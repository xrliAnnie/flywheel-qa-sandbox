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

# ── FLY-3083: FLYWHEEL_LEAD_ALERT_SCRIPT is exported on the full-access path in
# BOTH headless and TUI mode (set before the headless/TUI split), starting from
# an env that does NOT preset it; a non-full-access profile never gets it.
# A PATH-injected mock `node` dumps the env the launcher execs the runtime with.
mkdir -p "$TMP/bin" "$TMP/home"
cat > "$TMP/bin/node" <<'MOCK'
#!/bin/bash
env > "$ENVDUMP"
exit 0
MOCK
chmod +x "$TMP/bin/node"
REPO_ALERT="$(cd "${SCRIPT_DIR}/../../../../scripts" && pwd -P)/lead-alert.sh"
run_env_dump() {
  local dump="$TMP/env.$RANDOM"
  env -u FLYWHEEL_LEAD_ALERT_SCRIPT -u FLYWHEEL_LEAD_CORE_CHANNEL_ID -u FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES \
    PATH="$TMP/bin:$PATH" HOME="$TMP/home" ENVDUMP="$dump" FLYWHEEL_LEAD_DRY_RUN=1 "$@" \
    bash "$CODEX_LEAD" good-lead "$TMP/project" proj >/dev/null 2>&1
  echo "$dump"
}
alert_of() { grep '^FLYWHEEL_LEAD_ALERT_SCRIPT=' "$1" 2>/dev/null | head -1 | cut -d= -f2-; }
for mode in headless tui; do
  D=$(run_env_dump FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_LEAD_MODE="$mode")
  got=$(alert_of "$D")
  if [ -n "$got" ] && [ "$got" = "$REPO_ALERT" ] && [ -f "$got" ]; then
    pass "FLY-3083 full-access $mode: FLYWHEEL_LEAD_ALERT_SCRIPT exported (existing canonical path)"
  else fail "FLY-3083 full-access $mode: FLYWHEEL_LEAD_ALERT_SCRIPT missing/wrong ('$got', dump=$([ -f "$D" ] && echo yes || echo none))"; fi
done
D=$(run_env_dump FLYWHEEL_CODEX_LEAD_PROFILE=companion)
if [ -f "$D" ] && ! grep -q '^FLYWHEEL_LEAD_ALERT_SCRIPT=' "$D"; then
  pass "FLY-3083 non-full-access profile: no FLYWHEEL_LEAD_ALERT_SCRIPT"
else fail "FLY-3083 non-full-access profile must not carry FLYWHEEL_LEAD_ALERT_SCRIPT (dump=$([ -f "$D" ] && echo yes || echo none))"; fi

echo ""
echo "[codex-lead-args] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
