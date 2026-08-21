#!/bin/bash
# Test suite for inbox-check.sh PostToolUse hook (GEO-266)
# Usage: bash scripts/hooks/test-inbox-check.sh

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/inbox-check.sh"
PASS=0
FAIL=0
TMPDIR=$(mktemp -d)

# FLY-142: this suite frequently runs INSIDE a live Runner session, which
# exports FLYWHEEL_RUNNER_STATE_DIR pointing at a state dir that carries an
# active `mailbox-active` sentinel. Tests that don't pin their own sentinel
# state (3–7) would inherit it and the hook would short-circuit to a no-op,
# producing spurious failures. Drop the ambient values so those tests exercise
# the real CommDB path. Tests that need a specific sentinel state set
# FLYWHEEL_RUNNER_STATE_DIR per-invocation (S1–S3) or a controlled HOME (S4).
unset FLYWHEEL_RUNNER_STATE_DIR FLYWHEEL_DISABLE_MAILBOX_SENTINEL 2>/dev/null || true

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }
create_mailbox_db() {
  sqlite3 "$1" "
CREATE TABLE mailbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  ref_id TEXT,
  state TEXT NOT NULL DEFAULT 'QUEUED',
  acked_at TEXT,
  delivered_at TEXT,
  claimed_by TEXT,
  claim_expires_at TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+72 hours'))
);
PRAGMA journal_mode=WAL;
"
}

echo "Testing inbox-check.sh hook"
echo "=========================="

# Test 1: No env vars → exit 0, no output
echo ""
echo "Test 1: No env vars → silent exit"
OUTPUT=$(FLYWHEEL_EXEC_ID= FLYWHEEL_COMM_DB= bash "$HOOK" 2>&1) || true
if [ -z "$OUTPUT" ]; then
  pass "No output when env vars empty"
else
  fail "Expected no output" "got: $OUTPUT"
fi

# Test 2: DB file doesn't exist → exit 0, no output
echo ""
echo "Test 2: DB file missing → silent exit"
OUTPUT=$(FLYWHEEL_EXEC_ID="test-exec" FLYWHEEL_COMM_DB="/nonexistent/path.db" bash "$HOOK" 2>&1) || true
if [ -z "$OUTPUT" ]; then
  pass "No output when DB file missing"
else
  fail "Expected no output" "got: $OUTPUT"
fi

# Test 3: Empty DB (no instructions) → exit 0, no output
echo ""
echo "Test 3: Empty DB → silent exit"
DB3="$TMPDIR/test3.db"
create_mailbox_db "$DB3"
OUTPUT=$(FLYWHEEL_EXEC_ID="test-exec" FLYWHEEL_COMM_DB="$DB3" bash "$HOOK" 2>&1) || true
if [ -z "$OUTPUT" ]; then
  pass "No output for empty DB"
else
  fail "Expected no output" "got: $OUTPUT"
fi

# Test 4: Has unread instructions → outputs valid JSON with additionalContext
echo ""
echo "Test 4: Unread instructions → JSON output"
DB4="$TMPDIR/test4.db"
create_mailbox_db "$DB4"
sqlite3 "$DB4" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('msg-1', 'product-lead', 'exec-42', 'instruction', 'Please report your progress');
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('msg-2', 'product-lead', 'exec-42', 'instruction', 'Also check the tests');
"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-42" FLYWHEEL_COMM_DB="$DB4" bash "$HOOK" 2>&1)
if echo "$OUTPUT" | jq -e '.hookSpecificOutput.additionalContext' > /dev/null 2>&1; then
  pass "Valid JSON with additionalContext"
else
  fail "Invalid JSON output" "$OUTPUT"
fi
if echo "$OUTPUT" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "LEAD INSTRUCTION"; then
  pass "Contains LEAD INSTRUCTION header"
else
  fail "Missing header" "$OUTPUT"
fi
if echo "$OUTPUT" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "report your progress"; then
  pass "Contains instruction content"
else
  fail "Missing instruction content" "$OUTPUT"
fi
DELIVERED_4=$(sqlite3 "$DB4" "SELECT COUNT(*) FROM mailbox WHERE id IN ('msg-1','msg-2') AND delivered_at IS NOT NULL;")
if [ "$DELIVERED_4" = "2" ]; then
  pass "Retrieved instructions receive raw delivery stamps"
else
  fail "Retrieved instructions should be delivery-stamped" "stamped=$DELIVERED_4"
fi

# Test 5: Only marks retrieved IDs as read (not blanket)
echo ""
echo "Test 5: Targeted read-marking"
DB5="$TMPDIR/test5.db"
create_mailbox_db "$DB5"
sqlite3 "$DB5" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('msg-a', 'lead', 'exec-99', 'instruction', 'First instruction');
UPDATE mailbox SET delivered_at='2026-08-20T01:02:03.004Z' WHERE id='msg-a';
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('msg-b', 'lead', 'other-exec', 'instruction', 'For different runner');
"
FLYWHEEL_EXEC_ID="exec-99" FLYWHEEL_COMM_DB="$DB5" bash "$HOOK" > /dev/null 2>&1 || true

# msg-a should be marked read
READ_A=$(sqlite3 "$DB5" "SELECT state = 'ACKED' FROM mailbox WHERE id='msg-a';")
if [ "$READ_A" = "1" ]; then
  pass "msg-a (target) marked as read"
else
  fail "msg-a should be read" "read_at=$READ_A"
fi
DELIVERED_A=$(sqlite3 "$DB5" "SELECT delivered_at FROM mailbox WHERE id='msg-a';")
if [ "$DELIVERED_A" = "2026-08-20T01:02:03.004Z" ]; then
  pass "msg-a preserves its earlier delivery stamp"
else
  fail "msg-a delivery stamp should be preserved" "delivered_at=$DELIVERED_A"
fi

# msg-b should still be unread (different exec-id)
READ_B=$(sqlite3 "$DB5" "SELECT state = 'QUEUED' FROM mailbox WHERE id='msg-b';")
if [ "$READ_B" = "1" ]; then
  pass "msg-b (different runner) still unread"
else
  fail "msg-b should be unread" "read_at check=$READ_B"
fi

# Test 6: Already-read instructions are not re-injected
echo ""
echo "Test 6: No re-injection of read instructions"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-99" FLYWHEEL_COMM_DB="$DB5" bash "$HOOK" 2>&1) || true
if [ -z "$OUTPUT" ]; then
  pass "No output after instructions already read"
else
  fail "Should not re-inject" "got: $OUTPUT"
fi

# Test 7: Multi-line content handled correctly (Codex R1 fix)
echo ""
echo "Test 7: Multi-line instruction content"
DB7="$TMPDIR/test7.db"
create_mailbox_db "$DB7"
sqlite3 "$DB7" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('msg-ml', 'product-lead', 'exec-ml', 'instruction', 'Line one
Line two
Line three');
"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-ml" FLYWHEEL_COMM_DB="$DB7" bash "$HOOK" 2>&1)
if echo "$OUTPUT" | jq -e '.hookSpecificOutput.additionalContext' > /dev/null 2>&1; then
  pass "Multi-line: valid JSON"
else
  fail "Multi-line: invalid JSON" "$OUTPUT"
fi
# Verify all three lines are present (not truncated)
CTX=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput.additionalContext')
if echo "$CTX" | grep -q "Line one" && echo "$CTX" | grep -q "Line two" && echo "$CTX" | grep -q "Line three"; then
  pass "Multi-line: all lines preserved"
else
  fail "Multi-line: content truncated" "$CTX"
fi
# Verify no bogus empty-agent entries
if echo "$CTX" | grep -q '\[\]:'; then
  fail "Multi-line: bogus empty entry found" "$CTX"
else
  pass "Multi-line: no bogus entries"
fi

# Test S1: FLY-142 PR 1.4 sentinel — present → noop even with unread instructions
echo ""
echo "Test S1: mailbox sentinel present → hook noops (FLY-142 PR 1.4)"
DB_S1="$TMPDIR/test_s1.db"
create_mailbox_db "$DB_S1"
sqlite3 "$DB_S1" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('s1-msg', 'lead', 'exec-s1', 'instruction', 'Should NOT be delivered when sentinel present');
"
SENTINEL_DIR_S1="$TMPDIR/runner-state/exec-s1"
mkdir -p "$SENTINEL_DIR_S1"
touch "$SENTINEL_DIR_S1/mailbox-active"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-s1" \
         FLYWHEEL_COMM_DB="$DB_S1" \
         FLYWHEEL_RUNNER_STATE_DIR="$SENTINEL_DIR_S1" \
         bash "$HOOK" 2>&1)
if [ -z "$OUTPUT" ]; then
  pass "Sentinel present → no output (hook short-circuits)"
else
  fail "Sentinel should suppress output" "got: $OUTPUT"
fi
# Verify the message was NOT marked as read (sentinel skipped the SQL path entirely)
READ_AT=$(sqlite3 "$DB_S1" "SELECT acked_at FROM mailbox WHERE id='s1-msg';")
if [ -z "$READ_AT" ]; then
  pass "Sentinel present → message NOT marked read (proves SQL path skipped)"
else
  fail "Sentinel should leave message unread" "read_at=$READ_AT"
fi

# Test S2: FLY-142 PR 1.4 sentinel absent → CommDB fallback runs
echo ""
echo "Test S2: sentinel absent → CommDB fallback delivery works"
DB_S2="$TMPDIR/test_s2.db"
create_mailbox_db "$DB_S2"
sqlite3 "$DB_S2" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('s2-msg', 'lead', 'exec-s2', 'instruction', 'Rollback path delivery');
"
# Explicitly point sentinel dir at empty location → no sentinel
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-s2" \
         FLYWHEEL_COMM_DB="$DB_S2" \
         FLYWHEEL_RUNNER_STATE_DIR="$TMPDIR/no-such-dir" \
         bash "$HOOK" 2>&1)
if echo "$OUTPUT" | jq -e '.hookSpecificOutput.additionalContext' > /dev/null 2>&1; then
  pass "No sentinel → CommDB delivery still works"
else
  fail "Expected CommDB delivery output" "$OUTPUT"
fi

# Test S3: FLY_DISABLE_MAILBOX_SENTINEL=1 → ignore sentinel, run fallback
echo ""
echo "Test S3: FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1 ignores sentinel"
DB_S3="$TMPDIR/test_s3.db"
create_mailbox_db "$DB_S3"
sqlite3 "$DB_S3" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('s3-msg', 'lead', 'exec-s3', 'instruction', 'Override delivery');
"
SENTINEL_DIR_S3="$TMPDIR/runner-state/exec-s3"
mkdir -p "$SENTINEL_DIR_S3"
touch "$SENTINEL_DIR_S3/mailbox-active"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-s3" \
         FLYWHEEL_COMM_DB="$DB_S3" \
         FLYWHEEL_RUNNER_STATE_DIR="$SENTINEL_DIR_S3" \
         FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1 \
         bash "$HOOK" 2>&1)
if echo "$OUTPUT" | jq -e '.hookSpecificOutput.additionalContext' > /dev/null 2>&1; then
  pass "DISABLE_MAILBOX_SENTINEL=1 → sentinel ignored, fallback delivery runs"
else
  fail "Expected fallback delivery despite sentinel" "$OUTPUT"
fi

# Test S4: Default sentinel path (~/.flywheel/runner-state/<exec>/mailbox-active)
# is consulted when FLYWHEEL_RUNNER_STATE_DIR is unset
echo ""
echo "Test S4: default sentinel path picked up via HOME-derived fallback"
DB_S4="$TMPDIR/test_s4.db"
create_mailbox_db "$DB_S4"
sqlite3 "$DB_S4" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('s4-msg', 'lead', 'exec-s4', 'instruction', 'Default-path test');
"
# Override HOME so the default path resolves into TMPDIR
FAKE_HOME="$TMPDIR/fake-home-s4"
mkdir -p "$FAKE_HOME/.flywheel/runner-state/exec-s4"
touch "$FAKE_HOME/.flywheel/runner-state/exec-s4/mailbox-active"
OUTPUT=$(HOME="$FAKE_HOME" \
         FLYWHEEL_EXEC_ID="exec-s4" \
         FLYWHEEL_COMM_DB="$DB_S4" \
         bash "$HOOK" 2>&1)
if [ -z "$OUTPUT" ]; then
  pass "Default \$HOME-derived sentinel path detected"
else
  fail "Expected sentinel-noop via default path" "$OUTPUT"
fi

# Test 8: FLY-142 — type='response' is delivered (the wake bug fix).
# A parked/idle runner asked the lead a question, then went idle. The lead's
# `respond` writes a type='response' row to the runner's inbox. The legacy
# CommDB fallback MUST now inject it (with parent question context) so the runner
# wakes on its next Bash. Sentinel deliberately absent.
echo ""
echo "Test 8: Lead response to a parked runner → injected with parent context"
DB8="$TMPDIR/test8.db"
create_mailbox_db "$DB8"
sqlite3 "$DB8" "
-- runner asked the lead a question (from runner → to lead)
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('q-1', 'exec-r8', 'product-lead', 'question', 'Which API version should I target?');
-- lead responded (from lead → to runner); ref_id links back to the question
INSERT INTO mailbox (id, from_agent, to_agent, type, content, ref_id)
  VALUES ('r-1', 'product-lead', 'exec-r8', 'response', 'Target v2 of the API.', 'q-1');
"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-r8" \
         FLYWHEEL_COMM_DB="$DB8" \
         FLYWHEEL_RUNNER_STATE_DIR="$TMPDIR/no-such-dir-8" \
         bash "$HOOK" 2>&1)
CTX=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)
if [ -n "$CTX" ] && [ "$CTX" != "null" ]; then
  pass "Response produced output (runner wakes)"
else
  fail "Response not delivered — the wake bug" "$OUTPUT"
fi
if echo "$CTX" | grep -q "Target v2 of the API"; then
  pass "Contains response content"
else
  fail "Missing response content" "$CTX"
fi
if echo "$CTX" | grep -q "Which API version should I target"; then
  pass "Contains parent question content (runner knows what it answers)"
else
  fail "Missing parent question context" "$CTX"
fi
if echo "$CTX" | grep -q "q-1"; then
  pass "Contains parent question id"
else
  fail "Missing parent question id" "$CTX"
fi
READ_R=$(sqlite3 "$DB8" "SELECT state = 'ACKED' FROM mailbox WHERE id='r-1';")
if [ "$READ_R" = "1" ]; then
  pass "Response marked read (no re-injection)"
else
  fail "Response should be marked read" "read_at check=$READ_R"
fi
# The parent question (to_agent=lead) is the lead's inbox item, not the runner's:
# it must NOT be marked read and must NOT appear as its own injected line.
READ_Q=$(sqlite3 "$DB8" "SELECT state = 'QUEUED' FROM mailbox WHERE id='q-1';")
if [ "$READ_Q" = "1" ]; then
  pass "Parent question left untouched (not the runner's inbox item)"
else
  fail "Parent question should be untouched" "read check=$READ_Q"
fi
if echo "$CTX" | grep -q "\[exec-r8\]:"; then
  fail "Question row wrongly injected as its own line" "$CTX"
else
  pass "Question row not injected as its own line"
fi

# Test 9: Response is not re-injected once marked read (parallels Test 6).
echo ""
echo "Test 9: No re-injection of an already-read response"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-r8" \
         FLYWHEEL_COMM_DB="$DB8" \
         FLYWHEEL_RUNNER_STATE_DIR="$TMPDIR/no-such-dir-8" \
         bash "$HOOK" 2>&1) || true
if [ -z "$OUTPUT" ]; then
  pass "No output after response already read"
else
  fail "Should not re-inject read response" "got: $OUTPUT"
fi

# Test 10: instruction + response co-resident in the same inbox → BOTH delivered.
# Proves the backward-compatible instruction path is unbroken by the response add.
echo ""
echo "Test 10: instruction + response together → both delivered"
DB10="$TMPDIR/test10.db"
create_mailbox_db "$DB10"
sqlite3 "$DB10" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('i-1', 'lead', 'exec-mix', 'instruction', 'Do the thing now');
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('q-2', 'exec-mix', 'lead', 'question', 'Ready to merge?');
INSERT INTO mailbox (id, from_agent, to_agent, type, content, ref_id)
  VALUES ('r-2', 'lead', 'exec-mix', 'response', 'Yes, go ahead', 'q-2');
"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-mix" \
         FLYWHEEL_COMM_DB="$DB10" \
         FLYWHEEL_RUNNER_STATE_DIR="$TMPDIR/no-such-dir-10" \
         bash "$HOOK" 2>&1)
CTX=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)
if echo "$CTX" | grep -q "Do the thing now"; then
  pass "Instruction still delivered (backward compat)"
else
  fail "Instruction dropped" "$CTX"
fi
if echo "$CTX" | grep -q "Yes, go ahead"; then
  pass "Response delivered alongside instruction"
else
  fail "Response dropped in mixed inbox" "$CTX"
fi

# Test 11: scope guard — a bare type='question' addressed to the runner is NOT
# injected. Ensures we widened the filter to exactly {instruction,response},
# not to all types.
echo ""
echo "Test 11: a 'question' row addressed to the runner is NOT injected"
DB11="$TMPDIR/test11.db"
create_mailbox_db "$DB11"
sqlite3 "$DB11" "
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('qq-1', 'someone', 'exec-q', 'question', 'A question pointed at the runner');
INSERT INTO mailbox (id, from_agent, to_agent, type, content)
  VALUES ('pp-1', 'someone', 'exec-q', 'progress', 'A progress note');
"
OUTPUT=$(FLYWHEEL_EXEC_ID="exec-q" \
         FLYWHEEL_COMM_DB="$DB11" \
         FLYWHEEL_RUNNER_STATE_DIR="$TMPDIR/no-such-dir-11" \
         bash "$HOOK" 2>&1) || true
if [ -z "$OUTPUT" ]; then
  pass "question/progress types not delivered (filter scoped correctly)"
else
  fail "Non-{instruction,response} type leaked into delivery" "got: $OUTPUT"
fi

# Summary
echo ""
echo "=========================="
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All tests passed!"
