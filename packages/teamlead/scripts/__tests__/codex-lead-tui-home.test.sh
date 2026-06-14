#!/bin/bash
# FLY-259 PR-B — codex-lead-tui-home.sh tests (PATH-injected mock codex,
# same pattern as codex-lead-cmux-window.test.sh). Run with /bin/bash.

set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/codex-lead-tui-home.sh"
T=$(mktemp -d /tmp/clt.XXXXX); trap 'rm -rf "$T"' EXIT

# mock codex: records argv; remote-control start creates the socket dir+file
mkdir -p "$T/bin"
cat > "$T/bin/codex" <<'EOF'
#!/bin/bash
echo "$@" >> "$MOCK_LOG"
if [ "$1" = "remote-control" ] && [ "$2" = "start" ]; then
  mkdir -p "$CODEX_HOME/app-server-control"
  SOCK="$CODEX_HOME/app-server-control/app-server-control.sock"
  [ -e "$SOCK" ] || python3 -c "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])" "$SOCK"
  echo '{"status":"connected"}'
fi
EOF
chmod +x "$T/bin/codex"
export MOCK_LOG="$T/mock.log"

fresh_home() {
  local h="$T/home-$1"; rm -rf "$h"; mkdir -p "$h"
  echo '{"tokens":"x"}' > "$h/auth.json"
  mkdir -p "$h/packages/standalone/current"
  printf '#!/bin/sh\n' > "$h/packages/standalone/current/codex"
  chmod +x "$h/packages/standalone/current/codex"
  echo "$h"
}

# ── ensure-home happy path: pins written, trust added, idempotent ──────────
H=$(fresh_home 1)
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  pass "ensure-home succeeds on a provisioned home"
else
  fail "ensure-home should succeed on a provisioned home"
fi
command grep -q 'sandbox_mode = "read-only"' "$H/config.toml" && pass "sandbox pin written" || fail "sandbox pin missing"
command grep -q 'approval_policy = "never"' "$H/config.toml" && pass "approval pin written" || fail "approval pin missing"
command grep -q 'projects."/work/dir"' "$H/config.toml" && pass "cwd trusted" || fail "cwd trust missing"
BEFORE=$(cat "$H/config.toml")
FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" /bin/bash "$SUT" ensure-home >/dev/null 2>&1
[ "$BEFORE" = "$(cat "$H/config.toml")" ] && pass "idempotent re-run (config unchanged)" || fail "re-run mutated config"

# ── fail-close: drifted pre-existing config (write-capable) ────────────────
H=$(fresh_home 2)
printf 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n' > "$H/config.toml"
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  fail "drifted sandbox config must fail-close"
else
  pass "drifted sandbox config fails closed (HIGH-1 transplant)"
fi

# ── fail-loud: missing auth / missing standalone ────────────────────────────
H="$T/home-noauth"; mkdir -p "$H"
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  fail "missing auth.json must fail"
else
  pass "missing auth.json fails loud (never copies credentials)"
fi
H="$T/home-nostandalone"; mkdir -p "$H"; echo '{}' > "$H/auth.json"
OUT=$(FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
echo "$OUT" | command grep -q "rc=1" && echo "$OUT" | command grep -q "standalone" \
  && pass "missing standalone fails loud with install instructions" \
  || fail "missing standalone should fail with instructions; got: $OUT"

# ── ensure-daemon: explicit FLYWHEEL_CODEX_BIN override path (MED-6 keeps it) ─
H=$(fresh_home 3)
: > "$MOCK_LOG"
if FLYWHEEL_CODEX_BIN="$T/bin/codex" FLYWHEEL_CODEX_TUI_HOME="$H" /bin/bash "$SUT" ensure-daemon >/dev/null 2>&1; then
  pass "ensure-daemon starts and verifies the control socket (explicit bin override)"
else
  fail "ensure-daemon should succeed with explicit mock codex override"
fi
command grep -q "remote-control start --json" "$MOCK_LOG" && pass "daemon started via remote-control start" || fail "remote-control start not invoked"


# ── code review R1 HIGH-3: TOML comment bypass must fail closed ─────────────
H=$(fresh_home 4)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "danger-full-access" # sandbox_mode = "read-only"
approval_policy = "on-request" # approval_policy = "never"
TOML
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  fail "HIGH-3: comment-bypass config must fail-close"
else
  pass "HIGH-3: comment-bypass config fails closed (TOML-parsed effective values)"
fi
H=$(fresh_home 5)
printf 'sandbox_mode = [broken\n' > "$H/config.toml"
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  fail "HIGH-3: unparseable config must fail-close"
else
  pass "HIGH-3: unparseable config fails closed"
fi

# ── code review R1 MED-6: ensure-daemon defaults to the standalone binary ──
H=$(fresh_home 6)
cat > "$H/packages/standalone/current/codex" <<'EOF2'
#!/bin/bash
echo "standalone $@" >> "$MOCK_LOG"
if [ "$1" = "remote-control" ]; then
  mkdir -p "$CODEX_HOME/app-server-control"
  S="$CODEX_HOME/app-server-control/app-server-control.sock"
  [ -e "$S" ] || python3 -c "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])" "$S"
  echo '{"status":"connected"}'
fi
EOF2
chmod +x "$H/packages/standalone/current/codex"
: > "$MOCK_LOG"
if FLYWHEEL_CODEX_TUI_HOME="$H" /bin/bash "$SUT" ensure-daemon >/dev/null 2>&1; then
  pass "MED-6: ensure-daemon runs with no FLYWHEEL_CODEX_BIN (standalone default)"
else
  fail "MED-6: ensure-daemon should default to the standalone binary"
fi
command grep -q "^standalone remote-control" "$MOCK_LOG" && pass "MED-6: the STANDALONE binary was invoked (not PATH codex)" || fail "MED-6: standalone binary not used; log: $(cat "$MOCK_LOG")"

# ── R2 MED-4: explicit non-trusted entry fails loud; grep-bypass comment safe ──
H=$(fresh_home 7)
FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
[projects."/w"]
trust_level = "untrusted"
TOML
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  fail "R2 MED-4: explicit untrusted entry must fail loud"
else
  pass "R2 MED-4: explicit untrusted entry fails loud (effective TOML state)"
fi
H=$(fresh_home 8)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
# projects."/w" mentioned only in this comment
TOML
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1 \
   && python3 -c "import tomllib,sys; cfg=tomllib.load(open(sys.argv[1],'rb')); sys.exit(0 if (cfg.get('projects') or {}).get('/w',{}).get('trust_level')=='trusted' else 1)" "$H/config.toml"; then
  pass "R2 MED-4: comment mention doesn't fool the trust check — entry appended"
else
  fail "R2 MED-4: comment-mentioned dir should still get a real trust entry"
fi

# ── R3 MED-2: existing project table WITHOUT trust_level must fail loud ─────
H=$(fresh_home 9)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
[projects."/w"]
TOML
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  fail "R3 MED-2: empty existing project table must fail loud (duplicate-table hazard)"
else
  pass "R3 MED-2: empty existing project table fails loud"
fi

# ── R4 MED-1: non-table `projects` must fail closed ─────────────────────────
H=$(fresh_home 10)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
projects = "invalid-schema"
TOML
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  fail "R4 MED-1: scalar projects must fail closed"
else
  pass "R4 MED-1: scalar projects fails closed"
fi
echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
