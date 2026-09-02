#!/usr/bin/env bash
# FLY-2274: Darwin-only real 3.5a private-socket stop rehearsal.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STOP="$ROOT/scripts/cutover/FLY-2264/stop-old-tmux-servers.sh"
LIB="$ROOT/scripts/cutover/FLY-2264/lib/tmux-process-inventory.sh"
OLD="/usr/local/Cellar/tmux/3.5a/bin/tmux"

if [[ "$(uname -s)" != Darwin ]]; then
  printf '[SKIP] FLY-2274 real tmux drill requires Darwin\n'
  exit 0
fi
if [[ ! -x "$OLD" ]]; then
  printf '[SKIP] FLY-2274 real tmux drill requires %s\n' "$OLD"
  exit 0
fi

# This production-client control deliberately runs before the process-inspection
# guard: it catches differences between a real tmux formatter and shell stubs.
PROBE_TMP="$(mktemp -d -t fly2264-real-probe.XXXXXX)"
PROBE_SOCKET="$PROBE_TMP/probe.sock"
cleanup_probe() {
  "$OLD" -S "$PROBE_SOCKET" kill-server >/dev/null 2>&1 || true
  rm -rf "$PROBE_TMP"
}
trap cleanup_probe EXIT
"$OLD" -S "$PROBE_SOCKET" new-session -d -s fly2264-probe 'sleep 30'
PROBE_PID="$($OLD -S "$PROBE_SOCKET" display-message -p '#{pid}')"
JQ_BIN=jq
export JQ_BIN
# Sourced inventory calls this on stable inspection failures.
# shellcheck disable=SC2329
die() { printf '[FAIL] real probe: %s\n' "$*" >&2; exit 1; }
# shellcheck disable=SC1090
source "$LIB"
PROBE_RESULT="$(tmux_probe_socket_owner "$OLD" "$PROBE_SOCKET")"
[[ "$PROBE_RESULT" == "$PROBE_PID"$'\t'"$PROBE_SOCKET" ]] || {
  printf '[FAIL] real tmux owner probe returned %q\n' "$PROBE_RESULT" >&2
  exit 1
}
cleanup_probe
trap - EXIT
printf '[PASS] real tmux owner probe validates pid and socket independently\n'

if ! /bin/ps -p $$ -o lstart= >/dev/null 2>&1 \
    || ! command -v lsof >/dev/null 2>&1; then
  printf '[SKIP] FLY-2274 real tmux drill requires process inspection (sandbox denied it)\n'
  exit 0
fi

TMP="$(mktemp -d /private/tmp/f2264.XXXXXX)"
TMP="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP")"
PIDS="$TMP/target-pids"
mkdir -p "$TMP/bin"
: >"$PIDS"

target_sockets=("$TMP/target-a.sock" "$TMP/target-b.sock" "$TMP/target-c.sock")
control_socket="$TMP/control.sock"
cleanup() {
  for socket in "${target_sockets[@]}" "$control_socket"; do
    "$OLD" -S "$socket" kill-server >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

for index in 0 1 2; do
  "$OLD" -S "${target_sockets[$index]}" new-session -d -s "fly2264-target-$index" 'sleep 120'
  "$OLD" -S "${target_sockets[$index]}" display-message -p '#{pid}' >>"$PIDS"
done
"$OLD" -S "$control_socket" new-session -d -s fly2264-control 'sleep 120'
control_pid="$($OLD -S "$control_socket" display-message -p '#{pid}')"

cat >"$TMP/bin/pgrep" <<'STUB'
#!/usr/bin/env bash
while IFS= read -r pid; do
  kill -0 "$pid" 2>/dev/null && printf '%s\n' "$pid"
done <"${FLY2264_REAL_TARGET_PIDS:?}"
[[ -s "${FLY2264_REAL_TARGET_PIDS}" ]] || exit 1
STUB
cat >"$TMP/bin/launchctl" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == print && "${2:-}" == pid/* ]] || exit 64
printf 'pid = {\n\tresource coalition = {\n\t\tname = com.flywheel.bridge\n\t}\n}\n'
STUB
chmod +x "$TMP/bin/pgrep" "$TMP/bin/launchctl"
export PATH="$TMP/bin:$PATH"
export FLY2264_REAL_TARGET_PIDS="$PIDS"

JQ_BIN=jq
export JQ_BIN
die() { printf '[FAIL] real inventory: %s\n' "$*" >&2; exit 1; }
# shellcheck disable=SC1090
source "$LIB"
inventory_tmux_servers >"$TMP/union.json"
[[ "$(jq 'length' "$TMP/union.json")" -eq 3 ]] || {
  printf '[FAIL] expected exactly three exposed target processes\n' >&2
  exit 1
}

"$STOP" "$TMP/union.json" "$OLD" >"$TMP/result.json"
jq -e '.status == "pass" and (.stoppedServerPids | length == 3)' "$TMP/result.json" >/dev/null
while IFS= read -r pid; do
  if kill -0 "$pid" 2>/dev/null; then
    printf '[FAIL] target tuple still alive: %s\n' "$pid" >&2
    exit 1
  fi
done <"$PIDS"
kill -0 "$control_pid" 2>/dev/null \
  && "$OLD" -S "$control_socket" display-message -p '#{pid}' | grep -qxF "$control_pid"
printf '[PASS] three private 3.5a targets stopped; independent control pid=%s survived\n' "$control_pid"
