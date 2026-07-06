#!/bin/bash
# FLY-869: tests for claude-lead.sh's founder_ux_gate.mode default-resolution
# block (the shell-side mirror of resolveEffectiveFounderUxConfig).
#
# FLY-598 shipped this as an OPT-IN awk read: absent config / absent
# founder_ux_gate block / absent mode key all left FOUNDER_UX_MODE empty,
# which the old conditional `[ -n "$FOUNDER_UX_MODE" ] && [ "$FOUNDER_UX_MODE"
# != "off" ]` treated as "off" (no rule-file append). FLY-869 flips this so
# absent resolves to "enforce" (append), while an EXPLICIT `mode: off` stays
# the byte-compatible kill-switch (no append).
#
# This test extracts the EXACT awk command + shell defaulting logic from
# claude-lead.sh (copy-pasted verbatim into resolve_founder_ux_mode below,
# mirroring the established convention in test-fly26-rules-split.sh) and
# exercises it against synthetic .flywheel/config.yaml fixtures on bash 3.2
# (macOS default) semantics — no bash 4+ constructs.
#
# Run: bash packages/teamlead/scripts/__tests__/fly869-founder-ux-default-mode.test.sh

set -euo pipefail

PASS=0; FAIL=0
assert_eq() {
  if [ "$1" = "$2" ]; then
    PASS=$((PASS+1)); echo "  PASS: $3"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $3 (expected '$2', got '$1')"
  fi
}

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Verbatim mirror of the claude-lead.sh block (~line 1793-1819 post-FLY-869).
# Takes a project dir (containing .flywheel/config.yaml, or nothing) and
# echoes: "<FOUNDER_UX_MODE>|<APPENDED:0-or-1>"
resolve_founder_ux_mode() {
  local PROJECT_DIR="$1"
  local FOUNDER_UX_MODE=""
  local _founder_ux_cfg="${PROJECT_DIR}/.flywheel/config.yaml"
  if [ -f "$_founder_ux_cfg" ]; then
    FOUNDER_UX_MODE="$(awk '
      /^founder_ux_gate:/ { inblk=1; next }
      inblk && /^[^[:space:]]/ { inblk=0 }
      inblk && $1 == "mode:" { v=$2; gsub(/["'"'"',]/, "", v); print v; exit }
    ' "$_founder_ux_cfg" 2>/dev/null || true)"
  fi
  # FLY-869 default-resolution (the fix under test):
  if [ -z "$FOUNDER_UX_MODE" ]; then
    FOUNDER_UX_MODE="enforce"
  fi
  local appended=0
  if [ "$FOUNDER_UX_MODE" != "off" ]; then
    appended=1
  fi
  echo "${FOUNDER_UX_MODE}|${appended}"
}

echo "=== FLY-869 founder_ux_gate default-mode resolution ==="

# Test 1: no project dir / no .flywheel directory at all → enforce, appended.
echo "--- Test 1: no .flywheel dir at all -> enforce (appended) ---"
PROJECT_1="$TMPDIR/proj-1"
mkdir -p "$PROJECT_1"
RESULT_1=$(resolve_founder_ux_mode "$PROJECT_1")
assert_eq "$RESULT_1" "enforce|1" "Test 1: absent .flywheel dir resolves to enforce+appended"

# Test 2: config.yaml exists but has no founder_ux_gate block at all → enforce, appended.
echo "--- Test 2: config.yaml present, no founder_ux_gate block -> enforce (appended) ---"
PROJECT_2="$TMPDIR/proj-2"
mkdir -p "$PROJECT_2/.flywheel"
cat > "$PROJECT_2/.flywheel/config.yaml" <<'EOF'
project: test-project
linear:
  team_id: "TEAM-1"
EOF
RESULT_2=$(resolve_founder_ux_mode "$PROJECT_2")
assert_eq "$RESULT_2" "enforce|1" "Test 2: config without founder_ux_gate block resolves to enforce+appended"

# Test 3: founder_ux_gate block present but no mode key -> enforce, appended
# (mirrors a malformed/partial block; ConfigLoader would reject this at load
# time server-side, but the shell-side read must still fail toward enforce,
# never silently toward off).
echo "--- Test 3: founder_ux_gate block present, no mode key -> enforce (appended) ---"
PROJECT_3="$TMPDIR/proj-3"
mkdir -p "$PROJECT_3/.flywheel"
cat > "$PROJECT_3/.flywheel/config.yaml" <<'EOF'
project: test-project
founder_ux_gate:
  exempt_labels:
    - chore
EOF
RESULT_3=$(resolve_founder_ux_mode "$PROJECT_3")
assert_eq "$RESULT_3" "enforce|1" "Test 3: founder_ux_gate block without mode key resolves to enforce+appended"

# Test 4: EXPLICIT mode: off -> off, NOT appended (byte-compat kill-switch).
echo "--- Test 4: explicit mode: off -> off (NOT appended, byte-compat) ---"
PROJECT_4="$TMPDIR/proj-4"
mkdir -p "$PROJECT_4/.flywheel"
cat > "$PROJECT_4/.flywheel/config.yaml" <<'EOF'
project: test-project
founder_ux_gate:
  mode: off
EOF
RESULT_4=$(resolve_founder_ux_mode "$PROJECT_4")
assert_eq "$RESULT_4" "off|0" "Test 4: explicit mode:off resolves to off, not appended"

# Test 5: explicit mode: audit_only -> audit_only, appended (pre-existing behavior, unchanged).
echo "--- Test 5: explicit mode: audit_only -> audit_only (appended) ---"
PROJECT_5="$TMPDIR/proj-5"
mkdir -p "$PROJECT_5/.flywheel"
cat > "$PROJECT_5/.flywheel/config.yaml" <<'EOF'
project: test-project
founder_ux_gate:
  mode: audit_only
EOF
RESULT_5=$(resolve_founder_ux_mode "$PROJECT_5")
assert_eq "$RESULT_5" "audit_only|1" "Test 5: explicit mode:audit_only resolves to audit_only+appended (unchanged)"

# Test 6: explicit mode: enforce -> enforce, appended (pre-existing behavior, unchanged).
echo "--- Test 6: explicit mode: enforce -> enforce (appended) ---"
PROJECT_6="$TMPDIR/proj-6"
mkdir -p "$PROJECT_6/.flywheel"
cat > "$PROJECT_6/.flywheel/config.yaml" <<'EOF'
project: test-project
founder_ux_gate:
  mode: enforce
EOF
RESULT_6=$(resolve_founder_ux_mode "$PROJECT_6")
assert_eq "$RESULT_6" "enforce|1" "Test 6: explicit mode:enforce resolves to enforce+appended (unchanged)"

# Test 7: another top-level block appearing BEFORE founder_ux_gate in the file
# must not leak its own "mode:"-shaped key into the match (inblk gating sanity).
echo "--- Test 7: unrelated preceding block with its own indented keys does not confuse the parser ---"
PROJECT_7="$TMPDIR/proj-7"
mkdir -p "$PROJECT_7/.flywheel"
cat > "$PROJECT_7/.flywheel/config.yaml" <<'EOF'
project: test-project
qa:
  auto: true
founder_ux_gate:
  mode: off
EOF
RESULT_7=$(resolve_founder_ux_mode "$PROJECT_7")
assert_eq "$RESULT_7" "off|0" "Test 7: preceding unrelated block does not prevent reading the real mode"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
