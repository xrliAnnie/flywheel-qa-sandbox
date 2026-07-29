#!/bin/bash
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL="$REPO_ROOT/scripts/install-v2-host.sh"
TMP="$(mktemp -d -t fly1502-host-install-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
HOME_DIR="$TMP/home"
LAUNCHD_DIR="$TMP/launchd"
CALLS="$TMP/calls"
BOOTSTRAPPED="$TMP/bootstrapped"
mkdir -p "$BIN" "$HOME_DIR" "$LAUNCHD_DIR" "$TMP/runtime"

cat > "$BIN/launchctl" <<EOF
#!/bin/bash
echo "launchctl \$*" >> "$CALLS"
case "\$1" in
  bootstrap) touch "$BOOTSTRAPPED" ;;
esac
exit 0
EOF
chmod +x "$BIN/launchctl"

HOST_CLI="$TMP/fake-host.js"
cat > "$HOST_CLI" <<'EOF'
process.exit(1);
EOF
CLIENT_CLI="$TMP/fake-client.js"
cat > "$CLIENT_CLI" <<EOF
if (process.argv.includes("health") && require("node:fs").existsSync("$BOOTSTRAPPED")) {
  process.stdout.write('{"status":"ok","authorityState":"cutover"}\\n');
  process.exit(0);
}
process.exit(1);
EOF

DB="$TMP/flywheel-v2.db"
MARKER="$TMP/migration-complete.json"
AUTHORITY="$TMP/cutover-authority.json"
ARMED="$TMP/cutover-armed.json"
SOCKET="$TMP/v2.sock"
SECRET="$TMP/host.secret"
PROOFS="$TMP/session-proofs"
RUNTIME="$TMP/runtime.json"
LOG="$TMP/host.log"
touch "$DB" "$MARKER" "$AUTHORITY" "$ARMED"
printf 'test-secret\n' > "$SECRET"
chmod 600 "$SECRET"
cat > "$RUNTIME" <<EOF
{
  "v": 1,
  "dispatch_interval_ms": 1000,
  "lock_root": "$TMP/runtime/locks",
  "injection_root": "$TMP/runtime/injections",
  "launcher": {
    "kind": "tmux",
    "tmux_bin": "/bin/echo",
    "claude_bin": "/bin/echo",
    "codex_bin": "/bin/echo",
    "client_cli": "$CLIENT_CLI",
    "release_root": "$TMP/runtime/release",
    "state_root": "$TMP/runtime/runner-state"
  },
  "git_bin": "/usr/bin/git",
  "gh_bin": "/usr/bin/true"
}
EOF
chmod 600 "$RUNTIME"

COMMON=(
  --window window-1 --epoch 1 --host-epoch host-1
  --db "$DB" --marker "$MARKER" --authority "$AUTHORITY" --armed "$ARMED"
  --socket "$SOCKET" --secret "$SECRET" --session-proof-root "$PROOFS"
  --runtime-config "$RUNTIME" --host-cli "$HOST_CLI" --client-cli "$CLIENT_CLI"
  --log "$LOG"
)

if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_LAUNCHD_DIR="$LAUNCHD_DIR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd \
    "$INSTALL" "${COMMON[@]}" >"$TMP/out" 2>"$TMP/err" \
  && grep -q "com.flywheel.v2-engine" "$LAUNCHD_DIR/com.flywheel.v2-engine.plist" \
  && grep -q -- "--runtime-config</string>" "$LAUNCHD_DIR/com.flywheel.v2-engine.plist" \
  && grep -q "<key>KeepAlive</key><true/>" "$LAUNCHD_DIR/com.flywheel.v2-engine.plist" \
  && grep -q "launchctl bootstrap" "$CALLS" \
  && grep -q "launchctl print" "$CALLS" \
  && grep -q "held/live health proof passed" "$TMP/out"; then
  pass "launchd host installs held, stays resident, and proves authenticated health"
else
  fail "launchd host install contract: out=$(cat "$TMP/out") err=$(cat "$TMP/err") calls=$(cat "$CALLS" 2>/dev/null)"
fi

DEFAULT_LAUNCHD_DIR="$TMP/launchd-default"
mkdir -p "$DEFAULT_LAUNCHD_DIR"
if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_LAUNCHD_DIR="$DEFAULT_LAUNCHD_DIR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd \
    "$INSTALL" \
      --window window-1 --epoch 1 --host-epoch host-1 \
      --db "$DB" --marker "$MARKER" --authority "$AUTHORITY" \
      --socket "$SOCKET" --secret "$SECRET" --session-proof-root "$PROOFS" \
      --runtime-config "$RUNTIME" --host-cli "$HOST_CLI" --client-cli "$CLIENT_CLI" \
      --log "$LOG" >"$TMP/default-out" 2>"$TMP/default-err" \
  && grep -q "$HOME_DIR/.flywheel/v2-cutover-armed" \
    "$DEFAULT_LAUNCHD_DIR/com.flywheel.v2-engine.plist" \
  && ! grep -q "$HOME_DIR/.flywheel/v2-cutover-armed.json" \
    "$DEFAULT_LAUNCHD_DIR/com.flywheel.v2-engine.plist"; then
  pass "default armed sentinel matches the kernel authority path"
else
  fail "host default armed sentinel drifted: $(cat "$DEFAULT_LAUNCHD_DIR/com.flywheel.v2-engine.plist" 2>/dev/null)"
fi

chmod 644 "$SECRET"
if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_LAUNCHD_DIR="$LAUNCHD_DIR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd \
    "$INSTALL" "${COMMON[@]}" >"$TMP/out2" 2>"$TMP/err2"; then
  fail "world-readable host secret was accepted"
else
  pass "host secret must already be exactly 0600"
fi
chmod 600 "$SECRET"

if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_SUPERVISOR_BACKEND=systemd-user \
    "$INSTALL" "${COMMON[@]}" >"$TMP/out3" 2>"$TMP/err3"; then
  fail "unsupported parallel/fallback backend was accepted"
else
  pass "non-launchd backend fails loud; no fallback starts"
fi

echo "v2-host-install.test: $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]]
