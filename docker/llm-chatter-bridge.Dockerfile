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
# a rebuild picks up whatever the module currently expects.
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

# Secrets are assembled here rather than baked in. parse_config() in
# chatter_shared.py is last-wins, so the order below is what makes the
# layering work:
#
#     upstream defaults  ->  our committed overrides  ->  secrets from env
#
# Nothing sensitive is ever written to an image layer or to git.
CMD ["sh", "-c", "\
set -e; \
[ -n \"$ANTHROPIC_API_KEY\" ] || { echo 'ANTHROPIC_API_KEY is not set -- add it in Dokploy > Environment' >&2; exit 1; }; \
[ -n \"$DB_ROOT_PASSWORD\" ] || { echo 'DB_ROOT_PASSWORD is not set' >&2; exit 1; }; \
[ -r /config/llm-chatter-settings.conf ] || { echo 'llm-chatter-settings.conf is not mounted at /config' >&2; exit 1; }; \
cat /defaults/mod_llm_chatter.conf.dist /config/llm-chatter-settings.conf > /tmp/mod_llm_chatter.conf; \
printf 'LLMChatter.Anthropic.ApiKey = %s\\n' \"$ANTHROPIC_API_KEY\" >> /tmp/mod_llm_chatter.conf; \
printf 'LLMChatter.Database.Password = %s\\n' \"$DB_ROOT_PASSWORD\" >> /tmp/mod_llm_chatter.conf; \
exec python llm_chatter_bridge.py --config /tmp/mod_llm_chatter.conf\
"]
