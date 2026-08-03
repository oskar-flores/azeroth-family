import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import familyRoutes from '../src/routes/family.js';
import adminRoutes from '../src/routes/admin.js';
import { ADMIN_ROUTES } from '../src/routes/admin.js';
import { createAuth, SESSION_COOKIE } from '../src/auth.js';
import { calculateVerifier } from '../src/srp6.js';
import { SoapError } from '../src/soap.js';
import { formBodyParser } from '../src/server.js';

const SALT = Buffer.alloc(32, 3);

export const ACCOUNTS = {
  PAPA: { id: 1, username: 'PAPA', salt: SALT, verifier: calculateVerifier('PAPA', 'goodpw', SALT), role: 3 },
  NINA: { id: 2, username: 'NINA', salt: SALT, verifier: calculateVerifier('NINA', 'kidpw', SALT), role: 0 },
};

export function stubDb(overrides = {}) {
  return {
    async findAccountForLogin(u) { return ACCOUNTS[String(u).toUpperCase()] ?? null; },
    async getRole(id) { return Object.values(ACCOUNTS).find((a) => a.id === id)?.role ?? 0; },
    async countAdmins() { return 1; },
    async listOnlineCharacters() {
      return [{ name: 'Ninadruida', level: 23, classId: 11, raceId: 4, accountName: 'NINA' }];
    },
    async listCharactersForAccount() {
      return [{ name: 'Ninadruida', level: 23, classId: 11, raceId: 4, online: true, lastPlayed: new Date(0) }];
    },
    async getRealm() { return { name: 'Azeroth Familiar', address: '100.64.0.1', port: 8085 }; },
    ...overrides,
  };
}

export function stubSoap(handler) {
  return { async executeCommand(command) { return handler(command); } };
}

export const soapUp = stubSoap(async () => ({ ok: true, output: 'Connected players: 1.' }));
export const soapDown = stubSoap(async () => { throw new SoapError('timeout', 'no answer'); });

export async function buildFamily({ db = stubDb(), soap = soapUp } = {}) {
  const fastify = Fastify({ logger: false });
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, formBodyParser);
  const auth = createAuth({ db });
  await fastify.register(familyRoutes, { db, auth, soap });
  return { fastify, auth };
}

async function loginAs(fastify, username, password) {
  const res = await fastify.inject({
    method: 'POST', url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ username, password }).toString(),
  });
  const cookie = res.headers['set-cookie'];
  return { res, cookie: Array.isArray(cookie) ? cookie[0] : cookie };
}

test('an anonymous visitor gets the login page, not the family page', async () => {
  const { fastify } = await buildFamily();
  const res = await fastify.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/login');
  await fastify.close();
});

test('a good login sets an HttpOnly session cookie and redirects', async () => {
  const { fastify } = await buildFamily();
  const { res, cookie } = await loginAs(fastify, 'nina', 'kidpw');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/');
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  await fastify.close();
});

test('an admin login lands on the console instead of the family page', async () => {
  const { fastify } = await buildFamily();
  const { res } = await loginAs(fastify, 'papa', 'goodpw');
  assert.equal(res.headers.location, '/admin');
  await fastify.close();
});

test('a bad password re-renders the login page with a Spanish error and no cookie', async () => {
  const { fastify } = await buildFamily();
  const { res, cookie } = await loginAs(fastify, 'nina', 'wrong');
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Usuario o contraseña/);
  assert.equal(cookie, undefined);
  await fastify.close();
});

// Never report an infrastructure failure as a wrong password.
test('a database outage says the realm database is unreachable, not "wrong password"', async () => {
  const { fastify } = await buildFamily({
    db: stubDb({ async findAccountForLogin() { throw new Error('ECONNREFUSED'); } }),
  });
  const { res } = await loginAs(fastify, 'nina', 'kidpw');
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /base de datos/i);
  assert.ok(!/contraseña incorrecta/i.test(res.body));
  await fastify.close();
});

test('a logged-in family member sees the online list and their own characters', async () => {
  const { fastify } = await buildFamily();
  const { cookie } = await loginAs(fastify, 'nina', 'kidpw');
  const res = await fastify.inject({ method: 'GET', url: '/', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Ninadruida/);
  assert.match(res.body, /en línea/);
  await fastify.close();
});

// The whole point of reading characters from MySQL rather than from the game.
test('the family page still renders when the worldserver is down', async () => {
  const { fastify } = await buildFamily({ soap: soapDown });
  const { cookie } = await loginAs(fastify, 'nina', 'kidpw');
  const res = await fastify.inject({ method: 'GET', url: '/', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /apagado/);
  assert.match(res.body, /Ninadruida/);
  await fastify.close();
});

test('logout destroys the session and clears the cookie', async () => {
  const { fastify } = await buildFamily();
  const { cookie } = await loginAs(fastify, 'nina', 'kidpw');
  const out = await fastify.inject({ method: 'POST', url: '/logout', headers: { cookie } });
  assert.equal(out.statusCode, 302);
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
  const after = await fastify.inject({ method: 'GET', url: '/', headers: { cookie } });
  assert.equal(after.headers.location, '/login');
  await fastify.close();
});

test('healthz answers without touching the database', async () => {
  const { fastify } = await buildFamily({
    db: stubDb({ async getRealm() { throw new Error('down'); } }),
  });
  const res = await fastify.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  await fastify.close();
});

function stubBackups(overrides = {}) {
  return {
    start: () => ({ state: 'running', startedAt: new Date(), databases: ['acore_auth'] }),
    status: () => ({ state: 'idle', done: [] }),
    async list() { return []; },
    async prune() { return []; },
    resolve(name) { return `/backups/${name}`; },
    ...overrides,
  };
}

async function buildAdmin({ db = stubDb(), soap = soapUp, backups = stubBackups() } = {}) {
  const fastify = Fastify({ logger: false });
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, formBodyParser);
  const auth = createAuth({ db });
  const entries = [];
  await fastify.register(familyRoutes, { db, auth, soap });
  await fastify.register(adminRoutes, { db, auth, soap, backups, audit: (e) => entries.push(e) });
  return { fastify, auth, entries };
}

async function sessionFor(fastify, username, password) {
  const res = await fastify.inject({
    method: 'POST', url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ username, password }).toString(),
  });
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0] : cookie;
}

// Returns only the payload. Callers must set the cookie and the form
// content-type together in `headers` — the previous version returned a
// `headers` key, and `headers: { cookie }, ...form(fields)` silently
// dropped the cookie (spread overwrite), turning every admin POST into a 403.
const form = (fields) => new URLSearchParams(fields).toString();

// Table-driven on purpose: an admin route added later that forgets its guard
// fails here by default rather than shipping open.
test('every admin route refuses a gmlevel-0 session', async () => {
  const { fastify } = await buildAdmin();
  const cookie = await sessionFor(fastify, 'nina', 'kidpw');
  for (const route of ADMIN_ROUTES) {
    const res = await fastify.inject({
      method: route.method, url: route.url,
      headers: route.method === 'POST' ? { cookie, 'content-type': 'application/x-www-form-urlencoded' } : { cookie },
      ...(route.method === 'POST' ? { payload: form({}) } : {}),
    });
    assert.equal(res.statusCode, 403, `${route.method} ${route.url} did not return 403`);
  }
  await fastify.close();
});

test('every admin route refuses an anonymous visitor', async () => {
  const { fastify } = await buildAdmin();
  for (const route of ADMIN_ROUTES) {
    const res = await fastify.inject({
      method: route.method, url: route.url,
      headers: route.method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
      ...(route.method === 'POST' ? { payload: form({}) } : {}),
    });
    assert.ok([302, 401, 403].includes(res.statusCode), `${route.method} ${route.url} => ${res.statusCode}`);
  }
  await fastify.close();
});

test('the console renders for an admin', async () => {
  const { fastify } = await buildAdmin();
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({ method: 'GET', url: '/admin', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Create an account/);
  await fastify.close();
});

test('creating an account sends the SOAP command and shows what it returned', async () => {
  const sent = [];
  const { fastify } = await buildAdmin({
    soap: stubSoap(async (cmd) => { sent.push(cmd); return { ok: true, output: "Account created: 'BOB'" }; }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({
    method: 'POST', url: '/admin/account',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'bob', password: 'secret1' }),
  });
  assert.equal(res.statusCode, 200);
  assert.ok(sent.includes('account create bob secret1'));
  assert.match(res.body, /Account created/);
  await fastify.close();
});

// The password must never come back out of this app, in the page or in a log.
test('the password never appears in the response or the audit entry', async () => {
  const { fastify, entries } = await buildAdmin();
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({
    method: 'POST', url: '/admin/account',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'bob', password: 'hunter22' }),
  });
  assert.ok(!res.body.includes('hunter22'));
  assert.ok(!JSON.stringify(entries).includes('hunter22'));
  await fastify.close();
});

test('the audit trail records who did what', async () => {
  const { fastify, entries } = await buildAdmin();
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  await fastify.inject({
    method: 'POST', url: '/admin/account',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'bob', password: 'secret1' }),
  });
  assert.equal(entries.at(-1).actor, 'PAPA');
  assert.equal(entries.at(-1).action, 'account.create');
  assert.equal(entries.at(-1).target, 'bob');
});

test('a SOAP Fault is rendered as a user-level message, not a 500', async () => {
  const { fastify } = await buildAdmin({
    soap: stubSoap(async (cmd) => {
      if (cmd.startsWith('account create')) throw new SoapError('fault', 'Account already exists.');
      return { ok: true, output: 'ok' };
    }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({
    method: 'POST', url: '/admin/account',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'papa', password: 'secret1' }),
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Account already exists\./);
  await fastify.close();
});

test('a SOAP 401 names the environment variable to fix', async () => {
  const { fastify } = await buildAdmin({
    soap: stubSoap(async (cmd) => {
      if (cmd === 'server info') return { ok: true, output: 'up' };
      throw new SoapError('auth', 'rejected', { status: 401 });
    }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({
    method: 'POST', url: '/admin/account',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'bob', password: 'secret1' }),
  });
  assert.match(res.body, /SOAP_USER/);
  await fastify.close();
});

test('invalid usernames and passwords are refused before any SOAP call', async () => {
  const sent = [];
  const { fastify } = await buildAdmin({
    soap: stubSoap(async (cmd) => { sent.push(cmd); return { ok: true, output: 'ok' }; }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const cases = [
    { username: 'ab', password: 'secret1' },              // too short
    { username: 'has space', password: 'secret1' },       // not [A-Za-z0-9]
    { username: 'bob', password: 'abc' },                 // under 4
    { username: 'bob', password: 'x'.repeat(17) },        // 3.3.5a truncates past 16
    { username: 'bob', password: 'contraseñ' },           // non-ASCII
  ];
  for (const fields of cases) {
    const res = await fastify.inject({
      method: 'POST', url: '/admin/account',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form(fields),
    });
    assert.equal(res.statusCode, 400, JSON.stringify(fields));
  }
  assert.deepEqual(sent.filter((c) => c.startsWith('account create')), []);
  await fastify.close();
});

test('setting a GM level sends the -1 realm id admin.sh also uses', async () => {
  const sent = [];
  const { fastify } = await buildAdmin({
    soap: stubSoap(async (cmd) => { sent.push(cmd); return { ok: true, output: 'done' }; }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  await fastify.inject({
    method: 'POST', url: '/admin/gmlevel',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'nina', level: '0' }),
  });
  assert.ok(sent.includes('account set gmlevel nina 0 -1'));
  await fastify.close();
});

// Guardrail 1: setting yourself to 0 locks you out of the UI you would use to undo it.
test('an admin cannot change their own level', async () => {
  const sent = [];
  const { fastify } = await buildAdmin({
    soap: stubSoap(async (cmd) => { sent.push(cmd); return { ok: true, output: 'done' }; }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({
    method: 'POST', url: '/admin/gmlevel',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'papa', level: '0', confirm: 'papa' }),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /your own/i);
  assert.deepEqual(sent.filter((c) => c.startsWith('account set')), []);
  await fastify.close();
});

// Guardrail 2: same lockout, one step removed.
test('a change that would leave zero admins is refused', async () => {
  const sent = [];
  const db = stubDb({
    async countAdmins() { return 1; },
    async findAccountForLogin(u) {
      // A second admin account that is not the logged-in user.
      if (String(u).toUpperCase() === 'OTROADMIN') {
        return { id: 9, username: 'OTROADMIN', salt: Buffer.alloc(32), verifier: Buffer.alloc(32), role: 3 };
      }
      return ACCOUNTS[String(u).toUpperCase()] ?? null;
    },
  });
  const { fastify } = await buildAdmin({
    db, soap: stubSoap(async (cmd) => { sent.push(cmd); return { ok: true, output: 'done' }; }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({
    method: 'POST', url: '/admin/gmlevel',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'otroadmin', level: '0', confirm: 'otroadmin' }),
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /last.*GM level 3.*account/i);
  assert.deepEqual(sent.filter((c) => c.startsWith('account set')), []);
  await fastify.close();
});

// Guardrail 3: CLAUDE.md is explicit that kids stay at 0.
test('promoting above 0 needs the username typed to confirm', async () => {
  const sent = [];
  const { fastify } = await buildAdmin({
    soap: stubSoap(async (cmd) => { sent.push(cmd); return { ok: true, output: 'done' }; }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');

  const without = await fastify.inject({
    method: 'POST', url: '/admin/gmlevel',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'nina', level: '2' }),
  });
  assert.equal(without.statusCode, 400);
  assert.deepEqual(sent.filter((c) => c.startsWith('account set')), []);

  const with_ = await fastify.inject({
    method: 'POST', url: '/admin/gmlevel',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'nina', level: '2', confirm: 'nina' }),
  });
  assert.equal(with_.statusCode, 200);
  assert.ok(sent.includes('account set gmlevel nina 2 -1'));
  await fastify.close();
});

test('a graceful restart warns players rather than hard-killing the container', async () => {
  const sent = [];
  const { fastify } = await buildAdmin({
    soap: stubSoap(async (cmd) => { sent.push(cmd); return { ok: true, output: 'Restart scheduled' }; }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  await fastify.inject({ method: 'POST', url: '/admin/restart', headers: { cookie }, payload: '' });
  assert.ok(sent.includes('server restart 30'));
  await fastify.close();
});

test('a backup starts in the background and the status endpoint reports it', async () => {
  let started = 0;
  const { fastify } = await buildAdmin({
    backups: stubBackups({
      start: () => { started++; return { state: 'running', startedAt: new Date(), databases: [] }; },
      status: () => ({ state: started ? 'running' : 'idle', done: [], current: 'acore_characters' }),
    }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({ method: 'POST', url: '/admin/backup', headers: { cookie }, payload: '' });
  assert.equal(res.statusCode, 302);
  assert.equal(started, 1);

  const status = await fastify.inject({ method: 'GET', url: '/admin/backup/status', headers: { cookie } });
  assert.equal(JSON.parse(status.body).state, 'running');
  await fastify.close();
});

test('a second backup while one runs is reported, not crashed', async () => {
  const { fastify } = await buildAdmin({
    backups: stubBackups({
      start: () => { throw new Error('a backup is already running'); },
      status: () => ({ state: 'running', done: [] }),
    }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({ method: 'POST', url: '/admin/backup', headers: { cookie }, payload: '' });
  assert.ok([200, 302, 409].includes(res.statusCode));
  await fastify.close();
});

test('a backup that fails to start is still audited as a failure', async () => {
  const { fastify, entries } = await buildAdmin({
    backups: stubBackups({
      start: () => { throw new Error('a backup is already running'); },
      status: () => ({ state: 'running', done: [] }),
    }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  await fastify.inject({ method: 'POST', url: '/admin/backup', headers: { cookie }, payload: '' });
  const last = entries.at(-1);
  assert.equal(last.action, 'backup.start');
  assert.equal(last.result, 'failed: a backup is already running');
  assert.equal(last.actor, 'PAPA');
  await fastify.close();
});

test('a download path outside the backup directory is refused', async () => {
  const { fastify } = await buildAdmin({
    backups: stubBackups({ resolve() { throw new Error('not a backup filename'); } }),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({ method: 'GET', url: '/admin/backup/..%2F..%2Fetc%2Fpasswd', headers: { cookie } });
  assert.equal(res.statusCode, 400);
  await fastify.close();
});

test('the restore page shows the command instead of doing the restore', async () => {
  const { fastify } = await buildAdmin();
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({
    method: 'GET', url: '/admin/restore/acore_characters_2026-08-02_1435.sql.gz', headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /admin\.sh restore/);
  await fastify.close();
});

test('GET /admin renders the Overview dashboard inside the tab shell', async () => {
  const { fastify } = await buildAdmin({
    soap: stubSoap(async () => ({ ok: true, output: 'Connected players: 3. Connection peak: 5. rev. 3aff15d' })),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({ method: 'GET', url: '/admin', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /class="tabs"/);
  assert.match(res.body, /Overview/);
  assert.match(res.body, /Connected players/);
  assert.match(res.body, /Quick actions/i);
  await fastify.close();
});

test('the un-built section tabs resolve to a stub, not a 404', async () => {
  const { fastify } = await buildAdmin();
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  for (const url of ['/admin/mailbox', '/admin/maintenance']) {
    const res = await fastify.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal(res.statusCode, 200, url);
  }
  await fastify.close();
});