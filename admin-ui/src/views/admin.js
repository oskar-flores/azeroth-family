import { escapeHtml, layout, realmPill, realmLine, dateText, bytes } from './layout.js';
import { notices as renderNotices } from './components.js';

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
${renderNotices(notices)}
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

// The v1 create-account and set-GM-level forms, kept on the Overview under a
// clearly-transitional label until the Accounts section plan relocates them.
// Headings are verbatim from v1 so existing route assertions still match.
export function legacyActions({ down = '' } = {}) {
  return `
<h2>Create an account</h2>
<p class="muted">Moving to the Accounts tab in a later update.</p>
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
`;
}
