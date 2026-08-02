import { createReadStream } from 'node:fs';
import { parseCookies, SESSION_COOKIE } from '../auth.js';
import { adminPage, restorePage } from '../views.js';

const USERNAME = /^[A-Za-z0-9]{3,16}$/;
// 3.3.5a truncates a password past 16 characters, which would create an account
// whose password is not what the admin typed. ASCII printable only.
const PASSWORD = /^[\x20-\x7E]{4,16}$/;

// The authorization test iterates this. A route added below but not listed here
// is a test gap; a route listed here but missing its guard fails the test.
export const ADMIN_ROUTES = [
  { method: 'GET', url: '/admin' },
  { method: 'POST', url: '/admin/account' },
  { method: 'POST', url: '/admin/gmlevel' },
  { method: 'POST', url: '/admin/restart' },
  { method: 'POST', url: '/admin/backup' },
  { method: 'GET', url: '/admin/backup/status' },
  { method: 'GET', url: '/admin/backup/some_2026-01-01_0000.sql.gz' },
  { method: 'GET', url: '/admin/restore/some_2026-01-01_0000.sql.gz' },
];

// Maps the SOAP error taxonomy onto messages an operator can act on. A Fault is
// the command's own output and belongs in front of the user unchanged.
function soapNotice(err) {
  switch (err.kind) {
    case 'fault':      return { kind: 'error', text: err.message };
    case 'auth':       return { kind: 'error', text: 'The worldserver rejected the SOAP service account. Check SOAP_USER / SOAP_PASS in Dokploy.' };
    case 'forbidden':  return { kind: 'error', text: 'The SOAP service account is below GM level 3. Re-run: ./scripts/admin.sh gm $SOAP_USER 3' };
    case 'timeout':    return { kind: 'error', text: 'The worldserver did not answer in time. It may be starting up or overloaded.' };
    case 'unreachable':return { kind: 'error', text: 'Cannot reach the worldserver on SOAP. Is ac-worldserver running?' };
    default:           return { kind: 'error', text: `Unexpected response from the worldserver: ${err.message}` };
  }
}

export default async function adminRoutes(fastify, { db, auth, soap, backups, audit }) {
  // Roles are re-read from the database here, on every request, so a session
  // minted before a demotion stops working immediately.
  async function requireAdmin(request, reply) {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    const user = await auth.requireRole(token, 3);
    if (!user) {
      reply.code(403).type('text/html; charset=utf-8')
        .send('<p>This page needs GM level 3. <a href="/">Back</a></p>');
      return null;
    }
    return user;
  }

  async function render(reply, user, notices = [], code = 200) {
    let realmUp = false;
    let serverInfo = null;
    try {
      serverInfo = (await soap.executeCommand('server info')).output;
      realmUp = true;
    } catch { /* the console must render with the world down */ }

    const [realm, list] = await Promise.all([
      db.getRealm().catch(() => null),
      backups.list().catch(() => []),
    ]);

    return reply.code(code).type('text/html; charset=utf-8').send(adminPage({
      user, realm, realmUp, serverInfo, backups: list, backupStatus: backups.status(), notices,
    }));
  }

  fastify.get('/admin', async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;
    return render(reply, user);
  });

  fastify.post('/admin/account', async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;

    const username = String(request.body?.username ?? '').trim();
    const password = String(request.body?.password ?? '');

    if (!USERNAME.test(username)) {
      return render(reply, user, [{ kind: 'error', text: 'Username must be 3-16 letters or digits.' }], 400);
    }
    if (!PASSWORD.test(password)) {
      return render(reply, user, [{ kind: 'error', text: 'Password must be 4-16 ASCII characters. 3.3.5a truncates anything longer.' }], 400);
    }

    try {
      const { output } = await soap.executeCommand(`account create ${username} ${password}`);
      // The password is deliberately absent from both the audit entry and the page.
      audit({ actor: user.username, action: 'account.create', target: username, result: 'ok' });
      return render(reply, user, [{ kind: 'ok', text: output }]);
    } catch (err) {
      audit({ actor: user.username, action: 'account.create', target: username, result: `failed: ${err.kind}` });
      return render(reply, user, [soapNotice(err)]);
    }
  });

  fastify.post('/admin/gmlevel', async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;

    const username = String(request.body?.username ?? '').trim();
    const level = Number(request.body?.level);
    const confirm = String(request.body?.confirm ?? '').trim();

    if (!USERNAME.test(username)) {
      return render(reply, user, [{ kind: 'error', text: 'Username must be 3-16 letters or digits.' }], 400);
    }
    if (!Number.isInteger(level) || level < 0 || level > 3) {
      return render(reply, user, [{ kind: 'error', text: 'Level must be 0, 1, 2 or 3.' }], 400);
    }

    const target = await db.findAccountForLogin(username).catch(() => null);
    if (!target) {
      return render(reply, user, [{ kind: 'error', text: `No such account: ${username}` }], 400);
    }

    // Guardrail 1 — setting yourself to 0 locks you out of the UI you would use
    // to undo it.
    if (target.id === user.id) {
      return render(reply, user, [{ kind: 'error', text: 'Refusing to change your own GM level. Use ./scripts/admin.sh if you really mean to.' }], 400);
    }

    // Guardrail 2 — same lockout, one step removed.
    if (target.role >= 3 && level < 3) {
      const admins = await db.countAdmins().catch(() => 0);
      if (admins <= 1) {
        return render(reply, user, [{ kind: 'error', text: 'Refusing: that is the last GM level 3 account on the realm.' }], 400);
      }
    }

    // Guardrail 3 — CLAUDE.md is explicit that kids stay at 0, and GM commands
    // can delete characters.
    if (level > 0 && confirm.toUpperCase() !== username.toUpperCase()) {
      return render(reply, user, [{ kind: 'error', text: `Promoting above 0 needs confirmation: type "${username}" in the confirm box.` }], 400);
    }

    try {
      const { output } = await soap.executeCommand(`account set gmlevel ${username} ${level} -1`);
      audit({ actor: user.username, action: 'account.gmlevel', target: `${username}=${level}`, result: 'ok' });
      return render(reply, user, [{ kind: 'ok', text: output }]);
    } catch (err) {
      audit({ actor: user.username, action: 'account.gmlevel', target: `${username}=${level}`, result: `failed: ${err.kind}` });
      return render(reply, user, [soapNotice(err)]);
    }
  });

  fastify.post('/admin/restart', async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;
    try {
      // A countdown, not a hard kill: `docker restart` would drop logged-in
      // players mid-fight. restart: unless-stopped brings the container back.
      const { output } = await soap.executeCommand('server restart 30');
      audit({ actor: user.username, action: 'server.restart', target: '30s', result: 'ok' });
      return render(reply, user, [{ kind: 'ok', text: output }]);
    } catch (err) {
      audit({ actor: user.username, action: 'server.restart', target: '30s', result: `failed: ${err.kind}` });
      return render(reply, user, [soapNotice(err)]);
    }
  });

  fastify.post('/admin/backup', async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;
    try {
      backups.start();
      audit({ actor: user.username, action: 'backup.start', target: 'all', result: 'ok' });
      return reply.redirect('/admin');
    } catch (err) {
      audit({ actor: user.username, action: 'backup.start', target: 'all', result: `failed: ${err.message}` });
      return render(reply, user, [{ kind: 'error', text: err.message }], 409);
    }
  });

  fastify.get('/admin/backup/status', async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;
    return reply.send(backups.status());
  });

  fastify.get('/admin/backup/:name', async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;
    let file;
    try {
      file = backups.resolve(request.params.name);
    } catch {
      return reply.code(400).send('not a backup filename');
    }
    audit({ actor: user.username, action: 'backup.download', target: request.params.name, result: 'ok' });
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${request.params.name}"`)
      .send(createReadStream(file));
  });

  fastify.get('/admin/restore/:name', async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return reply;
    // Deliberately a page of instructions, not an action. See the design doc.
    return reply.type('text/html; charset=utf-8').send(restorePage({ name: request.params.name }));
  });
}