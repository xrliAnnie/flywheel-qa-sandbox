#!/usr/bin/env bash
# FLY-1256 M6: hermetic install/enable + kill-switch tests.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

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
if run_setup default >/dev/null 2>&1; then
  order="$(jq -r '.order | join(",")' "$ROOT/default/home/.flywheel/quota-monitor.json")"
  if [[ "$order" == "shopping,school,alpha,zeta" ]]; then
    pass "default install enables founder order then alphabetical remainder"
  else
    fail "default order" "$order"
  fi
  if grep -q '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=1$' "$ROOT/default/home/.flywheel/.env" \
    && head -1 "$ROOT/default/restart.log" | grep -q '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=1$'; then
    pass "health succeeds before CUTOVER is persisted and Bridge restarted"
  else
    fail "cutover ordering" "env=$(cat "$ROOT/default/home/.flywheel/.env"); restart=$(cat "$ROOT/default/restart.log" 2>/dev/null)"
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

make_fixture monitor
if run_setup monitor --monitor-only >/dev/null 2>&1 \
  && [[ "$(jq -r '.order | length' "$ROOT/monitor/home/.flywheel/quota-monitor.json")" == "0" ]] \
  && ! grep -q '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=' "$ROOT/monitor/home/.flywheel/.env" \
  && [[ ! -e "$ROOT/monitor/restart.log" ]]; then
  pass "--monitor-only leaves order empty and does not retire legacy switcher"
else
  fail "monitor-only" "config=$(cat "$ROOT/monitor/home/.flywheel/quota-monitor.json" 2>/dev/null); env=$(cat "$ROOT/monitor/home/.flywheel/.env" 2>/dev/null)"
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

if run_setup default --disable >/dev/null 2>&1 \
  && ! grep -q '^FLYWHEEL_QUOTA_DAEMON_CUTOVER=' "$ROOT/default/home/.flywheel/.env" \
  && [[ ! -e "$ROOT/default/home/Library/LaunchAgents/com.flywheel.quota-monitor.plist" ]] \
  && tail -2 "$ROOT/default/restart.log" | grep -q -- '--bridge-only'; then
  pass "--disable stops daemon, removes plist/CUTOVER, and revives Bridge path"
else
  fail "kill switch" "env=$(cat "$ROOT/default/home/.flywheel/.env"); restart=$(cat "$ROOT/default/restart.log" 2>/dev/null)"
fi

echo ""
echo "[setup-quota-monitor.test] passed=$PASSED failed=$FAILED"
[[ "$FAILED" -eq 0 ]]
