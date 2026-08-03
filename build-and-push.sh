#!/usr/bin/env bash
#
# Build AzerothCore + mod-playerbots into Docker images.
#
# There is no maintained prebuilt playerbots image (see README), so we compile
# once here and hand finished images to Dokploy. Dokploy never compiles anything.
#
#   ./build-and-push.sh               build locally, tag as azeroth-family/*
#   ./build-and-push.sh --push        also push to $REGISTRY (needs docker login)
#   ./build-and-push.sh --update      report pinned refs vs upstream heads, then exit
#   ./build-and-push.sh --fetch-only  fetch + checkout the pinned refs, then exit (no build)
#   ./build-and-push.sh --no-latest   stop publishing the `latest` alias
#
# First build: 40-90 min and it wants ~8 GB RAM free. Later builds reuse ccache
# and are much faster.

set -euo pipefail

# ---------------------------------------------------------------- configuration

# Where to push. Leave empty if Dokploy runs on THIS machine -- then the images
# are already in the local Docker daemon and no registry is involved at all.
#   e.g. REGISTRY=ghcr.io/oskar-flores
REGISTRY="${REGISTRY:-}"

# Pinned by commit, not by branch. A branch head is whatever GitHub served that
# morning; a SHA is a version you can put in a Dokploy env var and roll back to.
# The *_BRANCH values are only used by --update, to report what the pins would
# become.
CORE_REPO="https://github.com/mod-playerbots/azerothcore-wotlk.git"
CORE_BRANCH="Playerbot"
CORE_REF="190184a04539937a617bf033e39378196c0c63f5"

MODULE_REPO="https://github.com/mod-playerbots/mod-playerbots.git"
MODULE_BRANCH="master"
MODULE_REF="ba46fcdecde3d0c6c2f244fcb3ea862430b6ae5b"

# The sha is the identity; the date is a build stamp. Passing TAG= explicitly
# reproduces any earlier build from the same pins.
TAG="${TAG:-$(date +%Y.%m.%d)-${CORE_REF:0:7}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SRC_DIR:-$SCRIPT_DIR/src}"

# Extra modules, one "name|url|branch|ref" per line. All of these get compiled
# in. Each one you add is another thing that can break the build -- add them one
# at a time and rebuild in between.
EXTRA_MODULES=(
  # LLM-driven bot chat. Replaces playerbots' built-in chat with generated
  # dialogue in Spanish. The C++ half compiles in here; the Python half runs
  # as the separate ac-llm-chatter-bridge image built at the end of this
  # script. Provider (Anthropic now, local Ollama later) is a runtime setting
  # in llm-chatter-settings.conf -- switching does NOT need another build.
  "mod-llm-chatter|https://github.com/Hokken/mod-llm-chatter.git|master|97274f8106c33bff3a1c9a8f13944920598921fb"
  # Scales dungeon mobs and bosses to group size. No SQL, config only.
  # Pinned to a master commit rather than upstream's own `stable` tag on
  # purpose: that tag is 5d2778e and predates the core commit AutoBalance's
  # README states as its minimum, so `stable` is the riskier choice against a
  # current core, not the safer one.
  "mod-autobalance|https://github.com/azerothcore/mod-autobalance.git|master|73d4ad3c379fbfc35c63b5b9b44fba1f7d9e213d"
  # Cosmetic gear appearance. Ships SQL under data/sql/db-{world,characters,
  # auth}/, which dbimport picks up from modules/ -- do NOT stage it anywhere.
  "mod-transmog|https://github.com/azerothcore/mod-transmog.git|master|0d85cbc53d63ce2df8527169ce6ae47f5f6f6ba8"
  # Server half of the MultiBot addon: answers structured MBOT addon messages so
  # the addon can drive bots through a UI instead of parsing localized bot chat
  # -- which is the point here, the kids' clients being esES. Requires
  # mod-playerbots and no SQL. Note `main`, not `master`. It does nothing on its
  # own: the client addon that drives it is deliberately not shipped from this
  # repo. It also includes playerbots internals directly (PlayerbotAI.h,
  # AiObjectContext.h, BudgetValues.h), so it is the module most likely to break
  # when the playerbots pin moves.
  "mod-multibot-bridge|https://github.com/Wishmaster117/mod-multibot-bridge.git|main|fba3d2464fc9d36d50b3176535e5881c231449f6"
)

# A container found running on the host should be traceable to its sources
# without consulting the registry or this script's git history. Defined here,
# right after EXTRA_MODULES, and assigned immediately below so PINS exists
# before the --fetch-only exit further down uses it -- not down by the other
# publish helpers, where it would be defined too late under set -u.
pin_labels() {
  local pins="core=${CORE_REF:0:7},playerbots=${MODULE_REF:0:7}"
  if (( ${#EXTRA_MODULES[@]} )); then
    local spec name url branch ref
    for spec in "${EXTRA_MODULES[@]}"; do
      IFS='|' read -r name url branch ref <<<"$spec"
      pins="$pins,$name=${ref:0:7}"
    done
  fi
  printf '%s' "$pins"
}
PINS="$(pin_labels)"

CORE_DIR="$SRC_DIR/azerothcore-wotlk"

DO_PUSH=0
DO_UPDATE=0
DO_FETCH_ONLY=0
DO_LATEST=1
for arg in "$@"; do
  case "$arg" in
    --push)       DO_PUSH=1 ;;
    --update)     DO_UPDATE=1 ;;
    --fetch-only) DO_FETCH_ONLY=1 ;;
    --no-latest)  DO_LATEST=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

# Every build also publishes `latest`. docker-compose.yml still defaults to
# ${IMAGE_TAG:-latest} in six places and the Dokploy blueprint hard-codes
# image_tag = "latest", so dropping it would break the running deploy the
# moment this script is used. Pass --no-latest once IMAGE_TAG is set in
# Dokploy and the alias is dead weight.

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

# Everything about --push is checked HERE, before the 40-90 minute compile.
# These used to live inside build_target, which meant a missing REGISTRY was
# reported after the longest build in the script had already finished.
if (( DO_PUSH )); then
  [[ -n "$REGISTRY" ]] \
    || die "--push needs REGISTRY, e.g. REGISTRY=ghcr.io/oskar-flores ./build-and-push.sh --push"

  # Not being logged in wastes exactly as much time. Only a warning: credential
  # helpers keep auths out of config.json, so absence here is not proof.
  registry_host="${REGISTRY%%/*}"
  if [[ -r "$HOME/.docker/config.json" ]] \
     && ! grep -q "\"$registry_host\"" "$HOME/.docker/config.json"; then
    warn "no stored credentials for $registry_host -- if the push fails, run: docker login $registry_host"
  fi
fi

# ---------------------------------------------------------------- fetch sources

# A pin is a commit SHA, and `git clone --branch` does not accept one. So this
# is init + fetch + checkout instead of clone. GitHub serves any reachable SHA
# to a --depth 1 fetch, so it costs the same as the old shallow clone.
#
# `clean -fd` deliberately has no -x: gitignored files must survive, because the
# stale data/sql/custom check further down is what catches them, and it needs
# them to still be there to report.
fetch_pinned() {
  local dir="$1" url="$2" ref="$3"
  local name; name=$(basename "$dir")

  if [[ ! -d "$dir/.git" ]]; then
    log "Initialising $name"
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" remote add origin "$url"
  fi

  # Refs are always full 40-char SHAs by construction, so this is an exact
  # match, not really a prefix match -- no ambiguity, no collision risk. A ref
  # given as a tag name never matches, so it re-fetches every run -- correct,
  # just not free.
  local head
  head=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo "none")
  if [[ "$head" == "$ref"* ]]; then
    echo "    $name already at $ref"
    return
  fi

  log "Fetching $name @ $ref"
  git -C "$dir" fetch --depth 1 origin "$ref"
  git -C "$dir" checkout -q --detach FETCH_HEAD
  git -C "$dir" clean -qfd
}

# --update no longer moves anything. It reports what the pins WOULD become, so
# a version bump is a commit you can see in a diff rather than a side effect of
# having run the build on a Tuesday.
report_updates() {
  local name url branch pinned head stale=0
  log "Pinned refs vs upstream heads"

  local extra=""
  if (( ${#EXTRA_MODULES[@]} )); then
    extra=$(printf '%s\n' "${EXTRA_MODULES[@]}")
  fi

  while IFS='|' read -r name url branch pinned; do
    [[ -n "$name" ]] || continue
    head=$(git ls-remote "$url" "refs/heads/$branch" | cut -f1)
    [[ -n "$head" ]] || die "could not read $branch from $url"
    if [[ "$head" == "$pinned"* ]]; then
      printf '    %-19s %-41s up to date\n' "$name" "$pinned"
    else
      printf '    %-19s %-41s -> %s\n' "$name" "$pinned" "${head:0:7}"
      stale=1
    fi
  done <<EOF
azerothcore-wotlk|$CORE_REPO|$CORE_BRANCH|$CORE_REF
mod-playerbots|$MODULE_REPO|$MODULE_BRANCH|$MODULE_REF
$extra
EOF

  if (( stale )); then
    cat <<'MSG'

Nothing was changed. To take these, edit the *_REF values at the top of this
script, commit them, and rebuild. Core and mod-playerbots move TOGETHER --
mixing versions gives compile errors or runtime crashes.
MSG
  else
    echo "    all pins current"
  fi
  exit 0
}

(( DO_UPDATE )) && report_updates

mkdir -p "$SRC_DIR"

# The core MUST be the playerbots fork. Building mod-playerbots against upstream
# azerothcore produces hundreds of compile errors -- it is the #1 install mistake.
fetch_pinned "$CORE_DIR" "$CORE_REPO" "$CORE_REF"
fetch_pinned "$CORE_DIR/modules/mod-playerbots" "$MODULE_REPO" "$MODULE_REF"

# The length check is not optional: on bash 3.2 (the macOS system bash, which is
# what `env bash` finds here) expanding an empty array under `set -u` is an
# "unbound variable" error, not an empty expansion.
if (( ${#EXTRA_MODULES[@]} )); then
  for spec in "${EXTRA_MODULES[@]}"; do
    IFS='|' read -r name url branch ref <<<"$spec"
    fetch_pinned "$CORE_DIR/modules/$name" "$url" "$ref"
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

# Deleting the staging block was not enough to stop it recurring. The core's
# .gitignore has `/data/sql/custom/*`, so files a pre-2dc2bb6 run copied there
# are *ignored*, not merely untracked: `git reset --hard` leaves them and so does
# a plain `git clean -fd`. They survive every --update, get COPYed into every
# image, and the import keeps aborting long after this script stopped creating
# them. `ls-files --others` (deliberately without --exclude-standard) is what
# sees them; the tracked README.md and .dummy files stay hidden.
stale_custom=$(git -C "$CORE_DIR" ls-files --others -- data/sql/custom)
if [[ -n "$stale_custom" ]]; then
  printf '%s\n' "$stale_custom" >&2
  die "staged module SQL in data/sql/custom/ (listed above). dbimport would see each
    of those filenames twice -- once there, once under modules/ -- and abort the
    import. Remove them, then rebuild:
      git -C \"$CORE_DIR\" clean -fdx data/sql/custom"
fi

# This is the schema for acore_playerbots specifically. Missing it is the real
# cause of 'Unknown database acore_playerbots' on first boot.
[[ -d "$CORE_DIR/modules/mod-playerbots/data/sql/playerbots/base" ]] \
  || die "mod-playerbots is missing data/sql/playerbots/base -- the acore_playerbots schema will not be created"

if (( DO_FETCH_ONLY )); then
  log "Fetched sources only (--fetch-only); nothing built"
  echo "    tag that a build would produce: $TAG"
  echo "    pins: $PINS"
  exit 0
fi

# ------------------------------------------------------------------- build images

# `docker push` exiting 0 is not proof the registry now serves what was just
# built, and the build machine gives you no hint either way: `docker images`
# lists the registry-qualified tag whether or not --push was passed, because
# REGISTRY controls the *tag*, not the push. That is how a fixed db-import image
# sat on the builder while Dokploy kept pulling the broken one, costing a full
# redeploy cycle to notice. Compare the digests instead of trusting the exit code.
#
# --insecure is needed for a plain-HTTP LAN registry and is harmless against a
# TLS one (checked against docker.io). Reads the top-level Descriptor, which is
# correct for the single-arch images this script builds; for a manifest *list*
# it would report the first platform instead of the index.
verify_push() {
  local image="$1"
  local local_digest remote_digest

  local_digest=$(docker image inspect "$image" \
      --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    | awk -F@ -v repo="${image%:*}" '$1 == repo { print $2; exit }')

  remote_digest=$(docker manifest inspect --insecure --verbose "$image" 2>/dev/null \
    | awk '/"Descriptor"/ { seen = 1 } seen && /"digest"/ { gsub(/[",]/, ""); print $2; exit }')

  [[ -n "$remote_digest" ]] \
    || die "pushed $image but the registry serves no manifest for that tag"

  [[ "$local_digest" == "$remote_digest" ]] \
    || die "$image was pushed but the registry still serves a different image.
      local:    ${local_digest:-<none>}
      registry: $remote_digest
    Re-run the push, or look for a caching proxy in front of the registry."

  echo "    verified in registry: $remote_digest"
}

push_and_verify() {
  local image="$1"
  log "Pushing $image"
  docker push "$image"
  verify_push "$image"
}

# Tag the alias regardless of --push so a local-daemon Dokploy (no registry at
# all) also keeps working.
publish() {
  local image="$1"
  (( DO_PUSH )) && push_and_verify "$image"
  if (( DO_LATEST )); then
    local alias="${image%:*}:latest"
    docker tag "$image" "$alias"
    (( DO_PUSH )) && push_and_verify "$alias"
  fi
  return 0
}

build_target() {
  local target="$1" name="$2"
  local image="azeroth-family/$name:$TAG"
  [[ -n "$REGISTRY" ]] && image="$REGISTRY/$name:$TAG"

  # org.opencontainers.image.revision is deliberately the full CORE_REF, not a
  # short SHA: the OCI spec's convention for source-control-revision is full
  # length, and that is the one field where precision matters more than
  # readability. Short SHAs are what family.pins is for.
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
    --label "org.opencontainers.image.revision=$CORE_REF" \
    --label "org.opencontainers.image.version=$TAG" \
    --label "family.pins=$PINS" \
    "$CORE_DIR"

  publish "$image"
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

  # See build_target: revision stays the full CORE_REF on purpose, unlike the
  # short SHAs in family.pins.
  log "Building $image"
  DOCKER_BUILDKIT=1 docker build \
    --file "$dockerfile" \
    --tag "$image" \
    --label "org.opencontainers.image.revision=$CORE_REF" \
    --label "org.opencontainers.image.version=$TAG" \
    --label "family.pins=$PINS" \
    "$mod_dir"

  publish "$image"
}

# ------------------------------------------------------------- admin ui

# The web console. Like the bridge this is an npm ci, seconds not hours, and it
# has nothing to do with the core's Dockerfile.
build_admin_ui() {
  local app_dir="$SCRIPT_DIR/admin-ui"
  local dockerfile="$SCRIPT_DIR/docker/admin-ui.Dockerfile"
  local image="azeroth-family/admin-ui:$TAG"
  [[ -n "$REGISTRY" ]] && image="$REGISTRY/admin-ui:$TAG"

  [[ -d "$app_dir" ]] || die "missing $app_dir"
  [[ -f "$dockerfile" ]] || die "missing $dockerfile"

  # See build_target: revision stays the full CORE_REF on purpose, unlike the
  # short SHAs in family.pins.
  log "Building $image"
  DOCKER_BUILDKIT=1 docker build \
    --file "$dockerfile" \
    --tag "$image" \
    --label "org.opencontainers.image.revision=$CORE_REF" \
    --label "org.opencontainers.image.version=$TAG" \
    --label "family.pins=$PINS" \
    "$app_dir"

  publish "$image"
}

build_bridge
build_admin_ui

log "Done"
prefix=$( [[ -n "$REGISTRY" ]] && echo "$REGISTRY" || echo "azeroth-family" )
cat <<EOF

Images built ($TAG):
  $prefix/worldserver:$TAG
  $prefix/authserver:$TAG
  $prefix/db-import:$TAG
  $prefix/llm-chatter-bridge:$TAG
  $prefix/admin-ui:$TAG
$( (( DO_LATEST )) && echo "
Also tagged :latest, so an existing deploy keeps working untouched." )

Pins: $PINS

Next: in Dokploy > Environment, set

  IMAGE_PREFIX=$prefix
  IMAGE_TAG=$TAG

then redeploy. Leaving IMAGE_TAG unset keeps pulling :latest, which still
works but is not rollback-able.

Also set ANTHROPIC_API_KEY -- the bridge refuses to start without it.
EOF
