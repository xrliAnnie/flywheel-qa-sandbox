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
PREVIOUS_REPORT="$(find "$REPORT_DIR" -maxdepth 1 -type f -name '*-tick*.md' -print 2>/dev/null | sort | tail -1)"
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

field_from_evidence() { # <line> <field>
  local line="$1" name="$2" word
  for word in $line; do
    case "$word" in
      "$name"=*) printf '%s' "${word#*=}"; return 0 ;;
    esac
  done
  return 1
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
WHERE status IN ('running','ship_parked','awaiting_review','design_done','approved_to_ship')
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
if command -v tmux >/dev/null 2>&1; then
  TMUX_ERR_FILE="$WORK_TMP/tmux-list.err"
  STEP1_FACTS="$(TMUX= tmux list-windows -a 2>"$TMUX_ERR_FILE")"
  if [ "$?" -ne 0 ]; then
    TMUX_ERR_TEXT="$(tr '[:upper:]' '[:lower:]' < "$TMUX_ERR_FILE" 2>/dev/null || true)"
    case "$TMUX_ERR_TEXT" in
      *"no server running"*|*"failed to connect to server"*)
        TMUX_ERROR_TOKEN="transient: tmux_server_absent"
        ;;
    esac
    STEP1_STATUS="UNAVAILABLE($TMUX_ERROR_TOKEN)"
    STEP1_FACTS=""
  else
    PANE_LIST_RAW="$(TMUX= tmux list-panes -a -F $'#{pane_id}\t#{session_name}\t#{session_name}:#{window_id}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}' 2>/dev/null)"
    PANE_LIST_RC=$?
    if [ "$PANE_LIST_RC" -eq 0 ]; then
      RUNNER_PANES="$(printf '%s\n' "$PANE_LIST_RAW" | awk -F '\t' '
        $2 ~ /^runner-/ && $4 ~ /^[A-Z][A-Z0-9]*-[0-9]+($|[-_:])/ { print }
      ')"
    else
      STEP1_STATUS="UNAVAILABLE($TMUX_ERROR_TOKEN)"
    fi
  fi
else
  STEP1_STATUS="UNAVAILABLE(structural: tmux_unavailable)"
fi
if [ -n "$RUNNER_PANES" ]; then
  STEP1_FACTS="${STEP1_FACTS:-(none)}
RUNNER_PANES:
$RUNNER_PANES"
else
  STEP1_FACTS="${STEP1_FACTS:-(none)}
RUNNER_PANES: (none)"
fi

PANE_COUNT="$(printf '%s\n' "$RUNNER_PANES" | awk 'NF {n++} END {print n+0}')"
STEP2_STATUS="OK-CANDIDATE"
STEP2_FACTS=""
OWNER_INDEX=""
INCOMPLETE_SESSIONS=""

if [ "$PANE_LIST_RC" -ne 0 ]; then
  STEP2_STATUS="UNAVAILABLE($TMUX_ERROR_TOKEN)"
elif [ "$PROJECT_REGISTRY_OK" -eq 1 ]; then
  while IFS= read -r index_project; do
    [ -n "$index_project" ] || continue
    if ! safe_key "$index_project"; then
      INCOMPLETE_SESSIONS="${INCOMPLETE_SESSIONS} runner-$index_project"
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
      2)
        if printf '%s\n' "$RUNNER_PANES" | awk -F '\t' -v session="runner-$index_project" '$2 == session {found=1} END {exit !found}'; then
          INCOMPLETE_SESSIONS="${INCOMPLETE_SESSIONS} runner-$index_project"
        fi
        ;;
      *) INCOMPLETE_SESSIONS="${INCOMPLETE_SESSIONS} runner-$index_project" ;;
    esac
  done <<< "$PROJECT_NAMES"
else
  STEP2_STATUS="UNAVAILABLE(structural: owner_index_incomplete)"
fi

NOW_EPOCH="$(date +%s)"
CONTINUITY_CONTENT=""
CONTINUITY_WRITE_READY=1
if ! mkdir -p "$CONTINUITY_DIR" 2>/dev/null; then
  CONTINUITY_WRITE_READY=0
  STEP2_STATUS="UNAVAILABLE(structural: continuity_state_unavailable)"
fi
while IFS=$'\t' read -r pane_id session_name target window_name pane_command pane_dead; do
  [ -n "$pane_id" ] || continue
  owner="unknown"
  execution_id="none"
  findings="none"
  action="none"
  result="clear"
  if [ "$pane_dead" = 1 ]; then
    findings="$(append_finding "$findings" PANE_DEAD)"
  fi

  index_matches="$(printf '%s\n' "$OWNER_INDEX" | awk -F '\t' -v target="$target" '$1 == target {print}')"
  match_count="$(printf '%s\n' "$index_matches" | awk 'NF {n++} END {print n+0}')"
  if [ "$match_count" -eq 1 ]; then
    IFS=$'\t' read -r _match_target match_project execution_id match_lead <<< "$index_matches"
    if [ "$match_lead" = "$LEAD_ID" ]; then owner="owned"; else owner="cross-boundary"; fi
  elif [ "$match_count" -gt 1 ]; then
    findings="SESSION_TARGET_AMBIGUOUS"
    STEP2_STATUS="UNAVAILABLE(structural: session_target_ambiguous)"
  else
    session_project="${session_name#runner-}"
    if [ "$PROJECT_REGISTRY_OK" -ne 1 ]; then
      findings="$(append_finding "$findings" OWNER_INDEX_INCOMPLETE)"
      STEP2_STATUS="UNAVAILABLE(structural: owner_index_incomplete)"
    elif ! printf '%s\n' "$PROJECT_NAMES" | grep -Fxq -- "$session_project"; then
      owner="foreign-registry"
      result="foreign_registry_clear"
    elif case " $INCOMPLETE_SESSIONS " in *" $session_name "*) true;; *) false;; esac; then
      findings="OWNER_INDEX_INCOMPLETE"
      STEP2_STATUS="UNAVAILABLE($COMM_INDEX_ERROR_TOKEN)"
    else
      previous_line=""
      if [ -n "$PREVIOUS_REPORT" ] && [ -f "$PREVIOUS_REPORT" ]; then
        previous_line="$(grep -F "target=$target " "$PREVIOUS_REPORT" 2>/dev/null | tail -1)"
      fi
      previous_result="$(field_from_evidence "$previous_line" result 2>/dev/null || true)"
      if [ "$previous_result" = session_terminated ] || [ "$previous_result" = UNSET ]; then
        findings="ORPHANED"
      else
        result="session_terminated"
      fi
    fi
  fi

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
    previous_state=""
    previous_change=""
    if [ -f "$CONTINUITY_FILE" ]; then
      previous_continuity="$(awk -F '\t' -v target="$target" '$1 == target {print; exit}' "$CONTINUITY_FILE" 2>/dev/null || true)"
      IFS=$'\t' read -r _continuity_target previous_state previous_change <<< "$previous_continuity"
    fi
    if [ "$previous_state" = "$state_hash" ]; then
      case "$previous_change" in
        ''|*[!0-9]*) ;;
        *) last_change_epoch="$previous_change" ;;
      esac
    fi
    if [ $((NOW_EPOCH - last_change_epoch)) -ge 3600 ]; then
      findings="$(append_finding "$findings" STALLED_60M)"
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
    CONTINUITY_CONTENT="${CONTINUITY_CONTENT}${CONTINUITY_CONTENT:+$'\n'}${target}"$'\t'"${state_hash}"$'\t'"${last_change_epoch}"
  fi
  rm -f "$capture_file" 2>/dev/null || true

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

STEP3_FACTS=""
STEP3_SQL=$(cat <<SQL
WITH active AS (
  SELECT DISTINCT wr.issue_id, n.node_id, n.attempt, n.execution_id
  FROM workflow_run wr
  JOIN workflow_run_node n ON n.run_id = wr.run_id
  WHERE wr.project_name = '$PROJECT_NAME'
    AND wr.status = 'active'
    AND n.state = 'running'
)
SELECT 'TURN_MISSING issue=' || a.issue_id || ' node=' || a.node_id || ' attempt=' || a.attempt
FROM active a
LEFT JOIN comm.three_stage_turn t ON t.issue_id = a.issue_id
WHERE t.issue_id IS NULL
UNION ALL
SELECT 'TURN_HOLDER_NOT_LIVE issue=' || a.issue_id || ' holder=' || substr(t.holder_exec_id,1,8)
FROM (SELECT DISTINCT issue_id FROM active) a
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
FROM active a
JOIN sessions s ON s.execution_id = a.execution_id
  AND s.project_name = '$PROJECT_NAME'
  AND s.status IN ('running','ship_parked','awaiting_review','design_done','approved_to_ship')
JOIN comm.turn_wait_ledger w ON w.execution_id = a.execution_id
WHERE w.no_turn_streak >= 3
UNION ALL
SELECT 'NODE_SESSION_NOT_LIVE issue=' || a.issue_id || ' exec=' || coalesce(substr(a.execution_id,1,8),'none')
FROM active a
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
  if [ -n "$STEP3_FACTS" ]; then STEP3_STATUS="FINDING-CANDIDATE"; else STEP3_STATUS="OK-CANDIDATE"; fi
else
  STEP3_STATUS="UNAVAILABLE($SQL_ERROR_TOKEN)"
fi

STEP4_FACTS=""
STEP4_SQL=$(cat <<SQL
SELECT 'MAILBOX_STALE id=' || substr(m.id,1,12) || ' to=' || substr(m.to_agent,1,8) ||
       ' state=' || m.state || ' created=' || m.created_at ||
       ' claim_expires=' || coalesce(m.claim_expires_at,'-')
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
UNION ALL
SELECT 'WAKE_UNACKED wake=' || substr(w.wake_id,1,16) || ' issue=' || w.issue_id ||
       ' exec=' || substr(w.execution_id,1,8) || ' state=' || w.state || ' created_ms=' || w.created_at
FROM comm.turn_wake_outbox w
JOIN workflow_run_node n ON n.execution_id = w.execution_id AND n.state = 'running'
JOIN workflow_run wr ON wr.run_id = n.run_id
  AND wr.project_name = '$PROJECT_NAME' AND wr.status = 'active'
WHERE w.state IN ('pending','sent')
  AND w.acked_at IS NULL
  AND w.created_at <= (unixepoch('now','-15 minutes') * 1000)
UNION ALL
SELECT 'DEAD_LETTER_PENDING id=' || substr(d.id,1,16) || ' recipient=' || substr(d.recipient,1,12) ||
       ' source=' || d.source_kind || ' lead=' || d.lead_id || ' project=' || d.project_name ||
       ' count=' || d.dead_count || ' state=' || d.state || ' created=' || d.created_at
FROM dead_letter_alerts d
WHERE d.state = 'pending'
  AND julianday(d.created_at) >= julianday('now','-24 hours')
UNION ALL
SELECT 'VERDICT_HEAD_MISMATCH issue=' || wr.issue_id || ' node=' || b.node_id ||
       ' attempt=' || b.attempt || ' head=' || substr(b.head_sha,1,8) ||
       ' claim=' || substr(min(c.subject_digest),1,8)
FROM workflow_run wr
JOIN workflow_node_pr_binding b ON b.run_id = wr.run_id
JOIN workflow_claims c ON c.workflow_run_id = b.run_id
  AND c.node_id = b.node_id AND c.attempt = b.attempt
  AND c.predicate IN ('codex_approved','qa_passed','founder_approved')
  AND c.subject_kind = 'git_head'
  AND (c.permanent = 1 OR julianday(c.expires_at) > julianday('now'))
WHERE wr.project_name = '$PROJECT_NAME' AND wr.status = 'active'
GROUP BY wr.issue_id, b.node_id, b.attempt, b.head_sha
HAVING sum(CASE WHEN c.subject_digest = b.head_sha THEN 1 ELSE 0 END) = 0
ORDER BY 1
LIMIT 500;
SQL
)
if run_sql STEP4_FACTS "$STEP4_SQL"; then
  if [ -n "$STEP4_FACTS" ]; then STEP4_STATUS="FINDING-CANDIDATE"; else STEP4_STATUS="OK-CANDIDATE"; fi
else
  STEP4_STATUS="UNAVAILABLE($SQL_ERROR_TOKEN)"
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
STEP6_FACTS='Finalize every STEP status; route cross-boundary findings and UNAVAILABLE per runner-patrol-rules.md.'

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
