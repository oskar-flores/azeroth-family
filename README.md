# Azeroth Family — a private WotLK realm for the family

A closed AzerothCore 3.3.5a realm with `mod-playerbots`, deployed as a Dokploy
Docker Compose app on a home machine, reachable only over Tailscale. Tuned for
kids: gentle progression, no death penalty, no PvP — and ~150 bots keep the world
feeling alive. Clients run in Spanish (esES).

```
  build machine                     home machine (Dokploy)               family
 ┌──────────────────┐              ┌──────────────────────┐           ┌─────────┐
 │ build-and-push   │   images     │  mysql               │           │ WoW     │
 │ compiles core +  │ ───────────▶ │  authserver  :3724   │ ◀───────▶ │ 3.3.5a  │
 │ playerbots once  │              │  worldserver :8085   │ tailnet   │ esES    │
 └──────────────────┘              │  + ~150 playerbots   │  only     └─────────┘
                                   └──────────────────────┘
```

Two stages, kept separate: **build** on a machine with CPU and RAM (~40–90 min
cold, ~8 GB free), **deploy** on the Dokploy host, which only pulls finished
images (~30 s redeploy). There's no maintained prebuilt playerbots image, so the
core and module are compiled once from the fork
(`mod-playerbots/azerothcore-wotlk`, branch `Playerbot`) — the stock
`acore/ac-wotlk-*` images have no bot code and won't work here.

---

## Requirements

Playerbots is heavy — every bot is a full player simulation, pathfinding and all.
With ~150 bots and a couple of humans:

| | comfortable | tight |
|---|---|---|
| CPU | 6+ fast modern cores | 4 cores |
| RAM | 16 GB | 8 GB |
| Disk | 60 GB SSD | 40 GB (~16 GB is map data, downloaded once) |

AzerothCore is bound by **single-core** speed far more than core count — a fast
4-core box beats a slow 16-core one. That's also why `MapUpdate.Threads = 4`, not
16 (past ~8 it gets slower). If the host struggles, the first dial is bot count
(`AiPlayerbot.Min/MaxRandomBots`), before anything else.

---

## Files

```
azeroth-family/
├── build-and-push.sh          compiles core + modules into 5 Docker images
├── docker-compose.yml         the Dokploy stack
├── .env.example               paste into Dokploy's Environment tab
├── family-settings.ini        ← EDIT THIS (gameplay + bot config)
├── family.env                 generated from the ini; never hand-edit
├── llm-chatter-settings.conf  bot dialogue (deltas over upstream defaults)
├── dokploy-template/          one-click Dokploy template (custom source)
├── docker/                    Dockerfiles for the llm-chatter bridge and admin-ui
├── admin-ui/                  the web console (Fastify, no bundler)
└── scripts/
    ├── ini2env.py             .ini keys → AC_* env vars (self-tests)
    ├── make-template-compose.py   bakes vars into the Dokploy template
    └── admin.sh               accounts, console, backups, status
```

---

## Configure

Edit `family-settings.ini`, never `family.env`. The AzerothCore env-var name
conversion isn't just "uppercase and swap dots" — it also splits camelCase and
letter↔digit boundaries, so `Death.CorpseReclaimDelay.PvE` becomes
`AC_DEATH_CORPSE_RECLAIM_DELAY_PV_E`. A wrong name is silently ignored.
`scripts/ini2env.py` is a port of the fork's conversion function and self-tests:

```bash
python3 scripts/ini2env.py --selftest                  # 13/13 passed
python3 scripts/ini2env.py --key Rate.XP.Kill          # look up one AC_* name
python3 scripts/ini2env.py family-settings.ini > family.env    # regenerate
```

These are runtime settings — regenerate `family.env` and redeploy, no rebuild.

Bot *dialogue* is separate: `llm-chatter-settings.conf` is a WoW-style `.conf`
holding only deltas over the module's upstream defaults, so new upstream keys
arrive on the next build with no merge. **It's committed to a public repo — never
put a secret in it** (the bridge reads a plain file, no env-var support).

---

## Build

```bash
git clone <this repo> azeroth-family && cd azeroth-family
./build-and-push.sh
```

The script fetches the playerbots fork (and refuses if the remote isn't it),
fetches the modules, verifies the module SQL is present, and builds five images:
`worldserver`, `authserver`, `db-import` (one compile, three `--target`s against
the core's own Dockerfile), `llm-chatter-bridge` and `admin-ui`.

Compiled-in modules: `mod-playerbots`, `mod-llm-chatter`, `mod-autobalance`,
`mod-transmog`.

### Versions

Core and every module are pinned by commit at the top of `build-and-push.sh`,
and the image tag is derived from the core pin — `2026.08.03-190184a`, where the
sha is the identity and the date is a build stamp.

```bash
./build-and-push.sh --fetch-only   # resolve + check out the pins, print the tag,
                                   # build nothing (minutes, not an hour)
./build-and-push.sh --update       # report what the pins WOULD become; changes
                                   # nothing. Bump the *_REF values by hand.
./build-and-push.sh --no-latest    # stop publishing the `latest` alias
```

`--update` deliberately does not move anything, so a version bump is a commit you
can see in a diff. Always move core and `mod-playerbots` **together** — mixing
versions gives compile errors or runtime crashes.

Every build also tags `latest`, so a deploy that has no `IMAGE_TAG` set keeps
working. To pin a running stack, set `IMAGE_TAG` in Dokploy to the tag the script
printed; to roll back, set it to an older one. Once `IMAGE_TAG` is set, pass
`--no-latest`.

If Dokploy is on the same machine, you're done — images are in the local Docker
daemon and the stack will find them. If you built elsewhere:

```bash
REGISTRY=ghcr.io/oskar-flores ./build-and-push.sh --push
```

and set `IMAGE_PREFIX=ghcr.io/oskar-flores` in Dokploy.

### After the first build with Transmog

Transmog's NPC gossip menu is its only interface, so the NPC has to be spawned
once, in-game, as a GM. Stand where you want it and:

```
.npc add 190010
```

Repeat per capital. This cannot be done from the web console or `admin.sh` — the
command needs a player position, which SOAP has no way to supply.

Sanity-check AutoBalance from inside a dungeon with `.ab mapstat`. Remember bots
count as players: a character with four bots reads as a five-player group.

---

## Deploy on Dokploy

**A. Compose from a Git repo.** Push this folder somewhere Dokploy can read → New
application → **Docker Compose** → point it at the repo, compose path
`docker-compose.yml` → Environment tab: paste `.env.example` filled in → Deploy.

**B. One-click template** (`dokploy-template/`). In Dokploy → **Settings →
Templates**, add a custom template source with this base URL (the fetch is
unauthenticated HTTP, so the repo must be public):
```
https://raw.githubusercontent.com/oskar-flores/azeroth-family/main/dokploy-template
```
"Azeroth Family Server" appears under Templates. Install it, set `realm_address`
to your Tailscale IP and `anthropic_api_key` to your Anthropic key, deploy. The
images must already exist on the host — build first (or set `image_prefix` to a
registry you've pushed to). The kid settings are baked into the template; when you
change `family-settings.ini` or `llm-chatter-settings.conf`, regenerate it too:

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
python3 scripts/make-template-compose.py
```

First deploy takes ~20 min: one-shot containers download ~16 GB of map data and
build the databases, then exit (that's success, not a crash).

---

## Tailscale — the actual safety boundary

Install Tailscale on the host and every machine that will play, then
`tailscale ip -4` (e.g. `100.101.102.103`). Put that address in **both**
`REALM_ADDRESS` and `BIND_ADDR`.

`BIND_ADDR` does the real work. Docker publishes ports on `0.0.0.0` by default —
your LAN, and the internet if anything's ever forwarded. Pinning the publish
address to the Tailscale IP means the socket only exists on the tailnet: a device
not in your tailnet can't even reach it. Combined with AzerothCore having no
self-registration (accounts exist only if you type them at the console), that's
the closed-realm guarantee — enforced by the network, not a setting a curious kid
can flip.

---

## The client, in Spanish

You need a **3.3.5a (build 12340)** client, esES locale. Edit
`Data/esES/realmlist.wtf`:
```
set realmlist 100.101.102.103
```
Delete the `Cache` folder afterward, or the client may keep using the old address.

The **server** data must stay enUS — playerbots' spell logic matches English spell
names. That doesn't rule out Spanish: an esES client renders everything it owns
(spells, items, the UI) in Spanish from its own files. Quest and NPC text comes
from the server's `*_locale` tables, so most of it is Spanish, but coverage isn't
100% — expect occasional English, mostly in later content. For esMX, same steps,
different folder.

---

## Accounts

```bash
./scripts/admin.sh account papa   micontraseña
./scripts/admin.sh gm papa 3          # GM powers for an adult
./scripts/admin.sh list | status      # see who's there
```

Leave the kids at level 0 — GM commands can delete characters. Passwords are
case-insensitive ASCII in 3.3.5a; keep them short and typeable.

---

## Web console

`ac-admin-ui` is a small web page the family can use instead of SSH. It is on
the tailnet only — published on `BIND_ADDR` just like the game ports, so it is
reachable at `http://<your tailscale ip>:8080` and nowhere else.

Login is **the player's own WoW account** — the console authenticates against
`acore_auth` with the same SRP6 the game client uses, not a separate password.
Anyone at GM level 3 sees the admin page (create accounts, set GM levels 0-3,
restart the worldserver, and run a backup now); everyone else gets a
read-only family page showing who is online and their own characters.

It needs a dedicated gmlevel-3 service account for its SOAP actions — see
`SOAP_USER`/`SOAP_PASS` in `.env.example`. Create that once on the Docker host
before the first deploy:

```bash
./scripts/admin.sh account acconsole <a long random password>
./scripts/admin.sh gm acconsole 3
```

**Restore is deliberately not in the console.** A restore has to run while the
worldserver is down (it flushes in-memory character state over a fresh import),
and `restart: unless-stopped` would bring the world straight back up underneath
the import. Restores stay in `admin.sh`:

```bash
./scripts/admin.sh restore <file.sql.gz> <db>
```

---

## What "kid friendly" means

- **No death penalty.** No resurrection sickness, instant corpse reclaim, zero
  durability loss, no fall damage. Dying is never a reason to stop playing.
- **x3 XP, x2 loot** on the good tiers. Real progress in a 45-minute session
  without outlevelling the story.
- **PvE only** (`GameType = 0`): no open-world PvP, no bot battlegrounds.
- **Instant flight paths** (scenic route still toggleable), all routes known from
  the start.
- **Max 4 bots per player** — a 5-man group, not the module default of 40.
  `SelfBotLevel = 2` lets a stuck kid hand their character to the AI for a moment.
- **Bots sleep when no human is online** — saves CPU and electricity.

Bot chat is pinned explicitly in the ini: the toxic-phrase and toxic-link reply
chances (some are ON upstream) are set to 0, and bot dialogue now runs through
`mod-llm-chatter` in Spanish instead of the fixed English phrase table. The
request log (`LLMChatter.RequestLog.Enable`) is the only visibility into what bots
say — keep it on. Neither module has a content filter, so eyeball the dialogue
yourself before turning kids loose.

---

## Things that go wrong

**Client connects, then hangs at the realm list.** The `realmlist` address in the
database isn't reachable from the client. Run `./scripts/admin.sh status` and
confirm it matches your Tailscale IP. `ac-realm-config` rewrites that row on every
boot for exactly this reason.

**`Unknown database 'acore_playerbots'`.** Module SQL didn't import. The importer
applies it automatically from `modules/<mod>/data/sql/`, and `ac-realm-config`
creates the database itself as a backstop. If it persists, rebuild with
`./build-and-push.sh`.

**Build dies partway through.** Almost always RAM. Close everything else, or
lower the build parallelism.

**First boot sits at "Loading…" for minutes.** Normal — the bots are being
created and logged in for the first time.

**Ctrl-C in the console kills the realm.** Detach with `Ctrl-P` then `Ctrl-Q`
(`admin.sh console` sets this).

---

## Backups & updates

```bash
./scripts/admin.sh backup      # keeps the last 14 of each database
```

`acore_characters` is the one that matters — every character, bag, bank and
achievement. `world` and `auth` can be rebuilt from scratch; a lost character
cannot. Put it on a schedule, and test a restore once while nothing's at stake.

Upstream updates are a two-step now, on purpose:

```bash
./build-and-push.sh --update    # reports what the pins would become
# edit the *_REF values at the top of the script, commit them
./build-and-push.sh             # build the new pins
```

Nothing moves until you commit a ref, so "what is deployed" is always answerable
from git.

---

## Sources

Config keys, the env-var algorithm, Dockerfile build targets and the module-SQL
path were verified against the fork source, not the wiki.

[mod-playerbots install](https://github.com/mod-playerbots/mod-playerbots/wiki/Installation-Guide) ·
[fork docker-compose](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/docker-compose.yml) ·
[fork Dockerfile](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/apps/docker/Dockerfile) ·
[Config.cpp env-var conversion](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/src/common/Configuration/Config.cpp) ·
[worldserver.conf.dist](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/src/server/apps/worldserver/worldserver.conf.dist) ·
[AzerothCore + Docker](https://www.azerothcore.org/wiki/install-with-docker) ·
[Dokploy Compose](https://docs.dokploy.com/docs/core/docker-compose/domains) ·
[Dokploy template format](https://github.com/Dokploy/templates/blob/main/README.md) ·
[Non-HTTP services (#640)](https://github.com/Dokploy/templates/issues/640)
