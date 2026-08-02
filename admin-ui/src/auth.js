import { randomBytes } from 'node:crypto';
import { checkLogin } from './srp6.js';

export const SESSION_COOKIE = 'ac_admin_sid';

const HOUR = 60 * 60 * 1000;

export function parseCookies(header) {
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAgeSeconds } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  // No Secure flag: this is plain HTTP over the tailnet, and Tailscale supplies
  // the transport encryption. `tailscale serve` can terminate TLS later without
  // touching this app.
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function createAuth({
  db,
  ttlMs = 12 * HOUR,
  maxAttempts = 10,
  cooldownMs = 60_000,
  now = () => Date.now(),
}) {
  const sessions = new Map();   // token -> { id, username, role, expiresAt }
  const attempts = new Map();   // `${USER}|${ip}` -> { count, blockedUntil }

  function readSession(token) {
    if (typeof token !== 'string') return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  return {
    async login({ username, password, ip }) {
      const key = `${String(username).toUpperCase()}|${ip}`;
      const record = attempts.get(key);

      if (record?.blockedUntil && record.blockedUntil > now()) {
        return { ok: false, reason: 'rate-limited', retryAfterMs: record.blockedUntil - now() };
      }

      let account;
      try {
        account = await db.findAccountForLogin(username);
      } catch {
        // Infrastructure failure. Reporting this as a wrong password is how a
        // child ends up certain they forgot a password they typed correctly.
        return { ok: false, reason: 'unavailable' };
      }

      const valid = account !== null
        && checkLogin(username, password, account.salt, account.verifier);

      if (!valid) {
        const count = (record?.blockedUntil && record.blockedUntil <= now() ? 0 : record?.count ?? 0) + 1;
        attempts.set(key, count >= maxAttempts
          ? { count: 0, blockedUntil: now() + cooldownMs }
          : { count });
        return { ok: false, reason: 'bad-credentials' };
      }

      attempts.delete(key);

      const token = randomBytes(32).toString('hex');
      sessions.set(token, {
        id: account.id,
        username: account.username,
        role: account.role,
        expiresAt: now() + ttlMs,
      });
      return {
        ok: true,
        token,
        account: { id: account.id, username: account.username, role: account.role },
      };
    },

    getSession(token) {
      const session = readSession(token);
      return session ? { ...session } : null;
    },

    destroySession(token) {
      sessions.delete(token);
    },

    // Roles are authoritative in the database, not in the cookie: a session
    // minted before a demotion must stop working immediately.
    async requireRole(token, minRole) {
      const session = readSession(token);
      if (!session) return null;
      let role;
      try {
        role = await db.getRole(session.id);
      } catch {
        return null;
      }
      session.role = role;
      if (role < minRole) return null;
      return { id: session.id, username: session.username, role };
    },

    get ttlMs() { return ttlMs; },
  };
}
