# Design: `mod-multibot-bridge` as a fifth compiled-in module

Date: 2026-08-03
Status: approved, implemented

## Problem

Managing playerbots means typing chat commands. The
[MultiBot-Chatless](https://github.com/Wishmaster117/MultiBot-Chatless) addon
replaces that with a real UI, but only against a server-side companion module,
[`mod-multibot-bridge`](https://github.com/Wishmaster117/mod-multibot-bridge),
which answers structured `MBOT GET~...` / `RUN~...` addon messages instead of
making the addon trigger bot commands and parse the chat replies.

That last part is why this module fits *this* realm specifically. The kids'
clients are esES, so the legacy approach — parse localised bot chat — was never
going to work here. A structured protocol sidesteps the language question
entirely.

Ask: compile the bridge in so the addon can be used later.

## Decisions

| Question | Decision |
| --- | --- |
| Should this repo ship or document the client addon? | **No.** Out of scope — the repo stays server-side only. |
| Where does the one config key live? | `family-settings.ini` → `family.env`. No mounted `.conf`. |
| `EnableConsoleLogs` value? | `0`. Silence is the steady state; flip to `1` only to debug. |
| Move the core / playerbots pins at the same time? | No. One new module per rebuild. |

## What the module actually is

Three files: `src/MultiBotBridge.cpp` (4445 lines),
`src/mod_multibot_bridge.cpp` (8 lines, just the script loader), and
`conf/MultiBotBridge.conf.dist` (one key). No SQL, no `CMakeLists.txt` — the
core's `modules/CMakeLists.txt` collects module sources itself, which is why
none of the four existing modules ships one either.

So `docker-compose.yml`, `ac-db-import`, `ac-module-sql-init`, `scripts/`,
`dokploy-template/` and `.env.example` are all untouched. The entire server-side
change is a pin and a config line.

### It grants no new authority

Every read and every `RUN~` endpoint is gated on the bot being in the
requester's group or the requester being the bot's master
(`MultiBotBridge.cpp:3666-3693`, `:3869-3879`). That is the same trust boundary
`mod-playerbots`' own chat commands already enforce. A gmlevel-0 kid gets a UI
for bots they could already command by typing — not new reach. Nothing here
touches the `SOAP_USER` / GM path.

## The two non-obvious parts

### 1. The config key is load-bearing, and looks like it isn't

The module reads `MultiBotBridge.EnableConsoleLogs` with a code default of
**`true`** (`MultiBotBridge.cpp:53`). Its `conf.dist` ships `0`. Those disagree,
and the `conf.dist` loses — because it is never read:

```
CMake:   installs  conf/MultiBotBridge.conf.dist  →  etc/modules/MultiBotBridge.conf.dist
CMake:   registers "MultiBotBridge.conf"          (modules/CMakeLists.txt:361 strips .dist)
Runtime: loads     etc/modules/MultiBotBridge.conf  ← nothing ever creates this
```

`Config.cpp` has no `.dist` fallback, so the file simply isn't found and the
code default wins. Left alone, every addon UI refresh writes RX/TX lines to the
worldserver console forever.

Setting it in `family-settings.ini` fixes this with no mount, because
`GetValueDefault` (`Config.cpp:601-620`) checks the environment *before* the
not-found branch — the `AC_*` var wins even when no config file exists at all.
The generated name is `AC_MULTI_BOT_BRIDGE_ENABLE_CONSOLE_LOGS`; the converter
splits `MultiBot` at the camelCase boundary, which is exactly the kind of name
that must not be hand-written.

This is why the module needs no mounted `.conf` even though `mod-llm-chatter`
does. `mod-llm-chatter`'s file exists because its *Python bridge* reads the same
file; this module has no second process.

### 2. Compile risk is the real risk

The bridge `#include`s playerbots internals directly — `PlayerbotAI.h`,
`Playerbots.h`, `RandomPlayerbotMgr.h`, `AiObjectContext.h`, `BudgetValues.h`,
`ChatHelper.h`. Its HEAD is `fba3d24` (2026-05-13); the pinned `mod-playerbots`
is `ba46fcd` (2026-07-31). A ~2.5 month gap against unstable internal APIs is
precisely the case `build-and-push.sh`'s own comment warns about — "add them one
at a time and rebuild in between".

Accepted rather than mitigated: the failure is loud, immediate, and cheap to
revert (delete one array entry). The alternative — rolling playerbots back to
suit an addon-support module — trades a real risk for a worse one.

**If the build fails inside `MultiBotBridge.cpp`, that is the finding.** Do not
patch the module, and do not move the playerbots pin backwards.

## Changes

1. `build-and-push.sh` — one `EXTRA_MODULES` entry, pinned to `fba3d24`, branch
   `main` (not `master`; the branch field feeds `--update`). `pin_labels()`
   picks it up automatically, so the `family.pins` image label gains
   `mod-multibot-bridge=fba3d24` with no further edit.
2. `family-settings.ini` — a `MULTIBOT BRIDGE` section setting
   `MultiBotBridge.EnableConsoleLogs = 0`, with the reasoning above inline so
   nobody deletes it as redundant. `family.env` regenerated and committed.
3. `README.md` / `CLAUDE.md` — module list, architecture paragraph, and three
   invariants: the config trap, the compile-risk edge on the playerbots pin, and
   "a silent bridge is not a broken build".

## Verification

`ini2env.py --selftest` and the drift check gate everything before a build.
Then `--fetch-only` and `--update` confirm the pin resolves without spending
40-90 minutes, and the full build is the real test.

Deployed, the pass condition is inverted from the usual: with
`EnableConsoleLogs = 0` there should be **no** `MBOT` traffic on the console.
End-to-end confirmation needs the client addon on a PC, which is out of scope
here — and until someone installs it, the module doing nothing visible is
correct behaviour, not a regression.
