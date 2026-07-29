#!/usr/bin/env bash
#
# Day-to-day admin for the family realm. Run on the Docker host.
#
#   ./admin.sh account <user> <password>   create a login for a family member
#   ./admin.sh gm <user> <0-3>             set permission level (0 = player)
#   ./admin.sh list                        list accounts
#   ./admin.sh console                     attach to the world server console
#   ./admin.sh backup [dir]                dump the databases
#   ./admin.sh restore <file.sql.gz> <db>  restore one database from a dump
#   ./admin.sh status                      what is running, and the realm address
#
# Account names and passwords are case-insensitive and ASCII-only in 3.3.5a.
# Keep them short and typeable -- a 7-year-old has to enter this at a login screen.

set -euo pipefail

WORLD_CONTAINER="${WORLD_CONTAINER:-ac-worldserver}"
DB_CONTAINER="${DB_CONTAINER:-ac-database}"

die() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m== %s\033[0m\n' "$*"; }

running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

# The world server reads commands from stdin when attached. `docker attach` is
# interactive, so for scripted commands we write straight to the container's
# stdin via a socat-free trick: docker exec is not enough (the console lives in
# PID 1), so we use `docker attach` with a here-string and detach immediately.
send_console() {
  running "$WORLD_CONTAINER" || die "$WORLD_CONTAINER is not running"
  # --detach-keys makes sure we never leave the terminal wedged.
  printf '%s\n' "$1" | timeout 10 docker attach --detach-keys=ctrl-p,ctrl-q "$WORLD_CONTAINER" >/dev/null 2>&1 || true
  sleep 1
}

cmd_account() {
  local user="${1:?usage: admin.sh account <user> <password>}"
  local pass="${2:?usage: admin.sh account <user> <password>}"
  (( ${#pass} >= 4 )) || die "password must be at least 4 characters"
  send_console "account create $user $pass"
  ok "created account '$user' (if it already existed the console will say so -- check ./admin.sh console)"
}

cmd_gm() {
  local user="${1:?usage: admin.sh gm <user> <0-3>}"
  local level="${2:?usage: admin.sh gm <user> <0-3>}"
  [[ "$level" =~ ^[0-3]$ ]] || die "level must be 0-3 (0 = normal player, 3 = full admin)"
  send_console "account set gmlevel $user $level -1"
  ok "set $user to gm level $level"
  [[ "$level" != "0" ]] && echo "   note: keep kids' accounts at 0. GM commands can delete characters."
}

cmd_list() {
  running "$DB_CONTAINER" || die "$DB_CONTAINER is not running"
  docker exec -i "$DB_CONTAINER" sh -c \
    'mysql -u root -p"$MYSQL_ROOT_PASSWORD" acore_auth -e "SELECT id, username, last_login FROM account ORDER BY id;"'
}

cmd_console() {
  running "$WORLD_CONTAINER" || die "$WORLD_CONTAINER is not running"
  cat <<'EOF'
Attaching to the world server console.
  Useful:  account create <user> <pass>
           account set gmlevel <user> 3 -1
           server info
  Detach with  Ctrl-P  then  Ctrl-Q   <-- NOT Ctrl-C, that shuts the realm down.
EOF
  read -rp "Press Enter to attach... " _
  docker attach --detach-keys=ctrl-p,ctrl-q "$WORLD_CONTAINER"
}

cmd_backup() {
  local dir="${1:-./backups}"
  mkdir -p "$dir"
  running "$DB_CONTAINER" || die "$DB_CONTAINER is not running"
  local stamp; stamp=$(date +%Y-%m-%d_%H%M)
  # acore_characters is the one that actually matters -- it holds every
  # character, bag, bank and achievement. world and auth can be rebuilt.
  for db in acore_characters acore_auth acore_playerbots; do
    local out="$dir/${db}_${stamp}.sql.gz"
    docker exec -i "$DB_CONTAINER" sh -c \
      "mysqldump -u root -p\"\$MYSQL_ROOT_PASSWORD\" --single-transaction --routines $db" \
      | gzip > "$out"
    ok "$db -> $out ($(du -h "$out" | cut -f1))"
  done
  # Keep the last 14 of each.
  for db in acore_characters acore_auth acore_playerbots; do
    ls -1t "$dir/${db}_"*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm --
  done
}

cmd_restore() {
  local file="${1:?usage: admin.sh restore <file.sql.gz> <database>}"
  local db="${2:?usage: admin.sh restore <file.sql.gz> <database>}"
  [[ -f "$file" ]] || die "no such file: $file"
  read -rp "This OVERWRITES $db with $file. Type the database name to confirm: " confirm
  [[ "$confirm" == "$db" ]] || die "aborted"
  gunzip -c "$file" | docker exec -i "$DB_CONTAINER" sh -c \
    "mysql -u root -p\"\$MYSQL_ROOT_PASSWORD\" $db"
  ok "restored $db"
  echo "   restart the stack so the servers pick it up"
}

cmd_status() {
  docker ps --filter 'name=ac-' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  echo
  if running "$DB_CONTAINER"; then
    echo "Realm the clients will be sent to:"
    docker exec -i "$DB_CONTAINER" sh -c \
      'mysql -u root -p"$MYSQL_ROOT_PASSWORD" acore_auth -e "SELECT name, address, port FROM realmlist;"'
  fi
  if command -v tailscale >/dev/null 2>&1; then
    echo
    echo "This host on the tailnet: $(tailscale ip -4 2>/dev/null | head -1)"
  fi
}

case "${1:-}" in
  account) shift; cmd_account "$@" ;;
  gm)      shift; cmd_gm "$@" ;;
  list)    shift; cmd_list "$@" ;;
  console) shift; cmd_console "$@" ;;
  backup)  shift; cmd_backup "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  status)  shift; cmd_status "$@" ;;
  *) sed -n '3,18p' "$0"; exit 1 ;;
esac
