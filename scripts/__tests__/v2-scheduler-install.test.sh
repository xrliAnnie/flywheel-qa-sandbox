#!/bin/bash
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL="$REPO_ROOT/scripts/install-v2-scheduler.sh"
TMP="$(mktemp -d -t fly1501-scheduler-install-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
HOME_DIR="$TMP/home"
LAUNCHD_DIR="$TMP/launchd"
CALLS="$TMP/calls"
TRIGGERED="$TMP/triggered"
mkdir -p "$BIN" "$HOME_DIR" "$LAUNCHD_DIR"

cat > "$BIN/launchctl" <<EOF
#!/bin/bash
echo "launchctl \$*" >> "$CALLS"
case "\$1" in
  kickstart) touch "$TRIGGERED" ;;
esac
exit 0
EOF
chmod +x "$BIN/launchctl"

CLI="$TMP/fake-cli.js"
cat > "$CLI" <<EOF
if (process.argv.includes("--check-receipt-after") && require("node:fs").existsSync("$TRIGGERED")) {
  process.exit(0);
}
process.exit(1);
EOF

DB="$TMP/flywheel-v2.db"
LOG="$TMP/scheduler.log"
if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_LAUNCHD_DIR="$LAUNCHD_DIR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd \
    "$INSTALL" --project flywheel --db "$DB" --cli "$CLI" \
      --gate-bin "$REPO_ROOT/scripts/restart-storm-gate.py" --log "$LOG" \
      >"$TMP/out" 2>"$TMP/err" \
  && grep -q "StartInterval</key><integer>60" "$LAUNCHD_DIR/com.flywheel.v2-scheduler.plist" \
  && grep -q "launchctl bootstrap" "$CALLS" \
  && grep -q "launchctl print" "$CALLS" \
  && grep -q "launchctl kickstart" "$CALLS" \
  && grep -q "self-proof passed" "$TMP/out"; then
  pass "unique launchd timer installs, loads, triggers, and proves a receipt"
else
  fail "launchd install contract: out=$(cat "$TMP/out") err=$(cat "$TMP/err") calls=$(cat "$CALLS" 2>/dev/null)"
fi

if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_SUPERVISOR_BACKEND=systemd-user \
    "$INSTALL" --project flywheel --db "$DB" --cli "$CLI" \
      --gate-bin "$REPO_ROOT/scripts/restart-storm-gate.py" --log "$LOG" \
      >"$TMP/out2" 2>"$TMP/err2"; then
  fail "unsupported parallel/fallback backend was accepted"
else
  pass "non-launchd backend fails loud; no fallback starts"
fi

echo "v2-scheduler-install.test: $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]]
