#!/bin/bash
# Test suite for inbox-check.sh PostToolUse hook (GEO-266)
# Usage: bash scripts/hooks/test-inbox-check.sh

set -euo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/inbox-check.sh"
PASS=0
FAIL=0
TMPDIR=$(mktemp -d)

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

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
sqlite3 "$DB3" "
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_id TEXT,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT (datetime('now', '+72 hours'))
);
PRAGMA journal_mode=WAL;
"
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
sqlite3 "$DB4" "
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_id TEXT,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT (datetime('now', '+72 hours'))
);
PRAGMA journal_mode=WAL;
INSERT INTO messages (id, from_agent, to_agent, type, content)
  VALUES ('msg-1', 'product-lead', 'exec-42', 'instruction', 'Please report your progress');
INSERT INTO messages (id, from_agent, to_agent, type, content)
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

# Test 5: Only marks retrieved IDs as read (not blanket)
echo ""
echo "Test 5: Targeted read-marking"
DB5="$TMPDIR/test5.db"
sqlite3 "$DB5" "
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_id TEXT,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT (datetime('now', '+72 hours'))
);
PRAGMA journal_mode=WAL;
INSERT INTO messages (id, from_agent, to_agent, type, content)
  VALUES ('msg-a', 'lead', 'exec-99', 'instruction', 'First instruction');
INSERT INTO messages (id, from_agent, to_agent, type, content)
  VALUES ('msg-b', 'lead', 'other-exec', 'instruction', 'For different runner');
"
FLYWHEEL_EXEC_ID="exec-99" FLYWHEEL_COMM_DB="$DB5" bash "$HOOK" > /dev/null 2>&1 || true

# msg-a should be marked read
READ_A=$(sqlite3 "$DB5" "SELECT read_at IS NOT NULL FROM messages WHERE id='msg-a';")
if [ "$READ_A" = "1" ]; then
  pass "msg-a (target) marked as read"
else
  fail "msg-a should be read" "read_at=$READ_A"
fi

# msg-b should still be unread (different exec-id)
READ_B=$(sqlite3 "$DB5" "SELECT read_at IS NULL FROM messages WHERE id='msg-b';")
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
sqlite3 "$DB7" "
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_id TEXT,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT (datetime('now', '+72 hours'))
);
PRAGMA journal_mode=WAL;
INSERT INTO messages (id, from_agent, to_agent, type, content)
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

# Summary
echo ""
echo "=========================="
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All tests passed!"
