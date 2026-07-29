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
