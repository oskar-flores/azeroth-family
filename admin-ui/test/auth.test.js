import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, parseCookies, serializeCookie, SESSION_COOKIE } from '../src/auth.js';
import { calculateVerifier } from '../src/srp6.js';

const SALT = Buffer.alloc(32, 7);

// A stub standing in for db.js. Only the two methods auth.js uses.
function stubDb({ accounts = {}, fail = false } = {}) {
  return {
    async findAccountForLogin(username) {
      if (fail) throw new Error('ECONNREFUSED');
      return accounts[username.toUpperCase()] ?? null;
    },
    async getRole(id) {
      if (fail) throw new Error('ECONNREFUSED');
      return Object.values(accounts).find((a) => a.id === id)?.role ?? 0;
    },
  };
}

const ACCOUNTS = {
  PAPA: { id: 1, username: 'PAPA', salt: SALT, verifier: calculateVerifier('PAPA', 'goodpw', SALT), role: 3 },
  NINA: { id: 2, username: 'NINA', salt: SALT, verifier: calculateVerifier('NINA', 'kidpw', SALT), role: 0 },
};

test('a correct password logs in and returns the role', async () => {
  const auth = createAuth({ db: stubDb({ accounts: ACCOUNTS }) });
  const result = await auth.login({ username: 'papa', password: 'goodpw', ip: '100.64.0.2' });
  assert.equal(result.ok, true);
  assert.equal(result.account.role, 3);
  assert.equal(result.account.username, 'PAPA');
  assert.ok(result.token.length >= 32);
});

test('a wrong password is rejected as bad-credentials', async () => {
  const auth = createAuth({ db: stubDb({ accounts: ACCOUNTS }) });
  const result = await auth.login({ username: 'papa', password: 'nope', ip: '100.64.0.2' });
  assert.deepEqual(result, { ok: false, reason: 'bad-credentials' });
});

test('an unknown account is rejected as bad-credentials, not something more specific', async () => {
  const auth = createAuth({ db: stubDb({ accounts: ACCOUNTS }) });
  const result = await auth.login({ username: 'ghost', password: 'x', ip: '100.64.0.2' });
  assert.deepEqual(result, { ok: false, reason: 'bad-credentials' });
});

// The single most important behaviour in this module: a child who typed their
// password correctly must never be told they got it wrong.
test('a database outage is reported as unavailable, never as bad-credentials', async () => {
  const auth = createAuth({ db: stubDb({ fail: true }) });
  const result = await auth.login({ username: 'papa', password: 'goodpw', ip: '100.64.0.2' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unavailable');
});

test('a failed login does not count against the limit once the password is right', async () => {
  const auth = createAuth({ db: stubDb({ accounts: ACCOUNTS }), maxAttempts: 3 });
  for (let i = 0; i < 2; i++) await auth.login({ username: 'nina', password: 'wrong', ip: 'a' });
  const good = await auth.login({ username: 'nina', password: 'kidpw', ip: 'a' });
  assert.equal(good.ok, true);
  // The counter reset, so a fresh run of wrong guesses is allowed again.
  for (let i = 0; i < 2; i++) {
    assert.equal((await auth.login({ username: 'nina', password: 'wrong', ip: 'a' })).reason, 'bad-credentials');
  }
});

test('too many wrong guesses trigger a cooldown, then clear', async () => {
  let clock = 0;
  const auth = createAuth({
    db: stubDb({ accounts: ACCOUNTS }), maxAttempts: 3, cooldownMs: 60_000, now: () => clock,
  });
  for (let i = 0; i < 3; i++) await auth.login({ username: 'nina', password: 'wrong', ip: 'a' });

  const limited = await auth.login({ username: 'nina', password: 'kidpw', ip: 'a' });
  assert.equal(limited.reason, 'rate-limited');
  assert.equal(limited.retryAfterMs, 60_000);

  clock += 60_001;
  assert.equal((await auth.login({ username: 'nina', password: 'kidpw', ip: 'a' })).ok, true);
});

test('the cooldown is per username+IP, so one kid cannot lock out another', async () => {
  const auth = createAuth({ db: stubDb({ accounts: ACCOUNTS }), maxAttempts: 2 });
  for (let i = 0; i < 3; i++) await auth.login({ username: 'nina', password: 'wrong', ip: 'a' });
  assert.equal((await auth.login({ username: 'papa', password: 'goodpw', ip: 'a' })).ok, true);
  assert.equal((await auth.login({ username: 'nina', password: 'kidpw', ip: 'b' })).ok, true);
});

test('a session can be read back and destroyed', async () => {
  const auth = createAuth({ db: stubDb({ accounts: ACCOUNTS }) });
  const { token } = await auth.login({ username: 'papa', password: 'goodpw', ip: 'a' });
  assert.equal(auth.getSession(token).username, 'PAPA');
  auth.destroySession(token);
  assert.equal(auth.getSession(token), null);
});

test('an expired session is gone', async () => {
  let clock = 0;
  const auth = createAuth({ db: stubDb({ accounts: ACCOUNTS }), ttlMs: 1000, now: () => clock });
  const { token } = await auth.login({ username: 'papa', password: 'goodpw', ip: 'a' });
  clock += 1001;
  assert.equal(auth.getSession(token), null);
});

test('an unknown or malformed token is not a session', async () => {
  const auth = createAuth({ db: stubDb({ accounts: ACCOUNTS }) });
  assert.equal(auth.getSession('nope'), null);
  assert.equal(auth.getSession(undefined), null);
});

// A cookie minted while you were an admin must stop working the moment the DB
// says you are not.
test('requireRole re-reads the level from the database, not the cookie', async () => {
  const accounts = structuredClone(ACCOUNTS);
  accounts.PAPA.salt = SALT;
  accounts.PAPA.verifier = calculateVerifier('PAPA', 'goodpw', SALT);
  const auth = createAuth({ db: stubDb({ accounts }) });
  const { token } = await auth.login({ username: 'papa', password: 'goodpw', ip: 'a' });
  assert.equal((await auth.requireRole(token, 3)).id, 1);

  accounts.PAPA.role = 0;
  assert.equal(await auth.requireRole(token, 3), null);
  assert.equal((await auth.requireRole(token, 0)).role, 0);
});

test('parseCookies handles absent, single and multiple cookies', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=1'), { a: '1' });
  assert.deepEqual(parseCookies('a=1; b=two; c=v%3D1'), { a: '1', b: 'two', c: 'v=1' });
});

test('serializeCookie sets the flags the design requires', () => {
  const header = serializeCookie(SESSION_COOKIE, 'abc', { maxAgeSeconds: 3600 });
  assert.match(header, /^ac_admin_sid=abc;/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.match(header, /Max-Age=3600/);
  // Tailscale provides the transport encryption; Secure would break plain HTTP.
  assert.ok(!/Secure/.test(header));
});

test('serializeCookie with maxAgeSeconds 0 clears the cookie', () => {
  assert.match(serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0 }), /Max-Age=0/);
});
