#!/bin/bash
# FLY-1364 live-machine acceptance. This is intentionally NOT a CI test: it
# requires a running cmux app and performs one exact-ref workspace lifecycle.
# All Flywheel state and watcher locks live under a private temp root. Cleanup
# closes only the UUID created by this run and restores the previously selected
# workspace only while the test still owns focus.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SYNC="$ROOT/scripts/flywheel-cmux-sync.sh"
TEST_ROOT="$(mktemp -d -t fly1364-live.XXXXXX)" || exit 1
SOCKET="${CMUX_SOCKET_PATH:-/tmp/cmux.sock}"
ORIGINAL_SELECTED=""
LIVE_WORKSPACE_UUID=""
LIVE_WORKSPACE_REF=""
CHILD_PIDS=""
ISOLATED_TMUX_BIN=""
ISOLATED_TMUX_SOCKET="$TEST_ROOT/tmux-live.sock"

current_selected_ref() {
  cmux --socket "$SOCKET" --json list-workspaces 2>/dev/null | /usr/bin/python3 -c '
import json, sys
try:
    workspaces = json.load(sys.stdin).get("workspaces", [])
except Exception:
    raise SystemExit(1)
print(next((w.get("ref", "") for w in workspaces if w.get("selected")), ""))
' || return 1
}

restore_original_focus_if_test_selected() {
  local current=""
  [ -n "$ORIGINAL_SELECTED" ] && [ -n "$LIVE_WORKSPACE_REF" ] || return 0
  current="$(current_selected_ref)" || return 0
  # Preserve any user navigation that happened after the test tab appeared.
  # We may restore only while the selection is still the exact tab we created.
  [ "$current" = "$LIVE_WORKSPACE_REF" ] || return 0
  cmux --socket "$SOCKET" select-workspace --workspace "$ORIGINAL_SELECTED" >/dev/null 2>&1 || true
}

cleanup() {
  local pid
  trap - EXIT INT TERM
  for pid in $CHILD_PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in $CHILD_PIDS; do
    wait "$pid" 2>/dev/null || true
  done
  restore_original_focus_if_test_selected
  if [ -n "$LIVE_WORKSPACE_UUID" ]; then
    cmux --socket "$SOCKET" close-workspace --workspace "$LIVE_WORKSPACE_UUID" >/dev/null 2>&1 || true
  elif [ -n "$LIVE_WORKSPACE_REF" ]; then
    cmux --socket "$SOCKET" close-workspace --workspace "$LIVE_WORKSPACE_REF" >/dev/null 2>&1 || true
  fi
  if [ -n "$ISOLATED_TMUX_BIN" ]; then
    "$ISOLATED_TMUX_BIN" kill-server >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

pass() {
  echo "[PASS] $*"
}

wait_for_file() {
  local path="$1" attempt=0
  while [ "$attempt" -lt 250 ]; do
    [ -s "$path" ] && return 0
    sleep 0.02
    attempt=$((attempt + 1))
  done
  return 1
}

workspace_field_for_id() {
  local raw="$1" workspace_id="$2" field="$3"
  printf '%s' "$raw" | /usr/bin/python3 -c '
import json, sys
workspace_id, field = sys.argv[1:3]
for workspace in json.load(sys.stdin).get("workspaces", []):
    if workspace.get("id") == workspace_id:
        print(workspace.get(field, ""))
        break
' "$workspace_id" "$field"
}

workspace_present() {
  local raw="$1" ref="$2" title="$3"
  printf '%s' "$raw" | /usr/bin/python3 -c '
import json, sys
ref, title = sys.argv[1:3]
raise SystemExit(0 if any(
    workspace.get("ref") == ref and workspace.get("title") == title
    for workspace in json.load(sys.stdin).get("workspaces", [])
) else 1)
' "$ref" "$title"
}

workspace_ref_for_title() {
  local raw="$1" title="$2"
  printf '%s' "$raw" | /usr/bin/python3 -c '
import json, sys
title = sys.argv[1]
matches = [w.get("ref", "") for w in json.load(sys.stdin).get("workspaces", [])
           if w.get("title") == title and w.get("ref")]
if len(matches) == 1:
    print(matches[0])
' "$title"
}

workspace_id_for_ref() {
  local raw="$1" ref="$2"
  printf '%s' "$raw" | /usr/bin/python3 -c '
import json, sys
ref = sys.argv[1]
for workspace in json.load(sys.stdin).get("workspaces", []):
    if workspace.get("ref") == ref:
        print(workspace.get("id", ""))
        break
' "$ref"
}

mkdir -p "$TEST_ROOT/home/.flywheel/state"
export HOME="$TEST_ROOT/home"
export CMUX_SOCKET_PATH="$SOCKET"
export EVENT_FILE="$TEST_ROOT/events"
export CLEANUP_PENDING="$TEST_ROOT/cleanup-pending"
export STALE_STATE="$TEST_ROOT/stale-state"
export HEAL_STATE="$TEST_ROOT/heal-state"
export CREATE_STATE="$TEST_ROOT/create-state"
export ORPHAN_PIN_STATE="$TEST_ROOT/orphan-pin-state"
export ADOPTION_STATE="$TEST_ROOT/adoption-state"
export FLYWHEEL_CMUX_CLOSE_REQUEST_FILE="$TEST_ROOT/close-request"
export HUSK_STATE="$TEST_ROOT/husk-state"
export VIEW_WAL_DIR="$TEST_ROOT/view-wal"
export VIEW_LEDGER="$TEST_ROOT/view-ledger"
export KEEPER_INVENTORY="$TEST_ROOT/keeper-inventory"
export VIEW_ABSENT_STATE="$TEST_ROOT/view-absent"
export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TEST_ROOT/maintenance"
export CMUX_FLAG_STATE="$TEST_ROOT/flag-state"
export CMUX_SOCK_IDENT_FILE="$TEST_ROOT/socket-identity"
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TEST_ROOT/watcher.lock"
export FLYWHEEL_CMUX_ALERT_BIN="/usr/bin/true"
export FLYWHEEL_CMUX_LINKED_VIEW=0
export FLYWHEEL_CMUX_STOCK_ADOPTION=1
export FLYWHEEL_CMUX_ORPHAN_REAPER=0
export FLYWHEEL_CMUX_CLEANUP_DELAY=1
export FLYWHEEL_CMUX_CONSERVATIVE_CLEANUP=1

if ps -o lstart= -p "$$" >/dev/null 2>&1; then
  INCARNATION_EVIDENCE="kernel process start identity"
else
  # The managed Codex sandbox denies /bin/ps even for our own PID. Production
  # never sets this seam; real PIDs + kill -0 still arbitrate contenders here.
  export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1364-live-sandbox"
  INCARNATION_EVIDENCE="deterministic sandbox seam (ps denied)"
fi

# shellcheck source=../flywheel-cmux-sync.sh
source "$SYNC"

echo "[ENV] $(uname -srm)"
echo "[ENV] $(cmux --socket "$SOCKET" --version)"
echo "[ENV] $(${SHELL:-/bin/bash} --version 2>/dev/null | head -1 || true)"
echo "[ENV] lease incarnation: $INCARNATION_EVIDENCE"
cmux --socket "$SOCKET" ping >/dev/null || fail "cmux socket is not live: $SOCKET"

echo "[TEST] invalid residual ledger lock is rebuilt by the verified sole writer"
acquire_mutator_lease qa_teardown || fail "could not acquire private mutator lease"
mkdir -p "${VIEW_LEDGER}.lock"
printf 'malformed-owner\n' > "${VIEW_LEDGER}.lock/owner"
_ledger_upsert committed live-generation workspace:900001 lock-recovery-one \
  2>"$TEST_ROOT/ledger-recovery.log" || fail "first post-recovery ledger write failed"
_ledger_upsert committed live-generation workspace:900002 lock-recovery-two \
  2>>"$TEST_ROOT/ledger-recovery.log" || fail "mutator did not continue after lock recovery"
if [ -d "${VIEW_LEDGER}.lock" ] \
    || [ "$(grep -c '^committed|live-generation|workspace:90000[12]|lock-recovery-' "$VIEW_LEDGER" || true)" -ne 2 ] \
    || ! grep -q 'reaping residual ledger inner lock under verified mutator lease' "$TEST_ROOT/ledger-recovery.log"; then
  fail "residual lock recovery did not rebuild and continue"
fi
release_mutator_lease
pass "lock verification failure -> safe rebuild -> subsequent write continues"

echo "[TEST] two real watcher contenders produce exactly one lease winner"
: > "$VIEW_LEDGER"
# Inject the production failure shape before releasing both contenders: a
# globally malformed lease with no live mutator. The winner must rebuild it
# and continue; the kernel reconstruction mutex must keep the loser out.
mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
printf 'malformed-owner\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner"
printf '999999\n' > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
BARRIER="$TEST_ROOT/watcher-start"
WINNERS="$TEST_ROOT/watcher-winners"
FINISH="$TEST_ROOT/watcher-finish"
for contender in 1 2; do
  /bin/bash -c '
    set -euo pipefail
    sync="$1"; barrier="$2"; winners="$3"; finish="$4"
    while [ ! -e "$barrier" ]; do sleep 0.01; done
    source "$sync"
    # The host may have its real production watcher running. This capability
    # owns a private lease namespace, so exclude unrelated host mutators from
    # only the stale-lease census while retaining real contender PIDs, the
    # production classifier, and the kernel reconstruction mutex.
    _snapshot_live_mutator_processes() { return 0; }
    acquire_watcher_lock
    printf "%s\n" "$$" >> "$winners"
    while [ ! -e "$finish" ]; do sleep 0.02; done
  ' _ "$SYNC" "$BARRIER" "$WINNERS" "$FINISH" \
    >"$TEST_ROOT/watcher-$contender.log" 2>&1 &
  pid=$!
  CHILD_PIDS="$CHILD_PIDS $pid"
done
touch "$BARRIER"
wait_for_file "$WINNERS" || fail "no watcher contender acquired the lease"

attempt=0
while [ "$attempt" -lt 250 ]; do
  winner_count="$(wc -l < "$WINNERS" | tr -d ' ')"
  # No loser log yet is the normal polling state. Under set -o pipefail a bare
  # grep miss would abort the entire E2E before the contender can finish.
  loser_log_count="$( { grep -l 'already running' "$TEST_ROOT"/watcher-*.log 2>/dev/null || true; } | wc -l | tr -d ' ')"
  [ "$winner_count" = "1" ] && [ "$loser_log_count" = "1" ] && break
  sleep 0.02
  attempt=$((attempt + 1))
done
winner_pid="$(sed -n '1p' "$WINNERS")"
owner_pid="$(cut -d'|' -f1 "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/owner" 2>/dev/null || true)"
if [ "$(wc -l < "$WINNERS" | tr -d ' ')" != "1" ] \
    || [ "$owner_pid" != "$winner_pid" ] \
    || [ "$(grep -l 'already running' "$TEST_ROOT"/watcher-*.log 2>/dev/null | wc -l | tr -d ' ')" != "1" ] \
    || ! grep -q 'rebuilt stale/unverifiable mutator lease reason=malformed-owner-no-live-mutator' \
      "$TEST_ROOT"/watcher-*.log; then
  fail "duplicate watchers did not converge to one winner"
fi
touch "$FINISH"
for pid in $CHILD_PIDS; do
  wait "$pid" || fail "watcher contender exited non-zero: $pid"
done
CHILD_PIDS=""
[ ! -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ] || fail "winner did not release its private lease"
pass "malformed global lease + duplicate watcher injection -> rebuild, one live owner, one clean dedup exit"

echo "[TEST] a real pre-ledger dead cmux workspace converges through the default stock state machine"
before="$(cmux --socket "$SOCKET" --json list-workspaces)"
ORIGINAL_SELECTED="$(printf '%s' "$before" | /usr/bin/python3 -c '
import json, sys
print(next((w.get("ref", "") for w in json.load(sys.stdin).get("workspaces", []) if w.get("selected")), ""))
')"
create_out="$(cmux --socket "$SOCKET" new-workspace --command "/usr/bin/true")"
LIVE_WORKSPACE_UUID="$(printf '%s\n' "$create_out" | awk '$1 == "OK" { print $2; exit }')"
case "$LIVE_WORKSPACE_UUID" in
  ''|*[!A-Fa-f0-9-]*) fail "cmux did not return an exact workspace UUID: $create_out" ;;
esac

attempt=0
while [ "$attempt" -lt 100 ]; do
  inventory="$(cmux --socket "$SOCKET" --id-format both --json list-workspaces)"
  LIVE_WORKSPACE_REF="$(workspace_field_for_id "$inventory" "$LIVE_WORKSPACE_UUID" ref)"
  [ -n "$LIVE_WORKSPACE_REF" ] && break
  sleep 0.05
  attempt=$((attempt + 1))
done
[ -n "$LIVE_WORKSPACE_REF" ] || fail "created UUID never appeared in cmux inventory"

restore_original_focus_if_test_selected
title="FLY-1364-qa-live-stock-$(date +%s)-$$"
cmux --socket "$SOCKET" rename-workspace --workspace "$LIVE_WORKSPACE_REF" "$title" >/dev/null \
  || fail "could not name the exact test workspace"
sleep 0.25
inventory="$(get_cmux_workspaces_json)" || fail "cmux inventory failed after live create"
workspace_present "$inventory" "$LIVE_WORKSPACE_REF" "$title" \
  || fail "dead command workspace did not remain as a sidebar entry"

# Exercise the same quiet-state sync_additive branch used by the real watcher.
# Only unrelated hygiene passes are isolated; stock observation, durable first
# pass, exact final revalidation, receipt, close, and receipt removal are the
# production implementations. No test writes a cleanup receipt directly.
(
  export FLYWHEEL_CMUX_STOCK_ADOPTION=1
  export FLYWHEEL_CMUX_ADOPTION_GRACE=0
  # Expose only the exact workspace created by this capability run to the
  # adoption state machine. The close mutation remains a real cmux call, but
  # unrelated host tabs can never enter this private two-pass candidate set.
  get_cmux_workspaces_json() {
    cmux --socket "$SOCKET" --id-format both --json list-workspaces \
      | /usr/bin/python3 -c '
import json, sys
ref, title = sys.argv[1:3]
data = json.load(sys.stdin)
matches = [w for w in data.get("workspaces", [])
           if w.get("ref") == ref and w.get("title") == title]
json.dump({"workspaces": matches}, sys.stdout)
' "$LIVE_WORKSPACE_REF" "$title"
  }
  register_hooks_on_new_sessions() { return 0; }
  get_tmux_agent_windows() { return 0; }
  self_heal_sweep_all() { return 0; }
  cleanup_stale_conservative() { return 0; }
  reap_ghost_workspaces() { return 0; }
  reap_orphan_workspace_pins() { return 0; }
  acquire_mutator_lease qa_teardown || fail "could not acquire stock-adoption lease"
  sync_additive
  first_inventory="$(get_cmux_workspaces_json)" || fail "inventory failed after first stock pass"
  workspace_present "$first_inventory" "$LIVE_WORKSPACE_REF" "$title" \
    || fail "first stock pass mutated before durable two-pass evidence"
  [ -s "$ADOPTION_STATE" ] || fail "first stock pass did not persist adoption evidence"
  sync_additive
  release_mutator_lease
) || fail "default stock-adoption state machine failed"

inventory="$(get_cmux_workspaces_json)" || fail "cmux inventory failed after cleanup"
if workspace_present "$inventory" "$LIVE_WORKSPACE_REF" "$title" \
    || grep -Fq "|$LIVE_WORKSPACE_REF|" "$VIEW_LEDGER" 2>/dev/null; then
  fail "dead workspace or its receipt survived cleanup"
fi
LIVE_WORKSPACE_UUID=""
LIVE_WORKSPACE_REF=""
pass "real pre-ledger dead workspace -> two-pass default stock adoption -> exact-ref close -> receipt removal"

echo "[TEST] real watcher creates, heals, preserves, then cleans an isolated A0B1 view"
: > "$VIEW_LEDGER"
: > "$EVENT_FILE"
: > "$CLEANUP_PENDING"
: > "$STALE_STATE"
: > "$HEAL_STATE"
: > "$CREATE_STATE"
: > "$ADOPTION_STATE"

TMUX_REAL="$(command -v tmux)"
case "$TMUX_REAL" in
  /*) ;;
  *) fail "could not resolve an absolute tmux binary" ;;
esac
mkdir -p "$TEST_ROOT/bin"
ISOLATED_TMUX_BIN="$TEST_ROOT/bin/tmux-fly1364"
printf '#!/bin/sh\nexec '\''%s'\'' -S '\''%s'\'' "$@"\n' "$TMUX_REAL" "$ISOLATED_TMUX_SOCKET" > "$ISOLATED_TMUX_BIN"
chmod +x "$ISOLATED_TMUX_BIN"
export FLYWHEEL_CMUX_ATTACH_TMUX_BIN="$ISOLATED_TMUX_BIN"
export FLYWHEEL_CMUX_TMUX_GENERATION="fly1364-live-$PPID-$$"

# From this point every sync function resolves tmux through the isolated server.
tmux() { "$ISOLATED_TMUX_BIN" "$@"; }

runner_session="runner-fly1364-live-$$"
runner_title="FLY-1364-qa-live-$$"
tmux new-session -d -s "$runner_session" -n "$runner_title" "sleep 300" \
  || fail "could not create isolated runner session"
tmux set-option -t "=$runner_session:" remain-on-exit on \
  || fail "could not enable remain-on-exit in isolated runner"
runner_wid="$(tmux display-message -p -t "=$runner_session:" '#{window_id}')"
case "$runner_wid" in @*) ;; *) fail "isolated runner did not expose a window id" ;; esac

/bin/bash -c '
  set -euo pipefail
  sync="$1"
  source "$sync"
  tmux() { "$FLYWHEEL_CMUX_ATTACH_TMUX_BIN" "$@"; }
  # This capability case owns one exact title/ref. Disable global cmux hygiene
  # passes so the real watcher can never inspect or mutate unrelated tabs.
  reap_ghost_workspaces() { return 0; }
  reap_unledgered_stock_workspaces() { return 0; }
  reap_orphan_workspace_pins() { return 0; }
  process_close_requests() { return 0; }
  acquire_watcher_lock
  watch_main
' _ "$SYNC" >"$TEST_ROOT/watch-main.log" 2>&1 &
watch_pid=$!
CHILD_PIDS="$CHILD_PIDS $watch_pid"

# Bootstrap is immediate. The 60s limit includes cmux create, exact receipt,
# independent-view construction, and the real tmux attach client.
create_started="$(date +%s)"
attempt=0
while [ "$attempt" -lt 300 ]; do
  inventory="$(cmux --socket "$SOCKET" --id-format both --json list-workspaces)"
  LIVE_WORKSPACE_REF="$(workspace_ref_for_title "$inventory" "$runner_title")"
  if [ -n "$LIVE_WORKSPACE_REF" ] \
      && grep -Fq "|$LIVE_WORKSPACE_REF|$runner_title" "$VIEW_LEDGER" 2>/dev/null \
      && tmux has-session -t "=cmux-$runner_title" 2>/dev/null \
      && [ "$(tmux list-clients -t "=cmux-$runner_title" -F '#{client_pid}' 2>/dev/null | grep -c . || true)" -ge 1 ]; then
    break
  fi
  sleep 0.2
  attempt=$((attempt + 1))
done
[ -n "$LIVE_WORKSPACE_REF" ] || fail "real watcher did not create the A0B1 workspace: $(tail -30 "$TEST_ROOT/watch-main.log")"
LIVE_WORKSPACE_UUID="$(workspace_id_for_ref "$inventory" "$LIVE_WORKSPACE_REF")"
create_elapsed=$(( $(date +%s) - create_started ))
[ "$create_elapsed" -le 60 ] || fail "A0B1 workspace missed the 60s create SLA (${create_elapsed}s)"
# A watcher-created workspace may become selected. Give focus back immediately,
# but only if the user has not already navigated away from the test-owned tab.
restore_original_focus_if_test_selected

grouped="$(tmux display-message -p -t "=cmux-$runner_title:" '#{session_grouped}')"
view_members="$(tmux list-windows -t "=cmux-$runner_title" -F '#{window_id}' | paste -sd, -)"
[ "$grouped" = "0" ] && [ "$view_members" = "$runner_wid" ] \
  || fail "A0B1 view is not independent/exact (grouped=$grouped members=$view_members source=$runner_wid)"
pass "real watcher -> A0B1 workspace + exact receipt + independent attached view in ${create_elapsed}s"

# Kill only the tmux attach client; the cmux surface returns to a bare shell.
# No create/register event is emitted, so recovery must come from the bounded
# 60s additive sweep added by R6.
# First cross a healthy watch tick so bootstrap and every create-time attach
# race are conclusively behind us; then detach every client present.
sleep 16
client_ttys="$(tmux list-clients -t "=cmux-$runner_title" -F '#{client_tty}')"
[ -n "$client_ttys" ] || fail "attached view had no detachable client"
while IFS= read -r client_tty; do
  [ -z "$client_tty" ] && continue
  tmux detach-client -t "$client_tty" || fail "could not detach isolated attach client $client_tty"
done <<< "$client_ttys"
attempt=0
while [ "$attempt" -lt 100 ]; do
  clients="$(tmux list-clients -t "=cmux-$runner_title" -F '#{client_pid}' 2>/dev/null | grep -c . || true)"
  [ "$clients" = "0" ] && break
  sleep 0.1
  attempt=$((attempt + 1))
done
[ "${clients:-1}" = "0" ] || fail "attach client did not enter the killed/detached state"

heal_started="$(date +%s)"
attempt=0
while [ "$attempt" -lt 375 ]; do
  clients="$(tmux list-clients -t "=cmux-$runner_title" -F '#{client_pid}' 2>/dev/null | grep -c . || true)"
  [ "$clients" -ge 1 ] && break
  sleep 0.2
  attempt=$((attempt + 1))
done
heal_elapsed=$(( $(date +%s) - heal_started ))
[ "${clients:-0}" -ge 1 ] && [ "$heal_elapsed" -le 75 ] \
  || fail "periodic attach heal did not reattach within its bounded tick (${heal_elapsed}s): $(tail -40 "$TEST_ROOT/watch-main.log")"
pass "killed attach -> periodic zero-client heal -> real client restored in ${heal_elapsed}s"

# Retire the spawning runner session while the watched pane is still held by
# the strict view. The window-unlinked event must be cancelled by view liveness.
tmux kill-session -t "=$runner_session" || fail "could not retire isolated runner session"
sleep 20
inventory="$(cmux --socket "$SOCKET" --id-format both --json list-workspaces)"
workspace_present "$inventory" "$LIVE_WORKSPACE_REF" "$runner_title" \
  || fail "workspace lifetime was still tied to the spawning runner session"
tmux has-session -t "=cmux-$runner_title" \
  || fail "independent view disappeared with the spawning runner session"
pass "runner session retired -> live watched window/view remains the lifetime owner"

# Now make the watched process exit while remain-on-exit retains the dead pane.
# The resulting strict-view pane-died event enters the same delayed exact-ref
# cleanup path; no direct helper call is used here.
tmux send-keys -t "=cmux-$runner_title:$runner_wid" C-c \
  || fail "could not terminate the watched process"
attempt=0
while [ "$attempt" -lt 100 ]; do
  pane_dead="$(tmux display-message -p -t "=cmux-$runner_title:$runner_wid" '#{pane_dead}' 2>/dev/null || echo 0)"
  [ "$pane_dead" = "1" ] && break
  sleep 0.1
  attempt=$((attempt + 1))
done
[ "${pane_dead:-0}" = "1" ] || fail "watched pane did not reach remain-on-exit dead state"
cleanup_started="$(date +%s)"
attempt=0
while [ "$attempt" -lt 225 ]; do
  inventory="$(cmux --socket "$SOCKET" --id-format both --json list-workspaces)"
  if ! workspace_present "$inventory" "$LIVE_WORKSPACE_REF" "$runner_title" \
      && ! grep -Fq "|$LIVE_WORKSPACE_REF|" "$VIEW_LEDGER" 2>/dev/null; then
    break
  fi
  sleep 0.2
  attempt=$((attempt + 1))
done
cleanup_elapsed=$(( $(date +%s) - cleanup_started ))
if workspace_present "$inventory" "$LIVE_WORKSPACE_REF" "$runner_title" \
    || grep -Fq "|$LIVE_WORKSPACE_REF|" "$VIEW_LEDGER" 2>/dev/null; then
  fail "dead watched pane was not automatically removed: $(tail -60 "$TEST_ROOT/watch-main.log")"
fi
LIVE_WORKSPACE_UUID=""
LIVE_WORKSPACE_REF=""
pass "watched pane exited -> real watcher exact-ref cleanup in ${cleanup_elapsed}s"

echo "Results: 7 passed, 0 failed"
