# Admin-UI v2 — Foundation (shell, components, Overview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the v1 admin console into a tabbed shell with a shared component layer and a live Overview dashboard, without losing any v1 capability — the foundation that the Accounts / Characters / Mailbox / Maintenance section plans build on.

**Architecture:** Pure refactor + new shell/views, still Fastify + server-rendered HTML, no bundler, still two npm deps. Routes stay in `routes/admin.js` for now (section plans carve them out). Views split into `views/`. Shared route helpers (`requireAdmin`, `soapNotice`) extracted so section route files can import them. A tiny inlined `<script>` (no new dep) polls small JSON endpoints for live updates.

**Tech Stack:** Node ≥22 ESM, `fastify` ^5, `mysql2` ^3, `node:test` + `node:assert`. No new dependencies.

## Global Constraints

(From `CLAUDE.md` + the v2 design doc. Every task implicitly includes these.)

- **Two npm deps maximum** (`fastify`, `mysql2`). No bundler, no `@fastify/static`. Browser JS is an inlined `<script>` string emitted by the view layer, same pattern as v1's inlined `<style>`.
- **Server-rendered HTML.** JS is progressive enhancement only; every destructive action is re-validated server-side.
- **Every admin route** is added to a section-level `*_ROUTES` array consumed by the table-driven guard test — an unguarded route fails the test by default.
- **SOAP errors** flow through the shared `soapNotice` taxonomy. **Passwords are never logged or echoed.**
- **Human lists filter bot accounts** (`rndbot%`, the `BOT_ACCOUNT_PREFIX` default).
- **`family-settings.ini` / `family.env` are untouched** by this work — no `ini2env.py` run needed.
- Tests: `cd admin-ui && npm test` (runs `node --test`). Targeted: `node --test test/<file>.js`.

## File Structure (after this plan)

```
admin-ui/src/
  routes/
    shared.js       NEW — requireAdmin(request, reply, auth), soapNotice(err)
    admin.js        Overview GET /admin + v1 actions (account/gmlevel/restart/backup) +
                    NEW GET /admin/status.json. Imports shared helpers.
    family.js       unchanged + NEW GET /online.json
  views/
    layout.js       NEW — escapeHtml, STYLE, layout({title,lang,user,section,body}),
                    realmPill, realmLine, dateText, bytes
    components.js   NEW — notices([...]) ; parseServerInfo(output), statusCard({...})
    family.js       NEW — loginPage, familyPage (moved from views.js)
    admin.js        NEW — adminPage, restorePage (moved from views.js; transitional)
    overview.js     NEW — overviewPage({...}) : the dashboard
  views.js          DELETED (imports updated to point at views/*)
```

Section plans (separate documents) will add `views/{accounts,characters,mailbox,maintenance}.js` + `routes/{accounts,characters,mailbox,maintenance}.js`, and relocate the transitional v1 controls off the Overview.

---

### Task 1: Extract shared route helpers

**Files:**
- Create: `admin-ui/src/routes/shared.js`
- Modify: `admin-ui/src/routes/admin.js` (remove the local `requireAdmin` and `soapNotice`, import from `./shared.js`)
- Test: `admin-ui/test/shared.test.js` (new)

**Interfaces:**
- Produces:
  - `requireAdmin(request, reply, auth)` → `Promise<user|null>`. Reads the role fresh from the DB; on non-admin sends `403` HTML and returns `null`, else returns `{ id, username, role }`. (Same contract as v1's closure version; only `auth` is now a parameter.)
  - `soapNotice(err)` → `{ kind: 'error'|'ok', text }`. Maps `SoapError.kind` (`fault|auth|forbidden|timeout|unreachable|protocol`) to operator-actionable text. Pure.

- [ ] **Step 1: Write the failing test**

Create `admin-ui/test/shared.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { soapNotice } from '../src/routes/shared.js';
import { SoapError } from '../src/soap.js';

test('soapNotice maps each SOAP error kind to actionable text', () => {
  assert.match(soapNotice(new SoapError('fault', 'Account already exists.')).text, /Account already exists\./);
  assert.match(soapNotice(new SoapError('auth', 'x', { status: 401 })).text, /SOAP_USER/);
  assert.match(soapNotice(new SoapError('forbidden', 'x', { status: 403 })).text, /GM level 3/);
  assert.match(soapNotice(new SoapError('timeout', 'x')).text, /did not answer/i);
  assert.match(soapNotice(new SoapError('unreachable', 'x')).text, /Cannot reach/i);
  assert.match(soapNotice(new SoapError('protocol', 'x')).text, /Unexpected response/i);
  for (const kind of ['fault', 'auth', 'forbidden', 'timeout', 'unreachable', 'protocol']) {
    assert.equal(soapNotice(new SoapError(kind, 'x')).kind, 'error');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd admin-ui && node --test test/shared.test.js`
Expected: FAIL — `Cannot find module '.../src/routes/shared.js'`.

- [ ] **Step 3: Create `shared.js`**

Create `admin-ui/src/routes/shared.js`:

```js
import { parseCookies, SESSION_COOKIE } from '../auth.js';

// Roles are re-read from the database here, on every request, so a session
// minted before a demotion stops working immediately. Returns the user object
// or null (after sending a 403). Section route files import this.
export async function requireAdmin(request, reply, auth) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const user = await auth.requireRole(token, 3);
  if (!user) {
    reply.code(403).type('text/html; charset=utf-8')
      .send('<p>This page needs GM level 3. <a href="/">Back</a></p>');
    return null;
  }
  return user;
}

// Maps the SOAP error taxonomy onto messages an operator can act on. A Fault is
// the command's own output and belongs in front of the user unchanged.
export function soapNotice(err) {
  switch (err.kind) {
    case 'fault':       return { kind: 'error', text: err.message };
    case 'auth':        return { kind: 'error', text: 'The worldserver rejected the SOAP service account. Check SOAP_USER / SOAP_PASS in Dokploy.' };
    case 'forbidden':   return { kind: 'error', text: 'The SOAP service account is below GM level 3. Re-run: ./scripts/admin.sh gm $SOAP_USER 3' };
    case 'timeout':     return { kind: 'error', text: 'The worldserver did not answer in time. It may be starting up or overloaded.' };
    case 'unreachable': return { kind: 'error', text: 'Cannot reach the worldserver on SOAP. Is ac-worldserver running?' };
    default:            return { kind: 'error', text: `Unexpected response from the worldserver: ${err.message}` };
  }
}
```

- [ ] **Step 4: Switch `admin.js` to import them**

In `admin-ui/src/routes/admin.js`: delete the local `requireAdmin` and `soapNotice` definitions, and add at the top:

```js
import { requireAdmin, soapNotice } from './shared.js';
```

Then change every call site `await requireAdmin(request, reply)` → `await requireAdmin(request, reply, auth)` (the function body is otherwise identical, so pass `auth`).

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `cd admin-ui && npm test`
Expected: PASS (all existing admin/guard tests still green; `shared.test.js` green).

- [ ] **Step 6: Commit**

```bash
git add admin-ui/src/routes/shared.js admin-ui/src/routes/admin.js admin-ui/test/shared.test.js
git commit -m "refactor(admin-ui): extract requireAdmin + soapNotice to routes/shared.js"
```

---

### Task 2: Split `views.js` into `views/` (pure move)

Mechanical refactor — moves existing functions into focused files and updates the three import sites. No behaviour change; `test/views.test.js` must stay green after updating its imports.

**Files:**
- Create: `admin-ui/src/views/layout.js`, `admin-ui/src/views/components.js`, `admin-ui/src/views/family.js`, `admin-ui/src/views/admin.js`
- Modify: `admin-ui/src/routes/family.js`, `admin-ui/src/routes/admin.js` (import paths), `admin-ui/test/views.test.js` (import paths)
- Delete: `admin-ui/src/views.js`

**Interfaces:**
- Produces (all unchanged from v1, just relocated):
  - `views/layout.js`: `escapeHtml(value)`, `layout({ title, lang, user, body })`, plus internal helpers `realmPill`, `realmLine`, `dateText`, `bytes` exported for reuse by sibling view files.
  - `views/components.js`: `notices(list)` → HTML string rendering `<div class="notice …">` per entry.
  - `views/family.js`: `loginPage({ error, realm })`, `familyPage({ user, realm, realmUp, online, characters, worldMessage })`.
  - `views/admin.js`: `adminPage({ … })`, `restorePage({ name })` (transitional — section plans replace `adminPage`).

- [ ] **Step 1: Create the four view files by moving code**

Move code from `admin-ui/src/views.js` verbatim into:

- `src/views/layout.js` — `HTML_ESCAPES`, `escapeHtml`, the `STYLE` constant, `layout`, `realmPill`, `realmLine`, `dateText`, `bytes`. Each view file that needs a helper imports it: `import { escapeHtml, layout, dateText, bytes, realmPill, realmLine } from './layout.js';`
- `src/views/components.js` — a new `notices(list)` helper (extract the repeated `${notices.map(n => ...).join('\n')}` into a function). Body:
  ```js
  import { escapeHtml } from './layout.js';
  export function notices(list = []) {
    return list.map((n) => `<div class="notice ${escapeHtml(n.kind)}">${escapeHtml(n.text)}</div>`).join('\n');
  }
  ```
- `src/views/family.js` — `loginPage`, `familyPage`, importing helpers from `./layout.js`.
- `src/views/admin.js` — `adminPage`, `restorePage`, importing `escapeHtml, layout, dateText, bytes, realmLine` from `./layout.js` and `notices` from `./components.js`. (Replace the inline notices map in `adminPage` with `${notices(notices_arg)}` — rename the param to avoid shadowing, e.g. the page function param `notices` becomes `noticeList` and the body calls `notices(noticeList)`.)

- [ ] **Step 2: Update imports**

- `admin-ui/src/routes/family.js`: `import { loginPage, familyPage } from '../views.js';` → `from '../views/family.js';`
- `admin-ui/src/routes/admin.js`: `import { adminPage, restorePage } from '../views.js';` → `from '../views/admin.js';`
- `admin-ui/test/views.test.js`: change the single import line to:
  ```js
  import { escapeHtml, layout } from '../src/views/layout.js';
  import { loginPage, familyPage } from '../src/views/family.js';
  import { adminPage, restorePage } from '../src/views/admin.js';
  ```
  (The existing assertions reference these names only.)

- [ ] **Step 3: Delete the old file**

```bash
rm admin-ui/src/views.js
```

- [ ] **Step 4: Run the full suite**

Run: `cd admin-ui && npm test`
Expected: PASS — all view + route tests green (pure move).

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/views admin-ui/src/routes/family.js admin-ui/src/routes/admin.js admin-ui/test/views.test.js
git rm admin-ui/src/views.js
git commit -m "refactor(admin-ui): split views.js into views/{layout,components,family,admin}.js"
```

---

### Task 3: Admin tab-nav shell

Add the top tab bar to the admin layout. Family pages pass no `section` and get no tabs (unchanged look).

**Files:**
- Modify: `admin-ui/src/views/layout.js` (add `section` param + tab bar), `admin-ui/test/views.test.js`

**Interfaces:**
- Produces: `layout({ title, lang, user, section, body })` — when `section` is one of `overview|accounts|characters|mailbox|maintenance|backups`, renders a `<nav class="tabs">` with the six tabs, the matching one marked `class="tab active"`. When `section` is omitted, no nav (family pages).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Add to `admin-ui/test/views.test.js`:

```js
import { layout } from '../src/views/layout.js';

const TABS = ['overview', 'accounts', 'characters', 'mailbox', 'maintenance', 'backups'];

test('an admin page renders the six section tabs with the active one marked', () => {
  const html = layout({ title: 'Realm admin', lang: 'en', user: { username: 'PAPA', role: 3 }, section: 'overview', body: '' });
  for (const t of TABS) assert.match(html, new RegExp(t), `missing tab ${t}`);
  assert.match(html, /class="tab active"[^]*>Overview</); // overview marked active
});

test('a family page (no section) renders no tab nav', () => {
  const html = layout({ title: 'Azeroth Familiar', lang: 'es', body: '' });
  assert.ok(!/class="tabs"/.test(html));
});

test('the active tab follows the section argument', () => {
  const html = layout({ title: 'x', lang: 'en', user: { username: 'PAPA', role: 3 }, section: 'accounts', body: '' });
  assert.match(html, /href="\/admin\/accounts"[^>]*class="tab active"/);
  assert.ok(!/class="tab active"[^]*>Overview</.test(html));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd admin-ui && node --test test/views.test.js`
Expected: FAIL — the `section` tests fail (current `layout` ignores `section`).

- [ ] **Step 3: Implement the tab bar**

In `admin-ui/src/views/layout.js`, extend `STYLE` with:

```css
nav.tabs { display:flex; flex-wrap:wrap; gap:0; border-bottom:1px solid var(--line); margin:0 0 1rem; }
nav.tabs a { padding:.5rem .8rem; color:var(--muted); text-decoration:none; font-size:.9rem; border-bottom:2px solid transparent; }
nav.tabs a.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:600; }
```

and change `layout` to accept `section` and render the nav when set. The tab labels are English (admin audience) and point at the section routes:

```js
const TAB_DEFS = [
  ['overview', 'Overview', '/admin'],
  ['accounts', 'Accounts', '/admin/accounts'],
  ['characters', 'Characters', '/admin/characters'],
  ['mailbox', 'Mailbox', '/admin/mailbox'],
  ['maintenance', 'Maintenance', '/admin/maintenance'],
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
     <button type="submit">${lang === 'es' ? 'Salir' : 'Log out'}</button></form>` : ''}</div>
${tabs}
${body}
</main></body></html>`;
}
```

> Note: only four real sections exist today; `mailbox` and `maintenance` tabs render but their routes are built by later section plans (they will return a stub until then — Task 5 adds a tiny stub so the links don't 404).

- [ ] **Step 4: Run tests**

Run: `cd admin-ui && node --test test/views.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/views/layout.js admin-ui/test/views.test.js
git commit -m "feat(admin-ui): add tab-nav shell to admin layout"
```

---

### Task 4: `parseServerInfo` + `statusCard`

The signature v2 win over v1's raw `<pre>`. Pure function + tolerant regex over the real `server info` output, with a raw fallback.

**Files:**
- Modify: `admin-ui/src/views/components.js`, `admin-ui/test/views.test.js`

**Interfaces:**
- Produces:
  - `parseServerInfo(output)` → `{ online, peak, build, updateMs, uptime } | null`. Returns `null` when none of the reliable fields match (caller renders the raw block instead). `build` is the short revision hash; `uptime` is best-effort (may be `undefined`).
  - `statusCard({ serverInfo, realmUp })` → HTML string: a `<div class="card">` of the parsed fields when `parseServerInfo` succeeds, with a `<details><summary>raw output</summary><pre>…</pre></details>` expander underneath. When `realmUp` is false, renders a "worldserver not answering" card. When up but unparseable, renders the raw `<pre>` (v1 behaviour) inside the card.

- [ ] **Step 1: Write the failing tests**

Add to `admin-ui/test/views.test.js`:

```js
import { parseServerInfo, statusCard } from '../src/views/components.js';

const SAMPLE = `Default DBC locale: enUS.
Using World DB: 2026-08-03.
Connected players: 3. Characters in world: 12.
Connection peak: 5.
Server Uptime: 4h 12m 3s
Update time diff: 7ms. Last 100 diffs summary:
AzerothCore rev. 3aff15d 3.3.5a (Unix, 2026-08-03) (Playerbot)`;

test('parseServerInfo extracts the reliable fields from a real sample', () => {
  const p = parseServerInfo(SAMPLE);
  assert.equal(p.online, 3);
  assert.equal(p.peak, 5);
  assert.equal(p.build, '3aff15d');
  assert.equal(p.updateMs, 7);
  assert.match(p.uptime, /4h 12m/);
});

test('parseServerInfo returns null on totally unrecognised output', () => {
  assert.equal(parseServerInfo('hello world'), null);
  assert.equal(parseServerInfo(''), null);
});

test('statusCard shows parsed fields and a raw-output expander when up', () => {
  const html = statusCard({ serverInfo: SAMPLE, realmUp: true });
  assert.match(html, /Connected players/); // label or value present
  assert.match(html, /3/);
  assert.match(html, /<details>/);
  assert.match(html, /3aff15d/); // raw still present in the expander
});

test('statusCard falls back to raw pre when the output is unparseable', () => {
  const html = statusCard({ serverInfo: 'something odd', realmUp: true });
  assert.match(html, /<pre>/);
  assert.match(html, /something odd/);
});

test('statusCard says the worldserver is down when realmUp is false', () => {
  const html = statusCard({ serverInfo: null, realmUp: false });
  assert.match(html, /not answering/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd admin-ui && node --test test/views.test.js`
Expected: FAIL — `parseServerInfo`/`statusCard` not exported.

- [ ] **Step 3: Implement**

Append to `admin-ui/src/views/components.js`:

```js
import { escapeHtml } from './layout.js';

// Tolerant regex over the real `server info` output. Only fields that are
// version-stable are "reliable"; uptime's label is locale-dependent so it is
// best-effort. Returns null when nothing reliable matches, so the caller can
// fall back to the raw <pre> (v1 behaviour) and lose nothing.
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
  return `<div class="card">
<h2>Server <span class="pill up">up</span></h2>
${KV('uptime', parsed.uptime)}
${KV('players · peak', parsed.online !== undefined && parsed.peak !== undefined ? `${parsed.online} · ${parsed.peak}` : parsed.online ?? parsed.peak)}
${KV('update diff', parsed.updateMs !== undefined ? `${parsed.updateMs}ms` : undefined)}
${KV('build', parsed.build)}
<details><summary class="muted">raw output</summary><pre>${escapeHtml(serverInfo ?? '')}</pre></details>
</div>`;
}
```

Add `.card`, `.kv`, `.pill`, `details summary` styling to the `STYLE` constant in `views/layout.js`:

```css
.card { border:1px solid var(--line); border-radius:.4rem; padding:.6rem .8rem; margin:0 0 .75rem; }
.card h2 { margin:0 0 .4rem; font-size:1rem; border:0; padding:0; display:inline; }
.kv { display:flex; justify-content:space-between; font-size:.9rem; padding:.1rem 0; }
.kv span:first-child { color:var(--muted); }
.pill { font-size:.75rem; padding:.05rem .45rem; border-radius:1rem; border:1px solid var(--line); }
.pill.up { color:var(--good); border-color:var(--good); }
details summary { cursor:pointer; font-size:.85rem; }
```

- [ ] **Step 4: Run tests**

Run: `cd admin-ui && node --test test/views.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/views/components.js admin-ui/src/views/layout.js admin-ui/test/views.test.js
git commit -m "feat(admin-ui): parse server info into a status card with raw fallback"
```

---

### Task 5: Overview dashboard page + GET /admin

Compose the dashboard and make `/admin` render it inside the shell, with the v1 controls kept in a clearly-transitional block so nothing is lost (section plans relocate them).

**Files:**
- Create: `admin-ui/src/views/overview.js`
- Modify: `admin-ui/src/routes/admin.js` (render overview at GET /admin; add stub routes for `/admin/mailbox` and `/admin/maintenance` so Task 3's tab links don't 404), `admin-ui/src/views/admin.js` (export the v1 action block as `legacyActions()` for reuse), `admin-ui/test/routes.test.js`

**Interfaces:**
- Produces:
  - `overviewPage({ user, realm, realmUp, serverInfo, online, backupStatus, notices })` → HTML body string (no outer `<html>`; `layout` wraps it). Contains: notices, `statusCard`, a realm line, a backups strip, the online-humans table, a single quick action (Restart → existing `/admin/restart`), and the transitional `legacyActions()` block (Create account / Set GM / Back up now) labeled "Moving to their own tabs."
- Consumes: `layout({...,section:'overview'})`, `statusCard`, `notices`, `legacyActions` (from `views/admin.js`).

- [ ] **Step 1: Write the failing test**

Add to `admin-ui/test/routes.test.js` (inside the admin-test section, after the existing `buildAdmin` helper):

```js
test('GET /admin renders the Overview dashboard inside the tab shell', async () => {
  const { fastify } = await buildAdmin({
    soap: stubSoap(async () => ({ ok: true, output: 'Connected players: 3. Connection peak: 5. rev. 3aff15d' })),
  });
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({ method: 'GET', url: '/admin', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /class="tabs"/);            // tab shell
  assert.match(res.body, /Overview/);                // overview tab label
  assert.match(res.body, /Connected players/);       // parsed status card
  assert.match(res.body, /Quick actions/i);          // dashboard section
  await fastify.close();
});

test('the un-built section tabs resolve to a stub, not a 404', async () => {
  const { fastify } = await buildAdmin();
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  for (const url of ['/admin/mailbox', '/admin/maintenance']) {
    const res = await fastify.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal(res.statusCode, 200, url);
  }
  await fastify.close();
});
```

Add the two new GET routes to the `ADMIN_ROUTES` table in `admin-ui/src/routes/admin.js` (so the guard test covers them):

```js
{ method: 'GET', url: '/admin/mailbox' },
{ method: 'GET', url: '/admin/maintenance' },
```

- [ ] **Step 2: Run to verify failure**

Run: `cd admin-ui && node --test test/routes.test.js`
Expected: FAIL — overview test (no `Quick actions` / parsed card yet) and stub test (404s).

- [ ] **Step 3: Extract `legacyActions()` from the existing `adminPage`**

In `admin-ui/src/views/admin.js`, pull the "Create an account", "Set GM level", and "Backups → Back up now" forms out of `adminPage` into an exported helper:

```js
export function legacyActions({ down, backupDown }) {
  return `
<h2>Quick actions</h2>
<p class="muted">These are moving to their own tabs (Accounts, Maintenance, Backups) in later updates.</p>
<form action="/admin/account" method="post">
  <label>Username <input name="username" pattern="[A-Za-z0-9]{3,16}" required></label>
  <label>Password <input name="password" type="password" minlength="4" maxlength="16" required></label>
  <button type="submit"${down}>Create</button>
</form>
<h2>Set GM level</h2>
<form action="/admin/gmlevel" method="post">
  <label>Username <input name="username" pattern="[A-Za-z0-9]{3,16}" required></label>
  <label>Level <select name="level"><option>0</option><option>1</option><option>2</option><option>3</option></select></label>
  <label>Type the username again to confirm <input name="confirm"></label>
  <button type="submit"${down}>Apply</button>
</form>`;
}
```

(Leave `adminPage` and `restorePage` in place for now — they keep v1's exact markup and are still tested; section plans remove them.)

- [ ] **Step 4: Create `overview.js`**

Create `admin-ui/src/views/overview.js`:

```js
import { escapeHtml, realmLine, bytes, dateText } from './layout.js';
import { notices } from './components.js';
import { statusCard } from './components.js';
import { legacyActions } from './admin.js';

const onlineRows = (online) => online.length === 0
  ? `<tr><td colspan="3" class="muted">No humans online.</td></tr>`
  : online.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.level)}</td><td>${escapeHtml(c.classId)}</td></tr>`).join('\n');

export function overviewPage({ user, realm, realmUp, serverInfo, online, backupStatus, noticeList }) {
  const down = realmUp ? '' : ' disabled';
  const backupDown = backupStatus.state === 'running' ? ' disabled' : '';
  return `
${notices(noticeList)}
${statusCard({ serverInfo, realmUp })}
${realmLine(realm)}
<h2>Backups</h2>
<p class="muted">Last: ${escapeHtml(backupStatus.finishedAt ? dateText(backupStatus.finishedAt, 'en') : 'never')} · ${backupStatus.done?.length ?? 0} file(s) this run.
 <form action="/admin/backup" method="post" style="display:inline"><button type="submit"${backupDown}>Back up now</button></form></p>
<h2>Quick actions</h2>
<form action="/admin/restart" method="post">
  <button type="submit"${down}>Graceful restart (30s warning)</button>
</form>
<h2>Online now (humans)</h2>
<table><thead><tr><th>Name</th><th>Level</th><th>Class</th></tr></thead>
<tbody>${onlineRows(online)}</tbody></table>
${legacyActions({ down, backupDown })}
`;
}
```

- [ ] **Step 5: Render it from the route**

In `admin-ui/src/routes/admin.js`, change the existing `render()` helper so the GET `/admin` path wraps `overviewPage` in `layout({...,section:'overview'})`. Concretely, replace the body returned by `render()` with:

```js
import { overviewPage } from '../views/overview.js';
import { layout } from '../views/layout.js';
// ...
return reply.code(code).type('text/html; charset=utf-8').send(layout({
  title: 'Realm admin', lang: 'en', user, section: 'overview',
  body: overviewPage({ user, realm, realmUp, serverInfo, online: [], backupStatus: backups.status(), noticeList: notices }),
}));
```

where `online` is fetched the same way the family page does (add `db.listOnlineCharacters()` to the `Promise.all` in `render()`, defaulting to `[]` on error). Keep `notices` as the render param name passed into `overviewPage` as `noticeList`.

Add the two stub routes (guarded):

```js
fastify.get('/admin/mailbox', async (request, reply) => {
  const user = await requireAdmin(request, reply, auth); if (!user) return reply;
  return reply.type('text/html; charset=utf-8').send(layout({
    title: 'Mailbox', lang: 'en', user, section: 'mailbox',
    body: `${notices([])}<p class="muted">Mailbox is built in a later update.</p>`,
  }));
});
fastify.get('/admin/maintenance', async (request, reply) => {
  const user = await requireAdmin(request, reply, auth); if (!user) return reply;
  return reply.type('text/html; charset=utf-8').send(layout({
    title: 'Maintenance', lang: 'en', user, section: 'maintenance',
    body: `${notices([])}<p class="muted">Maintenance is built in a later update.</p>`,
  }));
});
```

(`notices` here is the imported helper from `views/components.js`; add that import.)

- [ ] **Step 6: Run the full suite**

Run: `cd admin-ui && npm test`
Expected: PASS — new overview + stub tests green; all v1 guard/action tests still green (the v1 POST routes `/admin/account`, `/admin/gmlevel`, `/admin/restart`, `/admin/backup*` are unchanged).

- [ ] **Step 7: Commit**

```bash
git add admin-ui/src/views/overview.js admin-ui/src/views/admin.js admin-ui/src/routes/admin.js admin-ui/test/routes.test.js
git commit -m "feat(admin-ui): Overview dashboard on a tabbed shell (v1 controls kept transitional)"
```

---

### Task 6: Live polling — `GET /admin/status.json` + inline poller

A single JSON endpoint driving the Overview's online + backup panels, refreshed by a tiny inlined script with no new dependency.

**Files:**
- Modify: `admin-ui/src/routes/admin.js` (add `/admin/status.json`, guard-protected), `admin-ui/src/views/layout.js` (emit `POLL_SCRIPT` when asked), `admin-ui/src/views/overview.js` (tag poll targets + request the script), `admin-ui/test/routes.test.js`

**Interfaces:**
- Produces:
  - `GET /admin/status.json` → `{ online: number, backup: { state, current?, done: number } }`. Guarded by `requireAdmin`.
  - `POLL_SCRIPT` (exported from `views/layout.js`) — a string of framework-free JS that, every 5s, `fetch`es a given URL and swaps the text of elements by `data-poll` key.
- Consumes: `db.listOnlineCharacters()` (length, bot-filtered), `backups.status()`.

- [ ] **Step 1: Write the failing tests**

Add to `admin-ui/test/routes.test.js`:

```js
test('GET /admin/status.json returns online count and backup state, guarded', async () => {
  const { fastify } = await buildAdmin({
    db: stubDb({ async listOnlineCharacters() { return [{}, {}, {}]; } }),
    backups: stubBackups({ status: () => ({ state: 'running', current: 'acore_auth', done: ['x'] }) }),
  });
  // refused without a session
  const noauth = await fastify.inject({ method: 'GET', url: '/admin/status.json' });
  assert.equal(noauth.statusCode, 403);
  // allowed with one
  const cookie = await sessionFor(fastify, 'papa', 'goodpw');
  const res = await fastify.inject({ method: 'GET', url: '/admin/status.json', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  const body = JSON.parse(res.body);
  assert.equal(body.online, 3);
  assert.equal(body.backup.state, 'running');
  assert.equal(body.backup.done, 1);
  await fastify.close();
});
```

Add `{ method: 'GET', url: '/admin/status.json' }` to `ADMIN_ROUTES`.

- [ ] **Step 2: Run to verify failure**

Run: `cd admin-ui && node --test test/routes.test.js`
Expected: FAIL — route missing.

- [ ] **Step 3: Add the route**

In `admin-ui/src/routes/admin.js`:

```js
fastify.get('/admin/status.json', async (request, reply) => {
  const user = await requireAdmin(request, reply, auth); if (!user) return reply;
  const [online, backupStatus] = await Promise.all([
    db.listOnlineCharacters().catch(() => []),
    backups.status(),
  ]);
  return reply.send({
    online: online.length,
    backup: { state: backupStatus.state, current: backupStatus.current, done: backupStatus.done?.length ?? 0 },
  });
});
```

- [ ] **Step 4: Add the poller script + emit it**

In `admin-ui/src/views/layout.js`:

```js
export const POLL_SCRIPT = `
<script>
(function(){
  function tick(){
    fetch(document.body.getAttribute('data-poll-url'))
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!d) return;
        document.querySelectorAll('[data-poll]').forEach(el => {
          const k = el.getAttribute('data-poll');
          if (k === 'online') el.textContent = d.online + ' humans online';
          if (k === 'backup') el.textContent = 'Backup: ' + d.backup.state + (d.backup.current ? ' (' + d.backup.current + ')' : '');
        });
      }).catch(()=>{});
  }
  setInterval(tick, 5000); tick();
})();
</script>`;
```

Extend `layout({...,poll})` so that when `poll` is truthy it sets `<body data-poll-url="${poll}">` and appends `${POLL_SCRIPT}` before `</body>`. (One line in the template: `<body data-poll-url="${escapeHtml(poll ?? '')}">`, and `${poll ? POLL_SCRIPT : ''}` before `</body>`.)

- [ ] **Step 5: Wire the Overview to the poller**

In `overviewPage`, pass the URL up to `layout` (the route already calls `layout`; add `poll: '/admin/status.json'` to that call), and tag two elements: add `<p data-poll="online" class="muted">${online.length} humans online</p>` above the online table, and `<p data-poll="backup" class="muted">Backup: ${backupStatus.state}</p>` in the backups section.

- [ ] **Step 6: Run the full suite**

Run: `cd admin-ui && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add admin-ui/src/routes/admin.js admin-ui/src/views/layout.js admin-ui/src/views/overview.js admin-ui/test/routes.test.js
git commit -m "feat(admin-ui): live-poll Overview online + backup status, no new deps"
```

---

### Task 7: Family page light-touch live online list

Same poller pattern, Spanish page, `GET /online.json`.

**Files:**
- Modify: `admin-ui/src/routes/family.js` (add `/online.json`, re-render family page via a small data attr), `admin-ui/src/views/family.js` (tag the online section), `admin-ui/test/routes.test.js`

**Interfaces:**
- Produces: `GET /online.json` → `{ names: string[], realmUp: boolean }` (session-scoped; the family user only sees the same bot-filtered list).
- Consumes: `POLL_SCRIPT` from `views/layout.js`.

- [ ] **Step 1: Write the failing test**

Add to `admin-ui/test/routes.test.js`:

```js
test('GET /online.json returns the online human names for a family session', async () => {
  const { fastify } = await buildFamily({
    db: stubDb({ async listOnlineCharacters() { return [{ name: 'Ninadruida', level: 23, classId: 11, raceId: 4, accountName: 'NINA' }]; } }),
  });
  const noauth = await fastify.inject({ method: 'GET', url: '/online.json' });
  assert.equal(noauth.statusCode, 302); // redirected to login (no session)
  const { cookie } = await loginAs(fastify, 'nina', 'kidpw');
  const res = await fastify.inject({ method: 'GET', url: '/online.json', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).names, ['Ninadruida']);
  await fastify.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd admin-ui && node --test test/routes.test.js`
Expected: FAIL — `/online.json` missing.

- [ ] **Step 3: Add the route + tag the page**

In `admin-ui/src/routes/family.js`:

```js
fastify.get('/online.json', async (request, reply) => {
  const session = sessionFrom(request);
  if (!session) return reply.redirect('/login');
  const realmState = await probeRealm(soap);
  const online = realmState.up ? await db.listOnlineCharacters().catch(() => []) : [];
  return reply.send({ names: online.map((c) => c.name), realmUp: realmState.up });
});
```

In `familyPage`, accept an optional `poll` and pass it to `layout`, and tag the "Quién está jugando" heading container with `data-poll="online"` (the poller will overwrite its text with a joined name list — extend `POLL_SCRIPT`'s family branch, or simplest: add a second tiny inline script in `familyPage` that updates a `<ul data-poll="online-names">` from `/online.json`). Minimal version — add to `familyPage` body, above the online table:

```html
<p data-poll="online" class="muted">…</p>
```

and emit `POLL_SCRIPT` via `layout({...,poll:'/online.json'})`. Extend the poller's online branch to handle an array of names:

```js
if (k === 'online' && Array.isArray(d.names)) el.textContent = d.names.length ? d.names.join(', ') : 'Nadie conectado.';
```

(The poller keys off whether `d.names` exists vs `d.online`, so the same script serves both pages.)

- [ ] **Step 4: Run the full suite**

Run: `cd admin-ui && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-ui/src/routes/family.js admin-ui/src/views/family.js admin-ui/src/views/layout.js admin-ui/test/routes.test.js
git commit -m "feat(admin-ui): live-poll the family page online list"
```

---

## Self-Review

**Spec coverage (design doc → this plan):** top-tab shell (Task 3) ✓; parsed `server info` status card (Task 4) ✓; Overview status + quick actions (Task 5; restart quick-action ✓ — lock-logins/broadcast deferred to the Maintenance section plan, as scoped) ✓; live polling (Tasks 6–7) ✓; directory→detail + tiered confirmation components — **not in this plan by design**; they are introduced in the Accounts section plan, which first needs `confirmForm`/`areYouSure`/`actionTable`. The SOAP-account lock is enforced there too. The Backups relocation and family light-touch are here ✓.

**Type/name consistency:** `layout({title,lang,user,section,body,poll})`, `overviewPage({user,realm,realmUp,serverInfo,online,backupStatus,noticeList})`, `requireAdmin(request,reply,auth)`, `soapNotice(err)` — used identically across tasks. `ADMIN_ROUTES` gains each new GET route in the same task that adds it (guard test stays honest).

**Placeholder scan:** none. Refactor tasks reference existing functions by name + file and say "move verbatim" (the code already lives in the repo). New code is written in full.

**Scope:** this plan is shippable on its own — after Task 7 the console has the new tabbed shell, the live Overview dashboard with the parsed status card, and every v1 capability intact. The four section plans build on the produced interfaces (`layout` with `section`, `statusCard`, `notices`, `requireAdmin`, `soapNotice`, `POLL_SCRIPT`).

## Following plans (separate documents, same format)

1. **Accounts** — `routes/accounts.js` + `views/accounts.js`; move `/admin/account` + `/admin/gmlevel` out of the transitional block; add the directory query (`listAccounts` in `db.js`), the detail page `/admin/accounts/:name`, reset password (`account set password`), mute/unmute, delete account; introduce `confirmForm`/`areYouSure`/`actionTable` in `views/components.js`; enforce the SOAP-account lock.
2. **Characters** — directory + detail + deleted list (`deleteDate` queries); rename / set level / customize / change-race / change-faction / erase / restore-deleted.
3. **Mailbox** — `send money` / `send items` / `send mail` at Moderate confirmation.
4. **Maintenance** — restart + **cancel** (3-state, in-memory tracker), lock logins (`server set closed`), broadcast (`announce`/`notify`), set MOTD; removes the transitional restart form.
