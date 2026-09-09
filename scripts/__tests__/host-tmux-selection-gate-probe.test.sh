#!/bin/bash
# FLY-2444: the host tmux preflight probe must make the same selection
# judgment as gate without publishing applicability or selection state.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; shift; [ "$#" -eq 0 ] || echo "        $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/host-tmux-selection-gate.sh"
SANDBOX="$(mktemp -d -t fly2444-host-tmux-probe-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

FIXTURE_HOME="$SANDBOX/home"
FIXTURE_BIN="$SANDBOX/opt-homebrew/Cellar/tmux/3.7c/bin"
FIXTURE_CANONICAL="$FIXTURE_BIN/tmux"
FIXTURE_TOOLS="$SANDBOX/tools"
VALID_SHA="0123456789abcdef0123456789abcdef01234567"
mkdir -p "$FIXTURE_HOME" "$FIXTURE_BIN" "$FIXTURE_TOOLS"
printf '%s\n' '#!/bin/bash' 'printf "tmux 3.7c\n"' > "$FIXTURE_CANONICAL"
chmod +x "$FIXTURE_CANONICAL"
ln -s "$FIXTURE_CANONICAL" "$FIXTURE_TOOLS/tmux"
printf '%s\n' '#!/bin/bash' 'printf "%s: Mach-O 64-bit executable arm64\n" "$1"' \
  > "$FIXTURE_TOOLS/file"
chmod +x "$FIXTURE_TOOLS/file"
FIXTURE_CANONICAL_RESOLVED="$(readlink -f "$FIXTURE_CANONICAL")"

snapshot_tree() {
  local root="$1"
  if [ ! -e "$root" ] && [ ! -L "$root" ]; then
    printf 'absent\n'
    return
  fi
  while IFS= read -r path; do
    if [ -L "$path" ]; then
      printf 'link %s -> %s\n' "${path#"$root"}" "$(readlink "$path")"
    elif [ -f "$path" ]; then
      printf 'file %s %s\n' "${path#"$root"}" "$(shasum -a 256 "$path" | awk '{print $1}')"
    elif [ -d "$path" ]; then
      printf 'dir %s\n' "${path#"$root"}"
    else
      printf 'other %s\n' "${path#"$root"}"
    fi
  done < <(find "$root" -print | LC_ALL=C sort)
}

run_selection() {
  local action="$1" state_dir="$2" applicability="$3" canonical="$4"
  env -i \
    HOME="$FIXTURE_HOME" \
    PATH="/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$state_dir" \
    FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
    FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY="$applicability" \
    FLYWHEEL_HOST_TMUX_POST_S1_PATH="$FIXTURE_TOOLS:/usr/bin:/bin" \
    FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH="$canonical" \
    FLYWHEEL_HOST_TMUX_FILE_BIN="$FIXTURE_TOOLS/file" \
    FLYWHEEL_HOST_TMUX_HOST_ID="fixture-host" \
    FLYWHEEL_HOST_TMUX_TARGET_SHA="$VALID_SHA" \
    FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:codex-generic" \
    FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-lead.sh" \
    FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH=1000 \
    FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS=300 \
    bash "$GATE" "$action" codex-generic
}

PROBE_STATE="$SANDBOX/probe-state"
GATE_STATE="$SANDBOX/gate-state"
mkdir -p "$PROBE_STATE"
printf 'preserve-me\n' > "$PROBE_STATE/sentinel"
PROBE_BEFORE="$(snapshot_tree "$PROBE_STATE")"
PROBE_OUT="$(run_selection probe "$PROBE_STATE" required "$FIXTURE_CANONICAL_RESOLVED" \
  2>"$SANDBOX/probe.err")"
PROBE_RC=$?
PROBE_AFTER="$(snapshot_tree "$PROBE_STATE")"
GATE_OUT="$(run_selection gate "$GATE_STATE" required "$FIXTURE_CANONICAL_RESOLVED" \
  2>"$SANDBOX/gate.err")"
GATE_RC=$?
if [ "$PROBE_RC" -eq 0 ] \
  && [ "$GATE_RC" -eq 0 ] \
  && [ "$PROBE_OUT" = "$GATE_OUT" ] \
  && [ "$PROBE_BEFORE" = "$PROBE_AFTER" ] \
  && [ ! -e "$PROBE_STATE/state/host-tmux/required" ] \
  && [ ! -e "$PROBE_STATE/state/host-tmux/codex-generic.json" ] \
  && [ -f "$GATE_STATE/state/host-tmux/codex-generic.json" ]; then
  pass "required probe matches gate judgment without publishing marker or receipt state"
else
  fail "required probe parity and zero-write contract (probe=$PROBE_RC gate=$GATE_RC)" \
    "$(cat "$SANDBOX/probe.err" 2>/dev/null)"
fi

NOT_APPLICABLE_STATE="$SANDBOX/not-applicable-state"
NOT_APPLICABLE_GATE_STATE="$SANDBOX/not-applicable-gate-state"
mkdir -p "$NOT_APPLICABLE_STATE"
printf 'preserve-me-too\n' > "$NOT_APPLICABLE_STATE/sentinel"
NOT_APPLICABLE_BEFORE="$(snapshot_tree "$NOT_APPLICABLE_STATE")"
NOT_APPLICABLE_OUT="$(run_selection probe "$NOT_APPLICABLE_STATE" not-applicable \
  "$FIXTURE_CANONICAL_RESOLVED" 2>"$SANDBOX/not-applicable.err")"
NOT_APPLICABLE_RC=$?
NOT_APPLICABLE_AFTER="$(snapshot_tree "$NOT_APPLICABLE_STATE")"
NOT_APPLICABLE_GATE_OUT="$(run_selection gate "$NOT_APPLICABLE_GATE_STATE" not-applicable \
  "$FIXTURE_CANONICAL_RESOLVED" 2>"$SANDBOX/not-applicable-gate.err")"
NOT_APPLICABLE_GATE_RC=$?
if [ "$NOT_APPLICABLE_RC" -eq 0 ] \
  && [ "$NOT_APPLICABLE_GATE_RC" -eq 0 ] \
  && [ "$NOT_APPLICABLE_OUT" = "$NOT_APPLICABLE_GATE_OUT" ] \
  && [ "$NOT_APPLICABLE_BEFORE" = "$NOT_APPLICABLE_AFTER" ]; then
  pass "not-applicable probe preserves the gate decision and state tree"
else
  fail "not-applicable probe parity and zero-write contract" \
    "$(cat "$SANDBOX/not-applicable.err" 2>/dev/null)"
fi

BAD_CANONICAL="$SANDBOX/opt-homebrew/Cellar/tmux/3.5a/bin/tmux"
mkdir -p "$(dirname "$BAD_CANONICAL")"
printf '%s\n' '#!/bin/bash' 'printf "tmux 3.5a\n"' > "$BAD_CANONICAL"
chmod +x "$BAD_CANONICAL"
rm "$FIXTURE_TOOLS/tmux"
ln -s "$BAD_CANONICAL" "$FIXTURE_TOOLS/tmux"
BAD_CANONICAL_RESOLVED="$(readlink -f "$BAD_CANONICAL")"
BAD_PROBE_RC=0
BAD_GATE_RC=0
run_selection probe "$SANDBOX/bad-probe-state" required "$BAD_CANONICAL_RESOLVED" \
  >"$SANDBOX/bad-probe.out" 2>"$SANDBOX/bad-probe.err" || BAD_PROBE_RC=$?
run_selection gate "$SANDBOX/bad-gate-state" required "$BAD_CANONICAL_RESOLVED" \
  >"$SANDBOX/bad-gate.out" 2>"$SANDBOX/bad-gate.err" || BAD_GATE_RC=$?
if [ "$BAD_PROBE_RC" -ne 0 ] \
  && [ "$BAD_PROBE_RC" -eq "$BAD_GATE_RC" ] \
  && cmp -s "$SANDBOX/bad-probe.out" "$SANDBOX/bad-gate.out" \
  && cmp -s "$SANDBOX/bad-probe.err" "$SANDBOX/bad-gate.err" \
  && grep -Fq "selected tmux version is not tmux 3.7c: tmux 3.5a" \
    "$SANDBOX/bad-probe.err" \
  && [ ! -e "$SANDBOX/bad-probe-state" ]; then
  pass "probe preserves gate failure status and diagnostics without state writes"
else
  fail "probe failure parity and zero-write contract (probe=$BAD_PROBE_RC gate=$BAD_GATE_RC)" \
    "$(cat "$SANDBOX/bad-probe.err" 2>/dev/null)"
fi

echo ""
echo "host-tmux-selection-gate-probe: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
