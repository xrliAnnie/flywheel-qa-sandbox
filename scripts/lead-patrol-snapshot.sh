#!/bin/bash
# FLY-1855: collect the six-step Lead patrol's independent facts and publish a
# fail-visible report skeleton. This script never declares human judgment steps
# healthy and never mutates StateStore, CommDB, GitHub, Discord, or Linear.

set -uo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOUNDED_RUN="$SCRIPT_DIR/lib/bounded-run.sh"
case "$(basename "${BASH_SOURCE[0]}")" in
  lead-patrol-snapshot.sh) DWELL_CONTROL="$SCRIPT_DIR/flywheel-node-dwell-control.mjs" ;;
  flywheel-patrol-snapshot) DWELL_CONTROL="$SCRIPT_DIR/flywheel-node-dwell-control" ;;
  *) DWELL_CONTROL="" ;;
esac
WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/flywheel-patrol.XXXXXX")" || {
  echo "[patrol-snapshot] ERROR: temp_directory_unavailable" >&2
  exit 1
}
CONTINUITY_TMP=""
cleanup_work_tmp() {
  rm -rf "$WORK_TMP"
  [ -z "$CONTINUITY_TMP" ] || rm -f "$CONTINUITY_TMP"
}
trap cleanup_work_tmp EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  echo "Usage: lead-patrol-snapshot.sh --project <project> [--lead <lead-id>] [--tick-seq <n>] [--record-dwell-receipts <verdict> [--note <text>]]" >&2
}

PROJECT_NAME=""
LEAD_ID="${FLYWHEEL_LEAD_ID:-}"
TICK_SEQ="NA"
RECORD_DWELL_VERDICT=""
RECORD_DWELL_NOTE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--lead|--tick-seq|--record-dwell-receipts|--note)
      if [ "$#" -lt 2 ]; then
        echo "[patrol-snapshot] ERROR: $1 requires a value" >&2
        usage
        exit 2
      fi
      case "$1" in
        --project) PROJECT_NAME="$2" ;;
        --lead) LEAD_ID="$2" ;;
        --tick-seq) TICK_SEQ="$2" ;;
        --record-dwell-receipts) RECORD_DWELL_VERDICT="$2" ;;
        --note) RECORD_DWELL_NOTE="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[patrol-snapshot] ERROR: unknown argument" >&2; usage; exit 2 ;;
  esac
done

safe_key() {
  case "$1" in
    ""|.|..|*[!A-Za-z0-9._-]* ) return 1 ;;
  esac
  [ "${#1}" -le 64 ]
}

safe_repo_slug() {
  local slug="$1" owner repo
  case "$slug" in
    ""|/*|*/|*/*/*|*[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  owner="${slug%%/*}"
  repo="${slug#*/}"
  case "$owner" in .|..) return 1 ;; esac
  case "$repo" in .|..) return 1 ;; esac
  [ "${#owner}" -le 64 ] && [ "${#repo}" -le 100 ]
}

if ! safe_key "$PROJECT_NAME" || ! safe_key "$LEAD_ID"; then
  echo "[patrol-snapshot] ERROR: project and lead must match [A-Za-z0-9._-]{1,64} and not be . or .." >&2
  exit 2
fi
case "$TICK_SEQ" in
  NA) ;;
  ""|*[!0-9]*)
    echo "[patrol-snapshot] ERROR: tick sequence must be an unsigned integer" >&2
    exit 2
    ;;
esac
if [ "${#TICK_SEQ}" -gt 16 ]; then
  echo "[patrol-snapshot] ERROR: tick sequence is too long" >&2
  exit 2
fi
if [ -n "$RECORD_DWELL_VERDICT" ]; then
  case "$RECORD_DWELL_VERDICT" in
    normal|cleared|fixed|waiting_founder) ;;
    *) echo "[patrol-snapshot] ERROR: invalid dwell receipt verdict" >&2; exit 2 ;;
  esac
elif [ -n "$RECORD_DWELL_NOTE" ]; then
  echo "[patrol-snapshot] ERROR: --note requires --record-dwell-receipts" >&2
  exit 2
fi
if [ "${#RECORD_DWELL_NOTE}" -gt 1000 ]; then
  echo "[patrol-snapshot] ERROR: dwell receipt note is too long" >&2
  exit 2
fi

STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
STATE_DB="${FLYWHEEL_STATE_DB_PATH:-${TEAMLEAD_DB_PATH:-$HOME/.flywheel/teamlead.db}}"
PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-$STATE_DIR/projects.json}"
REPORT_DIR="$STATE_DIR/patrol-reports/$LEAD_ID"
CONTINUITY_DIR="$STATE_DIR/patrol-continuity/$LEAD_ID"
CONTINUITY_FILE="$CONTINUITY_DIR/$PROJECT_NAME.tsv"
DEFAULT_COMM_DB="$STATE_DIR/comm/$PROJECT_NAME/comm.db"
COMM_DB="$DEFAULT_COMM_DB"
if [ -n "${FLYWHEEL_COMM_DB:-}" ] \
  && [ "$(basename "$(dirname "$FLYWHEEL_COMM_DB")")" = "$PROJECT_NAME" ]; then
  COMM_DB="$FLYWHEEL_COMM_DB"
fi

safe_sqlite_path() {
  case "$1" in
    ""|*"'"*|*"?"*|*"#"*|*$'\n'*|*$'\r'*) return 1 ;;
    *) return 0 ;;
  esac
}

if ! safe_sqlite_path "$STATE_DB" || ! safe_sqlite_path "$COMM_DB"; then
  echo "[patrol-snapshot] ERROR: database path contains URI/SQL control characters" >&2
  exit 2
fi

if [ -n "$RECORD_DWELL_VERDICT" ]; then
  if [ ! -x "$DWELL_CONTROL" ]; then
    echo "RECEIPT_REJECTED helper_unavailable" >&2
    exit 70
  fi
  if [ -n "$RECORD_DWELL_NOTE" ]; then
    exec "$DWELL_CONTROL" receipt-batch --db "$STATE_DB" --comm-db "$COMM_DB" \
      --project "$PROJECT_NAME" --lead "$LEAD_ID" --verdict "$RECORD_DWELL_VERDICT" \
      --note "$RECORD_DWELL_NOTE"
  fi
  exec "$DWELL_CONTROL" receipt-batch --db "$STATE_DB" --comm-db "$COMM_DB" \
    --project "$PROJECT_NAME" --lead "$LEAD_ID" --verdict "$RECORD_DWELL_VERDICT"
fi

readonly_sqlite_uri() { # <db> — immutable is safe only for a closed WAL DB
  local db="$1"
  if [ ! -e "${db}-wal" ] && [ ! -e "${db}-shm" ]; then
    printf 'file:%s?mode=ro&immutable=1' "$db"
  else
    printf 'file:%s?mode=ro' "$db"
  fi
}

STATE_DB_URI="$(readonly_sqlite_uri "$STATE_DB")"
COMM_DB_URI="$(readonly_sqlite_uri "$COMM_DB")"

PROJECT_REPO=""
PROJECTS_OK=0
PROJECT_REGISTRY_OK=0
PROJECT_NAMES=""
if command -v jq >/dev/null 2>&1 && [ -f "$PROJECTS_FILE" ]; then
  if PROJECT_NAMES="$(jq -er '
      if type == "array" and length > 0 and
        all(.[]; (.projectName | type == "string") and
          (.projectName | test("^[A-Za-z0-9._-]{1,64}$")) and
          .projectName != "." and .projectName != "..")
      then [.[].projectName] | unique[]
      else error("invalid project registry") end' \
      "$PROJECTS_FILE" 2>/dev/null)" \
    && printf '%s\n' "$PROJECT_NAMES" | grep -Fxq -- "$PROJECT_NAME"; then
    PROJECT_REGISTRY_OK=1
    PROJECT_REPO="$(jq -er --arg project "$PROJECT_NAME" \
      'first(.[] | select(.projectName == $project) | .projectRepo)' \
      "$PROJECTS_FILE" 2>/dev/null || true)"
    if safe_repo_slug "$PROJECT_REPO"; then
      PROJECTS_OK=1
    else
      PROJECT_REPO=""
    fi
  else
    PROJECT_NAMES=""
  fi
fi

SQL_ERROR_TOKEN="structural: sqlite_unavailable"
classify_sql_error() {
  case "$1" in
    *locked*|*busy*) SQL_ERROR_TOKEN="transient: sqlite_busy" ;;
    *"no such table"*|*"no such column"*) SQL_ERROR_TOKEN="structural: schema_missing" ;;
    *"unable to open"*|*"cannot open"*|*"not a database"*) SQL_ERROR_TOKEN="structural: db_unavailable" ;;
    *) SQL_ERROR_TOKEN="structural: sqlite_error" ;;
  esac
}

run_sql() { # <output-var> <sql>
  local out_var="$1" sql="$2" attempt output rc err_file err_text
  if ! command -v sqlite3 >/dev/null 2>&1; then
    SQL_ERROR_TOKEN="structural: sqlite_unavailable"
    printf -v "$out_var" '%s' ""
    return 1
  fi
  for attempt in 1 2; do
    err_file="$(mktemp "$WORK_TMP/sql.XXXXXX")" || {
      SQL_ERROR_TOKEN="structural: temp_unavailable"
      printf -v "$out_var" '%s' ""
      return 1
    }
    output="$(sqlite3 "$STATE_DB_URI" 2>"$err_file" <<SQL
.bail on
.timeout 3000
.mode list
ATTACH DATABASE '$COMM_DB_URI' AS comm;
$sql
SQL
)"
    rc=$?
    err_text="$(tr '[:upper:]' '[:lower:]' < "$err_file" 2>/dev/null || true)"
    rm -f "$err_file"
    if [ "$rc" -eq 0 ]; then
      printf -v "$out_var" '%s' "$output"
      return 0
    fi
  done
  classify_sql_error "$err_text"
  printf -v "$out_var" '%s' ""
  return 1
}

sha256_text() {
  printf '%s' "$1" | shasum -a 256 2>/dev/null | awk '{print $1}'
}

is_sha256() {
  printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{64}$'
}

append_finding() { # <current> <finding>
  if [ -z "$1" ] || [ "$1" = none ]; then
    printf '%s' "$2"
  else
    printf '%s,%s' "$1" "$2"
  fi
}

COMM_INDEX_ERROR_TOKEN="structural: owner_index_incomplete"
run_comm_index() { # <output-var> <db>
  local out_var="$1" db="$2" attempt output rc err_file err_text uri
  if [ ! -f "$db" ]; then
    printf -v "$out_var" '%s' ""
    return 2
  fi
  if ! safe_sqlite_path "$db" || ! command -v sqlite3 >/dev/null 2>&1; then
    COMM_INDEX_ERROR_TOKEN="structural: owner_index_incomplete"
    printf -v "$out_var" '%s' ""
    return 1
  fi
  uri="$(readonly_sqlite_uri "$db")"
  for attempt in 1 2; do
    err_file="$(mktemp "$WORK_TMP/index.XXXXXX")" || {
      COMM_INDEX_ERROR_TOKEN="structural: owner_index_incomplete"
      printf -v "$out_var" '%s' ""
      return 1
    }
    output="$(sqlite3 "$uri" 2>"$err_file" <<'SQL'
.bail on
.timeout 3000
.mode tabs
SELECT tmux_window, project_name, execution_id, coalesce(lead_id,'')
FROM sessions
WHERE status IN ('running','blocked')
  AND tmux_window <> ''
  AND tmux_window NOT LIKE '%:pending'
ORDER BY tmux_window, execution_id
LIMIT 2000;
SQL
)"
    rc=$?
    err_text="$(tr '[:upper:]' '[:lower:]' < "$err_file" 2>/dev/null || true)"
    rm -f "$err_file"
    if [ "$rc" -eq 0 ]; then
      printf -v "$out_var" '%s' "$output"
      return 0
    fi
  done
  case "$err_text" in
    *locked*|*busy*) COMM_INDEX_ERROR_TOKEN="transient: owner_index_incomplete" ;;
    *) COMM_INDEX_ERROR_TOKEN="structural: owner_index_incomplete" ;;
  esac
  printf -v "$out_var" '%s' ""
  return 1
}

STEP1_STATUS="LEAD-JUDGMENT-REQUIRED"
STEP1_FACTS=""
RUNNER_PANES=""
PANE_LIST_RC=1
TMUX_ERROR_TOKEN="structural: tmux_unavailable"
STEP2_STATUS="OK-CANDIDATE"
STEP2_FACTS=""
OWNER_INDEX=""
OWNER_INDEX_COMPLETE=1
OWNER_INDEX_ERROR_TOKEN="structural: owner_index_incomplete"
OWNED_TARGET_ROWS=""
AMBIGUOUS_TARGET_COUNT=0

if [ "$PROJECT_REGISTRY_OK" -eq 1 ]; then
  while IFS= read -r index_project; do
    [ -n "$index_project" ] || continue
    if ! safe_key "$index_project"; then
      OWNER_INDEX_COMPLETE=0
      continue
    fi
    index_db="$STATE_DIR/comm/$index_project/comm.db"
    if [ "$index_project" = "$PROJECT_NAME" ]; then index_db="$COMM_DB"; fi
    INDEX_ROWS=""
    run_comm_index INDEX_ROWS "$index_db"
    index_rc=$?
    case "$index_rc" in
      0)
        if [ -n "$INDEX_ROWS" ]; then
          OWNER_INDEX="${OWNER_INDEX}${OWNER_INDEX:+$'\n'}$INDEX_ROWS"
        fi
        ;;
      *)
        OWNER_INDEX_COMPLETE=0
        case "$COMM_INDEX_ERROR_TOKEN" in
          transient:*) OWNER_INDEX_ERROR_TOKEN="$COMM_INDEX_ERROR_TOKEN" ;;
        esac
        ;;
    esac
  done <<< "$PROJECT_NAMES"
else
  OWNER_INDEX_COMPLETE=0
fi

# A bound active target without a Lead is not an orphan finding. It means the
# owner index itself is incomplete, so no department Lead may infer ownership.
if printf '%s\n' "$OWNER_INDEX" | awk -F '\t' 'NF && $1 != "" && $4 == "" {found=1} END {exit !found}'; then
  OWNER_INDEX_COMPLETE=0
fi

if [ "$OWNER_INDEX_COMPLETE" -eq 1 ]; then
  OWNED_CLAIMS="$(printf '%s\n' "$OWNER_INDEX" | awk -F '\t' -v project="$PROJECT_NAME" -v lead="$LEAD_ID" '
    $1 != "" && $2 == project && $4 == lead && !seen[$1]++ { print }
  ')"
  while IFS=$'\t' read -r target _claim_project execution_id _claim_lead; do
    [ -n "$target" ] || continue
    target_claims="$(printf '%s\n' "$OWNER_INDEX" | awk -F '\t' -v target="$target" '$1 == target {n++} END {print n+0}')"
    if [ "$target_claims" -ne 1 ]; then
      AMBIGUOUS_TARGET_COUNT=$((AMBIGUOUS_TARGET_COUNT + 1))
      continue
    fi
    OWNED_TARGET_ROWS="${OWNED_TARGET_ROWS}${OWNED_TARGET_ROWS:+$'\n'}${target}"$'\t'"${execution_id}"
  done <<< "$OWNED_CLAIMS"
else
  STEP1_STATUS="UNAVAILABLE($OWNER_INDEX_ERROR_TOKEN)"
  STEP2_STATUS="UNAVAILABLE($OWNER_INDEX_ERROR_TOKEN)"
fi

if [ "$AMBIGUOUS_TARGET_COUNT" -gt 0 ]; then
  STEP1_STATUS="UNAVAILABLE(structural: session_target_ambiguous)"
  STEP2_STATUS="UNAVAILABLE(structural: session_target_ambiguous)"
  STEP1_FACTS="OWNER_SCOPE_ERROR session_target_ambiguous count=$AMBIGUOUS_TARGET_COUNT"
fi

if [ "$OWNER_INDEX_COMPLETE" -eq 1 ]; then
  if command -v tmux >/dev/null 2>&1; then
    TMUX_ERR_FILE="$WORK_TMP/tmux-list.err"
    PANE_LIST_RAW="$(TMUX= tmux list-panes -a -F $'#{pane_id}\t#{session_name}\t#{session_name}:#{window_id}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}' 2>"$TMUX_ERR_FILE")"
    PANE_LIST_RC=$?
    if [ "$PANE_LIST_RC" -eq 0 ]; then
      CANONICAL_PANES="$(printf '%s\n' "$PANE_LIST_RAW" | awk -F '\t' '
        $2 ~ /^runner-/ && $4 ~ /^[A-Z][A-Z0-9]*-[0-9]+($|[-_:])/ { print }
      ')"
      while IFS=$'\t' read -r target execution_id; do
        [ -n "$target" ] || continue
        target_panes="$(printf '%s\n' "$CANONICAL_PANES" | awk -F '\t' -v target="$target" '$3 == target {print}')"
        live_count="$(printf '%s\n' "$target_panes" | awk 'NF {n++} END {print n+0}')"
        roster_fact="ROSTER_EVIDENCE target=$target exec=$execution_id live_panes=$live_count"
        if [ "$live_count" -eq 0 ]; then
          roster_fact="$roster_fact findings=MISSING_PANE"
          case "$STEP1_STATUS" in UNAVAILABLE*) ;; *) STEP1_STATUS="FINDING-CANDIDATE" ;; esac
        else
          roster_fact="$roster_fact findings=none"
          RUNNER_PANES="${RUNNER_PANES}${RUNNER_PANES:+$'\n'}$target_panes"
        fi
        STEP1_FACTS="${STEP1_FACTS}${STEP1_FACTS:+$'\n'}$roster_fact"
      done <<< "$OWNED_TARGET_ROWS"
    else
      TMUX_ERR_TEXT="$(tr '[:upper:]' '[:lower:]' < "$TMUX_ERR_FILE" 2>/dev/null || true)"
      case "$TMUX_ERR_TEXT" in
        *"no server running"*|*"failed to connect to server"*)
          TMUX_ERROR_TOKEN="transient: tmux_server_absent"
          ;;
      esac
      STEP1_STATUS="UNAVAILABLE($TMUX_ERROR_TOKEN)"
      STEP2_STATUS="UNAVAILABLE($TMUX_ERROR_TOKEN)"
    fi
  else
    STEP1_STATUS="UNAVAILABLE(structural: tmux_unavailable)"
    STEP2_STATUS="UNAVAILABLE(structural: tmux_unavailable)"
  fi
fi

if [ -n "$RUNNER_PANES" ]; then
  STEP1_FACTS="${STEP1_FACTS:-(none)}
OWNED_RUNNER_PANES:
$RUNNER_PANES"
else
  STEP1_FACTS="${STEP1_FACTS:-(none)}
OWNED_RUNNER_PANES: (none)"
fi

PANE_COUNT="$(printf '%s\n' "$RUNNER_PANES" | awk 'NF {n++} END {print n+0}')"

NOW_EPOCH="$(date +%s)"
CONTINUITY_CONTENT=""
CONTINUITY_WRITE_READY=1
if ! mkdir -p "$CONTINUITY_DIR" 2>/dev/null; then
  CONTINUITY_WRITE_READY=0
  STEP2_STATUS="UNAVAILABLE(structural: continuity_state_unavailable)"
fi
while IFS=$'\t' read -r pane_id session_name target window_name pane_command pane_dead; do
  [ -n "$pane_id" ] || continue
  owner="owned"
  execution_id="none"
  findings="none"
  action="none"
  result="clear"
  previous_state=""
  previous_change=""
  previous_continuity=""
  if [ -f "$CONTINUITY_FILE" ]; then
    previous_continuity="$(awk -F '\t' -v target="$target" '$1 == target {print; exit}' "$CONTINUITY_FILE" 2>/dev/null || true)"
    IFS=$'\t' read -r _continuity_target previous_state previous_change _legacy_unclaimed <<< "$previous_continuity"
  fi
  if [ "$pane_dead" = 1 ]; then
    findings="$(append_finding "$findings" PANE_DEAD)"
  fi

  execution_id="$(printf '%s\n' "$OWNED_TARGET_ROWS" | awk -F '\t' -v target="$target" '$1 == target {print $2; exit}')"

  capture_hash="unavailable"
  line_count=0
  byte_count=0
  state_hash="unavailable"
  last_change_epoch="$NOW_EPOCH"
  capture_file="$(mktemp "$WORK_TMP/pane.XXXXXX")" || true
  if [ -z "$capture_file" ] || [ ! -x "$BOUNDED_RUN" ] \
    || ! "$BOUNDED_RUN" 5 env TMUX= tmux capture-pane -p -S - -t "$pane_id" > "$capture_file" 2>/dev/null; then
    findings="$(append_finding "$findings" CAPTURE_FAILED)"
    STEP2_STATUS="UNAVAILABLE(structural: pane_capture_incomplete)"
  else
    capture_hash="$(shasum -a 256 "$capture_file" 2>/dev/null | awk '{print $1}')"
    line_count="$(awk 'END {print NR+0}' "$capture_file")"
    byte_count="$(wc -c < "$capture_file" | tr -d ' ')"
    last_state="$(awk 'NF {line=$0} END {printf "%s", line}' "$capture_file")"
    state_hash="$(sha256_text "$last_state")"
    if ! is_sha256 "$capture_hash" || ! is_sha256 "$state_hash"; then
      capture_hash="unavailable"
      state_hash="unavailable"
      findings="$(append_finding "$findings" HASH_UNAVAILABLE)"
      STEP2_STATUS="UNAVAILABLE(structural: hash_unavailable)"
    else
      if [ "$previous_state" = "$state_hash" ]; then
        case "$previous_change" in
          ''|*[!0-9]*)
            findings="$(append_finding "$findings" CONTINUITY_STATE_INVALID)"
            STEP2_STATUS="UNAVAILABLE(structural: continuity_state_invalid)"
            ;;
          *)
            if [ "$previous_change" -le "$NOW_EPOCH" ]; then
              last_change_epoch="$previous_change"
            else
              findings="$(append_finding "$findings" CONTINUITY_STATE_INVALID)"
              STEP2_STATUS="UNAVAILABLE(structural: continuity_state_invalid)"
            fi
            ;;
        esac
      fi
      if [ $((NOW_EPOCH - last_change_epoch)) -ge 3600 ]; then
        findings="$(append_finding "$findings" STALLED_60M)"
      fi
    fi
    filtered_capture="$(grep -Eiv 'not your (session|usage) limit' "$capture_file" 2>/dev/null || true)"
    recent_capture="$(printf '%s\n' "$filtered_capture" | tail -80)"
    if printf '%s\n' "$recent_capture" | grep -Eiq "You've hit your (session|usage) limit|Claude usage limit reached"; then
      findings="$(append_finding "$findings" LIMIT_LIVE)"
    elif printf '%s\n' "$filtered_capture" | grep -Eiq "You've hit your (session|usage) limit|Claude usage limit reached"; then
      findings="$(append_finding "$findings" LIMIT_HISTORY)"
    fi
    if printf '%s\n' "$recent_capture" | grep -Eiq 'Press Enter to (confirm|continue)|resume menu'; then
      findings="$(append_finding "$findings" INTERACTIVE_MENU)"
    fi
  fi
  rm -f "$capture_file" 2>/dev/null || true
  CONTINUITY_CONTENT="${CONTINUITY_CONTENT}${CONTINUITY_CONTENT:+$'\n'}${target}"$'\t'"${state_hash}"$'\t'"${last_change_epoch}"

  if [ "$findings" != none ]; then
    action="REQUIRED"
    result="UNSET"
    case "$STEP2_STATUS" in
      UNAVAILABLE*) ;;
      *) STEP2_STATUS="FINDING-CANDIDATE" ;;
    esac
  fi
  evidence="PANE_EVIDENCE pane=$pane_id target=$target owner=$owner exec=$execution_id capture_sha256=$capture_hash lines=$line_count bytes=$byte_count state_sha256=$state_hash last_change_epoch=$last_change_epoch findings=$findings action=$action result=$result"
  STEP2_FACTS="${STEP2_FACTS}${STEP2_FACTS:+$'\n'}$evidence"
done <<< "$RUNNER_PANES"

if [ "$PANE_LIST_RC" -eq 0 ] && [ "$CONTINUITY_WRITE_READY" -eq 1 ]; then
  CONTINUITY_TMP="$CONTINUITY_DIR/.$PROJECT_NAME.tsv.tmp.$$"
  if ! printf '%s%s' "$CONTINUITY_CONTENT" "${CONTINUITY_CONTENT:+$'\n'}" > "$CONTINUITY_TMP" \
    || ! chmod 0600 "$CONTINUITY_TMP" 2>/dev/null \
    || ! mv -f "$CONTINUITY_TMP" "$CONTINUITY_FILE"; then
    rm -f "$CONTINUITY_TMP" 2>/dev/null || true
    STEP2_STATUS="UNAVAILABLE(structural: continuity_state_unavailable)"
    STEP2_FACTS="${STEP2_FACTS}${STEP2_FACTS:+$'\n'}CONTINUITY_STATE_WRITE_FAILED"
  fi
  CONTINUITY_TMP=""
fi

STEP2_FACTS="pane_count=$PANE_COUNT${STEP2_FACTS:+$'\n'}${STEP2_FACTS}"

# Resolve a patrol fact's owner from the execution row first, then the current
# issue cohort, then only the latest historical cohort. Every caller defines an
# attribution_subjects(execution_id, issue_id) CTE before expanding this block.
# Existing patrol steps stay live-session-only; STEP DWELL alone supplies its
# durable identity relation so pruned founder gates remain attributable without
# widening STEP 3/4/5 ownership.
owner_attribution_ctes() {
  local exact_relation="$1"
  local issue_fallback_relation="${2:-}"
  local latest_issue_fallback_sql=""
  if [ -n "$issue_fallback_relation" ]; then
    latest_issue_fallback_sql=$(cat <<SQL
  UNION ALL
  SELECT lineage.execution_id, lineage.project_name, lineage.issue_id,
         lineage.lead_id, '' AS started_at
  FROM $issue_fallback_relation lineage
  WHERE NOT EXISTS (
    SELECT 1 FROM comm.sessions historical
    WHERE historical.project_name = lineage.project_name
      AND historical.issue_id = lineage.issue_id
  )
SQL
)
  fi
  cat <<SQL
exact_resolution AS (
  SELECT x.execution_id, x.issue_id,
         count(cs.execution_id) AS row_count,
         count(nullif(trim(cs.lead_id),'')) AS owner_count,
         count(DISTINCT nullif(trim(cs.lead_id),'')) AS distinct_owner_count,
         min(nullif(trim(cs.lead_id),'')) AS owner
  FROM attribution_subjects x
  LEFT JOIN $exact_relation cs ON cs.execution_id = x.execution_id
    AND cs.project_name = '$PROJECT_NAME'
  GROUP BY x.execution_id, x.issue_id
),
current_identity AS (
  SELECT execution_id, project_name, issue_id, lead_id
  FROM comm.sessions
  WHERE status IN ('running','blocked')
),
current_resolution AS (
  SELECT x.execution_id, x.issue_id,
         count(cs.execution_id) AS row_count,
         count(nullif(trim(cs.lead_id),'')) AS owner_count,
         count(DISTINCT nullif(trim(cs.lead_id),'')) AS distinct_owner_count,
         min(nullif(trim(cs.lead_id),'')) AS owner
  FROM attribution_subjects x
  LEFT JOIN current_identity cs ON cs.issue_id = x.issue_id
    AND cs.project_name = '$PROJECT_NAME'
  GROUP BY x.execution_id, x.issue_id
),
latest_identity AS (
  SELECT execution_id, project_name, issue_id, lead_id, started_at
  FROM comm.sessions
$latest_issue_fallback_sql
),
latest_cohort AS (
  SELECT x.execution_id, x.issue_id, max(cs.started_at) AS latest_started_at
  FROM attribution_subjects x
  LEFT JOIN latest_identity cs ON cs.issue_id = x.issue_id
    AND cs.project_name = '$PROJECT_NAME'
  GROUP BY x.execution_id, x.issue_id
),
latest_resolution AS (
  SELECT x.execution_id, x.issue_id,
         count(cs.execution_id) AS row_count,
         count(nullif(trim(cs.lead_id),'')) AS owner_count,
         count(DISTINCT nullif(trim(cs.lead_id),'')) AS distinct_owner_count,
         min(nullif(trim(cs.lead_id),'')) AS owner
  FROM attribution_subjects x
  JOIN latest_cohort lc ON lc.execution_id IS x.execution_id AND lc.issue_id = x.issue_id
  LEFT JOIN latest_identity cs ON cs.issue_id = x.issue_id
    AND cs.project_name = '$PROJECT_NAME'
    AND cs.started_at = lc.latest_started_at
  GROUP BY x.execution_id, x.issue_id
),
owner_resolution AS (
  SELECT e.execution_id, e.issue_id,
    CASE
      WHEN e.row_count > 0 AND e.owner_count = e.row_count AND e.distinct_owner_count = 1 THEN e.owner
      WHEN e.row_count > 0 THEN NULL
      WHEN c.row_count > 0 AND c.owner_count = c.row_count AND c.distinct_owner_count = 1 THEN c.owner
      WHEN c.row_count > 0 THEN NULL
      WHEN l.row_count > 0 AND l.owner_count = l.row_count AND l.distinct_owner_count = 1 THEN l.owner
      ELSE NULL
    END AS attributed_lead,
    CASE
      WHEN e.row_count > 0 AND e.owner_count <> e.row_count THEN 'execution_owner_invalid'
      WHEN e.row_count > 0 AND e.distinct_owner_count <> 1 THEN 'execution_owner_ambiguous'
      WHEN e.row_count > 0 THEN NULL
      WHEN c.row_count > 0 AND c.owner_count <> c.row_count THEN 'current_owner_invalid'
      WHEN c.row_count > 0 AND c.distinct_owner_count <> 1 THEN 'current_owner_ambiguous'
      WHEN c.row_count > 0 THEN NULL
      WHEN l.row_count > 0 AND l.owner_count <> l.row_count THEN 'latest_owner_invalid'
      WHEN l.row_count > 0 AND l.distinct_owner_count <> 1 THEN 'latest_owner_ambiguous'
      WHEN l.row_count > 0 THEN NULL
      ELSE 'owner_missing'
    END AS attribution_error
  FROM exact_resolution e
  JOIN current_resolution c ON c.execution_id IS e.execution_id AND c.issue_id = e.issue_id
  JOIN latest_resolution l ON l.execution_id IS e.execution_id AND l.issue_id = e.issue_id
)
SQL
}
OWNER_ATTRIBUTION_CTES="$(owner_attribution_ctes comm.sessions)"
DWELL_OWNER_ATTRIBUTION_CTES="$(owner_attribution_ctes dwell_owner_execution_identity comm.session_receipt_lineage)"

STEP3_FACTS=""
STEP3_SQL=$(cat <<SQL
WITH active AS (
  SELECT DISTINCT wr.issue_id, n.node_id, n.attempt, n.execution_id
  FROM workflow_run wr
  JOIN workflow_run_node n ON n.run_id = wr.run_id
  WHERE wr.project_name = '$PROJECT_NAME'
    AND wr.status = 'active'
    AND n.state = 'running'
),
attribution_subjects AS (
  SELECT DISTINCT execution_id, issue_id FROM active
),
$OWNER_ATTRIBUTION_CTES,
owned_active AS (
  SELECT a.*
  FROM active a
  JOIN owner_resolution o ON o.execution_id IS a.execution_id AND o.issue_id = a.issue_id
  WHERE o.attributed_lead = '$LEAD_ID'
    AND NOT EXISTS (SELECT 1 FROM owner_resolution WHERE attribution_error IS NOT NULL)
)
SELECT 'OWNER_ATTRIBUTION_INCOMPLETE reason=' || attribution_error || ' count=' || count(*)
FROM owner_resolution
WHERE attribution_error IS NOT NULL
GROUP BY attribution_error
UNION ALL
SELECT 'TURN_MISSING issue=' || a.issue_id || ' node=' || a.node_id || ' attempt=' || a.attempt
FROM owned_active a
LEFT JOIN comm.three_stage_turn t ON t.issue_id = a.issue_id
WHERE t.issue_id IS NULL
UNION ALL
SELECT 'TURN_HOLDER_NOT_LIVE issue=' || a.issue_id || ' holder=' || substr(t.holder_exec_id,1,8)
FROM (SELECT DISTINCT issue_id FROM owned_active) a
JOIN comm.three_stage_turn t ON t.issue_id = a.issue_id
WHERE NOT EXISTS (
  SELECT 1 FROM sessions s
  WHERE s.issue_id = a.issue_id
    AND s.project_name = '$PROJECT_NAME'
    AND s.status IN ('running','ship_parked','awaiting_review','design_done','approved_to_ship')
    AND s.execution_id = t.holder_exec_id
)
UNION ALL
SELECT 'NO_TURN_STREAK issue=' || a.issue_id || ' exec=' || substr(a.execution_id,1,8) || ' streak=' || w.no_turn_streak
FROM owned_active a
JOIN sessions s ON s.execution_id = a.execution_id
  AND s.project_name = '$PROJECT_NAME'
  AND s.status IN ('running','ship_parked','awaiting_review','design_done','approved_to_ship')
JOIN comm.turn_wait_ledger w ON w.execution_id = a.execution_id
WHERE w.no_turn_streak >= 3
UNION ALL
SELECT 'NODE_SESSION_NOT_LIVE issue=' || a.issue_id || ' exec=' || coalesce(substr(a.execution_id,1,8),'none')
FROM owned_active a
WHERE a.execution_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM sessions s
  WHERE s.execution_id = a.execution_id
    AND s.project_name = '$PROJECT_NAME'
    AND s.status IN ('running','ship_parked','awaiting_review','design_done','approved_to_ship')
)
ORDER BY 1
LIMIT 500;
SQL
)
if run_sql STEP3_FACTS "$STEP3_SQL"; then
  if printf '%s\n' "$STEP3_FACTS" | grep -q '^OWNER_ATTRIBUTION_INCOMPLETE '; then
    STEP3_STATUS="UNAVAILABLE(structural: owner_attribution_incomplete)"
  elif [ -n "$STEP3_FACTS" ]; then
    STEP3_STATUS="FINDING-CANDIDATE"
  else
    STEP3_STATUS="OK-CANDIDATE"
  fi
else
  STEP3_STATUS="UNAVAILABLE($SQL_ERROR_TOKEN)"
fi

STEP4_FACTS=""
STEP4_BASE_FACTS=""
STEP4_SQL=$(cat <<SQL
WITH stale_mail AS (
  SELECT m.*, s.issue_id
  FROM comm.mailbox m
  JOIN sessions s ON s.execution_id = m.to_agent
    AND s.project_name = '$PROJECT_NAME'
    AND s.status IN ('running','ship_parked','awaiting_review','design_done','approved_to_ship')
  WHERE m.recipient_kind = 'runner'
    AND (
      (m.state = 'QUEUED' AND julianday(m.created_at) <= julianday('now','-30 minutes'))
      OR
      (m.state = 'LEASED'
        AND julianday(m.claim_expires_at) <= julianday('now')
        AND julianday(m.created_at) >= julianday('now','-24 hours'))
    )
),
wake_candidates AS (
  SELECT w.*
  FROM comm.turn_wake_outbox w
  JOIN workflow_run_node n ON n.execution_id = w.execution_id AND n.state = 'running'
  JOIN workflow_run wr ON wr.run_id = n.run_id
    AND wr.project_name = '$PROJECT_NAME' AND wr.status = 'active'
  WHERE w.state IN ('pending','sent')
    AND w.acked_at IS NULL
    AND w.created_at <= (unixepoch('now','-15 minutes') * 1000)
),
verdict_candidates AS (
  SELECT wr.issue_id, b.node_id, b.attempt, b.head_sha, n.execution_id,
         min(c.subject_digest) AS claim_digest
  FROM workflow_run wr
  JOIN workflow_node_pr_binding b ON b.run_id = wr.run_id
  JOIN workflow_claims c ON c.workflow_run_id = b.run_id
    AND c.node_id = b.node_id AND c.attempt = b.attempt
    AND c.predicate IN ('codex_approved','qa_passed','founder_approved')
    AND c.subject_kind = 'git_head'
    AND (c.permanent = 1 OR julianday(c.expires_at) > julianday('now'))
  LEFT JOIN workflow_run_node n ON n.run_id = b.run_id
    AND n.node_id = b.node_id AND n.attempt = b.attempt AND n.state = 'running'
  WHERE wr.project_name = '$PROJECT_NAME' AND wr.status = 'active'
  GROUP BY wr.issue_id, b.node_id, b.attempt, b.head_sha, n.execution_id
  HAVING sum(CASE WHEN c.subject_digest = b.head_sha THEN 1 ELSE 0 END) = 0
),
failed_review_candidates AS (
  SELECT j.request_id, j.execution_id, s.issue_id, j.review_type, j.round,
         j.failure_reason, j.updated_at, j.retry_at
  FROM codex_review_job j
  JOIN sessions s ON s.execution_id = j.execution_id
    AND s.project_name = '$PROJECT_NAME'
    AND s.status IN ('running','ship_parked','awaiting_review','design_done','approved_to_ship')
  WHERE j.project_name = '$PROJECT_NAME'
    AND j.status = 'failed'
    AND EXISTS (
      SELECT 1 FROM comm.sessions cs
      WHERE cs.execution_id = j.execution_id
        AND cs.project_name = '$PROJECT_NAME'
        AND nullif(trim(cs.lead_id),'') IS NOT NULL
    )
    AND (
      j.retry_at IS NOT NULL
      OR julianday(coalesce(j.updated_at,j.created_at)) >= julianday('now','-24 hours')
    )
    AND coalesce(j.failure_reason,'') NOT IN (
      'head_moved','reviewed_wrong_head','gate_answered_externally','gate_answered',
      'gate_expired','gate_missing','gate_mismatch','gate_unknown','superseded_by_revision'
    )
),
attribution_subjects AS (
  SELECT DISTINCT to_agent AS execution_id, issue_id FROM stale_mail
  UNION
  SELECT DISTINCT execution_id, issue_id FROM wake_candidates
  UNION
  SELECT DISTINCT execution_id, issue_id FROM verdict_candidates
  UNION
  SELECT DISTINCT execution_id, issue_id FROM failed_review_candidates
),
$OWNER_ATTRIBUTION_CTES
SELECT 'OWNER_ATTRIBUTION_INCOMPLETE reason=' || attribution_error || ' count=' || count(*)
FROM owner_resolution
WHERE attribution_error IS NOT NULL
GROUP BY attribution_error
UNION ALL
SELECT 'MAILBOX_STALE id=' || substr(m.id,1,12) || ' to=' || substr(m.to_agent,1,8) ||
       ' state=' || m.state || ' created=' || m.created_at ||
       ' claim_expires=' || coalesce(m.claim_expires_at,'-')
FROM stale_mail m
JOIN owner_resolution o ON o.execution_id IS m.to_agent AND o.issue_id = m.issue_id
WHERE o.attributed_lead = '$LEAD_ID'
  AND NOT EXISTS (SELECT 1 FROM owner_resolution WHERE attribution_error IS NOT NULL)
UNION ALL
SELECT 'WAKE_UNACKED wake=' || substr(w.wake_id,1,16) || ' issue=' || w.issue_id ||
       ' exec=' || substr(w.execution_id,1,8) || ' state=' || w.state || ' created_ms=' || w.created_at
FROM wake_candidates w
JOIN owner_resolution o ON o.execution_id IS w.execution_id AND o.issue_id = w.issue_id
WHERE o.attributed_lead = '$LEAD_ID'
  AND NOT EXISTS (SELECT 1 FROM owner_resolution WHERE attribution_error IS NOT NULL)
UNION ALL
SELECT 'DEAD_LETTER_PENDING id=' || substr(d.id,1,16) || ' recipient=' || substr(d.recipient,1,12) ||
       ' source=' || d.source_kind || ' lead=' || d.lead_id || ' project=' || d.project_name ||
       ' count=' || d.dead_count || ' state=' || d.state || ' created=' || d.created_at
FROM dead_letter_alerts d
WHERE d.state = 'pending'
  AND d.project_name = '$PROJECT_NAME'
  AND d.lead_id = '$LEAD_ID'
  AND julianday(d.created_at) >= julianday('now','-24 hours')
  AND NOT EXISTS (SELECT 1 FROM owner_resolution WHERE attribution_error IS NOT NULL)
UNION ALL
SELECT 'VERDICT_HEAD_MISMATCH issue=' || v.issue_id || ' node=' || v.node_id ||
       ' attempt=' || v.attempt || ' head=' || substr(v.head_sha,1,8) ||
       ' claim=' || substr(v.claim_digest,1,8)
FROM verdict_candidates v
JOIN owner_resolution o ON o.execution_id IS v.execution_id AND o.issue_id = v.issue_id
WHERE o.attributed_lead = '$LEAD_ID'
  AND NOT EXISTS (SELECT 1 FROM owner_resolution WHERE attribution_error IS NOT NULL)
UNION ALL
SELECT 'REVIEW_JOB_FAILED issue=' || f.issue_id || ' request=' || f.request_id ||
       ' type=' || f.review_type || ' round=' || f.round ||
       ' reason=' || coalesce(f.failure_reason,'unknown') ||
       ' updated=' || coalesce(f.updated_at,'-') ||
       ' retry_at=' || coalesce(f.retry_at,'-') ||
       ' recovery=' || CASE
         WHEN f.failure_reason = 'head_moved_exhausted'
           THEN 'open_new_review_gate_current_head'
         ELSE 'POST_/review-requests_same_requestId'
       END
FROM failed_review_candidates f
JOIN owner_resolution o ON o.execution_id IS f.execution_id AND o.issue_id = f.issue_id
WHERE o.attributed_lead = '$LEAD_ID'
  AND NOT EXISTS (SELECT 1 FROM owner_resolution WHERE attribution_error IS NOT NULL)
ORDER BY 1
LIMIT 500;
SQL
)
STEP4_BASE_OK=0
STEP4_BASE_ERROR_TOKEN=""
if run_sql STEP4_BASE_FACTS "$STEP4_SQL"; then
  STEP4_BASE_OK=1
else
  STEP4_BASE_ERROR_TOKEN="$SQL_ERROR_TOKEN"
fi

# FLY-2152 sixth dimension: marked workflow verdict claims are durable facts,
# independent of whether the submitting Runner remembered to notify its Lead.
# Keep this query separate from the existing delivery query: malformed claim
# attribution closes only this branch and cannot suppress mailbox/wake/dead-letter
# or head-mismatch facts already collected above.
STEP4_CLAIM_FACTS=""
STEP4_CLAIM_SQL=$(cat <<SQL
WITH claim_candidates AS (
  SELECT c.id, c.issue_id, c.workflow_run_id, c.node_id, c.attempt,
         c.decision_kind, c.predicate, c.issued_at, c.issuer_execution_id
  FROM workflow_claims c
  JOIN workflow_run wr ON wr.run_id = c.workflow_run_id
  WHERE wr.project_name = '$PROJECT_NAME'
    AND wr.status = 'active'
    AND c.issuer_kind = 'runner_node'
    AND c.client_request_id IS NOT NULL
    AND c.issuer_execution_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM workflow_claim_revocation r WHERE r.claim_id = c.id
    )
),
marker_rows AS (
  SELECT c.*,
         e.id AS marker_id,
         CASE WHEN json_valid(e.payload) = 1
                   AND (json_type(e.payload,'$.leadEventRequired') IS NOT NULL
                        OR json_type(e.payload,'$.leadEventId') IS NOT NULL)
              THEN 1 ELSE 0 END AS marker_contract,
         CASE WHEN json_valid(e.payload) = 1
                   AND json_extract(e.payload,'$.leadEventRequired') = 1
                   AND json_extract(e.payload,'$.leadEventId') = 'workflow_claim:' || c.id
              THEN 1 ELSE 0 END AS marker_valid,
         CASE WHEN json_valid(e.payload) = 1
              THEN json_extract(e.payload,'$.leadEventId') ELSE NULL END AS lead_event_id
  FROM claim_candidates c
  LEFT JOIN workflow_run_event e ON e.run_id = c.workflow_run_id
    AND e.kind = 'claim_written'
    AND CASE WHEN json_valid(e.payload) = 1
             THEN json_extract(e.payload,'$.claimId') = c.id ELSE 0 END
),
marker_resolution AS (
  SELECT id, issue_id, workflow_run_id, node_id, attempt, decision_kind,
         predicate, issued_at, issuer_execution_id,
         count(marker_id) AS marker_count,
         sum(marker_contract) AS contract_marker_count,
         sum(marker_valid) AS valid_marker_count,
         min(CASE WHEN marker_valid = 1 THEN lead_event_id END) AS lead_event_id
  FROM marker_rows
  GROUP BY id, issue_id, workflow_run_id, node_id, attempt, decision_kind,
           predicate, issued_at, issuer_execution_id
),
marked_claims AS (
  SELECT * FROM marker_resolution
  WHERE marker_count = 1 AND contract_marker_count = 1 AND valid_marker_count = 1
),
attribution_subjects AS (
  SELECT DISTINCT issuer_execution_id AS execution_id, issue_id FROM marked_claims
),
$OWNER_ATTRIBUTION_CTES,
claim_delivery AS (
  SELECT c.*, o.attributed_lead,
         count(le.seq) AS event_count,
         sum(CASE WHEN le.lead_id = o.attributed_lead THEN 1 ELSE 0 END) AS owner_event_count,
         sum(CASE WHEN le.lead_id = o.attributed_lead AND le.delivered_at IS NULL THEN 1 ELSE 0 END) AS pending_owner_count,
         sum(CASE WHEN le.lead_id = o.attributed_lead AND le.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered_owner_count
  FROM marked_claims c
  JOIN owner_resolution o ON o.execution_id IS c.issuer_execution_id AND o.issue_id = c.issue_id
  LEFT JOIN lead_events le ON le.event_type = 'workflow_claim_recorded'
    AND le.event_id = c.lead_event_id
  WHERE o.attribution_error IS NULL
  GROUP BY c.id, c.issue_id, c.workflow_run_id, c.node_id, c.attempt,
           c.decision_kind, c.predicate, c.issued_at, c.issuer_execution_id,
           c.lead_event_id, o.attributed_lead
)
SELECT 'CLAIM_ATTRIBUTION_INCOMPLETE reason=claim_delivery_marker_invalid count=' || count(*)
FROM marker_resolution
WHERE contract_marker_count > 0
  AND (marker_count <> 1 OR contract_marker_count <> 1 OR valid_marker_count <> 1)
HAVING count(*) > 0
UNION ALL
SELECT 'CLAIM_ATTRIBUTION_INCOMPLETE reason=' || attribution_error || ' count=' || count(*)
FROM owner_resolution
WHERE attribution_error IS NOT NULL
GROUP BY attribution_error
UNION ALL
SELECT CASE
         WHEN d.event_count = 0 THEN 'CLAIM_DELIVERY_MISSING'
         WHEN d.owner_event_count = 0 THEN 'CLAIM_DELIVERY_OWNER_MISMATCH'
         ELSE 'CLAIM_DELIVERY_PENDING'
       END ||
       ' issue=' || coalesce(d.issue_id,'none') ||
       ' claim=' || coalesce(CAST(d.id AS TEXT),'none') ||
       ' decision=' || coalesce(d.decision_kind,'none') ||
       ' predicate=' || coalesce(d.predicate,'none') ||
       ' issued=' || coalesce(d.issued_at,'none') ||
       ' node=' || coalesce(d.node_id,'none') ||
       ' attempt=' || coalesce(CAST(d.attempt AS TEXT),'none') ||
       ' exec=' || coalesce(d.issuer_execution_id,'none')
FROM claim_delivery d
WHERE d.attributed_lead = '$LEAD_ID'
  AND (d.event_count = 0 OR d.owner_event_count = 0 OR d.pending_owner_count > 0)
  AND d.delivered_owner_count = 0
ORDER BY 1
LIMIT 500;
SQL
)
STEP4_CLAIM_OK=0
STEP4_CLAIM_ERROR_TOKEN=""
if run_sql STEP4_CLAIM_FACTS "$STEP4_CLAIM_SQL"; then
  STEP4_CLAIM_OK=1
else
  STEP4_CLAIM_ERROR_TOKEN="$SQL_ERROR_TOKEN"
fi

STEP4_FACTS="$STEP4_BASE_FACTS"
if [ -n "$STEP4_CLAIM_FACTS" ]; then
  STEP4_FACTS="${STEP4_FACTS:+$STEP4_FACTS$'\n'}$STEP4_CLAIM_FACTS"
fi
if [ "$STEP4_BASE_OK" != 1 ]; then
  STEP4_STATUS="UNAVAILABLE($STEP4_BASE_ERROR_TOKEN)"
elif [ "$STEP4_CLAIM_OK" != 1 ]; then
  STEP4_STATUS="UNAVAILABLE($STEP4_CLAIM_ERROR_TOKEN)"
elif printf '%s\n' "$STEP4_BASE_FACTS" | grep -q '^OWNER_ATTRIBUTION_INCOMPLETE '; then
  STEP4_STATUS="UNAVAILABLE(structural: owner_attribution_incomplete)"
elif [ -n "$STEP4_FACTS" ]; then
  STEP4_STATUS="FINDING-CANDIDATE"
else
  STEP4_STATUS="OK-CANDIDATE"
fi

STEP5_FACTS=""
STEP5_STATUS="LEAD-JUDGMENT-REQUIRED"
if [ "$PROJECTS_OK" != 1 ] || ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  STEP5_STATUS="UNAVAILABLE(structural: gh_unavailable)"
else
  PR_JSON="$(GH_REPO="$PROJECT_REPO" gh api 'repos/{owner}/{repo}/pulls?state=open&per_page=50' 2>/dev/null)"
  PR_RC=$?
  RUN_JSON="$(GH_REPO="$PROJECT_REPO" gh api 'repos/{owner}/{repo}/actions/runs?per_page=5' 2>/dev/null)"
  RUN_RC=$?
  if [ "$PR_RC" -ne 0 ] || [ "$RUN_RC" -ne 0 ]; then
    STEP5_STATUS="UNAVAILABLE(structural: gh_unavailable)"
  elif ! printf '%s' "$PR_JSON" | jq -e '
      type == "array" and all(.[ ];
        (.number | type == "number") and
        (.draft | type == "boolean") and
        (.head | type == "object") and (.head.sha | type == "string") and
        (.updated_at | type == "string"))' >/dev/null 2>&1 \
    || ! printf '%s' "$RUN_JSON" | jq -e '
      type == "object" and (.workflow_runs | type == "array") and
      all(.workflow_runs[ ];
        (.id | type == "number") and
        (.status | type == "string") and
        (.created_at | type == "string"))' >/dev/null 2>&1; then
    STEP5_STATUS="UNAVAILABLE(structural: gh_schema)"
  else
    PR_FACTS="$(printf '%s' "$PR_JSON" | jq -r '.[] | "PR number=\(.number) draft=\(.draft) head=\(.head.sha[0:8]) updated=\(.updated_at)"' 2>/dev/null)"
    PR_PARSE_RC=$?
    RUN_FACTS="$(printf '%s' "$RUN_JSON" | jq -r '.workflow_runs[] | "RUN id=\(.id) status=\(.status) created=\(.created_at)"' 2>/dev/null)"
    RUN_PARSE_RC=$?
    if [ "$PR_PARSE_RC" -ne 0 ] || [ "$RUN_PARSE_RC" -ne 0 ]; then
      STEP5_STATUS="UNAVAILABLE(structural: gh_schema)"
    else
      STEP5_FACTS="repo=$PROJECT_REPO
${PR_FACTS:-PR none}
${RUN_FACTS:-RUN none}
Discord: resolve at most 2 recent roster identifiers via /api/chat-threads, then run fetch_messages."
    fi
  fi
fi

STEP6_STATUS="LEAD-JUDGMENT-REQUIRED"
STEP6_FACTS='Finalize every STEP status; route UNAVAILABLE per runner-patrol-rules.md.'

# FLY-2210: independent workflow-node dwell dimension. Keep this outside the
# numeric STEP 1-6 sequence so existing extractors retain their exact contract.
STEP_DWELL_STATUS="OK"
STEP_DWELL_FACTS=""
DWELL_THRESHOLD_OUTPUT=""
DWELL_THRESHOLD_HOURS=""
DWELL_THRESHOLD_SECONDS=""
DWELL_OPEN_GATE_ROWS_SQL=""
DWELL_ENABLED=""
if [ ! -x "$DWELL_CONTROL" ]; then
  STEP_DWELL_STATUS="UNAVAILABLE(structural: helper_unavailable)"
  STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=helper_unavailable"
else
  DWELL_ENABLED_OUTPUT="$("$DWELL_CONTROL" enabled --db "$STATE_DB" --project "$PROJECT_NAME" 2>&1)"
  DWELL_ENABLED_RC=$?
  if [ "$DWELL_ENABLED_RC" -ne 0 ]; then
    DWELL_TOKEN="$(printf '%s\n' "$DWELL_ENABLED_OUTPUT" | awk '/^NODE_DWELL_UNAVAILABLE [A-Za-z0-9_]+/{print $2; exit}')"
    [ -n "$DWELL_TOKEN" ] || DWELL_TOKEN="flag_unavailable"
    STEP_DWELL_STATUS="UNAVAILABLE(structural: $DWELL_TOKEN)"
    STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=$DWELL_TOKEN"
  elif [ "$DWELL_ENABLED_OUTPUT" = "NODE_DWELL_ENABLED project=$PROJECT_NAME enabled=yes" ]; then
    DWELL_ENABLED="yes"
  elif [ "$DWELL_ENABLED_OUTPUT" = "NODE_DWELL_ENABLED project=$PROJECT_NAME enabled=no" ]; then
    DWELL_ENABLED="no"
  else
    STEP_DWELL_STATUS="UNAVAILABLE(structural: flag_invalid)"
    STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=flag_invalid"
  fi
  if [ "$DWELL_ENABLED" = "yes" ]; then
  DWELL_GATE_OUTPUT="$("$DWELL_CONTROL" open-approve-gates --comm-db "$COMM_DB" 2>&1)"
  DWELL_GATE_RC=$?
  if [ "$DWELL_GATE_RC" -ne 0 ]; then
    DWELL_TOKEN="$(printf '%s\n' "$DWELL_GATE_OUTPUT" | awk '/^NODE_DWELL_UNAVAILABLE [A-Za-z0-9_]+/{print $2; exit}')"
    [ -n "$DWELL_TOKEN" ] || DWELL_TOKEN="question_domain_unavailable"
    STEP_DWELL_STATUS="UNAVAILABLE(structural: $DWELL_TOKEN)"
    STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=$DWELL_TOKEN"
  else
    DWELL_OPEN_GATE_ROWS_SQL="$(printf '%s\n' "$DWELL_GATE_OUTPUT" | awk '
      function valid_hex(value) { return value ~ /^([0-9a-f][0-9a-f])+$/ }
      BEGIN { rows=0; summaries=0; expected=-1; quote=sprintf("%c",39); bad=0 }
      $1 == "NODE_DWELL_OPEN_APPROVE_GATE" {
        id=$2; sender=$3
        sub(/^id_hex=/,"",id); sub(/^from_hex=/,"",sender)
        if (NF != 3 || !valid_hex(id) || !valid_hex(sender)) { bad=1; next }
        if (rows > 0) print " UNION ALL"
        printf "SELECT CAST(X%s%s%s AS TEXT) AS id, CAST(X%s%s%s AS TEXT) AS from_agent", quote,id,quote,quote,sender,quote
        rows++
        next
      }
      $1 == "NODE_DWELL_OPEN_APPROVE_GATES" {
        count=$2; sub(/^count=/,"",count)
        if (NF != 2 || count !~ /^[0-9]+$/) { bad=1; next }
        summaries++; expected=count + 0
        next
      }
      NF > 0 { bad=1 }
      END {
        if (bad || summaries != 1 || expected != rows) exit 2
        if (rows == 0) print "SELECT NULL AS id, NULL AS from_agent WHERE 0"
        else print ""
      }
    ')"
    DWELL_GATE_PARSE_RC=$?
    if [ "$DWELL_GATE_PARSE_RC" -ne 0 ]; then
      STEP_DWELL_STATUS="UNAVAILABLE(structural: question_domain_invalid)"
      STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=question_domain_invalid"
    fi
  fi
  if [ "$STEP_DWELL_STATUS" = "OK" ]; then
  DWELL_THRESHOLD_OUTPUT="$("$DWELL_CONTROL" threshold --db "$STATE_DB" --project "$PROJECT_NAME" 2>&1)"
  DWELL_THRESHOLD_RC=$?
  if [ "$DWELL_THRESHOLD_RC" -ne 0 ]; then
    DWELL_TOKEN="$(printf '%s\n' "$DWELL_THRESHOLD_OUTPUT" | awk '/^NODE_DWELL_UNAVAILABLE [A-Za-z0-9_]+/{print $2; exit}')"
    [ -n "$DWELL_TOKEN" ] || DWELL_TOKEN="threshold_unavailable"
    STEP_DWELL_STATUS="UNAVAILABLE(structural: $DWELL_TOKEN)"
    STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=$DWELL_TOKEN"
  else
    DWELL_THRESHOLD_HOURS="$(printf '%s\n' "$DWELL_THRESHOLD_OUTPUT" | awk '
      /^NODE_DWELL_THRESHOLD / {
        for (i=1; i<=NF; i++) if ($i ~ /^hours=/) {sub(/^hours=/,"",$i); print $i; exit}
      }')"
    if ! printf '%s\n' "$DWELL_THRESHOLD_HOURS" | grep -Eq '^(0|[1-9][0-9]*)(\.[0-9]+)?$'; then
      STEP_DWELL_STATUS="UNAVAILABLE(structural: threshold_invalid)"
      STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=threshold_invalid"
    else
      DWELL_THRESHOLD_SECONDS="$(awk -v hours="$DWELL_THRESHOLD_HOURS" 'BEGIN {
        seconds = hours * 3600
        if (hours <= 0 || seconds < 1) exit 1
        printf "%.0f", seconds
      }')"
      if [ -z "$DWELL_THRESHOLD_SECONDS" ]; then
        STEP_DWELL_STATUS="UNAVAILABLE(structural: threshold_invalid)"
        STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=threshold_invalid"
      else
        STEP_DWELL_SQL=$(cat <<SQL
WITH active_nodes AS (
  SELECT wr.run_id, wr.issue_id, wr.project_name, n.node_id, n.attempt,
         n.state, n.execution_id, n.started_at
  FROM workflow_run wr
  JOIN workflow_run_node n ON n.run_id = wr.run_id
  WHERE wr.project_name = '$PROJECT_NAME'
    AND wr.status = 'active'
    AND n.ended_at IS NULL
    AND n.state IN ('running','review','admitted')
),
dwell_execution_identity AS (
  SELECT execution_id, project_name, issue_id, lead_id
  FROM comm.sessions
  UNION ALL
  SELECT lineage.execution_id, lineage.project_name, lineage.issue_id, lineage.lead_id
  FROM comm.session_receipt_lineage lineage
  WHERE NOT EXISTS (
    SELECT 1 FROM comm.sessions live
    WHERE live.execution_id = lineage.execution_id
  )
),
dwell_owner_execution_identity AS (
  SELECT execution_id, project_name, issue_id, lead_id
  FROM comm.sessions
  UNION ALL
  SELECT lineage.execution_id, lineage.project_name, lineage.issue_id, lineage.lead_id
  FROM comm.session_receipt_lineage lineage
  WHERE NOT EXISTS (
    SELECT 1 FROM comm.sessions live
    WHERE live.execution_id = lineage.execution_id
  )
    AND EXISTS (
      SELECT 1 FROM active_nodes target
      WHERE target.execution_id = lineage.execution_id
        AND target.project_name = lineage.project_name
        AND target.issue_id = lineage.issue_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM comm.sessions historical
      WHERE historical.project_name = lineage.project_name
        AND historical.issue_id = lineage.issue_id
    )
),
latest_receipt AS (
  SELECT run_id, node_id, attempt, max(examined_at) AS examined_at
  FROM node_dwell_review
  GROUP BY run_id, node_id, attempt
),
latest_waiting_receipt AS (
  SELECT run_id, node_id, attempt, max(examined_at) AS examined_at
  FROM node_dwell_review
  WHERE verdict = 'waiting_founder'
  GROUP BY run_id, node_id, attempt
),
dwell AS (
  SELECT a.*, waiting.examined_at AS waiting_examined_at,
         CASE
           WHEN r.examined_at IS NOT NULL
             AND julianday(r.examined_at) > julianday(a.started_at)
           THEN r.examined_at ELSE a.started_at
         END AS baseline_at
  FROM active_nodes a
  LEFT JOIN latest_receipt r ON r.run_id = a.run_id
    AND r.node_id = a.node_id AND r.attempt = a.attempt
  LEFT JOIN latest_waiting_receipt waiting ON waiting.run_id = a.run_id
    AND waiting.node_id = a.node_id AND waiting.attempt = a.attempt
),
attribution_subjects AS (
  SELECT DISTINCT execution_id, issue_id FROM active_nodes
),
$DWELL_OWNER_ATTRIBUTION_CTES,
open_approve_questions AS (
$DWELL_OPEN_GATE_ROWS_SQL
),
historical_approve_questions AS (
  SELECT q.id, q.from_agent,
         count(s.execution_id) AS mapping_count,
         count(DISTINCT s.project_name || char(0) || coalesce(s.issue_id,'')) AS distinct_mapping_count,
         min(s.project_name) AS project_name,
         min(s.issue_id) AS issue_id
  FROM open_approve_questions q
  LEFT JOIN dwell_execution_identity s ON s.execution_id = q.from_agent
  GROUP BY q.id
),
founder_chat_envelopes AS (
  SELECT created_at,
         substr(content, instr(content,'{'),
                instr(content,char(10)) - instr(content,'{')) AS envelope
  FROM comm.mailbox
  WHERE from_agent = 'founder' AND type = 'discord_chat'
    AND source_kind = 'discord_chat'
    AND instr(content,'{') > 0
    AND instr(content,char(10)) > instr(content,'{')
  UNION ALL
  SELECT json_extract(row_json,'$.created_at') AS created_at,
         substr(json_extract(row_json,'$.content'),
                instr(json_extract(row_json,'$.content'),'{'),
                instr(json_extract(row_json,'$.content'),char(10))
                  - instr(json_extract(row_json,'$.content'),'{')) AS envelope
  FROM comm.mailbox_log
  WHERE event = 'archived' AND json_valid(row_json)
    AND json_extract(row_json,'$.from_agent') = 'founder'
    AND json_extract(row_json,'$.type') = 'discord_chat'
    AND json_extract(row_json,'$.source_kind') = 'discord_chat'
    AND instr(json_extract(row_json,'$.content'),'{') > 0
    AND instr(json_extract(row_json,'$.content'),char(10))
          > instr(json_extract(row_json,'$.content'),'{')
),
founder_thread_activity AS (
  SELECT threads.issue_id, max(messages.created_at) AS episode_at
  FROM chat_threads threads
  JOIN founder_chat_envelopes messages
    ON json_extract(
         CASE WHEN json_valid(messages.envelope)
              THEN messages.envelope ELSE '{}' END,
         '$.chatId'
       ) = threads.thread_id
  WHERE threads.issue_id IS NOT NULL
  GROUP BY threads.issue_id
),
founder_gate_activity AS (
  SELECT run_id,
         max(CASE WHEN state IN ('approved','superseded')
                  THEN updated_at ELSE created_at END) AS episode_at
  FROM workflow_gate_holder
  WHERE gate_node_id = 'founder_gate'
  GROUP BY run_id
),
classified AS (
  SELECT d.*, o.attributed_lead, o.attribution_error,
         CASE
         WHEN (d.node_id = 'founder_gate' AND d.state = 'review')
           OR EXISTS (
             SELECT 1
             FROM workflow_gate_holder h
             JOIN open_approve_questions q ON q.id = h.question_id
             WHERE h.run_id = d.run_id
               AND h.state IN ('materializing','awaiting_review')
           )
           OR (
             NOT EXISTS (
               SELECT 1 FROM workflow_gate_holder any_holder
               WHERE any_holder.run_id = d.run_id
             )
             AND EXISTS (
               SELECT 1 FROM historical_approve_questions historical
               WHERE historical.mapping_count = 1
                 AND historical.distinct_mapping_count = 1
                 AND historical.project_name = d.project_name
                 AND historical.issue_id = d.issue_id
             )
           )
         THEN 'founder_reminder'
         WHEN NOT EXISTS (
                SELECT 1 FROM workflow_gate_holder any_holder
                WHERE any_holder.run_id = d.run_id
              )
           AND EXISTS (
             SELECT 1 FROM historical_approve_questions historical
             WHERE historical.from_agent IS d.execution_id
               AND (historical.mapping_count != 1
                 OR historical.distinct_mapping_count != 1)
           )
         THEN 'unavailable_gate_mapping'
         ELSE 'deep_dive' END AS route
  FROM dwell d
  JOIN owner_resolution o
    ON o.execution_id IS d.execution_id AND o.issue_id = d.issue_id
),
routed_with_episode AS (
  SELECT classified.*,
         CASE WHEN route = 'founder_reminder'
              THEN max(
                strftime('%Y-%m-%dT%H:%M:%fZ', started_at),
                coalesce(
                  strftime('%Y-%m-%dT%H:%M:%fZ', gate_activity.episode_at),
                  strftime('%Y-%m-%dT%H:%M:%fZ', started_at)
                ),
                coalesce(
                  strftime('%Y-%m-%dT%H:%M:%fZ', thread_activity.episode_at),
                  strftime('%Y-%m-%dT%H:%M:%fZ', started_at)
                )
              )
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', started_at)
          END AS episode_started_at
  FROM classified
  LEFT JOIN founder_gate_activity gate_activity
    ON gate_activity.run_id = classified.run_id
  LEFT JOIN founder_thread_activity thread_activity
    ON thread_activity.issue_id = classified.issue_id
),
routed_with_baseline AS (
  SELECT routed_with_episode.*,
         max(
           strftime('%Y-%m-%dT%H:%M:%fZ', baseline_at),
           strftime('%Y-%m-%dT%H:%M:%fZ', episode_started_at)
         ) AS effective_baseline_at,
         CASE WHEN route = 'founder_reminder'
                   AND waiting_examined_at IS NOT NULL
                   AND julianday(waiting_examined_at) >= julianday(episode_started_at)
              THEN 1 ELSE 0 END AS waiting_episode_reminded
  FROM routed_with_episode
),
routed AS (
  SELECT routed_with_baseline.*,
         unixepoch('now') - unixepoch(effective_baseline_at) AS dwell_seconds
  FROM routed_with_baseline
),
mismatch AS (
  SELECT count(*) AS count
  FROM workflow_run wr
  JOIN workflow_run_node n ON n.run_id = wr.run_id
  WHERE wr.project_name = '$PROJECT_NAME'
    AND wr.status = 'active'
    AND n.state IN ('running','review','admitted')
    AND n.ended_at IS NOT NULL
),
gate_mapping_incomplete AS (
  SELECT count(DISTINCT historical.id) AS count
  FROM routed
  JOIN historical_approve_questions historical
    ON historical.from_agent IS routed.execution_id
      AND (historical.mapping_count != 1
        OR historical.distinct_mapping_count != 1)
  WHERE routed.route = 'unavailable_gate_mapping'
),
owned_dwell AS (
  SELECT routed.*,
         row_number() OVER (ORDER BY issue_id,run_id,node_id,attempt) AS output_row
  FROM routed
  WHERE attributed_lead = '$LEAD_ID' AND attribution_error IS NULL
),
owned_truncation AS (
  SELECT CASE WHEN count(*) > 500 THEN count(*) - 500 ELSE 0 END AS count
  FROM owned_dwell
)
SELECT 'NODE_DWELL issue=' || issue_id || ' run=' || run_id ||
       ' node=' || node_id || ' attempt=' || attempt || ' state=' || state ||
       ' baseline=' || coalesce(strftime('%Y-%m-%dT%H:%M:%fZ',effective_baseline_at),'invalid') ||
       ' dwell_hours=' || coalesce(printf('%.2f', dwell_seconds / 3600.0),'invalid') ||
       ' threshold_hours=$DWELL_THRESHOLD_HOURS' ||
       ' waiting_episode_reminded=' || CASE WHEN waiting_episode_reminded = 1 THEN 'yes' ELSE 'no' END ||
       ' over_threshold=' || CASE
         WHEN dwell_seconds >= $DWELL_THRESHOLD_SECONDS
           AND NOT (route = 'founder_reminder' AND waiting_episode_reminded = 1)
         THEN 'yes' ELSE 'no' END ||
       ' route=' || CASE
         WHEN dwell_seconds >= $DWELL_THRESHOLD_SECONDS
           AND NOT (route = 'founder_reminder' AND waiting_episode_reminded = 1)
         THEN route ELSE 'none' END
FROM owned_dwell
WHERE output_row <= 500
UNION ALL
SELECT 'NODE_DWELL_ATTRIBUTION_INCOMPLETE reason=' || attribution_error || ' count=' || count(*)
FROM owner_resolution
WHERE attribution_error IS NOT NULL
GROUP BY attribution_error
UNION ALL
SELECT 'NODE_DWELL_STATE_END_MISMATCH count=' || count
FROM mismatch WHERE count > 0
UNION ALL
SELECT 'NODE_DWELL_BASELINE_INVALID count=' || count(*)
FROM routed WHERE effective_baseline_at IS NULL OR dwell_seconds IS NULL
HAVING count(*) > 0
UNION ALL
SELECT 'NODE_DWELL_GATE_MAPPING_INCOMPLETE count=' || count
FROM gate_mapping_incomplete WHERE count > 0
UNION ALL
SELECT 'NODE_DWELL_TRUNCATED count=' || count
FROM owned_truncation WHERE count > 0
ORDER BY 1
;
SQL
)
        if run_sql STEP_DWELL_FACTS "$STEP_DWELL_SQL"; then
          DWELL_DEGRADED=0
          if printf '%s\n' "$STEP_DWELL_FACTS" | grep -Eq '^NODE_DWELL_(ATTRIBUTION_INCOMPLETE|STATE_END_MISMATCH|BASELINE_INVALID|GATE_MAPPING_INCOMPLETE|TRUNCATED) '; then
            DWELL_DEGRADED=1
            if printf '%s\n' "$STEP_DWELL_FACTS" | grep -q '^NODE_DWELL_ATTRIBUTION_INCOMPLETE '; then
              STEP_DWELL_FACTS="$STEP_DWELL_FACTS
UNAVAILABLE_CAUSE step=DWELL class=structural token=owner_attribution_incomplete
DWELL_ACTION step=DWELL issue=aggregate route=repair_owner_attribution action=REQUIRED result=UNSET evidence=node_dwell_aggregate"
            fi
            if printf '%s\n' "$STEP_DWELL_FACTS" | grep -q '^NODE_DWELL_STATE_END_MISMATCH '; then
              STEP_DWELL_FACTS="$STEP_DWELL_FACTS
UNAVAILABLE_CAUSE step=DWELL class=structural token=state_end_mismatch
DWELL_ACTION step=DWELL issue=aggregate route=repair_node_state action=REQUIRED result=UNSET evidence=node_dwell_aggregate"
            fi
            if printf '%s\n' "$STEP_DWELL_FACTS" | grep -q '^NODE_DWELL_BASELINE_INVALID '; then
              STEP_DWELL_FACTS="$STEP_DWELL_FACTS
UNAVAILABLE_CAUSE step=DWELL class=structural token=baseline_invalid
DWELL_ACTION step=DWELL issue=aggregate route=repair_dwell_baseline action=REQUIRED result=UNSET evidence=node_dwell_aggregate"
            fi
            if printf '%s\n' "$STEP_DWELL_FACTS" | grep -q '^NODE_DWELL_GATE_MAPPING_INCOMPLETE '; then
              STEP_DWELL_FACTS="$STEP_DWELL_FACTS
UNAVAILABLE_CAUSE step=DWELL class=structural token=gate_mapping_incomplete
DWELL_ACTION step=DWELL issue=aggregate route=repair_gate_mapping action=REQUIRED result=UNSET evidence=node_dwell_aggregate"
            fi
            if printf '%s\n' "$STEP_DWELL_FACTS" | grep -q '^NODE_DWELL_TRUNCATED '; then
              STEP_DWELL_FACTS="$STEP_DWELL_FACTS
UNAVAILABLE_CAUSE step=DWELL class=structural token=output_truncated
DWELL_ACTION step=DWELL issue=aggregate route=repair_output_truncation action=REQUIRED result=UNSET evidence=node_dwell_aggregate"
            fi
          fi
          DWELL_ROUTE_ACTIONS="$(printf '%s\n' "$STEP_DWELL_FACTS" | awk '
            /^NODE_DWELL / && / over_threshold=yes / {
              issue=""; route=""
              for (i=1; i<=NF; i++) {
                if ($i ~ /^issue=/) { issue=$i; sub(/^issue=/,"",issue) }
                if ($i ~ /^route=/) { route=$i; sub(/^route=/,"",route) }
              }
              if (issue != "" && (route == "deep_dive" || route == "founder_reminder")) {
                key=issue SUBSEP route
                if (!seen[key]++)
                  print "DWELL_ACTION step=DWELL issue=" issue " route=" route " action=REQUIRED result=UNSET evidence=node_dwell_table"
              }
            }
          ')"
          if [ -n "$DWELL_ROUTE_ACTIONS" ]; then
            STEP_DWELL_FACTS="$STEP_DWELL_FACTS
$DWELL_ROUTE_ACTIONS"
          fi
          if printf '%s\n' "$STEP_DWELL_FACTS" | grep -q '^NODE_DWELL .* over_threshold=yes '; then
            STEP_DWELL_STATUS="FINDING"
          elif [ "$DWELL_DEGRADED" -eq 1 ]; then
            STEP_DWELL_STATUS="UNAVAILABLE(structural: node_dwell_incomplete)"
          else
            STEP_DWELL_STATUS="OK"
          fi
        else
          STEP_DWELL_STATUS="UNAVAILABLE($SQL_ERROR_TOKEN)"
          STEP_DWELL_FACTS="UNAVAILABLE_CAUSE step=DWELL class=structural token=$(printf '%s' "$SQL_ERROR_TOKEN" | tr ' :' '__')"
        fi
      fi
    fi
  fi
  fi
  fi
fi

REPORT_CONTENT="# Lead Patrol Snapshot
project: $PROJECT_NAME
lead: $LEAD_ID
captured_at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')

## STEP 1
STEP 1: $STEP1_STATUS
${STEP1_FACTS:-(none)}

## STEP 2
STEP 2: $STEP2_STATUS
${STEP2_FACTS:-(none)}

## STEP 3
STEP 3: $STEP3_STATUS
${STEP3_FACTS:-(none)}

## STEP 4
STEP 4: $STEP4_STATUS
${STEP4_FACTS:-(none)}

## STEP 5
STEP 5: $STEP5_STATUS
${STEP5_FACTS:-(none)}

## STEP 6
STEP 6: $STEP6_STATUS
${STEP6_FACTS:-(none)}

## STEP DWELL
STEP DWELL: $STEP_DWELL_STATUS
${STEP_DWELL_FACTS:-(none)}"

printf '%s\n' "$REPORT_CONTENT"

REPORT_DIR="$STATE_DIR/patrol-reports/$LEAD_ID"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
REPORT_PATH="$REPORT_DIR/${STAMP}-tick${TICK_SEQ}.md"
if ! mkdir -p "$REPORT_DIR" 2>/dev/null; then
  echo "[patrol-snapshot] ERROR: report_directory_unavailable" >&2
  exit 1
fi
TMP_REPORT="$REPORT_DIR/.${STAMP}-tick${TICK_SEQ}.md.tmp.$$"
if ! printf '%s\n' "$REPORT_CONTENT" > "$TMP_REPORT"; then
  rm -f "$TMP_REPORT" 2>/dev/null || true
  echo "[patrol-snapshot] ERROR: report_temp_write_failed" >&2
  exit 1
fi
chmod 0600 "$TMP_REPORT" 2>/dev/null || {
  rm -f "$TMP_REPORT" 2>/dev/null || true
  echo "[patrol-snapshot] ERROR: report_mode_failed" >&2
  exit 1
}
if ! mv -f "$TMP_REPORT" "$REPORT_PATH"; then
  rm -f "$TMP_REPORT" 2>/dev/null || true
  echo "[patrol-snapshot] ERROR: report_publish_failed" >&2
  exit 1
fi
printf 'REPORT_PATH=%s\n' "$REPORT_PATH"
