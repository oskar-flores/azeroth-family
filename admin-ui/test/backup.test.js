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

const RUN_AT = new Date('2026-08-02T14:35:00Z');

// What admin.sh's `date +%Y-%m-%d_%H%M` would print for RUN_AT on this host.
// Derived from the local accessors rather than hardcoded, so tests that merely
// need to name the file they just wrote pass in any timezone. The dedicated
// local-vs-UTC test below pins TZ and hardcodes instead — that one is the proof.
const localStamp = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
       + `_${pad(date.getHours())}${pad(date.getMinutes())}`;
};

const managerWith = (mysqldumpPath, overrides = {}) => createBackupManager({
  dir,
  mysqldumpPath,
  mysql: { host: 'db', port: 3306, user: 'root', password: 'secret' },
  databases: ['acore_characters', 'acore_auth'],
  now: () => RUN_AT,
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
  const stamp = localStamp(RUN_AT);
  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, [
    `acore_auth_${stamp}.sql.gz`,
    `acore_characters_${stamp}.sql.gz`,
  ]);
});

test('the dump is really gzip and really contains the dump output', async () => {
  const manager = managerWith(await fakeMysqldump('ok'));
  manager.start();
  await settle(manager);

  const chunks = [];
  await pipeline(
    createReadStream(path.join(dir, `acore_auth_${localStamp(RUN_AT)}.sql.gz`)),
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

// Regression: a mysqldump that cannot be spawned at all (missing from the image,
// misconfigured path, EACCES) used to kill the entire admin-ui process. The
// child's 'error' event rejected both the pipeline and the separate `exited`
// promise; the pipeline rejected first, so `await exited` was never reached and
// that second rejection went unhandled — fatal under Node's default
// --unhandled-rejections=throw. One bad path took down the whole console.
test('a mysqldump that cannot be spawned fails the job, not the process', async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  // Recording rather than relying on node:test's own detection: a listener
  // suppresses the default throw, so the assertion below stands in for it.
  process.on('unhandledRejection', record);
  try {
    const missing = path.join(binDir, 'definitely', 'not', 'here', 'mysqldump-xyz');
    const manager = managerWith(missing);
    manager.start();
    const status = await settle(manager);

    assert.equal(status.state, 'failed');
    assert.match(status.error, /ENOENT|mysqldump-xyz/);
    // Nothing half-written survives, not even the .partial.
    assert.deepEqual(await fs.readdir(dir), []);
    // And the manager is still usable afterwards — the failure was contained.
    assert.doesNotThrow(() => manager.start());
    await settle(manager);
  } finally {
    process.off('unhandledRejection', record);
  }

  assert.deepEqual(
    unhandled.map((e) => (e && e.message) || String(e)),
    [],
    'spawn failure left an unhandled rejection, which terminates the admin-ui process',
  );
});

// Regression: stampFor() used getUTC*, but scripts/admin.sh:77 stamps with
// `date +%Y-%m-%d_%H%M` — the host's local clock. On any non-UTC host the two
// tools named the same moment differently, defeating the cross-tool correlation
// the matching filename format exists for.
test('the stamp follows the local clock like admin.sh, not UTC', async () => {
  const originalTz = process.env.TZ;
  // Asia/Tokyo is UTC+9 year-round (no DST), so this instant lands on a
  // different hour AND a different calendar day than its UTC rendering — a UTC
  // stamp cannot coincidentally match.
  process.env.TZ = 'Asia/Tokyo';
  try {
    const when = new Date('2026-08-02T18:00:00Z');
    assert.equal(when.getUTCHours(), 18, 'sanity: 18:00 UTC on the 2nd');
    assert.equal(when.getUTCDate(), 2);
    assert.equal(when.getHours(), 3, 'sanity: 03:00 JST on the 3rd');
    assert.equal(when.getDate(), 3);

    const manager = managerWith(await fakeMysqldump('ok'), {
      databases: ['acore_auth'],
      now: () => when,
    });
    manager.start();
    assert.equal((await settle(manager)).state, 'done');

    // Local (JST) would be 2026-08-03_0300; UTC would be 2026-08-02_1800.
    assert.deepEqual(await fs.readdir(dir), ['acore_auth_2026-08-03_0300.sql.gz']);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
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
