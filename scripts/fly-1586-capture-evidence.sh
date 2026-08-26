#!/usr/bin/env bash
# FLY-1586 — capture the pre-restart baseline (plan §1).
#
# WHY THIS EXISTS
#   Fixing the wedge requires restarting the Bridge, and the restart DESTROYS the
#   crime scene. Without this snapshot, "did the fix work?" becomes unprovable —
#   there is no before to compare the after against.
#
# HARD CONTRACTS (plan §1, and the review rounds behind it)
#   1. Output goes to an ABSOLUTE path derived from this script's own location.
#      It never depends on the caller's cwd.
#   2. The project/lead target set is derived from the EFFECTIVE production config
#      (~/.flywheel/projects.json). It is NOT hardcoded, and it does NOT glob
#      ~/.flywheel/comm/*/ — that directory is full of test-slot-*, qa-*, and
#      fire-test databases, some without a loop_heartbeat table at all.
#      Do not hardcode a lead count either (the incident text says 14; config
#      currently yields a different number — that drift is exactly the point).
#   3. READ-ONLY. Every sqlite3 call uses -readonly. This script must be safe to
#      run against live production at any time.
#   4. A source that is MISSING is recorded as missing, loudly. An absent file and
#      an empty result must never render identically — "0 rows" is satisfied both
#      by "nothing is wrong" and by "I queried the wrong place".
#   5. A FAILING QUERY FAILS THE RUN. The first version of this script exited 0
#      with 8 files written, and every one of them held sqlite error text where
#      the evidence should have been. Exit code and file count are not evidence;
#      they were satisfied just as well by a script that captured nothing. Any
#      query error now increments QUERY_ERRORS and the script exits non-zero.
#
# Usage:  scripts/fly-1586-capture-evidence.sh [output-dir]

set -uo pipefail
QUERY_ERRORS=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${1:-$REPO_ROOT/engineering/doc/FLY-1586-inbox-loop-poison-isolation/evidence/$STAMP}"
mkdir -p "$OUT_DIR"

FLY_HOME="$HOME/.flywheel"
PROJECTS_JSON="$FLY_HOME/projects.json"
TEAMLEAD_DB="$FLY_HOME/teamlead.db"
MANIFEST="$OUT_DIR/00-MANIFEST.txt"

note() { printf '%s\n' "$*" | tee -a "$MANIFEST"; }
# Records an absent source as an explicit, greppable fact rather than an empty file.
absent() { printf 'ABSENT: %s — %s\n' "$1" "$2" | tee -a "$MANIFEST" >&2; }

# q <db> <sql> — read-only, column-formatted query.
# Dot-commands are NOT passed inside the SQL string: sqlite3 parses ".headers on"
# as two arguments and dies with `extra argument: "on"`. Use the real flags.
q() {
	local db="$1" sql="$2" out rc
	if [ ! -f "$db" ]; then printf 'MISSING_DB\t%s\n' "$db"; return 0; fi
	# Q_MODE: -column pads every row to the widest cell, which is fine for the
	# small human-readable summaries and absurd for bulk rows (measured: 808
	# chars/line, 183 of them real — 5.8MB of mostly whitespace). Bulk queries
	# pass Q_MODE=-list.
	out="$(sqlite3 -readonly -header "${Q_MODE:--column}" -cmd '.timeout 5000' "$db" "$sql" 2>&1)"
	rc=$?
	printf '%s\n' "$out"
	# sqlite3 can print `Error: ...` and still exit 0, so check both.
	if [ $rc -ne 0 ] || printf '%s' "$out" | grep -q '^Error:\|^Parse error\|extra argument'; then
		QUERY_ERRORS=$((QUERY_ERRORS + 1))
		printf 'QUERY_FAILED db=%s rc=%s\n' "$db" "$rc" >&2
	fi
}

note "FLY-1586 evidence capture"
note "captured_at_utc: $STAMP"
note "host: $(hostname)"
note "repo_head: $(cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
note "out_dir: $OUT_DIR"
note ""

# ---------------------------------------------------------------------------
# Target set — derived, never assumed.
# ---------------------------------------------------------------------------
if [ ! -f "$PROJECTS_JSON" ]; then
	absent "$PROJECTS_JSON" "cannot derive the production target set; refusing to guess"
	note "FATAL: no effective production config. Nothing captured."
	exit 2
fi

# Emits "<projectName>\t<leadId>" per line, straight from the effective config.
python3 - "$PROJECTS_JSON" > "$OUT_DIR/01-target-set.tsv" <<'PY'
import json, sys
projects = json.load(open(sys.argv[1]))
for p in projects:
    name = p.get("projectName")
    if not name:
        continue
    for lead in (p.get("leads") or []):
        lid = lead.get("agentId") or lead.get("id")
        if lid:
            print(f"{name}\t{lid}")
PY

PROJECT_COUNT=$(cut -f1 "$OUT_DIR/01-target-set.tsv" | sort -u | wc -l | tr -d ' ')
LEAD_COUNT=$(wc -l < "$OUT_DIR/01-target-set.tsv" | tr -d ' ')
note "target set (derived from $PROJECTS_JSON):"
note "  projects: $PROJECT_COUNT"
note "  leads:    $LEAD_COUNT   <- derived; do NOT compare against a hardcoded 14/16"
note ""

# ---------------------------------------------------------------------------
# Evidence 1 — loop_heartbeat per production project (liveness ground truth)
# Evidence 2 — lead_inbox backlog per lead (the denominator the fix is judged by)
# ---------------------------------------------------------------------------
: > "$OUT_DIR/02-loop-heartbeat.txt"
: > "$OUT_DIR/03-inbox-backlog.txt"
for proj in $(cut -f1 "$OUT_DIR/01-target-set.tsv" | sort -u); do
	db="$FLY_HOME/comm/$proj/comm.db"
	{
		printf '\n===== project=%s db=%s =====\n' "$proj" "$db"
		if [ ! -f "$db" ]; then
			printf 'MISSING_DB — no comm.db for a project that IS in production config\n'
		else
			q "$db" "SELECT lead_id, last_started_at, last_success_at, stall_episode_at,
       CAST((julianday('now') - julianday(last_success_at)) * 1440 AS INT) AS mins_since_success
FROM loop_heartbeat ORDER BY lead_id;"
		fi
	} >> "$OUT_DIR/02-loop-heartbeat.txt"

	{
		printf '\n===== project=%s =====\n' "$proj"
		if [ ! -f "$db" ]; then
			printf 'MISSING_DB\n'
		else
			q "$db" "SELECT to_lead,
       COUNT(*) AS undelivered,
       SUM(CASE WHEN source='founder_reply' THEN 1 ELSE 0 END) AS founder_rows,
       MIN(created_at) AS oldest,
       MAX(created_at) AS newest
FROM lead_inbox WHERE consumed_at IS NULL GROUP BY to_lead ORDER BY undelivered DESC;"
		fi
	} >> "$OUT_DIR/03-inbox-backlog.txt"
done
note "evidence 1 -> 02-loop-heartbeat.txt"
note "evidence 2 -> 03-inbox-backlog.txt"

# ---------------------------------------------------------------------------
# Evidence 3 — the poison row's raw material.
#
# ⚠️ CORRECTION, verified against the production DB rather than assumed:
# the lone surrogate is NOT stored in lead_events. seq 56649's payload contains
# neither an unpaired surrogate nor a U+FFFD. The payload holds exactly one
# astral character (🤖) at UTF-16 unit 741, and slicing the PAYLOAD at 500 does
# not split it.
#
# The poison is MANUFACTURED downstream: the reconciler renders the envelope,
# contentSummary truncates the RENDERED text at 500 UTF-16 code units, and it is
# that cut — not this payload — that can land between a surrogate pair.
#
# So the honest artifact here is the payload as fixture raw material, plus the
# CANDIDATE population (rows carrying astral characters at all). Whether a given
# row actually splits depends on the renderer, which a capture script does not
# run. Labelling the candidate set "confirmed poison" would be the same
# false-label mistake this whole issue exists to fix.
# ---------------------------------------------------------------------------
if [ ! -f "$TEAMLEAD_DB" ]; then
	absent "$TEAMLEAD_DB" "cannot capture the poison row (evidence 3)"
else
	{
		echo "--- seq 56649 (the known poison row) ---"
		q "$TEAMLEAD_DB" "SELECT seq, lead_id, event_type, event_id, session_key,
		       delivered_at IS NULL AS still_undelivered, length(payload) AS payload_len
		FROM lead_events WHERE seq = 56649;"
		echo
		echo "--- payload as HEX (lossless; decode to inspect) ---"
		q "$TEAMLEAD_DB" "SELECT hex(CAST(payload AS BLOB)) FROM lead_events WHERE seq = 56649;"
		echo
		echo "--- rows already carrying U+FFFD (the SUBSTITUTION, i.e. the symptom) ---"
		q "$TEAMLEAD_DB" "SELECT COUNT(*) AS rows_with_fffd FROM lead_events
		WHERE hex(CAST(payload AS BLOB)) LIKE '%EFBFBD%';"
	} > "$OUT_DIR/04-poison-row.txt" 2>&1

	# CANDIDATE population — needs real UTF-16 semantics, which SQL does not have.
	# Reported as candidates, never as confirmed poison (see the block comment).
	python3 - "$TEAMLEAD_DB" >> "$OUT_DIR/04-poison-row.txt" 2>&1 <<'PY'
import os, sqlite3, sys
db = sys.argv[1]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
con.text_factory = str
print("\n--- CANDIDATE population: undelivered rows containing astral chars ---")
print("--- (astral char => needs a surrogate pair => a 500-unit cut CAN split it) ---")
print("--- candidate != confirmed: confirming requires running the renderer ---")
rows = con.execute(
    "SELECT seq, lead_id, event_type, payload FROM lead_events "
    "WHERE delivered_at IS NULL ORDER BY seq"
).fetchall()
cands = []
for seq, lead, etype, payload in rows:
    if not isinstance(payload, str):
        continue
    positions = []
    u16 = 0
    for ch in payload:
        if ord(ch) > 0xFFFF:
            positions.append(u16)
        u16 += 2 if ord(ch) > 0xFFFF else 1
    if positions:
        cands.append((seq, lead, etype, u16, positions[:5]))
print(f"undelivered rows scanned: {len(rows)}")
print(f"candidates (>=1 astral char): {len(cands)}")
for seq, lead, etype, total16, pos in cands[:40]:
    print(f"  seq={seq} lead={lead} type={etype} utf16_len={total16} astral_at={pos}")
PY
	note "evidence 3 -> 04-poison-row.txt"
fi

# ---------------------------------------------------------------------------
# Evidence 4 — the rollback is only ever visible in the log. Nothing in any DB
# records a transaction that was rolled back.
# ---------------------------------------------------------------------------
BRIDGE_LOG="/tmp/flywheel-bridge.log"
BRIDGE_LOGS=()
for bridge_log_candidate in \
	"$BRIDGE_LOG.3" "$BRIDGE_LOG.2" "$BRIDGE_LOG.1" "$BRIDGE_LOG"; do
	[[ -f "$bridge_log_candidate" && ! -L "$bridge_log_candidate" ]] \
		&& BRIDGE_LOGS+=("$bridge_log_candidate")
done
if [ "${#BRIDGE_LOGS[@]}" -eq 0 ]; then
	absent "$BRIDGE_LOG" "rollback count (evidence 4) unavailable — the log is the only place it appears"
else
	{
		echo "logs_oldest_to_active: ${BRIDGE_LOGS[*]}"
		for bridge_log_candidate in "${BRIDGE_LOGS[@]}"; do
			echo "size_bytes[$bridge_log_candidate]: $(wc -c < "$bridge_log_candidate" | tr -d ' ')"
		done
		echo "reused-with-different-content count: $(grep -h 'was reused with different content' "${BRIDGE_LOGS[@]}" 2>/dev/null | awk 'END { print NR + 0 }')"
		echo
		echo "--- last 40 matching lines ---"
		grep -h 'was reused with different content' "${BRIDGE_LOGS[@]}" 2>/dev/null | tail -40
	} > "$OUT_DIR/05-rollback-log.txt" 2>&1
	note "evidence 4 -> 05-rollback-log.txt"
fi

# ---------------------------------------------------------------------------
# Evidence 5 — why the alert fired and nobody heard it. Counts are derived,
# never asserted: the incident text says "16 times", and confirming that number
# is part of the evidence, not an input to it.
# ---------------------------------------------------------------------------
{
	echo "===== inbox_loop_stalled alert ledger ====="
	for adb in "$FLY_HOME/alerts/alerts.db" "$FLY_HOME/alerts/claims.db" "$FLY_HOME/claims.db"; do
		printf '\n--- %s ---\n' "$adb"
		if [ ! -f "$adb" ]; then printf 'MISSING_DB\n'; continue; fi
		printf 'tables: '; q "$adb" "SELECT group_concat(name, ', ') FROM sqlite_master WHERE type='table';"
		q "$adb" "SELECT * FROM sqlite_master WHERE type='table' AND sql LIKE '%stall%';"
	done

	echo
	echo "===== alert queue / dead-letter (file-backed) ====="
	for d in "$FLY_HOME/alert-queue" "$FLY_HOME/alert-deadletter"; do
		if [ -d "$d" ]; then
			printf '%s: %s files\n' "$d" "$(find "$d" -type f | wc -l | tr -d ' ')"
			find "$d" -type f -name '*stall*' | head -20
		else
			printf 'ABSENT_DIR: %s\n' "$d"
		fi
	done
} > "$OUT_DIR/06-alert-path.txt" 2>&1
note "evidence 5 -> 06-alert-path.txt  (partial: /health liveness manifest needs a live Bridge — see NOTE below)"

# ---------------------------------------------------------------------------
# Evidence 6 — the frozen question cohort. Without this, the "7 recoverable /
# 13 not" split has already drifted by the time anyone deploys.
# ---------------------------------------------------------------------------
: > "$OUT_DIR/07-question-cohort.txt"
for proj in $(cut -f1 "$OUT_DIR/01-target-set.tsv" | sort -u); do
	db="$FLY_HOME/comm/$proj/comm.db"
	{
		printf '\n===== project=%s =====\n' "$proj"
		if [ ! -f "$db" ]; then printf 'MISSING_DB\n'; else
			# Message BODIES are redacted by default. This artifact is committed to
			# the repo, and the cohort holds founder instructions verbatim — proving
			# the wedge needs the row's identity and shape, never its text. Set
			# FLY1586_INCLUDE_CONTENT=1 for a local-only capture that keeps bodies.
			if [ "${FLY1586_INCLUDE_CONTENT:-0}" = "1" ]; then
				q "$db" "SELECT id, to_lead, source, type, msg_class, created_at,
       consumed_at IS NULL AS undelivered, substr(content, 1, 90) AS head
FROM lead_inbox WHERE consumed_at IS NULL ORDER BY created_at;"
			else
				Q_MODE=-list q "$db" "SELECT id, to_lead, source, type, msg_class, created_at,
       consumed_at IS NULL AS undelivered,
       length(content) AS content_len,
       substr(hex(content), 1, 16) AS content_prefix_hex
FROM lead_inbox WHERE consumed_at IS NULL ORDER BY created_at;"
			fi
		fi
	} >> "$OUT_DIR/07-question-cohort.txt"
done
note "evidence 6 -> 07-question-cohort.txt"

note ""
note "NOTE — what this capture does NOT contain:"
note "  * the /health liveness manifest ((.liveness // .watchdogs) — FLY-1560 renamed the key) requires a LIVE Bridge; capture it separately before the stop."
note "  * Discord-side receipts are not reachable from this host and are not faked here."
note "Both gaps are written down rather than silently omitted, so a reader can tell"
note "'not captured' from 'captured and empty'."
note ""
note "files written: $(find "$OUT_DIR" -type f | wc -l | tr -d ' ') in $OUT_DIR"
note "query_errors: $QUERY_ERRORS"
if [ "$QUERY_ERRORS" -ne 0 ]; then
	note "FAILED — $QUERY_ERRORS quer(y|ies) errored. The files above contain sqlite"
	note "error text where evidence should be. Do NOT treat this as a captured"
	note "baseline, and do NOT restart the Bridge on the strength of it."
	exit 1
fi
note "DONE — capture is complete and every query returned without error."
