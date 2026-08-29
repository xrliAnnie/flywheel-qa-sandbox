#!/usr/bin/env bash
# FLY-1189 H5c: PR-C-dist deployment preflight, run at the TOP of QA Phase A on
# a real deployed slot (before any fault injection). It asserts the
# createSessionTargetResolver preconditions the founder-page path depends on —
# if any is missing, the whole N-to-N matrix would produce false negatives, so
# this STOPS and tells the operator to ask Tadashi (a real blocker, not a bug
# to work around).
#
# Checks, for a runner spawned against a labeled dept issue:
#   1. sessions row exists + carries the expected dept label (issue_labels).
#   2. owner Lead resolves to the expected agentId (resolveLeadForIssue).
#   3. a chat_threads binding exists for the issue (founder page needs it).
#
# Usage:
#   scripts/qa-fly-1189-preflight.sh --slot-dir <dir> --exec <execId> \
#       --expect-label Product-Test --expect-lead flywheel-test-2 --issue FLY-145
set -uo pipefail

SLOT_DIR=""; EXEC=""; EXPECT_LABEL=""; EXPECT_LEAD=""; ISSUE=""; PROJECTS_FILE=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--slot-dir) SLOT_DIR="${2:?}"; shift 2 ;;
		--exec) EXEC="${2:?}"; shift 2 ;;
		--expect-label) EXPECT_LABEL="${2:?}"; shift 2 ;;
		--expect-lead) EXPECT_LEAD="${2:?}"; shift 2 ;;
		--issue) ISSUE="${2:?}"; shift 2 ;;
		--projects-file) PROJECTS_FILE="${2:?}"; shift 2 ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		*) echo "unknown arg '$1'" >&2; exit 2 ;;
	esac
done
for req in SLOT_DIR EXEC EXPECT_LABEL EXPECT_LEAD ISSUE; do
	[[ -n "${!req}" ]] || { echo "ERROR: --${req,,} required" >&2; exit 2; }
done
DB="${SLOT_DIR}/teamlead.db"
[[ -f "$DB" ]] || { echo "ERROR: ${DB} not found" >&2; exit 2; }
command -v sqlite3 >/dev/null 2>&1 || { echo "ERROR: sqlite3 required" >&2; exit 2; }

sql() { sqlite3 "file:${DB}?mode=ro" "$1" 2>/dev/null; }
FAIL=0
ok()  { echo "[preflight] ✓ $*"; }
bad() { FAIL=1; echo "[preflight] ✗ $*"; }

# Read the session's own state once (used by both checks). `sessions` PK is
# execution_id (no `id` column); issue_labels is a JSON-array TEXT column.
SESS_LABELS_JSON=$(sql "SELECT COALESCE(issue_labels,'[]') FROM sessions WHERE execution_id='${EXEC}' LIMIT 1;")
[[ -z "$SESS_LABELS_JSON" ]] && SESS_LABELS_JSON='[]'
SESS_PROJECT=$(sql "SELECT COALESCE(project_name,'') FROM sessions WHERE execution_id='${EXEC}' LIMIT 1;")
ROW=$(sql "SELECT COUNT(*) FROM sessions WHERE execution_id='${EXEC}';")

# 1. session row + EXACT dept-label membership. Codex R6: use exact
#    case-insensitive membership over the parsed label array — NOT a substring
#    grep (which false-matched 'NotProduct-Test-X' as containing 'Product-Test').
if [[ "${ROW:-0}" -lt 1 ]]; then
	bad "no sessions row for execId=${EXEC} (runner not spawned / not persisted)"
elif ! jq -e . >/dev/null 2>&1 <<<"$SESS_LABELS_JSON"; then
	bad "session issue_labels is not valid JSON ('${SESS_LABELS_JSON}')"
elif jq -e --arg l "$EXPECT_LABEL" '(. // []) | any(ascii_downcase == ($l | ascii_downcase))' \
		>/dev/null 2>&1 <<<"$SESS_LABELS_JSON"; then
	ok "session carries dept label '${EXPECT_LABEL}' (issue_labels=${SESS_LABELS_JSON})"
else
	bad "session issue_labels=${SESS_LABELS_JSON} does NOT contain '${EXPECT_LABEL}' (exact) — owner routing will be wrong"
fi

# 2. owner Lead routing — replicate resolveLeadForIssue EXACTLY (Codex R6):
#    within the session's project, the FIRST lead (document order) whose
#    match.labels has SOME label in the session's labels (CASE-INSENSITIVE exact
#    membership — `"*"` is a LITERAL label, NOT a wildcard). If NO lead matches,
#    the resolver falls back to leads[0] ("general"); we replicate that fallback
#    and still assert it equals --expect-lead (a mismatch = misroute). Missing
#    config → BLOCK.
PJF="${PROJECTS_FILE:-${SLOT_DIR}/flywheel-projects.json}"
if [[ ! -f "$PJF" ]]; then
	bad "projects file ${PJF} not found — cannot verify owner routing (pass --projects-file to the slot's flywheel-projects.json)"
elif ! jq -e . >/dev/null 2>&1 <<<"$SESS_LABELS_JSON"; then
	: # already reported in section 1
else
	RESOLVED_LEAD=$(jq -r --argjson labels "$SESS_LABELS_JSON" --arg proj "$SESS_PROJECT" '
		(($labels // []) | map(ascii_downcase)) as $ll
		| ([ .[] | select(.projectName == $proj) ][0]) as $p
		| if $p == null then ""
		  else
		    ([ $p.leads[]
		       | select(
		           ((.match.labels // []) | map(ascii_downcase))
		           | any(. as $x | ($ll | index($x)) != null)
		         ) ][0]) as $matched
		    | (($matched // $p.leads[0]) // {}).agentId // ""
		  end
	' "$PJF" 2>/dev/null)
	MATCH_METHOD=$(jq -r --argjson labels "$SESS_LABELS_JSON" --arg proj "$SESS_PROJECT" '
		(($labels // []) | map(ascii_downcase)) as $ll
		| ([ .[] | select(.projectName == $proj) ][0]) as $p
		| if $p == null then "no-project"
		  elif ([ $p.leads[] | select(((.match.labels // []) | map(ascii_downcase)) | any(. as $x | ($ll | index($x)) != null)) ] | length) > 0
		    then "label" else "general(fallback→leads[0])" end
	' "$PJF" 2>/dev/null)
	if [[ -z "$RESOLVED_LEAD" ]]; then
		bad "no project '${SESS_PROJECT}' (or no leads) in ${PJF} — owner routing cannot resolve"
	elif [[ "$RESOLVED_LEAD" == "$EXPECT_LEAD" ]]; then
		ok "owner routing verified: session labels ${SESS_LABELS_JSON} @ '${SESS_PROJECT}' → '${RESOLVED_LEAD}' (match=${MATCH_METHOD})"
	else
		bad "owner routing MISMATCH: session labels ${SESS_LABELS_JSON} @ '${SESS_PROJECT}' → '${RESOLVED_LEAD}' (match=${MATCH_METHOD}), expected '${EXPECT_LEAD}'"
	fi
fi

# 3. chat_threads binding for the issue (founder page depends on it). The
#    column is `channel_id` (NOT `chat_channel_id`).
THREAD=$(sql "SELECT COALESCE(channel_id, thread_id, '') FROM chat_threads WHERE issue_id='${ISSUE}' LIMIT 1;")
if [[ -n "$THREAD" ]]; then
	ok "chat_threads binding exists for ${ISSUE} (channel/thread=${THREAD})"
else
	bad "NO chat_threads row for ${ISSUE} — founder page would no-op (TEST_REPLY_BY_ISSUE=1 + runner must have posted first)"
fi

if [[ "$FAIL" == "0" ]]; then
	echo "[preflight] ALL PRECONDITIONS MET — safe to run the N-to-N matrix."
	exit 0
else
	echo "[preflight] BLOCKED — a createSessionTargetResolver precondition is missing." >&2
	echo "[preflight] Do NOT run the matrix (it would false-negative). Ask Tadashi." >&2
	exit 1
fi
