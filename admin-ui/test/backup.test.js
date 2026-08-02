import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { createBackupManager } from '../src/backup.js';

let dir;
let binDir;

// A stand-in for mysqldump. `mode` decides how it behaves:
//   ok      - prints SQL, exits 0
//   partial - prints some SQL, then exits 1 (the truncated-dump case)
async function fakeMysqldump(mode) {
  const file = path.join(binDir, 'mysqldump');
  const script = mode === 'ok'
    ? '#!/bin/sh\necho "-- dump of $4"\necho "INSERT INTO t VALUES (1);"\nexit 0\n'
    : '#!/bin/sh\necho "-- dump of $4"\nexit 1\n';
  await fs.writeFile(file, script, { mode: 0o755 });
  return file;
}

const settle = async (manager) => {
  for (let i = 0; i < 200; i++) {
    if (manager.status().state !== 'running') return manager.status();
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('backup job never finished');
};

const managerWith = (mysqldumpPath, overrides = {}) => createBackupManager({
  dir,
  mysqldumpPath,
  mysql: { host: 'db', port: 3306, user: 'root', password: 'secret' },
  databases: ['acore_characters', 'acore_auth'],
  now: () => new Date('2026-08-02T14:35:00Z'),
  ...overrides,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-ui-backup-'));
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-ui-bin-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(binDir, { recursive: true, force: true });
});

test('a successful run writes one gzipped dump per database, named like admin.sh', async () => {
  const manager = managerWith(await fakeMysqldump('ok'));
  manager.start();
  const status = await settle(manager);

  assert.equal(status.state, 'done');
  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, [
    'acore_auth_2026-08-02_1435.sql.gz',
    'acore_characters_2026-08-02_1435.sql.gz',
  ]);
});

test('the dump is really gzip and really contains the dump output', async () => {
  const manager = managerWith(await fakeMysqldump('ok'));
  manager.start();
  await settle(manager);

  const chunks = [];
  await pipeline(
    createReadStream(path.join(dir, 'acore_auth_2026-08-02_1435.sql.gz')),
    createGunzip(),
    async function* (source) { for await (const c of source) chunks.push(c); },
  );
  assert.match(Buffer.concat(chunks).toString('utf8'), /INSERT INTO t VALUES \(1\);/);
});

// The reason this module exists rather than being three lines of shell.
test('a mysqldump that dies mid-dump leaves no .sql.gz, only a failed status', async () => {
  const manager = managerWith(await fakeMysqldump('partial'));
  manager.start();
  const status = await settle(manager);

  assert.equal(status.state, 'failed');
  assert.match(status.error, /acore_characters/);
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.sql.gz')), []);
});

test('the password is never passed on the command line', async () => {
  // Record argv so we can assert the secret is not in it.
  const file = path.join(binDir, 'mysqldump');
  await fs.writeFile(file, `#!/bin/sh\necho "$@" >> ${path.join(binDir, 'argv.log')}\necho "-- ok"\nexit 0\n`, { mode: 0o755 });
  const manager = managerWith(file);
  manager.start();
  await settle(manager);

  const argv = await fs.readFile(path.join(binDir, 'argv.log'), 'utf8');
  assert.ok(!argv.includes('secret'), `password leaked into argv: ${argv}`);
});

test('list ignores .partial files', async () => {
  await fs.writeFile(path.join(dir, 'acore_auth_2026-08-02_1435.sql.gz'), 'x');
  await fs.writeFile(path.join(dir, 'acore_auth_2026-08-02_1440.sql.gz.partial'), 'x');
  const manager = managerWith('/bin/true');
  const listed = (await manager.list()).map((b) => b.name);
  assert.deepEqual(listed, ['acore_auth_2026-08-02_1435.sql.gz']);
});

test('list reports the database each file belongs to', async () => {
  await fs.writeFile(path.join(dir, 'acore_characters_2026-08-02_1435.sql.gz'), 'xyz');
  const manager = managerWith('/bin/true');
  const [entry] = await manager.list();
  assert.equal(entry.database, 'acore_characters');
  assert.equal(entry.size, 3);
  assert.ok(entry.modified instanceof Date);
});

test('prune keeps exactly the newest 14 per database and never touches .partial', async () => {
  for (let i = 0; i < 20; i++) {
    const stamp = `2026-08-02_${String(1000 + i).padStart(4, '0')}`;
    await fs.writeFile(path.join(dir, `acore_auth_${stamp}.sql.gz`), 'x');
    await fs.writeFile(path.join(dir, `acore_characters_${stamp}.sql.gz`), 'x');
  }
  await fs.writeFile(path.join(dir, 'acore_auth_2026-08-02_0001.sql.gz.partial'), 'x');

  const manager = managerWith('/bin/true');
  const removed = await manager.prune();

  assert.equal(removed.length, 12);
  const left = await fs.readdir(dir);
  assert.equal(left.filter((f) => f.startsWith('acore_auth_') && f.endsWith('.sql.gz')).length, 14);
  assert.equal(left.filter((f) => f.startsWith('acore_characters_') && f.endsWith('.sql.gz')).length, 14);
  assert.ok(left.includes('acore_auth_2026-08-02_0001.sql.gz.partial'));
  // The newest survive.
  assert.ok(left.includes('acore_auth_2026-08-02_1019.sql.gz'));
  assert.ok(!left.includes('acore_auth_2026-08-02_1000.sql.gz'));
});

test('a second start while one is running is refused', async () => {
  const manager = managerWith(await fakeMysqldump('ok'));
  manager.start();
  assert.throws(() => manager.start(), /already running/);
  await settle(manager);
});

test('a run refuses to start when the disk is nearly full', async () => {
  const manager = managerWith(await fakeMysqldump('ok'), { minFreeBytes: Number.MAX_SAFE_INTEGER });
  manager.start();
  const status = await settle(manager);
  assert.equal(status.state, 'failed');
  assert.match(status.error, /free space/i);
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.sql.gz')), []);
});

test('resolve refuses anything that is not a plain backup filename', () => {
  const manager = managerWith('/bin/true');
  assert.equal(manager.resolve('acore_auth_2026-08-02_1435.sql.gz'), path.join(dir, 'acore_auth_2026-08-02_1435.sql.gz'));
  assert.throws(() => manager.resolve('../../etc/passwd'), /not a backup/);
  assert.throws(() => manager.resolve('acore_auth_2026-08-02_1435.sql.gz.partial'), /not a backup/);
  assert.throws(() => manager.resolve('/etc/passwd'), /not a backup/);
});
