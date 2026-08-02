import test from 'node:test';
import assert from 'node:assert/strict';
import { className, raceName } from '../src/lookups.js';
import { escapeHtml, loginPage, familyPage, adminPage, restorePage } from '../src/views.js';

test('class and race IDs map to the names the esES client shows', () => {
  assert.equal(className(1), 'Guerrero');
  assert.equal(className(6), 'Caballero de la Muerte');
  assert.equal(className(11), 'Druida');
  assert.equal(raceName(4), 'Elfo de la noche');
  assert.equal(raceName(10), 'Elfo de sangre');
});

test('unused and unknown IDs degrade to a readable placeholder, not undefined', () => {
  assert.equal(className(10), 'Clase 10');
  assert.equal(raceName(9), 'Raza 9');
  assert.equal(className(999), 'Clase 999');
});

test('escapeHtml neutralises every character that can break out of markup', () => {
  assert.equal(escapeHtml(`<a href="x" y='z'>&</a>`),
    '&lt;a href=&quot;x&quot; y=&#39;z&#39;&gt;&amp;&lt;/a&gt;');
});

test('escapeHtml renders null and undefined as empty, not as the words', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});

test('the login page is Spanish and posts to /login', () => {
  const html = loginPage({});
  assert.match(html, /<html lang="es"/);
  assert.match(html, /<form[^>]+action="\/login"[^>]+method="post"/);
  assert.match(html, /name="username"/);
  assert.match(html, /type="password"/);
});

test('a login error is shown escaped', () => {
  assert.match(loginPage({ error: 'Usuario o contraseña <incorrectos>' }), /&lt;incorrectos&gt;/);
});

test('the family page lists online characters with class and race', () => {
  const html = familyPage({
    user: { username: 'NINA', role: 0 },
    realm: { name: 'Azeroth Familiar', address: '100.64.0.1', port: 8085 },
    realmUp: true,
    online: [{ name: 'Ninadruida', level: 23, classId: 11, raceId: 4, accountName: 'NINA' }],
    characters: [{ name: 'Ninadruida', level: 23, classId: 11, raceId: 4, online: true, lastPlayed: new Date(0) }],
  });
  assert.match(html, /Ninadruida/);
  assert.match(html, /Druida/);
  assert.match(html, /Elfo de la noche/);
  assert.match(html, /100\.64\.0\.1/);
});

test('the family page says the realm is down without pretending the character list failed', () => {
  const html = familyPage({
    user: { username: 'NINA', role: 0 },
    realm: { name: 'Azeroth Familiar', address: '100.64.0.1', port: 8085 },
    realmUp: false,
    online: [],
    characters: [{ name: 'Ninamaga', level: 5, classId: 8, raceId: 7, online: false, lastPlayed: null }],
    worldMessage: 'El servidor está apagado ahora mismo.',
  });
  assert.match(html, /apagado/);
  assert.match(html, /Ninamaga/);
});

test('a character name containing markup is escaped on the family page', () => {
  const html = familyPage({
    user: { username: 'NINA', role: 0 },
    realm: null,
    realmUp: false,
    online: [],
    characters: [{ name: '<script>x</script>', level: 1, classId: 1, raceId: 1, online: false, lastPlayed: null }],
  });
  assert.ok(!html.includes('<script>x</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('the admin page renders the account, gmlevel, lifecycle and backup controls', () => {
  const html = adminPage({
    user: { username: 'PAPA', role: 3 },
    realm: { name: 'Azeroth Familiar', address: '100.64.0.1', port: 8085 },
    realmUp: true,
    serverInfo: 'Connected players: 2.',
    backups: [{ name: 'acore_auth_2026-08-02_1435.sql.gz', database: 'acore_auth', size: 1024, modified: new Date(0) }],
    backupStatus: { state: 'idle', done: [] },
    notices: [],
  });
  assert.match(html, /action="\/admin\/account"/);
  assert.match(html, /action="\/admin\/gmlevel"/);
  assert.match(html, /action="\/admin\/restart"/);
  assert.match(html, /action="\/admin\/backup"/);
  assert.match(html, /acore_auth_2026-08-02_1435\.sql\.gz/);
});

test('admin notices render their kind so failures are visually distinct', () => {
  const html = adminPage({
    user: { username: 'PAPA', role: 3 },
    realm: null, realmUp: false, backups: [], backupStatus: { state: 'idle', done: [] },
    notices: [{ kind: 'error', text: 'Account already exists.' }],
  });
  assert.match(html, /class="notice error"/);
  assert.match(html, /Account already exists\./);
});

test('when the world is down the admin page disables the SOAP-backed controls with a reason', () => {
  const html = adminPage({
    user: { username: 'PAPA', role: 3 },
    realm: null, realmUp: false, backups: [], backupStatus: { state: 'idle', done: [] }, notices: [],
  });
  assert.match(html, /disabled/);
  assert.match(html, /worldserver is not answering/i);
});

test('the restore page shows the exact admin.sh command and no restore button', () => {
  const html = restorePage({ name: 'acore_characters_2026-08-02_1435.sql.gz' });
  assert.match(html, /\.\/scripts\/admin\.sh restore .*acore_characters_2026-08-02_1435\.sql\.gz acore_characters/);
  assert.ok(!/<button[^>]*>\s*Restore/i.test(html));
});