import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { resetTestDatabase, TEST_MYSQL } from './helpers/mysql.js';

// Needs a throwaway MySQL 8.4. Start one with:
//   docker run --rm -d --name admin-ui-test-mysql -p 3399:3306 \
//     -e MYSQL_ROOT_PASSWORD=test mysql:8.4
let db;

before(async () => {
  await resetTestDatabase();
  db = createDb(TEST_MYSQL);
});

after(async () => { await db?.close(); });

test('findAccountForLogin returns salt and verifier as 32-byte Buffers', async () => {
  const account = await db.findAccountForLogin('PAPA');
  assert.equal(account.id, 1);
  assert.equal(account.username, 'PAPA');
  assert.ok(Buffer.isBuffer(account.salt));
  assert.equal(account.salt.length, 32);
  assert.equal(account.verifier.length, 32);
});

test('findAccountForLogin is case-insensitive on the username', async () => {
  const account = await db.findAccountForLogin('papa');
  assert.equal(account?.id, 1);
});

test('findAccountForLogin returns null for an unknown account', async () => {
  assert.equal(await db.findAccountForLogin('NOBODY'), null);
});

// account_access rows written by admin.sh use RealmID = -1. A "RealmID = 1"
// filter would report the admin as a level-0 player and lock them out.
test('the role comes from account_access rows written with RealmID = -1', async () => {
  assert.equal((await db.findAccountForLogin('PAPA')).role, 3);
});

test('an account with no account_access row is role 0, not null', async () => {
  assert.equal((await db.findAccountForLogin('NINA')).role, 0);
});

test('countAdmins counts gmlevel-3 accounts', async () => {
  assert.equal(await db.countAdmins(), 1);
});

test('getRole re-reads the level from the database', async () => {
  assert.equal(await db.getRole(1), 3);
  assert.equal(await db.getRole(2), 0);
  assert.equal(await db.getRole(999), 0);
});

// The single most important assertion in this file: without the filter the
// online list is ~150 bots and the humans are invisible.
test('listOnlineCharacters excludes rndbot accounts', async () => {
  const rows = await db.listOnlineCharacters();
  const names = rows.map((r) => r.name);
  assert.deepEqual(names.sort(), ['Ninadruida', 'Papaguerrero']);
  assert.ok(!names.includes('Botrogue'));
});

test('listOnlineCharacters excludes offline characters', async () => {
  const rows = await db.listOnlineCharacters();
  assert.ok(!rows.map((r) => r.name).includes('Ninamaga'));
});

test('listCharactersForAccount returns that account only, online first', async () => {
  const rows = await db.listCharactersForAccount(2);
  assert.deepEqual(rows.map((r) => r.name), ['Ninadruida', 'Ninamaga']);
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].classId, 11);
  assert.equal(rows[0].raceId, 4);
  assert.ok(rows[0].lastPlayed instanceof Date);
});

test('listCharactersForAccount is empty for an account with no characters', async () => {
  assert.deepEqual(await db.listCharactersForAccount(3).then((r) => r.map((c) => c.name)), ['Botrogue']);
  assert.deepEqual(await db.listCharactersForAccount(999), []);
});

test('getRealm reads the row admin.sh status reads', async () => {
  assert.deepEqual(await db.getRealm(), {
    name: 'Azeroth Familiar', address: '100.64.0.1', port: 8085,
  });
});

test('a bad host fails fast rather than hanging the login page', async () => {
  const dead = createDb({ ...TEST_MYSQL, host: '203.0.113.1', connectTimeoutMs: 500 });
  await assert.rejects(() => dead.findAccountForLogin('PAPA'));
  await dead.close();
});
