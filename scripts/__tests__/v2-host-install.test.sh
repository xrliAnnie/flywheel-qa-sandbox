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

# FLY-1503 MEDIUM-1: the installer now proves the REAL host parser accepts the
# config before anything is bounced, so this test must use the real host module.
# The old fake host never parsed a config, which is why a config the production host
# rejects outright still produced a green install test -- a false green that would
# have taken the engine down on the next restart.
REPO_ROOT_FOR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST_CLI="$REPO_ROOT_FOR_TEST/packages/v2-host/dist/cli.js"
if [[ ! -f "$HOST_CLI" ]]; then
  # FLY-1550 (Codex R1 MEDIUM-5): in CI the build step precedes this suite, so
  # a missing dist is a broken pipeline and must FAIL — a skip would read as
  # green coverage that never ran.
  if [[ "${CI:-}" == "true" ]]; then
    echo "FAIL: packages/v2-host/dist/cli.js missing in CI — the build step must precede this suite" >&2
    exit 1
  fi
  echo "SKIP: build packages/v2-host before running this suite" >&2
  exit 0
fi
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
CREDENTIALS="$TMP/claude-credentials.json"
LOG="$TMP/host.log"
touch "$DB" "$MARKER" "$AUTHORITY" "$ARMED"
printf 'test-secret\n' > "$SECRET"
chmod 600 "$SECRET"
# FLY-1550: no claude_credentials / injection_root -- runners share ~/.claude.
cat > "$RUNTIME" <<EOF
{
  "v": 1,
  "dispatch_interval_ms": 1000,
  "lock_root": "$TMP/runtime/locks",
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

# FLY-1503 MEDIUM-1 / FLY-1550: the exact config shape that would take production
# down -- now the PRE-FLY-1550 launcher section that still carries
# claude_credentials. The installer must refuse it, name the stale field, and
# never reach launchd.
LEGACY_RUNTIME="$TMP/runtime-legacy.json"
printf '{"claudeAiOauth":{"accessToken":"install-test-token"}}\n' > "$CREDENTIALS"
chmod 600 "$CREDENTIALS"
jq --arg cred "$CREDENTIALS" \
  '.launcher.claude_credentials = $cred | .injection_root = "/tmp/v2-injection"' \
  "$RUNTIME" > "$LEGACY_RUNTIME"
chmod 600 "$LEGACY_RUNTIME"
LEGACY_LAUNCHD_DIR="$TMP/launchd-legacy"
mkdir -p "$LEGACY_LAUNCHD_DIR"
: > "$CALLS"
LEGACY_COMMON=(
  --window window-1 --epoch 1 --host-epoch host-1
  --db "$DB" --marker "$MARKER" --authority "$AUTHORITY" --armed "$ARMED"
  --socket "$SOCKET" --secret "$SECRET" --session-proof-root "$PROOFS"
  --runtime-config "$LEGACY_RUNTIME" --host-cli "$HOST_CLI" --client-cli "$CLIENT_CLI"
  --log "$LOG"
)
if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_LAUNCHD_DIR="$LEGACY_LAUNCHD_DIR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd \
    "$INSTALL" "${LEGACY_COMMON[@]}" >"$TMP/legacy-out" 2>"$TMP/legacy-err"; then
  fail "installer accepted a runtime config the real host rejects"
elif ! grep -q "claude_credentials" "$TMP/legacy-err"; then
  fail "installer refused the pre-upgrade config without naming claude_credentials: $(cat "$TMP/legacy-err")"
elif grep -q "launchctl bootstrap" "$CALLS"; then
  fail "installer reached launchd with a config the real host rejects"
else
  pass "installer refuses a pre-upgrade runtime config before touching launchd"
fi

# --validate-only proves a good config without installing anything, so an operator
# can check before restarting a live host.
VALIDATE_LAUNCHD_DIR="$TMP/launchd-validate"
mkdir -p "$VALIDATE_LAUNCHD_DIR"
: > "$CALLS"
if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_LAUNCHD_DIR="$VALIDATE_LAUNCHD_DIR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd \
    "$INSTALL" "${COMMON[@]}" --validate-only >"$TMP/validate-out" 2>"$TMP/validate-err" \
  && ! grep -q "launchctl bootstrap" "$CALLS" \
  && [[ ! -f "$VALIDATE_LAUNCHD_DIR/com.flywheel.v2-engine.plist" ]]; then
  pass "--validate-only accepts a good config without installing"
else
  fail "--validate-only contract: out=$(cat "$TMP/validate-out") err=$(cat "$TMP/validate-err")"
fi

# FLY-1550: --migrate-fly1550 atomically rewrites a pre-upgrade config into the
# accepted shape; the SAME exact-key gates and the real host parser then
# validate the migrated file, making the documented deploy sequence executable
# against a live installation (no hand-editing required).
MIGRATE_RUNTIME="$TMP/runtime-migrate.json"
cp "$LEGACY_RUNTIME" "$MIGRATE_RUNTIME"
chmod 600 "$MIGRATE_RUNTIME"
MIGRATE_LAUNCHD_DIR="$TMP/launchd-migrate"
mkdir -p "$MIGRATE_LAUNCHD_DIR"
: > "$CALLS"
MIGRATE_COMMON=(
  --window window-1 --epoch 1 --host-epoch host-1
  --db "$DB" --marker "$MARKER" --authority "$AUTHORITY" --armed "$ARMED"
  --socket "$SOCKET" --secret "$SECRET" --session-proof-root "$PROOFS"
  --runtime-config "$MIGRATE_RUNTIME" --host-cli "$HOST_CLI" --client-cli "$CLIENT_CLI"
  --log "$LOG"
)
if env HOME="$HOME_DIR" PATH="$BIN:$PATH" \
    FLYWHEEL_LAUNCHD_DIR="$MIGRATE_LAUNCHD_DIR" \
    FLYWHEEL_SUPERVISOR_BACKEND=launchd \
    "$INSTALL" "${MIGRATE_COMMON[@]}" --validate-only --migrate-fly1550 \
    >"$TMP/migrate-out" 2>"$TMP/migrate-err"; then
  if jq -e 'has("injection_root") or (.launcher | has("claude_credentials"))' "$MIGRATE_RUNTIME" >/dev/null; then
    fail "--migrate-fly1550 left retired keys behind: $(cat "$MIGRATE_RUNTIME")"
  elif [[ "$(stat -f %Lp "$MIGRATE_RUNTIME" 2>/dev/null || stat -c %a "$MIGRATE_RUNTIME")" != "600" ]]; then
    fail "--migrate-fly1550 dropped the 0600 mode on the migrated config"
  else
    pass "--migrate-fly1550 rewrites a pre-upgrade config to the accepted shape (proved by --validate-only)"
  fi
else
  fail "--migrate-fly1550 + --validate-only rejected the migrated config: $(cat "$TMP/migrate-err")"
fi

echo "v2-host-install.test: $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]]
