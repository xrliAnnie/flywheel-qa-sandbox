#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WINDOW_SCRIPT="$REPO_ROOT/scripts/r4/r4-window.sh"
TREE_LIB="$REPO_ROOT/scripts/lib/bridge-process-tree.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1649-window.XXXXXX")"
cleanup_r4_window_test() {
	local pid_file pid
	for pid_file in "${PY_PID_FILE:-}" "${TSX_PID_FILE:-}" "${NPX_PID_FILE:-}"; do
		[[ -n "$pid_file" && -f "$pid_file" ]] || continue
		pid="$(cat "$pid_file" 2>/dev/null || true)"
		[[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
		kill -TERM "$pid" 2>/dev/null || true
	done
	pid="${R4_TRIAL_PID:-}"
	if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
		kill -TERM "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	fi
	rm -rf "$TMP_ROOT"
}
trap cleanup_r4_window_test EXIT

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

# Bash disables errexit throughout a function invoked from an `if`/`||`
# condition. Every destructive phase therefore has to propagate each safety
# failure explicitly rather than depend on the script-level `set -e`.
if (
	R4_LOADED_LEAD_LABELS_FILE="$TMP_ROOT/quiesce-loaded"
	r4_assert_updater_quiet() { return 7; }
	r4_launch_state() { printf 'unloaded\n'; }
	r4_installed_lead_labels() { :; }
	r4_reap_trial_bridge() { :; }
	r4_assert_authority_empty() { :; }
	r4_assert_no_db_holders() { :; }
	r4_quiesce
); then
	echo "FAIL: quiesce swallowed updater-quiet failure" >&2
	exit 1
fi

FAIL_SNAPSHOT="$TMP_ROOT/fail-snapshot.sh"
cat > "$FAIL_SNAPSHOT" <<'SH'
#!/usr/bin/env bash
exit 23
SH
chmod +x "$FAIL_SNAPSHOT"
if (
	R4_SNAPSHOT_SCRIPT="$FAIL_SNAPSHOT"
	R4_SNAPSHOT_DIR="$TMP_ROOT/never-created-snapshot"
	R4_COMM_ROOT="$TMP_ROOT/comm"
	R4_REPO="$REPO_ROOT"
	R4_ROOT="$TMP_ROOT/snapshot-failure"
	mkdir -p "$R4_ROOT"
	r4_assert_authority_empty() { :; }
	r4_assert_no_db_holders() { :; }
	r4_snapshot_dist() { :; }
	r4_render_rollback() { :; }
	r4_snapshot
); then
	echo "FAIL: snapshot phase swallowed snapshot producer failure" >&2
	exit 1
fi

if (
	_listeners_on_port() { printf '42\n'; }
	bridge_port() { printf '9876\n'; }
	r4_health_ok() { return 8; }
	r4_verify_fleet() { :; }
	r4_launch_state() { printf 'loaded\n'; }
	r4_verify_final
); then
	echo "FAIL: final verification swallowed health failure" >&2
	exit 1
fi

MISSING_CANONICAL="$TMP_ROOT/missing-canonical/comm.db"
if r4_classify_db "$MISSING_CANONICAL" >/dev/null 2>&1; then
	echo "FAIL: classification accepted a missing canonical DB" >&2
	exit 1
fi
[[ ! -e "$MISSING_CANONICAL" ]] || {
	echo "FAIL: classification created a missing canonical DB" >&2
	exit 1
}

# The flywheel shard survives Phase M-reset and must already exist. The other
# six shards are deliberately retired, so preflight recreates them as virgin
# mailbox DBs before the Bridge-only trial.
POST_RESET_ROOT="$TMP_ROOT/post-reset"
mkdir -p "$POST_RESET_ROOT/flywheel"
(
	cd "$REPO_ROOT"
	DB_PATH="$POST_RESET_ROOT/flywheel/comm.db" pnpm exec tsx -e \
		'import { CommDB } from "./packages/flywheel-comm/src/db.ts"; const db = new CommDB(process.env.DB_PATH!); db.close();'
)
FLYWHEEL_COMM_ROOT="$POST_RESET_ROOT" pnpm -C "$REPO_ROOT" exec tsx \
	"$REPO_ROOT/scripts/r4/preflight-r4.ts" >/dev/null
for shard in geoforge3d growth joycon-typeless personal-assistant sub tidal-echo; do
	[[ -f "$POST_RESET_ROOT/$shard/comm.db" ]] || {
		echo "FAIL: preflight did not recreate reset shard: $shard" >&2
		exit 1
	}
done

PREFLIGHT_MISSING_ROOT="$TMP_ROOT/preflight-missing"
set +e
FLYWHEEL_COMM_ROOT="$PREFLIGHT_MISSING_ROOT" pnpm -C "$REPO_ROOT" exec tsx \
	"$REPO_ROOT/scripts/r4/preflight-r4.ts" >/dev/null 2>&1
preflight_missing_rc=$?
set -e
[[ "$preflight_missing_rc" -ne 0 ]] || {
	echo "FAIL: preflight accepted a missing persistent flywheel shard" >&2
	exit 1
}
[[ ! -e "$PREFLIGHT_MISSING_ROOT/flywheel/comm.db" ]] || {
	echo "FAIL: preflight recreated the persistent flywheel shard" >&2
	exit 1
}
echo "r4-window: destructive phase failures and missing DBs fail closed PASS"

if ! (
	R4_REPO="$REPO_ROOT"
	FLYWHEEL_COMM_DB="$TMP_ROOT/wrong-shard/comm.db"
	npx() {
		[[ -z "${FLYWHEEL_COMM_DB+x}" ]] || return 91
		[[ "$*" == "tsx scripts/migrate-fly1572-mailbox.ts --confirm-quiesced" ]]
	}
	r4_migrate
); then
	echo "FAIL: migration inherited an ambient FLYWHEEL_COMM_DB shard override" >&2
	exit 1
fi
echo "r4-window: migration clears the ambient shard override PASS"

MANIFEST_HOME="$TMP_ROOT/manifest-home"
mkdir -p "$MANIFEST_HOME/.flywheel/manifests" "$MANIFEST_HOME/Library/LaunchAgents"
printf '%s\n' '{"projectName":"aaa","leadId":"aaa-lead"}' > \
	"$MANIFEST_HOME/.flywheel/manifests/a-good.json"
printf '%s\n' '{"projectName":"broken"}' > \
	"$MANIFEST_HOME/.flywheel/manifests/b-broken.json"
printf '%s\n' '{"projectName":"zzz","leadId":"zzz-lead"}' > \
	"$MANIFEST_HOME/.flywheel/manifests/c-good.json"
: > "$MANIFEST_HOME/Library/LaunchAgents/com.flywheel.lead.aaa-aaa-lead.plist"
: > "$MANIFEST_HOME/Library/LaunchAgents/com.flywheel.lead.zzz-zzz-lead.plist"
if (
	HOME="$MANIFEST_HOME"
	R4_LEAD_LABELS_FILE="$TMP_ROOT/malformed-manifest-labels"
	r4_launch_state() { printf 'loaded\n'; }
	r4_assert_all_manifest_leads_loaded
); then
	echo "FAIL: malformed manifest silently truncated the production Lead ledger" >&2
	exit 1
fi
echo "r4-window: malformed manifest fails the Phase-Q Lead census closed PASS"

# Production macOS ships Bash 3.2, where nounset treats an empty `arr[@]`
# expansion as an unbound variable. Exercise the real system Bash so a zero-Lead
# recovery host remains a valid authority-empty state.
ZERO_LEAD_HOME="$TMP_ROOT/zero-lead-home"
mkdir -p "$ZERO_LEAD_HOME/.flywheel/manifests" "$ZERO_LEAD_HOME/Library/LaunchAgents"
set +e
zero_lead_output="$(HOME="$ZERO_LEAD_HOME" R4_WINDOW_SOURCE_ONLY=1 /bin/bash -c '
	set -euo pipefail
	source "$1"
	[[ -z "$(r4_manifest_lead_labels)" ]]
	[[ -z "$(r4_installed_lead_labels)" ]]
	r4_launch_state() { printf "unloaded\n"; }
	r4_assert_authority_empty
	printf "bash=%s.%s zero-lead-ok\n" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"
' _ "$WINDOW_SCRIPT" 2>&1)"
zero_lead_rc=$?
set -e
[[ "$zero_lead_rc" -eq 0 && "$zero_lead_output" == *"zero-lead-ok"* ]] || {
	echo "FAIL: zero-Lead authority census failed under /bin/bash: $zero_lead_output" >&2
	exit 1
}
echo "r4-window: $zero_lead_output PASS"

RESTORE_EVENTS="$TMP_ROOT/restore-pre-window.events"
: > "$RESTORE_EVENTS"
set +e
(
	R4_QUIESCE_STARTED=1
	R4_BRIDGE_ORIGINAL_STATE=loaded
	r4_launch_state() { printf 'unloaded\n'; }
	launchctl() { return 1; }
	r4_restore_lead_authority() { printf 'leads-attempted\n' >> "$RESTORE_EVENTS"; }
	r4_restore_pre_window
)
restore_pre_window_rc=$?
set -e
[[ "$restore_pre_window_rc" -ne 0 ]] || {
	echo "FAIL: partial pre-window restoration did not report failure" >&2
	exit 1
}
assert_contains "$RESTORE_EVENTS" "leads-attempted"
echo "r4-window: pre-window recovery attempts Leads after Bridge failure PASS"

ROLLBACK_AFTER_LOG_MARKER="$TMP_ROOT/rollback-after-log-failure"
set +e
R4_WINDOW_SOURCE_ONLY=1 bash -c '
	set -euo pipefail
	source "$1"
	R4_MUTATED=1
	R4_COMMITTED=0
	R4_PHASE=M-test
	ROLLBACK_MARKER="$2"
	r4_log() { return 1; }
	r4_run_rollback() { printf "rollback-ran\n" > "$ROLLBACK_MARKER"; }
	r4_write_state() { :; }
	r4_fail injected
' _ "$WINDOW_SCRIPT" "$ROLLBACK_AFTER_LOG_MARKER" >/dev/null 2>&1
rollback_after_log_rc=$?
set -e
[[ "$rollback_after_log_rc" -ne 0 && -f "$ROLLBACK_AFTER_LOG_MARKER" ]] || {
	echo "FAIL: log failure aborted the whole-state rollback handler" >&2
	exit 1
}
echo "r4-window: logging failure cannot suppress whole-state rollback PASS"

STALE_LEDGER_ROOT="$TMP_ROOT/stale-ledger"
STALE_LEDGER="$STALE_LEDGER_ROOT/loaded-lead-labels.txt"
STALE_LEDGER_MARKER="$STALE_LEDGER_ROOT/stale-used"
mkdir -p "$STALE_LEDGER_ROOT"
printf 'com.flywheel.lead.retired-old\n' > "$STALE_LEDGER"
(
	R4_ROOT="$STALE_LEDGER_ROOT"
	R4_PROGRESS_LOG="$STALE_LEDGER_ROOT/progress.log"
	R4_STATE_FILE="$STALE_LEDGER_ROOT/state"
	R4_LOADED_LEAD_LABELS_FILE="$STALE_LEDGER"
	r4_validate_config() { :; }
	r4_write_state() { :; }
	r4_assert_all_manifest_leads_loaded() { :; }
	r4_quiesce() { return 1; }
	r4_fail() {
		[[ ! -s "$R4_LOADED_LEAD_LABELS_FILE" ]] || : > "$STALE_LEDGER_MARKER"
		return 1
	}
	r4_window_main
) >/dev/null 2>&1 || true
[[ ! -e "$STALE_LEDGER_MARKER" ]] || {
	echo "FAIL: current window recovery consumed a stale Lead ledger" >&2
	exit 1
}
echo "r4-window: each window invalidates the prior loaded-Lead ledger PASS"

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
printf '%s\n' "$$" > "$1"
shift
python3 "$1" "$2" "$3" &
wait
SH
cat > "$NPX_WRAPPER" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$$" > "$1"
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
for pid_file in "$PY_PID_FILE" "$TSX_PID_FILE" "$NPX_PID_FILE"; do
	pid="$(cat "$pid_file")"
	[[ "$pid" =~ ^[1-9][0-9]*$ ]] || {
		echo "FAIL: fixture emitted a nonnumeric PID in $pid_file: $pid" >&2
		exit 1
	}
done
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

# FLY-1959: R4 may bootstrap updater only after preparing the sole watched
# founder-urgent directory. This stays shell-only; plist structure is covered
# portably by updater-trigger-policy.test.sh.
R4_URGENT_HOME="$TMP_ROOT/r4-urgent-home"
if ! (
    HOME="$R4_URGENT_HOME"
    r4_launch_state() { printf 'unloaded\n'; }
    r4_assert_updater_quiet
); then
    echo "FAIL: updater quiet preflight rejected an empty urgent directory" >&2
    exit 1
fi
urgent_dir="$R4_URGENT_HOME/.flywheel/self-ship-urgent.d"
urgent_mode="$(stat -c %a "$urgent_dir" 2>/dev/null || stat -f %Lp "$urgent_dir")"
[[ -d "$urgent_dir" && "$urgent_mode" == 700 ]] || {
    echo "FAIL: updater quiet preflight did not create mode-0700 urgent dir" >&2
    exit 1
}
printf '{}\n' > "$urgent_dir/blocked.urgent.json"
if (
    HOME="$R4_URGENT_HOME"
    r4_launch_state() { printf 'unloaded\n'; }
    r4_assert_updater_quiet
) >/dev/null 2>&1; then
    echo "FAIL: updater quiet preflight accepted a nonempty urgent dir" >&2
    exit 1
fi

R4_RESTORE_HOME="$TMP_ROOT/r4-restore-home"
mkdir -p "$R4_RESTORE_HOME/Library/LaunchAgents"
if ! (
    HOME="$R4_RESTORE_HOME"
    R4_REPO="$REPO_ROOT"
    r4_validate_updater_plist() { :; }
    r4_launch_state() { printf 'loaded\n'; }
    launchctl() {
        [[ "$1" == bootstrap ]] || return 90
        local dir="$HOME/.flywheel/self-ship-urgent.d" mode
        mode="$(stat -c %a "$dir" 2>/dev/null || stat -f %Lp "$dir")" || return 91
        [[ -d "$dir" && "$mode" == 700 ]]
    }
    r4_restore_updater
); then
    echo "FAIL: updater restore did not prepare urgent dir before bootstrap" >&2
    exit 1
fi
if [[ "$(declare -f r4_validate_updater_plist)" != *'.ThrottleInterval == 60'* ]]; then
    echo "FAIL: R4 updater validator does not enforce ThrottleInterval=60" >&2
    exit 1
fi
echo "r4-window: urgent-only updater quiet/restore contract PASS"

echo "r4-window: PASS"
