import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export const DATABASES = ['acore_characters', 'acore_auth', 'acore_playerbots'];

// Same naming as scripts/admin.sh:81 (`date +%Y-%m-%d_%H%M`), so admin.sh restore
// and this tool read each other's output.
const BACKUP_NAME = /^([a-z_]+)_(\d{4}-\d{2}-\d{2}_\d{4})\.sql\.gz$/;

const GIB = 1024 ** 3;

function stampFor(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
       + `_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

export function createBackupManager({
  dir,
  mysql,
  databases = DATABASES,
  keep = 14,
  minFreeBytes = 1 * GIB,
  mysqldumpPath = 'mysqldump',
  now = () => new Date(),
}) {
  let job = { state: 'idle', done: [] };

  async function freeBytes() {
    const stats = await fs.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  // Runs one database into `${db}_${stamp}.sql.gz`, via a `.partial` that is only
  // renamed once mysqldump itself has exited 0. gzip exits 0 even when the dump
  // dies, so the pipeline's own success proves nothing.
  async function dumpOne(database, stamp) {
    const finalPath = path.join(dir, `${database}_${stamp}.sql.gz`);
    const partialPath = `${finalPath}.partial`;

    const child = spawn(mysqldumpPath, [
      '-h', mysql.host,
      '-P', String(mysql.port ?? 3306),
      '-u', mysql.user,
      '--single-transaction',
      '--routines',
      database,
    ], {
      // MYSQL_PWD, never -p: argv is visible to `ps aux` inside this container.
      env: { ...process.env, MYSQL_PWD: mysql.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    const exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });

    try {
      await pipeline(child.stdout, createGzip(), createWriteStream(partialPath));
      const code = await exited;
      if (code !== 0) {
        throw new Error(`mysqldump for ${database} exited ${code}: ${stderr.trim() || 'no stderr'}`);
      }
      await fs.rename(partialPath, finalPath);
      return path.basename(finalPath);
    } catch (err) {
      await fs.rm(partialPath, { force: true });
      throw err;
    }
  }

  async function run() {
    const stamp = stampFor(now());
    try {
      const free = await freeBytes();
      if (free < minFreeBytes) {
        throw new Error(`refusing to dump: only ${(free / GIB).toFixed(1)} GiB free space in ${dir}`);
      }
      for (const database of databases) {
        job = { ...job, current: database };
        const name = await dumpOne(database, stamp);
        job = { ...job, done: [...job.done, name] };
      }
      await prune();
      job = { ...job, state: 'done', current: undefined, finishedAt: new Date() };
    } catch (err) {
      job = { ...job, state: 'failed', current: undefined, finishedAt: new Date(), error: err.message };
    }
  }

  async function prune() {
    const entries = await list();
    const removed = [];
    for (const database of new Set(entries.map((e) => e.database))) {
      const forDb = entries.filter((e) => e.database === database);
      for (const stale of forDb.slice(keep)) {
        await fs.rm(path.join(dir, stale.name), { force: true });
        removed.push(stale.name);
      }
    }
    return removed;
  }

  async function list() {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const entries = [];
    for (const name of names) {
      // .partial files are in-flight or abandoned. Never list them, never prune
      // them, never let one be downloaded as if it were a backup.
      const match = BACKUP_NAME.exec(name);
      if (!match) continue;
      const stats = await fs.stat(path.join(dir, name));
      entries.push({ name, database: match[1], size: stats.size, modified: stats.mtime });
    }
    // Newest first — prune() relies on this ordering.
    return entries.sort((a, b) => b.name.localeCompare(a.name));
  }

  return {
    DATABASES: databases,

    start() {
      if (job.state === 'running') throw new Error('a backup is already running');
      job = { state: 'running', startedAt: new Date(), done: [] };
      // Deliberately not awaited: a multi-GB dump cannot be a synchronous request.
      void run();
      return { state: 'running', startedAt: job.startedAt, databases };
    },

    status() {
      return { ...job };
    },

    list,
    prune,

    resolve(name) {
      if (typeof name !== 'string' || !BACKUP_NAME.test(name)) {
        throw new Error(`not a backup filename: ${name}`);
      }
      return path.join(dir, name);
    },
  };
}
