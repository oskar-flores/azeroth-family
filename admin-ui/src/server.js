import Fastify from 'fastify';
import { createDb } from './db.js';
import { createSoapClient } from './soap.js';
import { createBackupManager } from './backup.js';
import { createAuth } from './auth.js';
import familyRoutes from './routes/family.js';
import adminRoutes from './routes/admin.js';

// Fastify parses JSON out of the box but not HTML form posts, and the
// dependency budget for this app is two packages, so this replaces
// @fastify/formbody.
export function formBodyParser(request, body, done) {
  try {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  } catch (err) {
    done(err);
  }
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set — put it in Dokploy's Environment tab`);
  return value;
}

export function readConfig(env) {
  return {
    // Containment is BIND_ADDR on the published port in docker-compose.yml, the
    // same mechanism that already contains 3724 and 8085. Inside the container
    // there is nothing to gain by binding narrower.
    host: '0.0.0.0',
    port: Number(env.UI_PORT ?? 8080),
    db: {
      host: env.DB_HOST ?? 'ac-database',
      port: Number(env.DB_PORT ?? 3306),
      user: env.DB_USER ?? 'root',
      password: required(env, 'DB_ROOT_PASSWORD'),
    },
    soap: {
      host: env.SOAP_HOST ?? 'ac-worldserver',
      port: Number(env.SOAP_PORT ?? 7878),
      user: required(env, 'SOAP_USER'),
      pass: required(env, 'SOAP_PASS'),
    },
    backupDir: env.BACKUP_DIR ?? '/backups',
    botPrefix: env.BOT_ACCOUNT_PREFIX ?? 'rndbot',
  };
}

export async function build(config) {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Cheap insurance: nothing should log the root password, and if something
      // does, it must not land in Dokploy's log viewer.
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.pass'],
    },
  });

  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, formBodyParser);

  const db = createDb({ ...config.db, botPrefix: config.botPrefix });
  const soap = createSoapClient(config.soap);
  const backups = createBackupManager({ dir: config.backupDir, mysql: config.db });
  const auth = createAuth({ db });

  // SOAP attributes every command to one service account, so this log is the
  // only record of who actually asked for what. Same reasoning as the
  // LLMChatter.RequestLog invariant: don't turn it off.
  const audit = (entry) => fastify.log.info({ audit: entry }, 'admin action');

  await fastify.register(familyRoutes, { db, auth, soap });
  await fastify.register(adminRoutes, { db, auth, soap, backups, audit });

  fastify.addHook('onClose', async () => { await db.close(); });
  return fastify;
}

// Only run when invoked directly, so the tests can import readConfig without
// starting a listener.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = readConfig(process.env);
  const fastify = await build(config);
  try {
    await fastify.listen({ host: config.host, port: config.port });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => { void fastify.close().then(() => process.exit(0)); });
  }
}