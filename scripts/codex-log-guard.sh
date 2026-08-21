#!/usr/bin/env bash
# FLY-697 — Codex TRACE-log SSD-wear guard.
#
# WHY: Codex desktop logs at TRACE level into ~/.codex/logs_2.sqlite at very high
# frequency. On Annie's machine that DB reached 1.1GB with MAX(id) ~99M while only
# ~400K rows remain live — i.e. ~99M inserts churned through, the file is mostly
# dead SQLite pages, and the constant write traffic wears the SSD. The upstream
# CLI fix is partial and the desktop is unfixed (community reports it is still not
# really fixed), so we cannot rely on an update alone.
#
# WHAT: install an idempotent SQLite trigger that silently drops TRACE inserts
# (cuts ~77% of the write volume = the real wear fix), then VACUUM to reclaim the
# dead pages, and monitor file size to catch any re-growth.
#
# SAFETY (non-negotiable):
#   * Every write op (install-trigger / vacuum / remediate) REFUSES while the DB
#     is open by any process (Codex active) — touching a live SQLite under heavy
#     write would corrupt it. The open-file check uses `lsof` and FAILS CLOSED:
#     if it cannot prove the DB is idle, it refuses.
#   * The tool NEVER prints log bodies and NEVER copies the DB off the machine —
#     logs may contain tokens / credentials. Only sizes, counts and metadata are
#     ever emitted.
#
# Usage:
#   codex-log-guard.sh status            # read-only; safe any time
#   codex-log-guard.sh install-trigger   # refuses if DB in use
#   codex-log-guard.sh vacuum            # refuses if DB in use
#   codex-log-guard.sh remediate         # install-trigger + vacuum + status
#   codex-log-guard.sh monitor           # read-only; size log + meta-alert on bloat
#
# Env overrides:
#   CODEX_LOG_DB                  default ${CODEX_HOME:-$HOME/.codex}/logs_2.sqlite
#   CODEX_LOG_GUARD_LEVELS        comma list of levels to block (default: TRACE)
#   CODEX_LOG_GUARD_THRESHOLD_BYTES  monitor alert threshold (default: 268435456 = 256MB)
#   CODEX_LOG_GUARD_LOG           monitor size-log path (default: ~/Library/Logs/flywheel/codex-log-guard.log)
#   CODEX_LOG_GUARD_META_ALERT    meta-alert script (default: <dir>/meta-alert.sh)
#   LSOF_BIN                      lsof override (tests)
set -uo pipefail

TRIGGER_NAME="codex_log_guard_block"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -r "$SCRIPT_DIR/lib/flywheel-log.sh" ]]; then
  # shellcheck source=lib/flywheel-log.sh
  source "$SCRIPT_DIR/lib/flywheel-log.sh"
else
  flywheel_log_rotate_if_needed() { return 0; }
fi
DB="${CODEX_LOG_DB:-${CODEX_HOME:-$HOME/.codex}/logs_2.sqlite}"
LEVELS="${CODEX_LOG_GUARD_LEVELS:-TRACE}"
THRESHOLD_BYTES="${CODEX_LOG_GUARD_THRESHOLD_BYTES:-268435456}"
MONITOR_LOG="${CODEX_LOG_GUARD_LOG:-$HOME/Library/Logs/flywheel/codex-log-guard.log}"
META_ALERT="${CODEX_LOG_GUARD_META_ALERT:-$SCRIPT_DIR/meta-alert.sh}"

log()  { echo "[codex-log-guard] $*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

require_sqlite() { command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found"; }

# Portable file size in bytes (0 if absent). GNU `stat -c %s` is tried FIRST: on
# Linux it is correct, and on macOS it fails cleanly (illegal option) so we fall
# back to BSD `stat -f %z`. The reverse order is a trap — on Linux `stat -f`
# means --file-system and SUCCEEDS with garbage, masking the real size.
file_size() {
  local f="$1"
  [ -e "$f" ] || { echo 0; return; }
  stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0
}

# Total on-disk footprint: main DB + -wal + -shm.
total_size() {
  local main wal shm
  main=$(file_size "$DB")
  wal=$(file_size "$DB-wal")
  shm=$(file_size "$DB-shm")
  echo $(( main + wal + shm ))
}

resolve_lsof() {
  if [ -n "${LSOF_BIN:-}" ]; then echo "$LSOF_BIN"; return; fi
  if command -v lsof >/dev/null 2>&1; then echo "lsof"; return; fi
  if [ -x /usr/sbin/lsof ]; then echo /usr/sbin/lsof; return; fi
  echo ""   # not found
}

# Is the DB (or its -wal/-shm) held open by any process? FAILS CLOSED: if lsof
# is unavailable we report "in use" so write ops refuse rather than risk a live DB.
db_in_use() {
  local lsof_bin f
  lsof_bin="$(resolve_lsof)"
  if [ -z "$lsof_bin" ]; then
    log "lsof unavailable — assuming DB in use (fail-closed)"
    return 0
  fi
  for f in "$DB" "$DB-wal" "$DB-shm"; do
    [ -e "$f" ] || continue
    if "$lsof_bin" -- "$f" >/dev/null 2>&1; then
      return 0   # at least one holder → in use
    fi
  done
  return 1
}

db_exists()    { [ -f "$DB" ]; }
logs_table_exists() {
  [ "$(sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='logs';" 2>/dev/null)" = "1" ]
}
trigger_installed() {
  [ "$(sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='$TRIGGER_NAME';" 2>/dev/null)" = "1" ]
}

# Build the SQL IN-list from CODEX_LOG_GUARD_LEVELS, e.g. 'TRACE','DEBUG'.
levels_in_list() {
  local out="" lvl
  IFS=',' read -ra parts <<<"$LEVELS"
  for lvl in "${parts[@]}"; do
    lvl="$(echo "$lvl" | tr -d '[:space:]')"
    [ -n "$lvl" ] || continue
    [ -n "$out" ] && out="$out,"
    out="$out'$lvl'"
  done
  echo "$out"
}

# Refuse all write ops unless the DB is provably idle.
refuse_if_in_use() {
  if db_in_use; then
    die "DB is in use (Codex active) — refusing $1. Quit Codex desktop first, then re-run."
  fi
}

cmd_status() {
  require_sqlite
  local in_use="no" trig="no" exists="no"
  db_exists && exists="yes"
  db_in_use && in_use="yes"
  if [ "$exists" = "yes" ] && trigger_installed; then trig="yes"; fi
  echo "db_path=$DB"
  echo "db_exists=$exists"
  echo "size_main_bytes=$(file_size "$DB")"
  echo "size_wal_bytes=$(file_size "$DB-wal")"
  echo "size_shm_bytes=$(file_size "$DB-shm")"
  echo "size_total_bytes=$(total_size)"
  echo "in_use=$in_use"
  echo "trigger_installed=$trig"
  echo "blocked_levels=$LEVELS"
}

cmd_install_trigger() {
  require_sqlite
  db_exists || die "DB not found: $DB"
  refuse_if_in_use "install-trigger"
  logs_table_exists || die "no 'logs' table in $DB — nothing to guard"
  local in_list
  in_list="$(levels_in_list)"
  [ -n "$in_list" ] || die "no levels to block (CODEX_LOG_GUARD_LEVELS empty)"
  # Drop+recreate so the trigger always reflects the configured levels (idempotent).
  sqlite3 "$DB" <<SQL || die "failed to install trigger"
PRAGMA busy_timeout=5000;
DROP TRIGGER IF EXISTS $TRIGGER_NAME;
CREATE TRIGGER $TRIGGER_NAME
BEFORE INSERT ON logs
WHEN NEW.level IN ($in_list)
BEGIN
  SELECT RAISE(IGNORE);
END;
SQL
  trigger_installed || die "trigger missing after install"
  log "trigger '$TRIGGER_NAME' installed (blocks levels: $LEVELS)"
}

cmd_vacuum() {
  require_sqlite
  db_exists || die "DB not found: $DB"
  refuse_if_in_use "vacuum"
  local before after
  before=$(file_size "$DB")
  sqlite3 "$DB" "PRAGMA busy_timeout=5000; VACUUM;" || die "VACUUM failed"
  after=$(file_size "$DB")
  log "vacuum done: ${before} -> ${after} bytes (reclaimed $(( before - after )))"
}

cmd_remediate() {
  refuse_if_in_use "remediate"
  cmd_install_trigger
  cmd_vacuum
  cmd_status
}

cmd_monitor() {
  require_sqlite
  mkdir -p "$(dirname "$MONITOR_LOG")" 2>/dev/null || true
  local size trig stamp
  size=$(total_size)
  trig="no"; { db_exists && trigger_installed && trig="yes"; }
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Size-only line — never any log body.
  flywheel_log_rotate_if_needed "$MONITOR_LOG"
  echo "$stamp db=$DB size_total_bytes=$size trigger_installed=$trig threshold_bytes=$THRESHOLD_BYTES" >> "$MONITOR_LOG" 2>/dev/null || true

  if db_exists && [ "$size" -ge "$THRESHOLD_BYTES" ]; then
    local title body
    title="Codex log bloat: $(( size / 1048576 ))MB"
    body="$DB is $size bytes (>= $THRESHOLD_BYTES). trigger_installed=$trig. Quit Codex desktop, then run: codex-log-guard.sh remediate"
    if [ -x "$META_ALERT" ]; then
      "$META_ALERT" "codex_log_bloat" "$title" "$body" >/dev/null 2>&1 || true
    else
      log "ALERT: $title — $body"
    fi
  fi
  return 0
}

usage() {
  cat >&2 <<EOF
codex-log-guard.sh — guard ~/.codex TRACE-log SSD wear (FLY-697)
Commands: status | install-trigger | vacuum | remediate | monitor
Target DB: $DB
EOF
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    status)          cmd_status ;;
    install-trigger) cmd_install_trigger ;;
    vacuum)          cmd_vacuum ;;
    remediate)       cmd_remediate ;;
    monitor)         cmd_monitor ;;
    ""|-h|--help|help) usage; [ -z "$cmd" ] && exit 2 || exit 0 ;;
    *) usage; die "unknown command: $cmd" ;;
  esac
}

main "$@"
