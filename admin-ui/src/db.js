import mysql from 'mysql2/promise';

// AiPlayerbot.RandomBotAccountPrefix, upstream default. Every playerbot account
// starts with this, including the addclass pool.
const DEFAULT_BOT_PREFIX = 'rndbot';

export function createDb({
  host,
  port = 3306,
  user,
  password,
  connectTimeoutMs = 2000,
  botPrefix = DEFAULT_BOT_PREFIX,
}) {
  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    connectionLimit: 5,
    connectTimeout: connectTimeoutMs,
    // No `database`: every query names acore_auth / acore_characters explicitly.
    dateStrings: false,
  });

  const botFilter = `${botPrefix}%`;

  return {
    async findAccountForLogin(username) {
      const [rows] = await pool.query(
        `SELECT a.id, a.username, a.salt, a.verifier,
                COALESCE(MAX(aa.gmlevel), 0) AS role
           FROM acore_auth.account a
           LEFT JOIN acore_auth.account_access aa
                  ON aa.id = a.id AND aa.RealmID IN (-1, 1)
          WHERE a.username = UPPER(?)
          GROUP BY a.id`,
        [username],
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        id: r.id,
        username: r.username,
        salt: r.salt,
        verifier: r.verifier,
        role: Number(r.role),
      };
    },

    async countAdmins() {
      const [rows] = await pool.query(
        `SELECT COUNT(DISTINCT id) AS n
           FROM acore_auth.account_access
          WHERE gmlevel >= 3 AND RealmID IN (-1, 1)`,
      );
      return Number(rows[0].n);
    },

    // Read fresh on every admin request; never trust a role cached in a cookie.
    async getRole(accountId) {
      const [rows] = await pool.query(
        `SELECT COALESCE(MAX(gmlevel), 0) AS role
           FROM acore_auth.account_access
          WHERE id = ? AND RealmID IN (-1, 1)`,
        [accountId],
      );
      return Number(rows[0]?.role ?? 0);
    },

    async listOnlineCharacters() {
      const [rows] = await pool.query(
        `SELECT c.name, c.level, c.class AS classId, c.race AS raceId,
                a.username AS accountName
           FROM acore_characters.characters c
           JOIN acore_auth.account a ON a.id = c.account
          WHERE c.online = 1 AND a.username NOT LIKE ?
          ORDER BY c.level DESC, c.name ASC`,
        [botFilter],
      );
      return rows.map((r) => ({ ...r, level: Number(r.level) }));
    },

    async listCharactersForAccount(accountId) {
      const [rows] = await pool.query(
        `SELECT name, level, class AS classId, race AS raceId, online, logout_time
           FROM acore_characters.characters
          WHERE account = ?
          ORDER BY online DESC, level DESC, name ASC`,
        [accountId],
      );
      return rows.map((r) => ({
        name: r.name,
        level: Number(r.level),
        classId: Number(r.classId),
        raceId: Number(r.raceId),
        online: r.online === 1,
        // logout_time is a unix timestamp, 0 for a character that never logged out.
        lastPlayed: r.logout_time ? new Date(Number(r.logout_time) * 1000) : null,
      }));
    },

    async getRealm() {
      const [rows] = await pool.query(
        `SELECT name, address, port FROM acore_auth.realmlist WHERE id = 1`,
      );
      if (rows.length === 0) return null;
      return { name: rows[0].name, address: rows[0].address, port: Number(rows[0].port) };
    },

    async close() {
      await pool.end();
    },
  };
}
