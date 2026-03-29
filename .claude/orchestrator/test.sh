#!/usr/bin/env bash
# test.sh — Automated smoke tests for Flywheel orchestrator
# Usage: bash .claude/orchestrator/test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."

# Use a temporary DB for tests (not the real shared state)
export SHARED_STATE_DIR=$(mktemp -d)
export DB_PATH="$SHARED_STATE_DIR/agent-state.db"
export LOCK_DIR="$SHARED_STATE_DIR/locks"

source .claude/orchestrator/state.sh

PASS=0
FAIL=0

assert() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc (expected: '$expected', got: '$actual')"
        FAIL=$((FAIL + 1))
    fi
}

assert_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -q "$needle"; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc (expected to contain: '$needle')"
        FAIL=$((FAIL + 1))
    fi
}

assert_exit() {
    local desc="$1" expected_code="$2"
    shift 2
    set +e
    "$@" >/dev/null 2>&1
    local rc=$?
    set -e
    if [ "$rc" -eq "$expected_code" ]; then
        echo "  ✓ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $desc (expected exit $expected_code, got $rc)"
        FAIL=$((FAIL + 1))
    fi
}

cleanup() {
    rm -rf "$SHARED_STATE_DIR"
}
trap cleanup EXIT

# =========================================================================
echo "=== 1. Database Initialization ==="

init_db
tables=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('agents','step_templates','agent_steps','artifacts');")
assert "4 tables created" "4" "$tables"

template_count=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM step_templates WHERE agent_type='executor';")
assert "9 executor templates seeded" "9" "$template_count"

wal=$(sqlite3 "$DB_PATH" "PRAGMA journal_mode;")
assert "WAL mode enabled" "wal" "$wal"

# =========================================================================
echo ""
echo "=== 2. Agent Lifecycle ==="

create_agent "t-1" "executor" "v1.16.0" "test-slug" "GEO-901"
count=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM agents WHERE id='t-1';")
assert "Agent created" "1" "$count"

issue=$(sqlite3 "$DB_PATH" "SELECT issue_id FROM agents WHERE id='t-1';")
assert "issue_id stored" "GEO-901" "$issue"

status=$(sqlite3 "$DB_PATH" "SELECT status FROM agents WHERE id='t-1';")
assert "Initial status is spawned" "spawned" "$status"

update_agent_status "t-1" "running"
status=$(sqlite3 "$DB_PATH" "SELECT status FROM agents WHERE id='t-1';")
assert "Status updated to running" "running" "$status"

# =========================================================================
echo ""
echo "=== 3. set_agent_field Whitelist ==="

set_agent_field "t-1" "plan_file" "v1.16.0-GEO-901-test.md"
pf=$(sqlite3 "$DB_PATH" "SELECT plan_file FROM agents WHERE id='t-1';")
assert "plan_file set" "v1.16.0-GEO-901-test.md" "$pf"

set_agent_field "t-1" "branch" "feat/GEO-901-test"
set_agent_field "t-1" "worktree_path" "/tmp/flywheel-geo-901"
wt=$(sqlite3 "$DB_PATH" "SELECT worktree_path FROM agents WHERE id='t-1';")
assert "worktree_path set" "/tmp/flywheel-geo-901" "$wt"

assert_exit "Blocked: set status via set_agent_field" 1 set_agent_field "t-1" "status" "completed"
assert_exit "Blocked: set error_message via set_agent_field" 1 set_agent_field "t-1" "error_message" "hack"

# =========================================================================
echo ""
echo "=== 4. Duplicate Claim (issue_id UNIQUE) ==="

create_agent "t-2" "executor" "v1.16.0" "slug-a" "GEO-902"
set +e
create_agent "t-3" "executor" "v1.16.0" "slug-b" "GEO-902" 2>/dev/null
dup_rc=$?
set -e
assert "Duplicate issue_id rejected" "1" "$dup_rc"

dup_count=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM agents WHERE issue_id='GEO-902';")
assert "Only 1 agent for GEO-902" "1" "$dup_count"

# =========================================================================
echo ""
echo "=== 5. Step Tracking ==="

init_steps "t-1" "executor"
step_count=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM agent_steps WHERE agent_id='t-1';")
assert "9 steps initialized" "9" "$step_count"

start_step "t-1" "1"
s1_status=$(sqlite3 "$DB_PATH" "SELECT status FROM agent_steps WHERE agent_id='t-1' AND step_key='1';")
assert "Step 1 in_progress" "in_progress" "$s1_status"

complete_step "t-1" "1"
s1_status=$(sqlite3 "$DB_PATH" "SELECT status FROM agent_steps WHERE agent_id='t-1' AND step_key='1';")
assert "Step 1 completed" "completed" "$s1_status"

current=$(get_current_step "t-1")
assert_contains "Current step is 2" "2|Brainstorm" "$current"

skip_step "t-1" "2" "skipped for test"
current=$(get_current_step "t-1")
assert_contains "After skip, current is 3" "3|Research" "$current"

fail_step "t-1" "3" "test failure"
s3_status=$(sqlite3 "$DB_PATH" "SELECT status FROM agent_steps WHERE agent_id='t-1' AND step_key='3';")
assert "Step 3 failed" "failed" "$s3_status"

# =========================================================================
echo ""
echo "=== 6. Gate Chain ==="

# Step 2 is completed (skipped counts), step 1 is completed
assert_exit "Gate 2: PASS (step 1 completed)" 0 ./.claude/orchestrator/track.sh t-1 gate 2
# Step 3 is failed, so gate 4 should block
assert_exit "Gate 3: PASS (step 2 skipped counts as passed)" 0 ./.claude/orchestrator/track.sh t-1 gate 3
assert_exit "Gate 4: BLOCKED (step 3 failed, not completed/skipped)" 1 ./.claude/orchestrator/track.sh t-1 gate 4
# Step 7 gate requires step 6
assert_exit "Gate 7: BLOCKED (step 6 not completed)" 1 ./.claude/orchestrator/track.sh t-1 gate 7

# =========================================================================
echo ""
echo "=== 6b. Skip Enforcement ==="

# Step 2 (Brainstorm) can be skipped via track.sh
assert_exit "Skip step 2 allowed" 0 ./.claude/orchestrator/track.sh t-1 skip 2 "already explored"
# Step 3 (Research) can be skipped
assert_exit "Skip step 3 allowed" 0 ./.claude/orchestrator/track.sh t-1 skip 3 "already researched"
# Step 5 (Implement) CANNOT be skipped — mandatory
assert_exit "Skip step 5 blocked (mandatory)" 1 ./.claude/orchestrator/track.sh t-1 skip 5
# Step 6 (Ship) CANNOT be skipped — mandatory
assert_exit "Skip step 6 blocked (mandatory)" 1 ./.claude/orchestrator/track.sh t-1 skip 6

# =========================================================================
echo ""
echo "=== 7. Artifacts ==="

add_artifact "t-1" "exploration_doc" "doc/exploration/new/GEO-901-test.md"
add_artifact "t-1" "pr" "123" "merged"
add_artifact "t-1" "exploration_doc" "doc/exploration/new/GEO-901-test-v2.md"

val=$(get_artifact_value "t-1" "exploration_doc")
assert "get_artifact_value returns latest (by id DESC)" "doc/exploration/new/GEO-901-test-v2.md" "$val"

pr_val=$(get_artifact_value "t-1" "pr")
assert "PR artifact value" "123" "$pr_val"

# =========================================================================
echo ""
echo "=== 7b. Artifact-Critical ==="

# artifact-critical uses state_critical (fail-closed + retry)
./.claude/orchestrator/track.sh t-1 artifact-critical pr "456" "critical-merge"
crit_val=$(get_artifact_value "t-1" "pr")
assert "artifact-critical records value" "456" "$crit_val"

# =========================================================================
echo ""
echo "=== 8. Terminal State Immutability ==="

update_agent_status "t-1" "completed"
completed_at=$(sqlite3 "$DB_PATH" "SELECT completed_at FROM agents WHERE id='t-1';")
assert_contains "completed_at is set" "20" "$completed_at"

# Try to override terminal state
update_agent_status "t-1" "running"
status=$(sqlite3 "$DB_PATH" "SELECT status FROM agents WHERE id='t-1';")
assert "Terminal state immutable (still completed)" "completed" "$status"

# set_agent_field should not update terminal agent
set_agent_field "t-1" "plan_file" "should-not-change.md"
pf=$(sqlite3 "$DB_PATH" "SELECT plan_file FROM agents WHERE id='t-1';")
assert "set_agent_field blocked on terminal agent" "v1.16.0-GEO-901-test.md" "$pf"

# =========================================================================
echo ""
echo "=== 9. Lock ==="

acquire_lock "test-lock" "agent-1"
assert_exit "Second acquire blocked" 1 acquire_lock "test-lock" "agent-2"

holder=$(lock_holder "test-lock")
assert "Lock holder is agent-1" "agent-1" "$holder"

age=$(lock_age "test-lock")
# age should be 0 or 1 second
if [ "$age" -le 2 ]; then
    echo "  ✓ Lock age is recent ($age s)"
    PASS=$((PASS + 1))
else
    echo "  ✗ Lock age too old ($age s)"
    FAIL=$((FAIL + 1))
fi

release_lock "test-lock"
assert_exit "After release, can acquire again" 0 acquire_lock "test-lock" "agent-2"
release_lock "test-lock"

# =========================================================================
echo ""
echo "=== 10. Cleanup Idempotency ==="

# cleanup-agent.sh on already-completed agent (no worktree to remove)
./.claude/orchestrator/cleanup-agent.sh t-1 completed 2>/dev/null
status=$(sqlite3 "$DB_PATH" "SELECT status FROM agents WHERE id='t-1';")
assert "Cleanup on completed agent OK" "completed" "$status"

# Run cleanup again — should be idempotent
./.claude/orchestrator/cleanup-agent.sh t-1 completed 2>/dev/null
echo "  ✓ Second cleanup idempotent (no error)"
PASS=$((PASS + 1))

# =========================================================================
echo ""
echo "=== 11. Dashboard ==="

TEST_PORT=$((19000 + RANDOM % 1000))
python3 .claude/orchestrator/dashboard.py --db "$DB_PATH" --port "$TEST_PORT" &
DASH_PID=$!
sleep 1
dash_output=$(curl -s "http://localhost:$TEST_PORT/" 2>/dev/null || echo "FAILED")
kill $DASH_PID 2>/dev/null; wait $DASH_PID 2>/dev/null || true
assert_contains "Dashboard title" "Flywheel Orchestrator" "$dash_output"

# =========================================================================
echo ""
echo "=== 12. Queries ==="

active=$(list_active_agents)
# t-2 should be active (spawned), t-1 is completed
assert_contains "Active agents includes t-2" "t-2" "$active"

history=$(get_agent_history)
assert_contains "History includes t-1" "t-1" "$history"

# =========================================================================
echo ""
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "=========================================="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
