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
nav.tabs { display:flex; flex-wrap:wrap; gap:0; border-bottom:1px solid var(--line); margin:0 0 1rem; }
nav.tabs a { padding:.5rem .8rem; color:var(--muted); text-decoration:none; font-size:.9rem; border-bottom:2px solid transparent; }
nav.tabs a.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:600; }
`;

const TAB_DEFS = [
  ['overview', 'Overview', '/admin'],
  ['accounts', 'Accounts', '/admin/accounts'],
  ['characters', 'Characters', '/admin/characters'],
  ['mailbox', 'Mailbox', '/admin/mailbox'],
  ['maintenance', 'Maintenance', '/admin/maintenance'],
  ['backups', 'Backups', '/admin#backups'],
];

export function layout({ title, lang = 'es', body, user, section }) {
  const tabs = section
    ? `<nav class="tabs">${TAB_DEFS.map(([key, label, href]) =>
        `<a class="tab ${key === section ? 'active' : ''}" href="${href}">${escapeHtml(label)}</a>`).join('')}</nav>`
    : '';
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>
<div class="bar"><h1>${escapeHtml(title)}</h1>${user
  ? `<form action="/logout" method="post"><span class="muted">${escapeHtml(user.username)}</span>
     <button type="submit">${lang === 'es' ? 'Salir' : 'Log out'}</button></form>`
  : ''}</div>
${tabs}
${body}
</main></body></html>`;
}

export const realmPill = (up, lang) => up
  ? `<span class="pill up">${lang === 'es' ? 'en línea' : 'up'}</span>`
  : `<span class="pill down">${lang === 'es' ? 'apagado' : 'down'}</span>`;

export const realmLine = (realm) => realm
  ? `<p class="muted">${escapeHtml(realm.name)} — <code>${escapeHtml(realm.address)}:${escapeHtml(realm.port)}</code></p>`
  : '';

export const dateText = (value, lang) => value
  ? escapeHtml(value.toISOString().slice(0, 16).replace('T', ' '))
  : `<span class="muted">${lang === 'es' ? 'nunca' : 'never'}</span>`;

export const bytes = (n) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB`
  : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : `${(n / 1024).toFixed(0)} KB`;
