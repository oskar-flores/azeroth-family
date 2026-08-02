import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import familyRoutes from '../src/routes/family.js';
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