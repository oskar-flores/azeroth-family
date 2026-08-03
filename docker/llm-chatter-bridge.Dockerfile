# syntax=docker/dockerfile:1.7
# =============================================================================
#  mod-llm-chatter Python bridge
# =============================================================================
#  Upstream tells you to run python:3.11-slim and bind-mount the module's
#  tools/ directory off the source tree. That works on a machine that has the
#  source. This host does not have one -- Dokploy only ever pulls images -- so
#  we bake the bridge into an image on the build machine instead, exactly like
#  the three server images.
#
#  Build context is the MODULE directory, not this repo:
#      docker build -f docker/llm-chatter-bridge.Dockerfile \
#                   src/azerothcore-wotlk/modules/mod-llm-chatter
#  build-and-push.sh does this for you.
# =============================================================================

FROM python:3.11-slim

# anthropic, openai, mysql-connector-python. Pinned by upstream's own file so
# a rebuild picks up whatever the module currently expects. The `openai`
# package is the one that matters for us -- OpenRouter is reached through its
# OpenAI-compatible client, not a library of its own.
COPY tools/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# The bridge itself: ~45 Python modules plus its data files.
COPY tools/ /app/

# --- Spanish proper nouns ----------------------------------------------------
# Upstream hard-codes "keep WoW proper nouns in English" into get_language_rule()
# in chatter_shared.py. There is no config key, data file, plugin hook, env var
# or endpoint that changes it -- the whole module was checked -- so the string is
# rewritten here.
#
# This runs on the already-COPYed file rather than as a patch applied to the
# checkout, because the build context is the MODULE directory: a .patch living
# in this repo's docker/ dir is not reachable by COPY. It also beats a diff on
# merit -- a patch carries context lines and breaks on any nearby upstream edit,
# whereas this breaks only when the clause itself changes, which is exactly when
# a human should look.
#
# The sys.exit is the load-bearing part. A silent no-op would ship English names
# and nobody would find out until a kid asked why the bot said "Stormwind".
RUN python3 <<'PY'
import pathlib, sys

p = pathlib.Path("/app/chatter_shared.py")
src = p.read_text(encoding="utf-8")

OLD = (
    '        "Exception: keep WoW proper nouns (zone, "\n'
    '        "subzone, creature, NPC, item, spell, quest, "\n'
    '        "and character names) in English exactly as "\n'
    '        "written — never translate them. Any prior "\n'
)
NEW = (
    '        "Use the official Spanish (esES) WoW names for "\n'
    '        "zones, subzones, creatures, NPCs, items, spells "\n'
    '        "and quests — Stormwind is Ventormenta, Eversong "\n'
    '        "Woods is Bosque de la Canción Eterna. If you are "\n'
    '        "not sure of the official Spanish name, keep the "\n'
    '        "English one. NEVER translate player character, "\n'
    '        "bot or guild names — write those exactly as "\n'
    '        "given. Any prior "\n'
)

if OLD not in src:
    sys.exit(
        "chatter_shared.py: the proper-noun clause was not found. Upstream "
        "changed get_language_rule() -- re-read it and update this block in "
        "docker/llm-chatter-bridge.Dockerfile. Refusing to ship English names "
        "silently."
    )

p.write_text(src.replace(OLD, NEW, 1), encoding="utf-8")
print("chatter_shared.py: proper-noun rule set to Spanish (esES) names")
PY

# The complete upstream config. We never edit it -- llm-chatter-settings.conf
# is layered on top at runtime, so upstream can add keys freely and we only
# have to state our own deltas.
COPY conf/mod_llm_chatter.conf.dist /defaults/mod_llm_chatter.conf.dist

WORKDIR /app
ENV PYTHONUNBUFFERED=1

# --- entrypoint --------------------------------------------------------------
# Secrets are assembled at start rather than baked in. parse_config() in
# chatter_shared.py is last-wins, so the order below is what makes the
# layering work:
#
#     upstream defaults  ->  our committed overrides  ->  secrets from env
#
# Nothing sensitive is ever written to an image layer or to git.
#
# This is a script rather than the one-line `CMD ["sh", "-c", ...]` it replaces
# because it now branches on the provider. Written by heredoc rather than
# COPYed for the same reason as the proper-noun patch above: the build context
# is the MODULE directory, so nothing in this repo's docker/ is reachable.
#
# WHY IT BRANCHES. Upstream's conf.dist ships non-empty PLACEHOLDER keys --
# 'sk-or-v1-xxxxx', 'sk-xxxxx', 'AIza-xxxxx' -- and the bridge's only guard is
# `if not api_key: sys.exit(1)`. A placeholder is truthy, so injecting the
# wrong provider's key gives a container that starts perfectly and then 401s on
# every single bot line, with the realm looking healthy the whole time. Tying
# the injection to the selected provider is what makes that unrepresentable.
#
# The payoff is that Anthropic <-> OpenRouter <-> Ollama is a config edit plus
# `docker restart ac-llm-chatter-bridge`, with no rebuild -- set both keys in
# Dokploy and only the one matching LLMChatter.Provider is ever written.
RUN cat > /usr/local/bin/bridge-entrypoint.sh <<'SH' && chmod +x /usr/local/bin/bridge-entrypoint.sh
#!/bin/sh
set -eu

fail() { echo "ac-llm-chatter-bridge: $*" >&2; exit 1; }

[ -n "${DB_ROOT_PASSWORD:-}" ] || fail "DB_ROOT_PASSWORD is not set"
[ -r /config/llm-chatter-settings.conf ] ||
  fail "llm-chatter-settings.conf is not mounted at /config"

CONF=/tmp/mod_llm_chatter.conf
cat /defaults/mod_llm_chatter.conf.dist /config/llm-chatter-settings.conf > "$CONF"

# Effective provider: last match wins, matching parse_config(). Anchoring at
# line start skips the commented-out examples in llm-chatter-settings.conf.
# Absent -> anthropic, which is what llm_chatter_bridge.py defaults to.
provider=$(
  grep -iE '^[[:space:]]*LLMChatter\.Provider[[:space:]]*=' "$CONF" |
    tail -1 | cut -d= -f2- | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'
)
[ -n "$provider" ] || provider=anthropic

case "$provider" in
  openrouter)
    [ -n "${OPENROUTER_API_KEY:-}" ] ||
      fail "LLMChatter.Provider is openrouter but OPENROUTER_API_KEY is not set -- add it in Dokploy > Environment"
    printf 'LLMChatter.OpenRouter.ApiKey = %s\n' "$OPENROUTER_API_KEY" >> "$CONF"
    ;;
  anthropic)
    [ -n "${ANTHROPIC_API_KEY:-}" ] ||
      fail "LLMChatter.Provider is anthropic but ANTHROPIC_API_KEY is not set -- add it in Dokploy > Environment"
    printf 'LLMChatter.Anthropic.ApiKey = %s\n' "$ANTHROPIC_API_KEY" >> "$CONF"
    ;;
  ollama)
    # Local inference, no key. LLMChatter.Ollama.BaseUrl must point at a host
    # this container can reach -- not localhost, which is the container itself.
    ;;
  *)
    fail "LLMChatter.Provider is '$provider', which this image cannot inject a key for.
Supported: openrouter, anthropic, ollama. The module also accepts openai and
google, but their conf.dist placeholder keys are non-empty, so the bridge would
start clean and then fail every request -- refusing instead. Add a case here and
the matching env var in docker-compose.yml if you need one of them."
    ;;
esac

printf 'LLMChatter.Database.Password = %s\n' "$DB_ROOT_PASSWORD" >> "$CONF"

echo "ac-llm-chatter-bridge: provider=$provider"
exec python llm_chatter_bridge.py --config "$CONF"
SH

CMD ["/usr/local/bin/bridge-entrypoint.sh"]
