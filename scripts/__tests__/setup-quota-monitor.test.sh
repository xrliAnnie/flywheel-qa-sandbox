#!/usr/bin/env bash
# FLY-1256 M6: hermetic install/enable + kill-switch tests.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

file_mode() {
  local path="$1" mode
  if mode="$(stat -f '%Lp' "$path" 2>/dev/null)" && [[ "$mode" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$mode"
    return 0
  fi
  if mode="$(stat -c '%a' "$path" 2>/dev/null)" && [[ "$mode" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$mode"
    return 0
  fi
  return 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SETUP="$REPO_DIR/scripts/setup-quota-monitor.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1256-setup.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

if [[ -f "$SETUP" ]] && bash -n "$SETUP"; then
  pass "setup exists and parses"
else
  fail "setup exists and parses" "$SETUP"
fi

make_fixture() { # <name>
  local name="$1" home="$ROOT/$1/home" pool="$ROOT/$1/pool"
  mkdir -p "$home/.flywheel" "$home/Library/LaunchAgents" "$pool"
  printf 'ORIGINAL=yes\n' > "$home/.flywheel/.env"
  local account
  for account in shopping school zeta alpha; do
    mkdir -p "$pool/$account"
    printf '{"claudeAiOauth":{"accessToken":"fixture-%s","refreshToken":"r-%s","expiresAt":4102444800000}}' "$account" "$account" \
      > "$pool/$account/.credentials.json"
    chmod 600 "$pool/$account/.credentials.json"
  done
  printf 'shopping\n' > "$pool/.active"
  jq -n '{generation:1,activeAccount:"shopping",accounts:["shopping","school","zeta","alpha"]|map({name:.,quotaExhaustedUntil:null,weeklyResetAt:null})}' \
    > "$home/.flywheel/claude-accounts.json"
}

mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"
if [[ "${1:-}" == "bootstrap" ]]; then
  now_ms=$(( $(date +%s) * 1000 ))
  mkdir -p "$(dirname "$FLYWHEEL_QUOTA_PIDFILE")" "$(dirname "$FLYWHEEL_QUOTA_STATE_PATH")"
  printf '{"pid":%d,"uid":%d,"processStartTime":"fixture"}\n' "$PPID" "$(id -u)" > "$FLYWHEEL_QUOTA_PIDFILE"
  jq -n --argjson now "$now_ms" '{version:1,lastPollAt:$now,lastSuccessfulUsageAt:$now,errorStreak:0,backoffUntilMs:0,tier:"base",lastCandidateSweepAt:null,lastSwitchAt:null,observedGeneration:1,reviveEpoch:null}' > "$FLYWHEEL_QUOTA_STATE_PATH"
fi
if [[ "${1:-}" == "bootout" && "${FAKE_OLD_PID:-}" =~ ^[1-9][0-9]*$ ]]; then
  kill "$FAKE_OLD_PID" 2>/dev/null || true
fi
EOF
cat > "$ROOT/bin/restart" <<'EOF'
#!/usr/bin/env bash
grep '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=' "$FLYWHEEL_ENV_FILE" >> "$FAKE_RESTART_LOG" 2>/dev/null || printf 'unset\n' >> "$FAKE_RESTART_LOG"
printf '%s\n' "$*" >> "$FAKE_RESTART_LOG"
EOF
cat > "$ROOT/bin/alert" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_ALERT_LOG"
printf 'sent\n'
EOF
chmod +x "$ROOT/bin/launchctl" "$ROOT/bin/restart" "$ROOT/bin/alert"

run_setup() { # <fixture> [args...]
  local name="$1"; shift
  local home="$ROOT/$name/home" pool="$ROOT/$name/pool"
  env HOME="$home" \
    FLYWHEEL_DIR="$REPO_DIR" \
    FLYWHEEL_ENV_FILE="$home/.flywheel/.env" \
    FLYWHEEL_CLAUDE_PROFILES_DIR="$pool" \
    FLYWHEEL_CLAUDE_ACCOUNTS_PATH="$home/.flywheel/claude-accounts.json" \
    FLYWHEEL_QUOTA_MONITOR_CONFIG="$home/.flywheel/quota-monitor.json" \
    FLYWHEEL_QUOTA_PIDFILE="$home/.flywheel/quota-monitor.pid" \
    FLYWHEEL_QUOTA_STATE_PATH="$home/.flywheel/quota-monitor-state.json" \
    FLYWHEEL_QUOTA_LOG_PATH="$home/.flywheel/logs/quota-monitor.log" \
    FLYWHEEL_QUOTA_LAUNCHCTL_BIN="$ROOT/bin/launchctl" \
    FLYWHEEL_QUOTA_RESTART_BIN="$ROOT/bin/restart" \
    FLYWHEEL_LEAD_ALERT_BIN="$ROOT/bin/alert" \
    FLYWHEEL_QUOTA_HEALTH_TIMEOUT_SECONDS=3 \
    FAKE_LAUNCHCTL_LOG="$ROOT/$name/launchctl.log" \
    FAKE_RESTART_LOG="$ROOT/$name/restart.log" \
    FAKE_ALERT_LOG="$ROOT/$name/alert.log" \
    bash "$SETUP" "$@"
}

make_fixture default
if run_setup default >"$ROOT/default/setup.out" 2>&1; then
  order="$(jq -r '.order | join(",")' "$ROOT/default/home/.flywheel/quota-monitor.json")"
  if [[ "$order" == "shopping,school,alpha,zeta" ]]; then
    pass "default install enables founder order then alphabetical remainder"
  else
    fail "default order" "$order"
  fi
  if [[ "$(jq -r '.paneScanSeconds' "$ROOT/default/home/.flywheel/quota-monitor.json")" == "60" ]] \
    && [[ "$(jq -r '.confirmDelayMinutes' "$ROOT/default/home/.flywheel/quota-monitor.json")" == "7" ]]; then
    pass "default install writes local-loop clock defaults"
  else
    fail "default clock knobs" "$(cat "$ROOT/default/home/.flywheel/quota-monitor.json")"
  fi
  if ! grep -q '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=' "$ROOT/default/home/.flywheel/.env" \
    && [[ ! -e "$ROOT/default/restart.log" ]] \
    && grep -q 'only auto-switch executor' "$ROOT/default/setup.out"; then
    pass "healthy enable leaves the retired flag absent and does not restart Bridge"
  else
    fail "permanent cutover enable" "env=$(cat "$ROOT/default/home/.flywheel/.env"); restart=$(cat "$ROOT/default/restart.log" 2>/dev/null); output=$(cat "$ROOT/default/setup.out")"
  fi
  if grep -q '^bootout gui/.*/com.flywheel.quota-monitor$' "$ROOT/default/launchctl.log" \
    && grep -q '^bootstrap gui/' "$ROOT/default/launchctl.log"; then
    pass "bootstrap is idempotent via bootout then bootstrap"
  else
    fail "idempotent bootstrap" "$(cat "$ROOT/default/launchctl.log")"
  fi
else
  fail "default install" "setup exited non-zero"
fi

make_fixture legacy_config
jq -n '{
  trigger5hPct:90,
  basePollMinutes:20,
  acceleratePct:70,
  acceleratedPollMinutes:10,
  candidateSweepMinutes:60,
  minSwitchIntervalMinutes:15,
  order:["shopping","school","alpha","zeta"],
  writeStatuslineCache:true
}' > "$ROOT/legacy_config/home/.flywheel/quota-monitor.json"
chmod 600 "$ROOT/legacy_config/home/.flywheel/quota-monitor.json"
if run_setup legacy_config >/dev/null 2>&1 \
  && [[ "$(jq -r '.order | length' "$ROOT/legacy_config/home/.flywheel/quota-monitor.json")" == "4" ]]; then
  pass "re-running setup accepts the legacy eight-key production config"
else
  fail "legacy config rerun" "setup rejected a previously valid enabled config"
fi

old_state_json() { # generation
  jq -nc --argjson generation "$1" '{version:1,lastPollAt:100,lastSuccessfulUsageAt:100,errorStreak:0,backoffUntilMs:0,tier:"base",lastCandidateSweepAt:null,lastSwitchAt:null,observedGeneration:$generation,reviveEpoch:null}'
}

make_fixture rollback_valid
old_state_json 1 > "$ROOT/rollback_valid/home/.flywheel/quota-monitor-state.json"
valid_before="$(cat "$ROOT/rollback_valid/home/.flywheel/quota-monitor-state.json")"
if run_setup rollback_valid --rollback-state >/dev/null 2>&1 \
  && [[ "$(cat "$ROOT/rollback_valid/home/.flywheel/quota-monitor-state.json")" == "$valid_before" ]] \
  && [[ ! -e "$ROOT/rollback_valid/launchctl.log" ]]; then
  pass "rollback-state leaves a fully old-loader-compatible state byte-identical"
else
  fail "rollback valid no-op" "state=$(cat "$ROOT/rollback_valid/home/.flywheel/quota-monitor-state.json" 2>/dev/null)"
fi

make_fixture rollback_strip
old_state_json 1 | jq '. + {blockedEpisode:null,pendingSwitchFailure:null}' \
  > "$ROOT/rollback_strip/home/.flywheel/quota-monitor-state.json"
if run_setup rollback_strip --rollback-state >/dev/null 2>&1 \
  && jq -e '(has("blockedEpisode")|not) and (has("pendingSwitchFailure")|not) and .observedGeneration == 1' \
    "$ROOT/rollback_strip/home/.flywheel/quota-monitor-state.json" >/dev/null \
  && [[ "$(file_mode "$ROOT/rollback_strip/home/.flywheel/quota-monitor-state.json")" == "600" ]]; then
  pass "rollback-state strips new fields, revalidates, and writes mode 0600"
else
  fail "rollback strip" "state=$(cat "$ROOT/rollback_strip/home/.flywheel/quota-monitor-state.json" 2>/dev/null)"
fi

for shape in missing corrupt ahead; do
  make_fixture "rollback_$shape"
done
rm -f "$ROOT/rollback_missing/home/.flywheel/quota-monitor-state.json"
printf '{broken\n' > "$ROOT/rollback_corrupt/home/.flywheel/quota-monitor-state.json"
old_state_json 2 > "$ROOT/rollback_ahead/home/.flywheel/quota-monitor-state.json"
rollback_bad_ok=1
for shape in missing corrupt ahead; do
  run_setup "rollback_$shape" --rollback-state >/dev/null 2>&1 || rollback_bad_ok=0
  state="$ROOT/rollback_$shape/home/.flywheel/quota-monitor-state.json"
  jq -e '.observedGeneration == 1 and (.lastSwitchAt|type == "number") and .reviveEpoch == null and (keys|index("blockedEpisode")|not)' "$state" >/dev/null 2>&1 \
    || rollback_bad_ok=0
done
if (( rollback_bad_ok == 1 )); then
  pass "rollback-state materializes conservative old state for missing/corrupt/ahead inputs"
else
  fail "rollback conservative materialization" "one or more invalid shapes failed"
fi

make_fixture rollback_symlink
printf 'do-not-touch\n' > "$ROOT/rollback_symlink/state-target"
ln -s "$ROOT/rollback_symlink/state-target" "$ROOT/rollback_symlink/home/.flywheel/quota-monitor-state.json"
if run_setup rollback_symlink --rollback-state >/dev/null 2>&1; then
  fail "rollback symlink refusal" "command exited zero"
elif [[ "$(cat "$ROOT/rollback_symlink/state-target")" == "do-not-touch" ]]; then
  pass "rollback-state refuses symlink state without touching its target"
else
  fail "rollback symlink refusal" "target mutated"
fi

make_fixture rotation
rotation_log="$ROOT/rotation/home/.flywheel/logs/quota-monitor.log"
mkdir -p "$(dirname "$rotation_log")"
(
  while true; do printf 'old-writer\n' >> "$rotation_log"; sleep 0.02; done
) &
old_writer=$!
printf '{"pid":%d,"uid":%d,"processStartTime":"fixture"}\n' "$old_writer" "$(id -u)" \
  > "$ROOT/rotation/home/.flywheel/quota-monitor.pid"
if FAKE_OLD_PID="$old_writer" run_setup rotation >/dev/null 2>&1; then
  size_before="$(wc -c < "$rotation_log.1" | tr -d ' ')"
  sleep 0.1
  size_after="$(wc -c < "$rotation_log.1" | tr -d ' ')"
  if ! kill -0 "$old_writer" 2>/dev/null && [[ "$size_before" == "$size_after" ]] \
    && grep -q 'old-writer' "$rotation_log.1"; then
    pass "setup stops the old writer before rotating one durable log generation"
  else
    fail "stop-before-rotate ordering" "alive=$(kill -0 "$old_writer" 2>/dev/null && echo yes || echo no) sizes=$size_before/$size_after"
  fi
else
  kill "$old_writer" 2>/dev/null || true
  fail "rotation setup" "setup exited non-zero"
fi

make_fixture monitor
if run_setup monitor --monitor-only >"$ROOT/monitor/setup.out" 2>&1 \
  && [[ "$(jq -r '.order | length' "$ROOT/monitor/home/.flywheel/quota-monitor.json")" == "0" ]] \
  && ! grep -q '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=' "$ROOT/monitor/home/.flywheel/.env" \
  && [[ ! -e "$ROOT/monitor/restart.log" ]] \
  && grep -q 'automatic account switching stays OFF' "$ROOT/monitor/setup.out" \
  && grep -q 'NO Bridge fallback' "$ROOT/monitor/setup.out"; then
  pass "--monitor-only is pure observation with no automatic switching fallback"
else
  fail "monitor-only" "config=$(cat "$ROOT/monitor/home/.flywheel/quota-monitor.json" 2>/dev/null); env=$(cat "$ROOT/monitor/home/.flywheel/.env" 2>/dev/null); output=$(cat "$ROOT/monitor/setup.out" 2>/dev/null)"
fi

make_fixture empty_enable
jq -n '{
  trigger5hPct:90,
  basePollMinutes:20,
  acceleratePct:70,
  acceleratedPollMinutes:10,
  candidateSweepMinutes:60,
  minSwitchIntervalMinutes:15,
  order:[],
  writeStatuslineCache:true
}' > "$ROOT/empty_enable/home/.flywheel/quota-monitor.json"
chmod 600 "$ROOT/empty_enable/home/.flywheel/quota-monitor.json"
if run_setup empty_enable >/dev/null 2>&1; then
  fail "empty enable order refuses CUTOVER" "setup exited zero"
elif [[ ! -e "$ROOT/empty_enable/restart.log" ]] \
  && ! grep -q '^bootstrap ' "$ROOT/empty_enable/launchctl.log" 2>/dev/null \
  && ! grep -q '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=' "$ROOT/empty_enable/home/.flywheel/.env"; then
  pass "default enable rejects monitor-only config before bootstrap/CUTOVER"
else
  fail "empty enable fail-closed" "launchctl=$(cat "$ROOT/empty_enable/launchctl.log" 2>/dev/null); restart=$(cat "$ROOT/empty_enable/restart.log" 2>/dev/null)"
fi

make_fixture invalid
rm -rf "$ROOT/invalid/pool/school"
if run_setup invalid >/dev/null 2>&1; then
  fail "invalid order target refuses startup" "setup exited zero"
elif [[ ! -e "$ROOT/invalid/restart.log" ]] \
  && ! grep -q '^bootstrap ' "$ROOT/invalid/launchctl.log" 2>/dev/null; then
  pass "missing pool target fails before bootstrap/CUTOVER"
else
  fail "invalid target fail-closed" "launchctl=$(cat "$ROOT/invalid/launchctl.log" 2>/dev/null); restart=$(cat "$ROOT/invalid/restart.log" 2>/dev/null)"
fi

make_fixture unsafe_plist
PLIST_DEST="$ROOT/unsafe_plist/home/Library/LaunchAgents/com.flywheel.quota-monitor.plist"
printf 'do-not-overwrite\n' > "$ROOT/unsafe_plist/plist-target"
ln -s "$ROOT/unsafe_plist/plist-target" "$PLIST_DEST"
if run_setup unsafe_plist >/dev/null 2>&1; then
  fail "symlinked plist destination refuses startup" "setup exited zero"
elif [[ "$(cat "$ROOT/unsafe_plist/plist-target")" == "do-not-overwrite" ]]; then
  pass "symlinked plist destination fails closed without clobbering target"
else
  fail "symlinked plist destination" "target was overwritten"
fi

default_env_before_disable="$(cat "$ROOT/default/home/.flywheel/.env")"
if run_setup default --disable >"$ROOT/default/disable.out" 2>&1 \
  && [[ "$(cat "$ROOT/default/home/.flywheel/.env")" == "$default_env_before_disable" ]] \
  && ! grep -q '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=' "$ROOT/default/home/.flywheel/.env" \
  && [[ ! -e "$ROOT/default/home/Library/LaunchAgents/com.flywheel.quota-monitor.plist" ]] \
  && [[ ! -e "$ROOT/default/restart.log" ]] \
  && grep -q 'automatic account switching is now OFF entirely' "$ROOT/default/disable.out" \
  && grep -q 'NO Bridge fallback' "$ROOT/default/disable.out"; then
  pass "--disable stops the daemon without mutating env or reviving Bridge fallback"
else
  fail "disable" "env=$(cat "$ROOT/default/home/.flywheel/.env"); restart=$(cat "$ROOT/default/restart.log" 2>/dev/null); output=$(cat "$ROOT/default/disable.out" 2>/dev/null)"
fi

if ! grep -q 'FLYWHEEL_QUOTA_DAEMON_CUTOVER' "$SETUP"; then
  pass "setup source no longer reads or writes the retired cutover flag"
else
  fail "retired flag residue" "setup still references FLYWHEEL_QUOTA_DAEMON_CUTOVER"
fi

echo ""
echo "[setup-quota-monitor.test] passed=$PASSED failed=$FAILED"
[[ "$FAILED" -eq 0 ]]
