# Azeroth Familiar — a private WotLK server for the family

A closed AzerothCore 3.3.5a realm with `mod-playerbots`, deployed as a Dokploy
Compose app on a home machine, reachable only over Tailscale, tuned so that
kids have fun and never get punished, with a Spanish client.

```
  your build machine              home machine (Dokploy)              family
 ┌──────────────────┐            ┌──────────────────────┐          ┌─────────┐
 │ build-and-push   │  images    │  mysql               │          │ WoW     │
 │ compiles core +  │ ─────────▶ │  authserver  :3724   │ ◀──────▶ │ 3.3.5a  │
 │ playerbots once  │            │  worldserver :8085   │ tailnet  │ esES    │
 └──────────────────┘            │  + 40 playerbots     │  only    └─────────┘
                                 └──────────────────────┘
```

---

## The one finding that shapes everything

**There is no maintained prebuilt playerbots image.** You asked for option 3
with option 1 as fallback — it has to be option 1, and here is the evidence.

`mod-playerbots` cannot run on stock AzerothCore. It needs a forked core
(`mod-playerbots/azerothcore-wotlk`, branch `Playerbot`) because it patches
files a normal module can't touch. So the official `acore/ac-wotlk-worldserver`
images on Docker Hub are useless here — they're built from upstream and have no
bot code in them.

The only public playerbots image I could find is
`hxhieu/ac-wotlk-worldserver:playerbots-39d73fc49`. I checked its Docker Hub
metadata directly: last pushed **14 August 2025**, one amd64 tag, and no
matching authserver or db-import image alongside it. That is a personal
one-off build from someone's laptop, now roughly a year stale, with no
guarantee its schema matches today's module SQL. Running your kids' characters
on it would be building on sand.

So: we compile once, on your machine, and Dokploy only ever pulls finished
images. That's actually the better architecture anyway — Dokploy redeploys
become 30 seconds instead of an hour, and a bad module update can never take
the server down mid-deploy.

The compile is ~40–90 minutes the first time and wants about 8 GB of free RAM.
After that `ccache` makes rebuilds much faster.

---

## Hardware reality check

Playerbots is heavy — every bot is a full player simulation, pathfinding and
all. With the 40 bots this config sets, and a couple of humans:

| | comfortable | tight |
|---|---|---|
| CPU | 6+ modern cores, fast single-core | 4 cores |
| RAM | 16 GB | 8 GB |
| Disk | 60 GB SSD | 40 GB |

Roughly 16 GB of that disk is the map/vmap/mmap data, downloaded once into a
Docker volume. AzerothCore is bound by **single-core** speed far more than core
count — a fast 4-core box beats a slow 16-core one. That's also why
`MapUpdate.Threads` is set to 4 and not 16; past ~8 it gets slower, not faster.

If the machine struggles, the first dial to turn is bot count
(`AiPlayerbot.MinRandomBots` / `MaxRandomBots`), not anything else.

---

## Files here

```
azeroth-family/
├── build-and-push.sh      compiles core + module into 3 Docker images
├── docker-compose.yml     the Dokploy stack
├── .env.example           what to paste into Dokploy's Environment tab
├── family-settings.ini    ← the file you actually edit
├── family.env             generated from it; never hand-edit
├── dokploy-template/      one-click Dokploy template (private/custom source)
└── scripts/
    ├── ini2env.py         converts .ini keys → AC_* env vars (and self-tests)
    └── admin.sh           accounts, console, backups, status
```

### Why `family-settings.ini` and a generator

AzerothCore lets you override any config value with an environment variable,
which is perfect for Dokploy — no config files to mount, everything visible in
the UI. But the name conversion is nastier than the wiki suggests. It isn't
"uppercase it and swap dots for underscores"; it also splits camelCase *and*
letter↔digit boundaries. Which means:

```
Death.CorpseReclaimDelay.PvE   →   AC_DEATH_CORPSE_RECLAIM_DELAY_PV_E
                                                              ^^^^^
```

Nobody guesses `PV_E`. Get it wrong and there's no error — the setting is
silently ignored and you spend an evening wondering why corpse runs still hurt.

So `scripts/ini2env.py` is a line-by-line port of `IniKeyToEnvVarKey()` from
the fork's `src/common/Configuration/Config.cpp`, and it self-tests against the
examples in that source file plus the one worked example in the playerbots wiki:

```bash
python3 scripts/ini2env.py --selftest      # 9/9 passed
python3 scripts/ini2env.py --key Rate.XP.Kill
```

Edit `family-settings.ini`, then regenerate and redeploy:

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
```

No rebuild needed — these are runtime settings.

---

## Build it

On the machine with the CPU and RAM:

```bash
git clone <this repo> azeroth-family && cd azeroth-family
./build-and-push.sh
```

If Dokploy runs on this same machine, that's it — the images are in the local
Docker daemon and the stack will find them. If you built somewhere else:

```bash
REGISTRY=ghcr.io/oskarflores ./build-and-push.sh --push
```

and set `IMAGE_PREFIX=ghcr.io/oskarflores` in Dokploy.

The script clones the correct fork (and refuses to continue if the remote isn't
the playerbots one), clones the module into `modules/`, and — this is the part
the official Docker instructions get wrong often enough to be the top
troubleshooting entry — copies the module's SQL into `data/sql/custom/db_*` so
the importer actually picks it up. Without that you get
`Unknown database 'acore_playerbots'` on first boot.

To pull upstream changes later: `./build-and-push.sh --update`. Always update
core and module **together**; mixing versions gives compile errors or runtime
crashes.

---

## Tailscale: the actual safety mechanism

Install Tailscale on the host and on every machine that will play. Then:

```bash
tailscale ip -4        # e.g. 100.101.102.103
```

Put that address in **both** `REALM_ADDRESS` and `BIND_ADDR`.

`BIND_ADDR` is doing real work. Docker publishes ports on `0.0.0.0` by default,
meaning your LAN and (if anything is ever forwarded) the internet. Pinning the
publish address to the Tailscale IP means the listening socket only exists on
the tailnet interface. A device that isn't in your tailnet cannot open a
connection at all — not "gets rejected", *cannot reach it*. No port forwarding,
no router changes, no public DNS.

That, plus the fact that AzerothCore has no self-registration (accounts only
exist if you type them into the server console), is the closed-realm guarantee.
It's enforced by the network stack and by the absence of a registration page —
not by a setting a curious kid could flip.

---

## Deploy on Dokploy

1. Push this folder to a Git repo Dokploy can read.
2. New application → **Docker Compose** → point it at the repo, compose path
   `docker-compose.yml`.
3. Environment tab: paste `.env.example`, filled in.
4. Deploy.

### ...or install it as a one-click template

This repo also ships a Dokploy **template** under `dokploy-template/`, so you can
install the whole stack from Dokploy's Templates UI without pasting env vars by
hand. It's a **private/custom** template, not a marketplace contribution: this
stack publishes raw game TCP ports (auth 3724 / world 8085) and uses locally
built images, neither of which the public template format allows.

```
dokploy-template/
├── meta.json               registry Dokploy reads
└── azeroth-family/
    ├── docker-compose.yml  same stack as the repo root
    ├── template.toml       variables + env (no web domain — it's TCP, not HTTP)
    ├── family.env          the kid-friendly settings, baked in
    └── azeroth-family.png  logo
```

To use it:

1. Make the `dokploy-template/` path reachable by Dokploy's template fetch.
   Dokploy pulls templates over an **unauthenticated** HTTP GET, so the path must
   be publicly readable. This repo is private, so either copy the folder into a
   small **public** repo (or a GitHub gist) and point Dokploy there, or make this
   repo public.
2. In Dokploy → **Settings → Templates**, add a custom template source whose base
   URL is the raw path to that folder, e.g.
   `https://raw.githubusercontent.com/<you>/<public-repo>/main/dokploy-template`.
3. "Azeroth Family Server" appears under Templates. Install it, set
   `realm_address` to your Tailscale IP (`tailscale ip -4`), and deploy.

First-class support for *private* template sources is tracked at
[Dokploy #2414](https://github.com/Dokploy/dokploy/issues/2414); once your
Dokploy version supports an authenticated source you can skip step 1 and point
it straight at this private repo. The same images must already exist on the host
(build first with `./build-and-push.sh`).

When you change `family-settings.ini`, regenerate and refresh the baked-in copy
so the template stays in sync:

```bash
python3 scripts/ini2env.py family-settings.ini > family.env
cp family.env dokploy-template/azeroth-family/family.env
```

First deploy takes ~20 minutes: `ac-client-data-init` downloads ~16 GB of map
data and `ac-db-import` builds the databases. Both are one-shot containers —
they exit when done, which is correct, not a crash.

Watch for `ac-realm-config` in the logs. It prints the realm row it wrote. If
that address isn't your Tailscale IP, the clients will connect, authenticate,
and then hang forever at the realm list. That single row is the most common
"my private server doesn't work" cause in existence, which is why there's a
container whose entire job is setting it on every boot.

### Accounts

```bash
./scripts/admin.sh account papa   micontraseña
./scripts/admin.sh account nino1  dragon123
./scripts/admin.sh gm papa 3          # you get GM powers
# leave the kids at level 0 — GM commands can delete characters
```

Passwords are case-insensitive ASCII in 3.3.5a. Keep them short and typeable;
a 7-year-old has to enter this at a login screen with a controller-grade
attention span.

---

## The client, in Spanish

You need a **3.3.5a (build 12340)** client, esES locale. Then edit
`Data/esES/realmlist.wtf`:

```
set realmlist 100.101.102.103
```

Delete the `Cache` folder after changing it, or the client may keep using the
old address.

There's a subtlety worth understanding. The playerbots wiki is explicit that the
**server** must use enUS data files, because the bot spell system matches on
English spell names — Spanish server data breaks the bots. That sounds like it
rules out Spanish, but it doesn't: the client renders everything it owns
(spells, items, zone names, tooltips, the entire UI) from its own local files,
so an esES client shows Spanish regardless of what the server holds. The
`ac-client-data-init` image ships enUS data, which is exactly what we want.

What *does* come from the server is quest text, NPC dialogue and a few system
messages, read from the `*_locale` tables in the world database. AzerothCore's
world DB carries esES translations for a large part of that, so most quests
will be in Spanish, but coverage isn't 100% — expect occasional English quest
text, mostly in later expansion content. I'd rather tell you that now than have
you think something is misconfigured.

To use esMX instead, it's the same everywhere — just `Data/esMX/realmlist.wtf`.

---

## What "kid friendly" actually means here

You picked *closed realm* and *gentle gameplay*. Here's the reasoning behind
each setting, because you'll want to adjust some of them once you see how they
land.

**Nothing punishes death.** This is the big one. In vanilla WotLK, dying means
a corpse run, resurrection sickness, and a repair bill. For an adult that's
tension; for a kid it's a reason to stop playing. So: resurrection sickness
never triggers (`Death.SicknessLevel = 100`, above max level 80), corpse
reclaim is instant, and all durability loss is zero. Fall damage is off too —
kids jump off things, constantly — and `DisableWaterBreath = 0` means nobody
ever drowns while swimming around a lake looking at fish.

**x3 experience.** Fast enough that a 45-minute session shows real progress,
slow enough that zones and quest chains still make narrative sense. Above ~x10
you outlevel the story and the world stops cohering. Loot on the good tiers is
x2, so there are more "look what I got!" moments without burying them in grey
vendor trash.

**No PvP, ever.** `GameType = 0` makes it a PvE realm — nobody can attack
anyone in the open world. Bot battlegrounds are off too. Combined with the
closed realm, there is no one to be griefed by.

**Less walking.** All flight paths known from character creation, and
`InstantFlightPaths = 2` — instant by default, but each flight master still
offers the scenic route if someone wants to watch the world go by.

**Bots capped at 4 per player.** The module default lets one player summon 40
bots. That's funny once and then the game is unplayable. Four gives a proper
5-man dungeon group. `SelfBotLevel = 2` is a nice touch: a kid stuck on a hard
pull can hand their own character to the AI for a moment, which works as an
"unstick me" button rather than a tantrum.

**Bots sleep when nobody's playing.** `DisabledWithoutRealPlayer = 1` — the
world only spins up when a human logs in. Meaningful on a machine that lives in
your house and costs you electricity.

### What config can't fix

Worth being straight about the limits. You didn't pick chat lockdown, and I
think that's right: on a realm only your family can reach, there are no
strangers to be protected from, so filtering chat mostly just annoys everyone.
The safety here comes from Tailscale and from no registration page — not from
chat settings. If you ever open the realm to friends-of-friends, revisit that,
and I'd add chat restrictions then.

Playerbots do chat among themselves. `InviteChat = 0` cuts the noisiest of it.
It's automated fantasy small talk, not user-generated content, but it is
English and it is unfiltered — worth a look yourself before turning kids loose.

WoW is rated PEGI 12 / ESRB Teen for fantasy violence, which is a judgement
call only you can make for your own kids.

---

## Things that will go wrong

**Client connects, then hangs at the realm list.** The `realmlist` address in
the database isn't reachable from the client. Check `./scripts/admin.sh status`
and confirm the address matches your Tailscale IP.

**`Unknown database 'acore_playerbots'` or missing bot tables.** Module SQL
didn't get imported. The build script stages it into `data/sql/custom/`;
`ac-realm-config` also creates the database itself as a backstop. If it still
happens, rebuild with `--update`.

**Build dies partway through.** Almost always RAM. Close everything else, or
lower the build parallelism.

**Server starts, then sits at "Loading..." for ages on first boot.** Normal.
The bots are being created and logged in for the first time — several minutes.

**Ctrl-C in the console kills the realm.** Detach with `Ctrl-P` then `Ctrl-Q`.
`admin.sh console` reminds you before attaching.

---

## Keeping it alive

```bash
./scripts/admin.sh backup        # keeps the last 14 of each database
```

`acore_characters` is the one that matters — every character, bag, bank and
achievement. `world` and `auth` can be rebuilt from scratch; a lost character
cannot. Worth putting on a schedule, and worth testing a restore once while
nothing is at stake.

Updating: `./build-and-push.sh --update`, then redeploy in Dokploy. Take a
backup first. The fork tracks upstream AzerothCore but lags it, so third-party
modules targeting the newest AzerothCore may not compile — if you add one and
it fails, find an older commit of that module.

---

## A note on sources

I verified the config key names, the environment-variable algorithm, the
Dockerfile build targets and the module-SQL staging path by reading the actual
source in the `Playerbot` branch rather than trusting the wiki, and it was
worth it — the durability settings are `DurabilityLoss.OnDeath`, not
`Rate.Durability.Loss.OnDeath` as I first assumed, and the wiki's description
of the env-var conversion is incomplete.

You asked me to check Reddit for the family use case. I couldn't — reddit.com
blocks the crawler I have access to, so I have no Reddit-sourced input in here
and didn't want to pretend otherwise. If you paste a thread's text to me I'll
happily fold its advice in.

**Sources:**
[mod-playerbots Installation Guide](https://github.com/mod-playerbots/mod-playerbots/wiki/Installation-Guide) ·
[Playerbot fork docker-compose.yml](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/docker-compose.yml) ·
[Playerbot fork Dockerfile](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/apps/docker/Dockerfile) ·
[Config.cpp env-var conversion](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/src/common/Configuration/Config.cpp) ·
[worldserver.conf.dist](https://github.com/mod-playerbots/azerothcore-wotlk/blob/Playerbot/src/server/apps/worldserver/worldserver.conf.dist) ·
[AzerothCore install with Docker](https://www.azerothcore.org/wiki/install-with-docker) ·
[Dokploy Compose docs](https://docs.dokploy.com/docs/core/docker-compose/domains) ·
[hxhieu image tags](https://hub.docker.com/r/hxhieu/ac-wotlk-worldserver/tags)
