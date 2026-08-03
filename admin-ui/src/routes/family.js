import { parseCookies, serializeCookie, SESSION_COOKIE } from '../auth.js';
import { loginPage, familyPage } from '../views/family.js';

// SOAP `server info` answering at all is the liveness signal: it needs the world
// thread to run the command, so a reply means the realm is genuinely up.
async function probeRealm(soap) {
  try {
    const { output } = await soap.executeCommand('server info');
    return { up: true, info: output };
  } catch {
    return { up: false, info: null };
  }
}

export default async function familyRoutes(fastify, { db, auth, soap }) {
  const sessionFrom = (request) => auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);

  fastify.get('/healthz', async (request, reply) => reply.send({ ok: true }));

  fastify.get('/online.json', async (request, reply) => {
    const session = sessionFrom(request);
    if (!session) return reply.redirect('/login');
    const realmState = await probeRealm(soap);
    const online = realmState.up ? await db.listOnlineCharacters().catch(() => []) : [];
    return reply.send({ names: online.map((c) => c.name), realmUp: realmState.up });
  });

  fastify.get('/login', async (request, reply) => {
    if (sessionFrom(request)) return reply.redirect('/');
    // The realm address is useful on the login page and must not break it.
    const realm = await db.getRealm().catch(() => null);
    return reply.type('text/html; charset=utf-8').send(loginPage({ realm }));
  });

  fastify.post('/login', async (request, reply) => {
    const { username = '', password = '' } = request.body ?? {};
    const result = await auth.login({
      username: String(username).trim(),
      password: String(password),
      ip: request.ip,
    });

    if (result.ok) {
      reply.header('set-cookie', serializeCookie(SESSION_COOKIE, result.token, {
        maxAgeSeconds: Math.floor(auth.ttlMs / 1000),
      }));
      return reply.redirect(result.account.role >= 3 ? '/admin' : '/');
    }

    // Distinct messages, and never the word "password" for an infrastructure fault.
    const messages = {
      'bad-credentials': 'Usuario o contraseña incorrectos. Inténtalo otra vez.',
      'rate-limited': 'Demasiados intentos. Espera un minuto y vuelve a probar.',
      'unavailable': 'No se puede conectar con la base de datos del reino. No es culpa tuya — avisa a papá.',
    };
    const statuses = { 'bad-credentials': 401, 'rate-limited': 429, 'unavailable': 503 };
    const realm = await db.getRealm().catch(() => null);
    return reply
      .code(statuses[result.reason])
      .type('text/html; charset=utf-8')
      .send(loginPage({ error: messages[result.reason], realm }));
  });

  fastify.post('/logout', async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) auth.destroySession(token);
    reply.header('set-cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0 }));
    return reply.redirect('/login');
  });

  fastify.get('/', async (request, reply) => {
    const session = sessionFrom(request);
    if (!session) return reply.redirect('/login');

    // Characters come from MySQL, so this page survives a dead worldserver.
    const [realm, online, characters, realmState] = await Promise.all([
      db.getRealm().catch(() => null),
      db.listOnlineCharacters().catch(() => []),
      db.listCharactersForAccount(session.id).catch(() => []),
      probeRealm(soap),
    ]);

    return reply.type('text/html; charset=utf-8').send(familyPage({
      user: session,
      realm,
      realmUp: realmState.up,
      online: realmState.up ? online : [],
      characters,
      poll: '/online.json',
      worldMessage: realmState.up ? undefined
        : 'El servidor está apagado ahora mismo. Tus personajes están a salvo.',
    }));
  });
}