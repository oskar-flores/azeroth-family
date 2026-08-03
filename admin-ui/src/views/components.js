import { escapeHtml } from './layout.js';

// Renders a stack of { kind, text } notices as styled <div>s. Shared by every
// admin page. (statusCard/parseServerInfo are added in a later task.)
export function notices(list = []) {
  return list.map((n) => `<div class="notice ${escapeHtml(n.kind)}">${escapeHtml(n.text)}</div>`).join('\n');
}
