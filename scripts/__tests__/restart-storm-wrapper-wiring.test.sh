#!/usr/bin/env bash
# FLY-1501 W3: every OS-supervised child must gate before local running markers.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

assert_before() { # file first_pattern second_pattern description
  local file="$1" first="$2" second="$3" description="$4"
  local first_line second_line
  first_line="$(grep -n -m1 "$first" "$file" | cut -d: -f1)"
  second_line="$(grep -n -m1 "$second" "$file" | cut -d: -f1)"
  if [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]]; then
    pass "$description"
  else
    fail "$description" "first=${first_line:-missing} second=${second_line:-missing}"
  fi
}

BRIDGE="$REPO_DIR/scripts/flywheel-bridge-wrapper.sh"
VOICE="$REPO_DIR/scripts/flywheel-voice-bridge-wrapper.sh"
LEAD="$REPO_DIR/scripts/flywheel-lead-wrapper.sh"
QUOTA="$REPO_DIR/scripts/flywheel-quota-monitor-wrapper.sh"
CMUX="$REPO_DIR/scripts/flywheel-cmux-autostart.sh"

for wrapper in "$BRIDGE" "$VOICE" "$LEAD" "$QUOTA" "$CMUX"; do
  if bash -n "$wrapper" && grep -q 'restart-storm-gate.py' "$wrapper"; then
    pass "$(basename "$wrapper") parses and invokes the shared gate"
  else
    fail "$(basename "$wrapper") gate wiring" "missing or invalid"
  fi
done

assert_before "$BRIDGE" 'if \[\[ -f "\$PID_FILE" \]\]' 'restart-storm-gate.py' \
  "bridge excludes the PID no-op guard from restart accounting"
assert_before "$BRIDGE" 'restart-storm-gate.py' 'echo \$\$ > "\$PID_FILE"' \
  "bridge gates only a launch that will write its PID marker"
assert_before "$VOICE" 'if \[\[ -f "\$PID_FILE" \]\]' 'restart-storm-gate.py' \
  "voice bridge excludes the PID no-op guard from restart accounting"
assert_before "$VOICE" 'restart-storm-gate.py' 'echo \$\$ > "\$PID_FILE"' \
  "voice bridge gates only a launch that will write its PID marker"
assert_before "$LEAD" 'if \[ -f "\$PID_FILE" \]' 'restart-storm-gate.py' \
  "lead excludes the PID no-op guard from restart accounting"
assert_before "$LEAD" 'restart-storm-gate.py' 'case "\$LEAD_BACKEND"' \
  "lead gates only a launch that reaches backend dispatch"
assert_before "$QUOTA" 'restart-storm-gate.py' 'if \[\[ -f "\$RUN_MARKER" \]\]' \
  "quota monitor gates before reading or writing legacy crash markers"
assert_before "$CMUX" 'restart-storm-gate.py' 'exec "\$SYNC_SCRIPT" --watch' \
  "cmux supervised branch gates before watcher exec"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1501-wrapper-wiring.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/home/.flywheel" "$ROOT/bin"
: > "$ROOT/home/.flywheel/.env"
cat > "$ROOT/bin/held-gate" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_GATE_LOG"
exit 3
EOF
cat > "$ROOT/bin/sync" <<'EOF'
#!/usr/bin/env bash
printf 'executed\n' >> "$FAKE_SYNC_LOG"
EOF
chmod +x "$ROOT/bin/held-gate" "$ROOT/bin/sync"

if env HOME="$ROOT/home" \
    FLYWHEEL_CMUX_SUPERVISED=1 \
    FLYWHEEL_RESTART_STORM_GATE_BIN="$ROOT/bin/held-gate" \
    FAKE_GATE_LOG="$ROOT/gate.log" \
    FAKE_SYNC_LOG="$ROOT/sync.log" \
    bash "$CMUX" >/dev/null 2>&1 \
  && grep -q 'gate cmux-watcher' "$ROOT/gate.log" \
  && [[ ! -e "$ROOT/sync.log" ]]; then
  pass "held cmux exits cleanly without exec"
else
  fail "held cmux behavior" "gate=$(cat "$ROOT/gate.log" 2>/dev/null || echo missing)"
fi

echo
echo "[restart-storm-wrapper-wiring.test] passed=$PASSED failed=$FAILED"
[[ "$FAILED" -eq 0 ]]
