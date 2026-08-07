# Azeroth Family,  a private WotLK realm for the family

## What this is

A closed AzerothCore 3.3.5a (WotLK) realm with `mod-playerbots`, just for the
family. It runs as a Dokploy Docker Compose app on a home machine and is reachable
only over Tailscale.


### What "kid friendly" means

- **No death penalty**: no resurrection sickness, instant corpse reclaim, no
  durability loss, no fall damage.
- **x3 XP, x2 loot** on the good tiers: real progress in a short session, without
  outlevelling the story.
- **PvE only**: no open-world PvP, no bot battlegrounds.
- **Instant flight paths**, all routes known from the start.
- **Max 4 bots per player** (not the module's default of 40).

### Hardware

Every bot is a full player simulation, so playerbots is heavy. AzerothCore cares
about **single-core** speed far more than core count — a fast 4-core box beats a
slow 16-core one.

| | comfortable | tight |
|---|---|---|
| CPU | 6+ fast modern cores | 4 cores |
| RAM | 16 GB | 8 GB |
| Disk | 60 GB SSD | 40 GB (~16 GB is map data, fetched once) |

If the host struggles, the first dial is bot count
(`AiPlayerbot.Min/MaxRandomBots`), before anything else.

---

## Build & deploy

### Build

```bash
git clone <this repo> azeroth-family && cd azeroth-family
./build-and-push.sh
```

This fetches the fork (and refuses if the remote isn't it), fetches every module,
checks the module SQL is there, and builds five images: `worldserver`,
`authserver`, `db-import`, `llm-chatter-bridge`, and `admin-ui` (the first three
share one compile).

If Dokploy is on the same machine, you're done. If you built elsewhere, push to a
registry and point Dokploy at it:

```bash
REGISTRY=ghcr.io/oskar-flores ./build-and-push.sh --push
# then set IMAGE_PREFIX=ghcr.io/oskar-flores in Dokploy
```

### Versions

Core and every module are pinned by commit at the top of `build-and-push.sh`. The
image tag comes from the core pin (`<date>-<short-sha>`), so nothing moves unless
you commit a new ref — "what is deployed" is always answerable from git.

```bash
./build-and-push.sh --update      # show what the pins would become; moves nothing
./build-and-push.sh --fetch-only  # check out the pins, build nothing
```

To update: run `--update`, edit the `*_REF` values at the top of the script,
commit, then build. Always move the core and `mod-playerbots` **together** —
mixing versions breaks the compile or crashes at runtime. Every build also tags
`latest`, so a stack with no `IMAGE_TAG` keeps working; set `IMAGE_TAG` in Dokploy
to pin or roll back.

### Deploy on Dokploy

Set these in the application's Environment tab (full list in `.env.example`):

- **`REALM_ADDRESS`** and **`BIND_ADDR`**: your Tailscale IP.
- **`OPENROUTER_API_KEY`**: your key. The bridge won't start without it.
- **`SOAP_USER` / `SOAP_PASS`**: a gmlevel-3 service account. Create it on the
  host first (see *Web console*).
- **`DB_ROOT_PASSWORD`**, and **`IMAGE_PREFIX`** if you pushed to a registry.

Then pick one of two ways in:

**A. Compose from a Git repo.** Push this folder somewhere Dokploy can read → new
application → **Docker Compose** → compose path `docker-compose.yml` → Deploy.

**B. One-click template** (`dokploy-template/`). In Dokploy → **Settings →
Templates**, add a custom template source (the repo must be public, since the
fetch is plain HTTP):

```
https://raw.githubusercontent.com/oskar-flores/azeroth-family/main/dokploy-template
```

Install "Azeroth Family Server", set `realm_address` to your Tailscale IP and
`openrouter_api_key` to your key, deploy. The images must already exist on the
host — build first, or set `image_prefix` to a registry.

The template bakes the kid settings in, so when you change `family-settings.ini`
or `llm-chatter-settings.conf`, regenerate it too (see *What to change*):

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
python3 scripts/make-template-compose.py
```

The first deploy takes ~20 min: one-shot containers fetch ~16 GB of map data and
build the databases, then exit (that's success, not a crash). After that,
`ac-realm-config` rewrites the realm address on every boot.

### The clientby default is in Spanish

You need a **3.3.5a (build 12340)** client, esES locale. Edit
`Data/esES/realmlist.wtf` to `set realmlist 100.101.102.103`, then delete the
`Cache` folder or the client may keep the old address. (esMX is the same, just a
different folder.)

---

## What to change, and how

### Gameplay and bot config

Edit `family-settings.ini` — never `family.env`. Then regenerate and redeploy, no
rebuild:

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
```

The env-var name conversion isn't "uppercase and swap dots." It also splits
camelCase and digit boundaries, so `Death.CorpseReclaimDelay.PvE` becomes
`AC_DEATH_CORPSE_RECLAIM_DELAY_PV_E`. Get a name wrong and it's silently ignored.
`ini2env.py` can look up any key for you:

```bash
python3 scripts/ini2env.py --key Rate.XP.Kill
```

`family.env` is committed on purpose — it's what the server actually reads, so an
ini edit that isn't regenerated and committed has no effect.

### Bot dialogue

`llm-chatter-settings.conf` holds only the deltas over the module's upstream
defaults, so new keys arrive on the next build with no merge. It's mounted into
both the worldserver and the bridge.

Never put a secret in it — it's in a public repo, and the bridge reads a plain
file with no env-var support (the API key comes from `OPENROUTER_API_KEY`).
Changing the model or provider is a bridge restart, not a rebuild:

```bash
docker compose restart ac-llm-chatter-bridge
```

### Accounts

```bash
./scripts/admin.sh account papa   micontraseña
./scripts/admin.sh gm papa 3          # GM powers for an adult
./scripts/admin.sh list | status
```

Leave the kids at level 0 — GM commands can delete characters. Passwords are
case-insensitive ASCII in 3.3.5a, so keep them short and typeable.

### Web console

`ac-admin-ui` is a small web page the family can use instead of SSH — tailnet
only, at `http://<tailscale ip>:8080`.

You log in with **your WoW account** — the console checks `acore_auth` with the
same SRP6 the game client uses, not a separate password. GM level 3 gets the admin
page (create accounts, set GM levels, restart the worldserver, run a backup);
everyone else sees a read-only family page with who's online.

The console needs a gmlevel-3 service account for its SOAP actions
(`SOAP_USER` / `SOAP_PASS`). Create it once before the first deploy:

```bash
./scripts/admin.sh account acconsole <a long random password>
./scripts/admin.sh gm acconsole 3
```

Restore isn't in the console on purpose: it has to run while the worldserver is
down, and `restart: unless-stopped` would bring it straight back up. So restores
stay in `admin.sh`:

```bash
./scripts/admin.sh restore <file.sql.gz> <db>
```

### Backups

```bash
./scripts/admin.sh backup      # keeps the last 14 of each database
```

`acore_characters` is the one that matters — every character, bag, bank, and
achievement. `world` and `auth` can be rebuilt from scratch; a lost character
can't. Put backups on a schedule, and test a restore once while nothing's at stake.

---

## Modules enabled

Five modules compile in alongside the playerbots fork. All are pinned by commit in
`build-and-push.sh`.

| module | what it is |
|---|---|
| `mod-playerbots` | The bots: full player simulations that group with you and fill the world. |
| `mod-llm-chatter` | LLM-driven bot chat in Spanish, replacing the fixed phrase table. The C++ half compiles in; the Python half runs as the separate `ac-llm-chatter-bridge` container. |
| `mod-autobalance` | Scales dungeon mobs and bosses to group size (bots count as players). No SQL. |
| `mod-transmog` | Cosmetic gear appearances. Ships SQL; its NPC gossip menu is the only interface — spawn it once per capital (`.npc add 190010`). |
| `mod-multibot-bridge` | Server half of the MultiBot addon: lets a UI drive bots instead of chat. Does nothing until the client addon is installed, which this repo doesn't ship. |

---

## Adding a module

Modules live in the `EXTRA_MODULES` array at the top of `build-and-push.sh` — one
`"name|url|branch|ref"` line each, pinned by commit.

1. **Add a line, then rebuild.** Add modules one at a time — each one is another
   thing that can break the compile.
2. **SQL imports itself.** If the module has SQL under `data/sql/`, the importer
   picks it up from `modules/<mod>/data/sql/`. Don't also copy it into
   `data/sql/custom/` — the same filename twice makes the importer abort.
3. **Watch the playerbots internals.** A module that `#include`s playerbots
   headers (like `mod-multibot-bridge`) is the first to break when the playerbots
   pin moves. Move them together; don't patch the module or drag the pin back.
4. **Add a container only if it has its own process.** Most modules just compile
   in. `mod-llm-chatter` is the exception — its bridge is a separate image.
5. **Do any in-game setup the build can't.** Transmog's NPC has to be spawned by a
   GM (`.npc add 190010`), because the command needs a player position.

---

## Common gotchas

- **Connects, then hangs at the realm list.** The realm address in the database
  isn't reachable. Run `./scripts/admin.sh status` and check it matches your
  Tailscale IP — `ac-realm-config` rewrites that row on every boot.
- **`Unknown database 'acore_playerbots'`.** The playerbots base SQL dir was
  missing at build. Re-run `./build-and-push.sh --fetch-only` and rebuild;
  `ac-realm-config` creates the database as a backstop.
- **First boot sits at "Loading…" for minutes.** Normal — the bots are being
  created and logged in for the first time.
- **Build dies partway through.** Almost always RAM. Close everything else.
- **Ctrl-C on the worldserver console kills the realm.** Detach with `Ctrl-P`
  then `Ctrl-Q` (`admin.sh console` sets this).

---

## Sources

Config keys, the env-var algorithm, build targets, and the SQL path were verified
against the fork source, not the wiki.

[mod-playerbots install](https://github.com/mod-playerbots/mod-playerbots/wiki/Installation-Guide) ·
[fork Dockerfile](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/apps/docker/Dockerfile) ·
[Config.cpp env-var conversion](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/src/common/Configuration/Config.cpp) ·
[Dokploy template format](https://github.com/Dokploy/templates/blob/main/README.md)
