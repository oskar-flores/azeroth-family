# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Deployment and configuration for a private AzerothCore 3.3.5a (WotLK) realm with
`mod-playerbots`, run as a Dokploy Docker Compose app and reachable only over
Tailscale. Read `README.md` for the reasoning behind most settings — but see the
staleness note under "Invariants" before trusting its build section.

No game code lives here. Thirteen tracked files: three shell scripts, a compose
file, a Dockerfile, a Python generator, and the config they act on. The C++ core
is cloned on demand into `src/`, which is **gitignored and disposable**.

## Architecture

Two stages, deliberately separated:

1. **Build machine** — `build-and-push.sh` clones the core + modules into `src/`
   and produces four Docker images. Three (`worldserver`, `authserver`,
   `db-import`) come from one `docker build --target` each against the core's own
   `apps/docker/Dockerfile` and share a single compile stage, so it is one
   compile, not three. The fourth (`llm-chatter-bridge`) is built from
   `docker/llm-chatter-bridge.Dockerfile` with the *module* directory as context
   — a pip install, seconds not hours.
2. **Dokploy host** — `docker-compose.yml` only *pulls* images. Compose has no
   `build:` stanza anywhere and must never gain one; a redeploy is ~30 seconds,
   not an hour.

There is no maintained prebuilt playerbots image, which is why stage 1 exists at
all. `mod-playerbots` requires the forked core
(`mod-playerbots/azerothcore-wotlk`, branch `Playerbot`) — stock AzerothCore
images will not work, and `build-and-push.sh` hard-fails if `origin` isn't the
fork.

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
python3 scripts/ini2env.py --selftest              # 9/9; run after touching ini2env.py
python3 scripts/ini2env.py --key Rate.XP.Kill      # look up one AC_* name
python3 scripts/ini2env.py family-settings.ini > family.env

# drift check — regenerated output must match the committed file
python3 scripts/ini2env.py family-settings.ini | diff - family.env

# build (build machine; ~40-90 min cold, needs ~8 GB free RAM)
./build-and-push.sh                                # local images: azeroth-family/*
./build-and-push.sh --update                       # pull core + modules first
REGISTRY=ghcr.io/oskarflores ./build-and-push.sh --push

# read what the bots actually said (no content filter exists; this is the
# only visibility). Requires ANTHROPIC_API_KEY set in Dokploy.
docker exec ac-llm-chatter-bridge tail -f /logs/llm_requests.jsonl

# operate (run on the Docker host)
./scripts/admin.sh account <user> <pass>
./scripts/admin.sh gm <user> 0-3                   # keep kids at 0
./scripts/admin.sh list | console | status
./scripts/admin.sh backup [dir]                    # keeps last 14 per database
./scripts/admin.sh restore <file.sql.gz> <db>
```

The test suite is `ini2env.py --selftest` plus the drift check above; run both
after any config change. Shell changes are verified by running the script.

`push-to-github.sh` is a one-shot bootstrap: it `git add -A`s and commits
everything with a fixed message. Don't use it for normal commits.

## Invariants worth knowing before editing

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
- **`src/` is disposable.** `--update` does `git reset --hard`, so edits there are
  destroyed. It has its own `CLAUDE.md`/`AGENTS.md` from upstream — those apply to
  core C++ work, not to this repo.
- **Core and module update together.** Mixing versions gives compile errors or
  runtime crashes.
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
  image are correct as-is. Bot conversation is Spanish separately, via
  `LLMChatter.Language = ES`. That module deliberately keeps WoW proper nouns in
  English — a bot says "Stormwind" while an esES client renders *Ventormenta*.
  That seam is intentional and matches the server data; don't "fix" it by
  localising DBCs.
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
