#!/bin/bash
# FLY-224 Phase 2 (CR #2): codex-lead.sh arg parsing must match claude-lead.sh's
# contract — reject bad lead-id / unknown flag / missing flag value with a
# non-zero exit BEFORE reaching the runtime exec (i.e. it fails at parse, not at
# the "runtime entrypoint missing" stage).
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_LEAD="${SCRIPT_DIR}/../codex-lead.sh"
[ -x "$CODEX_LEAD" ] || { echo "ERROR: codex-lead.sh not executable at $CODEX_LEAD"; exit 1; }

# CR Phase 2a R2 #2: fail-fast if temp dir can't be created (no silent all-pass).
TMP="$(mktemp -d -t fly224-args-XXXXXX)" || { echo "FATAL: mktemp failed"; exit 1; }
[ -d "$TMP" ] || { echo "FATAL: temp dir not created"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/project"

# Returns the exit code + first stderr line; never reaches the runtime for these.
run() { out=$(bash "$CODEX_LEAD" "$@" 2>&1); echo "$?|$out"; }

# bad lead-id (leading hyphen) → reject
r=$(run -- "$TMP/project" proj); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "Invalid lead-id"; then
  pass "rejects bad lead-id (leading hyphen)"
else fail "bad lead-id should be rejected (got: $r)"; fi

# uppercase lead-id → reject
r=$(run BadLead "$TMP/project" proj); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "Invalid lead-id"; then
  pass "rejects uppercase lead-id"
else fail "uppercase lead-id should be rejected (got: $r)"; fi

# unknown flag → reject
r=$(run good-lead "$TMP/project" proj --nope); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "Unknown flag"; then
  pass "rejects unknown flag"
else fail "unknown flag should be rejected (got: $r)"; fi

# --subdir missing value → reject
r=$(run good-lead "$TMP/project" proj --subdir); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "subdir requires"; then
  pass "rejects --subdir without a value"
else fail "--subdir missing value should be rejected (got: $r)"; fi

# extra positional after project-name → reject
r=$(run good-lead "$TMP/project" proj extra); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "Unexpected argument"; then
  pass "rejects an extra positional argument"
else fail "extra positional should be rejected (got: $r)"; fi

# Token selector is registry-owned; an argv override would recreate a second identity source.
r=$(run good-lead "$TMP/project" proj --bot-token-env PRODUCT_TOKEN); code=${r%%|*}
if [ "$code" -ne 0 ] && printf '%s' "$r" | grep -qi "registry-owned"; then
  pass "rejects legacy --bot-token-env identity override"
else fail "--bot-token-env should be rejected as a second identity source (got: $r)"; fi

# FLY-2444 D7/D12/D13: exercise the post-resolve launcher through a hermetic
# copy that stubs only identity, home operations, and the final runtime exec.
HARNESS="$TMP/harness"
HARNESS_SCRIPT="$HARNESS/scripts/codex-lead.sh"
CALLS="$TMP/home-calls"
CAPTURE="$TMP/runtime-env.json"
mkdir -p "$HARNESS/scripts/lib" "$HARNESS/dist/lead-backends/codex" "$TMP/home"
cp "$CODEX_LEAD" "$HARNESS_SCRIPT"
cat >"$HARNESS/scripts/lib/canonical-lead-identity.sh" <<'SH'
canonical_lead_identity_resolve() {
  export FLYWHEEL_PROJECT_NAME="$1"
  export FLYWHEEL_LEAD_ID="$2"
  export FLYWHEEL_LEAD_PROJECTS_DIGEST="${STUB_PROJECTS_DIGEST:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
}
SH
cat >"$HARNESS/scripts/lead-rules-bundle.sh" <<'SH'
assemble_full_access_governance() {
  export FLY350_FULL_ACCESS_ROLE=dept
  export FLY350_FULL_ACCESS_BUNDLE=test
  return 0
}
SH
cat >"$HARNESS/scripts/codex-lead-tui-home.sh" <<'SH'
#!/bin/bash
printf '%s\n' "$1" >>"$HOME_CALLS"
SH
chmod +x "$HARNESS/scripts/codex-lead-tui-home.sh"
cat >"$HARNESS/dist/lead-backends/codex/codex-lead-tui-runtime.js" <<'JS'
const fs = require("node:fs");
fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  stateDir: process.env.FLYWHEEL_CODEX_LEAD_STATE_DIR,
  actionsStateDir: process.env.FLYWHEEL_LEAD_ACTIONS_STATE_DIR,
  projectsDigest: process.env.FLYWHEEL_LEAD_PROJECTS_DIGEST,
}));
JS

run_harness() {
  HOME="$TMP/home" \
  HOME_CALLS="$CALLS" \
  CAPTURE_FILE="$CAPTURE" \
  CODEX_HOME="$TMP/codex-home" \
  FLYWHEEL_STATE_DIR="$TMP/flywheel-state" \
  FLYWHEEL_CODEX_LEAD_MODE=tui \
  FLYWHEEL_CODEX_TUI_CWD="$TMP/project" \
  "$@" /bin/bash "$HARNESS_SCRIPT" good-lead "$TMP/project" project-a
}

: >"$CALLS"
rm -f "$CAPTURE"
if run_harness env FLYWHEEL_CODEX_LEAD_PROFILE=full-access >"$TMP/full.out" 2>"$TMP/full.err" \
  && [ "$(grep -c '^ensure-home$' "$CALLS" || true)" -eq 1 ] \
  && [ "$(grep -c '^ensure-daemon$' "$CALLS" || true)" -eq 0 ]; then
  pass "full-access defers ensure-daemon ownership to the TUI runtime"
else
  fail "full-access launcher must call ensure-home but not ensure-daemon"
fi

: >"$CALLS"
rm -f "$CAPTURE"
if run_harness env FLYWHEEL_CODEX_LEAD_PROFILE=companion >"$TMP/companion.out" 2>"$TMP/companion.err" \
  && [ "$(grep -c '^ensure-home$' "$CALLS" || true)" -eq 1 ] \
  && [ "$(grep -c '^ensure-daemon$' "$CALLS" || true)" -eq 1 ]; then
  pass "companion keeps launcher-owned ensure-daemon behavior"
else
  fail "companion launcher daemon behavior changed"
fi

if [ -f "$CAPTURE" ]; then
  state_dir=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).stateDir)' "$CAPTURE")
  actions_dir=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).actionsStateDir || "")' "$CAPTURE")
else
  state_dir=""; actions_dir=""
fi
if [ -n "$state_dir" ] && [ "$actions_dir" = "$state_dir" ]; then
  pass "defaults lead-actions state to the resolved Codex Lead state directory"
else
  fail "lead-actions state directory must equal resolved state: state=$state_dir actions=$actions_dir"
fi

if run_harness env FLYWHEEL_CODEX_LEAD_PROFILE=companion \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="$TMP/wrong-state" >"$TMP/conflict.out" 2>"$TMP/conflict.err"; then
  fail "conflicting lead-actions state directory must fail"
elif [ "$?" -eq 78 ] && grep -q 'actions state directory' "$TMP/conflict.err"; then
  pass "rejects a conflicting lead-actions state directory with exit 78"
else
  fail "conflicting lead-actions state directory returned the wrong error"
fi

if run_harness env FLYWHEEL_CODEX_LEAD_PROFILE=companion \
  FLYWHEEL_LEAD_EXPECTED_PROJECTS_DIGEST="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  >"$TMP/digest.out" 2>"$TMP/digest.err"; then
  fail "projects digest drift must fail"
elif [ "$?" -eq 78 ] && grep -q 'identity_projects_digest_drift' "$TMP/digest.err"; then
  pass "rejects selector-to-resolver projects digest drift with exit 78"
else
  fail "projects digest drift returned the wrong error"
fi

rm -f "$CAPTURE"
if run_harness env FLYWHEEL_CODEX_LEAD_PROFILE=companion \
  FLYWHEEL_LEAD_EXPECTED_PROJECTS_DIGEST="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  >"$TMP/digest-match.out" 2>"$TMP/digest-match.err" && [ -f "$CAPTURE" ]; then
  pass "accepts an exact selector-to-resolver projects digest match"
else
  fail "matching projects digest should reach the runtime"
fi

echo ""
echo "[codex-lead-args] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
