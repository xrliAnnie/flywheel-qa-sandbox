#!/usr/bin/env bash
# FLY-1330 — age-based cleanup for terminal Codex/Claude history and artifacts.
#
# Usage:
#   flywheel-log-janitor.sh --dry-run [--module NAME]
#   flywheel-log-janitor.sh --apply [--force] [--module NAME]
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
PUBLISH_TIMEOUT_SECONDS="${FLYWHEEL_JANITOR_PUBLISH_TIMEOUT_SECONDS:-120}"
REPORT_DRAIN_LIMIT=7
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
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

log() { printf '[log-janitor] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

usage() {
  cat >&2 <<'EOF'
flywheel-log-janitor.sh --dry-run|--apply [--force] [--module NAME]
Modules: codex_releases codex_sessions codex_artifacts codex_logs_db claude_orphans
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) [[ -z "$MODE" ]] || die "choose exactly one mode"; MODE="dry-run" ;;
      --apply) [[ -z "$MODE" ]] || die "choose exactly one mode"; MODE="apply" ;;
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
  [[ -n "$MODE" ]] || { usage; die "--dry-run or --apply is required"; }
  case "$ONLY_MODULE" in
    ""|codex_releases|codex_sessions|codex_artifacts|codex_logs_db|claude_orphans) ;;
    *) die "unknown module: $ONLY_MODULE" ;;
  esac
}

validate_uint() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be a non-negative integer"
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
          delete_count: ([.[] | select(.action == "delete")] | length),
          would_delete_count: ([.[] | select(.action == "would-delete")] | length),
          skipped_count: ([.[] | select(.action == "skip")] | length),
          freed_bytes: ([.[] | select(.action == "delete") | .bytes] | add // 0),
          candidate_bytes: ([.[] | select(.action == "delete" or .action == "would-delete") | .bytes] | add // 0)
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
    '{ts:$ts,run_id:$run_id,mode:$mode,module:"all",action:"summary",freed_bytes:$freed_bytes,deleted_count:$deleted_count,deleted_file_count:$deleted_file_count,candidate_bytes:$candidate_bytes,candidate_count:$candidate_count,skipped_count:$skipped_count,per_module:$per_module}' \
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
        "<tr><td>\(.key | h)</td><td>\(.value.delete_count)</td><td>\(.value.skipped_count)</td><td>\(.value.freed_bytes)</td></tr>"
      ) | join("")) as $rows |
      "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>日志 Janitor 清理报告</title><style>body{margin:0;background:#f5f5f7;color:#1d1d1f;font:15px -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}.wrap{max-width:920px;margin:0 auto;padding:48px 24px}.eyebrow{color:#6e6e73;font-weight:600}.hero{font-size:42px;line-height:1.08;margin:8px 0 28px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card,.panel{background:#fff;border-radius:18px;padding:22px;box-shadow:0 1px 0 rgba(0,0,0,.04)}.value{font-size:28px;font-weight:700;margin-top:8px}.muted{color:#6e6e73}.panel{margin-top:16px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 8px;border-bottom:1px solid #e8e8ed}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}@media(max-width:720px){.grid{grid-template-columns:1fr 1fr}.hero{font-size:34px}}</style></head><body><main class=\"wrap\"><div class=\"eyebrow\">FLY-1330 · \($generated_at | h)</div><h1 class=\"hero\">日志 Janitor 清理完成</h1><section class=\"grid\"><div class=\"card\"><div class=\"muted\">清理文件</div><div class=\"value\" id=\"deleted-file-count\">\($deleted_file_count | h)</div></div><div class=\"card\"><div class=\"muted\">释放空间</div><div class=\"value\">\($freed_gib | h) GiB</div><div class=\"muted\">\($freed_bytes | h) bytes</div></div><div class=\"card\"><div class=\"muted\">防线拦下</div><div class=\"value\">\($skipped_count | h)</div></div><div class=\"card\"><div class=\"muted\">Run</div><div class=\"value\" style=\"font-size:15px\"><code>\($run_id | h)</code></div></div></section><section class=\"panel\"><h2>时间范围</h2><p><strong>最老删除项：</strong>\($oldest | h)</p><p><strong>最新删除项：</strong>\($newest | h)</p></section><section class=\"panel\"><h2>审计 manifest 摘要</h2><table><thead><tr><th>模块</th><th>处置项</th><th>拦截数</th><th>释放 bytes</th></tr></thead><tbody>\($rows)</tbody></table></section></main></body></html>"
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
  local script_sha
  if command -v shasum >/dev/null 2>&1; then
    script_sha="$(shasum -a 256 "${BASH_SOURCE[0]}" | sed 's/[[:space:]].*$//')"
  elif command -v sha256sum >/dev/null 2>&1; then
    script_sha="$(sha256sum "${BASH_SOURCE[0]}" | sed 's/[[:space:]].*$//')"
  else
    die "shasum or sha256sum is required for the dry-run receipt"
  fi
  [[ "$script_sha" =~ ^[0-9a-fA-F]{64}$ ]] || die "cannot hash janitor script"
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
    --argjson publish_timeout_seconds "$PUBLISH_TIMEOUT_SECONDS" \
    --argjson codex_sessions_days "$RETENTION_CODEX_SESSIONS" \
    --argjson codex_artifacts_days "$RETENTION_CODEX_ARTIFACTS" \
    --argjson claude_orphans_days "$RETENTION_CLAUDE_ORPHANS" \
    --argjson keep_releases "$KEEP_RELEASES" \
    '{script_sha256:$script_sha256,codex_homes:$codex_homes,claude_projects:$claude_projects,teamlead_db:$teamlead_db,disabled_modules:$disabled_modules,report_channel:$report_channel,report_project:$report_project,report_env_file:$report_env_file,report_comm_cli:$report_comm_cli,publish_timeout_seconds:$publish_timeout_seconds,codex_sessions_days:$codex_sessions_days,codex_artifacts_days:$codex_artifacts_days,claude_orphans_days:$claude_orphans_days,keep_releases:$keep_releases}' \
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

main() {
  parse_args "$@"
  validate_uint FLYWHEEL_JANITOR_RETENTION_CODEX_SESSIONS_DAYS "$RETENTION_CODEX_SESSIONS"
  validate_uint FLYWHEEL_JANITOR_RETENTION_CODEX_ARTIFACTS_DAYS "$RETENTION_CODEX_ARTIFACTS"
  validate_uint FLYWHEEL_JANITOR_RETENTION_CLAUDE_ORPHANS_DAYS "$RETENTION_CLAUDE_ORPHANS"
  validate_uint FLYWHEEL_JANITOR_KEEP_RELEASES "$KEEP_RELEASES"
  validate_uint FLYWHEEL_JANITOR_PUBLISH_TIMEOUT_SECONDS "$PUBLISH_TIMEOUT_SECONDS"
  [[ "$KEEP_RELEASES" -ge 1 ]] || die "FLYWHEEL_JANITOR_KEEP_RELEASES must be at least 1"
  [[ "$PUBLISH_TIMEOUT_SECONDS" -ge 1 ]] || die "FLYWHEEL_JANITOR_PUBLISH_TIMEOUT_SECONDS must be at least 1"
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

  module_enabled codex_releases && run_codex_releases
  module_enabled codex_sessions && run_codex_sessions
  module_enabled codex_artifacts && run_codex_artifacts
  module_enabled codex_logs_db && run_codex_logs_db
  module_enabled claude_orphans && run_claude_orphans
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
}

main "$@"
