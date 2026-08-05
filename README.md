# Azeroth Family — a private WotLK realm for the family

## What this is

A closed AzerothCore 3.3.5a (WotLK) realm with `mod-playerbots`, run as a Dokploy
Docker Compose app on a home machine and reachable only over Tailscale. It is
tuned for kids — gentle progression, no death penalty, no PvP — and playerbots
keep the world populated when nobody human is online. Clients run in Spanish
(esES); the server data stays enUS, because playerbots' spell logic matches
English spell names (an esES client still renders everything it owns in Spanish
from its own files).

```
  build machine                     home machine (Dokploy)               family
 ┌──────────────────┐              ┌──────────────────────┐           ┌─────────┐
 │ build-and-push   │   images     │  mysql               │           │ WoW     │
 │ compiles core +  │ ───────────▶ │  authserver  :3724   │ ◀───────▶ │ 3.3.5a  │
 │ modules once     │              │  worldserver :8085   │ tailnet   │ esES    │
 └──────────────────┘              │  + playerbots        │  only     └─────────┘
                                   │  + llm-chatter bridge│
                                   │  + admin-ui  :8080   │
                                   └──────────────────────┘
```

Two stages, kept separate on purpose:

- **Build** happens on a machine with CPU and RAM (~40–90 min cold, ~8 GB free).
  There is no maintained prebuilt playerbots image, so the forked core
  (`mod-playerbots/azerothcore-wotlk`) and the modules are compiled once here.
  The stock `acore/ac-wotlk-*` images have no bot code and will not work.
- **Deploy** happens on the Dokploy host, which only *pulls* finished images
  (~30 s redeploy). It never compiles.

### What "kid friendly" means

- **No death penalty** — no resurrection sickness, instant corpse reclaim, zero
  durability loss, no fall damage. Dying is never a reason to stop playing.
- **x3 XP, x2 loot** on the good tiers — real progress in a 45-minute session
  without outlevelling the story.
- **PvE only** (`GameType = 0`) — no open-world PvP, no bot battlegrounds.
- **Instant flight paths**, all routes known from the start.
- **Max 4 bots per player** (a 5-man group, not the module default of 40);
  `SelfBotLevel = 2` lets a stuck kid hand their character to the AI briefly.
- **Bots sleep when no human is online** — saves CPU and electricity.
- **Bot chat is fenced off.** The toxic-phrase and toxic-link reply chances (some
  are ON upstream) are set to 0, and dialogue comes from an LLM via OpenRouter
  rather than the fixed English phrase table. Neither the LLM module nor the old
  phrase table has a content filter, so the request log is the only visibility
  into what bots say — keep it on, and re-read it after any model change.

### Hardware

Playerbots is heavy — every bot is a full player simulation. AzerothCore is bound
by **single-core** speed far more than core count (a fast 4-core box beats a slow
16-core one), which is why `MapUpdate.Threads = 4`, not 16.

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
verifies the module SQL is present, and produces five images: `worldserver`,
`authserver`, `db-import` (one compile, three `--target`s against the core's own
Dockerfile), `llm-chatter-bridge`, and `admin-ui`.

If Dokploy is on the same machine, you're done — the images are in the local
Docker daemon. If you built elsewhere, push to a registry and point Dokploy at it:

```bash
REGISTRY=ghcr.io/oskar-flores ./build-and-push.sh --push
# then set IMAGE_PREFIX=ghcr.io/oskar-flores in Dokploy
```

### Versions & updates (everything is pinned by commit)

Core and every module are pinned by commit at the top of `build-and-push.sh`, and
the image tag is derived from the core pin (`<YYYY.MM.DD>-<short-sha>` — the sha
is the identity, the date is a build stamp). Nothing moves unless you commit a new
ref, so "what is deployed" is always answerable from git.

```bash
./build-and-push.sh --update      # report what the pins WOULD become; moves nothing
./build-and-push.sh --fetch-only  # resolve + check out the pins, build nothing
./build-and-push.sh --no-latest   # stop publishing the `latest` alias
```

To update upstream: run `--update`, edit the `*_REF` values it reports at the top
of the script, commit them, then `./build-and-push.sh`. Always move the core and
`mod-playerbots` **together** — mixing versions gives compile errors or runtime
crashes. Every build also tags `latest`, so a deploy with no `IMAGE_TAG` set keeps
working; to pin or roll back, set `IMAGE_TAG` in Dokploy to a specific tag (then
pass `--no-latest`).

### Tailscale — set this up first

Install Tailscale on the host and every machine that will play, then
`tailscale ip -4` (e.g. `100.101.102.103`). You'll put that address in
`REALM_ADDRESS` and `BIND_ADDR` at the deploy step below.

`BIND_ADDR` is the actual safety boundary. Docker publishes ports on `0.0.0.0` by
default — your LAN, and the internet if anything's ever forwarded. Pinning the
publish address to the Tailscale IP means the socket only exists on the tailnet:
a device not in your tailnet can't even reach it. Combined with AzerothCore having
no self-registration (accounts exist only if you type them at the console), that's
the closed-realm guarantee — enforced by the network, not a setting a curious kid
can flip.

### Deploy on Dokploy

Set these in the application's Environment tab (full list in `.env.example`):
**`REALM_ADDRESS`** and **`BIND_ADDR`** = your Tailscale IP (above);
**`OPENROUTER_API_KEY`** = your key (the bridge refuses to start without it);
**`SOAP_USER`/`SOAP_PASS`** = a gmlevel-3 service account — create it on the host
first, see *Web console* below; **`DB_ROOT_PASSWORD`**; and `IMAGE_PREFIX` if you
pushed to a registry.

Then two ways in:

**A. Compose from a Git repo.** Push this folder somewhere Dokploy can read → new
application → **Docker Compose** → compose path `docker-compose.yml` → Deploy.

**B. One-click template** (`dokploy-template/`). In Dokploy → **Settings →
Templates**, add a custom template source (the fetch is unauthenticated HTTP, so
the repo must be public):
```
https://raw.githubusercontent.com/oskar-flores/azeroth-family/main/dokploy-template
```
"Azeroth Family Server" appears under Templates. Install it, set `realm_address`
to your Tailscale IP and `openrouter_api_key` to your key, deploy. The images
must already exist on the host — build first, or set `image_prefix` to a registry
you've pushed to.

The template bakes the kid settings in. When you change `family-settings.ini` or
`llm-chatter-settings.conf`, regenerate it too (see *What to change*):

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
python3 scripts/make-template-compose.py
```

First deploy takes ~20 min: one-shot containers fetch ~16 GB of map data and
build the databases, then exit (that's success, not a crash); `ac-realm-config`
then rewrites the realm address on every boot.

### The client, in Spanish

You need a **3.3.5a (build 12340)** client, esES locale. Edit
`Data/esES/realmlist.wtf` to `set realmlist 100.101.102.103`, then delete the
`Cache` folder or the client may keep the old address. (For esMX, same steps,
different folder.)

---

## What to change, and how

### Gameplay and bot config

**Edit `family-settings.ini`, never `family.env`.** Then regenerate and redeploy
— no rebuild:

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
```

The env-var name conversion is not "uppercase and swap dots" — it also splits
camelCase and letter↔digit boundaries, so `Death.CorpseReclaimDelay.PvE` becomes
`AC_DEATH_CORPSE_RECLAIM_DELAY_PV_E`. A wrong name is silently ignored.
`scripts/ini2env.py` is a port of the fork's conversion function and can look up
any key or self-test:

```bash
python3 scripts/ini2env.py --key Rate.XP.Kill     # look up one AC_* name
python3 scripts/ini2env.py --selftest             # 13/13
```

`family.env` is committed on purpose — it is what the deployed server actually
reads, so an ini change that isn't regenerated and committed has no effect.

### Bot dialogue

`llm-chatter-settings.conf` holds only deltas over the module's upstream
defaults, so new upstream keys arrive on the next build with no merge. It is
mounted into both the worldserver and the bridge. **Never put a secret in it —
it's committed to a public repo** (the bridge reads a plain file with no env-var
support; the API key comes from `OPENROUTER_API_KEY`). Switching model or
provider is a restart of the bridge, not a rebuild:

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
case-insensitive ASCII in 3.3.5a; keep them short and typeable.

### Web console

`ac-admin-ui` is a small web page the family can use instead of SSH — on the
tailnet only, at `http://<tailscale ip>:8080`. Login is **the player's own WoW
account**: the console authenticates against `acore_auth` with the same SRP6 the
client uses, not a separate password. GM level 3 sees the admin page (create
accounts, set GM levels 0–3, restart the worldserver, run a backup); everyone
else gets a read-only family page showing who is online.

It needs a dedicated gmlevel-3 service account for its SOAP actions
(`SOAP_USER`/`SOAP_PASS` in `.env.example`). Create it once on the Docker host
before the first deploy:

```bash
./scripts/admin.sh account acconsole <a long random password>
./scripts/admin.sh gm acconsole 3
```

**Restore is deliberately not in the console.** A restore must run while the
worldserver is down (it flushes in-memory character state over a fresh import),
and `restart: unless-stopped` would bring the world straight back up underneath
the import. Restores stay in `admin.sh`:

```bash
./scripts/admin.sh restore <file.sql.gz> <db>
```

### Backups

```bash
./scripts/admin.sh backup      # keeps the last 14 of each database
```

`acore_characters` is the one that matters — every character, bag, bank, and
achievement. `world` and `auth` can be rebuilt from scratch; a lost character
cannot. Put backups on a schedule, and test a restore once while nothing's at
stake.

---

## Modules enabled

Five modules compile in alongside the playerbots fork. All are pinned by commit
in `build-and-push.sh`.

| module | what it is |
|---|---|
| `mod-playerbots` | The bots — full player simulations that group with you, fill out the world, and can be driven from chat or the addon UI. |
| `mod-llm-chatter` | LLM-driven bot chat in Spanish, replacing playerbots' fixed English phrase table. The C++ half compiles in; the Python half runs as the separate `ac-llm-chatter-bridge` container so no API call blocks the world tick. |
| `mod-autobalance` | Scales dungeon mobs and bosses to group size (bots count as players). Config-only, no SQL. |
| `mod-transmog` | Cosmetic gear appearances. Ships SQL, and its NPC gossip menu is the only interface — spawn it once per capital as a GM (`.npc add 190010`). |
| `mod-multibot-bridge` | Server half of the MultiBot addon: answers structured `MBOT` messages so bots can be driven from a UI instead of chat. Does nothing until the client addon is installed, which this repo deliberately does not ship. |

---

## Adding a module

Modules are declared in the `EXTRA_MODULES` array at the top of
`build-and-push.sh` — one `"name|url|branch|ref"` per line, pinned by commit.

1. **Add a line, then rebuild** (`./build-and-push.sh`). Add modules **one at a
   time** and rebuild between each — every one is another thing that can break the
   compile.
2. **SQL ships itself.** If the module has SQL under `data/sql/`, the importer
   applies it automatically from `modules/<mod>/data/sql/`. Do **not** also stage
   it under `data/sql/custom/` — the same filename twice makes the importer log
   `Duplicate filename` and fatally abort the whole import.
3. **Watch the playerbots internals.** A module that `#include`s playerbots
   headers (as `mod-multibot-bridge` does) is the first thing to break when the
   playerbots pin moves — don't patch the module or drag the pin backwards (move
   core and playerbots together, per *Versions & updates*).
4. **Give it a container only if it has its own process.** Most modules just
   compile in and need no service. `mod-llm-chatter` is the exception: its Python
   bridge is a separate image and container.
5. **Handle one-off setup the build can't.** Some modules need an in-game step —
   transmog's NPC must be spawned by a GM (`.npc add 190010`), because the command
   needs a player position SOAP can't supply.

---

## Common gotchas

- **Client connects, then hangs at the realm list.** The `realmlist` address in
  the database isn't reachable from the client. Run `./scripts/admin.sh status`
  and confirm it matches your Tailscale IP — `ac-realm-config` rewrites that row
  on every boot.
- **`Unknown database 'acore_playerbots'`.** The playerbots base SQL dir
  (`modules/mod-playerbots/data/sql/playerbots/base`) was missing at build — the
  build verifies it and hard-fails otherwise, so this means a broken module
  checkout. Re-run `./build-and-push.sh --fetch-only` then rebuild;
  `ac-realm-config` creates the database itself as a backstop.
- **First boot sits at "Loading…" for minutes.** Normal — bots are being created
  and logged in for the first time.
- **Build dies partway through.** Almost always RAM. Close everything else, or
  lower the build parallelism.
- **Ctrl-C on the worldserver console kills the realm.** Detach with `Ctrl-P`
  then `Ctrl-Q` (`admin.sh console` sets this).

---

## Sources

Config keys, the env-var algorithm, Dockerfile build targets, and the module-SQL
path were verified against the fork source, not the wiki.

[mod-playerbots install](https://github.com/mod-playerbots/mod-playerbots/wiki/Installation-Guide) ·
[fork Dockerfile](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/apps/docker/Dockerfile) ·
[Config.cpp env-var conversion](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/src/common/Configuration/Config.cpp) ·
[Dokploy template format](https://github.com/Dokploy/templates/blob/main/README.md)
