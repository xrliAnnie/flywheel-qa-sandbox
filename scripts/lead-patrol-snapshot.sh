#!/bin/bash
# FLY-1855: collect the six-step Lead patrol's independent facts and publish a
# fail-visible report skeleton. This script never declares human judgment steps
# healthy and never mutates StateStore, CommDB, GitHub, Discord, or Linear.

set -uo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOUNDED_RUN="$SCRIPT_DIR/lib/bounded-run.sh"
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
  echo "Usage: lead-patrol-snapshot.sh --project <project> [--lead <lead-id>] [--tick-seq <n>]" >&2
}

PROJECT_NAME=""
LEAD_ID="${FLYWHEEL_LEAD_ID:-}"
TICK_SEQ="NA"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--lead|--tick-seq)
      if [ "$#" -lt 2 ]; then
        echo "[patrol-snapshot] ERROR: $1 requires a value" >&2
        usage
        exit 2
      fi
      case "$1" in
        --project) PROJECT_NAME="$2" ;;
        --lead) LEAD_ID="$2" ;;
        --tick-seq) TICK_SEQ="$2" ;;
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
OWNER_ATTRIBUTION_CTES=$(cat <<SQL
exact_resolution AS (
  SELECT x.execution_id, x.issue_id,
         count(cs.execution_id) AS row_count,
         count(nullif(trim(cs.lead_id),'')) AS owner_count,
         count(DISTINCT nullif(trim(cs.lead_id),'')) AS distinct_owner_count,
         min(nullif(trim(cs.lead_id),'')) AS owner
  FROM attribution_subjects x
  LEFT JOIN comm.sessions cs ON cs.execution_id = x.execution_id
    AND cs.project_name = '$PROJECT_NAME'
  GROUP BY x.execution_id, x.issue_id
),
current_resolution AS (
  SELECT x.execution_id, x.issue_id,
         count(cs.execution_id) AS row_count,
         count(nullif(trim(cs.lead_id),'')) AS owner_count,
         count(DISTINCT nullif(trim(cs.lead_id),'')) AS distinct_owner_count,
         min(nullif(trim(cs.lead_id),'')) AS owner
  FROM attribution_subjects x
  LEFT JOIN comm.sessions cs ON cs.issue_id = x.issue_id
    AND cs.project_name = '$PROJECT_NAME'
    AND cs.status IN ('running','blocked')
  GROUP BY x.execution_id, x.issue_id
),
latest_cohort AS (
  SELECT x.execution_id, x.issue_id, max(cs.started_at) AS latest_started_at
  FROM attribution_subjects x
  LEFT JOIN comm.sessions cs ON cs.issue_id = x.issue_id
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
  LEFT JOIN comm.sessions cs ON cs.issue_id = x.issue_id
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
)

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
       ' recovery=POST_/review-requests_same_requestId'
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
${STEP6_FACTS:-(none)}"

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
