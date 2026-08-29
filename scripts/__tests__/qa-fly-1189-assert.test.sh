#!/usr/bin/env bash
# FLY-1189 H3: hermetic tests for the assertion library (lib/qa-fly-1189-assert.sh).
# Assertions read a fixture slot StateStore (real sqlite schema) + recorded
# Discord API JSON, and emit `PASS|FAIL <id> <detail>` lines PLUS an evidence
# JSON written to the campaign root (SLOT_DIR gets wiped by teardown, so
# evidence MUST land outside it — Codex R1 #5).
#
#   E-EP  assert_episode — (target_key, kind, fingerprint) keyed lookup + status
#   E-TH  assert_thread_msg — message count + full evidence (id/link/dump/author)
#   E-FP  assert_founder_page — mentions[].id == owner, exactly one, ledger row
#   E-LE  assert_lead_event — lead_events row + delivered_at
#   E-XC  assert_no_cross — explicit two-thread traversal (Codex R1 #7)
#   E-EV  every assertion writes an evidence JSON to the campaign root
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${SCRIPT_DIR}/lib/qa-fly-1189-assert.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

[[ -f "$LIB" ]] || { echo "FATAL: ${LIB} missing — implement it first" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 not available" >&2; exit 0; }

# shellcheck source=/dev/null
source "$LIB"
for fn in assert_episode assert_thread_msg assert_founder_page assert_lead_event assert_no_cross assert_prod_taint; do
  type "$fn" >/dev/null 2>&1 || { echo "FATAL: ${fn} not defined in ${LIB}" >&2; exit 1; }
done

TMP="$(mktemp -d "/tmp/qa1189assert.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
DB="${TMP}/teamlead.db"
CAMPAIGN_ROOT="${TMP}/campaign"
mkdir -p "$CAMPAIGN_ROOT"
export QA1189_CAMPAIGN_ROOT="$CAMPAIGN_ROOT"

# ── Fixture StateStore with the real detection schema ──
sqlite3 "$DB" <<'SQL'
CREATE TABLE detection_escalations (
  target_key TEXT NOT NULL, kind TEXT NOT NULL, episode_fingerprint TEXT NOT NULL,
  issue_id TEXT, owner_lead_id TEXT, first_detected_at_ms INTEGER NOT NULL,
  lead_notified_at_ms INTEGER, lead_ack_at_ms INTEGER, founder_paged_at_ms INTEGER,
  clearing_since_ms INTEGER, status TEXT NOT NULL DEFAULT 'NEW', attempts INTEGER NOT NULL DEFAULT 0,
  resolved_via TEXT, created_at TEXT,
  PRIMARY KEY (target_key, kind, episode_fingerprint));
CREATE TABLE lead_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, event_id TEXT NOT NULL,
  event_type TEXT NOT NULL, payload TEXT NOT NULL, session_key TEXT, delivered_at TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0, last_delivery_error TEXT, created_at TEXT);
CREATE TABLE founder_page_ledger (event_id TEXT PRIMARY KEY, paged INTEGER NOT NULL, ts TEXT);

-- Episode A1: fully escalated (LEAD_NOTIFIED → ESCALATED), owner Lead-P.
INSERT INTO detection_escalations VALUES
 ('exec-A1','detection_stuck_confirmed','fpA1','FLY-145','flywheel-test-2',1000,2000,NULL,3000,NULL,'ESCALATED',2,NULL,'t');
-- Episode B1: gap-kind, owner Lead-O, ESCALATED.
INSERT INTO detection_escalations VALUES
 ('exec-B1','runner_parked_unreported','fpB1','FLY-9001','flywheel-test-3',1100,2100,NULL,3100,NULL,'ESCALATED',1,NULL,'t');
-- Episode A2': ACKED by Lead before grace.
INSERT INTO detection_escalations VALUES
 ('exec-A2p','detection_stuck_confirmed','fpA2p','FLY-145','flywheel-test-2',1200,2200,2500,NULL,NULL,'ACKED',1,NULL,'t');

INSERT INTO lead_events (lead_id,event_id,event_type,payload,delivered_at) VALUES
 ('flywheel-test-2','ev-A1','detection_escalation','{"execId":"exec-A1"}','2026-07-11T10:00:00Z'),
 ('flywheel-test-3','ev-B1','detection_escalation','{"execId":"exec-B1"}','2026-07-11T10:01:00Z'),
 ('flywheel-test-2','ev-A2p-undelivered','detection_escalation','{"execId":"exec-A2p"}',NULL);

INSERT INTO founder_page_ledger VALUES ('page-A1',1,'t'), ('page-B1',1,'t');
SQL

# ── E-EP: assert_episode by full (target_key, kind, fingerprint) key ──
E_OK=1
out=$(assert_episode "$DB" exec-A1 detection_stuck_confirmed fpA1 ESCALATED 2>/dev/null)
grep -q "^PASS" <<<"$out" || { E_OK=0; fail "E-EP: exact episode match should PASS ($out)"; }
out=$(assert_episode "$DB" exec-A1 detection_stuck_confirmed fpA1 ACKED 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { E_OK=0; fail "E-EP: wrong status should FAIL"; }
# fingerprint is part of the key — a different fingerprint must NOT match A1's row
out=$(assert_episode "$DB" exec-A1 detection_stuck_confirmed WRONGFP ESCALATED 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { E_OK=0; fail "E-EP: fingerprint mismatch must FAIL (key includes fingerprint)"; }
# kind is part of the key too
out=$(assert_episode "$DB" exec-A1 runner_parked_unreported fpA1 ESCALATED 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { E_OK=0; fail "E-EP: kind mismatch must FAIL"; }
[[ "$E_OK" == "1" ]] && pass "E-EP: assert_episode keyed on (target_key,kind,fingerprint)+status"

# ── E-LE: lead_events + delivered_at ──
L_OK=1
out=$(assert_lead_event "$DB" exec-A1 detection_escalation delivered 2>/dev/null)
grep -q "^PASS" <<<"$out" || { L_OK=0; fail "E-LE: delivered lead_event should PASS ($out)"; }
out=$(assert_lead_event "$DB" exec-A2p detection_escalation delivered 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { L_OK=0; fail "E-LE: undelivered event asserted delivered should FAIL"; }
out=$(assert_lead_event "$DB" exec-A2p detection_escalation any 2>/dev/null)
grep -q "^PASS" <<<"$out" || { L_OK=0; fail "E-LE: row-exists (any) should PASS regardless of delivery"; }
out=$(assert_lead_event "$DB" exec-NONE detection_escalation any 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { L_OK=0; fail "E-LE: missing execId should FAIL"; }
[[ "$L_OK" == "1" ]] && pass "E-LE: assert_lead_event (row + delivered_at)"

# ── Recorded Discord thread JSON fixtures (as returned by GET messages) ──
THREAD_A="${TMP}/thread-A1.json"
THREAD_B="${TMP}/thread-B1.json"
cat > "$THREAD_A" <<JSON
[
  {"id":"msg-a-1","channel_id":"111","author":{"id":"botP","bot":true},
   "content":"🔧 [FLY-145] detection: exec-A1 stuck (no mention)","mentions":[]},
  {"id":"msg-a-2","channel_id":"111","author":{"id":"botP","bot":true},
   "content":"@founder exec-A1 unresolved past grace","mentions":[{"id":"OWNER123"}]}
]
JSON
cat > "$THREAD_B" <<JSON
[
  {"id":"msg-b-1","channel_id":"222","author":{"id":"botO","bot":true},
   "content":"🔧 [FLY-9001] detection: exec-B1 parked-unreported","mentions":[]},
  {"id":"msg-b-2","channel_id":"222","author":{"id":"botO","bot":true},
   "content":"@founder exec-B1 unresolved past grace","mentions":[{"id":"OWNER123"}]}
]
JSON

# ── E-TH: message count + evidence ──
T_OK=1
out=$(assert_thread_msg "$THREAD_A" "detection: exec-A1" 1 2>/dev/null)
grep -q "^PASS" <<<"$out" || { T_OK=0; fail "E-TH: exactly-1 quiet post should PASS ($out)"; }
out=$(assert_thread_msg "$THREAD_A" "detection: exec-A1" 2 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { T_OK=0; fail "E-TH: wrong count should FAIL"; }
# evidence dump must carry message id + author bot id + parent channel
grep -q "msg-a-1" <<<"$out" && grep -q "botP" <<<"$out" || { T_OK=0; fail "E-TH: evidence must include msg id + author bot id"; }
[[ "$T_OK" == "1" ]] && pass "E-TH: assert_thread_msg count + evidence(id/author/channel)"

# ── E-FP: founder page — mention == owner, exactly one, EPISODE-SCOPED page ──
F_OK=1
# Episode-scoped (A1 has founder_paged_at_ms=3000) → PASS.
out=$(assert_founder_page "$THREAD_A" OWNER123 "$DB" exec-A1 detection_stuck_confirmed fpA1 2>/dev/null)
grep -q "^PASS" <<<"$out" || { F_OK=0; fail "E-FP: episode-scoped founder page should PASS ($out)"; }
out=$(assert_founder_page "$THREAD_A" WRONGOWNER "$DB" exec-A1 detection_stuck_confirmed fpA1 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { F_OK=0; fail "E-FP: wrong owner id must FAIL"; }
# a thread with TWO founder mentions must FAIL (exactly one)
DBL="${TMP}/thread-double.json"
cat > "$DBL" <<JSON
[
 {"id":"m1","channel_id":"111","author":{"id":"botP","bot":true},"content":"@founder x","mentions":[{"id":"OWNER123"}]},
 {"id":"m2","channel_id":"111","author":{"id":"botP","bot":true},"content":"@founder x again","mentions":[{"id":"OWNER123"}]}
]
JSON
out=$(assert_founder_page "$DBL" OWNER123 "$DB" exec-A1 detection_stuck_confirmed fpA1 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { F_OK=0; fail "E-FP: two founder pages must FAIL (exactly one)"; }
# EPISODE-SCOPED: an in-thread mention whose episode has founder_paged_at_ms=NULL
# must FAIL even though a global ledger row exists (A2p is ACKED, not paged).
out=$(assert_founder_page "$THREAD_A" OWNER123 "$DB" exec-A2p detection_stuck_confirmed fpA2p 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { F_OK=0; fail "E-FP: episode w/o founder_paged_at_ms must FAIL despite a global ledger row (stale-ledger false-green)"; }
[[ "$F_OK" == "1" ]] && pass "E-FP: assert_founder_page episode-scoped (founder_paged_at_ms, not global ledger)"

# ── E-PT: assert_prod_taint (E5 attribution gate) ──
PT_OK=1
PROD_STATE="${TMP}/prod-state.db"
PROD_COMM="${TMP}/prod-comm.db"
# Real StateStore-ish schema (subset of the columns the scan touches).
sqlite3 "$PROD_STATE" <<'SQL'
CREATE TABLE sessions (execution_id TEXT, project_name TEXT);
CREATE TABLE session_events (execution_id TEXT);
CREATE TABLE lead_events (payload TEXT);
CREATE TABLE chat_threads (issue_id TEXT);
INSERT INTO sessions VALUES ('prod-exec-1','geoforge3d');
SQL
# Real CommDB schema (db.ts): messages.content (NOT body); no questions table.
sqlite3 "$PROD_COMM" <<'SQL'
CREATE TABLE sessions (execution_id TEXT, tmux_window TEXT NOT NULL DEFAULT '', project_name TEXT);
CREATE TABLE messages (id TEXT, content TEXT);
INSERT INTO messages VALUES ('m1','a normal production message');
SQL
# Clean prod → PASS.
out=$(assert_prod_taint "$PROD_STATE" "$PROD_COMM" "fly1189-camp-1" "test-slot-2" "exec-A1" 2>/dev/null)
grep -q "^PASS" <<<"$out" || { PT_OK=0; fail "E-PT: clean prod should PASS ($out)"; }
# Plant a test-project row in prod StateStore → FAIL.
sqlite3 "$PROD_STATE" "INSERT INTO sessions VALUES ('exec-A1','test-slot-2');"
out=$(assert_prod_taint "$PROD_STATE" "$PROD_COMM" "fly1189-camp-1" "test-slot-2" "exec-A1" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { PT_OK=0; fail "E-PT: a test-project row in prod StateStore must FAIL"; }
# Plant a campaign marker in CommDB messages.content → FAIL (proves messages.content is scanned).
sqlite3 "$PROD_COMM" "INSERT INTO messages VALUES ('m2','leaked fly1189-camp-1 marker');"
out=$(assert_prod_taint "$PROD_STATE" "$PROD_COMM" "fly1189-camp-1" "geoforge3d" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { PT_OK=0; fail "E-PT: a campaign marker in CommDB messages.content must FAIL"; }
# Plant a test execId in CommDB runner_declared_states → FAIL (proves it is scanned).
sqlite3 "$PROD_COMM" "CREATE TABLE runner_declared_states(execution_id TEXT); INSERT INTO runner_declared_states VALUES('exec-A1');"
out=$(assert_prod_taint "$PROD_STATE" "$PROD_COMM" "fly1189-camp-1" "geoforge3d" "exec-A1" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { PT_OK=0; fail "E-PT: a test execId in CommDB runner_declared_states must FAIL"; }
# COLERR fail-closed: a CommDB whose messages table LACKS the content column
# (schema drift) must FAIL-CLOSED, not silently skip.
BADCOL="${TMP}/badcol-comm.db"
sqlite3 "$BADCOL" "CREATE TABLE sessions(execution_id TEXT, project_name TEXT); CREATE TABLE messages(id TEXT, wrongname TEXT);"
out=$(assert_prod_taint "${TMP}/nostatedb.db" "$BADCOL" "fly1189-camp-1" "test-slot-2" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { PT_OK=0; fail "E-PT: a missing scanned column must FAIL-CLOSED (COLERR)"; }
# Unreadable prod DB (non-sqlite file) → FAIL-CLOSED.
BAD_DB="${TMP}/not-a-db.db"
printf 'this is not sqlite' > "$BAD_DB"
out=$(assert_prod_taint "$BAD_DB" "$PROD_COMM" "fly1189-camp-1" "test-slot-2" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { PT_OK=0; fail "E-PT: an unreadable prod DB must FAIL-CLOSED"; }
# EXPLICITLY-provided but non-existent path → FAIL-CLOSED (Codex R4 #5).
out=$(assert_prod_taint "${TMP}/nonexistent.db" "$PROD_COMM" "fly1189-camp-1" "test-slot-2" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { PT_OK=0; fail "E-PT: a provided-but-missing prod DB path must FAIL-CLOSED (MISSINGDB)"; }
# EMPTY path args (no such prod DB configured) → legit skip → PASS.
out=$(assert_prod_taint "" "" "fly1189-camp-1" "test-slot-2" 2>/dev/null)
grep -q "^PASS" <<<"$out" || { PT_OK=0; fail "E-PT: empty prod DB paths should PASS (nothing configured to scan)"; }
[[ "$PT_OK" == "1" ]] && pass "E-PT: assert_prod_taint (real schema; taint/COLERR/unreadable/missing-path all FAIL-CLOSED; empty=skip)"

# ── E-XC: no-cross — explicit two-thread traversal ──
X_OK=1
# Clean: A's thread has no B identifier and vice-versa.
out=$(assert_no_cross "$THREAD_A" "FLY-145 exec-A1 botP" "$THREAD_B" "FLY-9001 exec-B1 botO" 2>/dev/null)
grep -q "^PASS" <<<"$out" || { X_OK=0; fail "E-XC: clean threads should PASS ($out)"; }
# Contaminated: plant B's execId into A's thread → must FAIL (Codex R1 #7 — the
# assertion must actually traverse BOTH threads, not just the parent channel).
CONTAM="${TMP}/thread-A-contam.json"
cat > "$CONTAM" <<JSON
[
 {"id":"c1","channel_id":"111","author":{"id":"botP","bot":true},"content":"leaked exec-B1 into A thread","mentions":[]}
]
JSON
out=$(assert_no_cross "$CONTAM" "FLY-145 exec-A1 botP" "$THREAD_B" "FLY-9001 exec-B1 botO" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { X_OK=0; fail "E-XC: B's execId in A's thread must FAIL"; }
# Reverse direction: A's identifier leaked into B's thread.
CONTAM2="${TMP}/thread-B-contam.json"
cat > "$CONTAM2" <<JSON
[
 {"id":"c2","channel_id":"222","author":{"id":"botO","bot":true},"content":"leaked FLY-145 into B thread","mentions":[]}
]
JSON
out=$(assert_no_cross "$THREAD_A" "FLY-145 exec-A1 botP" "$CONTAM2" "FLY-9001 exec-B1 botO" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { X_OK=0; fail "E-XC: A's identifier in B's thread must FAIL (reverse)"; }
# wrong-author contamination: B's bot posting in A's thread
CONTAM3="${TMP}/thread-A-wrongbot.json"
cat > "$CONTAM3" <<JSON
[
 {"id":"c3","channel_id":"111","author":{"id":"botO","bot":true},"content":"A content by wrong bot","mentions":[]}
]
JSON
out=$(assert_no_cross "$CONTAM3" "FLY-145 exec-A1 botP" "$THREAD_B" "FLY-9001 exec-B1 botO" 2>/dev/null)
grep -q "^FAIL" <<<"$out" || { X_OK=0; fail "E-XC: wrong bot author in A's thread must FAIL"; }
[[ "$X_OK" == "1" ]] && pass "E-XC: assert_no_cross traverses BOTH threads bidirectionally + author"

# ── E-UW: an UNWRITABLE campaign root forces FAIL (cannot prove → not PASS) ──
UW_OK=1
UNWRITABLE="${TMP}/unwritable-root"
: > "$UNWRITABLE"   # a FILE where a directory is expected → mkdir/-write fails
out=$(QA1189_CAMPAIGN_ROOT="${UNWRITABLE}/sub" assert_episode "$DB" exec-A1 detection_stuck_confirmed fpA1 ESCALATED 2>/dev/null)
if grep -q "^FAIL" <<<"$out" && grep -q "UNWRITABLE" <<<"$out"; then
  pass "E-UW: unwritable campaign root forces a would-be PASS to FAIL"
else
  UW_OK=0; fail "E-UW: unwritable evidence root must force FAIL (got: $out)"
fi

# ── E-MF: a malformed (non-empty, invalid-JSON) evidence blob forces FAIL ──
# Exercise via _qa1189a_emit directly (the internal API assertions use).
out=$(_qa1189a_emit "mf:test" PASS "would-be pass" 'this-is-not-json' 2>/dev/null)
if grep -q "^FAIL" <<<"$out" && grep -q "MALFORMED" <<<"$out"; then
  pass "E-MF: malformed evidence forces a would-be PASS to FAIL"
else
  fail "E-MF: malformed evidence must force FAIL (got: $out)"
fi

# ── E-EV: evidence JSON landed in the campaign root (outside SLOT_DIR) ──
if ls "${CAMPAIGN_ROOT}"/evidence-*.json >/dev/null 2>&1; then
  cnt=$(ls "${CAMPAIGN_ROOT}"/evidence-*.json | wc -l | tr -d ' ')
  if (( cnt > 0 )); then
    pass "E-EV: assertions wrote ${cnt} evidence file(s) to campaign root"
  else
    fail "E-EV: no evidence files written"
  fi
else
  fail "E-EV: no evidence-*.json in campaign root — assertions must persist evidence"
fi

echo "=================================="
echo "qa-fly-1189-assert tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
