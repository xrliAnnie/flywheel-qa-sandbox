#!/bin/bash
# FLY-224 Phase 2: verify flywheel-lead-wrapper.sh dispatches by resolved Lead
# backend (manifest.leadBackend.backendId) and that the CLAUDE path is
# byte-identical to the pre-FLY-224 behavior (same launcher, exact args).
#
# Strategy: point FLYWHEEL_DIR at a temp tree with STUB claude-lead.sh /
# codex-lead.sh that record their FULL argv (one arg per line, so boundaries are
# verifiable — not a prefix match) + cwd, feed a temp manifest, and assert which
# stub ran, with exactly which args, and the wrapper exit code.
set -uo pipefail

PASSED=0
FAILED=0
log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$(cd "${SCRIPT_DIR}/../../../../scripts" && pwd)/flywheel-lead-wrapper.sh"
[ -f "$WRAPPER" ] || { echo "ERROR: wrapper not found at $WRAPPER"; exit 1; }

# CR Phase 2a R2 #2: fail-fast if the temp dir can't be created — otherwise a
# read-only sandbox would let the suite report "all passed" without running.
TMP="$(mktemp -d -t fly224-dispatch-XXXXXX)" || { echo "FATAL: mktemp failed"; exit 1; }
[ -d "$TMP" ] || { echo "FATAL: temp dir not created"; exit 1; }
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/packages/teamlead/scripts" "$TMP/project" "$TMP/pids"
CAP="$TMP/capture.txt"

# Stubs record: "<BACKEND>" then "ARG=<each argv>" then "CWD=<pwd>".
for be in claude codex; do
  up=$(printf '%s' "$be" | tr '[:lower:]' '[:upper:]')
  cat > "$TMP/packages/teamlead/scripts/${be}-lead.sh" <<EOF
#!/bin/bash
{ echo "$up"; for a in "\$@"; do echo "ARG=\$a"; done; echo "CWD=\$(pwd)"; } > "$CAP"
EOF
done
chmod +x "$TMP/packages/teamlead/scripts/"*.sh
touch "$TMP/.env"

run_wrapper() { # $1 = manifest path → sets global RC
  : > "$CAP"
  FLYWHEEL_DIR="$TMP" \
  FLYWHEEL_WRAPPER_ENV_FILE="$TMP/.env" \
  FLYWHEEL_WRAPPER_PID_DIR="$TMP/pids" \
    bash "$WRAPPER" "$1" >/dev/null 2>&1
  RC=$?
}

manifest() { printf '%s' "$1" > "$TMP/m.json"; echo "$TMP/m.json"; }

EXPECT_CLAUDE_ARGS=$'CLAUDE\nARG=test-lead\nARG='"$TMP/project"$'\nARG=proj\nARG=--bot-token-env\nARG=DISCORD_BOT_TOKEN'
EXPECT_CODEX_ARGS=$'CODEX\nARG=cdx-lead\nARG='"$TMP/project"$'\nARG=proj\nARG=--subdir\nARG=ops\nARG=--bot-token-env\nARG=DISCORD_BOT_TOKEN'

# ── Case 1: absent leadBackend → CLAUDE, exact args, exit 0 ──
run_wrapper "$(manifest "{\"leadId\":\"test-lead\",\"projectDir\":\"$TMP/project\",\"projectName\":\"proj\"}")"
body=$(grep -vE '^CWD=' "$CAP")
if [ "$RC" -eq 0 ] && [ "$body" = "$EXPECT_CLAUDE_ARGS" ]; then
  pass "absent leadBackend → claude-lead.sh, exact args, exit 0"
else
  fail "absent leadBackend (rc=$RC) args mismatch: $(tr '\n' '|' < "$CAP")"
fi

# ── Case 2: explicit null → CLAUDE ──
run_wrapper "$(manifest "{\"leadId\":\"test-lead\",\"projectDir\":\"$TMP/project\",\"projectName\":\"proj\",\"leadBackend\":{\"backendId\":null}}")"
if [ "$RC" -eq 0 ] && head -1 "$CAP" | grep -qx "CLAUDE"; then
  pass "explicit null backendId → claude-lead.sh (byte-compat)"
else
  fail "null backendId should → claude (rc=$RC, got $(head -1 "$CAP"))"
fi

# ── Case 3: explicit claude-code → CLAUDE ──
run_wrapper "$(manifest "{\"leadId\":\"test-lead\",\"projectDir\":\"$TMP/project\",\"projectName\":\"proj\",\"leadBackend\":{\"backendId\":\"claude-code\"}}")"
if [ "$RC" -eq 0 ] && head -1 "$CAP" | grep -qx "CLAUDE"; then
  pass "explicit claude-code → claude-lead.sh"
else
  fail "claude-code should → claude (rc=$RC)"
fi

# ── Case 4: codex-app-server → CODEX, exact args incl --subdir, exit 0 ──
run_wrapper "$(manifest "{\"leadId\":\"cdx-lead\",\"projectDir\":\"$TMP/project\",\"projectName\":\"proj\",\"subdir\":\"ops\",\"leadBackend\":{\"backendId\":\"codex-app-server\"}}")"
body=$(grep -vE '^CWD=' "$CAP")
if [ "$RC" -eq 0 ] && [ "$body" = "$EXPECT_CODEX_ARGS" ]; then
  pass "codex-app-server → codex-lead.sh, exact args incl --subdir, exit 0"
else
  fail "codex-app-server args mismatch (rc=$RC): $(tr '\n' '|' < "$CAP")"
fi

# ── Case 5: unknown backend → non-zero exit, NO launcher ran ──
run_wrapper "$(manifest "{\"leadId\":\"x\",\"projectDir\":\"$TMP/project\",\"projectName\":\"proj\",\"leadBackend\":{\"backendId\":\"gemini-cli\"}}")"
if [ "$RC" -ne 0 ] && [ ! -s "$CAP" ]; then
  pass "unknown backend → non-zero exit + no launcher (fail-closed)"
else
  fail "unknown backend should fail-closed (rc=$RC, cap='$(cat "$CAP")')"
fi

echo ""
echo "[lead-backend-dispatch] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
