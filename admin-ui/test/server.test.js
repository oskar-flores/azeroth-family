import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, formBodyParser } from '../src/server.js';

const FULL_ENV = {
  DB_HOST: 'ac-database',
  DB_ROOT_PASSWORD: 'sekrit',
  SOAP_USER: 'svcbot',
  SOAP_PASS: 'svcpw',
};

test('readConfig fills in the deployment defaults', () => {
  const config = readConfig(FULL_ENV);
  assert.equal(config.db.host, 'ac-database');
  assert.equal(config.db.port, 3306);
  assert.equal(config.db.user, 'root');
  assert.equal(config.soap.host, 'ac-worldserver');
  assert.equal(config.soap.port, 7878);
  assert.equal(config.backupDir, '/backups');
  assert.equal(config.port, 8080);
  // Binding to 0.0.0.0 inside the container is correct: containment comes from
  // BIND_ADDR on the published port, not from the in-container bind address.
  assert.equal(config.host, '0.0.0.0');
});

test('a missing required variable fails at boot, naming the variable', () => {
  for (const name of ['DB_ROOT_PASSWORD', 'SOAP_USER', 'SOAP_PASS']) {
    const env = { ...FULL_ENV };
    delete env[name];
    assert.throws(() => readConfig(env), new RegExp(name), `${name} was not reported`);
  }
});

test('overrides are honoured and coerced to numbers', () => {
  const config = readConfig({ ...FULL_ENV, UI_PORT: '9090', DB_PORT: '3307', SOAP_PORT: '7979' });
  assert.equal(config.port, 9090);
  assert.equal(config.db.port, 3307);
  assert.equal(config.soap.port, 7979);
});

test('the bot account prefix is configurable but defaults to the upstream value', () => {
  assert.equal(readConfig(FULL_ENV).botPrefix, 'rndbot');
  assert.equal(readConfig({ ...FULL_ENV, BOT_ACCOUNT_PREFIX: 'testbot' }).botPrefix, 'testbot');
});

test('formBodyParser turns a urlencoded body into a plain object', (t, done) => {
  formBodyParser({}, 'username=bob&password=a%26b', (err, value) => {
    assert.equal(err, null);
    assert.deepEqual(value, { username: 'bob', password: 'a&b' });
    done();
  });
});

test('formBodyParser handles an empty body', (t, done) => {
  formBodyParser({}, '', (err, value) => {
    assert.equal(err, null);
    assert.deepEqual(value, {});
    done();
  });
});