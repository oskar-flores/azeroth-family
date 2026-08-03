import { className, raceName } from './lookups.js';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const STYLE = `
:root { color-scheme: light dark; --fg: #16181d; --bg: #fbfaf7; --muted: #6a6f7a;
        --line: #d9d5cc; --accent: #7a5c2e; --bad: #a3302a; --good: #2c6e49; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e8e4dc; --bg: #17191d; --muted: #9aa0ab; --line: #2f333a;
          --accent: #d3b072; --bad: #e07a72; --good: #7fc9a0; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; }
form { margin: 0 0 1rem; display: flex; flex-wrap: wrap; gap: .5rem; align-items: flex-end; }
label { display: flex; flex-direction: column; font-size: .85rem; color: var(--muted); gap: .2rem; }
input, select { font: inherit; padding: .35rem .5rem; border: 1px solid var(--line);
                border-radius: .25rem; background: var(--bg); color: var(--fg); }
button { font: inherit; padding: .4rem .9rem; border: 1px solid var(--accent);
         border-radius: .25rem; background: var(--accent); color: var(--bg); cursor: pointer; }
button[disabled] { opacity: .45; cursor: not-allowed; }
.notice { padding: .6rem .8rem; border-left: 3px solid var(--muted); margin: 0 0 .75rem;
          white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: .9rem; }
.notice.error { border-color: var(--bad); }
.notice.ok { border-color: var(--good); }
.muted { color: var(--muted); }
.pill { font-size: .8rem; padding: .1rem .5rem; border-radius: 1rem; border: 1px solid var(--line); }
.pill.up { color: var(--good); border-color: var(--good); }
.pill.down { color: var(--bad); border-color: var(--bad); }
pre { overflow-x: auto; padding: .75rem; border: 1px solid var(--line); border-radius: .25rem; }
.bar { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
`;

export function layout({ title, lang = 'es', body, user }) {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>
<div class="bar"><h1>${escapeHtml(title)}</h1>${user
  ? `<form action="/logout" method="post"><span class="muted">${escapeHtml(user.username)}</span>
     <button type="submit">${lang === 'es' ? 'Salir' : 'Log out'}</button></form>`
  : ''}</div>
${body}
</main></body></html>`;
}

const realmPill = (up, lang) => up
  ? `<span class="pill up">${lang === 'es' ? 'en línea' : 'up'}</span>`
  : `<span class="pill down">${lang === 'es' ? 'apagado' : 'down'}</span>`;

const realmLine = (realm) => realm
  ? `<p class="muted">${escapeHtml(realm.name)} — <code>${escapeHtml(realm.address)}:${escapeHtml(realm.port)}</code></p>`
  : '';

export function loginPage({ error, realm } = {}) {
  return layout({
    title: 'Azeroth Familiar',
    lang: 'es',
    body: `
${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
<form action="/login" method="post">
  <label>Usuario <input name="username" autocomplete="username" autocapitalize="none" required></label>
  <label>Contraseña <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Entrar</button>
</form>
<p class="muted">Usa el mismo usuario y contraseña del juego.</p>
${realmLine(realm)}`,
  });
}

const dateText = (value, lang) => value
  ? escapeHtml(value.toISOString().slice(0, 16).replace('T', ' '))
  : `<span class="muted">${lang === 'es' ? 'nunca' : 'never'}</span>`;

export function familyPage({ user, realm, realmUp, online, characters, worldMessage }) {
  const characterRows = characters.length === 0
    ? `<tr><td colspan="5" class="muted">Todavía no tienes personajes.</td></tr>`
    : characters.map((c) => `<tr>
        <td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.level)}</td>
        <td>${escapeHtml(className(c.classId))}</td><td>${escapeHtml(raceName(c.raceId))}</td>
        <td>${c.online ? 'sí' : dateText(c.lastPlayed, 'es')}</td></tr>`).join('\n');

  const onlineRows = online.length === 0
    ? `<tr><td colspan="4" class="muted">Nadie conectado ahora mismo.</td></tr>`
    : online.map((c) => `<tr>
        <td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.level)}</td>
        <td>${escapeHtml(className(c.classId))}</td><td>${escapeHtml(raceName(c.raceId))}</td></tr>`).join('\n');

  return layout({
    title: 'Azeroth Familiar',
    lang: 'es',
    user,
    body: `
<p>El reino está ${realmPill(realmUp, 'es')}.</p>
${realmLine(realm)}
${worldMessage ? `<div class="notice">${escapeHtml(worldMessage)}</div>` : ''}

<h2>Quién está jugando</h2>
<table><thead><tr><th>Personaje</th><th>Nivel</th><th>Clase</th><th>Raza</th></tr></thead>
<tbody>${onlineRows}</tbody></table>

<h2>Mis personajes</h2>
<table><thead><tr><th>Personaje</th><th>Nivel</th><th>Clase</th><th>Raza</th><th>Conectado</th></tr></thead>
<tbody>${characterRows}</tbody></table>`,
  });
}

const bytes = (n) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB`
  : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : `${(n / 1024).toFixed(0)} KB`;

export function adminPage({ user, realm, realmUp, serverInfo, backups, backupStatus, notices }) {
  // Every SOAP-backed control is disabled when the world is not answering, with
  // the reason stated rather than failing on submit.
  const down = realmUp ? '' : ' disabled';
  const downReason = realmUp ? '' :
    `<p class="muted">Account, GM level and restart controls are disabled: the worldserver is not answering on SOAP.</p>`;

  const backupRows = backups.length === 0
    ? `<tr><td colspan="4" class="muted">No backups yet.</td></tr>`
    : backups.map((b) => `<tr>
        <td><a href="/admin/backup/${encodeURIComponent(b.name)}">${escapeHtml(b.name)}</a></td>
        <td>${escapeHtml(b.database)}</td><td>${escapeHtml(bytes(b.size))}</td>
        <td>${dateText(b.modified, 'en')}
            <a class="muted" href="/admin/restore/${encodeURIComponent(b.name)}">restore…</a></td>
      </tr>`).join('\n');

  const jobLine = backupStatus.state === 'running'
    ? `<div class="notice">Backup running — ${escapeHtml(backupStatus.current ?? '')} (${backupStatus.done.length} done)</div>`
    : backupStatus.state === 'failed'
      ? `<div class="notice error">Last backup failed: ${escapeHtml(backupStatus.error)}</div>`
      : backupStatus.state === 'done'
        ? `<div class="notice ok">Last backup wrote ${backupStatus.done.length} file(s).</div>`
        : '';

  return layout({
    title: 'Realm admin',
    lang: 'en',
    user,
    body: `
${notices.map((n) => `<div class="notice ${escapeHtml(n.kind)}">${escapeHtml(n.text)}</div>`).join('\n')}
<p>Realm is ${realmPill(realmUp, 'en')}.</p>
${realmLine(realm)}
${serverInfo ? `<pre>${escapeHtml(serverInfo)}</pre>` : ''}
${downReason}

<h2>Create an account</h2>
<form action="/admin/account" method="post">
  <label>Username <input name="username" pattern="[A-Za-z0-9]{3,16}" required></label>
  <label>Password <input name="password" type="password" minlength="4" maxlength="16" required></label>
  <button type="submit"${down}>Create</button>
</form>
<p class="muted">3-16 letters/digits. Password 4-16 ASCII characters — 3.3.5a truncates past 16.</p>

<h2>Set GM level</h2>
<form action="/admin/gmlevel" method="post">
  <label>Username <input name="username" pattern="[A-Za-z0-9]{3,16}" required></label>
  <label>Level <select name="level"><option>0</option><option>1</option><option>2</option><option>3</option></select></label>
  <label>Type the username again to confirm <input name="confirm"></label>
  <button type="submit"${down}>Apply</button>
</form>
<p class="muted">Kids stay at 0. GM commands can delete characters. Confirmation is required for any level above 0.</p>

<h2>Lifecycle</h2>
<form action="/admin/restart" method="post">
  <button type="submit"${down}>Graceful restart (30s warning)</button>
</form>
<p class="muted">Players get a countdown. Starting a fully dead stack is not supported here — use <code>scripts/admin.sh</code>.</p>

<h2>Backups</h2>
${jobLine}
<form action="/admin/backup" method="post">
  <button type="submit"${backupStatus.state === 'running' ? ' disabled' : ''}>Back up now</button>
</form>
<table><thead><tr><th>File</th><th>Database</th><th>Size</th><th>Written</th></tr></thead>
<tbody>${backupRows}</tbody></table>`,
  });
}

export function restorePage({ name }) {
  // Restore is deliberately not a button: restoring acore_characters while the
  // worldserver runs corrupts it, and this app cannot hold the world down
  // because `restart: unless-stopped` brings it back on its own schedule.
  const database = String(name).replace(/_\d{4}-\d{2}-\d{2}_\d{4}\.sql\.gz$/, '');
  return layout({
    title: 'Restore',
    lang: 'en',
    body: `
<div class="notice">Restore is not available from the browser. The worldserver holds character
state in memory and flushes it over a freshly imported database, so a correct restore must hold
the world down for the whole import — which needs the Docker API this app deliberately does not have.</div>
<p>Run this on the Docker host:</p>
<pre>./scripts/admin.sh restore /var/lib/docker/volumes/ac-backups/_data/${escapeHtml(name)} ${escapeHtml(database)}</pre>
<p><a href="/admin">Back to the console</a></p>`,
  });
}