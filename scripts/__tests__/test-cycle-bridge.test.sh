#!/usr/bin/env bash
# FLY-2237: fail-closed contracts for the slot-only Bridge cycle primitive.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/qa-multilead.sh
source "$SCRIPT_DIR/lib/qa-multilead.sh"
# shellcheck source=../lib/qa-slot-bridge.sh
source "$SCRIPT_DIR/lib/qa-slot-bridge.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2237-cycle.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
SLOT=$((41000 + ($$ % 1000)))
BORROWED_SLOT=$((SLOT + 1))
PORT=$((26000 + ($$ % 8000)))
SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
OWNER_LOCK="/tmp/flywheel-test-slot-${SLOT}.lock"
BORROWED_LOCK="/tmp/flywheel-test-slot-${BORROWED_SLOT}.lock"
SPEC="$SLOT_DIR/bridge-launch.json"
GUARD_PATH="$(qa_slot_bridge_guard_path "$SLOT")"
BRIDGE_PID=""
REAL_CURL="$(command -v curl)"
REAL_JQ="$(command -v jq)"
REAL_NODE="$(command -v node)"
PYTHON_COMMAND="$(command -v python3)"
REAL_PYTHON="$("$PYTHON_COMMAND" -c 'import os, sys; print(os.path.realpath(sys.executable))')"
REAL_LSOF="$(command -v lsof)"
REAL_BASH="$(command -v bash)"
REAL_CAT="$(command -v cat)"
REAL_MV="$(command -v mv)"
REAL_MKDIR="$(command -v mkdir)"
REAL_RM="$(command -v rm)"
REAL_PS="$(command -v ps)"
BIN="$TMP/bin"
BRIDGE_FIXTURE="$TMP/scripts/run-bridge.ts"
mkdir -p "$BIN" "$TMP/scripts/lib"
cp "$SCRIPT_DIR/test-cycle-bridge.sh" "$TMP/scripts/test-cycle-bridge.sh"
cp "$SCRIPT_DIR/lib/qa-slot-bridge.sh" "$TMP/scripts/lib/qa-slot-bridge.sh"

cleanup() {
  if [[ "$BRIDGE_PID" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$BRIDGE_PID" 2>/dev/null || break
      sleep 0.05
    done
    kill -KILL "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
  rm -rf "$SLOT_DIR" "$OWNER_LOCK" "$BORROWED_LOCK" "$TMP"
}
trap cleanup EXIT

cat > "$BIN/ps" <<'EOF'
#!/bin/bash
set -u
FORMAT=""; PID=""; ORIGINAL_ARGS="$*"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) FORMAT="${2:?}"; shift 2 ;;
    -p) PID="${2:?}"; shift 2 ;;
    *) shift ;;
  esac
done
[[ "$PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$PID" 2>/dev/null || exit 1
case "$FORMAT" in
  lstart=)
    if [[ "${FLY2237_SWAP_REPLACEMENT_IDENTITY:-0}" == "1" \
        && -s "${FLY2237_SLOT_DIR:?}/fixture-live.pid" \
        && -s "$FLY2237_SLOT_DIR/fixture-boot-count" \
        && "$("${FLY2237_REAL_CAT:?}" "$FLY2237_SLOT_DIR/fixture-boot-count")" -gt 1 \
        && "$("$FLY2237_REAL_CAT" "$FLY2237_SLOT_DIR/fixture-live.pid")" == "$PID" ]]; then
      if [[ -e "${FLY2237_IDENTITY_MARKER:?}" ]]; then
        printf 'Fri Jan  2 00:00:00 1970 recycled-pid-%s\n' "$PID"
        exit 0
      fi
      printf '%s\n' "$PID" > "$FLY2237_IDENTITY_MARKER"
    fi
    printf 'Thu Jan  1 00:00:00 1970 fixture-pid-%s\n' "$PID"
    ;;
  ppid=)
    if [[ -s "${FLY2237_SLOT_DIR:?}/fixture-forwarding-chain" ]]; then
      read -r fixture_child fixture_parent \
        < "$FLY2237_SLOT_DIR/fixture-forwarding-chain"
      if [[ "$PID" == "$fixture_child" ]]; then
        printf '%s\n' "$fixture_parent"
        exit 0
      fi
    fi
    exec "${FLY2237_REAL_PS:?}" -o ppid= -p "$PID"
    ;;
  pgid=) printf '%s\n' "$PID" ;;
  "")
    [[ " $ORIGINAL_ARGS " == *" -axo pid=,ppid= "* ]] \
      && exec "${FLY2237_REAL_PS:?}" -axo pid=,ppid=
    exit 64
    ;;
  *) exit 64 ;;
esac
EOF
cat > "$BIN/cat" <<'EOF'
#!/bin/bash
set -u
value="$("${FLY2237_REAL_CAT:?}" "$@")"
printf '%s\n' "$value"
if [[ $# -eq 1 && -n "${FLY2237_SIGNAL_AFTER_CAT:-}" \
    && "$1" == "$FLY2237_SIGNAL_AFTER_CAT" \
    && "$value" =~ ^[1-9][0-9]*$ \
    && "$value" != "${FLY2237_SIGNAL_OLD_PID:-}" \
    && ! -e "${FLY2237_SIGNAL_MARKER:?}" ]]; then
  printf '%s\n' "$1" > "$FLY2237_SIGNAL_MARKER"
  kill -TERM "$PPID"
fi
EOF
cat > "$BIN/stalled-child" <<'EOF'
#!/bin/bash
set -u
trap 'printf "child:%s\n" "$$" >> "${FIXTURE_SLOT_DIR:?}/fixture-term.log"; exit 0' TERM
while :; do sleep 1; done
EOF

cat > "$BRIDGE_FIXTURE" <<'EOF'
#!/bin/bash
set -u
slot_dir="${FIXTURE_SLOT_DIR:?}"
boot_file="$slot_dir/fixture-boot-count"
boot=$(( $(cat "$boot_file" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$boot" > "$boot_file"
printf '%s\n' "$$" > "$slot_dir/fixture-live.pid"
printf '%s\n' "${FIXTURE_HEALTH_STATUS:-200}" > "$slot_dir/fixture-health-status"
printf 'fixture boot-%s pid=%s mode=%s\n' "$boot" "$$" "${FIXTURE_MODE:-healthy}"
if [[ "${FIXTURE_MODE:-healthy}" == "bad-cwd-on-restart" && "$boot" -gt 1 ]]; then
  cd /
fi
if [[ "${FIXTURE_MODE:-healthy}" == "stalled-child" && "$boot" -gt 1 ]]; then
  trap 'printf "launcher:%s\n" "$$" >> "$FIXTURE_SLOT_DIR/fixture-term.log"; exit 0' TERM
  "${FIXTURE_STALLED_CHILD:?}" &
  child=$!
  printf '%s\n' "$child" > "$slot_dir/fixture-stalled-child.pid"
  wait "$child"
  exit 0
fi
if [[ "${FIXTURE_MODE:-healthy}" == "forwarding-parent" ]]; then
  FIXTURE_MODE=healthy "$0" &
  child=$!
  printf '%s %s\n' "$child" "$$" > "$slot_dir/fixture-forwarding-chain"
  trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 0' TERM
  wait "$child"
  exit 0
fi
case "${FIXTURE_MODE:-healthy}" in
  exit) exit 17 ;;
  ignore-term) trap '' TERM ;;
  healthy|unhealthy|bad-cwd-on-restart|stalled-child|forwarding-parent) ;;
  *) exit 64 ;;
esac
exec "${FIXTURE_PYTHON:?}" -c '
import os, signal, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
slot_dir, port, status, mode = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
def terminate(_sig, _frame):
    with open(os.path.join(slot_dir, "fixture-term.log"), "a") as f:
        f.write(f"{os.getpid()}\n")
    raise SystemExit(0)
if mode != "ignore-term":
    signal.signal(signal.SIGTERM, terminate)
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        with open(os.path.join(slot_dir, "fixture-health-status")) as f:
            current_status = int(f.read().strip())
        self.send_response(current_status); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *args): pass
HTTPServer(("127.0.0.1", port), H).serve_forever()
' "$slot_dir" "${TEAMLEAD_PORT:?}" "${FIXTURE_HEALTH_STATUS:-200}" "${FIXTURE_MODE:-healthy}"
EOF
cat > "$BIN/mv" <<'EOF'
#!/bin/bash
set -u
"${FLY2237_REAL_MV:?}" "$@"
target="${!#}"
if [[ -n "${FLY2237_SIGNAL_AFTER_MV:-}" \
    && "$target" == "$FLY2237_SIGNAL_AFTER_MV" \
    && ! -e "${FLY2237_SIGNAL_MARKER:?}" ]]; then
  printf '%s\n' "$target" > "$FLY2237_SIGNAL_MARKER"
  kill -TERM "$PPID"
fi
EOF
cat > "$BIN/mkdir" <<'EOF'
#!/bin/bash
set -u
"${FLY2237_REAL_MKDIR:?}" "$@"
target="${!#}"
if [[ -n "${FLY2237_PAUSE_AFTER_MKDIR:-}" \
    && "$target" == "$FLY2237_PAUSE_AFTER_MKDIR" \
    && ! -e "${FLY2237_MKDIR_MARKER:?}" ]]; then
  printf '%s\n' "$PPID" > "$FLY2237_MKDIR_MARKER"
  while [[ ! -e "${FLY2237_MKDIR_RELEASE:?}" ]]; do sleep 0.02; done
fi
EOF
cat > "$BIN/rm" <<'EOF'
#!/bin/bash
set -u
target="${!#}"
"${FLY2237_REAL_RM:?}" "$@"
if [[ -n "${FLY2237_PAUSE_AFTER_RM:-}" \
    && "$target" == "$FLY2237_PAUSE_AFTER_RM" \
    && ! -e "${FLY2237_RM_MARKER:?}" ]]; then
  printf '%s\n' "$PPID" > "$FLY2237_RM_MARKER"
  while [[ ! -e "${FLY2237_RM_RELEASE:?}" ]]; do sleep 0.02; done
fi
EOF
cat > "$BIN/lsof" <<'EOF'
#!/bin/bash
set -u
if [[ " $* " == *" -iTCP:"* ]]; then
  case "${FLY2237_LSOF_MODE:-real}" in
    denied) echo 'fixture lsof denied' >&2; exit 1 ;;
    denied-after)
      output="$("${FLY2237_REAL_LSOF:?}" "$@" 2>/dev/null || true)"
      if grep -qx "${FLY2237_OLD_PID:?}" <<<"$output"; then
        printf '%s\n' "$FLY2237_OLD_PID"
        exit 0
      fi
      echo 'fixture post-TERM lsof denied' >&2
      exit 1
      ;;
    denied-fourth)
      count=$(( $(cat "${FLY2237_SLOT_DIR:?}/fixture-lsof-count" 2>/dev/null || echo 0) + 1 ))
      printf '%s\n' "$count" > "$FLY2237_SLOT_DIR/fixture-lsof-count"
      if [[ "$count" == "4" ]]; then
        echo 'fixture replacement cleanup lsof denied' >&2
        exit 1
      fi
      exec "${FLY2237_REAL_LSOF:?}" "$@"
      ;;
    ambiguous)
      pid="$("${FLY2237_REAL_LSOF:?}" "$@" 2>/dev/null | head -1)"
      printf '%s\n%s\n' "$pid" 999999
      exit 0
      ;;
    duplicate)
      pid="$("${FLY2237_REAL_LSOF:?}" "$@" 2>/dev/null | head -1)"
      printf '%s\n%s\n' "$pid" "$pid"
      exit 0
      ;;
    empty-bind)
      output="$("${FLY2237_REAL_LSOF:?}" "$@" 2>/dev/null || true)"
      if grep -qx "${FLY2237_OLD_PID:?}" <<<"$output"; then
        printf '%s\n' "$FLY2237_OLD_PID"
        exit 0
      fi
      if [[ ! -s "${FLY2237_SLOT_DIR:?}/fixture-blocker.pid" ]]; then
        port=""
        for arg in "$@"; do
          [[ "$arg" == -iTCP:* ]] && port="${arg#-iTCP:}"
        done
        "${FLY2237_REAL_PYTHON:?}" -c '
import os, signal, socket, sys, time
port, pid_file = int(sys.argv[1]), sys.argv[2]
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port)); s.listen(1)
with open(pid_file, "w") as f: f.write(str(os.getpid()) + "\n")
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True: time.sleep(1)
' "$port" "$FLY2237_SLOT_DIR/fixture-blocker.pid" >/dev/null 2>&1 &
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          [[ -s "$FLY2237_SLOT_DIR/fixture-blocker.pid" ]] && break
          sleep 0.02
        done
      fi
      exit 1
      ;;
  esac
fi
exec "${FLY2237_REAL_LSOF:?}" "$@"
EOF
chmod +x "$BIN/ps" "$BIN/cat" "$BIN/stalled-child" "$BRIDGE_FIXTURE" "$BIN/lsof" "$BIN/mv" "$BIN/mkdir" "$BIN/rm"

NO_LSOF_BIN="$TMP/no-lsof-bin"
mkdir -p "$NO_LSOF_BIN"
for command_name in bash basename cat curl date dirname env head jq mkdir mv node rm sed sleep stat tr; do
  command_path="$(command -v "$command_name")"
  ln -s "$command_path" "$NO_LSOF_BIN/$command_name"
done
ln -s "$BIN/ps" "$NO_LSOF_BIN/ps"

CYCLE_PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$REAL_JQ"):$(dirname "$REAL_NODE"):$(dirname "$REAL_CURL"):$(dirname "$REAL_LSOF")"
BRIDGE_PATH="/usr/bin:/bin:$(dirname "$REAL_PYTHON")"

write_spec() {
  local mode="${1:-healthy}" health="${2:-200}"
  mkdir -p "$SLOT_DIR" "$OWNER_LOCK" "$BORROWED_LOCK"
  chmod 700 "$SLOT_DIR"
  jq -n \
    --argjson slot "$SLOT" --argjson port "$PORT" \
    --arg url "http://127.0.0.1:${PORT}" --arg cwd "$TMP" \
    --arg log "$SLOT_DIR/bridge.log" --arg script "$BRIDGE_FIXTURE" --arg repoRoot "$TMP" \
    --arg path "$BRIDGE_PATH" --arg slotDir "$SLOT_DIR" --arg python "$REAL_PYTHON" \
    --arg mode "$mode" --arg health "$health" --arg command "$BRIDGE_FIXTURE" \
    --arg stalledChild "$BIN/stalled-child" \
    --arg owner "$OWNER_LOCK/pid" --arg borrowed "$BORROWED_LOCK/pid" '
    {
      schemaVersion: 1, slot: $slot, port: $port, bridgeUrl: $url,
      host: "127.0.0.1", cwd: $cwd, repoRoot: $repoRoot,
      sessionLauncher: $python,
      logPath: $log, scriptPath: $script,
      environment: [
        "PATH=" + $path,
        "PWD=" + $cwd,
        "FIXTURE_SLOT_DIR=" + $slotDir,
        "FIXTURE_PYTHON=" + $python,
        "FIXTURE_STALLED_CHILD=" + $stalledChild,
        "FIXTURE_MODE=" + $mode,
        "FIXTURE_HEALTH_STATUS=" + $health,
        "TEAMLEAD_PORT=" + ($port|tostring)
      ],
      secretEnvironment: [], command: [$command],
      ownershipPidFiles: [$owner, $borrowed]
    }
  ' > "$SPEC"
  chmod 600 "$SPEC"
  printf '%s\n' claiming > "$OWNER_LOCK/pid"
  printf '%s\n' claiming > "$BORROWED_LOCK/pid"
  jq -n --argjson owner "$SLOT" '{ownerSlot:$owner,campaignId:"fly2237",borrowed:false}' \
    > "$OWNER_LOCK/campaign.json"
  jq -n --argjson owner "$SLOT" '{ownerSlot:$owner,campaignId:"fly2237",borrowed:true}' \
    > "$BORROWED_LOCK/campaign.json"
}

start_fixture() {
  ( source "$SCRIPT_DIR/lib/qa-slot-bridge.sh"; qa_slot_bridge_exec_spec "$SPEC" "$TMP" ) \
    >> "$SLOT_DIR/bridge.log" 2>&1 &
  BRIDGE_PID=$!
  printf '%s\n' "$BRIDGE_PID" > "$SLOT_DIR/bridge.pid"
  printf '%s\n' "$BRIDGE_PID" > "$OWNER_LOCK/pid"
  printf '%s\n' "$BRIDGE_PID" > "$BORROWED_LOCK/pid"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    "$REAL_CURL" -q -fsS --noproxy '*' --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && return 0
    kill -0 "$BRIDGE_PID" 2>/dev/null || return 1
    sleep 0.05
  done
  return 1
}

reset_slot() {
  if [[ "$BRIDGE_PID" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$BRIDGE_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$BRIDGE_PID" 2>/dev/null || break
      sleep 0.05
    done
    kill -KILL "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
  BRIDGE_PID=""
  rm -rf "$SLOT_DIR" "$OWNER_LOCK" "$BORROWED_LOCK"
}

run_cycle() {
  FLYWHEEL_QA_BRIDGE_TERM_TIMEOUT_SEC=1 \
  FLYWHEEL_QA_BRIDGE_HEALTH_TIMEOUT_SEC=1 \
  FLY2237_REAL_LSOF="$REAL_LSOF" \
  FLY2237_REAL_CAT="$REAL_CAT" \
  FLY2237_REAL_MV="$REAL_MV" \
  FLY2237_REAL_MKDIR="$REAL_MKDIR" \
  FLY2237_REAL_RM="$REAL_RM" \
  FLY2237_REAL_PS="$REAL_PS" \
  FLY2237_SLOT_DIR="$SLOT_DIR" \
  PATH="$CYCLE_PATH" \
    bash "$TMP/scripts/test-cycle-bridge.sh" "$SLOT"
}

run_cycle_without_lsof() {
  FLYWHEEL_QA_BRIDGE_TERM_TIMEOUT_SEC=1 \
  FLYWHEEL_QA_BRIDGE_HEALTH_TIMEOUT_SEC=1 \
  FLY2237_REAL_MV="$REAL_MV" \
  FLY2237_REAL_PS="$REAL_PS" \
  PATH="$NO_LSOF_BIN" \
    "$REAL_BASH" "$TMP/scripts/test-cycle-bridge.sh" "$SLOT"
}

# C1: cycle-failed is an operator-owned recovery sentinel, never a stale PID.
C1_LOCK="$TMP/flywheel-test-slot-41.lock"
C1_STALE="$TMP/stale-invoked"
mkdir -p "$C1_LOCK"
printf '%s\n' cycle-failed > "$C1_LOCK/pid"
c1_stale() { printf '%s\n' "$1" > "$C1_STALE"; rm -rf "$C1_LOCK"; }
if qa_multilead_claim_one "$C1_LOCK" c1_stale 41 >/dev/null 2>&1; then
  fail "C1: campaign claim reclaimed cycle-failed"
elif [[ "$(cat "$C1_LOCK/pid" 2>/dev/null || true)" == "cycle-failed" && ! -e "$C1_STALE" ]]; then
  pass "C1: campaign claim preserves cycle-failed for explicit teardown"
else
  fail "C1: campaign claim mutated cycle-failed or invoked stale teardown"
fi

# H1: a public successful cycle transfers every campaign lock atomically and
# does not rewrite campaign ownership metadata.
write_spec healthy 200
if start_fixture; then
  H1_OLD_PID="$BRIDGE_PID"
  H1_OWNER_CAMPAIGN="$(cat "$OWNER_LOCK/campaign.json")"
  H1_BORROWED_CAMPAIGN="$(cat "$BORROWED_LOCK/campaign.json")"
  if run_cycle > "$TMP/h1.out" 2> "$TMP/h1.err"; then
    H1_NEW_PID="$(cat "$SLOT_DIR/bridge.pid" 2>/dev/null || true)"
    BRIDGE_PID="$H1_NEW_PID"
    H1_GUARD_FREE=0
    if qa_slot_bridge_guard_acquire "$SLOT"; then
      H1_GUARD_FREE=1
      qa_slot_bridge_guard_release
    fi
    if [[ "$H1_NEW_PID" =~ ^[1-9][0-9]*$ && "$H1_NEW_PID" != "$H1_OLD_PID" \
        && "$(cat "$OWNER_LOCK/pid")" == "$H1_NEW_PID" \
        && "$(cat "$BORROWED_LOCK/pid")" == "$H1_NEW_PID" \
        && "$(cat "$OWNER_LOCK/campaign.json")" == "$H1_OWNER_CAMPAIGN" \
        && "$(cat "$BORROWED_LOCK/campaign.json")" == "$H1_BORROWED_CAMPAIGN" \
        && "$H1_GUARD_FREE" == "1" ]] \
        && kill -0 "$H1_NEW_PID" 2>/dev/null; then
      pass "H1: cycle transfers ownership and releases its non-inherited guard"
    else
      fail "H1: successful campaign cycle left inconsistent ownership"
    fi
  else
    fail "H1: public campaign cycle failed"
    tail -20 "$TMP/h1.err"
  fi
else
  fail "H1: fixture Bridge did not become healthy"
fi

# N1: an unsafe secret reference is rejected before any TERM or ownership
# mutation. This is a control-plane validation failure, not a failed cycle.
reset_slot
write_spec healthy 200
if start_fixture; then
  N1_OLD_PID="$BRIDGE_PID"
  mkdir -p "$SLOT_DIR/state/bridge-env-secrets"
  printf '%s\n' 'fixture-super-secret' > "$TMP/outside-secret"
  ln -s "$TMP/outside-secret" "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN"
  jq --arg path "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN" '
    .secretEnvironment = [{name:"TEAMLEAD_API_TOKEN",path:$path}]
  ' "$SPEC" > "$SPEC.tmp"
  mv "$SPEC.tmp" "$SPEC"
  chmod 600 "$SPEC"
  if run_cycle > "$TMP/n1.out" 2> "$TMP/n1.err"; then
    fail "N1: cycle accepted a symlink secret reference"
  elif kill -0 "$N1_OLD_PID" 2>/dev/null \
      && [[ "$(cat "$SLOT_DIR/bridge.pid")" == "$N1_OLD_PID" \
          && "$(cat "$OWNER_LOCK/pid")" == "$N1_OLD_PID" \
          && "$(cat "$BORROWED_LOCK/pid")" == "$N1_OLD_PID" \
          && ! -s "$SLOT_DIR/fixture-term.log" ]] \
      && ! grep -Fq 'fixture-super-secret' "$TMP/n1.out" "$TMP/n1.err"; then
    pass "N1: unsafe secret reference fails before TERM without disclosure"
  else
    fail "N1: unsafe secret validation mutated the live room"
  fi
else
  fail "N1: fixture Bridge did not become healthy"
fi

# N2: a single borrowed-lock mismatch refuses the whole cycle without TERM.
reset_slot
write_spec healthy 200
if start_fixture; then
  N2_OLD_PID="$BRIDGE_PID"
  printf '%s\n' 999999 > "$BORROWED_LOCK/pid"
  if run_cycle > "$TMP/n2.out" 2> "$TMP/n2.err"; then
    fail "N2: cycle accepted a borrowed ownership mismatch"
  elif kill -0 "$N2_OLD_PID" 2>/dev/null \
      && [[ "$(cat "$SLOT_DIR/bridge.pid")" == "$N2_OLD_PID" \
          && "$(cat "$OWNER_LOCK/pid")" == "$N2_OLD_PID" \
          && "$(cat "$BORROWED_LOCK/pid")" == "999999" \
          && ! -s "$SLOT_DIR/fixture-term.log" ]]; then
    pass "N2: ownership mismatch fails closed without touching the Bridge"
  else
    fail "N2: ownership mismatch mutated the live room"
  fi
  printf '%s\n' "$N2_OLD_PID" > "$BORROWED_LOCK/pid"
else
  fail "N2: fixture Bridge did not become healthy"
fi

# N3: the old Bridge health endpoint is a control; failure refuses TERM.
reset_slot
write_spec healthy 200
if start_fixture; then
  N3_OLD_PID="$BRIDGE_PID"
  printf '%s\n' 500 > "$SLOT_DIR/fixture-health-status"
  if run_cycle > "$TMP/n3.out" 2> "$TMP/n3.err"; then
    fail "N3: cycle ignored old Bridge health failure"
  elif kill -0 "$N3_OLD_PID" 2>/dev/null \
      && [[ "$(cat "$OWNER_LOCK/pid")" == "$N3_OLD_PID" \
          && "$(cat "$BORROWED_LOCK/pid")" == "$N3_OLD_PID" \
          && ! -s "$SLOT_DIR/fixture-term.log" ]]; then
    pass "N3: old health failure refuses TERM and preserves ownership"
  else
    fail "N3: old health failure mutated the live room"
  fi
else
  fail "N3: fixture Bridge did not become healthy"
fi

# N4: an lsof operational error is not equivalent to an empty listener set.
reset_slot
write_spec healthy 200
if start_fixture; then
  N4_OLD_PID="$BRIDGE_PID"
  if FLY2237_LSOF_MODE=denied run_cycle > "$TMP/n4.out" 2> "$TMP/n4.err"; then
    fail "N4: cycle treated denied lsof as no listener"
  elif kill -0 "$N4_OLD_PID" 2>/dev/null \
      && [[ "$(cat "$OWNER_LOCK/pid")" == "$N4_OLD_PID" && ! -s "$SLOT_DIR/fixture-term.log" ]]; then
    pass "N4: lsof denial fails closed before TERM"
  else
    fail "N4: lsof denial mutated the live room"
  fi
else
  fail "N4: fixture Bridge did not become healthy"
fi

# N5: two distinct listener PIDs are ambiguous even when one is the expected
# Bridge; no process is signalled.
reset_slot
write_spec healthy 200
if start_fixture; then
  N5_OLD_PID="$BRIDGE_PID"
  if FLY2237_LSOF_MODE=ambiguous run_cycle > "$TMP/n5.out" 2> "$TMP/n5.err"; then
    fail "N5: cycle accepted ambiguous listeners"
  elif kill -0 "$N5_OLD_PID" 2>/dev/null \
      && [[ "$(cat "$OWNER_LOCK/pid")" == "$N5_OLD_PID" && ! -s "$SLOT_DIR/fixture-term.log" ]]; then
    pass "N5: ambiguous listeners fail closed before TERM"
  else
    fail "N5: listener ambiguity mutated the live room"
  fi
else
  fail "N5: fixture Bridge did not become healthy"
fi

# N6: lsof is a required proof dependency; absence fails before TERM.
reset_slot
write_spec healthy 200
if start_fixture; then
  N6_OLD_PID="$BRIDGE_PID"
  if run_cycle_without_lsof > "$TMP/n6.out" 2> "$TMP/n6.err"; then
    fail "N6: cycle ran without lsof"
  elif kill -0 "$N6_OLD_PID" 2>/dev/null \
      && [[ "$(cat "$OWNER_LOCK/pid")" == "$N6_OLD_PID" && ! -s "$SLOT_DIR/fixture-term.log" ]]; then
    pass "N6: missing lsof fails closed before TERM"
  else
    fail "N6: missing lsof mutated the live room"
  fi
else
  fail "N6: fixture Bridge did not become healthy"
fi

# H2: duplicate lsof rows for one PID are normalized to one listener.
reset_slot
write_spec healthy 200
if start_fixture; then
  H2_OLD_PID="$BRIDGE_PID"
  if FLY2237_LSOF_MODE=duplicate run_cycle > "$TMP/h2.out" 2> "$TMP/h2.err"; then
    H2_NEW_PID="$(cat "$SLOT_DIR/bridge.pid" 2>/dev/null || true)"
    BRIDGE_PID="$H2_NEW_PID"
    if [[ "$H2_NEW_PID" =~ ^[1-9][0-9]*$ && "$H2_NEW_PID" != "$H2_OLD_PID" ]] \
        && kill -0 "$H2_NEW_PID" 2>/dev/null; then
      pass "H2: duplicate lsof rows dedupe to one listener"
    else
      fail "H2: deduped cycle did not produce a live replacement"
    fi
  else
    fail "H2: duplicate lsof rows incorrectly blocked cycle"
  fi
else
  fail "H2: fixture Bridge did not become healthy"
fi

# N27: real wrappers such as npx/tsx may forward TERM, causing a descendant
# to exit before the ancestor-first loop reaches it. A vanished measured member
# is success; a still-live member with a changed start identity remains fatal.
reset_slot
write_spec forwarding-parent 200
if start_fixture; then
  N27_OLD_PID="$BRIDGE_PID"
  if run_cycle > "$TMP/n27.out" 2> "$TMP/n27.err"; then
    N27_NEW_PID="$(cat "$SLOT_DIR/bridge.pid" 2>/dev/null || true)"
    BRIDGE_PID="$N27_NEW_PID"
    if [[ "$N27_NEW_PID" =~ ^[1-9][0-9]*$ && "$N27_NEW_PID" != "$N27_OLD_PID" \
        && "$(cat "$OWNER_LOCK/pid")" == "$N27_NEW_PID" \
        && "$(cat "$BORROWED_LOCK/pid")" == "$N27_NEW_PID" ]] \
        && kill -0 "$N27_NEW_PID" 2>/dev/null \
        && "$REAL_CURL" -q -fsS --noproxy '*' --max-time 1 \
          "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      pass "N27: ancestor-forwarded TERM tolerates an already-exited descendant"
    else
      fail "N27: forwarding wrapper cycle did not publish a healthy replacement"
    fi
  else
    fail "N27: already-exited measured descendant aborted the cycle"
    tail -20 "$TMP/n27.err"
  fi
else
  fail "N27: forwarding-parent fixture Bridge did not become healthy"
fi

# N7: TERM timeout never escalates to KILL or starts a replacement. When the
# old process remains live, ownership is restored to that exact PID.
reset_slot
write_spec ignore-term 200
if start_fixture; then
  N7_OLD_PID="$BRIDGE_PID"
  if run_cycle > "$TMP/n7.out" 2> "$TMP/n7.err"; then
    fail "N7: TERM-ignoring Bridge unexpectedly completed a cycle"
  elif kill -0 "$N7_OLD_PID" 2>/dev/null \
      && [[ "$(cat "$SLOT_DIR/bridge.pid")" == "$N7_OLD_PID" \
          && "$(cat "$OWNER_LOCK/pid")" == "$N7_OLD_PID" \
          && "$(cat "$BORROWED_LOCK/pid")" == "$N7_OLD_PID" \
          && "$(cat "$SLOT_DIR/fixture-boot-count")" == "1" ]]; then
    pass "N7: TERM timeout preserves the old live Bridge without KILL or restart"
  else
    fail "N7: TERM timeout lost the old live ownership identity"
  fi
else
  fail "N7: TERM-ignore fixture Bridge did not become healthy"
fi

# N8: once the old tree is gone, a replacement that never becomes healthy is
# terminated and the room stays explicitly cycle-failed for operator teardown.
reset_slot
write_spec healthy 200
if start_fixture; then
  N8_OLD_PID="$BRIDGE_PID"
  jq '
    .environment |= map(
      if startswith("FIXTURE_MODE=") then "FIXTURE_MODE=unhealthy"
      elif startswith("FIXTURE_HEALTH_STATUS=") then "FIXTURE_HEALTH_STATUS=500"
      else . end
    )
  ' "$SPEC" > "$SPEC.tmp"
  mv "$SPEC.tmp" "$SPEC"
  chmod 600 "$SPEC"
  if run_cycle > "$TMP/n8.out" 2> "$TMP/n8.err"; then
    fail "N8: unhealthy replacement unexpectedly completed a cycle"
  else
    N8_NEW_PID="$(cat "$SLOT_DIR/fixture-live.pid" 2>/dev/null || true)"
    BRIDGE_PID="$N8_NEW_PID"
    N8_STALE="$TMP/n8-stale-invoked"
    n8_stale() { printf '%s\n' "$1" > "$N8_STALE"; }
    if [[ "$N8_NEW_PID" =~ ^[1-9][0-9]*$ && "$N8_NEW_PID" != "$N8_OLD_PID" \
        && "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
        && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" \
        && "$(cat "$SLOT_DIR/fixture-boot-count")" == "2" ]] \
        && ! kill -0 "$N8_NEW_PID" 2>/dev/null \
        && ! qa_multilead_claim_one "$OWNER_LOCK" n8_stale "$SLOT" >/dev/null 2>&1 \
        && [[ ! -e "$N8_STALE" ]]; then
      BRIDGE_PID=""
      pass "N8: unhealthy replacement is terminated and cycle-failed blocks reclaim"
    else
      fail "N8: unhealthy replacement leaked or ownership was auto-reclaimable"
    fi
  fi
else
  fail "N8: fixture Bridge did not become healthy"
fi

# N28: cleanup must rebind the replacement launcher's start identity before it
# signals the isolated group. A recycled launcher PID leaves the group untouched.
reset_slot
write_spec healthy 200
if start_fixture; then
  N28_OLD_PID="$BRIDGE_PID"
  N28_IDENTITY_MARKER="$TMP/n28-identity-marker"
  jq '
    .environment |= map(
      if startswith("FIXTURE_MODE=") then "FIXTURE_MODE=unhealthy"
      elif startswith("FIXTURE_HEALTH_STATUS=") then "FIXTURE_HEALTH_STATUS=500"
      else . end
    )
  ' "$SPEC" > "$SPEC.tmp"
  mv "$SPEC.tmp" "$SPEC"
  chmod 600 "$SPEC"
  if FLY2237_SWAP_REPLACEMENT_IDENTITY=1 \
      FLY2237_IDENTITY_MARKER="$N28_IDENTITY_MARKER" \
      run_cycle > "$TMP/n28.out" 2> "$TMP/n28.err"; then
    fail "N28: identity-swapped replacement unexpectedly completed a cycle"
  else
    N28_NEW_PID="$(cat "$SLOT_DIR/fixture-live.pid" 2>/dev/null || true)"
    BRIDGE_PID="$N28_NEW_PID"
    if [[ -e "$N28_IDENTITY_MARKER" \
        && "$N28_NEW_PID" =~ ^[1-9][0-9]*$ \
        && "$N28_NEW_PID" != "$N28_OLD_PID" \
        && "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
        && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" ]] \
        && kill -0 "$N28_NEW_PID" 2>/dev/null \
        && ! grep -Fxq "$N28_NEW_PID" "$SLOT_DIR/fixture-term.log" \
        && grep -Fq 'replacement Bridge identity changed before process-group TERM' \
          "$TMP/n28.err"; then
      pass "N28: replacement identity swap fails closed without signalling the group"
    else
      fail "N28: identity-swapped replacement was signalled or failed without a clear error"
    fi
  fi
else
  fail "N28: fixture Bridge did not become healthy"
fi

# N15: a replacement that becomes healthy but fails a later identity check
# must still be terminated; cycle-failed remains the only ownership state.
reset_slot
write_spec healthy 200
if start_fixture; then
  jq '
    .environment |= map(
      if startswith("FIXTURE_MODE=") then "FIXTURE_MODE=bad-cwd-on-restart"
      else . end
    )
  ' "$SPEC" > "$SPEC.tmp"
  mv "$SPEC.tmp" "$SPEC"
  chmod 600 "$SPEC"
  if run_cycle > "$TMP/n15.out" 2> "$TMP/n15.err"; then
    fail "N15: cwd-mismatched replacement unexpectedly completed a cycle"
  else
    N15_NEW_PID="$(cat "$SLOT_DIR/fixture-live.pid" 2>/dev/null || true)"
    BRIDGE_PID="$N15_NEW_PID"
    if [[ "$N15_NEW_PID" =~ ^[1-9][0-9]*$ \
        && "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
        && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" ]] \
        && ! kill -0 "$N15_NEW_PID" 2>/dev/null; then
      BRIDGE_PID=""
      pass "N15: late replacement validation failure terminates the new tree"
    else
      fail "N15: late replacement validation failure leaked the new Bridge"
    fi
  fi
else
  fail "N15: fixture Bridge did not become healthy"
fi

# N19: if listener discovery degrades during late-failure cleanup, the cycle
# must report that fact, TERM the fallback launcher, and independently prove
# that no replacement listener survived.
reset_slot
write_spec healthy 200
if start_fixture; then
  jq '
    .environment |= map(
      if startswith("FIXTURE_MODE=") then "FIXTURE_MODE=bad-cwd-on-restart"
      else . end
    )
  ' "$SPEC" > "$SPEC.tmp"
  mv "$SPEC.tmp" "$SPEC"
  chmod 600 "$SPEC"
  if FLY2237_LSOF_MODE=denied-fourth FLY2237_SLOT_DIR="$SLOT_DIR" \
      run_cycle > "$TMP/n19.out" 2> "$TMP/n19.err"; then
    fail "N19: degraded cleanup unexpectedly completed the cycle"
  else
    N19_NEW_PID="$(cat "$SLOT_DIR/fixture-live.pid" 2>/dev/null || true)"
    BRIDGE_PID="$N19_NEW_PID"
    if [[ "$N19_NEW_PID" =~ ^[1-9][0-9]*$ \
        && "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
        && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" ]] \
        && ! kill -0 "$N19_NEW_PID" 2>/dev/null \
        && grep -Fq 'replacement listener census failed; using launcher fallback' "$TMP/n19.err" \
        && "$REAL_NODE" -e '
          const net = require("node:net");
          const server = net.createServer();
          server.once("error", () => process.exit(1));
          server.listen({host:"127.0.0.1", port:Number(process.argv[1]), exclusive:true}, () =>
            server.close((error) => process.exit(error ? 1 : 0)));
        ' "$PORT"; then
      BRIDGE_PID=""
      pass "N19: degraded replacement cleanup is explicit and proves port release"
    else
      fail "N19: degraded replacement cleanup was silent or left a listener"
    fi
  fi
else
  fail "N19: fixture Bridge did not become healthy"
fi

# N20: a signal after the new PID and every ownership lock agree must leave
# the healthy room intact even if SUCCESS has not yet been armed.
reset_slot
write_spec healthy 200
if start_fixture; then
  N20_OLD_PID="$BRIDGE_PID"
  N20_SIGNAL_MARKER="$TMP/n20-signal-marker"
  if FLY2237_SIGNAL_AFTER_CAT="$BORROWED_LOCK/pid" \
      FLY2237_SIGNAL_OLD_PID="$N20_OLD_PID" \
      FLY2237_SIGNAL_MARKER="$N20_SIGNAL_MARKER" \
      run_cycle > "$TMP/n20.out" 2> "$TMP/n20.err"; then
    fail "N20: signal-window fixture unexpectedly returned success"
  else
    N20_NEW_PID="$(cat "$SLOT_DIR/bridge.pid" 2>/dev/null || true)"
    BRIDGE_PID="$N20_NEW_PID"
    if [[ -e "$N20_SIGNAL_MARKER" && "$N20_NEW_PID" =~ ^[1-9][0-9]*$ \
        && "$(cat "$OWNER_LOCK/pid")" == "$N20_NEW_PID" \
        && "$(cat "$BORROWED_LOCK/pid")" == "$N20_NEW_PID" \
        && ! -e "$SLOT_DIR/.bridge-cycle.lock" ]] \
        && kill -0 "$N20_NEW_PID" 2>/dev/null \
        && "$REAL_CURL" -q -fsS --noproxy '*' --max-time 1 \
          "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      pass "N20: post-readback signal leaves the consistent healthy room intact"
    else
      printf '[TEST] N20 debug marker=%s pid=%s owner=%s borrowed=%s mutex=%s live=%s health=%s stderr=%s\n' \
        "$([[ -e "$N20_SIGNAL_MARKER" ]] && echo yes || echo no)" \
        "${N20_NEW_PID:-missing}" \
        "$(cat "$OWNER_LOCK/pid" 2>/dev/null || echo missing)" \
        "$(cat "$BORROWED_LOCK/pid" 2>/dev/null || echo missing)" \
        "$([[ -e "$SLOT_DIR/.bridge-cycle.lock" ]] && echo present || echo absent)" \
        "$(kill -0 "$N20_NEW_PID" 2>/dev/null && echo yes || echo no)" \
        "$("$REAL_CURL" -q -fsS --noproxy '*' --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && echo yes || echo no)" \
        "$(tr '\n' ' ' < "$TMP/n20.err")" >&2
      fail "N20: post-readback signal killed or poisoned the healthy replacement"
    fi
  fi
else
  fail "N20: fixture Bridge did not become healthy"
fi

# N21: a replacement can fail before it opens a listener. Cleanup must still
# enumerate and TERM the launcher plus its stalled descendant.
reset_slot
write_spec healthy 200
if start_fixture; then
  jq '
    .environment |= map(
      if startswith("FIXTURE_MODE=") then "FIXTURE_MODE=stalled-child"
      else . end
    )
  ' "$SPEC" > "$SPEC.tmp"
  mv "$SPEC.tmp" "$SPEC"
  chmod 600 "$SPEC"
  if run_cycle > "$TMP/n21.out" 2> "$TMP/n21.err"; then
    fail "N21: pre-listener replacement unexpectedly completed the cycle"
  else
    N21_LAUNCHER_PID="$(cat "$SLOT_DIR/fixture-live.pid" 2>/dev/null || true)"
    N21_CHILD_PID="$(cat "$SLOT_DIR/fixture-stalled-child.pid" 2>/dev/null || true)"
    BRIDGE_PID="$N21_LAUNCHER_PID"
    if [[ "$N21_LAUNCHER_PID" =~ ^[1-9][0-9]*$ \
        && "$N21_CHILD_PID" =~ ^[1-9][0-9]*$ \
        && "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
        && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" ]] \
        && ! kill -0 "$N21_LAUNCHER_PID" 2>/dev/null \
        && ! kill -0 "$N21_CHILD_PID" 2>/dev/null \
        && grep -Fq "launcher:${N21_LAUNCHER_PID}" "$SLOT_DIR/fixture-term.log" \
        && grep -Fq "child:${N21_CHILD_PID}" "$SLOT_DIR/fixture-term.log"; then
      BRIDGE_PID=""
      pass "N21: pre-listener replacement cleanup TERMs the full process tree"
    else
      fail "N21: pre-listener replacement cleanup leaked a descendant"
      kill -TERM "$N21_CHILD_PID" 2>/dev/null || true
    fi
  fi
else
  fail "N21: fixture Bridge did not become healthy"
fi

# N9: a live cycle holder excludes a second caller. Interrupting the holder
# after the sentinel write releases only the mutex and preserves cycle-failed.
reset_slot
write_spec ignore-term 200
if start_fixture; then
  N9_OLD_PID="$BRIDGE_PID"
  ( run_cycle > "$TMP/n9-first.out" 2> "$TMP/n9-first.err" ) &
  N9_DRIVER_PID=$!
  N9_HOLDER_PID=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    N9_HOLDER_PID="$(cat "$SLOT_DIR/.bridge-cycle.lock/pid" 2>/dev/null || true)"
    [[ "$N9_HOLDER_PID" =~ ^[1-9][0-9]*$ \
        && "$(cat "$OWNER_LOCK/pid" 2>/dev/null || true)" == "cycle-failed" ]] && break
    sleep 0.02
  done
  if run_cycle > "$TMP/n9-second.out" 2> "$TMP/n9-second.err"; then
    fail "N9: concurrent cycle caller acquired a live mutex"
  elif [[ "$N9_HOLDER_PID" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$N9_HOLDER_PID" 2>/dev/null || true
    wait "$N9_DRIVER_PID" 2>/dev/null || true
    if kill -0 "$N9_OLD_PID" 2>/dev/null \
        && [[ "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
            && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" \
            && ! -e "$SLOT_DIR/.bridge-cycle.lock" ]]; then
      pass "N9: concurrent caller is excluded and interrupted cycle preserves sentinel"
    else
      fail "N9: interrupted holder lost sentinel or mutex cleanup"
    fi
  else
    fail "N9: first cycle never published its live mutex"
    kill -TERM "$N9_DRIVER_PID" 2>/dev/null || true
    wait "$N9_DRIVER_PID" 2>/dev/null || true
  fi
  printf '%s\n' "$N9_OLD_PID" > "$OWNER_LOCK/pid"
  printf '%s\n' "$N9_OLD_PID" > "$BORROWED_LOCK/pid"
else
  fail "N9: TERM-ignore fixture Bridge did not become healthy"
fi

# N10: an empty post-TERM lsof result is insufficient; the independent Node
# bind proof detects a hidden process that acquired the released port.
reset_slot
write_spec healthy 200
if start_fixture; then
  N10_OLD_PID="$BRIDGE_PID"
  if FLY2237_LSOF_MODE=empty-bind \
      FLY2237_OLD_PID="$N10_OLD_PID" \
      FLY2237_REAL_PYTHON="$REAL_PYTHON" \
      FLY2237_SLOT_DIR="$SLOT_DIR" \
      run_cycle > "$TMP/n10.out" 2> "$TMP/n10.err"; then
    fail "N10: cycle accepted an empty lsof result without a free bind"
  else
    N10_BLOCKER_PID="$(cat "$SLOT_DIR/fixture-blocker.pid" 2>/dev/null || true)"
    if [[ "$N10_BLOCKER_PID" =~ ^[1-9][0-9]*$ \
        && "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
        && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" \
        && "$(cat "$SLOT_DIR/fixture-boot-count")" == "1" ]] \
        && kill -0 "$N10_BLOCKER_PID" 2>/dev/null; then
      pass "N10: positive bind proof rejects a hidden post-TERM port owner"
    else
      fail "N10: hidden port-owner fixture did not exercise bind-proof failure"
    fi
    kill -TERM "$N10_BLOCKER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$N10_BLOCKER_PID" 2>/dev/null || break
      sleep 0.05
    done
    kill -KILL "$N10_BLOCKER_PID" 2>/dev/null || true
    BRIDGE_PID=""
  fi
else
  fail "N10: fixture Bridge did not become healthy"
fi

# N11: explicit teardown remains the cycle-failed recovery path, but it must
# refuse while a live cycle process owns the slot mutex.
reset_slot
mkdir -p "$SLOT_DIR/.bridge-cycle.lock"
printf '%s\n' "$$" > "$SLOT_DIR/.bridge-cycle.lock/pid"
if holder="$(qa_slot_bridge_live_cycle_holder "$SLOT_DIR" 2>/dev/null)" \
    && [[ "$holder" == "$$" ]] \
    && grep -Fq 'qa_slot_bridge_live_cycle_holder "$SLOT_DIR"' "$SCRIPT_DIR/test-teardown.sh" \
    && grep -Fq 'if [[ "$lock_pid" == "cycle-failed" ]]' "$SCRIPT_DIR/test-deploy.sh" \
    && ! grep -Fq 'cycle-failed ownership' "$SCRIPT_DIR/test-teardown.sh"; then
  pass "N11: teardown excludes a live cycle but remains available for cycle-failed"
else
  fail "N11: teardown and cycle lack a live-holder exclusion contract"
fi

# N12: pure validation matrix. N1 already drives the same validator through
# the public CLI; these low-cost mutations cover the remaining input classes.
reset_slot
write_spec healthy 200
cp "$SPEC" "$TMP/n12-valid.json"
N12_OK=1
n12_expect_invalid() {
  if qa_slot_bridge_validate_spec "$SPEC" "$SLOT" "$TMP" >/dev/null 2>&1; then
    N12_OK=0
    fail "N12: validator accepted $1"
  fi
}
chmod 644 "$SPEC"
n12_expect_invalid "world-readable spec"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
jq '.schemaVersion = 2' "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "unknown schema"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
jq '.logPath = "/tmp/outside.log"' "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "out-of-slot log path"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
jq --arg url "http://127.0.0.1:$((PORT + 1))" '.bridgeUrl = $url' \
  "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "bridge URL port mismatch"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
jq '.environment += ["teamlead_api_token=plain-secret"]' "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "plain lowercase secret assignment"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
jq '.environment += ["SAFE_MULTILINE=line1\nline2"]' "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "multiline plain environment value"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
jq '.command[0] = "relative-command"' "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "relative command"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
mkdir -p "$TMP/elsewhere"
cp "$BRIDGE_FIXTURE" "$TMP/elsewhere/run-bridge.ts"
chmod +x "$TMP/elsewhere/run-bridge.ts"
jq --arg script "$TMP/elsewhere/run-bridge.ts" \
  '.scriptPath = $script | .command = [$script]' \
  "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "run-bridge.ts outside the canonical repo cwd"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
jq --arg bash "$REAL_BASH" '.command = [$bash, "-c", "exit 0"]' \
  "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "command missing canonical scriptPath"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
jq '.ownershipPidFiles += ["/tmp/outside.pid"]' "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "out-of-bound ownership path"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
mkdir -p "$SLOT_DIR/state/bridge-env-secrets"
printf '%s\n' secret > "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN"
chmod 644 "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN"
jq --arg path "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN" \
  '.secretEnvironment = [{name:"TEAMLEAD_API_TOKEN",path:$path}]' \
  "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "world-readable secret file"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
chmod 600 "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN"
chmod 755 "$SLOT_DIR/state/bridge-env-secrets"
jq --arg path "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN" \
  '.secretEnvironment = [{name:"TEAMLEAD_API_TOKEN",path:$path}]' \
  "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "world-readable secret directory"
cp "$TMP/n12-valid.json" "$SPEC"; chmod 600 "$SPEC"
chmod 700 "$SLOT_DIR/state/bridge-env-secrets"
printf 'line1\nline2' > "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN"
chmod 600 "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN"
jq --arg path "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_API_TOKEN" \
  '.secretEnvironment = [{name:"TEAMLEAD_API_TOKEN",path:$path}]' \
  "$SPEC" > "$SPEC.tmp"; mv "$SPEC.tmp" "$SPEC"; chmod 600 "$SPEC"
n12_expect_invalid "multiline secret environment value"
cp "$TMP/n12-valid.json" "$TMP/outside-bridge-launch.json"
chmod 600 "$TMP/outside-bridge-launch.json"
if qa_slot_bridge_validate_spec "$TMP/outside-bridge-launch.json" "$SLOT" "$TMP" >/dev/null 2>&1; then
  N12_OK=0
  fail "N12: validator accepted a launch spec outside the canonical slot"
fi
[[ "$N12_OK" == "1" ]] && pass "N12: launch contract validation rejects malformed schema, canonical paths, env, command, and permissions"

# H3: a dead mutex holder is recoverable; it cannot strand a healthy room.
reset_slot
write_spec healthy 200
if start_fixture; then
  H3_OLD_PID="$BRIDGE_PID"
  H3_DEAD_PID=999999
  while kill -0 "$H3_DEAD_PID" 2>/dev/null; do H3_DEAD_PID=$((H3_DEAD_PID - 1)); done
  mkdir -p "$SLOT_DIR/.bridge-cycle.lock"
  printf '%s\n' "$H3_DEAD_PID" > "$SLOT_DIR/.bridge-cycle.lock/pid"
  printf '%s\n' stale-unlocked-file > "$GUARD_PATH"
  if run_cycle > "$TMP/h3.out" 2> "$TMP/h3.err"; then
    H3_NEW_PID="$(cat "$SLOT_DIR/bridge.pid" 2>/dev/null || true)"
    BRIDGE_PID="$H3_NEW_PID"
    if [[ "$H3_NEW_PID" =~ ^[1-9][0-9]*$ && "$H3_NEW_PID" != "$H3_OLD_PID" \
        && ! -e "$SLOT_DIR/.bridge-cycle.lock" ]] \
        && kill -0 "$H3_NEW_PID" 2>/dev/null; then
      pass "H3: dead cycle holder and unlocked guard file are reclaimed"
    else
      fail "H3: dead-holder recovery left inconsistent mutex or Bridge state"
    fi
  else
    fail "H3: dead cycle holder stranded the room"
  fi
else
  fail "H3: fixture Bridge did not become healthy"
fi

# N13: lsof must remain operational after TERM; an error cannot masquerade as
# an empty listener set even when the independent bind would currently pass.
reset_slot
write_spec healthy 200
if start_fixture; then
  N13_OLD_PID="$BRIDGE_PID"
  if FLY2237_LSOF_MODE=denied-after FLY2237_OLD_PID="$N13_OLD_PID" \
      run_cycle > "$TMP/n13.out" 2> "$TMP/n13.err"; then
    fail "N13: post-TERM lsof denial was treated as an empty listener set"
  elif [[ "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
      && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" \
      && "$(cat "$SLOT_DIR/fixture-boot-count")" == "1" ]]; then
    BRIDGE_PID=""
    pass "N13: post-TERM lsof denial fails closed before restart"
  else
    fail "N13: post-TERM lsof denial left inconsistent ownership"
  fi
else
  fail "N13: fixture Bridge did not become healthy"
fi

# N14: EXIT-trap recovery must report a failed cycle-failed persistence. The
# original cycle error still controls the exit status, but losing the durable
# sentinel can never be silent.
if grep -Fq 'qa_slot_bridge_atomic_write "$path" cycle-failed || true' \
    "$SCRIPT_DIR/test-cycle-bridge.sh"; then
  fail "N14: EXIT-trap sentinel write failures are silently swallowed"
elif grep -Fq 'failed to preserve cycle-failed ownership' \
    "$SCRIPT_DIR/test-cycle-bridge.sh"; then
  pass "N14: EXIT-trap sentinel write failures emit an explicit diagnostic"
else
  fail "N14: EXIT-trap sentinel failure contract is missing"
fi

# N16: TERM timeout may restore the old PID only after proving the complete
# original listener-to-launcher chain and health control still hold.
if grep -Fq 'if old_bridge_recoverable; then' "$SCRIPT_DIR/test-cycle-bridge.sh"; then
  pass "N16: TERM timeout restores ownership only for the intact old tree"
else
  fail "N16: TERM timeout restoration checks only a partial old tree"
fi

# N22: a second caller must reject while the first has created the cycle-lock
# directory but has not yet published its PID. This is the historical empty
# lock window that allowed two live callers to proceed.
reset_slot
write_spec ignore-term 200
if start_fixture; then
  N22_OLD_PID="$BRIDGE_PID"
  N22_MARKER="$TMP/n22-mkdir-marker"
  N22_RELEASE="$TMP/n22-mkdir-release"
  ( FLY2237_PAUSE_AFTER_MKDIR="$SLOT_DIR/.bridge-cycle.lock" \
      FLY2237_MKDIR_MARKER="$N22_MARKER" \
      FLY2237_MKDIR_RELEASE="$N22_RELEASE" \
      run_cycle > "$TMP/n22-first.out" 2> "$TMP/n22-first.err" ) &
  N22_DRIVER_PID=$!
  N22_HOLDER_PID=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    N22_HOLDER_PID="$(cat "$N22_MARKER" 2>/dev/null || true)"
    [[ "$N22_HOLDER_PID" =~ ^[1-9][0-9]*$ ]] && break
    sleep 0.02
  done
  if [[ ! "$N22_HOLDER_PID" =~ ^[1-9][0-9]*$ ]]; then
    fail "N22: first caller did not enter the empty-lock publication window"
  elif run_cycle > "$TMP/n22-second.out" 2> "$TMP/n22-second.err"; then
    fail "N22: second caller entered while the first was publishing its mutex"
  elif grep -Fq 'already has a Bridge cycle in progress' "$TMP/n22-second.err" \
      && kill -0 "$N22_HOLDER_PID" 2>/dev/null; then
    pass "N22: empty-lock publication window excludes a second caller"
  else
    fail "N22: second caller was not rejected by the serialization guard"
  fi
  kill -TERM "$N22_HOLDER_PID" 2>/dev/null || true
  printf '%s\n' release > "$N22_RELEASE"
  wait "$N22_DRIVER_PID" 2>/dev/null || true
  if ! kill -0 "$N22_OLD_PID" 2>/dev/null; then
    fail "N22: mutex-race fixture unexpectedly terminated the old Bridge"
  fi
else
  fail "N22: TERM-ignore fixture Bridge did not become healthy"
fi

# N25: teardown and cycle must contend on the same guard even while stale-lock
# recovery has removed the diagnostic PID directory and not yet recreated it.
reset_slot
write_spec ignore-term 200
if start_fixture; then
  N25_OLD_PID="$BRIDGE_PID"
  N25_MARKER="$TMP/n25-rm-marker"
  N25_RELEASE="$TMP/n25-rm-release"
  ( FLY2237_PAUSE_AFTER_RM="$SLOT_DIR/.bridge-cycle.lock" \
      FLY2237_RM_MARKER="$N25_MARKER" \
      FLY2237_RM_RELEASE="$N25_RELEASE" \
      run_cycle > "$TMP/n25-cycle.out" 2> "$TMP/n25-cycle.err" ) &
  N25_DRIVER_PID=$!
  N25_HOLDER_PID=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    N25_HOLDER_PID="$(cat "$N25_MARKER" 2>/dev/null || true)"
    [[ "$N25_HOLDER_PID" =~ ^[1-9][0-9]*$ ]] && break
    sleep 0.02
  done
  N25_GUARD_RC=0
  PATH="$CYCLE_PATH" "$REAL_BASH" -c '
    source "$1"
    qa_slot_bridge_guard_acquire "$2"
  ' _ "$SCRIPT_DIR/lib/qa-slot-bridge.sh" "$SLOT" \
    > "$TMP/n25-guard.out" 2> "$TMP/n25-guard.err" || N25_GUARD_RC=$?
  mkdir -p "$TMP/n25-home"
  N25_TEARDOWN_RC=0
  HOME="$TMP/n25-home" PATH="$CYCLE_PATH" "$REAL_BASH" -c '
    source "$1"
    teardown_slot "$2"
  ' _ "$SCRIPT_DIR/test-teardown.sh" "$SLOT" \
    > "$TMP/n25-teardown.out" 2> "$TMP/n25-teardown.err" || N25_TEARDOWN_RC=$?
  if [[ "$N25_HOLDER_PID" =~ ^[1-9][0-9]*$ \
      && "$N25_GUARD_RC" == "1" && "$N25_TEARDOWN_RC" == "1" ]] \
      && grep -Fq 'has a Bridge cycle in progress' "$TMP/n25-teardown.err"; then
    pass "N25: teardown shares the cycle guard across the absent PID-directory window"
  else
    fail "N25: teardown can enter while cycle stale-lock recovery is in progress"
  fi
  kill -TERM "$N25_HOLDER_PID" 2>/dev/null || true
  printf '%s\n' release > "$N25_RELEASE"
  wait "$N25_DRIVER_PID" 2>/dev/null || true
  if ! kill -0 "$N25_OLD_PID" 2>/dev/null; then
    fail "N25: guard-window fixture unexpectedly terminated the old Bridge"
  fi
else
  fail "N25: TERM-ignore fixture Bridge did not become healthy"
fi

# N23: interruption after the first owner-lock sentinel write must repair the
# full lock set before releasing the cycle mutex.
reset_slot
write_spec healthy 200
if start_fixture; then
  N23_OLD_PID="$BRIDGE_PID"
  N23_MARKER="$TMP/n23-sentinel-marker"
  if FLY2237_SIGNAL_AFTER_MV="$OWNER_LOCK/pid" \
      FLY2237_SIGNAL_MARKER="$N23_MARKER" \
      run_cycle > "$TMP/n23.out" 2> "$TMP/n23.err"; then
    fail "N23: sentinel-publication interruption unexpectedly returned success"
  elif [[ -e "$N23_MARKER" \
      && "$(cat "$OWNER_LOCK/pid")" == "cycle-failed" \
      && "$(cat "$BORROWED_LOCK/pid")" == "cycle-failed" \
      && ! -e "$SLOT_DIR/.bridge-cycle.lock" ]] \
      && kill -0 "$N23_OLD_PID" 2>/dev/null \
      && [[ ! -s "$SLOT_DIR/fixture-term.log" ]]; then
    pass "N23: interrupted sentinel publication repairs every ownership lock"
  else
    fail "N23: interrupted sentinel publication left mixed ownership"
  fi
else
  fail "N23: fixture Bridge did not become healthy"
fi

# N18: capture rejects both plain and secret multiline values before it writes
# a replayable launch contract.
reset_slot
mkdir -p "$SLOT_DIR" "$OWNER_LOCK"
chmod 700 "$SLOT_DIR"
N18_OK=1
for assignment in $'SAFE_MULTILINE=line1\nline2' $'NOVEL_TOKEN=line1\nline2'; do
  rm -f "$SPEC"
  rm -rf "$SLOT_DIR/state/bridge-env-secrets"
  if env -i PATH="$BRIDGE_PATH" PWD="$TMP" "$assignment" \
      "$REAL_NODE" "$SCRIPT_DIR/lib/qa-slot-bridge-spec.mjs" capture \
        --spec "$SPEC" --slot "$SLOT" --port "$PORT" --cwd "$TMP" \
        --repo-root "$TMP" \
        --session-launcher "$REAL_PYTHON" \
        --log "$SLOT_DIR/bridge.log" --bridge-url "http://127.0.0.1:${PORT}" \
        --script "$BRIDGE_FIXTURE" --ownership-pid-file "$OWNER_LOCK/pid" \
        -- "$BRIDGE_FIXTURE" >/dev/null 2> "$TMP/n18.err"; then
    N18_OK=0
  fi
done
if [[ "$N18_OK" == "1" ]]; then
  pass "N18: capture rejects plain and secret multiline environment values"
else
  fail "N18: capture accepted a multiline environment value"
fi

# N24: test-deploy passes command-v results, which are commonly symlinks on
# developer hosts. Capture must resolve those executable links to canonical
# regular files, while still rejecting a URL whose port disagrees with .port.
reset_slot
mkdir -p "$SLOT_DIR" "$OWNER_LOCK"
chmod 700 "$SLOT_DIR"
ln -s "$REAL_PYTHON" "$TMP/session-launcher-link"
ln -s "$BRIDGE_FIXTURE" "$TMP/bridge-command-link"
N24_OK=1
if ! env -i PATH="$BRIDGE_PATH" PWD="$TMP" \
    "$REAL_NODE" "$SCRIPT_DIR/lib/qa-slot-bridge-spec.mjs" capture \
      --spec "$SPEC" --slot "$SLOT" --port "$PORT" --cwd "$TMP" \
      --repo-root "$TMP" --session-launcher "$TMP/session-launcher-link" \
      --log "$SLOT_DIR/bridge.log" --bridge-url "http://127.0.0.1:${PORT}" \
      --script "$BRIDGE_FIXTURE" --ownership-pid-file "$OWNER_LOCK/pid" \
      -- "$TMP/bridge-command-link" >/dev/null 2> "$TMP/n24-symlink.err"; then
  N24_OK=0
elif ! jq -e --arg python "$REAL_PYTHON" --arg command "$BRIDGE_FIXTURE" \
    '.sessionLauncher == $python and .command[0] == $command' "$SPEC" >/dev/null; then
  N24_OK=0
fi
if env -i PATH="$BRIDGE_PATH" PWD="$TMP" \
    "$REAL_NODE" "$SCRIPT_DIR/lib/qa-slot-bridge-spec.mjs" capture \
      --spec "$SPEC" --slot "$SLOT" --port "$PORT" --cwd "$TMP" \
      --repo-root "$TMP" --session-launcher "$REAL_PYTHON" \
      --log "$SLOT_DIR/bridge.log" --bridge-url "http://127.0.0.1:$((PORT + 1))" \
      --script "$BRIDGE_FIXTURE" --ownership-pid-file "$OWNER_LOCK/pid" \
      -- "$BRIDGE_FIXTURE" >/dev/null 2> "$TMP/n24-port.err"; then
  N24_OK=0
fi
if [[ "$N24_OK" == "1" ]]; then
  pass "N24: capture canonicalizes executable symlinks and binds URL port to slot port"
else
  fail "N24: capture rejected normal executable links or accepted a mismatched URL port"
fi

# N26: the guard backend must work in both macOS 529 rooms and ubuntu-latest.
N26_LOCKF="$(
  qa_slot_bridge_has_lockf() { return 0; }
  qa_slot_bridge_has_flock() { return 0; }
  qa_slot_bridge_has_python_fcntl() { return 0; }
  qa_slot_bridge_select_guard_backend
)"
N26_FLOCK="$(
  qa_slot_bridge_has_lockf() { return 1; }
  qa_slot_bridge_has_flock() { return 0; }
  qa_slot_bridge_has_python_fcntl() { return 0; }
  qa_slot_bridge_select_guard_backend
)"
N26_PYTHON="$(
  qa_slot_bridge_has_lockf() { return 1; }
  qa_slot_bridge_has_flock() { return 1; }
  qa_slot_bridge_has_python_fcntl() { return 0; }
  qa_slot_bridge_select_guard_backend
)"
N26_MISSING_RC=0
N26_MISSING="$(
  qa_slot_bridge_has_lockf() { return 1; }
  qa_slot_bridge_has_flock() { return 1; }
  qa_slot_bridge_has_python_fcntl() { return 1; }
  qa_slot_bridge_select_guard_backend
)" || N26_MISSING_RC=$?
if [[ "$N26_LOCKF" == "lockf" && "$N26_FLOCK" == "flock" \
    && "$N26_PYTHON" == "python" && "$N26_MISSING_RC" != "0" \
    && -z "$N26_MISSING" ]]; then
  pass "N26: cycle guard selects lockf, flock, then Python fcntl fail-closed"
else
  fail "N26: cycle guard lacks the portable advisory-lock backend chain"
fi

echo "=================================="
echo "test-cycle-bridge tests: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
