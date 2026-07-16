#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCRIPT="$ROOT/scripts/flywheel-cmux-autostart.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0

pass() { echo "[TEST] ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "[TEST] ✗ $1"; FAIL=$((FAIL + 1)); }

HOME_DIR="$TMP/home"
mkdir -p "$HOME_DIR/.flywheel/bin" "$HOME_DIR/.flywheel/state"
cat > "$HOME_DIR/.flywheel/bin/flywheel-cmux-sync" <<'STUB'
#!/bin/bash
printf '%s|%s|%s\n' "$FLYWHEEL_CMUX_LINKED_VIEW" "$FLYWHEEL_CMUX_VIEW_INVARIANT" "$*" > "$RECORD"
STUB
chmod +x "$HOME_DIR/.flywheel/bin/flywheel-cmux-sync"

run_autostart() {
  local record="$1"; shift
  env -i HOME="$HOME_DIR" PATH="/usr/bin:/bin" RECORD="$record" "$@" /bin/bash "$SCRIPT"
}

printf 'FLYWHEEL_CMUX_LINKED_VIEW=0\nFLYWHEEL_CMUX_VIEW_INVARIANT=1\nUNRELATED=$(touch /tmp/must-not-run)\n' > "$HOME_DIR/.flywheel/.env"
record="$TMP/file-values"
run_autostart "$record"
if [[ "$(cat "$record")" == "0|1|--watch" && ! -e /tmp/must-not-run ]]; then
  pass "extracts only the two bool flags from .env without sourcing unrelated code"
else
  fail "file extraction/exec mismatch: $(cat "$record" 2>/dev/null || true)"
fi

record="$TMP/env-precedence"
run_autostart "$record" FLYWHEEL_CMUX_LINKED_VIEW=1 FLYWHEEL_CMUX_VIEW_INVARIANT=0
if [[ "$(cat "$record")" == "1|0|--watch" ]]; then
  pass "process env overrides .env"
else
  fail "env precedence mismatch: $(cat "$record" 2>/dev/null || true)"
fi

printf 'FLYWHEEL_CMUX_LINKED_VIEW=wat\nFLYWHEEL_CMUX_VIEW_INVARIANT=\n' > "$HOME_DIR/.flywheel/.env"
record="$TMP/invalid"
run_autostart "$record"
if [[ "$(cat "$record")" == "1|1|--watch" ]]; then
  pass "invalid/empty values fail safe to default-on"
else
  fail "invalid bool handling mismatch: $(cat "$record" 2>/dev/null || true)"
fi

touch "$HOME_DIR/.flywheel/state/cmux-maintenance"
record="$TMP/maintenance-zsh"
run_autostart "$record"
if [[ ! -e "$record" ]]; then
  pass "unsupervised autostart exits once while maintenance is active"
else
  fail "unsupervised maintenance path launched watcher"
fi

record="$TMP/maintenance-supervised"
run_autostart "$record" FLYWHEEL_CMUX_SUPERVISED=1
if [[ "$(cat "$record")" == "1|1|--watch" ]]; then
  pass "supervised launch delegates maintenance waiting to the sync process"
else
  fail "supervised maintenance path did not exec watcher"
fi

echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
