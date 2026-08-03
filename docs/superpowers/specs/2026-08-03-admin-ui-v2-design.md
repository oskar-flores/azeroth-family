# Design: `ac-admin-ui` v2 — redesign + SOAP feature expansion

Date: 2026-08-03
Status: approved, ready for implementation planning
Supersedes (extends): `2026-07-30-admin-ui-design.md` (v1, shipped)

## Context

v1 shipped with a working but minimal console: one scrolling admin page, four
SOAP commands (`account create`, `account set gmlevel`, `server info`,
`server restart 30`), backups, and a restore-instructions page. Every
capability that v1 *doesn't* have still routes through `scripts/admin.sh` on the
host — including the most common one (resetting a forgotten password, which
`admin.sh` cannot even do; it needs the raw console).

v2 restructures the console and expands what it can do over SOAP. The two are
the same job: bolting ~20 new actions onto v1's single page would be button
soup, so the information-architecture change *is* the structure that holds the
features.

All four design decisions below were validated against mockups in a
brainstorming session before this doc was written.

## Scope

### In (the v2 slice)

- **Redesign:** top-tab shell; parsed `server info` status card; live polling;
  directory→detail navigation; one reusable tiered confirmation pattern. Kept
  on the existing stack — Fastify, server-rendered HTML, **no bundler**, still
  two npm deps (`fastify`, `mysql2`). The warm parchment/dark palette is
  retained; this is a structural redesign, not a recolor.
- **Accounts:** directory + reset password + set GM level + mute/unmute +
  delete account.
- **Characters:** directory + restore-deleted + rename + set level +
  customize/change-race/change-faction + erase.
- **Mailbox:** send gold / send items / send mail (by character name, offline;
  raw item IDs — no lookup yet).
- **Maintenance:** restart (+ **cancel**) · lock logins (`server set closed`) ·
  broadcast (`announce` / `notify`) · set MOTD.
- **Backups:** unchanged behaviour + live-progress polling.
- **Family page:** light touch only — live-poll the online list; do not rebuild.

### Out (deliberate)

- **Bots** (`playerbots rndbot …`) — powerful and risky; **v3**.
- **Shutdown** — the operator already stops the world via Dokploy, so
  `server shutdown`/`… cancel` are redundant. Maintenance keeps *restart* + cancel
  (graceful, in-game countdown, auto-returns via `restart: unless-stopped`).
- **Restore-from-backup button** — still unsafe. SOAP can shut the world down
  but cannot *hold* it down against `restart: unless-stopped`; the live server
  flushes in-memory state over the imported rows. Stays in `admin.sh`. (See
  v1 design doc, "Restore is out of scope".)
- **2FA, ban-by-IP, arena/LFG, set-email, set-addon, item-ID lookup,
  self-service password change.** Low value for this realm or separate concern.

## Design decisions

| Question | Decision |
|---|---|
| App shell & nav | **Top tab bar.** Six flat sections; wraps on phones (a tailnet reached from phones). Status pill + login live in the header. |
| Overview density | **Status + quick actions.** Parsed status card + the three hot actions (restart→cancel, lock logins, broadcast) surfaced; full controls stay on Maintenance. |
| Action UI | **Directory → detail page.** Tables are scannable, mobile-friendly directories of links; each entity gets a detail route with its action forms. Mirrors v1's `/admin/restore/:name`. |
| Confirmation | **Tiered (Severe / Moderate / Mild).** Friction matches consequence; one shared `confirmForm` + one `areYouSure` helper drive every destructive action. |
| New dependencies | **None.** Polling JS is a small `<script>` inlined by the layout, same pattern as v1's inlined `<style>`. |
| SOAP service account | **The UI refuses to act on `SOAP_USER`.** Resetting its password or demoting it would brick the console. |

### Sections / tab bar

```
Overview · Accounts · Characters · Mailbox · Maintenance · Backups
```

The nav is rendered only for gmlevel-3 sessions. The family page (Spanish,
read-only) is unchanged in audience and gets only a light live-poll touch.

## Architecture

Same service, same network position, same `restart: unless-stopped`. No change
to `docker-compose.yml`. The redesign is internal to `admin-ui/`.

### File split (the redesign makes the v1 files grow — split them)

v1 had one `routes/admin.js` (204 lines) and one `views.js` (206 lines). v2 adds
~20 routes and ~10 page functions, so both are split by section:

```
admin-ui/src/
  routes/
    admin.js        Overview + Backups + shared helpers (requireAdmin, render, soapNotice)
    accounts.js     /admin/accounts, /admin/accounts/:name (+ actions)
    characters.js   /admin/characters, /admin/characters/:name, /admin/characters/deleted
    mailbox.js      /admin/mailbox (send money/items/mail)
    maintenance.js  /admin/maintenance (+ restart/cancel, closed, announce, motd)
    family.js       unchanged + light online-poller script
  views/
    layout.js       shell: <head>, style, tab bar, header, inlined poller script
    components.js   statusCard(serverInfo), actionTable(rows,…),
                    confirmForm({label,typedMatch,button}), areYouSure({…}), notice()
    overview.js accounts.js characters.js mailbox.js maintenance.js backups.js
  soap.js            unchanged: executeCommand(cmd)
  db.js              + listAccounts(), listCharacters(), listDeletedCharacters()
  backup.js          unchanged
  auth.js server.js  unchanged
```

Every new admin route is added to a section-level `*_ROUTES` export consumed by
the existing table-driven guard test — an unguarded new route fails the test by
default rather than shipping open. `requireAdmin` (role re-read from the DB on
every request) is shared, not duplicated.

### The new SOAP commands (all source-verified `Console::Yes`, offline-capable)

| Command | Verified at | Syntax |
|---|---|---|
| account set password | `cs_account.cpp:870` | `<account> <pw> <pw>` (pw twice, must match) |
| account set gmlevel | v1 | `<account> <0-3> <-1>` |
| account delete | `cs_account.cpp` | `<account>` |
| account set addon | `cs_account.cpp:689` | `<account> <0\|1\|2>` |
| mute / unmute | `cs_misc.cpp:142` / `:2887` | `mute <char> <dur> <reason…>` ; `unmute <char>` |
| character level | `cs_character.cpp:439` | `<name> <level>` |
| character rename/customize/changerace/changefaction | `cs_character.cpp` | `<name>` (at-login flag) |
| character erase | `cs_character.cpp` | `<name>` (permanent) |
| character deleted restore | `cs_character.cpp:634` | `<needle> [newName [account]]` |
| send items | `cs_send.cpp:54` | `<char> "subject" "body" <itemid[:count]> …` |
| send mail | `cs_send.cpp:141` | `<char> "subject" "body"` |
| send money | `cs_send.cpp:192` | `<char> "subject" "body" <amount\|g/s/c>` |
| announce / notify | `cs_message.cpp` | `<message>` (notify = on-screen popup) |
| server set motd | `cs_server.cpp:535` | `[realmId] <locale> <text…>` |
| server set closed | `cs_server.cpp:594` | `on\|off` |
| server restart / server restart cancel | `cs_server.cpp` / `:64` | `restart <time> [exitcode] [reason]` ; `restart cancel` |

`PlayerIdentifier` resolves the target **by name, offline**, for the `send *`,
`mute`, and `character level` commands — confirmed by their signatures taking
`Optional<PlayerIdentifier>` and the handlers tolerating `!GetSession()`. That is
what makes the Mailbox and Characters sections work without the player being
online.

### Why the redesign is cheap to run

The new functionality is thin: each action is a validated form POST → one SOAP
`executeCommand` → one `audit()` line → re-render with the command's own output
as the notice. The bulk of the effort is the redesign (shell, section pages,
status card, confirmation component, poller) — paid once, and shared across all
of it.

## Section designs

### Overview (`/admin`)

- **Status card** parsed from `server info` (uptime, online, peak, world/login
  delay, build) by a defensive regex; a `<details>` "raw output" expander keeps
  anything the card doesn't surface. If the parse doesn't match the running
  build's format, the card falls back to the v1 `<pre>` and nothing is lost.
- **Realm card** (`name`, `address:port`, expansion) from `acore_auth.realmlist`.
- **Backups card** (last write, file count) + the quick-action row.
- **Quick actions:** Restart 30s (→ confirm reveal → live countdown + cancel),
  Lock logins (toggles `server set closed`), Broadcast (opens the same compose
  used on Maintenance).
- **Online now (humans):** reuses v1's bot-filtered `listOnlineCharacters()`.
- **Live poll** (~20 lines vanilla JS): one `GET /admin/status.json` returns
  `{online, backup, restart}`; the page refreshes those panels without a full
  reload.

### Accounts (`/admin/accounts`, `/admin/accounts/:name`)

Directory (MySQL, bot-filtered, the SOAP account row **locked**):

```sql
SELECT a.id, a.username, a.last_login,
       COALESCE(MAX(aa.gmlevel),0) AS gmlevel,
       COUNT(DISTINCT c.guid) AS chars,
       COALESCE(SUM(c.online),0) AS online_chars
  FROM acore_auth.account a
  LEFT JOIN acore_auth.account_access aa
         ON aa.id = a.id AND aa.RealmID IN (-1,1)
  LEFT JOIN acore_characters.characters c ON c.account = a.id
 WHERE a.username NOT LIKE ?
 GROUP BY a.id
 ORDER BY a.username
```

Detail page actions: **Reset password** (`account set password`), **Set GM
level** (keeps v1's three guardrails: not yourself, never zero gm3 accounts,
typed-confirm above 0), **Mute/Unmute**, **Delete account** (danger zone, typed
confirm). The SOAP account is identified from `SOAP_USER` and rendered as a
non-actionable row; the route layer hard-refuses any POST targeting it.

### Characters (`/admin/characters`, `/admin/characters/:name`, `/admin/characters/deleted`)

Directory (bot-filtered, `deleteDate IS NULL`):

```sql
SELECT c.name, c.level, c.class, c.race, c.online, c.logout_time, a.username
  FROM acore_characters.characters c
  JOIN acore_auth.account a ON a.id = c.account
 WHERE c.deleteDate IS NULL AND a.username NOT LIKE ?
 ORDER BY c.online DESC, c.level DESC, c.name
```

Deleted list is the same query with `deleteDate IS NOT NULL` — cleaner than
parsing `character deleted list` console text. Detail page actions: **Rename**,
**Set level**, **Customize / Change race / Change faction** (at-login flags),
**Erase** (danger zone, typed confirm). **Restore deleted** lives on the deleted
list as a per-row Moderate action (`character deleted restore <needle>`).

### Mailbox (`/admin/mailbox`)

Three forms posting to one route each: **send gold** (`send money`), **send
items** (`send items`, raw `itemid[:count]`, comma-separated, no lookup),
**send mail** (`send mail`). All target a character name (offline OK). All land
in the **Moderate** tier (are-you-sure reveal) so a fat-fingered amount gets one
gate. Item-ID lookup/autocomplete is deferred to v3.

### Maintenance (`/admin/maintenance`)

Restart with countdown + cancel (see Confirmation flow), Lock logins
(`server set closed on/off`, shown as a toggle — the app tracks the state it
last set; a state flipped elsewhere won't be reflected, same limitation as the
restart tracker), Broadcast (`announce` / `notify`), Set MOTD (`server set motd`,
locale `esES`). The Overview quick-actions reuse these handlers verbatim.

### Backups (`/admin` Backups card + `/admin/backups`)

Unchanged behaviour. The v1 restore-instructions page stays — restore is still
out of scope (see Out). Only addition is the live-progress poller driving the
existing `/admin/backup/status`.

### Family page (`/`)

Unchanged audience and content. Light touch: a vanilla-JS poller refreshes the
"who's playing" table from a small `GET /online.json` so it stays current
without a full reload. No actions; gmlevel < 3 only.

## Confirmation flow (tiered)

| Tier | Actions | UI |
|---|---|---|
| **Severe** (irreversible) | delete account · erase character · set GM level > 0 | inline form: type the entity name to enable the button |
| **Moderate** (disruptive / costly) | restart 30s · lock logins · restore deleted · **send gold** · **send items** | inline "are you sure?" reveal, then act |
| **Mild** (routine) | reset password · mute/unmute · rename · customize/race/faction · set level · broadcast · set MOTD · back up now | plain submit |

Everything degrades cleanly with JS off. The button-enable is a progressive
enhancement; **server-side validation is the source of truth** (the route
re-checks that the typed field equals the target, as v1 already does for GM
level). `set GM level > 0` stays Severe to honour the kids-stay-at-0 invariant.

### Restart 3-state

idle (button) → click → confirm reveal (inline, no modal) → confirm → running
(countdown polled from `GET /admin/restart/status` + a **Cancel restart** button
that fires `server restart cancel`). The app tracks UI-initiated restarts
in-memory (a `{deadline, startedAt}` singleton in `maintenance.js`).

## Guardrails

- **SOAP service account is untouchable from the UI** — the directory shows it
  locked and the route layer hard-refuses any action targeting `SOAP_USER`.
  Resetting its password or demoting it would brick the console; same spirit as
  v1's "can't change your own GM level" / "never zero gm3 accounts".
- **v1 GM-level guardrails carry over** unchanged.
- **Kids stay at 0** — promoting above 0 keeps its typed-confirm (Severe).
- **Bot accounts filtered** everywhere a human list is shown (`rndbot%`).
- **Password never logged or echoed** — v1 invariant; the new reset-password
  action inherits it.

## Error handling

Reuses v1's SOAP taxonomy (`soapNotice`): Fault → command output rendered as the
user message; 401 → "check SOAP_USER/SOAP_PASS"; 403 → "below GM 3"; timeout →
"worldserver didn't answer"; unreachable → "is ac-worldserver running?". Every
SOAP-backed control is disabled when `server info` fails (realm down), with the
reason stated — exactly as v1.

## Audit

Every new SOAP action flows through the existing `audit()` helper
(`{actor, action, target, result}`). The action vocabulary extends
(`account.password`, `account.delete`, `character.rename`, `mail.send_money`,
`maintenance.restart`, …). No password, no mailed amount need be logged; the
*target* is what matters. This log remains the only record of who asked, since
SOAP attributes everything to `SOAP_USER`.

## Testing

| Area | Test | Needs |
|---|---|---|
| routes (guard) | table-driven over every new admin route; gmlevel-0 session → 403; a new route not listed → fails the test | nothing |
| SOAP client | unchanged v1 tests | nothing |
| confirmation | severe POST without matching typed field → 400; with match → SOAP called | nothing |
| SOAP-account lock | POST targeting `SOAP_USER` → 400 regardless of payload | nothing |
| db | `listAccounts`/`listCharacters`/`listDeletedCharacters` exclude `rndbot%`; `deleteDate` filter correct | throwaway MySQL |
| server-info parse | golden strings → expected fields; unknown format → raw fallback | nothing |
| restart tracker | in-memory singleton reflects pending/cancelled; `server restart cancel` called on cancel | nothing |
| mailbox | `send items`/`money`/`mail` build the exact command string (quoted args, id:count) | nothing |

The route-guard table is the load-bearing one: it is table-driven on purpose so
a future section added without its guard fails closed.

Existing repo gates still apply — no `family-settings.ini` change is required by
this design, so `ini2env.py --selftest` and the drift check are unaffected.

## Risks / unknowns

- **`server info` parse fragility.** The output format is version-dependent. The
  parser is defensive (regex, fall back to raw). Implementation must build the
  regex against the *actual* running output, not assumed text — capture a real
  sample first.
- **Restart countdown only tracks UI-initiated restarts.** A restart triggered
  from the raw console or another client won't show a cancel button in the UI
  (the app has no way to query a pending shutdown over SOAP). Acceptable for v2;
  documented in the Maintenance page copy.
- **`characters.deleteDate` column name** — verify against the schema at
  implementation (AzerothCore convention is `deleteDate`; confirm before relying
  on it for the deleted-list query).
- **Item IDs are opaque** in Mailbox until v3 lookup ships. Mitigated by the
  Moderate are-you-sure gate, not by a search box.
- **Inline `<script>`** keeps the dependency budget at two, but means the poller
  and confirm-enable JS live as a string in `layout.js`. Keep it small and
  framework-free; if it grows, revisit `@fastify/static` rather than letting the
  string balloon.

## Non-goals (restated)

Editing gameplay config · restore-from-backup · installing/building the server ·
retiring `admin.sh` · bot management · shutdown (Dokploy) · 2FA / ban-IP /
arena / LFG · item-ID lookup · self-service password change.
