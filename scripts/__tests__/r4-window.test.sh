#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WINDOW_SCRIPT="$REPO_ROOT/scripts/r4/r4-window.sh"
TREE_LIB="$REPO_ROOT/scripts/lib/bridge-process-tree.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1649-window.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

[[ -f "$WINDOW_SCRIPT" ]] || { echo "FAIL: missing $WINDOW_SCRIPT" >&2; exit 1; }
# shellcheck disable=SC1090
R4_WINDOW_SOURCE_ONLY=1 source "$WINDOW_SCRIPT"
for fn in r4_window_main r4_assert_all_manifest_leads_loaded r4_reap_trial_bridge r4_activate; do
    declare -F "$fn" >/dev/null || { echo "FAIL: missing function $fn" >&2; exit 1; }
done

assert_contains() {
    local file="$1" expected="$2"
    grep -Fq "$expected" "$file" || {
        echo "FAIL: expected '$expected' in $file" >&2
        sed -n '1,200p' "$file" >&2
        exit 1
    }
}

assert_not_contains() {
    local file="$1" unexpected="$2"
    if grep -Fq "$unexpected" "$file"; then
        echo "FAIL: unexpected '$unexpected' in $file" >&2
        sed -n '1,200p' "$file" >&2
        exit 1
    fi
}

run_case() {
    local name="$1" failure="$2" bridge_state="${3:-unloaded}"
    local events="$TMP_ROOT/$name.events"
    : > "$events"
    (
        R4_EVENTS="$events"
        R4_MUTATED=0
        R4_COMMITTED=0
        R4_BRIDGE_ORIGINAL_STATE="$bridge_state"
        R4_TRIAL_PID=""
        r4_log() { printf 'log:%s\n' "$*" >> "$R4_EVENTS"; }
        r4_validate_config() { :; }
        r4_assert_all_manifest_leads_loaded() {
            printf 'lead-preflight\n' >> "$R4_EVENTS"
            [[ "$failure" != unloaded-lead ]]
        }
        r4_quiesce() { printf 'Q\n' >> "$R4_EVENTS"; }
        r4_assert_canonical_modes() { printf 'Q:modes\n' >> "$R4_EVENTS"; }
        r4_inventory() { printf 'Q:inventory\n' >> "$R4_EVENTS"; }
        r4_snapshot() { printf 'S\n' >> "$R4_EVENTS"; }
        r4_reset_nonfly() {
            printf 'M:reset\n' >> "$R4_EVENTS"
            [[ "$failure" != reset ]]
        }
        r4_deploy_target() { printf 'M:code\n' >> "$R4_EVENTS"; }
        r4_migrate() {
            printf 'M:migrate\n' >> "$R4_EVENTS"
            [[ "$failure" != migrate ]]
        }
        r4_preflight() { printf 'M:preflight\n' >> "$R4_EVENTS"; }
        r4_start_trial() {
            printf 'B:start\n' >> "$R4_EVENTS"
            [[ "$failure" != trial-start ]]
        }
        r4_wait_trial_health() { printf 'B:health\n' >> "$R4_EVENTS"; }
        r4_stormwatch() {
            printf 'B:stormwatch\n' >> "$R4_EVENTS"
            [[ "$failure" != stormwatch ]]
        }
        r4_reap_trial_bridge() { printf 'B:reap\n' >> "$R4_EVENTS"; }
        r4_run_rollback() { printf 'ROLLBACK:whole-state\n' >> "$R4_EVENTS"; }
        r4_restore_lead_authority() { printf 'C:leads\n' >> "$R4_EVENTS"; }
        r4_restore_bridge_authority() { printf 'C:bridge-authority\n' >> "$R4_EVENTS"; }
        r4_activate() {
            printf 'C:activate\n' >> "$R4_EVENTS"
            [[ "$failure" != activate ]]
        }
        r4_verify_fleet() { printf 'C:verify\n' >> "$R4_EVENTS"; }
        r4_restore_updater() { printf 'R:updater\n' >> "$R4_EVENTS"; }
        r4_verify_final() { printf 'R:single-healthy-bridge\n' >> "$R4_EVENTS"; }
        r4_window_main
    ) >/dev/null 2>&1 || true
    printf '%s\n' "$events"
}

events="$(run_case trial-start trial-start)"
assert_contains "$events" "B:reap"
assert_contains "$events" "ROLLBACK:whole-state"
assert_not_contains "$events" "C:leads"
assert_not_contains "$events" "R:updater"

events="$(run_case stormwatch stormwatch)"
assert_contains "$events" "B:reap"
assert_contains "$events" "ROLLBACK:whole-state"
assert_not_contains "$events" "C:leads"

events="$(run_case reset reset)"
assert_contains "$events" "ROLLBACK:whole-state"
assert_not_contains "$events" "B:start"

events="$(run_case migrate migrate)"
assert_contains "$events" "ROLLBACK:whole-state"
assert_not_contains "$events" "B:start"

events="$(run_case activation activate)"
assert_contains "$events" "C:activate"
assert_not_contains "$events" "ROLLBACK:whole-state"
assert_not_contains "$events" "R:updater"

events="$(run_case success-unloaded none unloaded)"
assert_not_contains "$events" "C:bridge-authority"
assert_contains "$events" "R:single-healthy-bridge"

events="$(run_case success-loaded none loaded)"
assert_contains "$events" "C:bridge-authority"
assert_contains "$events" "R:single-healthy-bridge"

events="$(run_case unloaded-lead unloaded-lead)"
assert_contains "$events" "lead-preflight"
assert_not_contains "$events" "S"
assert_not_contains "$events" "M:reset"

echo "r4-window: eight lifecycle/failure cases PASS"

# The real activation call must cross the restart script's top-level detach
# seam in FOREGROUND mode. A fake restart prints detached only when the env is
# absent; Phase R may never follow a detached marker.
FAKE_RESTART="$TMP_ROOT/restart-services.sh"
cat > "$FAKE_RESTART" <<'SH'
#!/usr/bin/env bash
if [[ "${FLYWHEEL_RESTART_FOREGROUND:-0}" != "1" ]]; then
    echo "[restart] detached PID 999"
    exit 0
fi
echo "foreground=${FLYWHEEL_RESTART_FOREGROUND} disable=${FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK:-0}"
SH
chmod +x "$FAKE_RESTART"
R4_RESTART_SCRIPT="$FAKE_RESTART"
activation_output="$(r4_activate)"
[[ "$activation_output" == *"foreground=1 disable=1"* ]] || {
    echo "FAIL: activation did not force foreground migration-safe restart" >&2
    exit 1
}
[[ "$activation_output" != *"[restart] detached"* ]] || {
    echo "FAIL: activation crossed into Phase R after a detached restart" >&2
    exit 1
}
echo "r4-window: real restart top-level detach seam PASS"

# Real three-layer tree: listener (python) -> tsx-named shell -> npx-named shell.
# r4_reap_trial_bridge must kill every layer and release the port.
PORT_FILE="$TMP_ROOT/port"
PY_LISTENER="$TMP_ROOT/run-bridge.ts-listener.py"
TSX_WRAPPER="$TMP_ROOT/run-bridge.ts-tsx.sh"
NPX_WRAPPER="$TMP_ROOT/run-bridge.ts-npx.sh"
PY_PID_FILE="$TMP_ROOT/python.pid"
TSX_PID_FILE="$TMP_ROOT/tsx.pid"
NPX_PID_FILE="$TMP_ROOT/npx.pid"
cat > "$PY_LISTENER" <<'PY'
import os
import signal
import socket
import sys
import time

listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(str(listener.getsockname()[1]))
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    handle.write(str(os.getpid()))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    time.sleep(1)
PY
cat > "$TSX_WRAPPER" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$BASHPID" > "$1"
shift
python3 "$1" "$2" "$3" &
wait
SH
cat > "$NPX_WRAPPER" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$BASHPID" > "$1"
shift
bash "$1" "$2" "$3" "$4" "$5" &
wait
SH
chmod +x "$TSX_WRAPPER" "$NPX_WRAPPER"
bash "$NPX_WRAPPER" "$NPX_PID_FILE" "$TSX_WRAPPER" "$TSX_PID_FILE" \
    "$PY_LISTENER" "$PORT_FILE" "$PY_PID_FILE" &
R4_TRIAL_PID=$!
for _ in $(seq 1 50); do
    [[ -s "$PORT_FILE" && -s "$PY_PID_FILE" && -s "$TSX_PID_FILE" && -s "$NPX_PID_FILE" ]] && break
    sleep 0.1
done
[[ -s "$PORT_FILE" && -s "$PY_PID_FILE" && -s "$TSX_PID_FILE" && -s "$NPX_PID_FILE" ]] || {
    echo "FAIL: real trial process tree did not start" >&2
    exit 1
}
BRIDGE_URL="http://127.0.0.1:$(cat "$PORT_FILE")"
# shellcheck disable=SC1090
source "$TREE_LIB"
PY_PID="$(cat "$PY_PID_FILE")"
TSX_PID="$(cat "$TSX_PID_FILE")"
NPX_PID="$(cat "$NPX_PID_FILE")"
# The execution sandbox denies ps(1), so keep the production process seams but
# feed them identities recorded by the three real processes themselves.
_ppid_of() {
    case "$1" in
        "$PY_PID") printf '%s\n' "$TSX_PID" ;;
        "$TSX_PID") printf '%s\n' "$NPX_PID" ;;
        *) printf '1\n' ;;
    esac
}
_args_of() {
    case "$1" in
        "$PY_PID") printf '%s\n' "python run-bridge listener" ;;
        "$TSX_PID") printf '%s\n' "tsx scripts/run-bridge.ts" ;;
        "$NPX_PID") printf '%s\n' "npx tsx scripts/run-bridge.ts" ;;
        *) return 1 ;;
    esac
}
tree_before="$(bridge_target_pids)"
[[ "$(printf '%s\n' "$tree_before" | awk 'NF {n++} END {print n+0}')" -eq 3 ]] || {
    echo "FAIL: expected three process-tree layers, got: $tree_before" >&2
    exit 1
}
r4_reap_trial_bridge
for pid in $tree_before; do
    if kill -0 "$pid" 2>/dev/null; then
        echo "FAIL: trial process survived cleanup: $pid" >&2
        exit 1
    fi
done
[[ -z "$(_listeners_on_port "$(bridge_port)")" ]] || {
    echo "FAIL: trial listener port remained bound" >&2
    exit 1
}
echo "r4-window: real three-layer trial reaping PASS"

# Snapshot producer and rollback consumer must agree on the exact seven-shard
# DB/sidecar/refs manifest shape.
SNAP_COMM="$TMP_ROOT/snapshot-comm"
SNAP_OUT="$TMP_ROOT/snapshot"
for shard in flywheel geoforge3d growth joycon-typeless personal-assistant sub tidal-echo; do
    mkdir -p "$SNAP_COMM/$shard/refs"
    sqlite3 "$SNAP_COMM/$shard/comm.db" "CREATE TABLE t(v TEXT); INSERT INTO t VALUES('ok');"
    printf 'ref\n' > "$SNAP_COMM/$shard/refs/body"
done
R4_SNAPSHOT_COMM_ROOT="$SNAP_COMM" R4_SNAPSHOT_OUTPUT="$SNAP_OUT" \
    bash "$REPO_ROOT/scripts/r4/snapshot-r4.sh" >/dev/null
(
    export ROLLBACK_R4_SOURCE_ONLY=1
    source "$REPO_ROOT/scripts/r4/rollback-r4.sh"
    ROLLBACK_R4_SNAPSHOT_DIR="$SNAP_OUT"
    [[ -d "$SNAP_OUT/files" ]]
    verify_manifest_tree "$SNAP_OUT/files"
    verify_snapshot_sqlite "$SNAP_OUT/files"
)
[[ "$(wc -l < "$SNAP_OUT/manifest.tsv" | tr -d ' ')" -eq 14 ]] || {
    echo "FAIL: snapshot manifest did not include seven DBs and seven refs" >&2
    exit 1
}
echo "r4-window: snapshot/rollback manifest parity PASS"

echo "r4-window: PASS"
