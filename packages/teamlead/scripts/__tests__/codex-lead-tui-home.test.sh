#!/bin/bash
# shellcheck disable=SC2015  # test assertions intentionally use cmd && pass || fail
# FLY-259 PR-B — codex-lead-tui-home.sh tests (PATH-injected mock codex,
# same pattern as codex-lead-cmux-window.test.sh). Run with /bin/bash.

set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# Hermetic baseline: a Lead/runner parent may carry full-access profile and a
# global binary override, but the default-path cases below must exercise the
# companion home and its isolated standalone binary.
unset FLYWHEEL_CODEX_LEAD_PROFILE FLYWHEEL_CODEX_BIN \
  FLYWHEEL_LEAD_ID FLYWHEEL_PROJECT_NAME \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID FLYWHEEL_LEAD_CORE_CHANNEL_ID \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS FLYWHEEL_ROUNDTABLE_CHANNEL_ID \
  FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS FLYWHEEL_LEAD_ACTIONS_NODE_BIN \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR FLYWHEEL_COMM_DB

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

toml_table_block() {
  python3 - "$1" "$2" <<'PYTABLE'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read().splitlines(keepends=True)
target = f"[{sys.argv[2]}]"
start = None
for index, line in enumerate(text):
    if line.split("#", 1)[0].strip() == target:
        start = index
        break
if start is None:
    sys.exit(1)
end = len(text)
for index in range(start + 1, len(text)):
    if re.match(r"^[ \t]*\[", text[index]):
        end = index
        break
block = text[start:end]
while block and (not block[-1].strip() or block[-1].lstrip().startswith("#")):
    block.pop()
sys.stdout.write("".join(block).rstrip("\r\n"))
PYTABLE
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
python3 -c "import tomllib,sys; c=tomllib.load(open(sys.argv[1],'rb')); sys.exit(0 if c.get('notice',{}).get('hide_rate_limit_model_nudge') is True else 1)" "$H/config.toml" \
  && pass "FLY-2296: read-only home hides the rate-limit model nudge" \
  || fail "FLY-2296: read-only home notice pin missing"
python3 -c "import tomllib,sys; c=tomllib.load(open(sys.argv[1],'rb')); sys.exit(0 if c.get('features',{}).get('memories') is True and c.get('memories',{}).get('dedicated_tools') is True else 1)" "$H/config.toml" \
  && pass "FLY-2357: read-only home pins memory master switch and dedicated tools in separate tables" \
  || fail "FLY-2357: read-only home memory pins missing or misplaced"
BEFORE=$(cat "$H/config.toml")
FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" /bin/bash "$SUT" ensure-home >/dev/null 2>&1
[ "$BEFORE" = "$(cat "$H/config.toml")" ] && pass "idempotent re-run (config unchanged)" || fail "re-run mutated config"

# ── FLY-2357: validate both tables before appending either one ─────────────
H=$(fresh_home 2357-readonly-atomic)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
[projects."/w"]
trust_level = "trusted"
[memories]
dedicated_tools = false
[notice]
hide_rate_limit_model_nudge = true
TOML
BEFORE=$(cat "$H/config.toml")
OUT=$(FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -Fq "[memories] dedicated_tools = true" <<< "$OUT" \
  && [ "$BEFORE" = "$(cat "$H/config.toml")" ] \
  && pass "FLY-2357: read-only memory drift fails before either table is appended" \
  || fail "FLY-2357: read-only drift must leave both memory tables unchanged; got: $OUT"

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

# ── FLY-2296: explicit notice drift fails loud; never silently changes choice ──
H=$(fresh_home 11)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
[notice]
hide_rate_limit_model_nudge = false
TOML
OUT=$(FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -q "Rate-limit model-switch menu is explicitly enabled" <<< "$OUT" \
  && command grep -Fq "$H/config.toml" <<< "$OUT" \
  && command grep -q "hide_rate_limit_model_nudge = true" <<< "$OUT" \
  && pass "FLY-2296: explicit false notice pin fails loud with repair guidance" \
  || fail "FLY-2296: explicit false notice pin should fail with repair guidance; got: $OUT"

# ── FLY-2296: an existing true pin is accepted byte-for-byte ──────────────
H=$(fresh_home 12)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
[projects."/w"]
trust_level = "trusted"
[features]
memories = true
[memories]
dedicated_tools = true
[notice]
hide_rate_limit_model_nudge = true
TOML
BEFORE=$(cat "$H/config.toml")
if FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home >/dev/null 2>&1 \
   && [ "$BEFORE" = "$(cat "$H/config.toml")" ]; then
  pass "FLY-2296: existing true notice pin is accepted unchanged"
else
  fail "FLY-2296: existing true notice pin should be unchanged"
fi

# ── FLY-2296: existing notice shapes that cannot be appended fail loud ────
H=$(fresh_home 13)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
[notice]
hide_full_access_warning = true
TOML
OUT=$(FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -q "already has a \[notice\] table without" <<< "$OUT" \
  && command grep -Fq "$H/config.toml" <<< "$OUT" \
  && command grep -q "hide_rate_limit_model_nudge = true" <<< "$OUT" \
  && pass "FLY-2296: existing unpinned notice table fails loud" \
  || fail "FLY-2296: existing unpinned notice table should fail loud; got: $OUT"

H=$(fresh_home 14)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
notice = {}
TOML
OUT=$(FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -q "already has a \[notice\] table without" <<< "$OUT" \
  && command grep -Fq "$H/config.toml" <<< "$OUT" \
  && command grep -q "hide_rate_limit_model_nudge = true" <<< "$OUT" \
  && pass "FLY-2296: inline notice table fails loud instead of appending" \
  || fail "FLY-2296: inline notice table should fail loud; got: $OUT"

H=$(fresh_home 15)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "read-only"
approval_policy = "never"
notice = "invalid-schema"
TOML
OUT=$(FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/w" /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -q "Cannot parse" <<< "$OUT" \
  && command grep -Fq "$H/config.toml" <<< "$OUT" \
  && command grep -q "hide_rate_limit_model_nudge = true" <<< "$OUT" \
  && pass "FLY-2296: invalid notice schema fails loud with parse and repair guidance" \
  || fail "FLY-2296: invalid notice schema should fail with guidance; got: $OUT"
# ── companion ensure-daemon: start only, NO stop (byte-compat) ─────────────
H=$(fresh_home 23); : > "$MOCK_LOG"
FLYWHEEL_CODEX_BIN="$T/bin/codex" FLYWHEEL_CODEX_TUI_HOME="$H" /bin/bash "$SUT" ensure-daemon >/dev/null 2>&1
! command grep -q "remote-control stop" "$MOCK_LOG" && pass "flag-off ensure-daemon: NO stop (byte-compat)" || fail "flag-off ensure-daemon: must not stop the daemon"

GATE_JS="$SCRIPT_DIR/../dist/lead-backends/codex/lead-actions/mcp-config.js"
RUNTIME_JS="$SCRIPT_DIR/../dist/lead-backends/codex/codex-lead-runtime.js"

# FLY-1942: only an explicit roundtable parent enables the marker; cross-dept
# routing alone is not subscription authority. Exercise rendered config.toml.
rt_marker_case() {
  local n="$1" desc="$2" expect="$3"
  shift 3
  local H
  H=$(fresh_home "rt-$n")
  env "$@" FLYWHEEL_CODEX_LEAD_PROFILE=full-access \
    FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
    FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
    FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1500600400238084307" \
    FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" \
    FLYWHEEL_COMM_DB="/state/comm.db" \
    FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
    /bin/bash "$SUT" ensure-home >/dev/null 2>&1 || { fail "$desc: ensure-home failed"; return; }
  if [ "$expect" = "1" ]; then
    command grep -q 'FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE = "1"' "$H/config.toml" \
      && pass "$desc" || fail "$desc (marker expected, absent)"
  else
    ! command grep -q 'FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE' "$H/config.toml" \
      && pass "$desc" || fail "$desc (marker NOT expected, present)"
  fi
}

rt_marker_case 1 "FLY-1942: legacy flag + cross-dept without explicit parent → no marker" 0 \
  FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD=1 \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=1512578695468941333
rt_marker_case 2 "FLY-1942: cross-dept without explicit parent → no marker" 0 \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=1512578695468941333
rt_marker_case 3 "FLY-1942: no parent → no marker" 0
rt_marker_case 4 "FLY-1942: explicit parent → marker present" 1 \
  FLYWHEEL_ROUNDTABLE_CHANNEL_ID=1512578695468941333 \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=1512578695468941333
rt_marker_case 5 "FLY-1942: empty-leading cross list without explicit parent → no marker" 0 \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=" ,1512578695468941333"
rt_marker_case 6 "FLY-1942: chat-only cross-dept without explicit parent → no marker" 0 \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=1500600400238084307
rt_marker_case 7 "FLY-1942: chat + cross-dept without explicit parent → no marker" 0 \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=1500600400238084307,1512578695468941333
rt_marker_case 8 "FLY-1942: whitespace-only explicit parent → no marker" 0 \
  FLYWHEEL_ROUNDTABLE_CHANNEL_ID="   " \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=1512578695468941333
rt_marker_case 9 "FLY-1942: trimmed explicit parent → marker present" 1 \
  FLYWHEEL_ROUNDTABLE_CHANNEL_ID=" 1512578695468941333 " \
  FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=1512578695468941333

# ════════════════ FLY-398 full-access (FLYWHEEL_CODEX_LEAD_PROFILE=full-access) ════════════════

# ── ensure-home full-access: workspace-write + network ON + writable_roots ──
H=$(fresh_home 30)
if FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
   FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
   FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
   FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
   FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
   FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" \
   FLYWHEEL_CODEX_LEAD_OUTBOUND="bridge" \
   FLYWHEEL_COMM_DB="/state/comm.db" \
   /bin/bash "$SUT" ensure-home >/dev/null 2>&1; then
  pass "full-access ensure-home succeeds"
else
  fail "full-access ensure-home should succeed"
fi
python3 -c "import tomllib,sys; c=tomllib.load(open(sys.argv[1],'rb')); sys.exit(0 if c.get('sandbox_mode')=='workspace-write' else 1)" "$H/config.toml" \
  && pass "full-access: sandbox_mode=workspace-write" || fail "full-access: sandbox_mode wrong"
python3 -c "import tomllib,sys; c=tomllib.load(open(sys.argv[1],'rb')); sww=c.get('sandbox_workspace_write',{}); sys.exit(0 if (sww.get('network_access') is True and sww.get('writable_roots')==['/work/dir']) else 1)" "$H/config.toml" \
  && pass "full-access: network ON + writable_roots=[cwd]" || fail "full-access: network/writable_roots wrong"
python3 -c "import tomllib,sys; c=tomllib.load(open(sys.argv[1],'rb')); sys.exit(0 if c.get('default_permissions') is None else 1)" "$H/config.toml" \
  && pass "full-access: no default permission profile" || fail "full-access: must not carry a default permission profile"
command grep -q 'default_tools_approval_mode = "approve"' "$H/config.toml" && pass "full-access: lead_actions approve mode written" || fail "full-access: approve mode missing"
command grep -q 'env_vars = \["BRIDGE_URL", "TEAMLEAD_API_TOKEN"\]' "$H/config.toml" && pass "full-access: Bridge credentials forwarded by NAME (env_vars)" || fail "full-access: env_vars missing"
! command grep -q "BROKER_SOCKET" "$H/config.toml" && pass "full-access: NO broker socket in config (token by name)" || fail "full-access: broker socket must not appear"
python3 -c "import tomllib,sys; c=tomllib.load(open(sys.argv[1],'rb')); sys.exit(0 if c.get('notice',{}).get('hide_rate_limit_model_nudge') is True else 1)" "$H/config.toml" \
  && pass "FLY-2296: full-access home hides the rate-limit model nudge" \
  || fail "FLY-2296: full-access home notice pin missing"
python3 -c "import tomllib,sys; c=tomllib.load(open(sys.argv[1],'rb')); sys.exit(0 if c.get('features',{}).get('memories') is True and c.get('memories',{}).get('dedicated_tools') is True else 1)" "$H/config.toml" \
  && pass "FLY-2357: full-access home pins memory master switch and dedicated tools in separate tables" \
  || fail "FLY-2357: full-access home memory pins missing or misplaced"
FA_WHOLE_BEFORE=$(cat "$H/config.toml")
if FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_CODEX_LEAD_OUTBOUND="bridge" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home >/dev/null 2>&1 \
  && [ "$FA_WHOLE_BEFORE" = "$(cat "$H/config.toml")" ]; then
  pass "FLY-2357: fresh full-access config is byte-identical after a second ensure"
else
  fail "FLY-2357: fresh full-access config must be byte-identical after a second ensure"
fi

H_DIRECT=$(fresh_home 2445-direct)
if FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H_DIRECT" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="codex-infra-bot-lead" FLYWHEEL_PROJECT_NAME="flywheel" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_CODEX_LEAD_OUTBOUND="direct" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/claw" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home >/dev/null 2>&1 \
  && command grep -q 'env_vars = \["DISCORD_BOT_TOKEN"\]' "$H_DIRECT/config.toml" \
  && command grep -q 'FLYWHEEL_CODEX_LEAD_OUTBOUND = "direct"' "$H_DIRECT/config.toml" \
  && ! command grep -q 'TEAMLEAD_API_TOKEN' "$H_DIRECT/config.toml"; then
  pass "FLY-2445 review: direct full-access home preserves Discord delivery without Bridge credentials"
else
  fail "FLY-2445 review: direct full-access home must use only DISCORD_BOT_TOKEN"
fi

# ── FLY-2357: full-access must see memory drift before its rewrite ─────────
H=$(fresh_home 2357-drift)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "workspace-write"
approval_policy = "never"
[features]
memories = false
[memories]
dedicated_tools = true
TOML
BEFORE=$(cat "$H/config.toml")
OUT=$(FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -Fq "[features] memories = true" <<< "$OUT" \
  && command grep -Fq "Fix $H/config.toml manually" <<< "$OUT" \
  && [ "$BEFORE" = "$(cat "$H/config.toml")" ] \
  && pass "FLY-2357: full-access memory drift fails closed before rewrite" \
  || fail "FLY-2357: full-access memory drift must fail before rewrite without changing config; got: $OUT"

H=$(fresh_home 2357-tools-drift)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "workspace-write"
approval_policy = "never"
[features]
memories = true
[memories]
dedicated_tools = false
TOML
BEFORE=$(cat "$H/config.toml")
OUT=$(FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -Fq "[memories] dedicated_tools = true" <<< "$OUT" \
  && command grep -Fq "Fix $H/config.toml manually" <<< "$OUT" \
  && [ "$BEFORE" = "$(cat "$H/config.toml")" ] \
  && pass "FLY-2357: full-access dedicated-tools drift fails closed before rewrite" \
  || fail "FLY-2357: full-access dedicated-tools drift must fail before rewrite without changing config; got: $OUT"

# ── FLY-2357: `[memories].memories` is valid TOML but does not enable memory ──
H=$(fresh_home 2357-wrong-master-table)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "workspace-write"
approval_policy = "never"
[memories]
memories = true
dedicated_tools = true
TOML
BEFORE=$(cat "$H/config.toml")
OUT=$(FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -Fq "[memories] memories" <<< "$OUT" \
  && command grep -Fq "[features] memories = true" <<< "$OUT" \
  && command grep -Fq "Fix $H/config.toml manually" <<< "$OUT" \
  && [ "$BEFORE" = "$(cat "$H/config.toml")" ] \
  && pass "FLY-2357: misplaced memory master switch fails closed before rewrite" \
  || fail "FLY-2357: [memories] memories must fail before rewrite without changing config; got: $OUT"

# ── FLY-2357: dedicated_tools belongs only in [memories] ──────────────────
H=$(fresh_home 2357-wrong-tools-table)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "workspace-write"
approval_policy = "never"
[features]
memories = true
dedicated_tools = true
TOML
BEFORE=$(cat "$H/config.toml")
OUT=$(FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
command grep -q "rc=1" <<< "$OUT" \
  && command grep -Fq "[features] dedicated_tools" <<< "$OUT" \
  && command grep -Fq "[memories] dedicated_tools = true" <<< "$OUT" \
  && command grep -Fq "Fix $H/config.toml manually" <<< "$OUT" \
  && [ "$BEFORE" = "$(cat "$H/config.toml")" ] \
  && pass "FLY-2357: misplaced dedicated memory tools fail closed before rewrite" \
  || fail "FLY-2357: [features] dedicated_tools must fail before rewrite without changing config; got: $OUT"

# ── FLY-2357: full-access rewrite preserves the operator-owned tables verbatim ──
H=$(fresh_home 2357-preserve)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "workspace-write"
approval_policy = "never"

[features]
# Preserve comments, ordering, and unknown future flat keys.
memories = true
future_memory_feature = "keep-me"

[memories]
# Non-default sentinels prove FLY-2357 never tunes FLY-2355·D controls.
dedicated_tools = true
max_rollouts_per_startup = 17
min_rollout_idle_hours = 19
max_rollout_age_days = 23
min_rate_limit_remaining_percent = 29
disable_on_external_context = true

[projects."/already/trusted"]
trust_level = "trusted"

[notice]
hide_rate_limit_model_nudge = true
TOML
FEATURES_BEFORE=$(toml_table_block "$H/config.toml" features)
MEMORIES_BEFORE=$(toml_table_block "$H/config.toml" memories)
if FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home >/dev/null 2>&1 \
  && [ "$FEATURES_BEFORE" = "$(toml_table_block "$H/config.toml" features)" ] \
  && [ "$MEMORIES_BEFORE" = "$(toml_table_block "$H/config.toml" memories)" ]; then
  pass "FLY-2357: full-access rewrite preserves feature/memory tables verbatim"
else
  fail "FLY-2357: full-access rewrite must preserve feature/memory comments, unknown keys, and throttle sentinels verbatim"
fi
FA_SENTINEL_BEFORE=$(cat "$H/config.toml")
if FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home >/dev/null 2>&1 \
  && [ "$FA_SENTINEL_BEFORE" = "$(cat "$H/config.toml")" ]; then
  pass "FLY-2357: sentinel full-access config is byte-identical after a second ensure"
else
  fail "FLY-2357: sentinel full-access config must be byte-identical after a second ensure"
fi

# Inline/dotted/nested table shapes cannot be carried through the flat-table
# renderer losslessly. Fail closed, keep the original, and leave no staging files.
H=$(fresh_home 2357-inline-shape)
cat > "$H/config.toml" <<'TOML'
sandbox_mode = "workspace-write"
approval_policy = "never"
features = { memories = true }
[memories]
dedicated_tools = true
TOML
BEFORE=$(cat "$H/config.toml")
OUT=$(FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="456" \
  FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
STAGING_COUNT=$(find "$H" -maxdepth 1 -type f \( -name '.config.toml.fullaccess.*' -o -name '.config.toml.memory-source.*' \) | wc -l | tr -d ' ')
command grep -q "rc=1" <<< "$OUT" \
  && command grep -Fq "cannot preserve [features]/[memories] safely" <<< "$OUT" \
  && command grep -Fq "Fix $H/config.toml manually" <<< "$OUT" \
  && [ "$BEFORE" = "$(cat "$H/config.toml")" ] \
  && [ "$STAGING_COUNT" = "0" ] \
  && pass "FLY-2357: unsafe table shape fails closed and cleans staging files" \
  || fail "FLY-2357: unsafe table shape must keep original config and clean staging files; got: $OUT (staging=$STAGING_COUNT)"

# ── full-access ensure-daemon: STOP then START (pin ⑤ — daemon re-reads; no stale read-only daemon) ──
H=$(fresh_home 31); : > "$MOCK_LOG"
FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_BIN="$T/bin/codex" FLYWHEEL_CODEX_TUI_HOME="$H" /bin/bash "$SUT" ensure-daemon >/dev/null 2>&1
command grep -q "remote-control stop" "$MOCK_LOG" && pass "full-access ensure-daemon: stop invoked (no stale read-only daemon)" || fail "full-access ensure-daemon: stop not invoked"
command grep -q "remote-control start --json" "$MOCK_LOG" && pass "full-access ensure-daemon: start invoked after stop" || fail "full-access ensure-daemon: start not invoked"

# ── shell→gate full-access xcheck: the SHELL-written config.toml passes the FULL-ACCESS runtime gate ──
if [ ! -f "$GATE_JS" ] || [ ! -f "$RUNTIME_JS" ]; then
  fail "shell→gate FA: required teamlead dist is missing (build before running this suite)"
else
  run_fa_xcheck() {
    local H xcheck_rc=0
    H=$(fresh_home "fa-$1")
    FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
      FLYWHEEL_CODEX_LEAD_PROFILE=full-access \
      FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/Users/x/dist/lead-actions/lead-actions-main.js" \
      FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
      FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
      FLYWHEEL_LEAD_CHAT_CHANNEL_ID="1500600400238084307" \
      FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS="$2" \
      FLYWHEEL_CODEX_LEAD_OUTBOUND="direct" \
      FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/Users/x/.flywheel/state/codex-lead/mufasa" \
      FLYWHEEL_COMM_DB="/Users/x/.flywheel/comm/growth/comm.db" \
      FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES="$3" \
      /bin/bash "$SUT" ensure-home >/dev/null 2>&1 || { fail "shell→gate FA ($1): ensure-home failed"; return; }
    if ! python3 -c "import tomllib,sys; c=tomllib.load(open(sys.argv[1],'rb')); sys.exit(0 if c.get('features',{}).get('memories') is True and c.get('memories',{}).get('dedicated_tools') is True else 1)" "$H/config.toml"; then
      fail "shell→gate FA ($1): memory pins are missing or misplaced before the runtime gate"
      return
    fi
    GATE_JS="$GATE_JS" RUNTIME_JS="$RUNTIME_JS" CFG="$H/config.toml" CROSS="$2" ALI="$3" node --input-type=module -e '
      import { readFileSync } from "node:fs";
      let gateModule;
      let runtimeModule;
      try {
        gateModule = await import(process.env.GATE_JS);
        runtimeModule = await import(process.env.RUNTIME_JS);
      } catch (error) {
        console.error("shell→gate FA environment/module-load failure:", error);
        process.exit(20);
      }
      const { assertFullAccessLeadActionsConfigGate, buildFullAccessLeadActionsMcpServerConfig, assertFullAccessSandboxConfig } = gateModule;
      const { parseCodexLeadRuntimeConfig } = runtimeModule;
      // FLY-1243 (Codex R3): derive crossDeptChannelIds + effective roundtable autoContinue
      // through the REAL parser so the expected full-access config matches the runtime
      // EXACTLY; the shell now writes the same normalized/base-filtered value.
      const parsed = parseCodexLeadRuntimeConfig({
        FLYWHEEL_LEAD_ID: "mufasa-lead", FLYWHEEL_PROJECT_NAME: "growth",
        FLYWHEEL_LEAD_KEY: "growth-mufasa-lead", FLYWHEEL_LEAD_BACKEND: "codex-app-server",
        FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64), DISCORD_EXPECTED_BOT_USER_ID: "999", DISCORD_BOT_TOKEN: "x",
        FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "1500600400238084307",
        FLYWHEEL_CODEX_LEAD_STATE_DIR: "/Users/x/.flywheel/state/codex-lead/mufasa",
        FLYWHEEL_COMM_DB: "/Users/x/.flywheel/comm/growth/comm.db",
        FLYWHEEL_CODEX_BIN: "/usr/local/bin/codex", CODEX_HOME: "/tmp/codexhome",
        FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: process.env.CROSS || "",
      });
      const expected = buildFullAccessLeadActionsMcpServerConfig({
        nodeBin: "/usr/local/bin/node",
        mainJsPath: "/Users/x/dist/lead-actions/lead-actions-main.js",
        leadId: "mufasa-lead", projectName: "growth",
        chatChannelId: "1500600400238084307",
        crossDeptChannelIds: parsed.crossDeptChannelIds,
        stateDir: "/Users/x/.flywheel/state/codex-lead/mufasa",
        commDbPath: "/Users/x/.flywheel/comm/growth/comm.db",
        outboundMode: parsed.outboundMode,
        explicitAliases: process.env.ALI || undefined,
        roundtableAutoContinue: parsed.replyInThread?.autoContinue === true,
      });
      try {
        const toml = readFileSync(process.env.CFG, "utf8");
        assertFullAccessLeadActionsConfigGate(toml, expected);
        // Codex R1 HIGH-2: the shell-written sandbox section + writable_roots must pass the
        // runtime sandbox gate against the validated project root (here = the ensure-home cwd).
        assertFullAccessSandboxConfig(toml, "/work/dir");
      } catch (error) {
        console.error("shell→gate FA runtime gate rejection:", error);
        process.exit(21);
      }
    ' || xcheck_rc=$?
    case "$xcheck_rc" in
      0) pass "shell→gate FA ($1): full-access config.toml passes the runtime gate (MCP + sandbox/writable_roots)" ;;
      20) fail "shell→gate FA ($1): environment/module-load failed before the runtime gate" ;;
      21) fail "shell→gate FA ($1): config.toml was rejected by the full-access runtime gate" ;;
      *) fail "shell→gate FA ($1): unexpected xcheck failure (rc=$xcheck_rc)" ;;
    esac
  }
  run_fa_xcheck "one-crossdept" "1512578695468941333" ""
  run_fa_xcheck "with-aliases" "1512578695468941333,1517226183341904032" "roundtable:1512578695468941333"
  # FLY-1243 (Codex R3): chat id as the ONLY cross-dept entry → parser drops it → [] + no
  # marker; the shell now WRITES "" too → gate passes.
  run_fa_xcheck "chat-only" "1500600400238084307" ""
  # FLY-1243 (Codex R3): chat id + a real cross-dept id → parser drops the chat, keeps the
  # real id; the shell writes the same base-filtered single id → gate passes.
  run_fa_xcheck "chat-overlap" "1500600400238084307,1512578695468941333" ""
  # FLY-1243 (Codex R3): empty-leading list (" ,<id>") → parser normalizes to just <id>; the
  # shell writes the same → gate passes.
  run_fa_xcheck "empty-leading" " ,1512578695468941333" ""
fi

# ════════════════ FLY-694 — bash 3.2 here-doc desync re-exec guard ════════════════
# macOS /bin/bash is the GPLv2-frozen bash 3.2, whose incremental script reader
# silently mis-parses a here-document that straddles its read-buffer boundary. After
# FLY-676 shifted a heredoc onto a bad boundary, bash 3.2 failed to DEFINE
# write_full_access_config / append_full_access_lead_actions_mcp at runtime → the
# launcher hit "line 395: write_full_access_config: command not found" (exit 127, 30s
# launchd loop). `bash -n` cannot catch this on ANY bash version, and Linux CI uses a
# modern bash so it never reproduced there. The fix re-execs under a modern bash. These
# assertions are RED on the pre-fix script when this suite runs under /bin/bash 3.2 and
# GREEN once the guard is present (and trivially pass under a modern /bin/bash).
command grep -q 'FLYWHEEL_TUI_HOME_REEXEC' "$SUT" && command grep -q 'BASH_VERSINFO' "$SUT" \
  && pass "FLY-694: bash-3.2 re-exec guard present in the script" \
  || fail "FLY-694: re-exec guard (FLYWHEEL_TUI_HOME_REEXEC + BASH_VERSINFO) missing — bash 3.2 heredoc desync will recur"
H=$(fresh_home 694)
FA694_OUT=$(FLYWHEEL_CODEX_LEAD_PROFILE=full-access FLYWHEEL_CODEX_TUI_HOME="$H" FLYWHEEL_CODEX_TUI_CWD="/work/dir" \
  FLYWHEEL_LEAD_ACTIONS_MAIN_JS="/dist/lead-actions/lead-actions-main.js" \
  FLYWHEEL_LEAD_ACTIONS_NODE_BIN="/usr/local/bin/node" \
  FLYWHEEL_LEAD_ID="mufasa-lead" FLYWHEEL_PROJECT_NAME="growth" \
  FLYWHEEL_LEAD_CHAT_CHANNEL_ID="123" FLYWHEEL_LEAD_ACTIONS_STATE_DIR="/state/mufasa" \
  FLYWHEEL_COMM_DB="/state/comm.db" \
  /bin/bash "$SUT" ensure-home 2>&1; echo "rc=$?")
echo "$FA694_OUT" | command grep -q "command not found" \
  && fail "FLY-694: full-access ensure-home under /bin/bash emitted 'command not found' (bash 3.2 heredoc desync); out: $FA694_OUT" \
  || pass "FLY-694: full-access ensure-home under /bin/bash defines all functions (no 'command not found')"
echo "$FA694_OUT" | command grep -q "rc=0" \
  && pass "FLY-694: full-access ensure-home under /bin/bash exits 0 (was 127 pre-fix)" \
  || fail "FLY-694: full-access ensure-home under /bin/bash did not exit 0; out: $FA694_OUT"

echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
