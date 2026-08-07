# Azeroth Family

A private World of Warcraft 3.3.5a (WotLK) realm for the family — AzerothCore +
`mod-playerbots`, deployed with Dokploy, reachable only over Tailscale.

![AzerothCore 3.3.5a](https://img.shields.io/badge/AzerothCore-3.3.5a-blue)
![mod-playerbots](https://img.shields.io/badge/mod--playerbots-pinned-green)
![Deploy: Dokploy](https://img.shields.io/badge/deploy-Dokploy-7c3aed)
![Network: Tailscale](https://img.shields.io/badge/network-Tailscale%20only-111)

---

## Quick start

```bash
git clone https://github.com/oskar-flores/azeroth-family.git && cd azeroth-family && ./build-and-push.sh
```

That's the whole build — the forked core and every module, at pinned commits.
Then:

1. In Dokploy: new application → **Docker Compose** → compose path `docker-compose.yml`.
2. Set four required variables in the Environment tab (full list in `.env.example`):
   `REALM_ADDRESS`, `DB_ROOT_PASSWORD`, `SOAP_USER`, `SOAP_PASS`.
3. Deploy. First boot takes ~20 min while it downloads ~16 GB of map data and
   builds the databases.
4. Point the game client at it: `set realmlist <your tailscale ip>`.

> **Heads up:** the build takes **40–90 minutes** the first time and wants ~8 GB
> of free RAM. Later builds reuse ccache and are much faster.

---

## What this is

A closed realm, just for the family. It runs as a Dokploy Docker Compose app on
a home machine and is invisible to everything outside the tailnet.

**What "kid friendly" means here:**

| | |
|---|---|
| **No death penalty** | No resurrection sickness, instant corpse reclaim, no durability loss, no fall damage. |
| **x3 XP, x2 loot** | Real progress in a short session, without outlevelling the story. |
| **PvE only** | No open-world PvP, no bot battlegrounds. |
| **Instant flight paths** | All routes known from the start. |
| **Max 4 bots per player** | Not the module's default of 40. |

**Why this repo exists at all:** there is no maintained prebuilt playerbots
image. `mod-playerbots` needs the *forked* core
(`mod-playerbots/azerothcore-wotlk`) — stock AzerothCore images will not work —
so the compile happens here, once, and Dokploy only ever pulls finished images.

---

## Requirements

Every bot is a full player simulation, so playerbots is heavy. AzerothCore cares
about **single-core speed** far more than core count — a fast 4-core box beats a
slow 16-core one.

| | comfortable | tight |
|---|---|---|
| CPU | 6+ fast modern cores | 4 cores |
| RAM | 16 GB | 8 GB |
| Disk | 60 GB SSD | 40 GB (~16 GB is map data, fetched once) |

You also need: Docker, a Dokploy host, a Tailscale account, an
[OpenRouter key](https://openrouter.ai/keys) for bot chat, and a **3.3.5a (build
12340)** game client.

If the host struggles, the first dial is bot count
(`AiPlayerbot.Min/MaxRandomBots` in `family-settings.ini`, currently `1200`) —
before anything else. It's a runtime setting: regenerate and redeploy, no rebuild.

---

## Build

```bash
./build-and-push.sh                 # build locally, tag as azeroth-family/*
./build-and-push.sh --fetch-only    # check out the pins, build nothing
./build-and-push.sh --update        # report what the pins would become; moves nothing
```

Five images come out: `worldserver`, `authserver`, `db-import` (these three
share one compile), `llm-chatter-bridge`, and `admin-ui`.

If Dokploy runs on the same machine, you're done — the images are already in the
local daemon. If you built elsewhere, push to a registry:

```bash
REGISTRY=ghcr.io/oskar-flores ./build-and-push.sh --push
# then set IMAGE_PREFIX=ghcr.io/oskar-flores in Dokploy
```

### Versions

Everything is pinned **by commit** at the top of `build-and-push.sh`, and the
image tag comes from the core pin (`<date>-<short-sha>`) — so "what is deployed"
is always answerable from git.

To update: run `--update`, edit the `*_REF` values, commit, rebuild. Always move
the core and `mod-playerbots` **together** — mixing versions breaks the compile
or crashes at runtime. Every build also tags `latest`; set `IMAGE_TAG` in Dokploy
to pin or roll back.

---

## Deploy

Set these in Dokploy → your app → **Environment** (annotated list in
`.env.example`):

| variable | what it is |
|---|---|
| `REALM_ADDRESS` | Your Tailscale IP. Required. |
| `DB_ROOT_PASSWORD` | Any long random string. Required. |
| `SOAP_USER` / `SOAP_PASS` | A gmlevel-3 service account for the web console. Required — create it first (see [Web console](#web-console)). |
| `BIND_ADDR` | Same Tailscale IP. This is the security boundary. |
| `OPENROUTER_API_KEY` | The bridge refuses to start without a key for whichever provider `llm-chatter-settings.conf` names. |
| `IMAGE_PREFIX` | Only if you pushed to a registry. |

The first deploy runs one-shot containers that fetch map data and build the
databases, then exit — **that's success, not a crash**. After that,
`ac-realm-config` rewrites the realm address on every boot.

<details>
<summary><b>Alternative: one-click Dokploy template</b></summary>

In Dokploy → **Settings → Templates**, add a custom template source (the repo
must be public, since the fetch is plain HTTP):

```
https://raw.githubusercontent.com/oskar-flores/azeroth-family/main/dokploy-template
```

Install "Azeroth Family Server", set `realm_address` and `openrouter_api_key`,
deploy. The images must already exist on the host — build first, or set
`image_prefix` to a registry.

The template bakes the kid settings in, so regenerate it whenever you change
`family-settings.ini` or `llm-chatter-settings.conf`:

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
python3 scripts/make-template-compose.py
```
</details>

### Connecting the client

The family's clients are Spanish (esES). Edit `Data/esES/realmlist.wtf`:

```
set realmlist 100.101.102.103
```

Then delete the `Cache` folder, or the client may keep the old address. (esMX is
the same, just a different folder.)

---

## Configuration

### Gameplay and bots

Edit **`family-settings.ini`**, never `family.env`. Then regenerate and redeploy
— no rebuild:

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
```

The env-var conversion is not "uppercase and swap dots" — it also splits
camelCase and digit boundaries, so `Death.CorpseReclaimDelay.PvE` becomes
`AC_DEATH_CORPSE_RECLAIM_DELAY_PV_E`. Get a name wrong and it's **silently
ignored**, so look keys up instead of guessing:

```bash
python3 scripts/ini2env.py --key Rate.XP.Kill
```

`family.env` is committed on purpose — it's what the server actually reads, so
an ini edit that isn't regenerated and committed has no effect.

### Bot dialogue

**`llm-chatter-settings.conf`** holds only the deltas over the module's upstream
defaults, so new upstream keys arrive on the next build with no merge.

Never put a secret in it — it's in a public repo. Changing the model or provider
is a restart, not a rebuild:

```bash
docker compose restart ac-llm-chatter-bridge
```

There is no content filter in the module, so the request log is the control:

```bash
docker exec ac-llm-chatter-bridge tail -f /logs/llm_requests.jsonl
```

### Checks

```bash
python3 scripts/ini2env.py --selftest                  # 13/13
python3 scripts/ini2env.py family-settings.ini | diff - family.env   # drift check
```

---

## Operating it

### Accounts

```bash
./scripts/admin.sh account papa micontraseña
./scripts/admin.sh gm papa 3        # GM powers for an adult
./scripts/admin.sh list | status | console
```

Leave the kids at level 0 — GM commands can delete characters. Passwords are
case-insensitive ASCII in 3.3.5a, so keep them short and typeable.

### Web console

`ac-admin-ui` is a small web page the family can use instead of SSH — tailnet
only, at `http://<tailscale ip>:8080`. You log in with **your WoW account**; it
checks `acore_auth` with the same SRP6 the game client uses. GM level 3 gets the
admin page (create accounts, set GM levels, restart the worldserver, run a
backup); everyone else sees a read-only page with who's online.

It needs its own gmlevel-3 service account, created once before the first deploy:

```bash
./scripts/admin.sh account acconsole <a long random password>
./scripts/admin.sh gm acconsole 3
```

### Backups

```bash
./scripts/admin.sh backup                        # keeps the last 14 of each database
./scripts/admin.sh restore <file.sql.gz> <db>
```

`acore_characters` is the one that matters — every character, bag, bank and
achievement. `world` and `auth` can be rebuilt; a lost character can't. Put
backups on a schedule, and test a restore once while nothing's at stake.

Restore is deliberately not in the web console: it has to run while the
worldserver is down, and `restart: unless-stopped` would bring it straight back
up.

---

## Modules

Five modules compile into the core, all pinned by commit in `build-and-push.sh`.

| module | what it does |
|---|---|
| `mod-playerbots` | The bots: full player simulations that group with you and fill the world. |
| `mod-llm-chatter` | LLM-driven bot chat in Spanish, replacing the fixed phrase table. The C++ half compiles in; the Python half runs as the separate `ac-llm-chatter-bridge` container. |
| `mod-autobalance` | Scales dungeon mobs and bosses to group size (bots count as players). No SQL. |
| `mod-transmog` | Cosmetic gear appearances. Ships SQL; its NPC gossip menu is the only interface — spawn it once per capital with `.npc add 190010`. |
| `mod-multibot-bridge` | Server half of the MultiBot addon: lets a UI drive bots instead of chat. Does nothing until the client addon is installed, which this repo doesn't ship. |

<details>
<summary><b>Adding a module</b></summary>

Modules live in the `EXTRA_MODULES` array at the top of `build-and-push.sh` —
one `"name|url|branch|ref"` line each, pinned by commit.

1. **Add a line, then rebuild.** One at a time — each is another thing that can
   break the compile.
2. **SQL imports itself.** If the module has SQL under `data/sql/`, the importer
   picks it up from `modules/<mod>/data/sql/`. Do **not** also copy it into
   `data/sql/custom/` — the same filename twice makes the importer abort.
3. **Watch the playerbots internals.** A module that `#include`s playerbots
   headers (like `mod-multibot-bridge`) is the first to break when the
   playerbots pin moves. Move them together; don't patch the module or drag the
   pin backwards.
4. **Add a container only if it has its own process.** Most modules just compile
   in. `mod-llm-chatter` is the exception.
5. **Do any in-game setup the build can't** — e.g. transmog's NPC has to be
   spawned by a GM, because the command needs a player position.
</details>

---

## Troubleshooting

| symptom | cause |
|---|---|
| Connects, then hangs at the realm list | The realm address in the database isn't reachable. Run `./scripts/admin.sh status` and check it matches your Tailscale IP. |
| `Unknown database 'acore_playerbots'` | The playerbots base SQL dir was missing at build. Re-run `--fetch-only` and rebuild. |
| First boot sits at "Loading…" for minutes | Normal — the bots are being created and logged in for the first time. |
| Build dies partway through | Almost always RAM. Close everything else. |
| Containers exited right after deploy | If they're `ac-db-import` or `ac-client-data-init`, that's success — they're one-shot. |
| The realm died when you pressed `Ctrl-C` | That stops the worldserver. Detach with `Ctrl-P` then `Ctrl-Q` (`admin.sh console` sets this). |

---

## Sources

Config keys, the env-var algorithm, build targets and the SQL path were verified
against the fork's source, not the wiki.

[mod-playerbots install](https://github.com/mod-playerbots/mod-playerbots/wiki/Installation-Guide) ·
[fork Dockerfile](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/apps/docker/Dockerfile) ·
[Config.cpp env-var conversion](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/src/common/Configuration/Config.cpp) ·
[Dokploy template format](https://github.com/Dokploy/templates/blob/main/README.md)
