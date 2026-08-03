# Design: AutoBalance + Transmog, pinned image versions, Spanish proper nouns

Date: 2026-08-03
Status: approved, ready for implementation planning

## Problem

Three unrelated asks landed together, and they turn out to share one seam — the
build machine:

1. **Add `mod-autobalance` and `mod-transmog`.** Both are compiled-in C++
   modules, so both mean a rebuild, not a redeploy.
2. **Stop shipping `latest`.** Images are tagged `latest` everywhere, so there is
   no way to say which build is running, and no way to roll back.
3. **Make bot chat use Spanish proper nouns** — "Ventormenta", not "Stormwind".

`mod-playerbots` is already installed; it appeared on the request list but needs
no work.

## Decisions

| Question | Decision |
|---|---|
| Version scheme | `YYYY.MM.DD-<core-short-sha>`, e.g. `2026.08.03-190184a` |
| What a version pins | Core + every module, by commit — not by branch |
| Dokploy migration | Non-breaking: `latest` keeps being published alongside |
| AutoBalance tuning | Stock scaling + `StatModifier.Global = 0.85` |
| AutoBalance ref | `73d4ad3` (master), **not** the `stable` tag |
| Transmog posture | Free, restrictions relaxed, `EnablePlus` off |
| Spanish nouns | Rewrite the clause in the bridge Dockerfile |
| Rejected | `.patch` + `git apply`; config-driven language override |

---

## Part 1 — Version pinning

### Today

`build-and-push.sh` tracks branch heads (`CORE_BRANCH="Playerbot"`,
`MODULE_BRANCH="master"`) and `--update` does `git reset --hard origin/$branch`.
"The version" is therefore whatever GitHub served that morning. `TAG` defaults to
`latest`, `docker-compose.yml` defaults to `${IMAGE_TAG:-latest}` in six places
(`:68`, `:80`, `:135`, `:161`, `:214`, `:249`), and the Dokploy blueprint
hard-codes `image_tag = "latest"` (`template.toml:24`).

### Sources become pins

```bash
CORE_REF="190184a"      # mod-playerbots/azerothcore-wotlk @ Playerbot
MODULE_REF="ba46fcd"    # mod-playerbots/mod-playerbots   @ master
EXTRA_MODULES=(
  "mod-llm-chatter|https://github.com/Hokken/mod-llm-chatter.git|97274f8"
  "mod-autobalance|https://github.com/azerothcore/mod-autobalance.git|73d4ad3"
  "mod-transmog|https://github.com/azerothcore/mod-transmog.git|0d85cbc"
)
```

`clone_or_update()` needs reworking: `git clone --depth 1 --branch <sha>` does
not accept a SHA. It becomes `git init` + `git remote add` + `git fetch --depth 1
origin <sha>` + `git checkout FETCH_HEAD`. GitHub permits fetching an arbitrary
reachable SHA, so `--depth 1` still applies and clone cost is unchanged.

`--update` changes meaning and stops being destructive-by-surprise: it fetches
each branch head, prints the new SHAs against the current pins, and exits telling
you to commit them. It never silently moves what you build.

**On AutoBalance's ref specifically.** Upstream's README flags `master` as beta
and points at a `stable` tag. That tag is `5d2778e` and predates the core commit
its own README states as the minimum requirement, so `stable` is the *riskier*
choice against a current core. Pin `73d4ad3` (2026-01-16, settled six months)
instead. This is a deliberate departure from upstream's advice and belongs in a
comment next to the pin.

### Tag derivation

`TAG` defaults to `$(date +%Y.%m.%d)-<core-short-sha>`. The sha is the identity;
the date is a build stamp. Passing `TAG=` explicitly reproduces any past build
from the same pins.

Each image also gets OCI labels — `org.opencontainers.image.revision` (core sha)
plus a label per module ref — so a container found running on the host can be
traced to its sources without consulting the registry.

### Not breaking the running deploy

This is the part the request explicitly worried about, and it is handled by
addition rather than substitution:

- The `${IMAGE_TAG:-latest}` fallback **stays** in all six compose lines and in
  the blueprint. A fresh one-click install still works with no env set.
- Every build still tags and pushes `latest` in addition to the pinned tag.
- The build prints the exact `IMAGE_TAG=2026.08.03-190184a` line to paste into
  Dokploy, and `verify_push` runs against both tags.
- `--no-latest` opts out, once the pinned tag is in Dokploy and `latest` is dead
  weight.

`CLIENT_DATA_TAG` moves from `master` to `17.0.0-dev` in `.env.example` — the
same digest today, but frozen. `mysql:8.4` is already adequately pinned.

---

## Part 2 — AutoBalance

No SQL ships with this module, so it is config-only and rides the existing
`family-settings.ini` → `ini2env.py` → `family.env` pipeline.

### The finding that sets the values

**Playerbots are real `Player` objects, so AutoBalance counts them.** A kid
entering a dungeon with four bots reads as a five-player group and AutoBalance
does approximately nothing. The scaling only engages when the party is genuinely
small. This is why a flat modifier is needed in addition to enabling the module,
and it is the single non-obvious fact the config comments must carry.

### Settings

| Key | Upstream | Ours |
|---|---|---|
| `AutoBalance.Enable.Global` | 1 | 1 — pinned explicitly |
| `AutoBalance.MinPlayers` | 1 | 1 — pinned explicitly |
| `AutoBalance.InflectionPoint` | 0.5 | unchanged |
| `AutoBalance.StatModifier.Global` | 1.0 | **0.85** |

Everything else stays at upstream defaults. Two keys are pinned at their default
value on purpose: they are the ones a future reader would otherwise have to go
looking for, and the repo already does this in the playerbots block.

Intended outcome: solo play scales down hard, a kid plus four bots gets roughly
five-player tuning at ×0.85, bosses still take effort. If it plays wrong, this is
one line plus a redeploy — no rebuild.

---

## Part 3 — Transmog

### A one-time GM step is unavoidable

`cs_transmog.cpp:285-315`: `.transmog portable` is gated behind *both*
`IsPortableNPCEnabled` **and** `IsTransmogPlusEnabled`, then a per-player
subscription eligibility check. The full player command table
(`cs_transmog.cpp:43-54`) contains no other command that opens the UI — the NPC
gossip script is the only interface.

So the NPC must be spawned in-game, once, by a GM:

```
.npc add 190010
```

It cannot be done over SOAP (the command needs a player position), so it does not
belong in `ac-admin-ui` or `admin.sh`. It goes in the README beside the other
one-time steps. Spawn one per capital.

### Settings

Relaxed for kids — the point is looking how they want, not economy design:

- `IgnoreReqClass`, `IgnoreReqRace`, `IgnoreReqLevel`, `IgnoreReqSkill`,
  `IgnoreReqSpell`, `IgnoreReqStats` → `1`
- `AllowMixedArmorTypes` → `1`
- `AllowLegendary` → `1`
- `EnablePlus` stays `0` (it is a subscription/monetisation system)

`CopperCost = 0` and `RequireToken = 0` are already upstream defaults.

### Its SQL is safe

Transmog ships SQL in `data/sql/db-{world,characters,auth}/`.
`UpdateFetcher.cpp:165-186` scans the immediate subdirectories of a module's
`data/sql/` and keeps those whose name *contains* the DB module name — `world`,
`characters`, `auth` (`DBUpdater.cpp:100-180`). `db-world` matches `world`, and
files below it are then collected recursively (`FillFileListRecursively`,
`UpdateFetcher.cpp:73-104`).

No filename collides with a core update, so the `Duplicate filename` fatal abort
documented in `CLAUDE.md` does not recur here.

**One upstream wart to document and not chase:** `data/sql/updates/world/` does
not match the substring filter, so `2026_05_09_transmog_set_disclaimer.sql` is
silently never applied. It is a cosmetic string. Note it; do not work around it.

---

## Part 4 — Spanish proper nouns

### Why this cannot be configuration

`get_language_rule()` (`tools/chatter_shared.py:1288-1312`) emits:

> Exception: keep WoW proper nouns (zone, subzone, creature, NPC, item, spell,
> quest, and character names) in English exactly as written — never translate
> them.

It is a fixed f-string whose only variable is `_language`, and `_language` can
only ever be one of seven hard-coded labels or `""` (`chatter_shared.py:1214-1273`).
A full read of the module confirmed every alternative is closed:

| Avenue | Result |
|---|---|
| Config key injecting prompt text | None. Every prompt-affecting key is a percent-chance gating a hard-coded English block |
| Crafted `LLMChatter.Language` value | Unknown codes resolve to `""` and emit *no rule at all* — asserted by upstream's own `test_language_prompt_routing.py:106-124` |
| Plugin / auto-imported `custom_*.py` / env module swap | None. Sole `importlib` use is a fixed internal registry |
| Data-driven post-processing | `cleanup_message()` is entirely hard-coded regex; no replacement table |
| REST/config endpoint on the bridge | None. `requirements.txt` has no web framework; the bridge's only CLI surface is `--config` |
| DB-seeded prompt content | Per-bot flavor only; the zone/spell paths are a hard-coded dict and `spell_dbc.Name_Lang_enUS` |
| Mountable data file | `tools/subzone_lore.json` is genuinely loaded and reaches prompts — but covers subzone flavor only. **Out of scope** |

Upstream's README, explaining how to add a language, says to edit
`chatter_shared.py`. The negative is confirmed, not assumed.

### The change

The clause is defined **once** and injected into both the system and user prompts
by existing call sites (`chatter_shared.py:1470`, `:1484`), so editing the one
function covers both. No caller needs touching.

It runs inside the bridge image, immediately after `COPY tools/ /app/` in
`docker/llm-chatter-bridge.Dockerfile`. That placement matters: the bridge's
build context is the *module* directory, so a patch file living in `docker/`
would be unreachable by `COPY` — operating on the already-copied file sidesteps
the constraint entirely and leaves `build-and-push.sh` untouched by this part.

Requires `# syntax=docker/dockerfile:1.7` at the top of that Dockerfile for
heredoc support. The repo already requires buildx.

New text:

> Use the official Spanish (esES) WoW names for zones, subzones, creatures, NPCs,
> items, spells and quests — Stormwind is Ventormenta, Eversong Woods is Bosque
> de la Canción Eterna. If you are not sure of the official Spanish name, keep
> the English one. NEVER translate player character, bot or guild names — write
> those exactly as given.

### Why a targeted replace, not `git apply`

A `.patch` carries context lines and breaks on *any* upstream edit near the
function. A string replacement keyed on the clause itself breaks only when the
clause changes — which is exactly the condition under which a human should look.

The failure mode is the design point. A silent no-op ships English names and
nobody finds out until a kid asks why the bot said "Stormwind", so the
replacement asserts its target exists and exits non-zero when it does not,
failing the build loudly.

### Verification

```bash
docker run --rm --entrypoint python <bridge-image> -c \
  "import chatter_shared as c; c.set_language('ES'); print(c.get_language_rule())"
```

Must print the Spanish-names clause. This is a real command, run before claiming
the change works.

---

## Config plumbing

Both modules' keys go through `ini2env.py`. Generated names, verified with
`--key` rather than written by hand, per `CLAUDE.md`:

```
AutoBalance.Enable.Global                → AC_AUTO_BALANCE_ENABLE_GLOBAL
AutoBalance.StatModifier.Global          → AC_AUTO_BALANCE_STAT_MODIFIER_GLOBAL
AutoBalance.Enable.5M                    → AC_AUTO_BALANCE_ENABLE_5_M
AutoBalance.InflectionPointRaid10M.…     → AC_AUTO_BALANCE_INFLECTION_POINT_RAID_10_M_CURVE_FLOOR
AutoBalance.playerCountDifficultyOffset  → AC_AUTO_BALANCE_PLAYER_COUNT_DIFFICULTY_OFFSET
Transmogrification.AllowMixedArmorTypes  → AC_TRANSMOGRIFICATION_ALLOW_MIXED_ARMOR_TYPES
```

The digit-boundary cases (`5M` → `5_M`, `Raid10M` → `RAID_10_M`) are exactly what
`ini2env.py` exists for. Add `AutoBalance.Enable.5M`,
`AutoBalance.InflectionPointRaid10M.CurveFloor`,
`AutoBalance.playerCountDifficultyOffset` and
`Transmogrification.AllowMixedArmorTypes` to `SELFTESTS`
(`scripts/ini2env.py:61-74`), taking it from 9 to 13 cases.

## Documentation changes

Two documents currently assert the opposite of Part 4 and must be **rewritten,
not appended to**:

- The `SPANISH` block in `llm-chatter-settings.conf`, which tells the reader
  English proper nouns are correct behaviour and to "live with it".
- The *"Server data files must stay enUS"* invariant in `CLAUDE.md`.

The enUS half of that invariant remains true and load-bearing: server data stays
enUS because playerbots' spell logic matches English spell names. Only the
"therefore don't translate proper nouns in chat" conclusion changes, and the
reason is worth recording — the kids' clients are esES, so Spanish names in bot
chat now *match* what is on screen, and nothing about server data moves.

Also needs updating: `README.md` (build/versioning workflow, the `.npc add
190010` step, the two new modules), `.env.example` (`IMAGE_TAG`,
`CLIENT_DATA_TAG`), and the `CLAUDE.md` architecture section (five images built
from pinned refs; two new compiled-in modules).

## Out of scope

- **`chatter_log_viewer.py`.** The module ships a stdlib web log viewer that
  would be a far better audit surface than `docker exec … tail -f`, and it fits
  the tailnet-only `ac-admin-ui` pattern. But it exposes `POST /api/clear-logs`,
  which erases the exact trail `CLAUDE.md` calls the control that makes an LLM
  acceptable here. If wanted, it is a separate task with that route blocked.
- Localising `subzone_lore.json`.
- Any change to `DBC.Locale`, server data files, or world-DB `*_locale` tables.
- Upstream's unapplied `data/sql/updates/world/` file.

## Risks

| Risk | Mitigation |
|---|---|
| Haiku invents esES names for obscure NPCs | Prompt instructs "if unsure, keep the English one"; `LLMChatter.RequestLog` is the check |
| Bot/player names get translated | Explicit NEVER clause; verified by reading the request log for the first week |
| Upstream moves `get_language_rule()` | Replacement asserts and fails the build |
| Two new modules break the compile | Pinned refs; add and rebuild one at a time if the first build fails |
| Core moves forward at the same time | Core pin also moves in this change — first boot after deploy needs watching |
| Transmog NPC never spawned | Feature silently absent; README step + post-deploy check |

## Cost

All three modules are compiled into the worldserver, so this is a full rebuild:
40-90 minutes on the build machine, ~8 GB RAM. Afterwards, every AutoBalance and
Transmog setting is runtime-only — `family-settings.ini`, regenerate, redeploy,
or `.reload config` over SOAP.
