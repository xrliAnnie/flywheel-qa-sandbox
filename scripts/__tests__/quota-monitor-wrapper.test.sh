#!/usr/bin/env bash
# FLY-1256 M6: hermetic contract tests for the launchd wrapper + plist.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
WRAPPER="$REPO_DIR/scripts/flywheel-quota-monitor-wrapper.sh"
PLIST="$REPO_DIR/scripts/com.flywheel.quota-monitor.plist.template"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1256-wrapper.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

if [[ -f "$WRAPPER" ]] && bash -n "$WRAPPER"; then
  pass "wrapper exists and parses"
else
  fail "wrapper exists and parses" "$WRAPPER"
fi

mkdir -p "$ROOT/home/.flywheel" "$ROOT/bin" "$ROOT/state"
cat > "$ROOT/home/.flywheel/.env" <<'EOF'
FLYWHEEL_QUOTA_MONITOR_CONFIG=from-dot-env
FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE=from-dot-env-service
FLYWHEEL_NOTIFY_CHANNEL=from-dot-env-notification
EOF
cat > "$ROOT/bin/fake-monitor" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "${FLYWHEEL_QUOTA_MONITOR_CONFIG:-}" "${FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE:-}" > "$FAKE_MONITOR_LOG"
EOF
cat > "$ROOT/bin/fake-alert" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_ALERT_LOG"
printf 'sent\n'
EOF
chmod +x "$ROOT/bin/fake-monitor" "$ROOT/bin/fake-alert"
touch "$ROOT/dist.js"

COMMON_ENV=(
  HOME="$ROOT/home"
  FLYWHEEL_DIR="$REPO_DIR"
  FLYWHEEL_QUOTA_MONITOR_BIN="$ROOT/bin/fake-monitor"
  FLYWHEEL_QUOTA_MONITOR_DIST="$ROOT/dist.js"
  FLYWHEEL_QUOTA_RUN_MARKER="$ROOT/state/running.json"
  FLYWHEEL_QUOTA_CRASH_STREAK="$ROOT/state/crashes"
  FLYWHEEL_LEAD_ALERT_BIN="$ROOT/bin/fake-alert"
  FAKE_MONITOR_LOG="$ROOT/monitor.log"
  FAKE_ALERT_LOG="$ROOT/alerts.log"
)

if env "${COMMON_ENV[@]}" FLYWHEEL_QUOTA_MONITOR_CONFIG=from-process \
    bash "$WRAPPER" >/dev/null 2>&1 \
    && [[ "$(cat "$ROOT/monitor.log" 2>/dev/null)" == "from-process|from-dot-env-service" ]]; then
  pass "process FLYWHEEL_QUOTA_* wins while missing FLYWHEEL_CLAUDE_* loads from .env"
else
  fail "environment precedence" "got=$(cat "$ROOT/monitor.log" 2>/dev/null || echo missing)"
fi

cat > "$ROOT/missing-notify.env" <<'EOF'
FLYWHEEL_QUOTA_MONITOR_CONFIG=from-missing-notify-env
FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE=from-missing-notify-env-service
EOF
rm -f "$ROOT/monitor.log" "$ROOT/alerts.log"
if env "${COMMON_ENV[@]}" FLYWHEEL_NOTIFY_CHANNEL="" \
    FLYWHEEL_QUOTA_ENV_FILE="$ROOT/missing-notify.env" \
    bash "$WRAPPER" >/dev/null 2>&1; then
  fail "missing notification route fails before exec" "wrapper exited zero"
elif grep -q -- '--kind quota_monitor_down' "$ROOT/alerts.log" 2>/dev/null \
  && grep -q -- '--strict-delivery' "$ROOT/alerts.log" 2>/dev/null \
  && [[ ! -f "$ROOT/monitor.log" ]]; then
  pass "missing notification route emits strict quota_monitor_down before failing"
else
  fail "missing notification route fail-loud" "alert=$(cat "$ROOT/alerts.log" 2>/dev/null || echo missing) monitor=$(cat "$ROOT/monitor.log" 2>/dev/null || echo absent)"
fi

rm -f "$ROOT/alerts.log"
if env "${COMMON_ENV[@]}" FLYWHEEL_QUOTA_MONITOR_DIST="$ROOT/missing.js" \
    bash "$WRAPPER" >/dev/null 2>&1; then
  fail "missing dist fails before exec" "wrapper exited zero"
elif grep -q -- '--kind quota_monitor_down' "$ROOT/alerts.log" 2>/dev/null \
  && grep -q -- '--strict-delivery' "$ROOT/alerts.log" 2>/dev/null; then
  pass "missing dist emits strict quota_monitor_down before failing"
else
  fail "missing dist fail-loud" "alert=$(cat "$ROOT/alerts.log" 2>/dev/null || echo missing)"
fi

rm -f "$ROOT/alerts.log"
printf '{"pid":999,"bootedAt":1}\n' > "$ROOT/state/running.json"
if env "${COMMON_ENV[@]}" FLYWHEEL_QUOTA_CRASH_THRESHOLD=1 \
    bash "$WRAPPER" >/dev/null 2>&1 \
    && grep -q 'crash-loop' "$ROOT/alerts.log" 2>/dev/null; then
  pass "residual durable marker increments streak and pages at threshold"
else
  fail "crash-loop page" "alert=$(cat "$ROOT/alerts.log" 2>/dev/null || echo missing)"
fi

if [[ -f "$PLIST" ]] \
  && grep -q '<string>com.flywheel.quota-monitor</string>' "$PLIST" \
  && grep -q '<key>KeepAlive</key><true/>' "$PLIST" \
  && grep -q '<key>RunAtLoad</key><true/>' "$PLIST" \
  && grep -q '<key>ThrottleInterval</key><integer>30</integer>' "$PLIST" \
  && grep -q '__HOME__/.flywheel/logs/quota-monitor.log' "$PLIST" \
  && grep -q '__HOME__' "$PLIST"; then
  pass "plist pins KeepAlive and durable tokenized-HOME log contract"
else
  fail "plist contract" "$PLIST"
fi

echo ""
echo "[quota-monitor-wrapper.test] passed=$PASSED failed=$FAILED"
[[ "$FAILED" -eq 0 ]]
