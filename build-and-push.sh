#!/usr/bin/env bash
#
# Build AzerothCore + mod-playerbots into Docker images.
#
# There is no maintained prebuilt playerbots image (see README), so we compile
# once here and hand finished images to Dokploy. Dokploy never compiles anything.
#
#   ./build-and-push.sh              build locally, tag as azeroth-family/*
#   ./build-and-push.sh --push       also push to $REGISTRY
#   ./build-and-push.sh --update     git pull core + module first, then build
#
# First build: 40-90 min and it wants ~8 GB RAM free. Later builds reuse ccache
# and are much faster.

set -euo pipefail

# ---------------------------------------------------------------- configuration

# Where to push. Leave empty if Dokploy runs on THIS machine -- then the images
# are already in the local Docker daemon and no registry is involved at all.
#   e.g. REGISTRY=ghcr.io/oskarflores
REGISTRY="${REGISTRY:-}"

TAG="${TAG:-latest}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SRC_DIR:-$SCRIPT_DIR/src}"

CORE_REPO="https://github.com/mod-playerbots/azerothcore-wotlk.git"
CORE_BRANCH="Playerbot"
MODULE_REPO="https://github.com/mod-playerbots/mod-playerbots.git"
MODULE_BRANCH="master"

# Extra modules, one "name|url|branch" per line. All of these get compiled in.
# Each one you add is another thing that can break the build -- add them one at
# a time and rebuild in between.
EXTRA_MODULES=(
  # LLM-driven bot chat. Replaces playerbots' built-in chat with generated
  # dialogue in Spanish. The C++ half compiles in here; the Python half runs
  # as the separate ac-llm-chatter-bridge image built at the end of this
  # script. Provider (Anthropic now, local Ollama later) is a runtime setting
  # in llm-chatter-settings.conf -- switching does NOT need another build.
  "mod-llm-chatter|https://github.com/Hokken/mod-llm-chatter.git|master"
  # "mod-aoe-loot|https://github.com/azerothcore/mod-aoe-loot.git|master"
  # "mod-learn-spells|https://github.com/noisiver/mod-learn-spells.git|master"
  # "mod-fireworks-on-level|https://github.com/azerothcore/mod-fireworks-on-level.git|master"
)

CORE_DIR="$SRC_DIR/azerothcore-wotlk"

DO_PUSH=0
DO_UPDATE=0
for arg in "$@"; do
  case "$arg" in
    --push)   DO_PUSH=1 ;;
    --update) DO_UPDATE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m !! %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------- preflight

command -v git >/dev/null    || die "git is not installed"
command -v docker >/dev/null || die "docker is not installed"
docker buildx version >/dev/null 2>&1 \
  || die "docker buildx is required (the core Dockerfile uses BuildKit mounts)"

# The build wants real memory. Warn early rather than dying at 80% through.
if [[ -r /proc/meminfo ]]; then
  mem_gb=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo)
  (( mem_gb >= 8 )) || warn "only ${mem_gb} GB RAM detected; the C++ build may OOM. Consider lowering parallelism."
fi

# ---------------------------------------------------------------- fetch sources

clone_or_update() {
  local dir="$1" url="$2" branch="$3"
  if [[ -d "$dir/.git" ]]; then
    if (( DO_UPDATE )); then
      log "Updating $(basename "$dir")"
      git -C "$dir" fetch --depth 1 origin "$branch"
      git -C "$dir" reset --hard "origin/$branch"
    else
      echo "    $(basename "$dir") already present (use --update to pull)"
    fi
  else
    log "Cloning $(basename "$dir") [$branch]"
    git clone --depth 1 --branch "$branch" "$url" "$dir"
  fi
}

mkdir -p "$SRC_DIR"

# The core MUST be the playerbots fork. Building mod-playerbots against upstream
# azerothcore produces hundreds of compile errors -- it is the #1 install mistake.
clone_or_update "$CORE_DIR" "$CORE_REPO" "$CORE_BRANCH"
clone_or_update "$CORE_DIR/modules/mod-playerbots" "$MODULE_REPO" "$MODULE_BRANCH"

# The length check is not optional: on bash 3.2 (the macOS system bash, which is
# what `env bash` finds here) expanding an empty array under `set -u` is an
# "unbound variable" error, not an empty expansion.
if (( ${#EXTRA_MODULES[@]} )); then
  for spec in "${EXTRA_MODULES[@]}"; do
    IFS='|' read -r name url branch <<<"$spec"
    clone_or_update "$CORE_DIR/modules/$name" "$url" "$branch"
  done
fi

# Sanity check: are we really on the fork?
origin_url=$(git -C "$CORE_DIR" remote get-url origin)
[[ "$origin_url" == *"mod-playerbots/azerothcore-wotlk"* ]] \
  || die "core at $CORE_DIR points at $origin_url -- it must be the mod-playerbots fork"

# ------------------------------------------------------------ verify module SQL

# Do NOT copy module SQL into data/sql/custom/. dbimport already finds it in
# modules/<mod>/data/sql/ (Updates.AllowedModules=all resolves to the compiled-in
# AC_MODULES_LIST), and data/sql/custom/db_* is itself a seeded include dir. A
# copy in both places is the same filename twice, and UpdateFetcher dedupes on
# filename alone -- it logs "Duplicate filename" and aborts the whole import.
log "Checking module SQL"
for base in "$CORE_DIR/modules"/*/; do
  [[ -d "$base" ]] || continue
  mod=$(basename "$base")
  [[ -d "$base/data/sql" ]] || continue
  n=$(find "$base/data/sql" -name '*.sql' | wc -l | tr -d ' ')
  echo "    $mod: $n SQL file(s) (applied by dbimport from modules/)"
done

# This is the schema for acore_playerbots specifically. Missing it is the real
# cause of 'Unknown database acore_playerbots' on first boot.
[[ -d "$CORE_DIR/modules/mod-playerbots/data/sql/playerbots/base" ]] \
  || die "mod-playerbots is missing data/sql/playerbots/base -- the acore_playerbots schema will not be created"

# ------------------------------------------------------------------- build images

build_target() {
  local target="$1" name="$2"
  local image="azeroth-family/$name:$TAG"
  [[ -n "$REGISTRY" ]] && image="$REGISTRY/$name:$TAG"

  log "Building $image  (target: $target)"
  DOCKER_BUILDKIT=1 docker build \
    --file "$CORE_DIR/apps/docker/Dockerfile" \
    --target "$target" \
    --tag "$image" \
    --build-arg CWITH_WARNINGS=OFF \
    --build-arg DOCKER_USER="${DOCKER_USER_NAME:-acore}" \
    --build-arg USER_ID="${DOCKER_USER_ID:-1000}" \
    --build-arg GROUP_ID="${DOCKER_GROUP_ID:-1000}" \
    --build-arg TZ="${TZ:-Europe/Madrid}" \
    "$CORE_DIR"

  if (( DO_PUSH )); then
    [[ -n "$REGISTRY" ]] || die "--push needs REGISTRY to be set"
    log "Pushing $image"
    docker push "$image"
  fi
  echo "$image"
}

# All three come out of the same compile stage, so this is one build, not three.
build_target worldserver worldserver
build_target authserver  authserver
build_target db-import   db-import

# ------------------------------------------------------- llm-chatter bridge

# Not part of the core Dockerfile: this is the module's Python half, which
# upstream expects you to run from a bind-mounted source tree. Dokploy has no
# source tree, so it gets its own image. Seconds to build, not hours -- it is
# a pip install, no compilation.
build_bridge() {
  local mod_dir="$CORE_DIR/modules/mod-llm-chatter"
  local dockerfile="$SCRIPT_DIR/docker/llm-chatter-bridge.Dockerfile"
  local image="azeroth-family/llm-chatter-bridge:$TAG"
  [[ -n "$REGISTRY" ]] && image="$REGISTRY/llm-chatter-bridge:$TAG"

  [[ -d "$mod_dir" ]] || die "mod-llm-chatter is not cloned -- is it still in EXTRA_MODULES?"
  [[ -f "$dockerfile" ]] || die "missing $dockerfile"

  log "Building $image"
  DOCKER_BUILDKIT=1 docker build \
    --file "$dockerfile" \
    --tag "$image" \
    "$mod_dir"

  if (( DO_PUSH )); then
    [[ -n "$REGISTRY" ]] || die "--push needs REGISTRY to be set"
    log "Pushing $image"
    docker push "$image"
  fi
}

build_bridge

log "Done"
cat <<EOF

Images built:
  $( [[ -n "$REGISTRY" ]] && echo "$REGISTRY" || echo "azeroth-family" )/worldserver:$TAG
  $( [[ -n "$REGISTRY" ]] && echo "$REGISTRY" || echo "azeroth-family" )/authserver:$TAG
  $( [[ -n "$REGISTRY" ]] && echo "$REGISTRY" || echo "azeroth-family" )/db-import:$TAG
  $( [[ -n "$REGISTRY" ]] && echo "$REGISTRY" || echo "azeroth-family" )/llm-chatter-bridge:$TAG

Next: set IMAGE_PREFIX and IMAGE_TAG in Dokploy's environment to match, then deploy.
Also set ANTHROPIC_API_KEY -- the bridge refuses to start without it.
EOF
