#!/bin/bash
# FLY-247 WI-2: staged install — failure modes all non-zero with structured
# JSON result records; stop-timeout NEVER bootstraps; staged mode never
# touches the shared wrapper.
#
# Scenarios (plan §2.6 + Codex R1#1/R2#2/R4#2/R8#2/R8#3/R9#2/R10#3):
#   S1 prep: missing staged plist           → exit 10, zero launchd calls
#   S2 prep: plist label mismatch           → exit 10
#   S3 prep: plist embeds staged (non-canonical) manifest path → exit 10
#   S4 stop-timeout (old PID stays alive)   → exit 20, NO bootstrap call
#   S5 bootstrap failure                    → exit 40
#   S6 verify: not started (no PID)         → exit 41, outcome distinguishes
#   S7 verify: alive but unverified — same-name Codex-observer window must
#      NOT fake success (R8#3)              → exit 42, newPid recorded
#   S8 success (claude-confirmed via pane command) → exit 0, journal=applied,
#      canonical bytes == staged bytes, result record identity-bound (R10#3)
#   S9 staged mode never installs the wrapper (R4#2)
#
# Hermetic: launchctl/tmux stubbed via env seams; "old/new processes" are
# test-owned `sleep` children; HOME is a sandbox.
set -uo pipefail

PASSED=0
FAILED=0

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON_SH="${REPO_ROOT}/scripts/flywheel-daemon.sh"

SANDBOX="$(mktemp -d -t fly247-staged-XXXXXX)"
LIVE_PIDS=()
cleanup() {
  for p in "${LIVE_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

export HOME="$SANDBOX"
CTL="$SANDBOX/ctl"
mkdir -p "$CTL" "$SANDBOX/.flywheel/manifests" "$SANDBOX/Library/LaunchAgents" "$SANDBOX/.flywheel/bin"

# ── stubs ──────────────────────────────────────────────────────────────────
# launchctl stub: state machine driven by $CTL/{loaded,pid.last,bootstrap_rc};
# logs every call to $CTL/calls.log.
cat > "$SANDBOX/launchctl-stub" <<'EOF'
#!/bin/bash
CTL="${LAUNCHCTL_STUB_CTL:?}"
echo "$1" >> "$CTL/calls.log"
case "$1" in
  print)
    if [ -f "$CTL/loaded" ]; then
      pid="$(cat "$CTL/pid.last" 2>/dev/null || echo 0)"
      if [ "$pid" != "0" ]; then echo "    pid = $pid"; fi
      exit 0
    fi
    echo "Could not find service" >&2
    exit 1
    ;;
  bootout)
    rm -f "$CTL/loaded"
    kill "$(cat "$CTL/kill_on_bootout" 2>/dev/null)" 2>/dev/null
    echo 0 > "$CTL/pid.last"
    exit 0
    ;;
  bootstrap)
    rc="$(cat "$CTL/bootstrap_rc" 2>/dev/null || echo 0)"
    if [ "$rc" = "0" ]; then
      touch "$CTL/loaded"
      if [ -s "$CTL/next_pid" ]; then
        head -1 "$CTL/next_pid" > "$CTL/pid.last"
        tail -n +2 "$CTL/next_pid" > "$CTL/next_pid.rest" && mv "$CTL/next_pid.rest" "$CTL/next_pid"
      fi
      # Simulate the booted Lead's manifest self-write (pid binding evidence):
      # claude-lead.sh rewrites the canonical manifest with its own pid.
      if [ -f "$CTL/manifest_path" ] && [ -f "$CTL/pid.last" ]; then
        mp="$(cat "$CTL/manifest_path")"
        np="$(cat "$CTL/pid.last")"
        if [ -f "$mp" ] && [ "$np" != "0" ]; then
          jq --argjson pid "$np" '.pid = $pid' "$mp" > "$mp.stubtmp" && mv "$mp.stubtmp" "$mp"
        fi
      fi
    fi
    exit "$rc"
    ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$SANDBOX/launchctl-stub"

# tmux stub: prints $CTL/tmux_out if present (pane list lines).
cat > "$SANDBOX/tmux-stub" <<'EOF'
#!/bin/bash
CTL="${LAUNCHCTL_STUB_CTL:?}"
cat "$CTL/tmux_out" 2>/dev/null || true
EOF
chmod +x "$SANDBOX/tmux-stub"

export LAUNCHCTL_STUB_CTL="$CTL"
export FLYWHEEL_DAEMON_LAUNCHCTL="$SANDBOX/launchctl-stub"
export FLYWHEEL_DAEMON_TMUX="$SANDBOX/tmux-stub"
export FLYWHEEL_DAEMON_STOP_TIMEOUT=1
export FLYWHEEL_DAEMON_VERIFY_TIMEOUT=2
export FLYWHEEL_DAEMON_POLL_INTERVAL=1
export FLYWHEEL_DAEMON_SOURCED=1

# shellcheck disable=SC1090
source "$DAEMON_SH"
# Sourcing imports the daemon's `set -e`; the harness needs non-zero returns
# to be observable, not fatal.
set +e

KEY="geo-product-lead"
LABEL="com.flywheel.lead.${KEY}"
CANON_MANIFEST="$MANIFEST_DIR/${KEY}.json"
CANON_PLIST="$(plist_path "$KEY")"
WRAPPER_DST="${FLYWHEEL_BIN}/flywheel-lead-wrapper.sh"

TXN="$SANDBOX/txn"

reset_txn() {
  rm -rf "$TXN" "$CTL/loaded" "$CTL/calls.log" "$CTL/bootstrap_rc" "$CTL/tmux_out" \
    "$CTL/manifest_path" "$CTL/kill_on_bootout" "$CTL/next_pid"
  mkdir -p "$TXN/staged"
  # R5#2 + R6#1: the daemon REQUIRES a complete transaction (configSha +
  # original hashes) AND a RUNNING standard-bound claude lead at the
  # boundary (loaded label, manifest.pid == launchd pid, claude runtime).
  RESET_OLD_PID=$(bash -c 'exec -a claude-lead-test sleep 300' </dev/null >/dev/null 2>&1 & echo $!)
  LIVE_PIDS+=("$RESET_OLD_PID")
  echo "$RESET_OLD_PID" > "$CTL/pid.last"
  touch "$CTL/loaded"
  echo "$RESET_OLD_PID" > "$CTL/kill_on_bootout"
  printf '0\t%s\t0\tclaude\n' "$KEY" > "$CTL/tmux_out"
  echo '[{"projectName":"geo"}]' > "$HOME/.flywheel/projects.json"
  jq -n --argjson pid "$RESET_OLD_PID" \
    '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo",pid:$pid}' > "$CANON_MANIFEST"
  generate_plist "$KEY" "$CANON_MANIFEST" >/dev/null
  local cfg_sha m_sha p_sha
  cfg_sha=$(file_sha "$HOME/.flywheel/projects.json")
  m_sha=$(file_sha "$CANON_MANIFEST")
  p_sha=$(file_sha "$CANON_PLIST")
  jq -n --arg cfg "$cfg_sha" --arg m "$m_sha" --arg p "$p_sha" \
    '{transactionId: "txn-001", configSha: $cfg,
      leads: {"geo-product-lead": {attempt: 1, phase: "prepared",
        original: {manifestExisted: true, plistExisted: true,
                   manifestSha: $m, plistSha: $p}}}}' > "$TXN/transaction.json"
}

# R6#2: bind the staged artifacts into the transaction (the daemon refuses
# unbound/mismatched staged files).
bind_staged() {
  local sm sp tmp
  sm=$(file_sha "$TXN/staged/${KEY}.manifest.json" 2>/dev/null || echo "")
  sp=$(file_sha "$TXN/staged/${KEY}.plist" 2>/dev/null || echo "")
  tmp="$TXN/transaction.json.tmp"
  jq --arg sm "$sm" --arg sp "$sp" \
    '.leads["geo-product-lead"].staged = {manifestSha: $sm, plistSha: $sp}' \
    "$TXN/transaction.json" > "$tmp" && mv "$tmp" "$TXN/transaction.json"
}

make_staged() {
  # valid staged manifest + plist (plist embeds the CANONICAL manifest path)
  jq -n '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo",model:"claude-fable-5",leadBackend:{backendId:"claude-code"}}' \
    > "$TXN/staged/${KEY}.manifest.json"
  generate_plist_to "$KEY" "$TXN/staged/${KEY}.manifest.json" "$CANON_MANIFEST" "$TXN/staged/${KEY}.plist" >/dev/null
  bind_staged
}

result_field() {
  jq -r ".$1" "$TXN/result-${KEY}.json" 2>/dev/null
}

# ── S1: missing staged plist → prep failure, zero launchd calls ───────────
reset_txn
make_staged
rm -f "$TXN/staged/${KEY}.plist"
install_one_staged "$KEY" "$TXN" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 10 ] && [ "$(result_field outcome)" = "prep_failed_missing_staged" ] \
  && [ ! -s "$CTL/calls.log" ]; then
  pass "S1: missing staged artifact → exit 10 + prep_failed + zero launchd calls"
else
  fail "S1: rc=$rc outcome=$(result_field outcome) calls=$(cat "$CTL/calls.log" 2>/dev/null | tr '\n' ',')"
fi

# ── S2: label mismatch → prep failure ─────────────────────────────────────
reset_txn
make_staged
sed -i.bak "s|<string>${LABEL}</string>|<string>com.flywheel.lead.WRONG</string>|" "$TXN/staged/${KEY}.plist"
install_one_staged "$KEY" "$TXN" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 10 ] && [ "$(result_field outcome)" = "prep_failed_plist_label_mismatch" ]; then
  pass "S2: plist label mismatch → exit 10"
else
  fail "S2: rc=$rc outcome=$(result_field outcome)"
fi

# ── S3: staged plist embeds non-canonical manifest path (R5#4) ────────────
reset_txn
jq -n '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo"}' > "$TXN/staged/${KEY}.manifest.json"
generate_plist_to "$KEY" "$TXN/staged/${KEY}.manifest.json" "$TXN/staged/${KEY}.manifest.json" "$TXN/staged/${KEY}.plist" >/dev/null
install_one_staged "$KEY" "$TXN" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 10 ] && [ "$(result_field outcome)" = "prep_failed_plist_manifest_arg_not_canonical" ]; then
  pass "S3: staged-path-in-plist refused (would dangle after commit)"
else
  fail "S3: rc=$rc outcome=$(result_field outcome)"
fi

# ── S4: stop-timeout → exit 20, NEVER bootstraps ──────────────────────────
reset_txn
make_staged
rm -f "$CTL/kill_on_bootout"   # bootout does NOT kill the old process
OLD_PID="$RESET_OLD_PID"
install_one_staged "$KEY" "$TXN" >/dev/null 2>&1
rc=$?
phase=$(jq -r '.leads["geo-product-lead"].phase' "$TXN/transaction.json")
if [ "$rc" -eq 20 ] && [ "$(result_field outcome)" = "stop_timeout" ] \
  && ! grep -q "bootstrap" "$CTL/calls.log" \
  && [ "$phase" = "stopping" ] \
  && [ "$(result_field oldPid)" = "$OLD_PID" ]; then
  pass "S4: stop-timeout → exit 20, journal=stopping, oldPid recorded, NO bootstrap"
else
  fail "S4: rc=$rc outcome=$(result_field outcome) phase=$phase calls=$(tr '\n' ',' < "$CTL/calls.log")"
fi
kill "$OLD_PID" 2>/dev/null || true

# ── S5: bootstrap failure → exit 40 ───────────────────────────────────────
reset_txn
make_staged
echo 1 > "$CTL/bootstrap_rc"
install_one_staged "$KEY" "$TXN" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 40 ] && [ "$(result_field outcome)" = "bootstrap_failed" ]; then
  pass "S5: bootstrap failure → exit 40"
else
  fail "S5: rc=$rc outcome=$(result_field outcome)"
fi

# ── S6: loaded but no PID (not started) → exit 41 ─────────────────────────
reset_txn
make_staged
# bootout kills the old lead; bootstrap succeeds (loaded) but no next_pid
# is queued, so the new PID never appears
install_one_staged "$KEY" "$TXN" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 41 ] && [ "$(result_field outcome)" = "verify_failed_not_started" ] \
  && [ "$(result_field runtimeState)" = "not_started" ]; then
  pass "S6: loaded-but-no-PID → exit 41 (not_started)"
else
  fail "S6: rc=$rc outcome=$(result_field outcome)"
fi

# ── S7: alive but unverified — same-name Codex observer must not fake it ──
reset_txn
make_staged
sleep 300 &
NEW_PID=$!
LIVE_PIDS+=("$NEW_PID")
echo "$NEW_PID" > "$CTL/next_pid"
echo "$CANON_MANIFEST" > "$CTL/manifest_path"
# Window name matches the exact key but the pane command is the FLY-242
# Codex observer — the NEW pid runtime must NOT be claude-confirmed (R8#3);
# the OLD pid boundary evidence is ps-based (claude-lead-test argv0).
printf '0\t%s\t0\tcodex\n' "$KEY" > "$CTL/tmux_out"
install_one_staged "$KEY" "$TXN" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 42 ] && [ "$(result_field outcome)" = "verify_failed_alive_unverified" ] \
  && [ "$(result_field newPid)" = "$NEW_PID" ] \
  && [ "$(result_field runtimeState)" = "alive-unverified" ]; then
  pass "S7: same-name Codex observer window does NOT fake success → exit 42 + newPid"
else
  fail "S7: rc=$rc outcome=$(result_field outcome) newPid=$(result_field newPid)"
fi
kill "$NEW_PID" 2>/dev/null || true

# ── S8: success — pane command claude-confirmed ───────────────────────────
reset_txn
make_staged
sleep 300 &
NEW_PID=$!
LIVE_PIDS+=("$NEW_PID")
echo "$NEW_PID" > "$CTL/next_pid"
echo "$CANON_MANIFEST" > "$CTL/manifest_path"
printf '0\t%s\t0\tclaude\n' "$KEY" > "$CTL/tmux_out"
install_one_staged "$KEY" "$TXN" >/dev/null 2>&1
rc=$?
phase=$(jq -r '.leads["geo-product-lead"].phase' "$TXN/transaction.json")
# canonical manifest = staged content with the booted Lead's pid self-write
SHA_STAGED_M=$(jq -S 'del(.pid)' "$TXN/staged/${KEY}.manifest.json" | shasum -a 256 | awk '{print $1}')
SHA_CANON_M=$(jq -S 'del(.pid)' "$CANON_MANIFEST" | shasum -a 256 | awk '{print $1}')
CANON_PID=$(jq -r '.pid' "$CANON_MANIFEST")
SHA_STAGED_P=$(shasum -a 256 "$TXN/staged/${KEY}.plist" | awk '{print $1}')
SHA_CANON_P=$(shasum -a 256 "$CANON_PLIST" | awk '{print $1}')
if [ "$rc" -eq 0 ] && [ "$(result_field outcome)" = "applied" ] && [ "$phase" = "applied" ] \
  && [ "$SHA_STAGED_M" = "$SHA_CANON_M" ] && [ "$SHA_STAGED_P" = "$SHA_CANON_P" ] \
  && [ "$CANON_PID" = "$NEW_PID" ] \
  && [ "$(result_field transactionId)" = "txn-001" ] \
  && [ "$(result_field exactKey)" = "$KEY" ] \
  && [ "$(result_field attempt)" = "1" ]; then
  pass "S8: success → applied, canonical == staged bytes, identity-bound result record"
else
  fail "S8: rc=$rc outcome=$(result_field outcome) phase=$phase"
fi
kill "$NEW_PID" 2>/dev/null || true

# ── S9: staged mode never installs the wrapper (R4#2) ─────────────────────
if [ ! -f "$WRAPPER_DST" ]; then
  pass "S9: staged installs never touched the shared wrapper"
else
  fail "S9: wrapper was installed by a staged install"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
