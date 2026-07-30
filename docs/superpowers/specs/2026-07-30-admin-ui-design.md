# Design: `ac-admin-ui` — a web console for the family realm

Date: 2026-07-30
Status: approved, ready for implementation planning

## Problem

Managing the realm today means SSH plus `scripts/admin.sh`. That is fine for the
person who wrote it and unusable for everyone else in the house. Two reference
points exist:

- `DadsMmoLab/dads-mmo-lab`'s `wow-manage.sh` — a 336 KB interactive bash menu.
  Still a terminal.
- `0xVe1L/the-lab` — a graphical desktop app for the same job.

**`the-lab` cannot be reused.** Its repository contains only a README and 15
screenshots; the app ships as a single 140 MB `TheLab.AppImage` (v0.0.7, June
2026) with **no license file of any kind**. There is no source to fork and no
legal basis to reuse a decompiled build. The README now opens with "support …
halted indefinitely."

It is also solving a different problem: Steam Deck Gaming Mode, one-click
*install*, point-at-your-client-folder, auto-shutdown when WoW exits. This realm
is already deployed — Dokploy, remote host, Tailscale-only. Its screenshots
remain a useful UX reference and nothing more.

So: build our own, scoped to this deployment.

## Decisions

| Question | Decision |
|---|---|
| Audience | Admin console (you) + read-only family view |
| v1 capabilities | Accounts & GM levels, lifecycle, backups |
| Family page content | Realm up/down, who's online, own character list |
| Login | Reuse WoW accounts via SRP6 against `acore_auth` |
| Docker access | **None in v1.** SOAP + MySQL only |
| Restore | Stays in `admin.sh` (see "Restore is out of scope") |
| Stack | Fastify + server-rendered HTML, no bundler |

### The key finding: Docker access is almost entirely avoidable

The initial framing was "wrap `admin.sh` in Node," which implies driving Docker
from the app. Mapping each capability to what it actually requires:

| Capability | Needs Docker? | Real mechanism |
|---|---|---|
| Create account, set GM level | no | SOAP `account create` / `account set gmlevel` |
| Family page: online + characters | no | MySQL reads on `acore_auth` / `acore_characters` |
| Login (SRP6 verify) | no | MySQL read of `salt` / `verifier` |
| Backups | no | `mysqldump -h ac-database` over `ac-network` |
| Graceful restart | no | SOAP `server restart 30` — warns players first |
| Container health grid | read-only | Docker `GET /containers/json` — **not in v1** |
| Start a *dead* container | **yes** | not supported; use `admin.sh` |

v1 ships with no Docker access at all. The container health grid is the only
feature that would justify adding any, and it only needs read-only access
(`GET`, no `POST`, no `EXEC`) — the one shape a socket proxy actually contains
well. It is deferred, not designed in: SOAP `server info` already answers "is the
realm up?", which is the question that matters day to day.

This matters because `docker.sock` in a web-facing container is host root.
Socket proxies only help while access is read-only — enabling `POST=1` or
`EXEC=1` hands back the keys. Designing the socket out is cheaper than securing
it.

It is also a functional improvement, not just a security one. `admin.sh:30-35`
pipes a here-string into `docker attach` with `|| true` and a blind `sleep 1`; it
never reads the console's output, so `account create` cannot report "already
exists". SOAP returns command output as data. And `docker restart
ac-worldserver` hard-kills logged-in players, whereas `server restart 30` gives
them a countdown.

### Verified against source, not assumed

- SRP6: `src/common/Cryptography/Authentication/SRP6.cpp:38-47` —
  `v = g^H(salt ‖ H(USER:PASS)) mod N`, `g = 7`, SHA-1, `N` a 32-byte prime.
  Callers uppercase both username and password (`Utf8ToUpperOnlyLatin`).
- `account(id, username, salt BINARY(32), verifier BINARY(32), last_login, …)`
- `account_access(id, gmlevel, RealmID, comment)` — **no row means level 0**, and
  `admin.sh gm` writes `RealmID = -1`.
- `characters(guid, account, name, race, class, gender, level, …)`
- `AiPlayerbot.RandomBotAccountPrefix = "rndbot"` (upstream default, not
  overridden in `family-settings.ini`); upstream comments it as applying to bot
  accounts "of any type", so it covers the addclass pool too.
- SOAP exists but is off: `worldserver.conf.dist:451` — `SOAP.Enabled = 0`,
  `SOAP.IP = "127.0.0.1"`, `SOAP.Port = 7878`.
- `restart: unless-stopped` on `ac-worldserver` (`docker-compose.yml:133`).

## Non-goals

- **Editing gameplay config.** `family-settings.ini` → `ini2env.py` →
  `family.env` → commit → redeploy is a git-and-deploy pipeline, not a form.
- **Restore.** See below.
- **Installing or building the server.** That is `build-and-push.sh`, 40-90 min.
- **Retiring `admin.sh`.** It stays as break-glass and as the only way to start a
  dead stack.
- **`the-lab`'s player-facing features** — item mailing, teleport, bot party
  building. Possible later; not v1.
- **Zone names** on the character list. `characters.zone` is an `AreaTable.dbc`
  ID; those names live in client DBC files, not in any reachable database.
  Showing them requires a hand-built ID→name map.

## Architecture

One new service in `docker-compose.yml`:

```yaml
ac-admin-ui:
  image: ${IMAGE_PREFIX:-azeroth-family}/admin-ui:${IMAGE_TAG:-latest}
  container_name: ac-admin-ui
  restart: unless-stopped
  ports:
    - "${BIND_ADDR:-0.0.0.0}:${UI_PORT:-8080}:8080"
  volumes:
    - ac-backups:/backups
  networks: [ac-network]
  depends_on:
    ac-database: { condition: service_healthy }
```

No `build:` stanza — that invariant holds. The image is built by
`build-and-push.sh` from a new `docker/admin-ui.Dockerfile` with `admin-ui/` as
context: an `npm ci`, seconds rather than the core's compile. A new
`ac-backups` named volume is added.

Published on `BIND_ADDR`, so the UI is tailnet-only by exactly the same
mechanism that already contains ports 3724 and 8085.

Three outbound integrations; nothing inbound but the browser:

1. **MySQL** → `ac-database:3306` via `mysql2` — login, accounts, characters
2. **SOAP** → `ac-worldserver:7878` — `account create`, `account set gmlevel`,
   `server info`, `server restart`
3. **`mysqldump`** → subprocess inside this container, `-h ac-database`, to
   `/backups`

### Required config change

In `family-settings.ini`, regenerated into `family.env`:

```ini
SOAP.Enabled = 1
SOAP.IP = 0.0.0.0
SOAP.Port = 7878
```

→ `AC_SOAP_ENABLED`, `AC_SOAP_IP`, `AC_SOAP_PORT` (confirmed via
`ini2env.py --key`; never hand-write these).

Port 7878 gets **no `ports:` entry**. It is reachable on `ac-network` and
nowhere else — not from the tailnet, not from the host.

`SOAP.IP = 0.0.0.0` looks alarming and is required: `127.0.0.1` is per-container
loopback, which makes SOAP unreachable from a sibling container. Network
isolation, not the bind address, provides containment. **This line needs a
comment in the ini explaining why**, because a future reader will otherwise
"fix" it back to `127.0.0.1` and silently break account creation.

### SOAP identity

The app authenticates to SOAP with a dedicated service account (gmlevel 3,
credentials in Dokploy env as `SOAP_USER` / `SOAP_PASS`), not the logged-in
user's — passing a user's password through would mean holding it in the session.

Two consequences:

- The service account is a **new gmlevel-3 credential**, created once via
  `admin.sh`, as powerful as your own. Dokploy env only; never committed.
- SOAP-side attribution is uniform, so **the app must log who requested what**.
  That application log is the audit trail — same reasoning as the
  `LLMChatter.RequestLog` invariant in `CLAUDE.md`.

## Module boundaries

```
admin-ui/
  package.json
  src/
    srp6.js          verifier math — pure, zero I/O
    db.js            MySQL pool + named queries; no HTTP knowledge
    soap.js          executeCommand(cmd) → {ok, output}; no route knowledge
    backup.js        run / list / prune; sole owner of /backups
    auth.js          login, session cookie, role from gmlevel
    routes/admin.js  gmlevel-3 console
    routes/family.js read-only page
    server.js        wiring only
  test/
```

`srp6.js` and `db.js` carry the risk and both are testable without Docker.

**Stack rationale:** Fastify plus server-rendered HTML, no bundler, no React, no
build step. This repo has 18 tracked files and no Node anywhere; a Vite/React
toolchain would become the largest thing in it, to render two pages that are a
table and six buttons.

## Data flow

### Login

Uppercase both fields, then:

```sql
SELECT a.id, a.salt, a.verifier, COALESCE(MAX(aa.gmlevel), 0) AS role
FROM account a
LEFT JOIN account_access aa ON aa.id = a.id AND aa.RealmID IN (-1, 1)
WHERE a.username = ? GROUP BY a.id
```

Compute the verifier, compare with `crypto.timingSafeEqual`. `role >= 3` → admin
console; otherwise family page.

`RealmID IN (-1, 1)` is load-bearing: `admin.sh gm` passes `-1`, so a naive
`RealmID = 1` would miss every row your existing script created.

Rate limiting is per username+IP, in memory, deliberately gentle — 10 attempts
then a 60s cooldown. A 7-year-old will fumble a password repeatedly and must not
be locked out of seeing their own characters. The app never writes
`failed_logins` or `locked`; those belong to the authserver.

### Create account

Validate `[A-Za-z0-9]{3,16}` and password 4-16 ASCII — 3.3.5a truncates past 16,
which would otherwise create an account whose password is not what was typed.
Then SOAP `account create <u> <p>`, and **show the returned text**. Password is
never logged and never echoed back.

### Set GM level

SOAP `account set gmlevel <u> <n> -1`. Three guardrails:

- **Refuse to change your own level** — setting yourself to 0 locks you out of
  the UI you would use to undo it.
- **Refuse any change leaving zero gmlevel-3 accounts** — same lockout, one step
  removed.
- Promoting above 0 requires typed confirmation. `CLAUDE.md` is explicit that
  kids stay at 0 and that GM commands can delete characters.

### Family page

```sql
SELECT c.name, c.level, c.class, c.race FROM acore_characters.characters c
JOIN acore_auth.account a ON a.id = c.account
WHERE c.online = 1 AND a.username NOT LIKE 'rndbot%'
```

The filter is load-bearing: with `MaxRandomBots = 150` plus
`AddClassAccountPoolSize = 50` (×10 characters each), an unfiltered list shows
~150 bots and buries the humans.

"My characters" is the same query keyed on `c.account` from the session, showing
name, level, class, race, last-played. Class and race IDs map through static
11- and 10-entry JS lookups.

Liveness comes from SOAP `server info` (uptime plus player count in one call):
answers → up, times out → down. Realm address comes from `acore_auth.realmlist`,
the row `admin.sh status` already reads.

### Lifecycle

Graceful restart via SOAP `server restart 30`, giving players a countdown. The
process exits and `restart: unless-stopped` brings the container back.

Starting a container that is fully dead is **not supported** — it is the one
operation that genuinely requires the Docker API. Use `admin.sh` / `docker
compose up`.

### Backups

`mysqldump` per database into `/backups`, reusing `admin.sh`'s exact
`${db}_${stamp}.sql.gz` naming and keep-last-14 pruning, so the two tools read
each other's output. Databases: `acore_characters`, `acore_auth`,
`acore_playerbots`.

A multi-GB dump cannot be a synchronous request: it runs as a background job and
the UI polls a status endpoint. List reads the directory; download streams the
file.

## Restore is out of scope

Restore was requested as a must-have. It cannot be made safe under this
architecture, and the reason is worth recording.

Restoring `acore_characters` while the worldserver runs corrupts it — the live
server holds character state in memory and flushes it over the freshly imported
rows. A correct restore must hold the world down for the whole import.

The app can shut the world down (SOAP `server exit`). It cannot keep it down:
`restart: unless-stopped` (`docker-compose.yml:133`) brings it back on its own
schedule, racing the import. Changing a container's restart policy requires the
Docker API — precisely what this design excludes.

**Resolution:** the UI does backup, list, and download. Restore gets a page that
names the chosen file and shows the exact `admin.sh restore` command to paste.
Restore is a once-a-year emergency; backups are routine. Shipping a button that
silently corrupts character data would be worse than shipping no button.

If restore-from-browser later becomes important, the smallest viable change is a
socket proxy allowing exactly `POST /containers/ac-worldserver/{stop,start}` and
nothing else — a real hole, but a far smaller one than full socket access.

## Error handling

| Failure | Behaviour |
|---|---|
| MySQL unreachable | "Can't reach the realm database" — **never** "wrong password". 2s connect timeout, fail fast |
| Worldserver down | Family page still works (characters come from MySQL). Account/gmlevel buttons disable with a stated reason |
| SOAP Fault (HTTP 500) | Not "app broken" — parse `faultstring`, render as a user-level message |
| SOAP 401 | Operator error: service account wrong, missing, or demoted. Loud message naming the env var |
| Partial dump | Write `${name}.partial`, rename only on success. Pruner and list ignore `.partial` |
| Disk full | Check free space before dumping; refuse with a clear message |
| Stale role | Re-read `gmlevel` from DB on every admin request; don't trust the cookie |

Two specifics worth stating:

**Never report infrastructure failure as authentication failure.** That is how a
child ends up certain they forgot a password they typed correctly.

**In a `mysqldump | gzip` pipe, gzip exits 0 even when mysqldump dies.**
`admin.sh` is covered by `set -euo pipefail` (line 16); in Node, check
mysqldump's own exit code, not the pipeline's tail. A truncated `.sql.gz` is
worse than no backup because it survives pruning and looks legitimate.

**Password leakage** has two channels: scrub the DB root password from anything
logged or rendered, and pass it via `MYSQL_PWD` or a defaults-file rather than
`-p` on the argv — otherwise `docker exec ac-admin-ui ps aux` prints it.

## Testing

| Unit | Test | Needs |
|---|---|---|
| `srp6.js` | golden fixture: a known account's stored `salt`+`verifier` reproduced; wrong password rejected; lowercase input still verifies | nothing |
| `db.js` | query functions against throwaway MySQL. **The bot filter is the one that matters**: assert `rndbot*` characters are excluded | a MySQL |
| `soap.js` | mocked HTTP: success parsed, Fault → message, 401 → distinct type, timeout → distinct type | nothing |
| `backup.js` | `.partial` never listed and never pruned; prune keeps exactly 14 | temp dir |
| routes | table-driven over every admin route: gmlevel-0 session gets 403 | nothing |

The route test is table-driven on purpose: an admin route added later that
forgets its guard then fails by default rather than shipping open.

Existing repo gates still apply, since `family-settings.ini` changes:

```bash
python3 scripts/ini2env.py --selftest              # expect 9/9
python3 scripts/ini2env.py family-settings.ini | diff - family.env
```

## Risks

**SRP6 byte order is the one real unknown.** `BigNumber::ToByteArray<32>`'s
endianness is not obvious from the source. The fix is empirical: create a known
account, read its `salt`/`verifier` hex, confirm the Node implementation
reproduces the verifier; reverse the buffer if not.

**Build this fixture first, before any other code.** If the byte order is
reversed from what is assumed, that must surface in step one — not after the
auth layer, session handling, and two templates are stacked on top of it.
Everything else in this design is ordinary.

**Session cookie over plain HTTP.** Tailscale encrypts the transport, so
`secure: false` is defensible on the tailnet. `httpOnly` and `sameSite=lax`
still apply. If HTTPS is wanted later, `tailscale serve` terminates TLS without
touching this app.

**The service account is a standing gmlevel-3 credential** that exists whether
or not anyone is logged in. It is the largest new piece of authority this feature
introduces, and it lives in Dokploy env.
