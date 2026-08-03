import { escapeHtml } from './layout.js';

// Renders a stack of { kind, text } notices as styled <div>s. Shared by every
// admin page. (statusCard/parseServerInfo are added in a later task.)
export function notices(list = []) {
  return list.map((n) => `<div class="notice ${escapeHtml(n.kind)}">${escapeHtml(n.text)}</div>`).join('\n');
}

// Tolerant regex over the real `server info` output. Only version-stable fields
// are "reliable"; uptime's label is locale-dependent so it is best-effort.
// Returns null when nothing reliable matches, so the caller can fall back to
// the raw <pre> (v1 behaviour) and lose nothing.
export function parseServerInfo(output) {
  if (typeof output !== 'string' || output === '') return null;
  const num = (re) => { const m = re.exec(output); return m ? Number(m[1]) : undefined; };
  const online = num(/Connected players:\s*(\d+)/);
  const peak = num(/Connection peak:\s*(\d+)/);
  const updateMs = num(/Update time diff:\s*(\d+)ms/);
  const buildMatch = /rev\.\s*([0-9a-f]{7,})/.exec(output);
  const build = buildMatch ? buildMatch[1] : undefined;
  const uptimeMatch = /Uptime:\s*([0-9dhms ]+)/i.exec(output);
  const uptime = uptimeMatch ? uptimeMatch[1].trim() : undefined;
  if (online === undefined && peak === undefined && build === undefined) return null;
  return { online, peak, build, updateMs, uptime };
}

const KV = (label, value) =>
  value === undefined || value === null ? '' : `<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(value))}</span></div>`;

export function statusCard({ serverInfo, realmUp }) {
  if (!realmUp) {
    return `<div class="card"><h2>Server</h2><p class="muted">The worldserver is not answering on SOAP.</p></div>`;
  }
  const parsed = parseServerInfo(serverInfo ?? '');
  if (!parsed) {
    return `<div class="card"><h2>Server <span class="pill up">up</span></h2><pre>${escapeHtml(serverInfo ?? '')}</pre></div>`;
  }
  const playersPeak = parsed.online !== undefined && parsed.peak !== undefined
    ? `${parsed.online} · ${parsed.peak}` : (parsed.online ?? parsed.peak);
  return `<div class="card">
<h2>Server <span class="pill up">up</span></h2>
${KV('uptime', parsed.uptime)}
${KV('players · peak', playersPeak)}
${KV('update diff', parsed.updateMs !== undefined ? `${parsed.updateMs}ms` : undefined)}
${KV('build', parsed.build)}
<details><summary class="muted">raw output</summary><pre>${escapeHtml(serverInfo ?? '')}</pre></details>
</div>`;
}
