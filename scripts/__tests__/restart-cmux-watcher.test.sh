#!/usr/bin/env bash
set -uo pipefail

ROOT="$(mktemp -d)"
REAL_CENSUS_PIDS=""
cleanup() {
  [[ -n "$REAL_CENSUS_PIDS" ]] && kill $REAL_CENSUS_PIDS 2>/dev/null || true
  rm -rf "$ROOT"
}
trap cleanup EXIT
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/restart-cmux-watcher.sh"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*" >&2; }

if [[ ! -r "$LIB" ]]; then
  printf 'RED: missing %s\n' "$LIB" >&2
  exit 1
fi
# shellcheck source=../lib/restart-cmux-watcher.sh
source "$LIB"

mkdir -p "$ROOT/bin" "$ROOT/repo/scripts" "$ROOT/home/Library/LaunchAgents" "$ROOT/lease"
printf '<plist/>\n' > "$ROOT/home/Library/LaunchAgents/com.flywheel.cmux-watcher.plist"

echo "Test: FLY-1482 deployed watcher symlink resolves its repo census dependency"
mkdir -p "$ROOT/deployed-bin"
ln -s "$REPO_ROOT/scripts/flywheel-cmux-sync.sh" "$ROOT/deployed-bin/flywheel-cmux-sync"
deployed_rc=0
/bin/bash -c 'source "$1"; declare -F cmux_watcher_process_pids >/dev/null' _ \
  "$ROOT/deployed-bin/flywheel-cmux-sync" >/dev/null 2>&1 || deployed_rc=$?
if [[ "$deployed_rc" -eq 0 && ! -e "$ROOT/deployed-bin/cmux-mutator-process-census.sh" ]]; then
  pass "a bin symlink works before any installer-created sibling library exists"
else
  fail "deployed symlink could not load repo census without sibling rc=$deployed_rc"
fi

echo "Test: FLY-1482 real pgrep/ps census excludes a prompt-only process"
mkdir -p "$ROOT/real"
cat > "$ROOT/real/flywheel-cmux-sync.sh" <<'SH'
#!/usr/bin/env bash
while :; do sleep 1; done
SH
chmod +x "$ROOT/real/flywheel-cmux-sync.sh"
/bin/bash "$ROOT/real/flywheel-cmux-sync.sh" --watch &
real_watcher_pid=$!
REAL_CENSUS_PIDS="$real_watcher_pid"
node_bin=$(command -v node || true)
if [[ -z "$node_bin" ]]; then
  printf '  ⏭ node unavailable; real census decoy fixture skipped\n'
else
  /bin/bash -c 'exec -a claude "$1" -e "setTimeout(() => {}, 30000)" -- --prompt flywheel-cmux-sync --watch' _ "$node_bin" &
  real_decoy_pid=$!
  REAL_CENSUS_PIDS+=" $real_decoy_pid"
  /bin/sleep 0.3
  real_census_rc=0
  real_census=$(PATH="/usr/bin:/bin:${node_bin%/*}" cmux_watcher_process_pids) || real_census_rc=$?
  if [[ "$real_census_rc" -eq 2 ]]; then
    printf '  ⏭ host process census unavailable; real census assertion remains active on CI\n'
  elif printf '%s\n' "$real_census" | grep -qx "$real_watcher_pid" \
      && ! printf '%s\n' "$real_census" | grep -qx "$real_decoy_pid"; then
    pass "real pgrep/ps keeps the watcher and rejects the prompt-only decoy"
  else
    fail "real census mismatch rc=$real_census_rc rows=[$real_census] watcher=$real_watcher_pid decoy=$real_decoy_pid"
  fi
  kill $REAL_CENSUS_PIDS 2>/dev/null || true
  wait $REAL_CENSUS_PIDS 2>/dev/null || true
  REAL_CENSUS_PIDS=""
fi

echo "Test: FLY-1482 sync, restart, and teardown share one census implementation"
shared_lib="$REPO_ROOT/scripts/lib/cmux-mutator-process-census.sh"
predicate_defs=$(grep -R '^cmux_mutator_command_matches()' \
  "$REPO_ROOT/scripts/flywheel-cmux-sync.sh" \
  "$REPO_ROOT/scripts/lib/restart-cmux-watcher.sh" \
  "$REPO_ROOT/scripts/test-teardown.sh" \
  "$shared_lib" | wc -l | tr -d ' ')
census_defs=$(grep -R '^cmux_watcher_process_pids()' \
  "$REPO_ROOT/scripts/flywheel-cmux-sync.sh" \
  "$REPO_ROOT/scripts/lib/restart-cmux-watcher.sh" \
  "$shared_lib" | wc -l | tr -d ' ')
if [[ "$predicate_defs" == "1" && "$census_defs" == "1" ]] \
    && grep -q 'cmux-mutator-process-census.sh' "$REPO_ROOT/scripts/flywheel-cmux-sync.sh" \
    && grep -q 'cmux-mutator-process-census.sh' "$REPO_ROOT/scripts/lib/restart-cmux-watcher.sh" \
    && grep -q 'cmux-mutator-process-census.sh' "$REPO_ROOT/scripts/test-teardown.sh"; then
  pass "all three mutation/restart paths source the single shared census"
else
  fail "shared census drifted predicate_defs=$predicate_defs census_defs=$census_defs"
fi

echo "Test: FLY-1482 every census consumer fails closed with the named dependency"
missing_load_ok=1
for consumer in sync restart teardown; do
  consumer_root="$ROOT/missing-$consumer"
  consumer_err="$consumer_root/stderr.log"
  mkdir -p "$consumer_root/lib"
  consumer_rc=0
  case "$consumer" in
    sync)
      cp "$REPO_ROOT/scripts/flywheel-cmux-sync.sh" "$consumer_root/flywheel-cmux-sync.sh"
      /bin/bash -c 'source "$1"' _ "$consumer_root/flywheel-cmux-sync.sh" \
        >/dev/null 2>"$consumer_err" || consumer_rc=$?
      ;;
    restart)
      cp "$REPO_ROOT/scripts/lib/restart-cmux-watcher.sh" "$consumer_root/restart-cmux-watcher.sh"
      /bin/bash -c 'source "$1"' _ "$consumer_root/restart-cmux-watcher.sh" \
        >/dev/null 2>"$consumer_err" || consumer_rc=$?
      ;;
    teardown)
      cp "$REPO_ROOT/scripts/test-teardown.sh" "$consumer_root/test-teardown.sh"
      cp "$REPO_ROOT/scripts/lib/qa-multilead.sh" "$consumer_root/lib/qa-multilead.sh"
      cp "$REPO_ROOT/scripts/lib/qa-launchd-lead.sh" "$consumer_root/lib/qa-launchd-lead.sh"
      cp "$REPO_ROOT/scripts/lib/qa-generalized.sh" "$consumer_root/lib/qa-generalized.sh"
      cp "$REPO_ROOT/scripts/lib/runner-workspace-trust.sh" "$consumer_root/lib/runner-workspace-trust.sh"
      /bin/bash "$consumer_root/test-teardown.sh" 99 \
        >/dev/null 2>"$consumer_err" || consumer_rc=$?
      ;;
  esac
  if [[ "$consumer_rc" -eq 0 \
      || "$(grep -c 'required cmux process census library unavailable' "$consumer_err" || true)" != "1" ]]; then
    missing_load_ok=0
  fi
done
if [[ "$missing_load_ok" == "1" ]]; then
  pass "all consumers name the missing census dependency and perform no work"
else
  fail "one or more consumers did not use the shared fail-closed loader contract"
fi

cat > "$ROOT/bin/pgrep" <<'SH'
#!/usr/bin/env bash
[[ "${CRW_PGREP_ERROR:-0}" == "1" ]] && exit 2
[[ -s "$CRW_CONTROL/pids" ]] || exit 1
cat "$CRW_CONTROL/pids"
SH
cat > "$ROOT/bin/ps" <<'SH'
#!/usr/bin/env bash
[[ "${CRW_PS_ERROR:-0}" == "1" ]] && exit 2
pid=""
for arg in "$@"; do pid="$arg"; done
if [[ "$*" == *"lstart="* ]]; then
  incarnation=$(awk -F'|' -v p="$pid" '$1 == p { sub(/^[^|]*\|/, ""); print; exit }' "$CRW_CONTROL/incarnations")
  [[ -n "$incarnation" ]] || exit 1
  printf '%s\n' "$incarnation"
  exit 0
fi
command=$(awk -F'|' -v p="$pid" '$1 == p { sub(/^[^|]*\|/, ""); print; exit }' "$CRW_CONTROL/commands")
[[ -n "$command" ]] || exit 1
printf '%s\n' "$command"
SH
cat > "$ROOT/bin/launchctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$CRW_CONTROL/calls"
printf '%s\n' "$*" >> "$CRW_CONTROL/call-args"
case "$1" in
  bootout) exit "${CRW_BOOTOUT_RC:-0}" ;;
  print)
    if [[ -n "${CRW_PRINT_TOUCH_MARKER:-}" ]]; then
      touch "$CRW_PRINT_TOUCH_MARKER"
    fi
    [[ "$(cat "$CRW_CONTROL/job-present" 2>/dev/null || printf '0')" == "1" ]]
    ;;
  kickstart)
    [[ "${CRW_KICKSTART_RC:-0}" == "0" ]] || exit "$CRW_KICKSTART_RC"
    printf '%s\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/pids"
    printf '%s|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/commands"
    if [[ -n "${CRW_DECOY_PID:-}" ]]; then
      printf '%s\n' "$CRW_DECOY_PID" >> "$CRW_CONTROL/pids"
      printf '%s|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n' "$CRW_DECOY_PID" >> "$CRW_CONTROL/commands"
    fi
    printf '%s|new-incarnation|watch|new-nonce\n' "${CRW_OWNER_PID:-${CRW_NEW_PID:-222}}" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
    printf '%s|new-incarnation\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/incarnations"
    mkdir -p "$(dirname "$FLYWHEEL_CMUX_WATCHER_HEARTBEAT")"
    printf '%s|bootstrap|scan\n' "${CRW_NEW_PID:-222}" > "$FLYWHEEL_CMUX_WATCHER_HEARTBEAT"
    ;;
  bootstrap)
    if [[ "${CRW_BOOTSTRAP_RC:-0}" != "0" ]]; then
      if [[ "${CRW_BOOTSTRAP_RACE_PRESENT:-0}" == "1" ]]; then
        printf '1\n' > "$CRW_CONTROL/job-present"
        printf '%s\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/pids"
        printf '%s|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/commands"
        printf '%s|new-incarnation|watch|new-nonce\n' "${CRW_NEW_PID:-222}" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
        printf '%s|new-incarnation\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/incarnations"
        mkdir -p "$(dirname "$FLYWHEEL_CMUX_WATCHER_HEARTBEAT")"
        printf '%s|bootstrap|scan\n' "${CRW_NEW_PID:-222}" > "$FLYWHEEL_CMUX_WATCHER_HEARTBEAT"
      fi
      exit "$CRW_BOOTSTRAP_RC"
    fi
    printf '1\n' > "$CRW_CONTROL/job-present"
    printf '%s\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/pids"
    printf '%s|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/commands"
    if [[ -n "${CRW_DECOY_PID:-}" ]]; then
      printf '%s\n' "$CRW_DECOY_PID" >> "$CRW_CONTROL/pids"
      printf '%s|/opt/claude --prompt restart flywheel-cmux-sync --watch after QA\n' "$CRW_DECOY_PID" >> "$CRW_CONTROL/commands"
    fi
    case "${CRW_OWNER_MODE:-healthy}" in
      healthy) printf '%s|new-incarnation|watch|new-nonce\n' "${CRW_OWNER_PID:-${CRW_NEW_PID:-222}}" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" ;;
      malformed) printf 'malformed\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" ;;
      missing) rm -f "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" ;;
    esac
    printf '%s|new-incarnation\n' "${CRW_NEW_PID:-222}" > "$CRW_CONTROL/incarnations"
    mkdir -p "$(dirname "$FLYWHEEL_CMUX_WATCHER_HEARTBEAT")"
    printf '%s|bootstrap|scan\n' "${CRW_NEW_PID:-222}" > "$FLYWHEEL_CMUX_WATCHER_HEARTBEAT"
    ;;
  *) exit 64 ;;
esac
SH
cat > "$ROOT/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$ROOT/repo/scripts/flywheel-cmux-sync.sh" <<'SH'
#!/usr/bin/env bash
printf 'wait\n' >> "$CRW_CONTROL/calls"
case "${CRW_WAIT_MODE:-success}" in
  fail) exit 9 ;;
  stubborn) exit 0 ;;
  success)
    : > "$CRW_CONTROL/pids"
    : > "$CRW_CONTROL/commands"
    if [[ -n "${CRW_DECOY_PID:-}" ]]; then
      printf '%s\n' "$CRW_DECOY_PID" > "$CRW_CONTROL/pids"
      printf '%s|/opt/claude --prompt restart flywheel-cmux-sync --watch after QA\n' "$CRW_DECOY_PID" > "$CRW_CONTROL/commands"
    fi
    exit 0
    ;;
esac
SH
chmod +x "$ROOT/bin/pgrep" "$ROOT/bin/ps" "$ROOT/bin/launchctl" "$ROOT/bin/sleep" \
  "$ROOT/repo/scripts/flywheel-cmux-sync.sh"

reset_case() {
  : > "$ROOT/calls"
  : > "$ROOT/call-args"
  printf '111\n' > "$ROOT/pids"
  printf '111|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n' > "$ROOT/commands"
  printf '111|old-incarnation\n' > "$ROOT/incarnations"
  rm -f "$ROOT/lease/owner"
  rm -f "$ROOT/maintenance" "$ROOT/maintenance.qa-teardown" "$ROOT/maintenance.ops-rebuild"
  CRW_CONTROL="$ROOT"
  FLYWHEEL_DIR="$ROOT/repo"
  HOME="$ROOT/home"
  FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$ROOT/lease"
  FLYWHEEL_CMUX_WATCHER_HEARTBEAT="$ROOT/home/.flywheel/state/cmux-watcher-heartbeat"
  FLYWHEEL_CMUX_MAINTENANCE_MARKER="$ROOT/maintenance"
  PATH="$ROOT/bin:/usr/bin:/bin"
  CRW_WAIT_MODE=success
  CRW_BOOTOUT_RC=0
  CRW_BOOTSTRAP_RC=0
  CRW_BOOTSTRAP_RACE_PRESENT=0
  CRW_JOB_PRESENT=1
  CRW_KICKSTART_RC=0
  CRW_PRINT_TOUCH_MARKER=""
  CRW_NEW_PID=222
  CRW_OWNER_PID=222
  CRW_OWNER_MODE=healthy
  CRW_PGREP_ERROR=0
  CRW_PS_ERROR=0
  CRW_DECOY_PID=""
  FLYWHEEL_CMUX_WATCHER_PROBE_TRIES=3
  FLYWHEEL_CMUX_WATCHER_PROBE_INTERVAL=0
  printf '%s\n' "$CRW_JOB_PRESENT" > "$ROOT/job-present"
  export CRW_CONTROL FLYWHEEL_DIR HOME FLYWHEEL_CMUX_WATCHER_LOCK_DIR FLYWHEEL_CMUX_WATCHER_HEARTBEAT FLYWHEEL_CMUX_MAINTENANCE_MARKER PATH
  export CRW_WAIT_MODE CRW_BOOTOUT_RC CRW_BOOTSTRAP_RC CRW_NEW_PID CRW_OWNER_PID
  export CRW_OWNER_MODE CRW_PGREP_ERROR FLYWHEEL_CMUX_WATCHER_PROBE_TRIES
  export CRW_PS_ERROR CRW_DECOY_PID FLYWHEEL_CMUX_WATCHER_PROBE_INTERVAL
  export CRW_BOOTSTRAP_RACE_PRESENT CRW_JOB_PRESENT CRW_KICKSTART_RC CRW_PRINT_TOUCH_MARKER
}

echo "Test: FLY-1944 restart library exposes the bounded --recover operation"
if grep -q -- '--recover' "$LIB" && grep -q -- '--rebuild' "$LIB" \
    && grep -q 'FLYWHEEL_CMUX_WATCHER_RECOVER_DEADLINE' "$LIB"; then
  pass "rider exposes bounded recover and rebuild operations"
else
  fail "canonical --recover/--rebuild entrypoint or internal deadline is missing"
fi

echo "Test: FLY-2207 stalled recovery keeps the launchd label loaded"
eval "$(declare -f _crw_expected_owner_is_live | sed '1s/_crw_expected_owner_is_live/_crw_expected_owner_is_live_real/')"
_crw_expected_owner_is_live() {
  [[ "$(_crw_read_watch_owner_tuple "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" 2>/dev/null)" == "$1" ]]
}
reset_case
expected_owner='111|old-incarnation|watch|old-nonce'
printf '%s\n' "$expected_owner" > "$ROOT/lease/owner"
restart_cmux_watcher "$expected_owner"
if [[ "$CMUX_WATCHER_RESTART_STATE" == "healthy" \
    && "$(tr '\n' ',' < "$ROOT/calls")" == "kickstart," \
    && "$(cat "$ROOT/call-args")" == "kickstart -k gui/501/com.flywheel.cmux-watcher" ]]; then
  pass "tuple-bound recovery uses kickstart -k with no bootout window"
else
  fail "stalled recovery mutated launchd incorrectly state=$CMUX_WATCHER_RESTART_STATE calls=[$(cat "$ROOT/call-args")]"
fi

echo "Test: FLY-2207 a valid replacement wins over same-argv process residue"
reset_case
expected_owner='111|old-incarnation|watch|old-nonce'
printf '%s\n' "$expected_owner" > "$ROOT/lease/owner"
printf '111\n333\n' > "$ROOT/pids"
printf '111|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n333|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n' > "$ROOT/commands"
CRW_DECOY_PID=333; export CRW_DECOY_PID
restart_cmux_watcher "$expected_owner"
if [[ "$CMUX_WATCHER_RESTART_STATE" == "healthy" \
    && "$CMUX_WATCHER_RESTART_DETAIL" == *"census="* ]]; then
  pass "lease plus heartbeat are authoritative while census remains diagnostic"
else
  fail "same-argv residue vetoed healthy replacement state=$CMUX_WATCHER_RESTART_STATE detail=$CMUX_WATCHER_RESTART_DETAIL"
fi
eval "$(declare -f _crw_expected_owner_is_live_real | sed '1s/_crw_expected_owner_is_live_real/_crw_expected_owner_is_live/')"
unset -f _crw_expected_owner_is_live_real

echo "Test: FLY-2207 tuple drift refuses kickstart"
reset_case
expected_owner='111|old-incarnation|watch|old-nonce'
printf '111|replacement-incarnation|watch|replacement-nonce\n' > "$ROOT/lease/owner"
restart_cmux_watcher "$expected_owner"
if [[ "$CMUX_WATCHER_RESTART_STATE" == "unverifiable" && ! -s "$ROOT/calls" ]]; then
  pass "stale owner tuple performs zero launchd mutation"
else
  fail "tuple drift reached launchctl state=$CMUX_WATCHER_RESTART_STATE calls=[$(cat "$ROOT/calls")]"
fi

echo "Test: FLY-2207 absent job rebuilds and an updater race converges"
rebuild_ok=1
for mode in absent updater-race; do
  reset_case
  CRW_JOB_PRESENT=0
  printf '0\n' > "$ROOT/job-present"
  if [[ "$mode" == "updater-race" ]]; then
    CRW_BOOTSTRAP_RC=5
    CRW_BOOTSTRAP_RACE_PRESENT=1
  fi
  export CRW_JOB_PRESENT CRW_BOOTSTRAP_RC CRW_BOOTSTRAP_RACE_PRESENT
  rebuild_cmux_watcher
  [[ "$CMUX_WATCHER_RESTART_STATE" == "healthy" \
      && "$(cat "$ROOT/calls")" == *"bootstrap"* ]] || rebuild_ok=0
done
if [[ "$rebuild_ok" == "1" ]]; then
  pass "job absence bootstraps; concurrent updater ownership is accepted after print"
else
  fail "job-absent rebuild did not converge"
fi

echo "Test: FLY-2207 rebuild is idempotent when the job is already healthy"
reset_case
printf '222\n' > "$ROOT/pids"
printf '222|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n' > "$ROOT/commands"
printf '222|new-incarnation\n' > "$ROOT/incarnations"
printf '222|new-incarnation|watch|new-nonce\n' > "$ROOT/lease/owner"
mkdir -p "$(dirname "$FLYWHEEL_CMUX_WATCHER_HEARTBEAT")"
printf '222|bootstrap|scan\n' > "$FLYWHEEL_CMUX_WATCHER_HEARTBEAT"
rebuild_cmux_watcher
if [[ "$CMUX_WATCHER_RESTART_STATE" == "healthy" \
    && "$(tr '\n' ',' < "$ROOT/calls")" == "print," ]]; then
  pass "queryable healthy job needs no bootstrap mutation"
else
  fail "loaded rebuild was not idempotent state=$CMUX_WATCHER_RESTART_STATE calls=[$(cat "$ROOT/call-args")]"
fi

echo "Test: FLY-2207 all park markers fence rebuild at mutation time"
park_ok=1
for suffix in '' '.qa-teardown' '.ops-rebuild'; do
  reset_case
  CRW_JOB_PRESENT=0
  printf '0\n' > "$ROOT/job-present"
  export CRW_JOB_PRESENT
  touch "$ROOT/maintenance$suffix"
  rebuild_cmux_watcher
  [[ "$CMUX_WATCHER_RESTART_STATE" == "parked" && "$(cat "$ROOT/calls")" != *"bootstrap"* ]] || park_ok=0
done
reset_case
CRW_JOB_PRESENT=0
printf '0\n' > "$ROOT/job-present"
CRW_PRINT_TOUCH_MARKER="$ROOT/maintenance"
export CRW_JOB_PRESENT CRW_PRINT_TOUCH_MARKER
rebuild_cmux_watcher
[[ "$CMUX_WATCHER_RESTART_STATE" == "parked" && "$(cat "$ROOT/calls")" != *"bootstrap"* ]] || park_ok=0
if [[ "$park_ok" == "1" ]]; then
  pass "maintenance, QA, ops, and sensor-to-mutation races all block bootstrap"
else
  fail "a park marker allowed rebuild calls=[$(cat "$ROOT/call-args")] state=$CMUX_WATCHER_RESTART_STATE"
fi

echo "Test: FLY-1482 production restart probe defaults to the shared /tmp lease"
unset FLYWHEEL_CMUX_WATCHER_LOCK_DIR FLYWHEEL_STATE_DIR
default_lease=$(_crw_lease_dir 2>/dev/null || true)
if [[ "$default_lease" == "/tmp/flywheel-cmux-watcher.lock" ]]; then
  pass "unset-env restart probing shares the watcher and teardown lease path"
else
  fail "restart probe default drifted path=[$default_lease]"
fi

echo "Test: FLY-1482 installer handles inconclusive watcher shutdown explicitly"
install_script="$REPO_ROOT/scripts/flywheel-cmux-install.sh"
if grep -q 'if ! .*flywheel-cmux-sync.sh.*--wait-for-watcher-exit' "$install_script" \
    && grep -q 'watcher shutdown could not be verified.*bootstrap skipped' "$install_script"; then
  pass "installer fails loud and skips bootstrap when old-watcher absence is unproven"
else
  fail "installer still relies on bare set -e for watcher shutdown failure"
fi

echo "Test: FLY-1482 fleet restart replaces and verifies the watcher"
reset_case
restart_cmux_watcher
if [[ "$CMUX_WATCHER_RESTART_STATE" == "healthy" \
    && "$(tr '\n' ',' < "$ROOT/calls")" == "bootout,wait,bootstrap," \
    && "$CMUX_WATCHER_RESTART_DETAIL" == *"pid=222"* ]]; then
  pass "bootout → repo-pinned wait → bootstrap ends with a fresh PID owning the watch lease"
else
  fail "healthy restart mismatch state=$CMUX_WATCHER_RESTART_STATE detail=$CMUX_WATCHER_RESTART_DETAIL calls=[$(cat "$ROOT/calls")]"
fi

echo "Test: FLY-1482 fleet restart ignores prompt-only Runner pgrep candidates"
reset_case
CRW_DECOY_PID=333; export CRW_DECOY_PID
printf '111\n333\n' > "$ROOT/pids"
printf '111|/bin/bash /opt/flywheel-cmux-sync.sh --watch\n333|/opt/claude --prompt restart flywheel-cmux-sync --watch after QA\n' > "$ROOT/commands"
restart_cmux_watcher
verified_pids=$(_crw_watcher_pids 2>/dev/null || true)
if [[ "$CMUX_WATCHER_RESTART_STATE" == "healthy" && "$verified_pids" == "222" \
    && "$(tr '\n' ',' < "$ROOT/calls")" == "bootout,wait,bootstrap," ]]; then
  pass "Runner decoys neither block bootstrap nor inflate the verified watcher count"
else
  fail "Runner decoy poisoned restart state=$CMUX_WATCHER_RESTART_STATE pids=[$verified_pids] calls=[$(cat "$ROOT/calls")]"
fi

echo "Test: FLY-1482 genuine process-table failure remains fail-closed"
reset_case
CRW_PS_ERROR=1; export CRW_PS_ERROR
restart_cmux_watcher
if [[ "$CMUX_WATCHER_RESTART_STATE" == "unverifiable" && ! -s "$ROOT/calls" ]]; then
  pass "unreadable process commands refuse bootout before any mutation"
else
  fail "process-table failure did not fail closed state=$CMUX_WATCHER_RESTART_STATE calls=[$(cat "$ROOT/calls")]"
fi

echo "Test: FLY-1482 inconclusive shutdown never bootstraps a second watcher"
for wait_mode in fail stubborn; do
  reset_case
  CRW_WAIT_MODE="$wait_mode"; export CRW_WAIT_MODE
  restart_cmux_watcher
  if [[ "$CMUX_WATCHER_RESTART_STATE" == "unverifiable" \
      && "$(cat "$ROOT/calls")" != *"bootstrap"* ]]; then
    pass "$wait_mode shutdown is degraded and skips bootstrap"
  else
    fail "$wait_mode shutdown state=$CMUX_WATCHER_RESTART_STATE calls=[$(cat "$ROOT/calls")]"
  fi
done

echo "Test: FLY-1482 missing plist and bootstrap failure are structured outcomes"
reset_case
mv "$ROOT/home/Library/LaunchAgents/com.flywheel.cmux-watcher.plist" "$ROOT/missing.plist"
restart_cmux_watcher
missing_state="$CMUX_WATCHER_RESTART_STATE"; missing_calls="$(cat "$ROOT/calls")"
mv "$ROOT/missing.plist" "$ROOT/home/Library/LaunchAgents/com.flywheel.cmux-watcher.plist"
reset_case
CRW_BOOTSTRAP_RC=5; export CRW_BOOTSTRAP_RC
restart_cmux_watcher
if [[ "$missing_state" == "missing_plist" && -z "$missing_calls" \
    && "$CMUX_WATCHER_RESTART_STATE" == "bootstrap_failed" ]]; then
  pass "missing install state is non-destructive; bootstrap failure is explicit"
else
  fail "structured outcome mismatch missing=$missing_state bootstrap=$CMUX_WATCHER_RESTART_STATE"
fi

echo "Test: FLY-1482 probe rejects unchanged PID and malformed/unreadable owner"
probe_ok=1
for scenario in unchanged malformed missing; do
  reset_case
  case "$scenario" in
    unchanged) CRW_NEW_PID=111; CRW_OWNER_PID=111 ;;
    malformed) CRW_OWNER_MODE=malformed ;;
    missing) CRW_OWNER_MODE=missing ;;
  esac
  export CRW_NEW_PID CRW_OWNER_PID CRW_OWNER_MODE
  restart_cmux_watcher
  [[ "$CMUX_WATCHER_RESTART_STATE" == "probe_failed" ]] || probe_ok=0
done
if [[ "$probe_ok" == "1" ]]; then
  pass "a launchd bootstrap is not healthy until both process and lease ownership flip"
else
  fail "one or more invalid post-bootstrap states falsely passed"
fi

echo "Test: FLY-1482 fleet wiring reports watcher outcome before cmux refresh"
restart_script="$REPO_ROOT/scripts/restart-services.sh"
restart_line=$(grep -n '^[[:space:]]*restart_cmux_watcher$' "$restart_script" | cut -d: -f1)
refresh_line=$(grep -n '^[[:space:]]*trigger_cmux_refresh$' "$restart_script" | tail -1 | cut -d: -f1)
if [[ "$restart_line" =~ ^[0-9]+$ && "$refresh_line" =~ ^[0-9]+$ \
    && "$restart_line" -lt "$refresh_line" \
    && "$(cat "$restart_script")" == *'cmux watcher=${watcher_state}: ${watcher_detail}'* ]]; then
  pass "restart runs after Lead capture, before refresh, and feeds the degraded warning path"
else
  fail "restart-services watcher ordering/report wiring is incomplete"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
