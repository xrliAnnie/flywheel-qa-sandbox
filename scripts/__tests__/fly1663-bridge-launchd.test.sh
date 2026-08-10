#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUPERVISOR="$ROOT/scripts/lib/supervisor.sh"
INSTALLER="$ROOT/scripts/install-bridge-launchd.sh"
RESTART="$ROOT/scripts/restart-services.sh"
TMP="$(mktemp -d /tmp/fly1663-bridge.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
export FLYWHEEL_STATE_DIR="$HOME/.flywheel"
export FLYWHEEL_DIR="$ROOT"
export FLYWHEEL_LAUNCHD_DIR="$HOME/Library/LaunchAgents"
for writable_path in "$HOME" "$FLYWHEEL_STATE_DIR" "$FLYWHEEL_LAUNCHD_DIR"; do
  case "$writable_path" in
    "$TMP"|"$TMP"/*) ;;
    *) echo "FATAL: writable test path escaped sandbox: $writable_path" >&2; exit 99 ;;
  esac
done

passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

spec="$(SUPERVISOR_SOURCED= source "$SUPERVISOR"; supervisor_bridge_spec /opt/flywheel/flywheel-bridge-wrapper.sh)"
if [[ "$(jq -r '[.name,.kind,.keepAlive,.throttleInterval,.stdout] | @tsv' <<< "$spec")" == \
    $'bridge\tservice\ttrue\t30\t/tmp/flywheel-bridge.log' ]]; then
  pass "one shared Bridge service spec owns KeepAlive/throttle/log policy"
else
  fail "canonical Bridge service spec: [$spec]"
fi

mkdir -p "$TMP/bin" "$FLYWHEEL_STATE_DIR/bin" "$FLYWHEEL_LAUNCHD_DIR"
cp "$ROOT/scripts/flywheel-bridge-wrapper.sh" "$TMP/home/.flywheel/bin/flywheel-bridge-wrapper.sh"
chmod 755 "$TMP/home/.flywheel/bin/flywheel-bridge-wrapper.sh"
cat > "$TMP/bin/launchctl" <<'EOF'
#!/bin/bash
printf 'launchctl %s\n' "$*" >> "$FLY1663_CALLS"
exit 0
EOF
cat > "$TMP/bin/plutil" <<'EOF'
#!/bin/bash
if [[ "$1 $2 $3 $4" == "-extract KeepAlive raw -o" ]]; then printf 'true\n'; exit 0; fi
exit 1
EOF
chmod 755 "$TMP/bin/launchctl" "$TMP/bin/plutil"
calls="$TMP/calls"
: > "$calls"
if HOME="$TMP/home" PATH="$TMP/bin:$PATH" FLY1663_CALLS="$calls" \
    FLYWHEEL_LAUNCHD_DIR="$TMP/home/Library/LaunchAgents" \
    bash "$INSTALLER" --wrapper "$TMP/home/.flywheel/bin/flywheel-bridge-wrapper.sh" >/dev/null 2>&1; then
  plist="$TMP/home/Library/LaunchAgents/com.flywheel.bridge.plist"
  if [[ -f "$plist" ]] \
      && grep -q '<key>KeepAlive</key><true/>' "$plist" \
      && grep -q '<key>ThrottleInterval</key><integer>30</integer>' "$plist" \
      && grep -q '<key>StandardOutPath</key><string>/tmp/flywheel-bridge.log</string>' "$plist" \
      && grep -qF "$TMP/home/.flywheel/bin/flywheel-bridge-wrapper.sh" "$plist" \
      && grep -q 'launchctl bootstrap gui/' "$calls"; then
    pass "thin monorepo installer renders and loads the canonical launchd job"
  else
    fail "Bridge installer plist/calls contract"
  fi
else
  fail "Bridge installer execution"
fi

start_block="$(sed -n '/^start_bridge()/,/^}/p' "$RESTART")"
if grep -q 'supervisor_assert_keepalive bridge' <<< "$start_block" \
    && grep -q 'supervisor_restart bridge' <<< "$start_block" \
    && ! grep -qE 'nohup|npx tsx|falling back' <<< "$start_block"; then
  pass "restart path is launchd-only and fails loud instead of spawning an orphan"
else
  fail "restart start_bridge still exposes a non-launchd path"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
