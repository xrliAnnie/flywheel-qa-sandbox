#!/usr/bin/env bash
# FLY-1330 — age-based cleanup for terminal Codex/Claude history and artifacts.
#
# Usage:
#   flywheel-log-janitor.sh --dry-run [--module NAME]
#   flywheel-log-janitor.sh --apply [--force] [--module NAME]
#   flywheel-log-janitor.sh --cycle
#
# Configuration:
#   FLYWHEEL_JANITOR_RETENTION_CODEX_SESSIONS_DAYS   default 30
#   FLYWHEEL_JANITOR_RETENTION_CODEX_ARTIFACTS_DAYS  default 30
#   FLYWHEEL_JANITOR_RETENTION_CLAUDE_ORPHANS_DAYS   default 30
#   FLYWHEEL_JANITOR_KEEP_RELEASES                    default 2
#   FLYWHEEL_JANITOR_CODEX_HOMES                      colon-separated; first is main
#   FLYWHEEL_JANITOR_STATE_DIR                        lock, audit, apply marker
#   FLYWHEEL_JANITOR_TEAMLEAD_DB                      read-only session ledger
#   FLYWHEEL_JANITOR_DISABLE_MODULES                  comma-separated module names
#   FLYWHEEL_JANITOR_REPORT_CHANNEL                   Discord channel; explicit empty disables
#   FLYWHEEL_JANITOR_REPORT_PROJECT                   publish-report project name
#   FLYWHEEL_JANITOR_ENV_FILE                         Bridge credentials/config
#   FLYWHEEL_JANITOR_COMM_CLI                         absolute flywheel-comm entrypoint
#   FLYWHEEL_JANITOR_PUBLISH_TIMEOUT_SECONDS          default 120
#   FLYWHEEL_JANITOR_TMUX_SOCKET_ROOT                 default /private/tmp/tmux-<uid>
#   FLYWHEEL_JANITOR_TMUX_SOCKET_MIN_AGE_SECONDS      default 3600
#   FLYWHEEL_JANITOR_TMUX_SOCKET_PROBE_TIMEOUT_SECONDS default 5
#   FLYWHEEL_JANITOR_TMUX_SOCKET_DELETE_CAP           default 25 per apply
#   FLYWHEEL_JANITOR_FLYWHEEL_STATE_ROOT               default ~/.flywheel/state
#   FLYWHEEL_JANITOR_GATE_MARKER_DIR                   default <state>/codex-gates
#   FLYWHEEL_JANITOR_GATE_ARCHIVE_DIR                  default <state>/codex-gates-archive
#   FLYWHEEL_JANITOR_GATE_MARKER_DELETE_CAP            default 20000 per apply
#   FLYWHEEL_JANITOR_GATE_MARKER_BACKLOG_ALERT_THRESHOLD default 500
#   FLYWHEEL_JANITOR_ARCHIVE_ROOT                        default ~/.flywheel/archive
#   FLYWHEEL_JANITOR_COMM_ROOT                           default ~/.flywheel/comm
#   FLYWHEEL_JANITOR_TAR_BIN                             optional absolute tar override
#   FLYWHEEL_JANITOR_DB_RETENTION_HEALTH_URL              Bridge health sample URL
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=""
ONLY_MODULE=""
FORCE=0

RETENTION_CODEX_SESSIONS="${FLYWHEEL_JANITOR_RETENTION_CODEX_SESSIONS_DAYS:-30}"
RETENTION_CODEX_ARTIFACTS="${FLYWHEEL_JANITOR_RETENTION_CODEX_ARTIFACTS_DAYS:-30}"
RETENTION_CLAUDE_ORPHANS="${FLYWHEEL_JANITOR_RETENTION_CLAUDE_ORPHANS_DAYS:-30}"
KEEP_RELEASES="${FLYWHEEL_JANITOR_KEEP_RELEASES:-2}"
CODEX_HOMES_RAW="${FLYWHEEL_JANITOR_CODEX_HOMES:-$HOME/.codex:$HOME/.codex-mufasa:$HOME/.codex-infra-bot}"
STATE_DIR="${FLYWHEEL_JANITOR_STATE_DIR:-$HOME/.flywheel/state/log-janitor}"
TEAMLEAD_DB="${FLYWHEEL_JANITOR_TEAMLEAD_DB:-$HOME/.flywheel/teamlead.db}"
DISABLED_MODULES=",${FLYWHEEL_JANITOR_DISABLE_MODULES:-},"
CLAUDE_PROJECTS="$HOME/.claude/projects"
AUDIT_FILE="$STATE_DIR/audit.jsonl"
LOCK_DIR="$STATE_DIR/lock.d"
DRY_RUN_MARKER="$STATE_DIR/full-dry-run-ok"
FIRST_APPLY_MARKER="$STATE_DIR/first-apply-ok"
if [[ -n "${FLYWHEEL_JANITOR_REPORT_CHANNEL+x}" ]]; then
  REPORT_CHANNEL_EXPLICIT=1
  REPORT_CHANNEL="$FLYWHEEL_JANITOR_REPORT_CHANNEL"
else
  REPORT_CHANNEL_EXPLICIT=0
  REPORT_CHANNEL=""
fi
REPORT_PROJECT="${FLYWHEEL_JANITOR_REPORT_PROJECT:-flywheel}"
REPORT_PENDING_DIR="$STATE_DIR/pending-reports"
REPORT_ENV_FILE="${FLYWHEEL_JANITOR_ENV_FILE:-$HOME/.flywheel/.env}"
COMM_CLI="${FLYWHEEL_JANITOR_COMM_CLI:-$SCRIPT_DIR/../packages/flywheel-comm/dist/index.js}"
NODE_BIN="$(command -v node 2>/dev/null || true)"
PUBLISH_TIMEOUT_SECONDS="${FLYWHEEL_JANITOR_PUBLISH_TIMEOUT_SECONDS:-120}"
CURRENT_UID="$(id -u)"
TMUX_SOCKET_ROOT="${FLYWHEEL_JANITOR_TMUX_SOCKET_ROOT:-/private/tmp/tmux-$CURRENT_UID}"
TMUX_SOCKET_MIN_AGE_SECONDS="${FLYWHEEL_JANITOR_TMUX_SOCKET_MIN_AGE_SECONDS:-3600}"
TMUX_SOCKET_PROBE_TIMEOUT_SECONDS="${FLYWHEEL_JANITOR_TMUX_SOCKET_PROBE_TIMEOUT_SECONDS:-5}"
TMUX_SOCKET_DELETE_CAP="${FLYWHEEL_JANITOR_TMUX_SOCKET_DELETE_CAP:-25}"
TMUX_SOCKET_ALLOWLIST="${FLYWHEEL_JANITOR_TMUX_SOCKET_ALLOWLIST:-default,atlas}"
FLYWHEEL_STATE_ROOT="${FLYWHEEL_JANITOR_FLYWHEEL_STATE_ROOT:-$HOME/.flywheel/state}"
GATE_MARKER_DIR="${FLYWHEEL_JANITOR_GATE_MARKER_DIR:-$FLYWHEEL_STATE_ROOT/codex-gates}"
GATE_ARCHIVE_DIR="${FLYWHEEL_JANITOR_GATE_ARCHIVE_DIR:-$FLYWHEEL_STATE_ROOT/codex-gates-archive}"
GATE_MARKER_RETENTION_SECONDS=172800
GATE_MARKER_DELETE_CAP="${FLYWHEEL_JANITOR_GATE_MARKER_DELETE_CAP:-20000}"
GATE_MARKER_BACKLOG_ALERT_THRESHOLD="${FLYWHEEL_JANITOR_GATE_MARKER_BACKLOG_ALERT_THRESHOLD:-500}"
WAKE_TERMINAL_STATUSES="completed|terminated|failed|blocked|timeout|canceled|cancelled"
FLYWHEEL_ARCHIVE_ROOT="${FLYWHEEL_JANITOR_ARCHIVE_ROOT:-$HOME/.flywheel/archive}"
STATE_RESIDUE_ARCHIVE_DIR="$FLYWHEEL_ARCHIVE_ROOT/state-residue"
FLYWHEEL_COMM_ROOT="${FLYWHEEL_JANITOR_COMM_ROOT:-$HOME/.flywheel/comm}"
TAR_BIN_OVERRIDE="${FLYWHEEL_JANITOR_TAR_BIN:-}"
DB_RETENTION_CLI="$SCRIPT_DIR/fly-1998-database-retention-sweep.mjs"
DB_RETENTION_RATE_CLI="$SCRIPT_DIR/lib/fly-2139-retention-rates.mjs"
DB_RETENTION_COMM_DB="$FLYWHEEL_COMM_ROOT/flywheel/comm.db"
DB_RETENTION_EVIDENCE_ROOT="$HOME/.flywheel/maintenance/fly-2139"
DB_RETENTION_ACTIVATION_RECEIPT="$STATE_DIR/db-retention-activation.json"
DB_RETENTION_SUCCESS_MARKER="$STATE_DIR/db-retention-last-success.json"
DB_RETENTION_INVENTORY_MARKER="$STATE_DIR/db-retention-last-inventory.json"
DB_RETENTION_HEALTH_URL="${FLYWHEEL_JANITOR_DB_RETENTION_HEALTH_URL:-http://127.0.0.1:9876/health}"
DB_RETENTION_INTERVAL_SECONDS=604800
DB_RETENTION_EVIDENCE_KEEP=2
COMMDB_BACKUP_RETENTION_SECONDS=1209600
COMMDB_ARCHIVE_RETENTION_SECONDS=2592000
COMMDB_BACKUP_COMPRESS_CAP=100
REPORT_DRAIN_LIMIT=7
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BASE_RUN_ID="$RUN_ID"
LOCK_OWNED=0

DELETED_COUNT=0
DELETED_FILE_COUNT=0
SKIPPED_COUNT=0
FREED_BYTES=0
CANDIDATE_COUNT=0
CANDIDATE_BYTES=0
OLDEST_DELETED_MTIME=""
NEWEST_DELETED_MTIME=""
declare -a CODEX_HOMES=()
declare -a ALLOWED_ROOTS=()
declare -a LEDGER_THREADS=()
declare -a LEDGER_EXECUTIONS=()
declare -a DB_EXECUTIONS=()
declare -a DB_STATUSES=()
OPEN_CANONICALS=$'\n'
CURRENT_RUN_FAILED=0
CYCLE_DRY_PHASE=0

log() { printf '[log-janitor] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

usage() {
  cat >&2 <<'EOF'
flywheel-log-janitor.sh --dry-run|--apply|--cycle [--force] [--module NAME]
Modules: codex_releases codex_sessions codex_artifacts codex_logs_db claude_orphans tmux_dead_sockets gate_markers state_residue commdb_backups db_retention
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) [[ -z "$MODE" ]] || die "choose exactly one mode"; MODE="dry-run" ;;
      --apply) [[ -z "$MODE" ]] || die "choose exactly one mode"; MODE="apply" ;;
      --cycle) [[ -z "$MODE" ]] || die "choose exactly one mode"; MODE="cycle" ;;
      --force) FORCE=1 ;;
      --module)
        shift
        [[ $# -gt 0 ]] || die "--module requires a value"
        ONLY_MODULE="$1"
        ;;
      -h|--help) usage; exit 0 ;;
      *) usage; die "unknown argument: $1" ;;
    esac
    shift
  done
  [[ -n "$MODE" ]] || { usage; die "--dry-run, --apply, or --cycle is required"; }
  if [[ "$MODE" == "cycle" && ( -n "$ONLY_MODULE" || "$FORCE" -eq 1 ) ]]; then
    die "--cycle is full-scope and cannot be combined with --module or --force"
  fi
  case "$ONLY_MODULE" in
    ""|codex_releases|codex_sessions|codex_artifacts|codex_logs_db|claude_orphans|tmux_dead_sockets|gate_markers|state_residue|commdb_backups|db_retention) ;;
    *) die "unknown module: $ONLY_MODULE" ;;
  esac
}

validate_uint() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be a non-negative integer"
}

validate_tmux_socket_allowlist() {
  local item seen="," count=0
  local -a items=()
  IFS=',' read -ra items <<< "$TMUX_SOCKET_ALLOWLIST"
  for item in "${items[@]}"; do
    [[ "$item" =~ ^[A-Za-z0-9._-]+$ && "$item" != "." && "$item" != ".." ]] \
      || die "FLYWHEEL_JANITOR_TMUX_SOCKET_ALLOWLIST contains an unsafe basename"
    case "$seen" in
      *,"$item",*) die "FLYWHEEL_JANITOR_TMUX_SOCKET_ALLOWLIST contains a duplicate basename" ;;
    esac
    seen+="$item,"
    count=$((count + 1))
  done
  [[ "$count" -gt 0 ]] || die "FLYWHEEL_JANITOR_TMUX_SOCKET_ALLOWLIST must not be empty"
}

file_size() {
  local path="$1"
  stat -c %s "$path" 2>/dev/null || stat -f %z "$path" 2>/dev/null || printf '0\n'
}

file_mtime() {
  local path="$1"
  stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || return 1
}

note_deleted_mtime() {
  local mtime="$1"
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 0
  if [[ -z "$OLDEST_DELETED_MTIME" || "$mtime" -lt "$OLDEST_DELETED_MTIME" ]]; then
    OLDEST_DELETED_MTIME="$mtime"
  fi
  if [[ -z "$NEWEST_DELETED_MTIME" || "$mtime" -gt "$NEWEST_DELETED_MTIME" ]]; then
    NEWEST_DELETED_MTIME="$mtime"
  fi
}

format_epoch_utc() {
  local epoch="$1"
  date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
}

directory_size() {
  local path="$1" kib
  kib="$(du -sk "$path" 2>/dev/null | sed -n 's/[[:space:]].*$//p')" || kib="0"
  [[ "$kib" =~ ^[0-9]+$ ]] || kib="0"
  printf '%s\n' "$((kib * 1024))"
}

directory_file_count() {
  local path="$1" file count=0
  while IFS= read -r -d '' file; do
    count=$((count + 1))
  done < <(find "$path" -type f -print0 2>/dev/null)
  printf '%s\n' "$count"
}

physical_dir() {
  local dir="$1"
  (cd -P "$dir" 2>/dev/null && pwd -P)
}

normalize_existing_root() {
  local root="$1" parent base
  [[ "$root" == /* && ! -L "$root" ]] || return 1
  parent="${root%/*}"
  base="${root##*/}"
  [[ -n "$parent" && -n "$base" ]] || return 1
  parent="$(physical_dir "$parent")" || return 1
  printf '%s/%s\n' "$parent" "$base"
}

canonical_existing_path() {
  local path="$1" parent base
  [[ "$path" == /* && -e "$path" && ! -L "$path" ]] || return 1
  parent="$(physical_dir "${path%/*}")" || return 1
  base="${path##*/}"
  printf '%s/%s\n' "$parent" "$base"
}

is_allowed_target() {
  local path="$1" parent base resolved root
  [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
  [[ -e "$path" && ! -L "$path" ]] || return 1
  parent="$(physical_dir "${path%/*}")" || return 1
  base="${path##*/}"
  resolved="$parent/$base"
  for root in "${ALLOWED_ROOTS[@]}"; do
    [[ "$resolved" == "$root/"* ]] && return 0
  done
  return 1
}

audit_event() {
  local module="$1" action="$2" path="$3" bytes="$4" reason="$5" line
  line="$(jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg run_id "$RUN_ID" \
    --arg mode "$MODE" \
    --arg module "$module" \
    --arg action "$action" \
    --arg path "$path" \
    --argjson bytes "$bytes" \
    --arg reason "$reason" \
    '{ts:$ts,run_id:$run_id,mode:$mode,module:$module,action:$action,path:$path,bytes:$bytes,reason:$reason}' \
    2>/dev/null)" || die "cannot encode audit event"
  printf '%s\n' "$line" >> "$AUDIT_FILE" 2>/dev/null \
    || die "cannot append audit event to $AUDIT_FILE"
}

audit_summary() {
  local line per_module
  per_module="$(jq -sc --arg run_id "$RUN_ID" '
    [.[] | select(.run_id == $run_id and .module != "all")]
    | group_by(.module)
    | map({
        key: .[0].module,
        value: {
          action_count: length,
          delete_count: ([.[] | select(.action == "delete" or .action == "archive" or .action == "compress")] | length),
          would_delete_count: ([.[] | select(.action == "would-delete" or .action == "would-archive" or .action == "would-compress")] | length),
          skipped_count: ([.[] | select(.action == "skip")] | length),
          freed_bytes: ([.[] | select(.action == "delete") | .bytes] | add // 0),
          candidate_bytes: ([.[] | select(.action == "delete" or .action == "would-delete" or .action == "archive" or .action == "would-archive" or .action == "compress" or .action == "would-compress") | .bytes] | add // 0),
          retention_rates: ([.[] | select(.action == "retention-rates") | {candidate_count,previous_candidate_count,elapsed_hours,mint_rate_per_hour,drain_rate_per_hour,drain_rate_source,mint_exceeds_drain,mint_exceeds_drain_streak,alert}] | last // null)
        }
      })
    | from_entries
  ' "$AUDIT_FILE" 2>/dev/null)" || die "cannot summarize audit log"
  line="$(jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg run_id "$RUN_ID" \
    --arg mode "$MODE" \
    --argjson freed_bytes "$FREED_BYTES" \
    --argjson deleted_count "$DELETED_COUNT" \
    --argjson deleted_file_count "$DELETED_FILE_COUNT" \
    --argjson candidate_bytes "$CANDIDATE_BYTES" \
    --argjson candidate_count "$CANDIDATE_COUNT" \
    --argjson skipped_count "$SKIPPED_COUNT" \
    --argjson per_module "$per_module" \
    '{ts:$ts,run_id:$run_id,mode:$mode,module:"all",action:"summary",freed_bytes:$freed_bytes,deleted_count:$deleted_count,deleted_file_count:$deleted_file_count,candidate_bytes:$candidate_bytes,candidate_count:$candidate_count,skipped_count:$skipped_count,per_module:$per_module,db_retention_rates:($per_module.db_retention.retention_rates // null)}' \
    2>/dev/null)" || die "cannot encode audit summary"
  printf '%s\n' "$line" >> "$AUDIT_FILE" 2>/dev/null \
    || die "cannot append audit summary to $AUDIT_FILE"
}

render_apply_report() {
  local modules oldest newest freed_gib report_tmp report_path
  modules="$(jq -c --arg run_id "$RUN_ID" '
    select(.run_id == $run_id and .action == "summary") | .per_module
  ' "$AUDIT_FILE" 2>/dev/null | tail -1)"
  [[ "$modules" == \{* ]] || modules='{}'
  if [[ -n "$OLDEST_DELETED_MTIME" ]]; then
    oldest="$(format_epoch_utc "$OLDEST_DELETED_MTIME")" || return 1
  else
    oldest="无文件型删除"
  fi
  if [[ -n "$NEWEST_DELETED_MTIME" ]]; then
    newest="$(format_epoch_utc "$NEWEST_DELETED_MTIME")" || return 1
  else
    newest="无文件型删除"
  fi
  freed_gib="$(jq -nr --argjson bytes "$FREED_BYTES" '$bytes / 1073741824 | . * 100 | round / 100')" \
    || return 1
  [[ ! -L "$REPORT_PENDING_DIR" ]] || return 1
  mkdir -p "$REPORT_PENDING_DIR" || return 1
  [[ -d "$REPORT_PENDING_DIR" ]] || return 1
  report_path="$REPORT_PENDING_DIR/$RUN_ID.html"
  [[ ! -e "$report_path" && ! -L "$report_path" ]] || return 1
  report_tmp="$(mktemp "$REPORT_PENDING_DIR/.$RUN_ID.XXXXXX")" || return 1
  if ! jq -nr \
    --arg run_id "$RUN_ID" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg deleted_file_count "$DELETED_FILE_COUNT" \
    --arg freed_bytes "$FREED_BYTES" \
    --arg freed_gib "$freed_gib" \
    --arg skipped_count "$SKIPPED_COUNT" \
    --arg oldest "$oldest" \
    --arg newest "$newest" \
    --argjson modules "$modules" '
      def h: @html;
      ($modules | to_entries | map(
        (.value.retention_rates // {}) as $rates |
        (if $rates.alert == true then "持续落后" elif $rates.mint_exceeds_drain == true then "观察中" elif $rates.mint_exceeds_drain == false then "排水覆盖" else "待形成双点" end) as $rate_status |
        "<tr><td>\(.key | h)</td><td>\(.value.delete_count)</td><td>\(.value.skipped_count)</td><td>\(.value.freed_bytes)</td><td>\(($rates.candidate_count // "—") | tostring | h)</td><td>\(($rates.mint_rate_per_hour // "—") | tostring | h)</td><td>\(($rates.drain_rate_per_hour // "—") | tostring | h)</td><td>\($rate_status | h)</td></tr>"
      ) | join("")) as $rows |
      "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>日志 Janitor 清理报告</title><style>body{margin:0;background:#f5f5f7;color:#1d1d1f;font:15px -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}.wrap{max-width:1100px;margin:0 auto;padding:48px 24px}.eyebrow{color:#6e6e73;font-weight:600}.hero{font-size:42px;line-height:1.08;margin:8px 0 28px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card,.panel{background:#fff;border-radius:18px;padding:22px;box-shadow:0 1px 0 rgba(0,0,0,.04)}.value{font-size:28px;font-weight:700;margin-top:8px}.muted{color:#6e6e73}.panel{margin-top:16px;overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 8px;border-bottom:1px solid #e8e8ed;white-space:nowrap}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media(max-width:720px){.grid{grid-template-columns:1fr 1fr}.hero{font-size:34px}}</style></head><body><main class=\"wrap\"><div class=\"eyebrow\">FLY-1330 · \($generated_at | h)</div><h1 class=\"hero\">日志 Janitor 清理完成</h1><section class=\"grid\"><div class=\"card\"><div class=\"muted\">清理文件</div><div class=\"value\" id=\"deleted-file-count\">\($deleted_file_count | h)</div></div><div class=\"card\"><div class=\"muted\">释放空间</div><div class=\"value\">\($freed_gib | h) GiB</div><div class=\"muted\">\($freed_bytes | h) bytes</div></div><div class=\"card\"><div class=\"muted\">防线拦下</div><div class=\"value\">\($skipped_count | h)</div></div><div class=\"card\"><div class=\"muted\">Run</div><div class=\"value\" style=\"font-size:15px\"><code>\($run_id | h)</code></div></div></section><section class=\"panel\"><h2>时间范围</h2><p><strong>最老删除项：</strong>\($oldest | h)</p><p><strong>最新删除项：</strong>\($newest | h)</p></section><section class=\"panel\"><h2>审计 manifest 摘要</h2><table><thead><tr><th>模块</th><th>处置项</th><th>拦截数</th><th>释放 bytes</th><th>DB 候选</th><th>铸信/时</th><th>排水/时</th><th>速率状态</th></tr></thead><tbody>\($rows)</tbody></table></section></main></body></html>"
    ' > "$report_tmp"; then
    rm -f "$report_tmp" 2>/dev/null || true
    return 1
  fi
  mv "$report_tmp" "$report_path" || {
    rm -f "$report_tmp" 2>/dev/null || true
    return 1
  }
}

resolve_report_channel() {
  local notify_override="${FLYWHEEL_NOTIFY_CHANNEL:-}" resolved
  [[ "$REPORT_CHANNEL_EXPLICIT" -eq 0 ]] || return 0
  if [[ -n "$notify_override" ]]; then
    REPORT_CHANNEL="$notify_override"
    return 0
  fi
  [[ -f "$REPORT_ENV_FILE" && ! -L "$REPORT_ENV_FILE" ]] || return 1
  resolved="$(
    unset FLYWHEEL_NOTIFY_CHANNEL
    # shellcheck disable=SC1090
    . "$REPORT_ENV_FILE"
    printf '%s\n' "${FLYWHEEL_NOTIFY_CHANNEL:-}"
  )" || return 1
  [[ -n "$resolved" ]] || return 1
  REPORT_CHANNEL="$resolved"
}

resolve_timeout() {
  if command -v timeout >/dev/null 2>&1; then command -v timeout; return; fi
  if command -v gtimeout >/dev/null 2>&1; then command -v gtimeout; return; fi
  printf '\n'
}

publish_report_file() {
  local report_file="$1" node_bin timeout_bin rc
  local bridge_override token_override ingest_override reports_override width_override
  local -a publish_env=()
  [[ -f "$report_file" && ! -L "$report_file" ]] || {
    audit_event all skip "$report_file" 0 "report-file-unsafe-or-missing"
    return 1
  }
  [[ "$COMM_CLI" == /* && -f "$COMM_CLI" && ! -L "$COMM_CLI" ]] || {
    audit_event all skip "$COMM_CLI" 0 "report-comm-cli-unavailable"
    return 1
  }
  node_bin="$(command -v node 2>/dev/null || true)"
  [[ -n "$node_bin" ]] || {
    audit_event all skip "" 0 "report-node-unavailable"
    return 1
  }
  timeout_bin="$(resolve_timeout)"
  [[ -n "$timeout_bin" ]] || {
    audit_event all skip "" 0 "report-timeout-unavailable"
    return 1
  }
  bridge_override="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-}}"
  token_override="${TEAMLEAD_API_TOKEN:-}"
  ingest_override="${FLYWHEEL_INGEST_TOKEN:-}"
  reports_override="${FLYWHEEL_REPORTS_DIR:-}"
  width_override="${FLYWHEEL_REPORT_SHOT_WIDTH:-}"
  (
    if [[ -f "$REPORT_ENV_FILE" && ! -L "$REPORT_ENV_FILE" ]]; then
      # shellcheck disable=SC1090
      . "$REPORT_ENV_FILE"
    fi
    if [[ -n "$bridge_override" ]]; then
      FLYWHEEL_BRIDGE_URL="$bridge_override"
      BRIDGE_URL="$bridge_override"
    fi
    [[ -z "$token_override" ]] || TEAMLEAD_API_TOKEN="$token_override"
    [[ -z "$ingest_override" ]] || FLYWHEEL_INGEST_TOKEN="$ingest_override"
    [[ -z "$reports_override" ]] || FLYWHEEL_REPORTS_DIR="$reports_override"
    [[ -z "$width_override" ]] || FLYWHEEL_REPORT_SHOT_WIDTH="$width_override"
    publish_env=(
      "HOME=$HOME"
      "PATH=$PATH"
      "TMPDIR=${TMPDIR:-/tmp}"
      "LANG=${LANG:-en_US.UTF-8}"
      "FLYWHEEL_BRIDGE_URL=${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}"
    )
    [[ -z "${TEAMLEAD_API_TOKEN:-}" ]] \
      || publish_env+=("TEAMLEAD_API_TOKEN=$TEAMLEAD_API_TOKEN")
    [[ -z "${FLYWHEEL_INGEST_TOKEN:-}" ]] \
      || publish_env+=("FLYWHEEL_INGEST_TOKEN=$FLYWHEEL_INGEST_TOKEN")
    [[ -z "${FLYWHEEL_REPORTS_DIR:-}" ]] \
      || publish_env+=("FLYWHEEL_REPORTS_DIR=$FLYWHEEL_REPORTS_DIR")
    [[ -z "${FLYWHEEL_REPORT_SHOT_WIDTH:-}" ]] \
      || publish_env+=("FLYWHEEL_REPORT_SHOT_WIDTH=$FLYWHEEL_REPORT_SHOT_WIDTH")
    [[ -z "${JANITOR_TEST_PUBLISH_LOG:-}" ]] \
      || publish_env+=("JANITOR_TEST_PUBLISH_LOG=$JANITOR_TEST_PUBLISH_LOG")
    [[ -z "${JANITOR_TEST_REPORT_CAPTURE:-}" ]] \
      || publish_env+=("JANITOR_TEST_REPORT_CAPTURE=$JANITOR_TEST_REPORT_CAPTURE")
    [[ -z "${JANITOR_TEST_NODE_MODE:-}" ]] \
      || publish_env+=("JANITOR_TEST_NODE_MODE=$JANITOR_TEST_NODE_MODE")
    exec /usr/bin/env -i "${publish_env[@]}" \
        "$timeout_bin" --signal=TERM --kill-after=5s "${PUBLISH_TIMEOUT_SECONDS}s" \
        "$node_bin" "$COMM_CLI" publish-report \
        --html "$report_file" \
        --project "$REPORT_PROJECT" \
        --channel "$REPORT_CHANNEL" \
        --title "日志 Janitor 清理报告"
  )
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
      audit_event all skip "$report_file" 0 "report-delivery-timeout"
    else
      audit_event all skip "$report_file" 0 "report-delivery-failed-rc-$rc"
    fi
    return 1
  fi
  audit_event all report-delivered "$report_file" 0 "discord-channel-$REPORT_CHANNEL"
  rm -f "$report_file" || return 1
}

drain_pending_reports() {
  local report_file delivered=0 remaining
  [[ -d "$REPORT_PENDING_DIR" && ! -L "$REPORT_PENDING_DIR" ]] || {
    audit_event all skip "$REPORT_PENDING_DIR" 0 "report-queue-unavailable"
    return 1
  }
  while IFS= read -r report_file; do
    [[ "$delivered" -lt "$REPORT_DRAIN_LIMIT" ]] || break
    publish_report_file "$report_file" || return 1
    delivered=$((delivered + 1))
  done < <(find "$REPORT_PENDING_DIR" -type f -name '*.html' -print 2>/dev/null | LC_ALL=C sort)
  remaining="$(find "$REPORT_PENDING_DIR" -type f -name '*.html' -print 2>/dev/null | sed -n '1p')"
  if [[ -n "$remaining" ]]; then
    audit_event all skip "$remaining" 0 "report-drain-limit-reached"
    return 1
  fi
  return 0
}

rotate_audit_if_needed() {
  [[ -e "$AUDIT_FILE" ]] || return 0
  if [[ -L "$AUDIT_FILE" || ! -f "$AUDIT_FILE" ]]; then
    die "audit path must be a regular non-symlink file: $AUDIT_FILE"
  fi
  local bytes
  bytes="$(file_size "$AUDIT_FILE")"
  if [[ "$bytes" -gt 10485760 ]]; then
    mv -f "$AUDIT_FILE" "$AUDIT_FILE.1" || die "cannot rotate audit log"
  fi
}

release_lock() {
  [[ "$LOCK_OWNED" -eq 1 ]] || return 0
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
  LOCK_OWNED=0
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid" || die "cannot write lock pid"
    LOCK_OWNED=1
    return 0
  fi

  local holder=""
  if [[ -r "$LOCK_DIR/pid" ]]; then
    IFS= read -r holder < "$LOCK_DIR/pid" || holder=""
  fi
  if [[ ! "$holder" =~ ^[0-9]+$ ]]; then
    log "skip: lock-held (pid missing or unreadable)"
    return 1
  fi
  if kill -0 "$holder" 2>/dev/null; then
    log "skip: lock-held by pid $holder"
    return 1
  fi

  rm -f "$LOCK_DIR/pid" 2>/dev/null || return 1
  rmdir "$LOCK_DIR" 2>/dev/null || return 1
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid" || die "cannot write lock pid"
    LOCK_OWNED=1
    return 0
  fi
  log "skip: lock-held after stale-lock retry"
  return 1
}

module_enabled() {
  local module="$1"
  [[ -z "$ONLY_MODULE" || "$ONLY_MODULE" == "$module" ]] || return 1
  [[ "$DISABLED_MODULES" != *",$module,"* ]]
}

resolve_lsof() {
  if [[ -n "${LSOF_BIN+x}" ]]; then
    [[ -n "$LSOF_BIN" && -x "$LSOF_BIN" ]] && printf '%s\n' "$LSOF_BIN" || printf '\n'
    return
  fi
  if command -v lsof >/dev/null 2>&1; then command -v lsof; return; fi
  [[ -x /usr/sbin/lsof ]] && { printf '/usr/sbin/lsof\n'; return; }
  printf '\n'
}

resolve_xargs() {
  if command -v xargs >/dev/null 2>&1; then command -v xargs; return; fi
  [[ -x /usr/bin/xargs ]] && { printf '/usr/bin/xargs\n'; return; }
  printf '\n'
}

LSOF_OUTPUT=""
probe_open_candidates() {
  local module="$1" line canonical
  shift
  local lsof_bin xargs_bin rc
  lsof_bin="$(resolve_lsof)"
  xargs_bin="$(resolve_xargs)"
  if [[ -z "$lsof_bin" || -z "$xargs_bin" ]]; then
    audit_event "$module" skip "" 0 "lsof-or-xargs-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 1
  fi
  # xargs maps every child exit in 1..125 to 123, which would otherwise make a
  # broken lsof (for example rc=127) indistinguishable from lsof's normal
  # no-match rc=1. The wrapper emits an explicit sentinel and exits 255 for
  # every non-{0,1} lsof result; xargs then stops with rc=124.
  # The single-quoted program expands later in the /bin/sh child.
  # shellcheck disable=SC2016
  LSOF_OUTPUT="$(printf '%s\0' "$@" | "$xargs_bin" -0 /bin/sh -c '
    lsof_bin="$1"
    shift
    output="$("$lsof_bin" -F n -- "$@" 2>/dev/null)"
    rc=$?
    printf "%s\n" "$output"
    case "$rc" in
      0|1) exit 0 ;;
      *) printf "\n__FLYWHEEL_LSOF_ERROR__:%s\n" "$rc"; exit 255 ;;
    esac
  ' janitor-lsof "$lsof_bin" 2>/dev/null)"
  rc=$?
  if [[ "$LSOF_OUTPUT" == *"__FLYWHEEL_LSOF_ERROR__:"* ]]; then
    audit_event "$module" skip "" 0 "lsof-failed-rc-$rc"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 1
  fi
  case "$rc" in
    0|1|123) ;;
    *)
      audit_event "$module" skip "" 0 "lsof-failed-rc-$rc"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 1
      ;;
  esac
  OPEN_CANONICALS=$'\n'
  while IFS= read -r line; do
    [[ "$line" == n* ]] || continue
    canonical="$(canonical_existing_path "${line#n}")" || continue
    OPEN_CANONICALS+="$canonical"$'\n'
  done <<< "$LSOF_OUTPUT"
  return 0
}

path_is_open() {
  local path="$1" canonical
  canonical="$(canonical_existing_path "$path")" || return 0
  [[ "$OPEN_CANONICALS" == *$'\n'"$canonical"$'\n'* ]] && return 0
  return 1
}

record_candidate() {
  local module="$1" path="$2" reason="$3" retention_days="$4" check_open="${5:-1}"
  local bytes action current_mtime cutoff
  if ! is_allowed_target "$path"; then
    audit_event "$module" skip "$path" 0 "outside-allowlist-or-symlink"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  if [[ "$check_open" -eq 1 ]] && path_is_open "$path"; then
    audit_event "$module" skip "$path" 0 "open-file"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  current_mtime="$(file_mtime "$path")" || {
    audit_event "$module" skip "$path" 0 "restat-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  cutoff=$(( $(date +%s) - retention_days * 86400 ))
  if [[ "$current_mtime" -ge "$cutoff" ]]; then
    audit_event "$module" skip "$path" 0 "became-recent"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  bytes="$(file_size "$path")"
  if [[ "$MODE" == "dry-run" ]]; then
    action="would-delete"
  else
    action="delete"
    audit_event "$module" delete-intent "$path" "$bytes" "$reason"
    if ! rm -f -- "$path"; then
      audit_event "$module" skip "$path" "$bytes" "delete-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
    fi
    note_deleted_mtime "$current_mtime"
  fi
  audit_event "$module" "$action" "$path" "$bytes" "$reason"
  printf '[log-janitor] %s %s (%s bytes)\n' "$action" "$path" "$bytes"
  CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
  CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
  if [[ "$MODE" == "apply" ]]; then
    DELETED_COUNT=$((DELETED_COUNT + 1))
    DELETED_FILE_COUNT=$((DELETED_FILE_COUNT + 1))
    FREED_BYTES=$((FREED_BYTES + bytes))
  fi
}

load_session_ledgers() {
  local module="$1" ledger_root="$HOME/.flywheel/state/codex-sessions" file row thread execution db_row rc
  LEDGER_THREADS=()
  LEDGER_EXECUTIONS=()
  DB_EXECUTIONS=()
  DB_STATUSES=()
  if ! command -v sqlite3 >/dev/null 2>&1 \
    || [[ ! -f "$TEAMLEAD_DB" || -L "$TEAMLEAD_DB" ]]; then
    audit_event "$module" skip "$TEAMLEAD_DB" 0 "teamlead-db-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 1
  fi
  db_row="$(sqlite3 -batch -noheader -separator $'\t' \
    "file:$TEAMLEAD_DB?mode=ro" \
    'SELECT execution_id, status FROM sessions;' 2>/dev/null)"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    audit_event "$module" skip "$TEAMLEAD_DB" 0 "teamlead-db-query-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 1
  fi
  while IFS=$'\t' read -r execution row; do
    [[ -n "$execution" && -n "$row" ]] || continue
    DB_EXECUTIONS+=("$execution")
    DB_STATUSES+=("$row")
  done <<< "$db_row"

  [[ -d "$ledger_root" && ! -L "$ledger_root" ]] || return 0
  while IFS= read -r -d '' file; do
    row="$(jq -er '[.threadId,.executionId] | if all(.[]; type == "string" and length > 0) then @tsv else error("invalid") end' "$file" 2>/dev/null)"
    rc=$?
    if [[ "$rc" -ne 0 ]]; then
      audit_event "$module" skip "$file" 0 "session-ledger-invalid"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 1
    fi
    IFS=$'\t' read -r thread execution <<< "$row"
    LEDGER_THREADS+=("$thread")
    LEDGER_EXECUTIONS+=("$execution")
  done < <(find "$ledger_root" -type f -name session.json -print0 2>/dev/null)
}

terminal_session_status() {
  case "$1" in
    completed|failed|terminated|blocked|rejected|deferred|shelved) return 0 ;;
    *) return 1 ;;
  esac
}

session_ledger_allows_delete() {
  local thread="$1" i j execution status
  for ((i = 0; i < ${#LEDGER_THREADS[@]}; i++)); do
    [[ "${LEDGER_THREADS[$i]}" == "$thread" ]] || continue
    execution="${LEDGER_EXECUTIONS[$i]}"
    status=""
    for ((j = 0; j < ${#DB_EXECUTIONS[@]}; j++)); do
      if [[ "${DB_EXECUTIONS[$j]}" == "$execution" ]]; then
        status="${DB_STATUSES[$j]}"
        break
      fi
    done
    [[ -n "$status" ]] || return 1
    terminal_session_status "$status" || return 1
  done
  # No ledger match means a manual/rescue Codex session: age+lsof remain the
  # authority. One or more matches are deletable only when every binding is
  # irreversibly terminal.
  return 0
}

session_thread_id() {
  local name="${1##*/}"
  if [[ "$name" =~ ([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\.jsonl$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

run_codex_sessions() {
  local module="codex_sessions" root file thread
  local -a candidates=()
  root="${CODEX_HOMES[0]}/sessions"
  [[ -d "$root" && ! -L "$root" ]] || return 0
  load_session_ledgers "$module" || return 0
  while IFS= read -r -d '' file; do candidates+=("$file"); done \
    < <(collect_expired_files "$root" "$RETENTION_CODEX_SESSIONS")
  [[ ${#candidates[@]} -gt 0 ]] || return 0
  probe_open_candidates "$module" "${candidates[@]}" || return 0
  for file in "${candidates[@]}"; do
    thread="$(session_thread_id "$file")" || {
      audit_event "$module" skip "$file" 0 "thread-id-unparseable"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    }
    if ! session_ledger_allows_delete "$thread"; then
      audit_event "$module" skip "$file" 0 "session-not-terminal-or-db-row-missing"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    record_candidate "$module" "$file" "retention-exceeded-terminal" "$RETENTION_CODEX_SESSIONS"
  done
}

collect_expired_files() {
  local root="$1" days="$2" coarse_days
  [[ -d "$root" && ! -L "$root" ]] || return 0
  if [[ "$days" -eq 0 ]]; then
    find "$root" -type f -print0 2>/dev/null
  else
    coarse_days=$((days - 1))
    # find rounds age down to complete 24-hour buckets. Scan the preceding
    # bucket, then record_candidate's epoch re-stat enforces the exact cutoff.
    find "$root" -type f -mtime "+$coarse_days" -print0 2>/dev/null
  fi
}

resolve_current_release() {
  local home="$1" releases current target
  releases="$home/packages/standalone/releases"
  current="$home/packages/standalone/current"
  [[ -d "$releases" && ! -L "$releases" && -e "$current" ]] || return 1
  releases="$(normalize_existing_root "$releases")" || return 1
  target="$(physical_dir "$current")" || return 1
  [[ "$target" == "$releases/"* && "$target" != "$releases" && -d "$target" ]] || return 1
  printf '%s\n' "$target"
}

version_name_valid() {
  release_version_key "$1" >/dev/null
}

release_version_key() {
  if [[ "$1" =~ ^([0-9]+\.[0-9]+\.[0-9]+)(-[0-9A-Za-z._-]+)?$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

version_less_than() {
  local left="$1" right="$2" first
  [[ "$left" != "$right" ]] || return 1
  first="$(printf '%s\n%s\n' "$left" "$right" | LC_ALL=C sort -V | sed -n '1p')"
  [[ "$first" == "$left" ]]
}

record_release_candidate() {
  local home="$1" path="$2" current releases parent mtime cutoff bytes action deleted_files=0
  current="$(resolve_current_release "$home")" || {
    audit_event codex_releases skip "$path" 0 "current-unresolvable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  releases="$(normalize_existing_root "$home/packages/standalone/releases")" || return 0
  parent="$(physical_dir "${path%/*}")" || return 0
  if [[ "$path" == "$current" || "$parent" != "$releases" ]] || ! is_allowed_target "$path"; then
    audit_event codex_releases skip "$path" 0 "release-path-safety-check-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  if release_tree_is_open "$path"; then
    return 0
  fi
  mtime="$(file_mtime "$path")" || {
    audit_event codex_releases skip "$path" 0 "restat-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  cutoff=$(( $(date +%s) - 86400 ))
  if [[ "$mtime" -ge "$cutoff" ]]; then
    audit_event codex_releases skip "$path" 0 "release-younger-than-24h"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  bytes="$(directory_size "$path")"
  if [[ "$MODE" == "dry-run" ]]; then
    action="would-delete"
  else
    action="delete"
    deleted_files="$(directory_file_count "$path")"
    audit_event codex_releases delete-intent "$path" "$bytes" "superseded-release"
    if ! rm -rf -- "$path"; then
      audit_event codex_releases skip "$path" "$bytes" "delete-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
    fi
    note_deleted_mtime "$mtime"
  fi
  audit_event codex_releases "$action" "$path" "$bytes" "superseded-release"
  printf '[log-janitor] %s %s (%s bytes)\n' "$action" "$path" "$bytes"
  CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
  CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
  if [[ "$MODE" == "apply" ]]; then
    DELETED_COUNT=$((DELETED_COUNT + 1))
    DELETED_FILE_COUNT=$((DELETED_FILE_COUNT + deleted_files))
    FREED_BYTES=$((FREED_BYTES + bytes))
  fi
}

release_tree_is_open() {
  local path="$1" lsof_bin output rc
  lsof_bin="$(resolve_lsof)"
  if [[ -z "$lsof_bin" ]]; then
    audit_event codex_releases skip "$path" 0 "release-lsof-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  output="$("$lsof_bin" -F n +D "$path" 2>&1)"
  rc=$?
  case "$rc" in
    0)
      audit_event codex_releases skip "$path" 0 "release-tree-in-use"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
      ;;
    1)
      if [[ -z "$output" ]]; then
        return 1
      fi
      if [[ "$output" == n* || "$output" == *$'\n'n* ]]; then
        audit_event codex_releases skip "$path" 0 "release-tree-in-use"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        return 0
      fi
      audit_event codex_releases skip "$path" 0 "release-lsof-failed-rc-1"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
      ;;
    *)
      audit_event codex_releases skip "$path" 0 "release-lsof-failed-rc-$rc"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
      ;;
  esac
}

run_codex_releases() {
  local home releases current current_name current_key dir name name_key keep_remaining
  local -a older_names=()
  for home in "${CODEX_HOMES[@]}"; do
    releases="$home/packages/standalone/releases"
    [[ -d "$releases" && ! -L "$releases" ]] || continue
    current="$(resolve_current_release "$home")" || {
      audit_event codex_releases skip "$home/packages/standalone/current" 0 "current-unresolvable"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    }
    current_name="${current##*/}"
    current_key="$(release_version_key "$current_name")" || {
      audit_event codex_releases skip "$current" 0 "current-version-unparseable"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    }
    older_names=()
    while IFS= read -r -d '' dir; do
      name="${dir##*/}"
      if ! version_name_valid "$name"; then
        audit_event codex_releases skip "$dir" 0 "unparseable-version"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
      fi
      name_key="$(release_version_key "$name")" || continue
      if version_less_than "$name_key" "$current_key"; then
        older_names+=("$name")
      fi
    done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

    [[ ${#older_names[@]} -gt 0 ]] || continue
    keep_remaining=$((KEEP_RELEASES - 1))
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      if [[ "$keep_remaining" -gt 0 ]]; then
        keep_remaining=$((keep_remaining - 1))
        continue
      fi
      record_release_candidate "$home" "$releases/$name"
    done < <(printf '%s\n' "${older_names[@]}" | LC_ALL=C sort -Vr)
  done
}

run_codex_artifacts() {
  local module="codex_artifacts" home root file
  local -a candidates=()

  root="${CODEX_HOMES[0]}/archived_sessions"
  while IFS= read -r -d '' file; do candidates+=("$file"); done \
    < <(collect_expired_files "$root" "$RETENTION_CODEX_ARTIFACTS")
  for home in "${CODEX_HOMES[@]}"; do
    root="$home/generated_images"
    while IFS= read -r -d '' file; do candidates+=("$file"); done \
      < <(collect_expired_files "$root" "$RETENTION_CODEX_ARTIFACTS")
  done
  [[ ${#candidates[@]} -gt 0 ]] || return 0
  probe_open_candidates "$module" "${candidates[@]}" || return 0
  for file in "${candidates[@]}"; do
    record_candidate "$module" "$file" "retention-exceeded" "$RETENTION_CODEX_ARTIFACTS"
  done
}

run_claude_orphans() {
  local module="claude_orphans" file subagents_dir session_dir parent coarse_days
  local -a candidates=()
  [[ -d "$CLAUDE_PROJECTS" && ! -L "$CLAUDE_PROJECTS" ]] || return 0
  coarse_days=$((RETENTION_CLAUDE_ORPHANS > 0 ? RETENTION_CLAUDE_ORPHANS - 1 : 0))
  if [[ "$RETENTION_CLAUDE_ORPHANS" -eq 0 ]]; then
    while IFS= read -r -d '' file; do candidates+=("$file"); done \
      < <(find "$CLAUDE_PROJECTS" -type f -path '*/subagents/*.jsonl' -print0 2>/dev/null)
  else
    while IFS= read -r -d '' file; do candidates+=("$file"); done \
      < <(find "$CLAUDE_PROJECTS" -type f -path '*/subagents/*.jsonl' \
        -mtime "+$coarse_days" -print0 2>/dev/null)
  fi
  [[ ${#candidates[@]} -gt 0 ]] || return 0
  for file in "${candidates[@]}"; do
    subagents_dir="${file%/*}"
    session_dir="${subagents_dir%/*}"
    parent="$session_dir.jsonl"
    [[ ! -e "$parent" ]] || continue
    record_candidate "$module" "$file" "orphaned-subagent" "$RETENTION_CLAUDE_ORPHANS" 0
  done
}

status_field() {
  local output="$1" key="$2"
  printf '%s\n' "$output" | sed -n "s/^${key}=//p" | sed -n '1p'
}

run_codex_logs_db() {
  local module="codex_logs_db" guard="$SCRIPT_DIR/codex-log-guard.sh"
  local home db status rc exists in_use table_count before after reclaimed
  if [[ ! -x "$guard" ]]; then
    audit_event "$module" skip "$guard" 0 "codex-log-guard-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  for home in "${CODEX_HOMES[@]}"; do
    db="$home/logs_2.sqlite"
    if [[ "$MODE" == "apply" ]]; then
      CODEX_LOG_DB="$db" "$guard" monitor >/dev/null 2>&1
      rc=$?
      if [[ "$rc" -ne 0 ]]; then
        audit_event "$module" skip "$db" 0 "monitor-failed"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
      fi
    fi
    status="$(CODEX_LOG_DB="$db" "$guard" status 2>/dev/null)"
    rc=$?
    if [[ "$rc" -ne 0 ]]; then
      audit_event "$module" skip "$db" 0 "status-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    exists="$(status_field "$status" db_exists)"
    in_use="$(status_field "$status" in_use)"
    if [[ "$exists" != "yes" ]]; then
      audit_event "$module" skip "$db" 0 "db-missing"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    if [[ -L "$db" || "$in_use" != "no" ]]; then
      audit_event "$module" skip "$db" 0 "db-in-use-or-unsafe"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    table_count="$(sqlite3 "file:$db?mode=ro" \
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='logs';" 2>/dev/null)"
    rc=$?
    if [[ "$rc" -ne 0 || "$table_count" != "1" ]]; then
      audit_event "$module" skip "$db" 0 "logs-table-missing-or-unreadable"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    if [[ "$MODE" == "dry-run" ]]; then
      audit_event "$module" would-delete "$db" 0 "codex-log-guard-remediation"
      printf '[log-janitor] would-remediate %s\n' "$db"
      CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
      continue
    fi
    before="$(file_size "$db")"
    audit_event "$module" delete-intent "$db" 0 "codex-log-guard-remediation"
    if ! CODEX_LOG_DB="$db" "$guard" remediate >/dev/null 2>&1; then
      audit_event "$module" skip "$db" 0 "remediate-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    after="$(file_size "$db")"
    reclaimed=$((before - after))
    [[ "$reclaimed" -ge 0 ]] || reclaimed=0
    audit_event "$module" delete "$db" "$reclaimed" "codex-log-guard-remediation"
    printf '[log-janitor] remediated %s (%s bytes reclaimed)\n' "$db" "$reclaimed"
    CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
    CANDIDATE_BYTES=$((CANDIDATE_BYTES + reclaimed))
    DELETED_COUNT=$((DELETED_COUNT + 1))
    FREED_BYTES=$((FREED_BYTES + reclaimed))
  done
}

tmux_socket_lstat() {
  local path="$1"
  python3 - "$path" <<'PY' 2>/dev/null
import os
import stat
import sys

try:
    value = os.lstat(sys.argv[1])
except OSError:
    raise SystemExit(1)
if stat.S_ISLNK(value.st_mode):
    kind = "symlink"
elif stat.S_ISDIR(value.st_mode):
    kind = "directory"
elif stat.S_ISSOCK(value.st_mode):
    kind = "socket"
else:
    kind = "other"
print("%s|%d|%d|%d|%d|%d" % (
    kind,
    value.st_uid,
    stat.S_IMODE(value.st_mode),
    value.st_dev,
    value.st_ino,
    int(value.st_mtime),
))
PY
}

tmux_socket_entries() {
  local root="$1"
  python3 - "$root" <<'PY' 2>/dev/null
import os
import sys

try:
    names = sorted(os.listdir(os.fsencode(sys.argv[1])))
except OSError:
    raise SystemExit(1)
root = os.fsencode(sys.argv[1])
for name in names:
    sys.stdout.buffer.write(os.path.join(root, name) + b"\0")
PY
}

tmux_socket_allowlisted() {
  local name="$1"
  case ",$TMUX_SOCKET_ALLOWLIST," in
    *,"$name",*) return 0 ;;
    *) return 1 ;;
  esac
}

tmux_socket_probe_dead() {
  # rc=0 conclusively dead, rc=1 live, rc=2 inconclusive.
  local path="$1" timeout_bin output rc
  timeout_bin="$(resolve_timeout)"
  [[ -n "$timeout_bin" ]] || return 2
  output="$("$timeout_bin" --signal=TERM --kill-after=1s \
    "${TMUX_SOCKET_PROBE_TIMEOUT_SECONDS}s" \
    tmux -S "$path" list-sessions 2>&1)"
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    return 1
  fi
  case "$rc" in 124|137) return 2 ;; esac
  if [[ "$rc" -eq 1 ]] \
    && printf '%s\n' "$output" | grep -Eq \
      'no server running on|error connecting to .*\((No such file or directory|Connection refused)\)'; then
    return 0
  fi
  return 2
}

tmux_socket_unheld() {
  # rc=0 conclusively no holder, rc=1 held, rc=2 inconclusive.
  local path="$1" lsof_bin output rc
  lsof_bin="$(resolve_lsof)"
  [[ -n "$lsof_bin" ]] || return 2
  output="$("$lsof_bin" -t -- "$path" 2>/dev/null)"
  rc=$?
  case "$rc" in
    0) [[ -n "$output" ]] && return 1; return 2 ;;
    1) [[ -z "$output" ]] && return 0; return 2 ;;
    *) return 2 ;;
  esac
}

run_tmux_dead_sockets() {
  local module="tmux_dead_sockets" root="$TMUX_SOCKET_ROOT" root_meta
  local kind owner mode _device _inode mtime now path name meta verify_meta bytes action probe_rc holder_rc
  local deleted_this_run=0 entries_file
  if ! command -v python3 >/dev/null 2>&1; then
    audit_event "$module" skip "$root" 0 "python3-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  case "$root" in
    /*) ;;
    *) audit_event "$module" skip "$root" 0 "socket-root-not-absolute"; SKIPPED_COUNT=$((SKIPPED_COUNT + 1)); return 0 ;;
  esac
  case "$root" in *$'\n'*|*$'\r'*) audit_event "$module" skip "$root" 0 "socket-root-unsafe"; SKIPPED_COUNT=$((SKIPPED_COUNT + 1)); return 0 ;; esac
  root_meta="$(tmux_socket_lstat "$root")" || {
    audit_event "$module" skip "$root" 0 "socket-root-unreadable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  IFS='|' read -r kind owner mode _device _inode mtime <<< "$root_meta"
  if [[ "$kind" != "directory" || "$owner" != "$CURRENT_UID" ]] \
    || (( 10#$mode & 18 )); then
    audit_event "$module" skip "$root" 0 "socket-root-owner-or-mode-unsafe"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  [[ "$(physical_dir "$root")" == "$root" ]] || {
    audit_event "$module" skip "$root" 0 "socket-root-canonicalization-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  now="$(date +%s)"
  entries_file="$(mktemp "$STATE_DIR/.tmux-socket-entries.XXXXXX")" || {
    audit_event "$module" skip "$root" 0 "tmux-socket-enumeration-temp-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  if ! tmux_socket_entries "$root" > "$entries_file"; then
    rm -f "$entries_file"
    audit_event "$module" skip "$root" 0 "tmux-socket-enumeration-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  while IFS= read -r -d '' path; do
    name="${path##*/}"
    case "$name" in ""|.|..|*$'\n'*|*$'\r'*|*'|'*)
      audit_event "$module" skip "$path" 0 "socket-name-unsafe"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
      ;;
    esac
    if tmux_socket_allowlisted "$name"; then
      audit_event "$module" skip "$path" 0 "tmux-socket-allowlisted"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    meta="$(tmux_socket_lstat "$path")" || {
      audit_event "$module" skip "$path" 0 "tmux-socket-lstat-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    }
    IFS='|' read -r kind owner mode _device _inode mtime <<< "$meta"
    if [[ "$kind" != "socket" || "$owner" != "$CURRENT_UID" ]]; then
      audit_event "$module" skip "$path" 0 "tmux-socket-type-or-owner-unsafe"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    if (( 10#$mtime > 10#$now \
      || 10#$now - 10#$mtime <= 10#$TMUX_SOCKET_MIN_AGE_SECONDS )); then
      audit_event "$module" skip "$path" 0 "tmux-socket-too-recent"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    probe_rc=0
    tmux_socket_probe_dead "$path" || probe_rc=$?
    case "$probe_rc" in
      0) ;;
      1) audit_event "$module" skip "$path" 0 "tmux-socket-server-live"; SKIPPED_COUNT=$((SKIPPED_COUNT + 1)); continue ;;
      *) audit_event "$module" skip "$path" 0 "tmux-socket-probe-inconclusive"; SKIPPED_COUNT=$((SKIPPED_COUNT + 1)); continue ;;
    esac
    holder_rc=0
    tmux_socket_unheld "$path" || holder_rc=$?
    case "$holder_rc" in
      0) ;;
      1) audit_event "$module" skip "$path" 0 "tmux-socket-held"; SKIPPED_COUNT=$((SKIPPED_COUNT + 1)); continue ;;
      *) audit_event "$module" skip "$path" 0 "tmux-socket-lsof-inconclusive"; SKIPPED_COUNT=$((SKIPPED_COUNT + 1)); continue ;;
    esac
    verify_meta="$(tmux_socket_lstat "$path")" || verify_meta=""
    if [[ "$verify_meta" != "$meta" ]]; then
      audit_event "$module" skip "$path" 0 "tmux-socket-identity-drift"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    bytes="$(file_size "$path")"
    if [[ "$MODE" == "dry-run" ]]; then
      action="would-delete"
    elif (( deleted_this_run >= TMUX_SOCKET_DELETE_CAP )); then
      audit_event "$module" skip "$path" "$bytes" "tmux-socket-delete-cap-deferred"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    else
      action="delete"
      audit_event "$module" delete-intent "$path" "$bytes" "dead-tmux-socket"
      verify_meta="$(tmux_socket_lstat "$path")" || verify_meta=""
      if [[ "$verify_meta" != "$meta" ]]; then
        audit_event "$module" skip "$path" "$bytes" "tmux-socket-identity-drift"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
      fi
      if ! rm -f -- "$path" || [[ -e "$path" || -L "$path" ]]; then
        audit_event "$module" skip "$path" "$bytes" "tmux-socket-delete-failed"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
      fi
      deleted_this_run=$((deleted_this_run + 1))
      note_deleted_mtime "$mtime"
    fi
    audit_event "$module" "$action" "$path" "$bytes" "dead-tmux-socket"
    printf '[log-janitor] %s %s (%s bytes)\n' "$action" "$path" "$bytes"
    CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
    CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
    if [[ "$MODE" == "apply" ]]; then
      DELETED_COUNT=$((DELETED_COUNT + 1))
      DELETED_FILE_COUNT=$((DELETED_FILE_COUNT + 1))
      FREED_BYTES=$((FREED_BYTES + bytes))
    fi
  done < "$entries_file"
  rm -f "$entries_file"
}

run_gate_markers() {
  local module="gate_markers" scan_file scan_rc backlog=0 archive_day
  local kind path bytes mtime reason execution destination destination_dir current_mtime
  local deleted_this_run=0 i state_root marker_root archive_parent archive_root
  local -a candidate_kinds=() candidate_paths=() candidate_bytes=()
  local -a candidate_mtimes=() candidate_reasons=() candidate_executions=()

  if [[ ! -f "$TEAMLEAD_DB" || -L "$TEAMLEAD_DB" ]]; then
    audit_event "$module" skip "$TEAMLEAD_DB" 0 "teamlead-db-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  [[ -d "$FLYWHEEL_STATE_ROOT" && ! -L "$FLYWHEEL_STATE_ROOT" ]] || {
    audit_event "$module" skip "$FLYWHEEL_STATE_ROOT" 0 "state-root-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  state_root="$(physical_dir "$FLYWHEEL_STATE_ROOT")" || return 0
  [[ -d "$GATE_MARKER_DIR" && ! -L "$GATE_MARKER_DIR" ]] || return 0
  marker_root="$(physical_dir "$GATE_MARKER_DIR")" || {
    audit_event "$module" skip "$GATE_MARKER_DIR" 0 "gate-marker-root-unresolvable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  if [[ "$marker_root" != "$state_root/codex-gates" ]]; then
    audit_event "$module" skip "$GATE_MARKER_DIR" 0 "gate-marker-root-outside-policy"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  archive_parent="$(physical_dir "${GATE_ARCHIVE_DIR%/*}")" || archive_parent=""
  if [[ "$archive_parent" != "$state_root" || "${GATE_ARCHIVE_DIR##*/}" != "codex-gates-archive" ]]; then
    audit_event "$module" skip "$GATE_ARCHIVE_DIR" 0 "gate-archive-root-outside-policy"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  command -v python3 >/dev/null 2>&1 || {
    audit_event "$module" skip "$GATE_MARKER_DIR" 0 "python3-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }

  scan_file="$(mktemp "$STATE_DIR/.gate-markers.XXXXXX")" || die "cannot allocate gate marker scan"
  python3 - "$TEAMLEAD_DB" "$marker_root" "$GATE_MARKER_RETENTION_SECONDS" "$WAKE_TERMINAL_STATUSES" > "$scan_file" <<'PY'
import datetime as dt
import json
import os
import re
import sqlite3
import stat
import sys

db_path, marker_root, retention_raw, terminal_raw = sys.argv[1:]
retention_seconds = int(retention_raw)
terminal = set(terminal_raw.split("|"))
connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
try:
    sessions = {
        str(execution_id): str(status)
        for execution_id, status in connection.execute(
            "SELECT execution_id, status FROM sessions"
        )
    }
finally:
    connection.close()

now = dt.datetime.now(dt.timezone.utc).timestamp()
safe_name = re.compile(r"^[A-Za-z0-9_-]+\.json$")

def parse_iso(value):
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    parsed = dt.datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.timestamp()

for source_kind, root in (("main", marker_root), ("ask", os.path.join(marker_root, "ask"))):
    if not os.path.isdir(root) or os.path.islink(root):
        continue
    with os.scandir(root) as entries:
        for entry in entries:
            if not safe_name.fullmatch(entry.name) or not entry.is_file(follow_symlinks=False):
                continue
            info = entry.stat(follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                continue
            path = entry.path
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    marker = json.load(handle)
                execution_id = marker.get("executionId")
                if not isinstance(execution_id, str) or not execution_id:
                    raise ValueError("executionId missing")
                answered_at = marker.get("answeredAt")
                answered_epoch = parse_iso(answered_at) if answered_at is not None else None
                if answered_at is not None and answered_epoch is None:
                    raise ValueError("answeredAt invalid")
            except Exception:
                print("\t".join(("backlog", source_kind, path, str(info.st_size), str(int(info.st_mtime)), "corrupt-marker", "")))
                continue
            status_value = sessions.get(execution_id)
            if status_value is None:
                print("\t".join(("backlog", source_kind, path, str(info.st_size), str(int(info.st_mtime)), "missing-session", execution_id)))
                continue
            answered_old = answered_epoch is not None and now - answered_epoch > retention_seconds
            terminal_old = status_value in terminal and now - info.st_mtime > retention_seconds
            if answered_old or terminal_old:
                reason = "answered-retention-exceeded" if answered_old else "wake-terminal-retention-exceeded"
                classification = "candidate"
            else:
                reason = "not-settled-or-recent"
                classification = "preserve"
            print("\t".join((classification, source_kind, path, str(info.st_size), str(int(info.st_mtime)), reason, execution_id)))
PY
  scan_rc=$?
  if [[ "$scan_rc" -ne 0 ]]; then
    rm -f "$scan_file"
    audit_event "$module" skip "$TEAMLEAD_DB" 0 "teamlead-db-query-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi

  while IFS=$'\t' read -r reason kind path bytes mtime execution destination; do
    case "$reason" in
      candidate)
        candidate_kinds+=("$kind")
        candidate_paths+=("$path")
        candidate_bytes+=("$bytes")
        candidate_mtimes+=("$mtime")
        candidate_reasons+=("$execution")
        candidate_executions+=("$destination")
        ;;
      backlog)
        backlog=$((backlog + 1))
        audit_event "$module" skip "$path" "$bytes" "$execution"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        ;;
      preserve)
        audit_event "$module" skip "$path" "$bytes" "$execution"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        ;;
    esac
  done < "$scan_file"
  rm -f "$scan_file"

  if [[ "$backlog" -gt "$GATE_MARKER_BACKLOG_ALERT_THRESHOLD" ]]; then
    audit_event "$module" skip "$GATE_MARKER_DIR" 0 "gate-marker-backlog-alert:$backlog"
    log "WARNING: gate marker unclassified backlog $backlog exceeds $GATE_MARKER_BACKLOG_ALERT_THRESHOLD"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
  fi
  [[ ${#candidate_paths[@]} -gt 0 ]] || return 0
  probe_open_candidates "$module" "${candidate_paths[@]}" || return 0
  archive_day="$(date -u +%Y%m%d)"

  for ((i = 0; i < ${#candidate_paths[@]}; i++)); do
    kind="${candidate_kinds[$i]}"
    path="${candidate_paths[$i]}"
    bytes="${candidate_bytes[$i]}"
    mtime="${candidate_mtimes[$i]}"
    reason="${candidate_reasons[$i]}"
    execution="${candidate_executions[$i]}"
    if ! is_allowed_target "$path" || path_is_open "$path"; then
      audit_event "$module" skip "$path" "$bytes" "outside-policy-or-open"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    current_mtime="$(file_mtime "$path")" || current_mtime=""
    if [[ "$current_mtime" != "$mtime" || "$(file_size "$path")" != "$bytes" ]]; then
      audit_event "$module" skip "$path" "$bytes" "marker-identity-drift"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    destination_dir="$GATE_ARCHIVE_DIR/$archive_day/$kind"
    destination="$destination_dir/${path##*/}"
    if [[ "$MODE" == "dry-run" ]]; then
      audit_event "$module" would-archive "$path" "$bytes" "$reason:$execution"
      CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
      CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
      continue
    fi
    if [[ "$deleted_this_run" -ge "$GATE_MARKER_DELETE_CAP" ]]; then
      audit_event "$module" skip "$path" "$bytes" "gate-marker-delete-cap-deferred"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    if [[ -L "$GATE_ARCHIVE_DIR" ]]; then
      audit_event "$module" skip "$path" "$bytes" "gate-archive-root-symlink"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    mkdir -p "$destination_dir" || die "cannot create gate marker archive directory"
    archive_root="$(physical_dir "$GATE_ARCHIVE_DIR")" || die "cannot resolve gate marker archive"
    if [[ "$archive_root" != "$state_root/codex-gates-archive" \
      || "$(physical_dir "$destination_dir")" != "$archive_root/$archive_day/$kind" \
      || -e "$destination" || -L "$destination" ]]; then
      audit_event "$module" skip "$path" "$bytes" "gate-archive-destination-unsafe-or-exists"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    audit_event "$module" archive-intent "$path" "$bytes" "$reason:$execution"
    if ! mv -n "$path" "$destination" || [[ -e "$path" || -L "$path" ]]; then
      audit_event "$module" skip "$path" "$bytes" "gate-marker-archive-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    audit_event "$module" archive "$destination" "$bytes" "$reason:$execution"
    note_deleted_mtime "$mtime"
    deleted_this_run=$((deleted_this_run + 1))
    CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
    CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
    DELETED_COUNT=$((DELETED_COUNT + 1))
    DELETED_FILE_COUNT=$((DELETED_FILE_COUNT + 1))
  done
}

directory_tree_is_open() {
  local module="$1" path="$2" lsof_bin output rc
  lsof_bin="$(resolve_lsof)"
  if [[ -z "$lsof_bin" ]]; then
    audit_event "$module" skip "$path" 0 "directory-lsof-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  output="$("$lsof_bin" -F n +D "$path" 2>&1)"
  rc=$?
  case "$rc" in
    0)
      audit_event "$module" skip "$path" 0 "directory-tree-in-use"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
      ;;
    1)
      if [[ -z "$output" ]]; then return 1; fi
      ;;
  esac
  audit_event "$module" skip "$path" 0 "directory-lsof-inconclusive-rc-$rc"
  SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
  return 0
}

record_state_directory_delete() {
  local module="$1" path="$2" reason="$3" expected_root="$4"
  local canonical mtime bytes files action
  [[ -d "$path" && ! -L "$path" ]] || return 0
  canonical="$(physical_dir "$path")" || return 0
  if [[ "$canonical" != "$expected_root" ]]; then
    audit_event "$module" skip "$path" 0 "state-directory-outside-policy"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  directory_tree_is_open "$module" "$path" && return 0
  mtime="$(file_mtime "$path")" || return 0
  bytes="$(directory_size "$path")"
  files="$(directory_file_count "$path")"
  if [[ "$MODE" == "dry-run" ]]; then
    action="would-delete"
  else
    action="delete"
    audit_event "$module" delete-intent "$path" "$bytes" "$reason"
    if [[ "$(physical_dir "$path")" != "$expected_root" ]] || ! rm -rf -- "$path"; then
      audit_event "$module" skip "$path" "$bytes" "state-directory-delete-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      return 0
    fi
    note_deleted_mtime "$mtime"
  fi
  audit_event "$module" "$action" "$path" "$bytes" "$reason"
  CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
  CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
  if [[ "$MODE" == "apply" ]]; then
    DELETED_COUNT=$((DELETED_COUNT + 1))
    DELETED_FILE_COUNT=$((DELETED_FILE_COUNT + files))
    FREED_BYTES=$((FREED_BYTES + bytes))
  fi
}

run_state_residue() {
  local module="state_residue" state_root marker_root gate_archive_root
  local archive_root cache clone archive_cutoff dir file name mtime cutoff bytes files
  local destination destination_parent
  local -a loose_gate_archives=()
  state_root="$(physical_dir "$FLYWHEEL_STATE_ROOT" 2>/dev/null)" || {
    audit_event "$module" skip "$FLYWHEEL_STATE_ROOT" 0 "state-root-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  marker_root="$(physical_dir "$GATE_MARKER_DIR" 2>/dev/null)" || marker_root=""
  gate_archive_root="$(physical_dir "$GATE_ARCHIVE_DIR" 2>/dev/null)" || gate_archive_root=""
  archive_root="$(physical_dir "$FLYWHEEL_ARCHIVE_ROOT" 2>/dev/null)" || {
    audit_event "$module" skip "$FLYWHEEL_ARCHIVE_ROOT" 0 "archive-root-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }

  cache="$FLYWHEEL_STATE_ROOT/fly2054-playwright"
  if [[ -d "$cache" && ! -L "$cache" ]]; then
    mtime="$(file_mtime "$cache")" || mtime=""
    cutoff=$(( $(date +%s) - 14 * 86400 ))
    if [[ "$mtime" =~ ^[0-9]+$ && "$mtime" -lt "$cutoff" ]]; then
      record_state_directory_delete "$module" "$cache" "regenerable-cache-retention-exceeded" "$state_root/fly2054-playwright"
    fi
  fi

  clone="$GATE_MARKER_DIR/FLY-2024-xhs-mcp"
  if [[ -n "$marker_root" && -d "$clone" && ! -L "$clone" \
    && "$(physical_dir "$clone" 2>/dev/null)" == "$marker_root/FLY-2024-xhs-mcp" ]]; then
    if ! directory_tree_is_open "$module" "$clone"; then
      bytes="$(directory_size "$clone")"
      files="$(directory_file_count "$clone")"
      destination_parent="$STATE_RESIDUE_ARCHIVE_DIR"
      destination="$destination_parent/FLY-2024-xhs-mcp"
      if [[ "$MODE" == "dry-run" ]]; then
        audit_event "$module" would-archive "$clone" "$bytes" "misplaced-repository-clone"
        CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
        CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
      else
        if [[ -L "$STATE_RESIDUE_ARCHIVE_DIR" ]]; then
          audit_event "$module" skip "$clone" "$bytes" "state-residue-archive-symlink"
          SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        else
          mkdir -p "$destination_parent" || die "cannot create state residue archive"
          if [[ "$(physical_dir "$destination_parent")" != "$archive_root/state-residue" \
            || -e "$destination" || -L "$destination" ]]; then
            audit_event "$module" skip "$clone" "$bytes" "state-residue-destination-unsafe-or-exists"
            SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
          else
            audit_event "$module" archive-intent "$clone" "$bytes" "misplaced-repository-clone"
            if mv -n "$clone" "$destination" && [[ ! -e "$clone" && ! -L "$clone" ]]; then
              audit_event "$module" archive "$destination" "$bytes" "misplaced-repository-clone"
              CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
              CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
              DELETED_COUNT=$((DELETED_COUNT + 1))
              DELETED_FILE_COUNT=$((DELETED_FILE_COUNT + files))
            else
              audit_event "$module" skip "$clone" "$bytes" "state-residue-archive-failed"
              SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
            fi
          fi
        fi
      fi
    fi
  fi

  [[ -n "$gate_archive_root" ]] || return 0
  archive_cutoff="$(date -u -v-30d +%Y%m%d 2>/dev/null \
    || date -u -d '30 days ago' +%Y%m%d 2>/dev/null)" || {
    audit_event "$module" skip "$GATE_ARCHIVE_DIR" 0 "archive-cutoff-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  while IFS= read -r -d '' dir; do
    name="${dir##*/}"
    [[ "$name" =~ ^[0-9]{8}$ && "$name" < "$archive_cutoff" ]] || continue
    record_state_directory_delete "$module" "$dir" "gate-archive-retention-exceeded" "$gate_archive_root/$name"
  done < <(find "$GATE_ARCHIVE_DIR" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

  cutoff=$(( $(date +%s) - 30 * 86400 ))
  while IFS= read -r -d '' file; do
    name="${file##*/}"
    [[ "$name" =~ ^[A-Za-z0-9_-]+\.json$ ]] || continue
    mtime="$(file_mtime "$file")" || continue
    [[ "$mtime" =~ ^[0-9]+$ && "$mtime" -lt "$cutoff" ]] || continue
    loose_gate_archives+=("$file")
  done < <(find "$GATE_ARCHIVE_DIR" -mindepth 1 -maxdepth 1 -type f -print0 2>/dev/null)
  if [[ ${#loose_gate_archives[@]} -gt 0 ]] \
    && probe_open_candidates "$module" "${loose_gate_archives[@]}"; then
    for file in "${loose_gate_archives[@]}"; do
      record_candidate "$module" "$file" "loose-gate-archive-retention-exceeded" 30
    done
  fi
}

resolve_tar() {
  if [[ -n "$TAR_BIN_OVERRIDE" ]]; then
    [[ "$TAR_BIN_OVERRIDE" == /* && -x "$TAR_BIN_OVERRIDE" ]] \
      && printf '%s\n' "$TAR_BIN_OVERRIDE" || printf '\n'
    return
  fi
  command -v tar 2>/dev/null || printf '\n'
}

probe_tar_decompression() {
  local tar_bin="$1" probe rc
  probe="$(mktemp "$STATE_DIR/.commdb-decompress-probe.XXXXXX")" || return 2
  python3 - "$probe" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "w:gz"):
    pass
PY
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    rm -f -- "$probe" 2>/dev/null || true
    return 2
  fi
  "$tar_bin" -tzf "$probe" >/dev/null 2>&1
  rc=$?
  rm -f -- "$probe" 2>/dev/null || return 2
  [[ "$rc" -eq 0 ]]
}

run_commdb_backups() {
  local module="commdb_backups" comm_root scan_file scan_rc tar_bin probe_rc
  local classification path bytes mtime reason project i project_dir manifest refs archive tmp
  local current_mtime archive_bytes freed files deleted_this_run=0
  local -a candidate_paths=() candidate_bytes=() candidate_mtimes=() candidate_projects=()
  local -a tar_paths=() tar_bytes=() tar_mtimes=()
  local -a open_paths=() tar_members=()

  [[ -d "$FLYWHEEL_COMM_ROOT" && ! -L "$FLYWHEEL_COMM_ROOT" ]] || return 0
  comm_root="$(physical_dir "$FLYWHEEL_COMM_ROOT")" || {
    audit_event "$module" skip "$FLYWHEEL_COMM_ROOT" 0 "comm-root-unresolvable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  case "$comm_root" in *$'\t'*|*$'\n'*|*$'\r'*)
    audit_event "$module" skip "$FLYWHEEL_COMM_ROOT" 0 "comm-root-unsafe"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
    ;;
  esac
  tar_bin="$(resolve_tar)"
  if [[ -z "$tar_bin" ]]; then
    audit_event "$module" failure "$FLYWHEEL_COMM_ROOT" 0 "decompress-tool-unavailable"
    log "ERROR: $module: decompress-tool-unavailable"
    return 1
  fi
  command -v python3 >/dev/null 2>&1 || {
    audit_event "$module" skip "$FLYWHEEL_COMM_ROOT" 0 "python3-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  }
  probe_rc=0
  probe_tar_decompression "$tar_bin" || probe_rc=$?
  if [[ "$probe_rc" -ne 0 ]]; then
    reason="decompress-tool-unavailable"
    [[ "$probe_rc" -eq 2 ]] && reason="decompress-capability-probe-failed"
    audit_event "$module" failure "$FLYWHEEL_COMM_ROOT" 0 "$reason"
    log "ERROR: $module: $reason"
    return 1
  fi

  scan_file="$(mktemp "$STATE_DIR/.commdb-backups.XXXXXX")" || die "cannot allocate comm DB backup scan"
  python3 - "$comm_root" "$COMMDB_BACKUP_RETENTION_SECONDS" "$COMMDB_ARCHIVE_RETENTION_SECONDS" > "$scan_file" <<'PY'
import hashlib
import json
import os
from pathlib import PurePosixPath
import re
import sqlite3
import stat
import sys
import time

comm_root, raw_retention, raw_archive_retention = sys.argv[1:]
retention = int(raw_retention)
archive_retention = int(raw_archive_retention)
now = time.time()
safe_project = re.compile(r"^[A-Za-z0-9._-]+$")
manifest_pattern = re.compile(r"^(comm\.db\.pre-fly1572-[A-Za-z0-9._-]+)\.refs-manifest\.json$")
archive_pattern = re.compile(r"^comm\.db\.pre-fly1572-[A-Za-z0-9._-]+\.tar\.gz$")

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def validate_family(project_path, base_path, manifest_path):
    if os.path.islink(base_path) or not os.path.isfile(base_path):
        return False, 0, 0, 0
    try:
        connection = sqlite3.connect(f"file:{base_path}?mode=ro", uri=True)
        try:
            quick = connection.execute("PRAGMA quick_check").fetchone()
            if not quick or quick[0] != "ok":
                return False, 0, 0, 0
        finally:
            connection.close()
        with open(manifest_path, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        if not isinstance(manifest, dict) or set(manifest) != {"v", "files"}:
            return False, 0, 0, 0
        if manifest["v"] != 1 or not isinstance(manifest["files"], list):
            return False, 0, 0, 0
        expected = {}
        for item in manifest["files"]:
            if not isinstance(item, dict) or set(item) != {"path", "size", "sha256"}:
                return False, 0, 0, 0
            rel = item["path"]
            pure = PurePosixPath(rel) if isinstance(rel, str) else None
            if (
                pure is None
                or pure.is_absolute()
                or not pure.parts
                or any(part in ("", ".", "..") for part in pure.parts)
                or "\\" in rel
                or not isinstance(item["size"], int)
                or item["size"] < 0
                or not isinstance(item["sha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
                or rel in expected
            ):
                return False, 0, 0, 0
            expected[rel] = (item["size"], item["sha256"])
        refs_path = f"{base_path}.refs"
        actual = {}
        if os.path.lexists(refs_path):
            if os.path.islink(refs_path) or not os.path.isdir(refs_path):
                return False, 0, 0, 0
            for root, dirs, files in os.walk(refs_path, followlinks=False):
                if any(os.path.islink(os.path.join(root, name)) for name in dirs):
                    return False, 0, 0, 0
                for name in files:
                    path = os.path.join(root, name)
                    if os.path.islink(path) or not os.path.isfile(path):
                        return False, 0, 0, 0
                    rel = os.path.relpath(path, refs_path).replace(os.sep, "/")
                    actual[rel] = (os.path.getsize(path), sha256(path))
        if actual != expected:
            return False, 0, 0, 0
        members = [base_path, manifest_path]
        if os.path.isdir(refs_path):
            members.extend(os.path.join(root, name) for root, _, files in os.walk(refs_path) for name in files)
        total = sum(os.path.getsize(path) for path in members)
        newest = max(os.path.getmtime(path) for path in members)
        return True, total, int(newest), int(os.path.getmtime(base_path))
    except Exception:
        return False, 0, 0, 0

for project in os.scandir(comm_root):
    if not safe_project.fullmatch(project.name) or not project.is_dir(follow_symlinks=False):
        continue
    project_path = project.path
    names = {entry.name: entry for entry in os.scandir(project_path)}
    referenced = None
    intent_invalid = False
    intent_path = os.path.join(project_path, "comm.db.migration-swap-intent.json")
    if os.path.lexists(intent_path):
        try:
            if os.path.islink(intent_path) or not os.path.isfile(intent_path):
                raise ValueError("unsafe intent")
            with open(intent_path, "r", encoding="utf-8") as handle:
                intent = json.load(handle)
            referenced = intent.get("backupPath")
            if not isinstance(referenced, str):
                raise ValueError("backupPath missing")
            referenced = os.path.realpath(referenced)
        except Exception:
            intent_invalid = True

    families = []
    recognized = {"comm.db", "comm.db-wal", "comm.db-shm", "comm.db.migration-swap-intent.json"}
    for name, entry in names.items():
        match = manifest_pattern.fullmatch(name)
        if not match:
            continue
        base_name = match.group(1)
        base_path = os.path.join(project_path, base_name)
        manifest_path = entry.path
        refs_path = f"{base_path}.refs"
        recognized.update({name, base_name, f"{base_name}.refs", f"{base_name}-wal", f"{base_name}-shm"})
        valid, total, newest, identity_mtime = validate_family(project_path, base_path, manifest_path)
        families.append({
            "base": base_path,
            "valid": valid,
            "bytes": total if valid else (os.path.getsize(base_path) if os.path.isfile(base_path) else 0),
            "mtime": newest if valid else int(os.path.getmtime(manifest_path)),
            "identity_mtime": identity_mtime if valid else (int(os.path.getmtime(base_path)) if os.path.isfile(base_path) else 0),
            "stray": os.path.lexists(f"{base_path}-wal") or os.path.lexists(f"{base_path}-shm"),
        })
    valid_families = [family for family in families if family["valid"]]
    latest = max(valid_families, key=lambda family: family["mtime"])["base"] if valid_families else None
    for family in families:
        base = family["base"]
        if not family["valid"]:
            reason = "invalid-pre-fly1572-family"
            classification = "preserve"
        elif intent_invalid:
            reason = "recovery-intent-invalid"
            classification = "preserve"
        elif referenced == os.path.realpath(base):
            reason = "recovery-intent-references-family"
            classification = "preserve"
        elif family["stray"]:
            reason = "backup-sidecar-stray"
            classification = "preserve"
        elif base == latest:
            reason = "latest-valid-raw-family"
            classification = "preserve"
        elif now - family["mtime"] <= retention:
            reason = "backup-family-recent"
            classification = "preserve"
        else:
            reason = "backup-family-retention-exceeded"
            classification = "compress"
        print("\t".join((classification, base, str(family["bytes"]), str(family["identity_mtime"]), reason, project.name)))

    for name, entry in names.items():
        if archive_pattern.fullmatch(name) and entry.is_file(follow_symlinks=False):
            recognized.add(name)
            age = now - entry.stat(follow_symlinks=False).st_mtime
            classification = "tar-delete" if age > archive_retention else "preserve"
            reason = "compressed-backup-retention-exceeded" if classification == "tar-delete" else "compressed-backup-recent"
            info = entry.stat(follow_symlinks=False)
            print("\t".join((classification, entry.path, str(info.st_size), str(int(info.st_mtime)), reason, project.name)))
    for name, entry in names.items():
        if name in recognized or not name.startswith("comm.db."):
            continue
        if entry.is_file(follow_symlinks=False):
            info = entry.stat(follow_symlinks=False)
            print("\t".join(("preserve", entry.path, str(info.st_size), str(int(info.st_mtime)), "follow-up-unknown-backup-tag", project.name)))
PY
  scan_rc=$?
  if [[ "$scan_rc" -ne 0 ]]; then
    rm -f "$scan_file"
    audit_event "$module" skip "$FLYWHEEL_COMM_ROOT" 0 "commdb-backup-scan-failed"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi

  while IFS=$'\t' read -r classification path bytes mtime reason project; do
    case "$classification" in
      compress)
        candidate_paths+=("$path")
        candidate_bytes+=("$bytes")
        candidate_mtimes+=("$mtime")
        candidate_projects+=("$project")
        ;;
      tar-delete)
        tar_paths+=("$path")
        tar_bytes+=("$bytes")
        tar_mtimes+=("$mtime")
        ;;
      preserve)
        audit_event "$module" skip "$path" "$bytes" "$reason"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        ;;
    esac
  done < "$scan_file"
  rm -f "$scan_file"

  for ((i = 0; i < ${#tar_paths[@]}; i++)); do
    path="${tar_paths[$i]}"
    bytes="${tar_bytes[$i]}"
    mtime="${tar_mtimes[$i]}"
    if ! is_allowed_target "$path" || ! "$tar_bin" -tzf "$path" >/dev/null 2>&1; then
      audit_event "$module" skip "$path" "$bytes" "compressed-backup-invalid-or-outside-policy"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    if [[ "$MODE" == "dry-run" ]]; then
      audit_event "$module" would-delete "$path" "$bytes" "compressed-backup-retention-exceeded"
    else
      current_mtime="$(file_mtime "$path")" || current_mtime=""
      if [[ "$current_mtime" != "$mtime" ]] || ! rm -f -- "$path"; then
        audit_event "$module" skip "$path" "$bytes" "compressed-backup-delete-failed-or-drifted"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
      fi
      audit_event "$module" delete "$path" "$bytes" "compressed-backup-retention-exceeded"
      note_deleted_mtime "$mtime"
      DELETED_COUNT=$((DELETED_COUNT + 1))
      DELETED_FILE_COUNT=$((DELETED_FILE_COUNT + 1))
      FREED_BYTES=$((FREED_BYTES + bytes))
    fi
    CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
    CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
  done

  for ((i = 0; i < ${#candidate_paths[@]}; i++)); do
    path="${candidate_paths[$i]}"
    bytes="${candidate_bytes[$i]}"
    mtime="${candidate_mtimes[$i]}"
    project="${candidate_projects[$i]}"
    manifest="$path.refs-manifest.json"
    refs="$path.refs"
    archive="$path.tar.gz"
    project_dir="${path%/*}"
    if [[ "$deleted_this_run" -ge "$COMMDB_BACKUP_COMPRESS_CAP" ]]; then
      audit_event "$module" skip "$path" "$bytes" "commdb-backup-compress-cap-deferred"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    open_paths=("$path" "$manifest")
    if [[ -d "$refs" && ! -L "$refs" ]]; then
      while IFS= read -r -d '' tmp; do open_paths+=("$tmp"); done \
        < <(find "$refs" -type f -print0 2>/dev/null)
    fi
    probe_open_candidates "$module" "${open_paths[@]}" || continue
    if ! is_allowed_target "$path" || ! is_allowed_target "$manifest" \
      || [[ "$(file_mtime "$path")" != "$mtime" \
        || -e "$path-wal" || -L "$path-wal" || -e "$path-shm" || -L "$path-shm" \
        || -e "$archive" || -L "$archive" ]]; then
      audit_event "$module" skip "$path" "$bytes" "backup-family-identity-drift-or-destination-exists"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    if [[ "$MODE" == "dry-run" ]]; then
      audit_event "$module" would-compress "$path" "$bytes" "backup-family-retention-exceeded"
      CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
      CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
      continue
    fi
    tmp="$archive.tmp-$RUN_ID"
    if [[ -e "$tmp" || -L "$tmp" ]]; then
      audit_event "$module" skip "$path" "$bytes" "backup-compression-temp-exists"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    tar_members=("${path##*/}" "${manifest##*/}")
    [[ -d "$refs" && ! -L "$refs" ]] && tar_members+=("${refs##*/}")
    if ! "$tar_bin" -C "$project_dir" -czf "$tmp" "${tar_members[@]}" \
      || ! "$tar_bin" -tzf "$tmp" >/dev/null 2>&1; then
      rm -f -- "$tmp" 2>/dev/null || true
      audit_event "$module" skip "$path" "$bytes" "backup-compression-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    audit_event "$module" compress-intent "$path" "$bytes" "backup-family-retention-exceeded"
    if ! mv -n "$tmp" "$archive" || [[ -e "$tmp" || -L "$tmp" ]]; then
      rm -f -- "$tmp" 2>/dev/null || true
      audit_event "$module" skip "$path" "$bytes" "backup-compression-publish-failed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    files=2
    [[ -d "$refs" ]] && files=$((files + $(directory_file_count "$refs")))
    if ! rm -f -- "$path" "$manifest" || ! rm -rf -- "$refs"; then
      audit_event "$module" skip "$path" "$bytes" "backup-source-retirement-incomplete"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    archive_bytes="$(file_size "$archive")"
    freed=$((bytes > archive_bytes ? bytes - archive_bytes : 0))
    audit_event "$module" compress "$archive" "$archive_bytes" "backup-family-retention-exceeded"
    note_deleted_mtime "$mtime"
    deleted_this_run=$((deleted_this_run + 1))
    CANDIDATE_COUNT=$((CANDIDATE_COUNT + 1))
    CANDIDATE_BYTES=$((CANDIDATE_BYTES + bytes))
    DELETED_COUNT=$((DELETED_COUNT + 1))
    DELETED_FILE_COUNT=$((DELETED_FILE_COUNT + files))
    FREED_BYTES=$((FREED_BYTES + freed))
  done
}

db_retention_marker_fresh() {
  local marker="$1" marker_mtime now
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  marker_mtime="$(file_mtime "$marker")" || return 1
  now="$(date +%s)" || return 1
  [[ "$marker_mtime" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 1
  [[ "$marker_mtime" -le "$now" \
    && $((now - marker_mtime)) -lt "$DB_RETENTION_INTERVAL_SECONDS" ]]
}

db_retention_success_marker_current() {
  jq -e '
    (.schema_version == 1 or .schema_version == 2)
    and .issue == "FLY-2139"
    and (.completed_at | type) == "string"
    and (.apply_receipt_sha256 | test("^[0-9a-f]{64}$"))
  ' "$DB_RETENTION_SUCCESS_MARKER" >/dev/null 2>&1 \
    && db_retention_marker_fresh "$DB_RETENTION_SUCCESS_MARKER"
}

db_retention_inventory_marker_current() {
  jq -e '
    (.schema_version == 1 or .schema_version == 2)
    and .issue == "FLY-2139"
    and (.completed_at | type) == "string"
    and (.manifest_sha256 | test("^[0-9a-f]{64}$"))
  ' "$DB_RETENTION_INVENTORY_MARKER" >/dev/null 2>&1 \
    && db_retention_marker_fresh "$DB_RETENTION_INVENTORY_MARKER"
}

db_retention_current_marker_reason() {
  if db_retention_success_marker_current; then
    printf '%s\n' weekly-success-marker-current
    return 0
  fi
  if [[ ! -e "$DB_RETENTION_ACTIVATION_RECEIPT" ]] \
    && db_retention_inventory_marker_current; then
    printf '%s\n' weekly-inventory-marker-current
    return 0
  fi
  return 1
}

db_retention_previous_rate_observation() {
  local marker observation
  local -a markers=()
  for marker in "$DB_RETENTION_SUCCESS_MARKER" "$DB_RETENTION_INVENTORY_MARKER"; do
    [[ -f "$marker" && ! -L "$marker" ]] && markers+=("$marker")
  done
  [[ ${#markers[@]} -gt 0 ]] || return 1
  observation="$(jq -ecs '
    [.[]
      | .rate_observation
      | select(type == "object")
      | select((.candidateCount | type) == "number" and .candidateCount >= 0)
      | select((.observedAt | type) == "string")
      | select((.mintExceedsDrainStreak | type) == "number" and .mintExceedsDrainStreak >= 0)]
    | sort_by(.observedAt)
    | last // empty
  ' "${markers[@]}" 2>/dev/null)" || observation=""
  [[ -n "$observation" ]] || return 1
  printf '%s\n' "$observation"
}

derive_db_retention_rates() {
  local manifest="$1" receipt="${2:-}" current previous apply output
  local -a args=()
  [[ -f "$DB_RETENTION_RATE_CLI" && ! -L "$DB_RETENTION_RATE_CLI" ]] || return 1
  current="$(jq -ec '
    {candidateCount: ([.targets[]?.candidateCount] | add // 0), observedAt: .completedAt}
    | select((.candidateCount | type) == "number" and .candidateCount >= 0)
    | select((.observedAt | type) == "string")
  ' "$manifest" 2>/dev/null)" || return 1
  previous="$(db_retention_previous_rate_observation 2>/dev/null)" || previous=""
  args=("$DB_RETENTION_RATE_CLI" --current-json "$current")
  [[ -z "$previous" ]] || args+=(--previous-json "$previous")
  if [[ -n "$receipt" ]]; then
    apply="$(jq -ec '
      {deletedCount: ([.deleted[]?] | add // 0), durationMs: .durationMs}
      | select((.deletedCount | type) == "number" and .deletedCount >= 0)
      | select((.durationMs | type) == "number" and .durationMs > 0)
    ' "$receipt" 2>/dev/null)" || return 1
    args+=(--apply-json "$apply")
  fi
  output="$("$NODE_BIN" "${args[@]}" 2>/dev/null)" || return 1
  jq -ec '
    select((.candidateCount | type) == "number")
    | select(.mintRatePerHour == null or (.mintRatePerHour | type) == "number")
    | select(.drainRatePerHour == null or (.drainRatePerHour | type) == "number")
    | select((.mintExceedsDrainStreak | type) == "number")
    | select((.alert | type) == "boolean")
  ' <<< "$output" 2>/dev/null
}

audit_db_retention_rates() {
  local manifest="$1" observation="$2" line
  line="$(jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg run_id "$RUN_ID" \
    --arg mode "$MODE" \
    --arg path "$manifest" \
    --argjson observation "$observation" \
    '{ts:$ts,run_id:$run_id,mode:$mode,module:"db_retention",action:"retention-rates",path:$path,bytes:0,reason:(if $observation.alert then "mint-exceeds-drain-sustained" else "retention-rates-observed" end),candidate_count:$observation.candidateCount,previous_candidate_count:$observation.previousCandidateCount,elapsed_hours:$observation.elapsedHours,mint_rate_per_hour:$observation.mintRatePerHour,drain_rate_per_hour:$observation.drainRatePerHour,drain_rate_source:$observation.drainRateSource,mint_exceeds_drain:$observation.mintExceedsDrain,mint_exceeds_drain_streak:$observation.mintExceedsDrainStreak,alert:$observation.alert}' \
    2>/dev/null)" || return 1
  printf '%s\n' "$line" >> "$AUDIT_FILE" 2>/dev/null || return 1
  if [[ "$(jq -r '.alert' <<< "$observation")" == "true" ]]; then
    log "WARNING: DB retention mint rate exceeds drain rate for $(jq -r '.mintExceedsDrainStreak' <<< "$observation") consecutive cycles"
  fi
}

write_db_retention_failure() {
  local evidence_dir="$1" reason="$2" output="$3" path tmp digest
  path="$evidence_dir/janitor-failure.json"
  tmp="$(mktemp "$evidence_dir/.janitor-failure.XXXXXX")" || return 1
  jq -n \
    --arg issue FLY-2139 \
    --arg status failed \
    --arg mode "$MODE" \
    --arg run_id "$RUN_ID" \
    --arg reason "$reason" \
    --arg output "$output" \
    --arg recorded_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{issue:$issue,status:$status,mode:$mode,run_id:$run_id,reason:$reason,output:$output,recorded_at:$recorded_at}' \
    > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  digest="$(shasum -a 256 "$tmp" | sed 's/[[:space:]].*$//')" || {
    rm -f "$tmp"
    return 1
  }
  if [[ -e "$path" || -L "$path" ]] || ! mv -n "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  printf '%s\n' "$digest" > "$path.sha256" || return 1
}

validate_db_retention_apply_receipt() {
  local receipt="$1" evidence_dir="$2" expected actual activation_sha
  [[ "$receipt" == "$evidence_dir/apply-receipt.json" \
    && -f "$receipt" && ! -L "$receipt" \
    && -f "$receipt.sha256" && ! -L "$receipt.sha256" ]] || return 1
  expected="$(sed -n '1p' "$receipt.sha256" | tr -d '[:space:]')"
  actual="$(shasum -a 256 "$receipt" | sed 's/[[:space:]].*$//')" || return 1
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$actual" == "$expected" ]] || return 1
  activation_sha="$(shasum -a 256 "$DB_RETENTION_ACTIVATION_RECEIPT" \
    | sed 's/[[:space:]].*$//')" || return 1
  jq -e --arg activation_sha "$activation_sha" '
    .issue == "FLY-2139"
    and .status == "complete"
    and .policyAudit.activationReceiptSha256 == $activation_sha
    and (.durationMs | type) == "number" and .durationMs > 0
    and ([.deleted[]?] | all((type == "number") and . >= 0))
  ' "$receipt" >/dev/null 2>&1
}

write_db_retention_success_marker() {
  local receipt="$1" observation="$2" receipt_sha tmp payload
  receipt_sha="$(shasum -a 256 "$receipt" | sed 's/[[:space:]].*$//')" \
    || return 1
  payload="$(jq -nc \
    --arg issue FLY-2139 \
    --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg run_id "$RUN_ID" \
    --arg apply_receipt "$receipt" \
    --arg apply_receipt_sha256 "$receipt_sha" \
    --argjson rate_observation "$observation" \
    '{schema_version:2,issue:$issue,completed_at:$completed_at,run_id:$run_id,apply_receipt:$apply_receipt,apply_receipt_sha256:$apply_receipt_sha256,rate_observation:$rate_observation}' \
  )" || return 1
  [[ ! -L "$DB_RETENTION_SUCCESS_MARKER" ]] || return 1
  tmp="$(mktemp "$STATE_DIR/.db-retention-success.XXXXXX")" || return 1
  printf '%s\n' "$payload" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$DB_RETENTION_SUCCESS_MARKER"
}

write_db_retention_inventory_marker() {
  local manifest="$1" observation="$2" manifest_sha tmp payload
  [[ -f "$manifest" && ! -L "$manifest" ]] || return 1
  manifest_sha="$(shasum -a 256 "$manifest" | sed 's/[[:space:]].*$//')" \
    || return 1
  [[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  payload="$(jq -nc \
    --arg issue FLY-2139 \
    --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg run_id "$RUN_ID" \
    --arg manifest "$manifest" \
    --arg manifest_sha256 "$manifest_sha" \
    --argjson rate_observation "$observation" \
    '{schema_version:2,issue:$issue,completed_at:$completed_at,run_id:$run_id,manifest:$manifest,manifest_sha256:$manifest_sha256,rate_observation:$rate_observation}' \
  )" || return 1
  [[ ! -L "$DB_RETENTION_INVENTORY_MARKER" ]] || return 1
  tmp="$(mktemp "$STATE_DIR/.db-retention-inventory.XXXXXX")" || return 1
  printf '%s\n' "$payload" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$DB_RETENTION_INVENTORY_MARKER"
}

prune_db_retention_evidence() {
  local keep="$1" current="${2:-}" root dir name eligible_count delete_count i=0 current_parent
  local -a eligible=()
  [[ "$keep" =~ ^[0-9]+$ ]] || return 1
  [[ -d "$DB_RETENTION_EVIDENCE_ROOT" && ! -L "$DB_RETENTION_EVIDENCE_ROOT" ]] \
    || return 0
  root="$(physical_dir "$DB_RETENTION_EVIDENCE_ROOT")" || return 1
  if [[ -n "$current" ]]; then
    current_parent="$(physical_dir "${current%/*}")" || return 1
    current="$current_parent/${current##*/}"
  fi
  while IFS= read -r dir; do
    name="${dir##*/}"
    [[ "$name" == "db-maintenance" ]] && continue
    [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+(-(dry|apply))?$ ]] || {
      audit_event db_retention skip "$dir" 0 "retention-evidence-name-unclassified"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    }
    [[ ! -L "$dir" && "$(physical_dir "$dir" 2>/dev/null)" == "$root/$name" ]] \
      || continue
    if [[ ! ( -f "$dir/manifest.json" && ! -L "$dir/manifest.json" ) \
      && ! ( -f "$dir/janitor-failure.json" && ! -L "$dir/janitor-failure.json" ) ]]; then
      audit_event db_retention skip "$dir" 0 "retention-evidence-unsealed"
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      continue
    fi
    eligible[${#eligible[@]}]="$dir"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | LC_ALL=C sort)

  eligible_count=${#eligible[@]}
  delete_count=$((eligible_count - keep))
  [[ "$delete_count" -gt 0 ]] || return 0
  while [[ "$i" -lt "$eligible_count" && "$delete_count" -gt 0 ]]; do
    dir="${eligible[$i]}"
    i=$((i + 1))
    [[ -n "$current" && "$dir" == "$current" ]] && continue
    record_state_directory_delete \
      db_retention "$dir" "retention-evidence-history-bounded" "$dir"
    [[ -e "$dir" || -L "$dir" ]] || delete_count=$((delete_count - 1))
  done
}

run_db_retention() {
  local module="db_retention" evidence_dir output rc manifest receipt reason marker_reason observation
  if [[ "$MODE" == "dry-run" ]]; then
    reason="apply-phase-owns-inventory"
    [[ "$CYCLE_DRY_PHASE" -eq 1 ]] && reason="cycle-apply-phase-owns-inventory"
    audit_event "$module" skip "$DB_RETENTION_EVIDENCE_ROOT" 0 "$reason"
    log "skip $module $reason"
    return 0
  fi
  if marker_reason="$(db_retention_current_marker_reason)"; then
    audit_event "$module" skip "$STATE_DIR" 0 "$marker_reason"
    log "skip $module $marker_reason"
    return 0
  fi
  if [[ ! -f "$TEAMLEAD_DB" || -L "$TEAMLEAD_DB" \
    || ! -f "$DB_RETENTION_COMM_DB" || -L "$DB_RETENTION_COMM_DB" ]]; then
    audit_event "$module" skip "$TEAMLEAD_DB" 0 "retention-database-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 0
  fi
  if [[ ! -f "$DB_RETENTION_CLI" || -L "$DB_RETENTION_CLI" \
    || -z "$NODE_BIN" ]]; then
    audit_event "$module" skip "$DB_RETENTION_CLI" 0 "retention-cli-unavailable"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    return 1
  fi
  [[ "$DB_RETENTION_EVIDENCE_ROOT" == /* \
    && "$DB_RETENTION_EVIDENCE_ROOT" != *$'\n'* \
    && "$DB_RETENTION_EVIDENCE_ROOT" != *$'\r'* \
    && ! -L "$DB_RETENTION_EVIDENCE_ROOT" ]] || {
    audit_event "$module" skip "$DB_RETENTION_EVIDENCE_ROOT" 0 "retention-evidence-root-unsafe"
    return 1
  }
  mkdir -p "$DB_RETENTION_EVIDENCE_ROOT" || return 1
  prune_db_retention_evidence "$((DB_RETENTION_EVIDENCE_KEEP - 1))" || {
    audit_event "$module" skip "$DB_RETENTION_EVIDENCE_ROOT" 0 "retention-evidence-prune-failed"
    return 1
  }
  evidence_dir="$DB_RETENTION_EVIDENCE_ROOT/$RUN_ID"
  [[ ! -e "$evidence_dir" && ! -L "$evidence_dir" ]] || {
    audit_event "$module" skip "$evidence_dir" 0 "retention-evidence-run-exists"
    return 1
  }

  output="$("$NODE_BIN" "$DB_RETENTION_CLI" inventory \
    --teamlead-db "$TEAMLEAD_DB" \
    --comm-db "$DB_RETENTION_COMM_DB" \
    --evidence-dir "$evidence_dir" \
    --evidence-issue fly-2139 \
    --health-url "$DB_RETENTION_HEALTH_URL" 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    mkdir -p "$evidence_dir" 2>/dev/null || true
    write_db_retention_failure "$evidence_dir" "inventory-failed-rc-$rc" "$output" || true
    audit_event "$module" skip "$evidence_dir" 0 "inventory-failed-rc-$rc"
    return 1
  fi
  manifest="$(printf '%s\n' "$output" | tail -n 1 | jq -er '.manifestPath' 2>/dev/null)" || manifest=""
  if [[ "$manifest" != "$evidence_dir/manifest.json" || ! -f "$manifest" || -L "$manifest" ]]; then
    write_db_retention_failure "$evidence_dir" "inventory-result-invalid" "$output" || true
    audit_event "$module" skip "$evidence_dir" 0 "inventory-result-invalid"
    return 1
  fi
  audit_event "$module" inventory "$manifest" 0 "bounded-retention-inventory"

  if [[ ! -e "$DB_RETENTION_ACTIVATION_RECEIPT" ]]; then
    observation="$(derive_db_retention_rates "$manifest")" || {
      write_db_retention_failure "$evidence_dir" "retention-rate-derivation-failed" "$manifest" || true
      audit_event "$module" skip "$manifest" 0 "retention-rate-derivation-failed"
      return 1
    }
    audit_db_retention_rates "$manifest" "$observation" || return 1
    write_db_retention_inventory_marker "$manifest" "$observation" || {
      audit_event "$module" skip "$DB_RETENTION_INVENTORY_MARKER" 0 "inventory-marker-write-failed"
      return 1
    }
    prune_db_retention_evidence "$DB_RETENTION_EVIDENCE_KEEP" "$evidence_dir" || {
      audit_event "$module" skip "$DB_RETENTION_EVIDENCE_ROOT" 0 "retention-evidence-prune-failed"
      return 1
    }
    audit_event "$module" skip "$DB_RETENTION_ACTIVATION_RECEIPT" 0 "activation-missing-inventory-only"
    log "skip $module activation-missing-inventory-only"
    return 0
  fi
  output="$("$NODE_BIN" "$DB_RETENTION_CLI" policy-apply \
    --manifest "$manifest" \
    --activation-receipt "$DB_RETENTION_ACTIVATION_RECEIPT" 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    reason="policy-apply-failed-rc-$rc"
    write_db_retention_failure "$evidence_dir" "$reason" "$output" || true
    audit_event "$module" skip "$evidence_dir" 0 "$reason"
    return 1
  fi
  receipt="$(printf '%s\n' "$output" | tail -n 1 | jq -er '.applyReceiptPath' 2>/dev/null)" \
    || receipt=""
  if ! validate_db_retention_apply_receipt "$receipt" "$evidence_dir"; then
    write_db_retention_failure "$evidence_dir" "policy-apply-receipt-invalid" "$output" || true
    audit_event "$module" skip "$receipt" 0 "policy-apply-receipt-invalid"
    return 1
  fi
  observation="$(derive_db_retention_rates "$manifest" "$receipt")" || {
    write_db_retention_failure "$evidence_dir" "retention-rate-derivation-failed" "$receipt" || true
    audit_event "$module" skip "$receipt" 0 "retention-rate-derivation-failed"
    return 1
  }
  audit_db_retention_rates "$manifest" "$observation" || return 1
  write_db_retention_success_marker "$receipt" "$observation" || {
    audit_event "$module" skip "$DB_RETENTION_SUCCESS_MARKER" 0 "success-marker-write-failed"
    return 1
  }
  rm -f -- "$DB_RETENTION_INVENTORY_MARKER" || {
    audit_event "$module" skip "$DB_RETENTION_INVENTORY_MARKER" 0 "inventory-marker-retire-failed"
    return 1
  }
  prune_db_retention_evidence "$DB_RETENTION_EVIDENCE_KEEP" "$evidence_dir" || {
    audit_event "$module" skip "$DB_RETENTION_EVIDENCE_ROOT" 0 "retention-evidence-prune-failed"
    return 1
  }
  audit_event "$module" policy-apply "$receipt" 0 "bounded-retention-complete"
}

write_marker() {
  local path="$1" stem="$2" marker_tmp
  [[ ! -L "$path" ]] || die "$stem marker is a symlink"
  marker_tmp="$(/usr/bin/mktemp "$STATE_DIR/.$stem.XXXXXX")" \
    || die "cannot create $stem marker temp file"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) $RUN_ID" > "$marker_tmp" \
    || { rm -f "$marker_tmp"; die "cannot stage $stem marker"; }
  mv -f "$marker_tmp" "$path" \
    || { rm -f "$marker_tmp"; die "cannot install $stem marker"; }
}

dry_run_scope_json() {
  local script_sha rate_cli_sha
  if command -v shasum >/dev/null 2>&1; then
    script_sha="$(shasum -a 256 "${BASH_SOURCE[0]}" | sed 's/[[:space:]].*$//')"
  elif command -v sha256sum >/dev/null 2>&1; then
    script_sha="$(sha256sum "${BASH_SOURCE[0]}" | sed 's/[[:space:]].*$//')"
  else
    die "shasum or sha256sum is required for the dry-run receipt"
  fi
  [[ "$script_sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "cannot hash janitor script"
  if command -v shasum >/dev/null 2>&1; then
    rate_cli_sha="$(shasum -a 256 "$DB_RETENTION_RATE_CLI" | sed 's/[[:space:]].*$//')"
  else
    rate_cli_sha="$(sha256sum "$DB_RETENTION_RATE_CLI" | sed 's/[[:space:]].*$//')"
  fi
  [[ "$rate_cli_sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "cannot hash DB retention rate CLI"
  jq -nc \
    --arg script_sha256 "$script_sha" \
    --arg codex_homes "$CODEX_HOMES_RAW" \
    --arg claude_projects "$CLAUDE_PROJECTS" \
    --arg teamlead_db "$TEAMLEAD_DB" \
    --arg disabled_modules "$DISABLED_MODULES" \
    --arg report_channel "$REPORT_CHANNEL" \
    --arg report_project "$REPORT_PROJECT" \
    --arg report_env_file "$REPORT_ENV_FILE" \
    --arg report_comm_cli "$COMM_CLI" \
    --arg tmux_socket_root "$TMUX_SOCKET_ROOT" \
    --argjson tmux_socket_uid "$CURRENT_UID" \
    --argjson tmux_socket_min_age_seconds "$TMUX_SOCKET_MIN_AGE_SECONDS" \
    --argjson tmux_socket_probe_timeout_seconds "$TMUX_SOCKET_PROBE_TIMEOUT_SECONDS" \
    --arg tmux_socket_allowlist "$TMUX_SOCKET_ALLOWLIST" \
    --argjson tmux_socket_delete_cap "$TMUX_SOCKET_DELETE_CAP" \
    --arg flywheel_state_root "$FLYWHEEL_STATE_ROOT" \
    --arg gate_marker_dir "$GATE_MARKER_DIR" \
    --arg gate_archive_dir "$GATE_ARCHIVE_DIR" \
    --arg flywheel_archive_root "$FLYWHEEL_ARCHIVE_ROOT" \
    --arg flywheel_comm_root "$FLYWHEEL_COMM_ROOT" \
    --arg tar_bin_override "$TAR_BIN_OVERRIDE" \
    --arg db_retention_cli "$DB_RETENTION_CLI" \
    --arg db_retention_rate_cli "$DB_RETENTION_RATE_CLI" \
    --arg db_retention_rate_cli_sha256 "$rate_cli_sha" \
    --arg db_retention_comm_db "$DB_RETENTION_COMM_DB" \
    --arg db_retention_evidence_root "$DB_RETENTION_EVIDENCE_ROOT" \
    --arg db_retention_activation_receipt "$DB_RETENTION_ACTIVATION_RECEIPT" \
    --arg db_retention_health_url "$DB_RETENTION_HEALTH_URL" \
    --arg wake_terminal_statuses "$WAKE_TERMINAL_STATUSES" \
    --argjson gate_marker_retention_seconds "$GATE_MARKER_RETENTION_SECONDS" \
    --argjson gate_marker_delete_cap "$GATE_MARKER_DELETE_CAP" \
    --argjson gate_marker_backlog_alert_threshold "$GATE_MARKER_BACKLOG_ALERT_THRESHOLD" \
    --argjson publish_timeout_seconds "$PUBLISH_TIMEOUT_SECONDS" \
    --argjson codex_sessions_days "$RETENTION_CODEX_SESSIONS" \
    --argjson codex_artifacts_days "$RETENTION_CODEX_ARTIFACTS" \
    --argjson claude_orphans_days "$RETENTION_CLAUDE_ORPHANS" \
    --argjson keep_releases "$KEEP_RELEASES" \
    '{script_sha256:$script_sha256,codex_homes:$codex_homes,claude_projects:$claude_projects,teamlead_db:$teamlead_db,disabled_modules:$disabled_modules,report_channel:$report_channel,report_project:$report_project,report_env_file:$report_env_file,report_comm_cli:$report_comm_cli,tmux_socket_root:$tmux_socket_root,tmux_socket_uid:$tmux_socket_uid,tmux_socket_min_age_seconds:$tmux_socket_min_age_seconds,tmux_socket_probe_timeout_seconds:$tmux_socket_probe_timeout_seconds,tmux_socket_allowlist:$tmux_socket_allowlist,tmux_socket_delete_cap:$tmux_socket_delete_cap,flywheel_state_root:$flywheel_state_root,gate_marker_dir:$gate_marker_dir,gate_archive_dir:$gate_archive_dir,flywheel_archive_root:$flywheel_archive_root,flywheel_comm_root:$flywheel_comm_root,tar_bin_override:$tar_bin_override,db_retention_cli:$db_retention_cli,db_retention_rate_cli:$db_retention_rate_cli,db_retention_rate_cli_sha256:$db_retention_rate_cli_sha256,db_retention_comm_db:$db_retention_comm_db,db_retention_evidence_root:$db_retention_evidence_root,db_retention_activation_receipt:$db_retention_activation_receipt,db_retention_health_url:$db_retention_health_url,wake_terminal_statuses:$wake_terminal_statuses,gate_marker_retention_seconds:$gate_marker_retention_seconds,gate_marker_delete_cap:$gate_marker_delete_cap,gate_marker_backlog_alert_threshold:$gate_marker_backlog_alert_threshold,publish_timeout_seconds:$publish_timeout_seconds,codex_sessions_days:$codex_sessions_days,codex_artifacts_days:$codex_artifacts_days,claude_orphans_days:$claude_orphans_days,keep_releases:$keep_releases}' \
    2>/dev/null || die "cannot encode dry-run scope"
}

write_full_dry_run_marker() {
  local marker_tmp scope receipt
  [[ ! -L "$DRY_RUN_MARKER" ]] || die "full-dry-run marker is a symlink"
  scope="$(dry_run_scope_json)"
  receipt="$(jq -nc \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg run_id "$RUN_ID" \
    --argjson scope "$scope" \
    '{schema_version:2,created_at:$created_at,run_id:$run_id,scope:$scope}' \
    2>/dev/null)" || die "cannot encode full-dry-run receipt"
  marker_tmp="$(/usr/bin/mktemp "$STATE_DIR/.full-dry-run.XXXXXX")" \
    || die "cannot create full-dry-run marker temp file"
  printf '%s\n' "$receipt" > "$marker_tmp" \
    || { rm -f "$marker_tmp"; die "cannot stage full-dry-run marker"; }
  mv -f "$marker_tmp" "$DRY_RUN_MARKER" \
    || { rm -f "$marker_tmp"; die "cannot install full-dry-run marker"; }
}

dry_run_receipt_matches() {
  local expected actual
  [[ -f "$DRY_RUN_MARKER" && ! -L "$DRY_RUN_MARKER" ]] || return 1
  expected="$(dry_run_scope_json | jq -Sc . 2>/dev/null)" || return 1
  actual="$(jq -eSc \
    'if .schema_version == 2 and (.scope | type) == "object" then .scope else error("invalid receipt") end' \
    "$DRY_RUN_MARKER" 2>/dev/null)" || return 1
  [[ "$actual" == "$expected" ]]
}

reset_run_counters() {
  DELETED_COUNT=0
  DELETED_FILE_COUNT=0
  SKIPPED_COUNT=0
  FREED_BYTES=0
  CANDIDATE_COUNT=0
  CANDIDATE_BYTES=0
  OLDEST_DELETED_MTIME=""
  NEWEST_DELETED_MTIME=""
  OPEN_CANONICALS=$'\n'
  CURRENT_RUN_FAILED=0
}

run_current_mode() {
  module_enabled codex_releases && run_codex_releases
  module_enabled codex_sessions && run_codex_sessions
  module_enabled codex_artifacts && run_codex_artifacts
  module_enabled codex_logs_db && run_codex_logs_db
  module_enabled claude_orphans && run_claude_orphans
  module_enabled tmux_dead_sockets && run_tmux_dead_sockets
  module_enabled gate_markers && run_gate_markers
  module_enabled state_residue && run_state_residue
  if module_enabled commdb_backups; then
    run_commdb_backups || CURRENT_RUN_FAILED=1
  fi
  if module_enabled db_retention; then
    run_db_retention || CURRENT_RUN_FAILED=1
  fi
  audit_summary
  if [[ "$MODE" == "dry-run" && -z "$ONLY_MODULE" ]]; then
    write_full_dry_run_marker
  elif [[ "$MODE" == "apply" ]]; then
    if [[ -z "$ONLY_MODULE" && -n "$REPORT_CHANNEL" ]]; then
      if ! render_apply_report; then
        audit_event all skip "$REPORT_PENDING_DIR" 0 "report-render-failed"
        die "cleanup completed but audit manifest report rendering failed"
      fi
      drain_pending_reports \
        || die "cleanup completed; founder report queued for retry"
    fi
    if [[ -z "$ONLY_MODULE" && "$FORCE" -ne 1 ]]; then
      write_marker "$FIRST_APPLY_MARKER" first-apply
    fi
  fi
  [[ "$CURRENT_RUN_FAILED" -eq 0 ]]
}

main() {
  parse_args "$@"
  validate_uint FLYWHEEL_JANITOR_RETENTION_CODEX_SESSIONS_DAYS "$RETENTION_CODEX_SESSIONS"
  validate_uint FLYWHEEL_JANITOR_RETENTION_CODEX_ARTIFACTS_DAYS "$RETENTION_CODEX_ARTIFACTS"
  validate_uint FLYWHEEL_JANITOR_RETENTION_CLAUDE_ORPHANS_DAYS "$RETENTION_CLAUDE_ORPHANS"
  validate_uint FLYWHEEL_JANITOR_KEEP_RELEASES "$KEEP_RELEASES"
  validate_uint FLYWHEEL_JANITOR_PUBLISH_TIMEOUT_SECONDS "$PUBLISH_TIMEOUT_SECONDS"
  validate_uint FLYWHEEL_JANITOR_TMUX_SOCKET_MIN_AGE_SECONDS "$TMUX_SOCKET_MIN_AGE_SECONDS"
  validate_uint FLYWHEEL_JANITOR_TMUX_SOCKET_PROBE_TIMEOUT_SECONDS "$TMUX_SOCKET_PROBE_TIMEOUT_SECONDS"
  validate_uint FLYWHEEL_JANITOR_TMUX_SOCKET_DELETE_CAP "$TMUX_SOCKET_DELETE_CAP"
  validate_uint FLYWHEEL_JANITOR_GATE_MARKER_DELETE_CAP "$GATE_MARKER_DELETE_CAP"
  validate_uint FLYWHEEL_JANITOR_GATE_MARKER_BACKLOG_ALERT_THRESHOLD "$GATE_MARKER_BACKLOG_ALERT_THRESHOLD"
  [[ "$KEEP_RELEASES" -ge 1 ]] || die "FLYWHEEL_JANITOR_KEEP_RELEASES must be at least 1"
  [[ "$PUBLISH_TIMEOUT_SECONDS" -ge 1 ]] || die "FLYWHEEL_JANITOR_PUBLISH_TIMEOUT_SECONDS must be at least 1"
  [[ "$TMUX_SOCKET_MIN_AGE_SECONDS" -ge 1 ]] || die "FLYWHEEL_JANITOR_TMUX_SOCKET_MIN_AGE_SECONDS must be at least 1"
  [[ "$TMUX_SOCKET_PROBE_TIMEOUT_SECONDS" -ge 1 \
    && "$TMUX_SOCKET_PROBE_TIMEOUT_SECONDS" -le 30 ]] \
    || die "FLYWHEEL_JANITOR_TMUX_SOCKET_PROBE_TIMEOUT_SECONDS must be in [1,30]"
  [[ "$TMUX_SOCKET_DELETE_CAP" -ge 1 && "$TMUX_SOCKET_DELETE_CAP" -le 100 ]] \
    || die "FLYWHEEL_JANITOR_TMUX_SOCKET_DELETE_CAP must be in [1,100]"
  [[ "$GATE_MARKER_DELETE_CAP" -ge 1 && "$GATE_MARKER_DELETE_CAP" -le 50000 ]] \
    || die "FLYWHEEL_JANITOR_GATE_MARKER_DELETE_CAP must be in [1,50000]"
  [[ "$CURRENT_UID" =~ ^[0-9]+$ ]] || die "current uid is unavailable"
  validate_tmux_socket_allowlist
  command -v jq >/dev/null 2>&1 || die "jq is required for mandatory audit logging"
  [[ "$STATE_DIR" == /* && ! -L "$STATE_DIR" ]] || die "unsafe state directory"
  mkdir -p "$STATE_DIR" || die "cannot create state directory"
  [[ ! -L "$AUDIT_FILE" ]] || die "audit path must not be a symlink: $AUDIT_FILE"

  local home root
  IFS=':' read -ra CODEX_HOMES <<< "$CODEX_HOMES_RAW"
  [[ ${#CODEX_HOMES[@]} -gt 0 && -n "${CODEX_HOMES[0]}" ]] || die "no Codex homes configured"
  for home in "${CODEX_HOMES[@]}"; do
    [[ "$home" == /* ]] || die "Codex home must be absolute: $home"
    root="$(normalize_existing_root "$home")" || die "unsafe Codex home: $home"
    ALLOWED_ROOTS+=("$root")
  done
  if [[ -d "$CLAUDE_PROJECTS" && ! -L "$CLAUDE_PROJECTS" ]]; then
    root="$(normalize_existing_root "$CLAUDE_PROJECTS")" || die "unsafe Claude projects root"
    ALLOWED_ROOTS+=("$root")
  fi
  if [[ -d "$FLYWHEEL_STATE_ROOT" && ! -L "$FLYWHEEL_STATE_ROOT" ]]; then
    root="$(normalize_existing_root "$FLYWHEEL_STATE_ROOT")" || die "unsafe Flywheel state root"
    ALLOWED_ROOTS+=("$root")
  fi
  if [[ -d "$FLYWHEEL_ARCHIVE_ROOT" && ! -L "$FLYWHEEL_ARCHIVE_ROOT" ]]; then
    root="$(normalize_existing_root "$FLYWHEEL_ARCHIVE_ROOT")" || die "unsafe Flywheel archive root"
    ALLOWED_ROOTS+=("$root")
  fi
  if [[ -d "$FLYWHEEL_COMM_ROOT" && ! -L "$FLYWHEEL_COMM_ROOT" ]]; then
    root="$(normalize_existing_root "$FLYWHEEL_COMM_ROOT")" || die "unsafe Flywheel comm root"
    ALLOWED_ROOTS+=("$root")
  fi
  if [[ -z "$ONLY_MODULE" && "$REPORT_CHANNEL_EXPLICIT" -eq 0 ]]; then
    resolve_report_channel \
      || die "full-scope runs require FLYWHEEL_NOTIFY_CHANNEL in process env or $REPORT_ENV_FILE"
  fi

  if [[ "$MODE" == "apply" && "$FORCE" -ne 1 ]]; then
    dry_run_receipt_matches \
      || die "apply requires a matching full-scope dry-run; run --dry-run with the same configuration first (or use --force)"
  fi
  if ! acquire_lock; then
    audit_event all skip "$LOCK_DIR" 0 lock-held
    exit 0
  fi
  trap release_lock EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  rotate_audit_if_needed
  : >> "$AUDIT_FILE" || die "cannot open audit log for append: $AUDIT_FILE"

  if [[ "$MODE" == "cycle" ]]; then
    MODE="dry-run"
    RUN_ID="$BASE_RUN_ID-dry"
    CYCLE_DRY_PHASE=1
    reset_run_counters
    run_current_mode || die "cycle dry-run failed"
    dry_run_receipt_matches \
      || die "cycle dry-run did not produce a matching full-scope receipt"

    MODE="apply"
    RUN_ID="$BASE_RUN_ID-apply"
    CYCLE_DRY_PHASE=0
    reset_run_counters
    run_current_mode || die "cycle apply failed"
  else
    run_current_mode || die "janitor run failed"
  fi
}

main "$@"
