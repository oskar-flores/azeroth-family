// Minimal stand-ins for the three real schemas, holding only the columns db.js
// reads. Loaded into a throwaway MySQL 8.4 container; see test/db.test.js for
// how to start one.
import mysql from 'mysql2/promise';

export const TEST_MYSQL = {
  host: process.env.TEST_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_MYSQL_PORT ?? 3399),
  user: process.env.TEST_MYSQL_USER ?? 'root',
  password: process.env.TEST_MYSQL_PASSWORD ?? 'test',
};

const SCHEMA = `
DROP DATABASE IF EXISTS acore_auth;
DROP DATABASE IF EXISTS acore_characters;
CREATE DATABASE acore_auth;
CREATE DATABASE acore_characters;

CREATE TABLE acore_auth.account (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(32) NOT NULL DEFAULT '',
  salt BINARY(32) NOT NULL,
  verifier BINARY(32) NOT NULL,
  last_login TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY idx_username (username)
) ENGINE=InnoDB;

CREATE TABLE acore_auth.account_access (
  id INT UNSIGNED NOT NULL,
  gmlevel TINYINT UNSIGNED NOT NULL,
  RealmID INT NOT NULL DEFAULT -1,
  comment TEXT,
  PRIMARY KEY (id, RealmID)
) ENGINE=InnoDB;

CREATE TABLE acore_auth.realmlist (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(32) NOT NULL DEFAULT '',
  address VARCHAR(255) NOT NULL DEFAULT '127.0.0.1',
  port INT NOT NULL DEFAULT 8085
) ENGINE=InnoDB;

CREATE TABLE acore_characters.characters (
  guid INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account INT UNSIGNED NOT NULL DEFAULT 0,
  name VARCHAR(12) NOT NULL DEFAULT '',
  race TINYINT UNSIGNED NOT NULL DEFAULT 0,
  class TINYINT UNSIGNED NOT NULL DEFAULT 0,
  level TINYINT UNSIGNED NOT NULL DEFAULT 0,
  online TINYINT UNSIGNED NOT NULL DEFAULT 0,
  logout_time INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
`;

// One human admin, one human kid, one random bot, plus characters for each.
const SEED = `
INSERT INTO acore_auth.account (id, username, salt, verifier) VALUES
  (1, 'PAPA',      REPEAT(0x01, 32), REPEAT(0x11, 32)),
  (2, 'NINA',      REPEAT(0x02, 32), REPEAT(0x22, 32)),
  (3, 'RNDBOT001', REPEAT(0x03, 32), REPEAT(0x33, 32));

-- admin.sh writes RealmID = -1; a naive "RealmID = 1" filter would miss this row.
INSERT INTO acore_auth.account_access (id, gmlevel, RealmID) VALUES (1, 3, -1);

INSERT INTO acore_auth.realmlist (id, name, address, port)
  VALUES (1, 'Azeroth Familiar', '100.64.0.1', 8085);

INSERT INTO acore_characters.characters (guid, account, name, race, class, level, online, logout_time) VALUES
  (10, 1, 'Papaguerrero', 1, 1, 80, 1, 1750000000),
  (11, 2, 'Ninadruida',  4, 11, 23, 1, 1750000100),
  (12, 2, 'Ninamaga',    7,  8,  5, 0, 1749000000),
  (13, 3, 'Botrogue',    2,  4, 42, 1, 1750000200);
`;

export async function resetTestDatabase() {
  const conn = await mysql.createConnection({ ...TEST_MYSQL, multipleStatements: true });
  try {
    await conn.query(SCHEMA);
    await conn.query(SEED);
  } finally {
    await conn.end();
  }
}
