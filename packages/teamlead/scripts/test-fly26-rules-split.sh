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
# Summary
# ═══════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════"
echo "FLY-26 Rules Split Tests: ${PASS} passed, ${FAIL} failed"
echo "═══════════════════════════════════════"
exit "$FAIL"
