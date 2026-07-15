#!/bin/bash
# FLY-26: Tests for Lead agent rules splitting changes in claude-lead.sh.
# Tests identity.md priority, shared rule file sync (atomic replacement),
# and --append-system-prompt-file args construction.
# Run: bash packages/teamlead/scripts/test-fly26-rules-split.sh
set -euo pipefail

PASS=0; FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (expected '$2', got '$1')"
  fi
}
assert_contains() {
  if echo "$1" | grep -qF "$2"; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (expected to contain '$2')"
  fi
}
assert_not_contains() {
  if ! echo "$1" | grep -qF "$2"; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (expected NOT to contain '$2')"
  fi
}
assert_file_exists() {
  if [ -f "$1" ]; then
    PASS=$((PASS+1)); echo "  PASS: $2"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $2 (file not found: $1)"
  fi
}
assert_file_not_exists() {
  if [ ! -f "$1" ]; then
    PASS=$((PASS+1)); echo "  PASS: $2"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $2 (file should not exist: $1)"
  fi
}
assert_dir_not_exists() {
  if [ ! -d "$1" ]; then
    PASS=$((PASS+1)); echo "  PASS: $2"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $2 (dir should not exist: $1)"
  fi
}

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ═══════════════════════════════════════════════════════════════
# Test Group 1: Agent file source resolution (identity.md vs agent.md)
# ═══════════════════════════════════════════════════════════════
echo "=== Test Group 1: Agent file source resolution ==="

# Test 1.1: identity.md preferred over agent.md
echo "--- Test 1.1: identity.md preferred when both exist ---"
PROJECT="$TMPDIR/test-project-1"
mkdir -p "$PROJECT/.lead/product-lead"
echo "identity content" > "$PROJECT/.lead/product-lead/identity.md"
echo "agent content" > "$PROJECT/.lead/product-lead/agent.md"

# Simulate the resolution logic from claude-lead.sh
LEAD_ID="product-lead"
PROJECT_DIR="$PROJECT"
AGENT_SOURCE=""
if [ -n "${AGENT_SOURCE:-}" ]; then
  : # explicit override
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md"
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md"
fi
assert_contains "$AGENT_SOURCE" "identity.md" "identity.md preferred over agent.md"

# Test 1.2: agent.md used as fallback when identity.md missing
echo "--- Test 1.2: agent.md fallback when identity.md missing ---"
PROJECT="$TMPDIR/test-project-2"
mkdir -p "$PROJECT/.lead/ops-lead"
echo "agent content" > "$PROJECT/.lead/ops-lead/agent.md"

LEAD_ID="ops-lead"
PROJECT_DIR="$PROJECT"
AGENT_SOURCE=""
if [ -n "${AGENT_SOURCE:-}" ]; then
  :
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md"
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md"
fi
assert_contains "$AGENT_SOURCE" "agent.md" "agent.md used as fallback"

# Test 1.3: AGENT_SOURCE env var overrides both
echo "--- Test 1.3: AGENT_SOURCE env var takes priority ---"
PROJECT="$TMPDIR/test-project-3"
mkdir -p "$PROJECT/.lead/cos-lead"
echo "identity content" > "$PROJECT/.lead/cos-lead/identity.md"
echo "agent content" > "$PROJECT/.lead/cos-lead/agent.md"
echo "custom content" > "$TMPDIR/custom-agent.md"

LEAD_ID="cos-lead"
PROJECT_DIR="$PROJECT"
AGENT_SOURCE="$TMPDIR/custom-agent.md"
if [ -n "${AGENT_SOURCE:-}" ]; then
  :
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md"
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md"
fi
assert_contains "$AGENT_SOURCE" "custom-agent.md" "AGENT_SOURCE env var overrides"

# Test 1.4: Neither file exists → AGENT_SOURCE empty (fail-fast path)
echo "--- Test 1.4: Neither file exists → empty AGENT_SOURCE ---"
PROJECT="$TMPDIR/test-project-4"
mkdir -p "$PROJECT/.lead/new-lead"

LEAD_ID="new-lead"
PROJECT_DIR="$PROJECT"
AGENT_SOURCE=""
if [ -n "${AGENT_SOURCE:-}" ]; then
  :
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/identity.md"
elif [ -f "${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md" ]; then
  AGENT_SOURCE="${PROJECT_DIR}/.lead/${LEAD_ID}/agent.md"
fi
assert_eq "$AGENT_SOURCE" "" "AGENT_SOURCE empty when neither file exists"

# ═══════════════════════════════════════════════════════════════
# Test Group 2: Shared rule file sync (atomic replacement)
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Test Group 2: Shared rule file sync ==="

# Test 2.1: Normal sync — shared files copied atomically
echo "--- Test 2.1: Normal shared rule sync ---"
PROJECT="$TMPDIR/test-sync-1"
mkdir -p "$PROJECT/.lead/shared"
echo "# Common rules" > "$PROJECT/.lead/shared/common-rules.md"
echo "# Department rules" > "$PROJECT/.lead/shared/department-lead-rules.md"

SHARED_RULES_DIR="$PROJECT/.lead/shared"
LEAD_RULES_DIR="$TMPDIR/lead-rules-sync-1/product-lead"

# Run sync logic
if [ -d "$SHARED_RULES_DIR" ]; then
  mkdir -p "$(dirname "$LEAD_RULES_DIR")"
  LEAD_RULES_TMP=$(mktemp -d "${LEAD_RULES_DIR}.XXXXXX")
  SHARED_RULES_COUNT=0
  for rule_file in "$SHARED_RULES_DIR"/*.md; do
    [ -f "$rule_file" ] || continue
    rule_name=$(basename "$rule_file")
    cp "$rule_file" "${LEAD_RULES_TMP}/${rule_name}"
    SHARED_RULES_COUNT=$((SHARED_RULES_COUNT + 1))
  done
  if [ "$SHARED_RULES_COUNT" -gt 0 ]; then
    rm -rf "$LEAD_RULES_DIR"
    mv "$LEAD_RULES_TMP" "$LEAD_RULES_DIR"
  else
    rm -rf "$LEAD_RULES_TMP"
  fi
fi

assert_file_exists "$LEAD_RULES_DIR/common-rules.md" "common-rules.md copied"
assert_file_exists "$LEAD_RULES_DIR/department-lead-rules.md" "department-lead-rules.md copied"
assert_eq "$(cat "$LEAD_RULES_DIR/common-rules.md")" "# Common rules" "common-rules.md content correct"

# Test 2.2: Atomic replacement removes stale files
echo "--- Test 2.2: Atomic replacement removes stale files ---"
PROJECT="$TMPDIR/test-sync-2"
mkdir -p "$PROJECT/.lead/shared"
echo "# Common v2" > "$PROJECT/.lead/shared/common-rules.md"
# No department-lead-rules.md this time

LEAD_RULES_DIR="$TMPDIR/lead-rules-sync-2/product-lead"
mkdir -p "$LEAD_RULES_DIR"
echo "# Stale dept rules" > "$LEAD_RULES_DIR/department-lead-rules.md"
echo "# Stale common" > "$LEAD_RULES_DIR/common-rules.md"

SHARED_RULES_DIR="$PROJECT/.lead/shared"
if [ -d "$SHARED_RULES_DIR" ]; then
  mkdir -p "$(dirname "$LEAD_RULES_DIR")"
  LEAD_RULES_TMP=$(mktemp -d "${LEAD_RULES_DIR}.XXXXXX")
  SHARED_RULES_COUNT=0
  for rule_file in "$SHARED_RULES_DIR"/*.md; do
    [ -f "$rule_file" ] || continue
    rule_name=$(basename "$rule_file")
    cp "$rule_file" "${LEAD_RULES_TMP}/${rule_name}"
    SHARED_RULES_COUNT=$((SHARED_RULES_COUNT + 1))
  done
  if [ "$SHARED_RULES_COUNT" -gt 0 ]; then
    rm -rf "$LEAD_RULES_DIR"
    mv "$LEAD_RULES_TMP" "$LEAD_RULES_DIR"
  else
    rm -rf "$LEAD_RULES_TMP"
  fi
fi

assert_file_exists "$LEAD_RULES_DIR/common-rules.md" "common-rules.md exists after replace"
assert_file_not_exists "$LEAD_RULES_DIR/department-lead-rules.md" "stale dept rules removed by atomic replace"
assert_eq "$(cat "$LEAD_RULES_DIR/common-rules.md")" "# Common v2" "common-rules.md updated content"

# Test 2.3: No shared directory — graceful skip
echo "--- Test 2.3: No shared directory — graceful skip ---"
PROJECT="$TMPDIR/test-sync-3"
mkdir -p "$PROJECT/.lead/product-lead"
# No shared/ directory

SHARED_RULES_DIR="$PROJECT/.lead/shared"
LEAD_RULES_DIR="$TMPDIR/lead-rules-sync-3/product-lead"
SYNC_SKIPPED=0
if [ -d "$SHARED_RULES_DIR" ]; then
  : # would sync
else
  SYNC_SKIPPED=1
fi
assert_eq "$SYNC_SKIPPED" "1" "No shared dir → sync skipped gracefully"

# Test 2.4: Empty shared directory — no crash
echo "--- Test 2.4: Empty shared directory — no crash ---"
PROJECT="$TMPDIR/test-sync-4"
mkdir -p "$PROJECT/.lead/shared"
# No .md files in shared/

SHARED_RULES_DIR="$PROJECT/.lead/shared"
LEAD_RULES_DIR="$TMPDIR/lead-rules-sync-4/product-lead"
if [ -d "$SHARED_RULES_DIR" ]; then
  mkdir -p "$(dirname "$LEAD_RULES_DIR")"
  LEAD_RULES_TMP=$(mktemp -d "${LEAD_RULES_DIR}.XXXXXX")
  SHARED_RULES_COUNT=0
  for rule_file in "$SHARED_RULES_DIR"/*.md; do
    [ -f "$rule_file" ] || continue
    rule_name=$(basename "$rule_file")
    cp "$rule_file" "${LEAD_RULES_TMP}/${rule_name}"
    SHARED_RULES_COUNT=$((SHARED_RULES_COUNT + 1))
  done
  if [ "$SHARED_RULES_COUNT" -gt 0 ]; then
    rm -rf "$LEAD_RULES_DIR"
    mv "$LEAD_RULES_TMP" "$LEAD_RULES_DIR"
  else
    rm -rf "$LEAD_RULES_TMP"
  fi
fi
assert_eq "$SHARED_RULES_COUNT" "0" "Empty shared dir → 0 files staged"
assert_dir_not_exists "$LEAD_RULES_DIR" "No target dir created for 0 files"

# ═══════════════════════════════════════════════════════════════
# Test Group 3: --append-system-prompt-file args construction
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Test Group 3: --append-system-prompt-file args ==="

# Test 3.1: Peter loads both common + department rules
echo "--- Test 3.1: Peter loads common + department rules ---"
LEAD_RULES_DIR="$TMPDIR/args-test-1"
mkdir -p "$LEAD_RULES_DIR"
echo "# Common" > "$LEAD_RULES_DIR/common-rules.md"
echo "# Department" > "$LEAD_RULES_DIR/department-lead-rules.md"
LEAD_ID="product-lead"

CLAUDE_ARGS=(--agent "$LEAD_ID" --permission-mode bypassPermissions)
if [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ -f "$COMMON_RULES" ] && [ -r "$COMMON_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$COMMON_RULES")
  fi
  if [ "$LEAD_ID" != "cos-lead" ]; then
    DEPT_RULES="${LEAD_RULES_DIR}/department-lead-rules.md"
    if [ -f "$DEPT_RULES" ] && [ -r "$DEPT_RULES" ]; then
      CLAUDE_ARGS+=(--append-system-prompt-file "$DEPT_RULES")
    fi
  fi
fi

ARGS_STR="${CLAUDE_ARGS[*]}"
assert_contains "$ARGS_STR" "common-rules.md" "Peter gets common rules"
assert_contains "$ARGS_STR" "department-lead-rules.md" "Peter gets department rules"

# Test 3.2: Oliver loads both common + department rules
echo "--- Test 3.2: Oliver loads common + department rules ---"
LEAD_ID="ops-lead"
CLAUDE_ARGS=(--agent "$LEAD_ID" --permission-mode bypassPermissions)
if [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ -f "$COMMON_RULES" ] && [ -r "$COMMON_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$COMMON_RULES")
  fi
  if [ "$LEAD_ID" != "cos-lead" ]; then
    DEPT_RULES="${LEAD_RULES_DIR}/department-lead-rules.md"
    if [ -f "$DEPT_RULES" ] && [ -r "$DEPT_RULES" ]; then
      CLAUDE_ARGS+=(--append-system-prompt-file "$DEPT_RULES")
    fi
  fi
fi
ARGS_STR="${CLAUDE_ARGS[*]}"
assert_contains "$ARGS_STR" "common-rules.md" "Oliver gets common rules"
assert_contains "$ARGS_STR" "department-lead-rules.md" "Oliver gets department rules"

# Test 3.3: Simba loads ONLY common rules (no department)
echo "--- Test 3.3: Simba loads only common rules ---"
LEAD_ID="cos-lead"
CLAUDE_ARGS=(--agent "$LEAD_ID" --permission-mode bypassPermissions)
if [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ -f "$COMMON_RULES" ] && [ -r "$COMMON_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$COMMON_RULES")
  fi
  if [ "$LEAD_ID" != "cos-lead" ]; then
    DEPT_RULES="${LEAD_RULES_DIR}/department-lead-rules.md"
    if [ -f "$DEPT_RULES" ] && [ -r "$DEPT_RULES" ]; then
      CLAUDE_ARGS+=(--append-system-prompt-file "$DEPT_RULES")
    fi
  fi
fi
ARGS_STR="${CLAUDE_ARGS[*]}"
assert_contains "$ARGS_STR" "common-rules.md" "Simba gets common rules"
assert_not_contains "$ARGS_STR" "department-lead-rules.md" "Simba does NOT get department rules"

# Test 3.4: No LEAD_RULES_DIR → no append args (backward compat)
echo "--- Test 3.4: No rules dir → no append args ---"
LEAD_ID="product-lead"
LEAD_RULES_DIR="$TMPDIR/nonexistent-dir"
CLAUDE_ARGS=(--agent "$LEAD_ID" --permission-mode bypassPermissions)
if [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ -f "$COMMON_RULES" ] && [ -r "$COMMON_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$COMMON_RULES")
  fi
fi
ARGS_STR="${CLAUDE_ARGS[*]}"
assert_not_contains "$ARGS_STR" "append-system-prompt-file" "No rules dir → no append args"

# ═══════════════════════════════════════════════════════════════
# Test Group 4: Stale cache cleanup
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Test Group 4: Stale cache cleanup ==="

# Test 4.1: Stale cache cleaned when shared dir disappears
echo "--- Test 4.1: Stale cache cleaned when source dir disappears ---"
PROJECT="$TMPDIR/test-stale-1"
mkdir -p "$PROJECT/.lead/product-lead"
# No .lead/shared/ directory — simulates rollback/branch switch

LEAD_RULES_DIR="$TMPDIR/stale-cache-1/product-lead"
mkdir -p "$LEAD_RULES_DIR"
echo "# Old common" > "$LEAD_RULES_DIR/common-rules.md"
echo "# Old dept" > "$LEAD_RULES_DIR/department-lead-rules.md"

SHARED_RULES_DIR="$PROJECT/.lead/shared"
if [ -d "$SHARED_RULES_DIR" ]; then
  : # would sync
else
  if [ -d "$LEAD_RULES_DIR" ]; then
    rm -rf "$LEAD_RULES_DIR"
  fi
fi

assert_dir_not_exists "$LEAD_RULES_DIR" "Stale cache removed when source dir gone"

# Test 4.2: Stale cache NOT cleaned when shared dir exists
echo "--- Test 4.2: Cache preserved when source dir exists ---"
PROJECT="$TMPDIR/test-stale-2"
mkdir -p "$PROJECT/.lead/shared"
echo "# Fresh" > "$PROJECT/.lead/shared/common-rules.md"

LEAD_RULES_DIR="$TMPDIR/stale-cache-2/product-lead"
mkdir -p "$LEAD_RULES_DIR"
echo "# Will be replaced" > "$LEAD_RULES_DIR/common-rules.md"

SHARED_RULES_DIR="$PROJECT/.lead/shared"
if [ -d "$SHARED_RULES_DIR" ]; then
  mkdir -p "$(dirname "$LEAD_RULES_DIR")"
  LEAD_RULES_TMP=$(mktemp -d "${LEAD_RULES_DIR}.XXXXXX")
  SHARED_RULES_COUNT=0
  for rule_file in "$SHARED_RULES_DIR"/*.md; do
    [ -f "$rule_file" ] || continue
    rule_name=$(basename "$rule_file")
    cp "$rule_file" "${LEAD_RULES_TMP}/${rule_name}"
    SHARED_RULES_COUNT=$((SHARED_RULES_COUNT + 1))
  done
  if [ "$SHARED_RULES_COUNT" -gt 0 ]; then
    rm -rf "$LEAD_RULES_DIR"
    mv "$LEAD_RULES_TMP" "$LEAD_RULES_DIR"
  else
    rm -rf "$LEAD_RULES_TMP"
  fi
fi

assert_file_exists "$LEAD_RULES_DIR/common-rules.md" "Cache replaced with fresh content"
assert_eq "$(cat "$LEAD_RULES_DIR/common-rules.md")" "# Fresh" "Content is fresh, not stale"

# Test 4.3: Stale cache cleaned when shared dir exists but is empty
echo "--- Test 4.3: Stale cache cleaned when shared dir empty ---"
PROJECT="$TMPDIR/test-stale-3"
mkdir -p "$PROJECT/.lead/shared"
# Empty shared dir — no .md files

LEAD_RULES_DIR="$TMPDIR/stale-cache-3/product-lead"
mkdir -p "$LEAD_RULES_DIR"
echo "# Old stale common" > "$LEAD_RULES_DIR/common-rules.md"

SHARED_RULES_DIR="$PROJECT/.lead/shared"
if [ -d "$SHARED_RULES_DIR" ]; then
  mkdir -p "$(dirname "$LEAD_RULES_DIR")"
  LEAD_RULES_TMP=$(mktemp -d "${LEAD_RULES_DIR}.XXXXXX")
  SHARED_RULES_COUNT=0
  for rule_file in "$SHARED_RULES_DIR"/*.md; do
    [ -f "$rule_file" ] || continue
    rule_name=$(basename "$rule_file")
    cp "$rule_file" "${LEAD_RULES_TMP}/${rule_name}"
    SHARED_RULES_COUNT=$((SHARED_RULES_COUNT + 1))
  done
  if [ "$SHARED_RULES_COUNT" -gt 0 ]; then
    rm -rf "$LEAD_RULES_DIR"
    mv "$LEAD_RULES_TMP" "$LEAD_RULES_DIR"
  else
    rm -rf "$LEAD_RULES_TMP"
    # Empty shared dir: also clean stale cache
    if [ -d "$LEAD_RULES_DIR" ]; then
      rm -rf "$LEAD_RULES_DIR"
    fi
  fi
fi
assert_dir_not_exists "$LEAD_RULES_DIR" "Stale cache removed when shared dir empty"

# ═══════════════════════════════════════════════════════════════
# Test Group 5: Fail-fast on missing required files
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Test Group 5: Fail-fast on missing required files ==="

# Test 5.1: LEAD_RULES_DIR exists but common-rules.md missing → should fail
echo "--- Test 5.1: Missing common-rules.md → fail-fast ---"
LEAD_RULES_DIR="$TMPDIR/fail-fast-1"
mkdir -p "$LEAD_RULES_DIR"
# No common-rules.md inside

LEAD_ID="product-lead"
SHARED_RULES_DIR="$TMPDIR/dummy-shared"
FAILED=0
if [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ ! -f "$COMMON_RULES" ] || [ ! -r "$COMMON_RULES" ]; then
    FAILED=1
  fi
fi
assert_eq "$FAILED" "1" "Missing common-rules.md triggers fail-fast"

# Test 5.2: common-rules.md exists but dept-rules.md missing (Peter) → should fail
echo "--- Test 5.2: Missing dept-rules.md for Peter → fail-fast ---"
LEAD_RULES_DIR="$TMPDIR/fail-fast-2"
mkdir -p "$LEAD_RULES_DIR"
echo "# Common" > "$LEAD_RULES_DIR/common-rules.md"
# No department-lead-rules.md

LEAD_ID="product-lead"
FAILED=0
if [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ ! -f "$COMMON_RULES" ] || [ ! -r "$COMMON_RULES" ]; then
    FAILED=1
  fi
  if [ "$LEAD_ID" != "cos-lead" ]; then
    DEPT_RULES="${LEAD_RULES_DIR}/department-lead-rules.md"
    if [ ! -f "$DEPT_RULES" ] || [ ! -r "$DEPT_RULES" ]; then
      FAILED=1
    fi
  fi
fi
assert_eq "$FAILED" "1" "Missing dept-rules.md for Peter triggers fail-fast"

# Test 5.3: Missing dept-rules.md for Simba → should NOT fail (Simba doesn't need it)
echo "--- Test 5.3: Missing dept-rules.md for Simba → OK ---"
LEAD_RULES_DIR="$TMPDIR/fail-fast-3"
mkdir -p "$LEAD_RULES_DIR"
echo "# Common" > "$LEAD_RULES_DIR/common-rules.md"
# No department-lead-rules.md

LEAD_ID="cos-lead"
FAILED=0
if [ -d "$LEAD_RULES_DIR" ]; then
  COMMON_RULES="${LEAD_RULES_DIR}/common-rules.md"
  if [ ! -f "$COMMON_RULES" ] || [ ! -r "$COMMON_RULES" ]; then
    FAILED=1
  fi
  if [ "$LEAD_ID" != "cos-lead" ]; then
    DEPT_RULES="${LEAD_RULES_DIR}/department-lead-rules.md"
    if [ ! -f "$DEPT_RULES" ] || [ ! -r "$DEPT_RULES" ]; then
      FAILED=1
    fi
  fi
fi
assert_eq "$FAILED" "0" "Missing dept-rules.md OK for Simba (doesn't need it)"

# ═══════════════════════════════════════════════════════════════
# Test Group 6 (FLY-127 R3): flywheel BASE rules layered before PROJECT rules
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Test Group 6 (FLY-127 R3): base layer ordering ==="

# Helper: simulate the relevant slice of claude-lead.sh's append logic
# (the BASE block from FLY-127 R3 + the existing PROJECT block from FLY-26).
# Returns the joined CLAUDE_ARGS string. Inputs:
#   $1: BASE_RULES_DIR (path to flywheel base, may be missing)
#   $2: LEAD_RULES_DIR (path to project shared, may be missing)
#   $3: LEAD_ID (or set FLYWHEEL_LEAD_ROLE externally for test slots)
simulate_append_logic() {
  local base_dir="$1"
  local lead_rules_dir="$2"
  local lead_id="$3"
  local inbox_ack_path="${4:-}"

  CLAUDE_ARGS=(--agent "$lead_id" --permission-mode bypassPermissions)

  # Detect cos role early (matches claude-lead.sh)
  IS_COS_ROLE=false
  if [ "${FLYWHEEL_LEAD_ROLE:-}" = "cos" ] || [ "$lead_id" = "cos-lead" ]; then
    IS_COS_ROLE=true
  fi

  # FLY-109: inbox-ack-rule (flywheel single-source, conditional on inbox-mcp).
  # Optional in this test simulator — caller passes path when it wants to
  # verify the full chain ordering (Test 6.6).
  if [ -n "$inbox_ack_path" ] && [ -f "$inbox_ack_path" ] && [ -r "$inbox_ack_path" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$inbox_ack_path")
  fi

  # FLY-127 R3 BASE block (loaded BEFORE project — extension semantics)
  if [ "$IS_COS_ROLE" = false ]; then
    BASE_DEPT_RULES="${base_dir}/department-lead-rules.md"
    if [ -f "$BASE_DEPT_RULES" ] && [ -r "$BASE_DEPT_RULES" ]; then
      CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_DEPT_RULES")
    fi
    # FLY-178: executor-routing (non-cos only — spawn-only behavior). In
    # production claude-lead.sh interposes the CONDITIONAL runner-messaging-
    # rules.md between dept-rules and this append; the simulator omits that
    # optional file. executor-routing loads independent of the messaging
    # backend, so its position relative to founder-only / project (asserted
    # in Tests 6.15) is unaffected by that omission.
    BASE_EXECUTOR_ROUTING_RULES="${base_dir}/executor-routing.md"
    if [ -f "$BASE_EXECUTOR_ROUTING_RULES" ] && [ -r "$BASE_EXECUTOR_ROUTING_RULES" ]; then
      CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_EXECUTOR_ROUTING_RULES")
    fi
  else
    BASE_COS_RULES="${base_dir}/cos-lead-rules.md"
    if [ -f "$BASE_COS_RULES" ] && [ -r "$BASE_COS_RULES" ]; then
      CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_COS_RULES")
    fi
  fi

  # FLY-175: founder-only authority (universal — both cos and dept roles)
  # Loaded AFTER the role-specific base files so this rule appears late
  # enough in the prompt to dominate adjacent content. Optional — missing
  # base file is a no-op (pre-FLY-175 backward compat).
  BASE_FOUNDER_AUTH_RULES="${base_dir}/founder-only-authority.md"
  BASE_HTML_DELIVERY_RULES="${base_dir}/founder-html-delivery.md"
  BASE_CROSS_DEPT_RULES="${base_dir}/cross-dept-channel-rules.md"
  if [ -f "$BASE_FOUNDER_AUTH_RULES" ] && [ -r "$BASE_FOUNDER_AUTH_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_FOUNDER_AUTH_RULES")
  fi

  # FLY-203: founder-html-delivery rules (universal, mirrors claude-lead.sh)
  if [ -f "$BASE_HTML_DELIVERY_RULES" ] && [ -r "$BASE_HTML_DELIVERY_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_HTML_DELIVERY_RULES")
  fi

  # FLY-223: cross-dept-channel rules (universal, mirrors claude-lead.sh)
  if [ -f "$BASE_CROSS_DEPT_RULES" ] && [ -r "$BASE_CROSS_DEPT_RULES" ]; then
    CLAUDE_ARGS+=(--append-system-prompt-file "$BASE_CROSS_DEPT_RULES")
  fi

  # FLY-26 PROJECT block (loaded AFTER base)
  if [ -d "$lead_rules_dir" ]; then
    COMMON_RULES="${lead_rules_dir}/common-rules.md"
    if [ -f "$COMMON_RULES" ] && [ -r "$COMMON_RULES" ]; then
      CLAUDE_ARGS+=(--append-system-prompt-file "$COMMON_RULES")
    fi
    if [ "$IS_COS_ROLE" = false ]; then
      DEPT_RULES="${lead_rules_dir}/department-lead-rules.md"
      if [ -f "$DEPT_RULES" ] && [ -r "$DEPT_RULES" ]; then
        CLAUDE_ARGS+=(--append-system-prompt-file "$DEPT_RULES")
      fi
    fi
  fi

  echo "${CLAUDE_ARGS[*]}"
}

# Test 6.1: dept Lead — base file appended BEFORE project file
echo "--- Test 6.1: dept Lead — BASE before PROJECT (department-lead-rules.md) ---"
BASE_DIR_61="$TMPDIR/base-61"
PROJECT_DIR_61="$TMPDIR/project-61"
mkdir -p "$BASE_DIR_61" "$PROJECT_DIR_61"
echo "# BASE department rules" > "$BASE_DIR_61/department-lead-rules.md"
echo "# Common" > "$PROJECT_DIR_61/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_61/department-lead-rules.md"
ARGS_61=$(simulate_append_logic "$BASE_DIR_61" "$PROJECT_DIR_61" "product-lead")
# Both should be present
assert_contains "$ARGS_61" "$BASE_DIR_61/department-lead-rules.md" "Test 6.1: BASE dept rules appended"
assert_contains "$ARGS_61" "$PROJECT_DIR_61/department-lead-rules.md" "Test 6.1: PROJECT dept rules appended"
# Order check: base index < project index in the args string
BASE_POS_61=$(echo "$ARGS_61" | grep -bo "$BASE_DIR_61/department-lead-rules.md" | head -1 | cut -d: -f1)
PROJ_POS_61=$(echo "$ARGS_61" | grep -bo "$PROJECT_DIR_61/department-lead-rules.md" | head -1 | cut -d: -f1)
if [ -n "$BASE_POS_61" ] && [ -n "$PROJ_POS_61" ] && [ "$BASE_POS_61" -lt "$PROJ_POS_61" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.1: BASE precedes PROJECT in args order ($BASE_POS_61 < $PROJ_POS_61)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.1: BASE precedes PROJECT (BASE=$BASE_POS_61 PROJECT=$PROJ_POS_61)"
fi

# Test 6.2: cos-lead — base cos-lead-rules.md appended; no dept base
echo "--- Test 6.2: cos-lead — BASE cos-lead-rules appended, no dept base ---"
BASE_DIR_62="$TMPDIR/base-62"
PROJECT_DIR_62="$TMPDIR/project-62"
mkdir -p "$BASE_DIR_62" "$PROJECT_DIR_62"
echo "# BASE cos rules" > "$BASE_DIR_62/cos-lead-rules.md"
echo "# BASE department rules" > "$BASE_DIR_62/department-lead-rules.md"
echo "# Common" > "$PROJECT_DIR_62/common-rules.md"
ARGS_62=$(simulate_append_logic "$BASE_DIR_62" "$PROJECT_DIR_62" "cos-lead")
assert_contains "$ARGS_62" "$BASE_DIR_62/cos-lead-rules.md" "Test 6.2: cos-lead gets BASE cos rules"
assert_not_contains "$ARGS_62" "$BASE_DIR_62/department-lead-rules.md" "Test 6.2: cos-lead does NOT get BASE dept rules"

# Test 6.3: backward compat — missing BASE files → no failure, project-only behavior
echo "--- Test 6.3: missing BASE dir → project-only behavior (backward compat) ---"
BASE_DIR_63="$TMPDIR/nonexistent-base-63"
PROJECT_DIR_63="$TMPDIR/project-63"
mkdir -p "$PROJECT_DIR_63"
echo "# Common" > "$PROJECT_DIR_63/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_63/department-lead-rules.md"
ARGS_63=$(simulate_append_logic "$BASE_DIR_63" "$PROJECT_DIR_63" "product-lead")
assert_contains "$ARGS_63" "$PROJECT_DIR_63/department-lead-rules.md" "Test 6.3: PROJECT rules still appended"
assert_not_contains "$ARGS_63" "$BASE_DIR_63" "Test 6.3: missing BASE silently skipped"

# Test 6.4: FLYWHEEL_LEAD_ROLE=cos test slot also gets BASE cos-lead-rules
echo "--- Test 6.4: test slot (FLYWHEEL_LEAD_ROLE=cos, synthetic LEAD_ID) → cos base ---"
BASE_DIR_64="$TMPDIR/base-64"
PROJECT_DIR_64="$TMPDIR/project-64"
mkdir -p "$BASE_DIR_64" "$PROJECT_DIR_64"
echo "# BASE cos rules" > "$BASE_DIR_64/cos-lead-rules.md"
echo "# Common" > "$PROJECT_DIR_64/common-rules.md"
FLYWHEEL_LEAD_ROLE=cos
ARGS_64=$(simulate_append_logic "$BASE_DIR_64" "$PROJECT_DIR_64" "flywheel-test-1")
unset FLYWHEEL_LEAD_ROLE
assert_contains "$ARGS_64" "$BASE_DIR_64/cos-lead-rules.md" "Test 6.4: synthetic test slot in cos role gets BASE cos rules"

# Test 6.5: FLYWHEEL_LEAD_ROLE=lead test slot gets BASE department-lead-rules
echo "--- Test 6.5: test slot (FLYWHEEL_LEAD_ROLE=lead, synthetic LEAD_ID) → dept base ---"
BASE_DIR_65="$TMPDIR/base-65"
PROJECT_DIR_65="$TMPDIR/project-65"
mkdir -p "$BASE_DIR_65" "$PROJECT_DIR_65"
echo "# BASE department rules" > "$BASE_DIR_65/department-lead-rules.md"
echo "# Common" > "$PROJECT_DIR_65/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_65/department-lead-rules.md"
FLYWHEEL_LEAD_ROLE=lead
ARGS_65=$(simulate_append_logic "$BASE_DIR_65" "$PROJECT_DIR_65" "flywheel-test-2")
unset FLYWHEEL_LEAD_ROLE
assert_contains "$ARGS_65" "$BASE_DIR_65/department-lead-rules.md" "Test 6.5: synthetic test slot in lead role gets BASE dept rules"
assert_contains "$ARGS_65" "$PROJECT_DIR_65/department-lead-rules.md" "Test 6.5: PROJECT dept rules also appended"

# Test 6.6 (Codex round 1): full chain ordering
#   inbox-ack < BASE dept-rules < PROJECT common-rules < PROJECT dept-rules
echo "--- Test 6.6: full chain ordering inbox-ack < BASE < project-common < project-dept ---"
BASE_DIR_66="$TMPDIR/base-66"
PROJECT_DIR_66="$TMPDIR/project-66"
INBOX_ACK_66="$TMPDIR/inbox-ack-66.md"
mkdir -p "$BASE_DIR_66" "$PROJECT_DIR_66"
echo "# inbox-ack stub" > "$INBOX_ACK_66"
echo "# BASE dept rules" > "$BASE_DIR_66/department-lead-rules.md"
echo "# PROJECT common rules" > "$PROJECT_DIR_66/common-rules.md"
echo "# PROJECT dept rules" > "$PROJECT_DIR_66/department-lead-rules.md"
ARGS_66=$(simulate_append_logic "$BASE_DIR_66" "$PROJECT_DIR_66" "product-lead" "$INBOX_ACK_66")
INBOX_POS=$(echo "$ARGS_66" | grep -bo "$INBOX_ACK_66" | head -1 | cut -d: -f1)
BASE_POS=$(echo "$ARGS_66"  | grep -bo "$BASE_DIR_66/department-lead-rules.md"     | head -1 | cut -d: -f1)
PCOM_POS=$(echo "$ARGS_66"  | grep -bo "$PROJECT_DIR_66/common-rules.md"           | head -1 | cut -d: -f1)
PDEP_POS=$(echo "$ARGS_66"  | grep -bo "$PROJECT_DIR_66/department-lead-rules.md"  | head -1 | cut -d: -f1)
if [ -n "$INBOX_POS" ] && [ -n "$BASE_POS" ] && [ "$INBOX_POS" -lt "$BASE_POS" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.6: inbox-ack < BASE ($INBOX_POS < $BASE_POS)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.6: inbox-ack < BASE (inbox=$INBOX_POS BASE=$BASE_POS)"
fi
if [ -n "$BASE_POS" ] && [ -n "$PCOM_POS" ] && [ "$BASE_POS" -lt "$PCOM_POS" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.6: BASE < project-common ($BASE_POS < $PCOM_POS)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.6: BASE < project-common (BASE=$BASE_POS PCOM=$PCOM_POS)"
fi
if [ -n "$PCOM_POS" ] && [ -n "$PDEP_POS" ] && [ "$PCOM_POS" -lt "$PDEP_POS" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.6: project-common < project-dept ($PCOM_POS < $PDEP_POS)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.6: project-common < project-dept (PCOM=$PCOM_POS PDEP=$PDEP_POS)"
fi

# Test 6.7 (Codex round 1): generic-voice scan — base files must NOT contain
# project-specific names or hardcoded Discord IDs. Lives in flywheel base —
# anyone editing should see this fail loudly if they leak project data.
echo "--- Test 6.7: generic-voice scan — base files contain no project-specific names or hardcoded IDs ---"
BASE_FILES_DIR="$(cd "$(dirname "$0")/../lead-rules-base" && pwd)"
if [ ! -d "$BASE_FILES_DIR" ]; then
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.7 setup: base dir not found at $BASE_FILES_DIR"
else
  # Scan the rule files only (not README.md which legitimately documents
  # examples of project-side concrete data). FLY-175: include
  # founder-only-authority.md so its generic voice is enforced as well.
  # FLY-223: cross-dept-channel-rules.md is DELIBERATELY excluded — it is the
  # deployment-global cross-department roster (concrete Lead names + bot IDs by
  # design, since the #leads-roundtable channel spans projects and has no
  # per-project layer to instantiate it). Adding it here would fail by design;
  # its extensibility contract (add-a-Lead = one roster row) lives in that file.
  RULE_FILES=("$BASE_FILES_DIR/department-lead-rules.md" "$BASE_FILES_DIR/cos-lead-rules.md" "$BASE_FILES_DIR/founder-only-authority.md" "$BASE_FILES_DIR/executor-routing.md" "$BASE_FILES_DIR/founder-html-delivery.md")
  # Names that should never appear in base rule files (examples of project
  # concretes that belong in the project layer).
  FORBIDDEN_NAMES_RE='\b(Peter|Oliver|Simba|Annie)\b'
  # Hardcoded Discord IDs (17-20 digit @-mentions or bare 17-20 digit IDs)
  FORBIDDEN_IDS_RE='<@[0-9]{17,20}>|"id":\s*"?[0-9]{17,20}"?'
  any_name_leak=false
  any_id_leak=false
  for rf in "${RULE_FILES[@]}"; do
    if [ -f "$rf" ]; then
      if grep -qE "$FORBIDDEN_NAMES_RE" "$rf"; then any_name_leak=true; fi
      if grep -qE "$FORBIDDEN_IDS_RE" "$rf"; then any_id_leak=true; fi
    fi
  done
  if [ "$any_name_leak" = false ]; then
    PASS=$((PASS+1)); echo "  PASS: Test 6.7: base rule files contain no project-specific names (Peter/Oliver/Simba/Annie)"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: Test 6.7: base rule files leak project-specific names. Run: grep -nE '$FORBIDDEN_NAMES_RE' ${RULE_FILES[*]}"
  fi
  if [ "$any_id_leak" = false ]; then
    PASS=$((PASS+1)); echo "  PASS: Test 6.7: base rule files contain no hardcoded Discord IDs (17-20 digit)"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: Test 6.7: base rule files leak hardcoded Discord IDs. Run: grep -nE '$FORBIDDEN_IDS_RE' ${RULE_FILES[*]}"
  fi
fi

# Test 6.8 (FLY-175): founder-only-authority.md MUST load for BOTH cos and
# dept roles. This rule is universal — any Lead with Bridge action
# credentials could otherwise call /api/actions/approve or close-tmux.
echo "--- Test 6.8: FLY-175 founder-only-authority loads for BOTH cos and dept roles ---"
BASE_DIR_68="$TMPDIR/base-68"
PROJECT_DIR_68="$TMPDIR/project-68"
mkdir -p "$BASE_DIR_68" "$PROJECT_DIR_68"
echo "# BASE dept rules" > "$BASE_DIR_68/department-lead-rules.md"
echo "# BASE cos rules" > "$BASE_DIR_68/cos-lead-rules.md"
echo "# BASE founder-only-authority" > "$BASE_DIR_68/founder-only-authority.md"
echo "# Common" > "$PROJECT_DIR_68/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_68/department-lead-rules.md"
# Dept Lead loads founder-only-authority
ARGS_68_DEPT=$(simulate_append_logic "$BASE_DIR_68" "$PROJECT_DIR_68" "product-lead")
assert_contains "$ARGS_68_DEPT" "$BASE_DIR_68/founder-only-authority.md" "Test 6.8: dept Lead loads founder-only-authority"
# Cos-lead loads founder-only-authority
ARGS_68_COS=$(simulate_append_logic "$BASE_DIR_68" "$PROJECT_DIR_68" "cos-lead")
assert_contains "$ARGS_68_COS" "$BASE_DIR_68/founder-only-authority.md" "Test 6.8: cos-lead loads founder-only-authority"
# Test slot (synthetic LEAD_ID, FLYWHEEL_LEAD_ROLE=lead) loads it
FLYWHEEL_LEAD_ROLE=lead
ARGS_68_SLOT_LEAD=$(simulate_append_logic "$BASE_DIR_68" "$PROJECT_DIR_68" "flywheel-test-2")
unset FLYWHEEL_LEAD_ROLE
assert_contains "$ARGS_68_SLOT_LEAD" "$BASE_DIR_68/founder-only-authority.md" "Test 6.8: synthetic dept test slot loads founder-only-authority"
# Test slot (synthetic LEAD_ID, FLYWHEEL_LEAD_ROLE=cos) loads it
FLYWHEEL_LEAD_ROLE=cos
ARGS_68_SLOT_COS=$(simulate_append_logic "$BASE_DIR_68" "$PROJECT_DIR_68" "flywheel-test-1")
unset FLYWHEEL_LEAD_ROLE
assert_contains "$ARGS_68_SLOT_COS" "$BASE_DIR_68/founder-only-authority.md" "Test 6.8: synthetic cos test slot loads founder-only-authority"

# Test 6.9 (FLY-175): backward compat — missing founder-only-authority.md
# silently skipped (no failure, no warning). Preserves pre-FLY-175 behavior
# on older flywheel checkouts.
echo "--- Test 6.9: FLY-175 missing founder-only-authority.md silently skipped (backward compat) ---"
BASE_DIR_69="$TMPDIR/base-69"
PROJECT_DIR_69="$TMPDIR/project-69"
mkdir -p "$BASE_DIR_69" "$PROJECT_DIR_69"
echo "# BASE dept rules" > "$BASE_DIR_69/department-lead-rules.md"
# Intentionally NOT creating founder-only-authority.md
echo "# Common" > "$PROJECT_DIR_69/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_69/department-lead-rules.md"
ARGS_69=$(simulate_append_logic "$BASE_DIR_69" "$PROJECT_DIR_69" "product-lead")
assert_contains "$ARGS_69" "$BASE_DIR_69/department-lead-rules.md" "Test 6.9: dept rules still loaded when founder-auth missing"
assert_not_contains "$ARGS_69" "founder-only-authority.md" "Test 6.9: founder-only-authority silently skipped when absent"

# Test 6.10 (FLY-175): real base file ships with the repo and lives at
# the expected path. This guards against accidental deletion / rename.
echo "--- Test 6.10: FLY-175 real founder-only-authority.md ships in lead-rules-base ---"
REAL_BASE_DIR_610="$(cd "$(dirname "$0")/../lead-rules-base" && pwd)"
assert_file_exists "$REAL_BASE_DIR_610/founder-only-authority.md" "Test 6.10: founder-only-authority.md present in flywheel checkout"

# Test 6.11 (FLY-175, Codex Round 1 LOW): load order — founder-only-authority
# MUST appear AFTER role-specific base (department-lead-rules.md / cos-lead-
# rules.md) and BEFORE project-side common/dept rules. The prompt-stacking
# semantics is "later rule wins", so we want the universal founder rule late
# enough to dominate role-specific guidance but early enough that project
# layer (which adds concrete examples) can still extend it.
echo "--- Test 6.11: FLY-175 load order — role base < founder-only < project rules ---"
BASE_DIR_611="$TMPDIR/base-611"
PROJECT_DIR_611="$TMPDIR/project-611"
mkdir -p "$BASE_DIR_611" "$PROJECT_DIR_611"
echo "# BASE dept rules" > "$BASE_DIR_611/department-lead-rules.md"
echo "# BASE founder-only-authority" > "$BASE_DIR_611/founder-only-authority.md"
echo "# PROJECT common rules" > "$PROJECT_DIR_611/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_611/department-lead-rules.md"
ARGS_611=$(simulate_append_logic "$BASE_DIR_611" "$PROJECT_DIR_611" "product-lead")
DEPT_BASE_POS_611=$(echo "$ARGS_611" | grep -bo "$BASE_DIR_611/department-lead-rules.md" | head -1 | cut -d: -f1)
FOUNDER_POS_611=$(echo "$ARGS_611" | grep -bo "$BASE_DIR_611/founder-only-authority.md" | head -1 | cut -d: -f1)
PCOM_POS_611=$(echo "$ARGS_611" | grep -bo "$PROJECT_DIR_611/common-rules.md" | head -1 | cut -d: -f1)
PDEP_POS_611=$(echo "$ARGS_611" | grep -bo "$PROJECT_DIR_611/department-lead-rules.md" | head -1 | cut -d: -f1)
if [ -n "$DEPT_BASE_POS_611" ] && [ -n "$FOUNDER_POS_611" ] && [ "$DEPT_BASE_POS_611" -lt "$FOUNDER_POS_611" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.11: role base < founder-only-authority ($DEPT_BASE_POS_611 < $FOUNDER_POS_611)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.11: role base must precede founder-only-authority (role=$DEPT_BASE_POS_611 founder=$FOUNDER_POS_611)"
fi
if [ -n "$FOUNDER_POS_611" ] && [ -n "$PCOM_POS_611" ] && [ "$FOUNDER_POS_611" -lt "$PCOM_POS_611" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.11: founder-only-authority < project-common ($FOUNDER_POS_611 < $PCOM_POS_611)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.11: founder-only-authority must precede project-common (founder=$FOUNDER_POS_611 pcom=$PCOM_POS_611)"
fi
if [ -n "$FOUNDER_POS_611" ] && [ -n "$PDEP_POS_611" ] && [ "$FOUNDER_POS_611" -lt "$PDEP_POS_611" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.11: founder-only-authority < project-dept ($FOUNDER_POS_611 < $PDEP_POS_611)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.11: founder-only-authority must precede project-dept (founder=$FOUNDER_POS_611 pdep=$PDEP_POS_611)"
fi

# Test 6.12 (FLY-175, Codex Round 1 LOW): content sentinel — the shipped rule
# file must be non-empty and contain the canonical anchor heading. Guards
# against the file being accidentally emptied or replaced with placeholder.
echo "--- Test 6.12: FLY-175 founder-only-authority.md content sentinel ---"
REAL_FOUNDER_FILE_612="$REAL_BASE_DIR_610/founder-only-authority.md"
if [ -s "$REAL_FOUNDER_FILE_612" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.12: founder-only-authority.md is non-empty"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.12: founder-only-authority.md is empty or missing"
fi
if grep -q "# Founder-Only Authority" "$REAL_FOUNDER_FILE_612" 2>/dev/null; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.12: founder-only-authority.md has canonical anchor heading"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.12: founder-only-authority.md missing '# Founder-Only Authority' heading"
fi
# Sanity: reserved-action list must mention every callable endpoint that
# can end a Runner's life, at BOTH /api/actions/* AND /actions/* dashboard
# alias prefixes (plugin.ts mounts the same createActionRouter on both).
# Includes retry, which force-closes the prior preserved Runner via
# handleRetry() → closeRunner({forcePreserved:true}). Codex Round 1 HIGH
# fix (approve, terminate, reject, defer, shelve, close-tmux, close-runner)
# + Codex Round 2 HIGH fix (/actions/* aliases + retry) regression guards.
for keyword in \
  "/api/actions/approve" \
  "/api/actions/terminate" \
  "/api/actions/reject" \
  "/api/actions/defer" \
  "/api/actions/shelve" \
  "/api/actions/retry" \
  "/actions/approve" \
  "/actions/terminate" \
  "/actions/reject" \
  "/actions/defer" \
  "/actions/shelve" \
  "/actions/retry" \
  "close-tmux" \
  "close-runner" \
  ; do
  if grep -qF "$keyword" "$REAL_FOUNDER_FILE_612" 2>/dev/null; then
    PASS=$((PASS+1)); echo "  PASS: Test 6.12: founder-only-authority.md mentions reserved endpoint '$keyword'"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: Test 6.12: founder-only-authority.md must mention reserved endpoint '$keyword' so the Lead has no plausible-deniability gap"
  fi
done

# ═══════════════════════════════════════════════════════════════
# Test Group 6 (FLY-178): executor-routing.md base rule (non-cos only)
# ═══════════════════════════════════════════════════════════════
echo ""
echo "=== Test Group 6 (FLY-178): executor-routing base rule ==="

# Test 6.13: dept Lead gets executor-routing; cos-lead does NOT (spawn-only).
echo "--- Test 6.13: dept Lead gets executor-routing, cos-lead does NOT ---"
BASE_DIR_613="$TMPDIR/base-613"
PROJECT_DIR_613="$TMPDIR/project-613"
mkdir -p "$BASE_DIR_613" "$PROJECT_DIR_613"
echo "# BASE department rules" > "$BASE_DIR_613/department-lead-rules.md"
echo "# BASE cos rules" > "$BASE_DIR_613/cos-lead-rules.md"
echo "# BASE executor routing" > "$BASE_DIR_613/executor-routing.md"
echo "# Common" > "$PROJECT_DIR_613/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_613/department-lead-rules.md"
ARGS_613_DEPT=$(simulate_append_logic "$BASE_DIR_613" "$PROJECT_DIR_613" "product-lead")
assert_contains "$ARGS_613_DEPT" "$BASE_DIR_613/executor-routing.md" "Test 6.13: dept Lead gets executor-routing"
ARGS_613_COS=$(simulate_append_logic "$BASE_DIR_613" "$PROJECT_DIR_613" "cos-lead")
assert_not_contains "$ARGS_613_COS" "$BASE_DIR_613/executor-routing.md" "Test 6.13: cos-lead does NOT get executor-routing (cos never spawns Runners)"

# Test 6.14: backward compat — missing executor-routing.md silently skipped.
echo "--- Test 6.14: missing executor-routing.md silently skipped (backward compat) ---"
BASE_DIR_614="$TMPDIR/base-614"
PROJECT_DIR_614="$TMPDIR/project-614"
mkdir -p "$BASE_DIR_614" "$PROJECT_DIR_614"
echo "# BASE department rules" > "$BASE_DIR_614/department-lead-rules.md"
# Intentionally NOT creating executor-routing.md
echo "# Common" > "$PROJECT_DIR_614/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_614/department-lead-rules.md"
ARGS_614=$(simulate_append_logic "$BASE_DIR_614" "$PROJECT_DIR_614" "product-lead")
assert_contains "$ARGS_614" "$BASE_DIR_614/department-lead-rules.md" "Test 6.14: dept rules still loaded when executor-routing missing"
assert_not_contains "$ARGS_614" "executor-routing.md" "Test 6.14: executor-routing silently skipped when absent"

# Test 6.15: load order — role base < executor-routing < founder-only < project.
# (Production interposes the conditional runner-messaging-rules.md between role
# base and executor-routing; the simulator omits that optional file, which does
# not affect executor-routing's position relative to founder-only / project.)
echo "--- Test 6.15: load order — role base < executor-routing < founder-only < project ---"
BASE_DIR_615="$TMPDIR/base-615"
PROJECT_DIR_615="$TMPDIR/project-615"
mkdir -p "$BASE_DIR_615" "$PROJECT_DIR_615"
echo "# BASE department rules" > "$BASE_DIR_615/department-lead-rules.md"
echo "# BASE executor routing" > "$BASE_DIR_615/executor-routing.md"
echo "# BASE founder-only-authority" > "$BASE_DIR_615/founder-only-authority.md"
echo "# PROJECT common rules" > "$PROJECT_DIR_615/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_615/department-lead-rules.md"
ARGS_615=$(simulate_append_logic "$BASE_DIR_615" "$PROJECT_DIR_615" "product-lead")
DEPT_POS_615=$(echo "$ARGS_615" | grep -bo "$BASE_DIR_615/department-lead-rules.md" | head -1 | cut -d: -f1)
EXEC_POS_615=$(echo "$ARGS_615" | grep -bo "$BASE_DIR_615/executor-routing.md" | head -1 | cut -d: -f1)
FOUNDER_POS_615=$(echo "$ARGS_615" | grep -bo "$BASE_DIR_615/founder-only-authority.md" | head -1 | cut -d: -f1)
PDEP_POS_615=$(echo "$ARGS_615" | grep -bo "$PROJECT_DIR_615/department-lead-rules.md" | head -1 | cut -d: -f1)
if [ -n "$DEPT_POS_615" ] && [ -n "$EXEC_POS_615" ] && [ "$DEPT_POS_615" -lt "$EXEC_POS_615" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.15: role base < executor-routing ($DEPT_POS_615 < $EXEC_POS_615)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.15: role base must precede executor-routing (role=$DEPT_POS_615 exec=$EXEC_POS_615)"
fi
if [ -n "$EXEC_POS_615" ] && [ -n "$FOUNDER_POS_615" ] && [ "$EXEC_POS_615" -lt "$FOUNDER_POS_615" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.15: executor-routing < founder-only ($EXEC_POS_615 < $FOUNDER_POS_615)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.15: executor-routing must precede founder-only (exec=$EXEC_POS_615 founder=$FOUNDER_POS_615)"
fi
if [ -n "$FOUNDER_POS_615" ] && [ -n "$PDEP_POS_615" ] && [ "$FOUNDER_POS_615" -lt "$PDEP_POS_615" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.15: founder-only < project-dept ($FOUNDER_POS_615 < $PDEP_POS_615)"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.15: founder-only must precede project-dept (founder=$FOUNDER_POS_615 pdep=$PDEP_POS_615)"
fi

# Test 6.16: real base file ships + content sentinel (guards against deletion/rename/empty).
echo "--- Test 6.16: real executor-routing.md ships + content sentinel ---"
REAL_EXEC_FILE_616="$REAL_BASE_DIR_610/executor-routing.md"
assert_file_exists "$REAL_EXEC_FILE_616" "Test 6.16: executor-routing.md present in flywheel checkout"
if [ -s "$REAL_EXEC_FILE_616" ]; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.16: executor-routing.md is non-empty"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.16: executor-routing.md is empty or missing"
fi
if grep -q "# Executor Routing by Work Type" "$REAL_EXEC_FILE_616" 2>/dev/null; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.16: executor-routing.md has canonical anchor heading"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.16: executor-routing.md missing '# Executor Routing by Work Type' heading"
fi

# Test 6.17: test slots — FLYWHEEL_LEAD_ROLE=lead gets executor-routing; =cos does not.
echo "--- Test 6.17: test slots — lead role gets executor-routing, cos role does not ---"
BASE_DIR_617="$TMPDIR/base-617"
PROJECT_DIR_617="$TMPDIR/project-617"
mkdir -p "$BASE_DIR_617" "$PROJECT_DIR_617"
echo "# BASE department rules" > "$BASE_DIR_617/department-lead-rules.md"
echo "# BASE cos rules" > "$BASE_DIR_617/cos-lead-rules.md"
echo "# BASE executor routing" > "$BASE_DIR_617/executor-routing.md"
echo "# Common" > "$PROJECT_DIR_617/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_617/department-lead-rules.md"
FLYWHEEL_LEAD_ROLE=lead
ARGS_617_LEAD=$(simulate_append_logic "$BASE_DIR_617" "$PROJECT_DIR_617" "flywheel-test-2")
unset FLYWHEEL_LEAD_ROLE
assert_contains "$ARGS_617_LEAD" "$BASE_DIR_617/executor-routing.md" "Test 6.17: synthetic lead test slot gets executor-routing"
FLYWHEEL_LEAD_ROLE=cos
ARGS_617_COS=$(simulate_append_logic "$BASE_DIR_617" "$PROJECT_DIR_617" "flywheel-test-1")
unset FLYWHEEL_LEAD_ROLE
assert_not_contains "$ARGS_617_COS" "$BASE_DIR_617/executor-routing.md" "Test 6.17: synthetic cos test slot does NOT get executor-routing"

# ═══════════════════════════════════════════════════════════════
# Test 6.18 (FLY-203): founder-html-delivery.md — universal load for BOTH
# roles, silent skip when missing, ordered BEFORE project-side rules, and
# the SHIPPED file carries the canonical command + no-local-path anchors.
# ═══════════════════════════════════════════════════════════════
echo "--- Test 6.18: FLY-203 founder-html-delivery — both roles, missing-skip, ordering, content sentinel ---"
BASE_DIR_618="$TMPDIR/base-618"
PROJECT_DIR_618="$TMPDIR/project-618"
mkdir -p "$BASE_DIR_618" "$PROJECT_DIR_618"
echo "# BASE department rules" > "$BASE_DIR_618/department-lead-rules.md"
echo "# BASE cos rules" > "$BASE_DIR_618/cos-lead-rules.md"
echo "# BASE founder html delivery" > "$BASE_DIR_618/founder-html-delivery.md"
echo "# Common" > "$PROJECT_DIR_618/common-rules.md"
echo "# PROJECT department rules" > "$PROJECT_DIR_618/department-lead-rules.md"
ARGS_618_DEPT=$(simulate_append_logic "$BASE_DIR_618" "$PROJECT_DIR_618" "product-lead")
assert_contains "$ARGS_618_DEPT" "$BASE_DIR_618/founder-html-delivery.md" "Test 6.18: dept Lead loads founder-html-delivery"
ARGS_618_COS=$(simulate_append_logic "$BASE_DIR_618" "$PROJECT_DIR_618" "cos-lead")
assert_contains "$ARGS_618_COS" "$BASE_DIR_618/founder-html-delivery.md" "Test 6.18: cos-lead loads founder-html-delivery"
# Ordering: base html-delivery before project common rules (positional compare)
HTML_THEN_COMMON_618="${ARGS_618_DEPT#*founder-html-delivery.md}"
case "$HTML_THEN_COMMON_618" in
  *common-rules.md*)
    PASS=$((PASS+1)); echo "  PASS: Test 6.18: founder-html-delivery loads before project common rules" ;;
  *)
    FAIL=$((FAIL+1)); echo "  FAIL: Test 6.18: founder-html-delivery must load before project common rules" ;;
esac
# Backward compat: missing file silently skipped
rm "$BASE_DIR_618/founder-html-delivery.md"
ARGS_618_MISSING=$(simulate_append_logic "$BASE_DIR_618" "$PROJECT_DIR_618" "product-lead")
assert_not_contains "$ARGS_618_MISSING" "founder-html-delivery.md" "Test 6.18: missing founder-html-delivery silently skipped"
# Content sentinel on the SHIPPED file
SHIPPED_618="$BASE_FILES_DIR/founder-html-delivery.md"
if [ -f "$SHIPPED_618" ] && grep -q "flywheel-comm publish-report" "$SHIPPED_618" && grep -qi "Never post a local file path" "$SHIPPED_618"; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.18: shipped founder-html-delivery.md has canonical command + no-local-path anchors"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.18: shipped founder-html-delivery.md missing or lacks canonical anchors"
fi

# Test 6.19 (FLY-223): cross-dept-channel-rules.md is a UNIVERSAL base file —
# loads for BOTH cos and dept roles (every Lead is present in #leads-roundtable),
# a missing file is a silent no-op, and the shipped file carries the canonical
# anchors. Mirrors the founder-html-delivery (6.18) universal-block contract.
echo "--- Test 6.19: FLY-223 cross-dept-channel-rules loads for BOTH roles + no-op when missing ---"
BASE_DIR_619="$TMPDIR/base-619"
PROJECT_DIR_619="$TMPDIR/project-619"
mkdir -p "$BASE_DIR_619" "$PROJECT_DIR_619"
echo "# BASE dept rules" > "$BASE_DIR_619/department-lead-rules.md"
echo "# BASE cos rules" > "$BASE_DIR_619/cos-lead-rules.md"
echo "# BASE cross-dept" > "$BASE_DIR_619/cross-dept-channel-rules.md"
echo "# Common" > "$PROJECT_DIR_619/common-rules.md"
# dept role loads it
ARGS_619_DEPT=$(simulate_append_logic "$BASE_DIR_619" "$PROJECT_DIR_619" "product-lead")
assert_contains "$ARGS_619_DEPT" "$BASE_DIR_619/cross-dept-channel-rules.md" "Test 6.19: dept Lead loads cross-dept-channel rules"
# cos role loads it (the cos-lead Simba is in the cross-dept channel too)
ARGS_619_COS=$(simulate_append_logic "$BASE_DIR_619" "$PROJECT_DIR_619" "cos-lead")
assert_contains "$ARGS_619_COS" "$BASE_DIR_619/cross-dept-channel-rules.md" "Test 6.19: cos-lead loads cross-dept-channel rules"
# synthetic test slot (FLYWHEEL_LEAD_ROLE=cos) loads it
FLYWHEEL_LEAD_ROLE=cos
ARGS_619_SLOT=$(simulate_append_logic "$BASE_DIR_619" "$PROJECT_DIR_619" "flywheel-test-1")
unset FLYWHEEL_LEAD_ROLE
assert_contains "$ARGS_619_SLOT" "$BASE_DIR_619/cross-dept-channel-rules.md" "Test 6.19: synthetic cos test slot loads cross-dept-channel rules"
# missing file silently skipped (backward compat with older checkouts)
rm "$BASE_DIR_619/cross-dept-channel-rules.md"
ARGS_619_MISSING=$(simulate_append_logic "$BASE_DIR_619" "$PROJECT_DIR_619" "product-lead")
assert_not_contains "$ARGS_619_MISSING" "cross-dept-channel-rules.md" "Test 6.19: missing cross-dept-channel-rules silently skipped"
# shipped file present + content sentinel (guards against empty/rename)
SHIPPED_619="$BASE_FILES_DIR/cross-dept-channel-rules.md"
if [ -f "$SHIPPED_619" ] && grep -q "leads-roundtable" "$SHIPPED_619" && grep -qi "requireMention" "$SHIPPED_619"; then
  PASS=$((PASS+1)); echo "  PASS: Test 6.19: shipped cross-dept-channel-rules.md present with canonical anchors"
else
  FAIL=$((FAIL+1)); echo "  FAIL: Test 6.19: shipped cross-dept-channel-rules.md missing or lacks canonical anchors"
fi

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════"
echo "FLY-26 Rules Split Tests: ${PASS} passed, ${FAIL} failed"
echo "═══════════════════════════════════════"
exit "$FAIL"
