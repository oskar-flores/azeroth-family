# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Deployment and configuration for a private AzerothCore 3.3.5a (WotLK) realm with
`mod-playerbots`, run as a Dokploy Docker Compose app and reachable only over
Tailscale. Read `README.md` for the reasoning behind most settings — but see the
staleness note under "Invariants" before trusting its build section.

No game code lives here: shell and Python scripts, a compose file, Dockerfiles
for the llm-chatter bridge and admin-ui, the admin-ui app itself, and the config
they all act on. The C++ core is cloned on demand into `src/`, which is
**gitignored and disposable**.

## Architecture

Two stages, deliberately separated:

1. **Build machine** — `build-and-push.sh` clones the core + modules into `src/`
   and produces five Docker images. Three (`worldserver`, `authserver`,
   `db-import`) come from one `docker build --target` each against the core's own
   `apps/docker/Dockerfile` and share a single compile stage, so it is one
   compile, not three.

   Since 2026-08, the core and every module are pinned by commit rather than
   tracked by branch, and `TAG` is derived from the core pin
   (`<date>-<core-short-sha>`). `--update` no longer moves anything: it reports
   what the pins would become. `--fetch-only` resolves and checks out the pins
   without the 40-90 minute compile. `latest` is still published alongside the
   pinned tag, which is what keeps an existing Dokploy deploy working.

   The fourth (`llm-chatter-bridge`) is built from
   `docker/llm-chatter-bridge.Dockerfile` with the *module* directory as context
   — a pip install, seconds not hours. The fifth (`admin-ui`) is built from this
   repo's own `admin-ui/` directory rather than the core sources — a Fastify app
   with no bundler, so it's just as quick.
2. **Dokploy host** — `docker-compose.yml` only *pulls* images. Compose has no
   `build:` stanza anywhere and must never gain one; a redeploy is ~30 seconds,
   not an hour.

There is no maintained prebuilt playerbots image, which is why stage 1 exists at
all. `mod-playerbots` requires the forked core
(`mod-playerbots/azerothcore-wotlk`, branch `Playerbot`) — stock AzerothCore
images will not work, and `build-and-push.sh` hard-fails if `origin` isn't the
fork.

Three more modules compile in alongside `mod-playerbots` but need no service of
their own: `mod-autobalance` scales dungeon mobs and bosses to group size —
config-only, ships no SQL. `mod-transmog` adds cosmetic gear appearances, ships
SQL, and needs a one-time in-game `.npc add 190010` per capital, since its NPC
gossip menu is the only interface. `mod-multibot-bridge` answers structured
`MBOT` addon messages so bots can be driven from a UI rather than by typing chat
commands — no SQL, one config key, and see the two notes below before touching
it.

### Container roles in the stack

`ac-database` (MySQL 8.4, tuned for playerbots) → `ac-db-import` and
`ac-client-data-init` are one-shot (they exit; that is success, not a crash) →
`ac-realm-config` runs on **every** boot to create `acore_playerbots` and rewrite
the `realmlist` row → `ac-authserver` (3724), `ac-worldserver` (8085) and
`ac-llm-chatter-bridge`.

`ac-llm-chatter-bridge` is the Python half of `mod-llm-chatter`. It is
deliberately outside the game process: the worldserver drops event rows into
`acore_characters` and moves on, the bridge polls them, calls the LLM API, and
writes replies back for delivery on the next world tick. No API call ever blocks
the server. It depends on `ac-db-import` because it does **not** create its own
tables.

`ac-realm-config` exists because AzerothCore ships `realmlist.address =
127.0.0.1`. Wrong address there = clients authenticate, then hang at the realm
list forever. If a change touches the realm address, it goes here.

Only `ac-worldserver` gets `env_file: ./family.env`. Gameplay settings applied
anywhere else have no effect.

## The config pipeline

`family-settings.ini` → `scripts/ini2env.py` → `family.env` → compose `env_file`
on `ac-worldserver`.

**Edit `family-settings.ini`, never `family.env`.** Regenerate and commit both:

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
```

`family.env` is committed on purpose — `.gitignore` ignores `*.env` but
re-includes it (`!family.env`). It is what the deployed server actually reads, so
an ini change that isn't regenerated and committed has no effect in production.

**Never hand-write an `AC_*` variable name.** The conversion is not "uppercase
and swap dots": it also splits camelCase and letter↔digit boundaries, so
`Death.CorpseReclaimDelay.PvE` → `AC_DEATH_CORPSE_RECLAIM_DELAY_PV_E`. A wrong
name is silently ignored — no error, the setting just never applies. `ini2env.py`
is a line-by-line port of `IniKeyToEnvVarKey()` from the fork's
`src/common/Configuration/Config.cpp`.

`family-settings.ini` is INI-*style* but **flat** — no `[section]` headers. The
converter passes `#` comments and blank lines through and drops any other line
without `=`, warning on stderr only. A stray section header disappears quietly
from stdout.

Config keys must be spelled exactly as in the fork's `worldserver.conf.dist` /
`playerbots.conf.dist`. Verify against source in `src/`, not against the wiki
(e.g. it's `DurabilityLoss.OnDeath`, not `Rate.Durability.Loss.OnDeath`). Not
every documented key is wired up: `AIPlayerbot.GuildFeedback` appears in
`playerbots.conf.dist` but nothing in the module source reads it.

Deployment values (`DB_ROOT_PASSWORD`, `DB_BUFFER_POOL`, `REALM_ADDRESS`,
`BIND_ADDR`, `IMAGE_PREFIX`, `IMAGE_TAG`, ports, `REALM_NAME`,
`ANTHROPIC_API_KEY`) are *not* in `family.env` — they go in Dokploy's Environment
tab, templated by `.env.example`.

### The second config pipeline: `llm-chatter-settings.conf`

`mod-llm-chatter` does **not** go through `ini2env.py`. It reads a WoW-style
`.conf` file, and the same file is mounted into two containers:

- `ac-llm-chatter-bridge` at `/config/`, layered onto the upstream defaults
- `ac-worldserver` at `etc/modules/mod_llm_chatter.conf`, where the core picks it
  up (`GetConfigPath() + "modules/"`, `Config.cpp:766`)

The file holds **deltas only**. The module's complete `conf.dist` is baked into
the bridge image and this file is concatenated after it, so anything unmentioned
keeps the upstream default and new upstream keys arrive on the next build with no
merge. The C++ half reads ~100 `LLMChatter.*` keys via `sConfigMgr`, which is why
they are not in `family.env` — that many `AC_*` lines would be unreadable.

**Never put a secret in it — it is committed to a public repo.** The bridge's
`parse_config()` reads a plain file and has *no* env-var support, so the API key
cannot simply be an env var. The image assembles the final config at container
start:

```
upstream conf.dist  →  llm-chatter-settings.conf  →  secrets from env
```

`parse_config` is last-wins, which is what makes the layering correct. Keys
marked `[BRIDGE]` upstream only take effect after restarting
`ac-llm-chatter-bridge`, not the worldserver.

## Commands

```bash
# config
python3 scripts/ini2env.py --selftest              # 13/13; run after touching ini2env.py
python3 scripts/ini2env.py --key Rate.XP.Kill      # look up one AC_* name
python3 scripts/ini2env.py family-settings.ini > family.env

# drift check — regenerated output must match the committed file
python3 scripts/ini2env.py family-settings.ini | diff - family.env

# build (build machine; ~40-90 min cold, needs ~8 GB free RAM)
./build-and-push.sh                                # local images: azeroth-family/*
./build-and-push.sh --fetch-only                   # resolve + check out the pins, no compile
./build-and-push.sh --update                       # report what the pins would become; nothing moves
REGISTRY=ghcr.io/oskar-flores ./build-and-push.sh --push

# read what the bots actually said (no content filter exists; this is the
# only visibility). Requires ANTHROPIC_API_KEY set in Dokploy.
docker exec ac-llm-chatter-bridge tail -f /logs/llm_requests.jsonl

# operate (run on the Docker host)
./scripts/admin.sh account <user> <pass>
./scripts/admin.sh gm <user> 0-3                   # keep kids at 0
./scripts/admin.sh list | console | status
./scripts/admin.sh backup [dir]                    # keeps last 14 per database
./scripts/admin.sh restore <file.sql.gz> <db>

# web console (tailnet only, http://<tailscale-ip>:${UI_PORT:-8080})
cd admin-ui && npm test                            # unit tests; db.test.js needs a throwaway MySQL
docker logs ac-admin-ui 2>&1 | grep audit          # who did what through the console
```

The test suite is `ini2env.py --selftest` plus the drift check above; run both
after any config change. Shell changes are verified by running the script.

## Invariants worth knowing before editing

- **The root files are at the root on purpose — don't "tidy" them into a
  `config/` subdir.** `docker-compose.yml` resolves its `./family.env` env_file
  and its `./llm-chatter-settings.conf` mounts relative to its own location, so
  those three — plus `.env.example` and `family-settings.ini` — must sit next to
  it; Dokploy also points a "compose path" at the root `docker-compose.yml`, and
  `scripts/make-template-compose.py` reads all of them from the repo root. And
  `build-and-push.sh` derives `src/` and `docker/` from its own `SCRIPT_DIR`, so
  those three are a rigid triple — moving the script silently re-clones the
  whole core. A `config/` directory looks cleaner and breaks all three
  consumers.
- **Do not stage module SQL into `data/sql/custom/`.** This is the one thing the
  README still describes the old way — it was removed in `2dc2bb6` because it
  breaks the import. `dbimport` already applies module SQL from
  `modules/<mod>/data/sql/` (`Updates.AllowedModules=all` resolves against the
  compiled-in `AC_MODULES_LIST`), and `data/sql/custom/db_*` is itself a seeded
  include dir. A copy in both places is the same filename twice, and
  `UpdateFetcher` dedupes on filename alone — it logs `Duplicate filename` and
  **fatally aborts the whole import**. `build-and-push.sh` now only *verifies*
  the SQL is present and hard-fails if
  `modules/mod-playerbots/data/sql/playerbots/base` is missing (that directory is
  the real cause of `Unknown database 'acore_playerbots'`); `ac-realm-config`
  creates the database as a backstop.
- **`src/` is disposable.** Any build or `--fetch-only` run calls `fetch_pinned`,
  which does `git checkout -q --detach FETCH_HEAD` then `git clean -qfd` whenever
  the checked-out HEAD doesn't already match the pin — so edits there are
  destroyed, just not by `--update` (which now only reports, see above). It has
  its own `CLAUDE.md`/`AGENTS.md` from upstream — those apply to core C++ work,
  not to this repo.
- **Core and module update together.** Mixing versions gives compile errors or
  runtime crashes. `mod-multibot-bridge` is the sharpest edge of this: it
  `#include`s playerbots internals directly (`PlayerbotAI.h`,
  `AiObjectContext.h`, `BudgetValues.h`, `ChatHelper.h`), so it is the first
  thing to break when the playerbots pin moves. If a build fails inside
  `MultiBotBridge.cpp`, the module has not caught up to the core — don't patch
  the module or drag the playerbots pin backwards to suit it.
- **`MultiBotBridge.EnableConsoleLogs = 0` in `family-settings.ini` is load-
  bearing, not a restatement of the default.** The module's *code* default is
  `1` (`MultiBotBridge.cpp:53`); its `conf.dist` says `0` and is never read.
  CMake installs `MultiBotBridge.conf.dist` but registers the name with the
  suffix stripped (`modules/CMakeLists.txt:361`), so the core looks for
  `MultiBotBridge.conf`, which nothing creates, and `Config.cpp` has no `.dist`
  fallback. Delete the line as redundant and every addon UI refresh starts
  writing RX/TX lines to the worldserver console. No mount is needed to fix
  this — `GetValueDefault` (`Config.cpp:601-620`) checks the environment before
  the not-found branch, so the `AC_*` var wins with no config file present at
  all. That is why this module, unlike `mod-llm-chatter`, has no mounted
  `.conf`: there is no second process that needs to read the same file.
- **A silent `mod-multibot-bridge` is not a broken build.** It does nothing
  until the MultiBot client addon is installed on a PC, and shipping or
  documenting that addon is deliberately out of scope for this repo.
- **`BIND_ADDR` is the security boundary.** Pinning the published ports to the
  Tailscale IP means the socket only exists on the tailnet — that plus the
  absence of any self-registration is the entire closed-realm guarantee. Don't
  widen it to `0.0.0.0` outside host-local testing.
- **The bot-chat keys are pinned deliberately, not inherited.** The
  `BroadcastChanceSuggestSomethingToxic` / `SuggestToxicLinks` /
  `SuggestThunderfury` and `ToxicLinksRepliesChance` / `ThunderfuryRepliesChance`
  block in `family-settings.ini` is the only kid-safety control that config can
  actually provide — the crude text rows are installed in the database
  regardless, these settings just decide whether a bot can pick one. Two of them
  are ON upstream. Don't drop them as redundant on an update. In particular they
  are **not** made redundant by `RandomBotTalk = 0`: that stops the crude corpus
  being reached via random chatter, but the reply paths in `PlayerbotAI.cpp`
  (`:1242-1251`) are a separate mechanism it does not cover.
- **With the LLM there is no auditable corpus, so the request log is the
  control.** Playerbots' own chat is now off and `mod-llm-chatter` generates
  dialogue instead. Neither that module nor `mod-ollama-chat` has a content
  filter, so `LLMChatter.RequestLog.Enable = 1` and the lowered
  `Temperature = 0.4` are doing the work that grepping a text table used to do.
  Don't turn the log off to save disk.
- **Server data files must stay enUS.** Playerbots' spell logic matches English
  spell names. Spanish comes from the client's own files plus the world DB's
  `*_locale` tables; `DBC.Locale = 255` and the stock `acore/ac-wotlk-client-data`
  image are correct as-is. Don't "fix" anything by localising DBCs.
- **Bot chat, unlike server data, does use Spanish proper nouns — and that is a
  patch, not a setting.** `mod-llm-chatter` hard-codes "keep WoW proper nouns in
  English" into `get_language_rule()` (`tools/chatter_shared.py:1288-1312`) and
  exposes no config key, data file, plugin hook or endpoint to change it. The
  clause is rewritten in `docker/llm-chatter-bridge.Dockerfile`, immediately
  after `COPY tools/ /app/`, guarded by a `sys.exit` that fails the build if
  upstream moves the string. The two halves are not in tension: the kids' clients
  are esES, so Spanish names in chat *match* what is on screen, and nothing about
  server data moves. If a rebuild ever prints "the proper-noun clause was not
  found", re-read `get_language_rule()` and update the block — do not delete it.
  Verify with:
  `docker run --rm --entrypoint python <bridge-image> -c "import chatter_shared as c; c.set_language('ES'); print(c.get_language_rule())"`
- **Switching the LLM provider is not a rebuild.** `LLMChatter.Provider` /
  `Model` / `Ollama.BaseUrl` are runtime settings handled by the Python bridge;
  Anthropic → local Ollama is those lines plus a bridge restart. The local target
  is a 4B model (`qwen3:4b`), not a 1B one — upstream warns smaller models
  produce malformed JSON, and the bridge needs structured output, so a weak model
  fails outright rather than merely sounding worse.
- **`Ctrl-C` on the worldserver console stops the realm.** Detach with `Ctrl-P`
  `Ctrl-Q`; `admin.sh` sets `--detach-keys` for this reason.
- Bot load is tuned by `AiPlayerbot.MinRandomBots` / `MaxRandomBots` (currently
  150/150) — that's the first dial for a struggling host, before anything else.
  It's runtime-only: regenerate `family.env` and redeploy, no rebuild.
- **`ac-admin-ui` has no Docker socket, and that is a design decision, not an
  oversight.** Every capability it has runs over MySQL or SOAP. `docker.sock` in
  a web-facing container is host root, and socket proxies only help while access
  stays read-only. The two things it therefore cannot do — start a fully dead
  container, and restore a database — stay in `scripts/admin.sh`. Restore in
  particular cannot be made safe here: the worldserver flushes in-memory
  character state over a fresh import, and `restart: unless-stopped`
  (`docker-compose.yml:163`) means this app cannot hold the world down.
- **`SOAP.IP = 0.0.0.0` in `family-settings.ini` is required, not a mistake.**
  `127.0.0.1` is per-container loopback, which makes SOAP unreachable from
  `ac-admin-ui`. Port 7878 has no `ports:` entry, so `ac-network` is the whole
  containment. Changing it back to `127.0.0.1` silently breaks account creation.
- **`SOAP_USER` is a standing gmlevel-3 credential.** It is the largest piece of
  authority the console introduces and it exists whether or not anyone is logged
  in. Because SOAP attributes every command to it, the app's own log is the only
  record of who actually asked — same reasoning as `LLMChatter.RequestLog`.
