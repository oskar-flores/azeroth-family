import { escapeHtml, realmLine } from './layout.js';
import { notices, statusCard } from './components.js';
import { className } from '../lookups.js';
import { legacyActions } from './admin.js';

const onlineRows = (online) => online.length === 0
  ? `<tr><td colspan="4" class="muted">No humans online.</td></tr>`
  : online.map((c) => `<tr>
      <td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.level)}</td>
      <td>${escapeHtml(className(c.classId))}</td><td>${escapeHtml(c.accountName ?? '')}</td></tr>`).join('\n');

// The Overview dashboard body (wrapped by layout({section:'overview'}) in the
// route). statusCard parses server info; the v1 create/gmlevel controls live in
// legacyActions() until the Accounts section plan relocates them.
export function overviewPage({ user, realm, realmUp, serverInfo, online, backupStatus, noticeList }) {
  const down = realmUp ? '' : ' disabled';
  const backupDown = backupStatus.state === 'running' ? ' disabled' : '';
  return `
${notices(noticeList)}
${statusCard({ serverInfo, realmUp })}
${realmLine(realm)}

<h2 id="backups">Backups</h2>
<p data-poll="backup" class="muted">Backup: ${escapeHtml(backupStatus.state)}</p>
<p class="muted">Status: ${escapeHtml(backupStatus.state)}. ${escapeHtml(String(backupStatus.done?.length ?? 0))} file(s) last run.</p>
<form action="/admin/backup" method="post">
  <button type="submit"${backupDown}>Back up now</button>
</form>

<h2>Quick actions</h2>
<form action="/admin/restart" method="post">
  <button type="submit"${down}>Graceful restart (30s warning)</button>
</form>
<p class="muted">Lock-logins, broadcast and MOTD arrive with the Maintenance tab.</p>

<h2>Online now (humans)</h2>
<p data-poll="online" class="muted">${escapeHtml(String(online.length))} humans online</p>
<table><thead><tr><th>Name</th><th>Level</th><th>Class</th><th>Account</th></tr></thead>
<tbody>${onlineRows(online)}</tbody></table>

${legacyActions({ down })}
`;
}
