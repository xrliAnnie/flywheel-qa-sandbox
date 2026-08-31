#!/usr/bin/env bash
# FLY-2048: operator convergence takes the existing watcher handover, refreshes
# every proof round, and fails loud when no mutation happened.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMP/watcher.lock"
export CMUX_OPS_REBUILD_CLAIM="$TMP/ops.claim"
export CMUX_QA_TEARDOWN_CLAIM="$TMP/qa.claim"
export CMUX_MAINTENANCE_MARKER="$TMP/maintenance"

# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"
set +e

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

if declare -F parse_converge_runners_args >/dev/null; then
  parse_converge_runners_args --handover
  good_rc=$?
  parse_converge_runners_args >/dev/null 2>&1
  missing_rc=$?
  parse_converge_runners_args --handover --handover >/dev/null 2>&1
  duplicate_rc=$?
  parse_converge_runners_args --unknown >/dev/null 2>&1
  unknown_rc=$?
else
  good_rc=127; missing_rc=0; duplicate_rc=0; unknown_rc=0
fi
if [[ "$good_rc" == 0 && "$missing_rc" != 0 && "$duplicate_rc" != 0 && "$unknown_rc" != 0 ]]; then
  ok "operator argv accepts exactly one --handover"
else
  bad "operator argv contract missing good=$good_rc missing=$missing_rc duplicate=$duplicate_rc unknown=$unknown_rc"
fi

handover_trace="$TMP/watcher-handover.trace"
ROOT="$ROOT" HANDOVER_TRACE="$handover_trace" /bin/bash -c '
  source "$ROOT/scripts/flywheel-cmux-sync.sh"
  MAINTENANCE_ACTIVE=1
  maintenance_requested() { [[ "$MAINTENANCE_ACTIVE" == 1 ]]; }
  mutator_lease_owned_by_self() { return 0; }
  watcher_maintenance_checkpoint() { printf "checkpoint\n" >> "$HANDOVER_TRACE"; }
  MUTATOR_LEASE_MODE=watch
  WATCHER_PASS_ACTIVE=1
  watcher_mutation_latch_clear && printf "continued\n" >> "$HANDOVER_TRACE"
  [[ "$WATCHER_AUTHORITY_LOST" == 1 ]] || printf "direct-guard-continued\n" >> "$HANDOVER_TRACE"
  watcher_finish_pass
  WATCHER_AUTHORITY_FAILURE_STREAK=2
  watcher_begin_pass
  watcher_mutation_latch_clear >/dev/null || true
  MAINTENANCE_ACTIVE=0
  watcher_finish_pass
  printf "streak:%s\n" "$WATCHER_AUTHORITY_FAILURE_STREAK" >> "$HANDOVER_TRACE"
'
if [[ "$(cat "$handover_trace")" == $'checkpoint\nstreak:0' ]]; then
  ok "an in-flight watcher pass parks at its next safe boundary without faking lease loss"
else
  bad "in-flight watcher ignored handover trace=[$(tr '\n' ';' < "$handover_trace")]"
fi

ref_gone_rc=0
ROOT="$ROOT" REF_GONE_TMP="$TMP/ref-gone" /bin/bash -c '
  export VIEW_LEDGER="$REF_GONE_TMP.ledger"
  source "$ROOT/scripts/flywheel-cmux-sync.sh"
  printf "%s\n" "committed|generation-2048|workspace:2048|FLY-2048-runner-codex-G-gone|00000000-0000-4000-8000-000000002048" > "$VIEW_LEDGER"
  cmux_socket_identity() { printf "generation-2048\n"; }
  get_cmux_workspaces_json() { printf "%s\n" "{\"workspaces\":[]}"; }
  tmux() { [[ "$1" == list-sessions ]] && return 0; return 1; }
  collect_agent_window_names_strict() { return 0; }
  close_orphan_workspace_pin_if_still_orphan workspace:2048 FLY-2048-runner-codex-G-gone
' >/dev/null 2>&1 || ref_gone_rc=$?
if [[ "$ref_gone_rc" == 1 ]]; then
  ok "an exact ref already gone at revalidation is a predicate skip, not uncertainty"
else
  bad "ref-gone revalidation returned rc=$ref_gone_rc instead of 1"
fi

stock_retired_env_receipt=$(ROOT="$ROOT" /bin/bash -c '
  source "$ROOT/scripts/flywheel-cmux-sync.sh"
  assert_or_reuse_owned_lease() { return 1; }
  FLYWHEEL_CMUX_STOCK_ADOPTION=0 reap_unledgered_stock_workspaces
  printf "%s\n" "$CMUX_STOCK_SWEEP_CONCLUSIVE"
')
if [[ "$stock_retired_env_receipt" == 0 ]]; then
  ok "the retired stock-adoption env cannot manufacture a configured-skip receipt"
else
  bad "retired stock-adoption env still skipped the sweep receipt=[$stock_retired_env_receipt]"
fi

trace="$TMP/converge.trace"
: > "$trace"
if declare -F run_converge_runners >/dev/null; then
  publish_ops_rebuild_claim() { printf 'claim\n' >> "$trace"; return 0; }
  release_ops_rebuild_claim() { printf 'release-claim\n' >> "$trace"; return 0; }
  acquire_mutator_lease() { printf 'lease:%s\n' "$1" >> "$trace"; return 0; }
  release_mutator_lease() { printf 'release-lease\n' >> "$trace"; return 0; }
  maintenance_entry_allowed() { printf 'maintenance:%s\n' "$1" >> "$trace"; return 0; }
  begin_cmux_additive_round() {
    ROUND_N=$(( ${ROUND_N:-0} + 1 ))
    CMUX_ADDITIVE_ROUND_ID="2048-$ROUND_N"
    printf 'round:%s\n' "$ROUND_N" >> "$trace"
  }
  cmux_attach_birth_cache_prime() {
    BIRTH_N=$(( ${BIRTH_N:-0} + 1 ))
    printf 'birth:%s\n' "$BIRTH_N" >> "$trace"
  }
  prepare_linked_view_state() { printf 'wal:%s\n' "$1" >> "$trace"; return 0; }
  reap_orphan_pins_oneshot() { printf 'pins\n' >> "$trace"; }
  discover_orphan_attach_helpers() {
    CMUX_HELPER_DISCOVERY_CONCLUSIVE=1
    printf 'helpers:%s\n' "$CMUX_ADDITIVE_ROUND_ID" >> "$trace"
  }
  advance_attach_reap_state() { printf 'advance\n' >> "$trace"; }
  reap_unledgered_stock_workspaces() {
    CMUX_STOCK_SWEEP_CONCLUSIVE=1
    printf 'stock\n' >> "$trace"
  }
  sleep() { printf 'sleep:%s\n' "$1" >> "$trace"; }
  FLYWHEEL_CMUX_CONVERGE_OBSERVATION_SECONDS=1 run_converge_runners --handover
  converge_rc=$?
else
  converge_rc=127
fi
expected=$'claim\nlease:ops_rebuild\nmaintenance:ops_rebuild\nadvance\nround:1\nbirth:1\nwal:pre\npins\nhelpers:2048-1\nstock'
for _ in {1..60}; do expected+=$'\nsleep:1'; done
expected+=$'\nround:2\nbirth:2\nwal:pre\npins\nhelpers:2048-2\nstock\nadvance\nrelease-lease\nrelease-claim'
if [[ "$converge_rc" == 0 && "$(cat "$trace")" == "$expected" ]]; then
  ok "operator handover runs two independently primed rounds and releases exact authority"
else
  bad "operator convergence wiring rc=$converge_rc trace=[$(tr '\n' ';' < "$trace")]"
fi

abort_trace="$TMP/converge-abort.trace"
: > "$abort_trace"
set -m
ROOT="$ROOT" ABORT_TRACE="$abort_trace" /bin/bash -c '
  source "$ROOT/scripts/flywheel-cmux-sync.sh"
  publish_ops_rebuild_claim() { printf "claim\n" >> "$ABORT_TRACE"; }
  release_ops_rebuild_claim() { printf "release-claim\n" >> "$ABORT_TRACE"; }
  acquire_mutator_lease() { printf "lease\n" >> "$ABORT_TRACE"; }
  release_mutator_lease() { printf "release-lease\n" >> "$ABORT_TRACE"; }
  maintenance_entry_allowed() { return 0; }
  advance_attach_reap_state() { return 0; }
  begin_cmux_additive_round() { CMUX_ADDITIVE_ROUND_ID=2048-1; }
  cmux_attach_birth_cache_prime() { return 0; }
  prepare_linked_view_state() { return 0; }
  reap_orphan_pins_oneshot() { return 0; }
  discover_orphan_attach_helpers() { CMUX_HELPER_DISCOVERY_CONCLUSIVE=1; }
  reap_unledgered_stock_workspaces() {
    CMUX_STOCK_SWEEP_CONCLUSIVE=1
    printf "observation\n" >> "$ABORT_TRACE"
  }
  FLYWHEEL_CMUX_CONVERGE_OBSERVATION_SECONDS=60 run_converge_runners --handover
' >"$TMP/converge-abort.out" 2>&1 &
abort_pid=$!
set +m
for abort_wait in $(seq 1 50); do
  grep -q '^observation$' "$abort_trace" 2>/dev/null && break
  /bin/sleep 0.1
done
kill -TERM "$abort_pid" 2>/dev/null || true
abort_prompt=0
for abort_wait in $(seq 1 30); do
  if ! kill -0 "$abort_pid" 2>/dev/null; then abort_prompt=1; break; fi
  /bin/sleep 0.1
done
if [[ "$abort_prompt" == 0 ]]; then kill -KILL -- "-$abort_pid" 2>/dev/null || true; fi
wait "$abort_pid" 2>/dev/null
abort_rc=$?
if [[ "$abort_prompt" == 1 && "$abort_rc" == 143 \
    && "$(grep -c '^release-lease$' "$abort_trace")" -ge 1 \
    && "$(grep -c '^release-claim$' "$abort_trace")" -ge 1 ]]; then
  ok "TERM interrupts the inter-round observation wait and releases exact authority promptly"
else
  bad "TERM was deferred by observation wait prompt=$abort_prompt rc=$abort_rc trace=[$(tr '\n' ';' < "$abort_trace")]"
fi

: > "$trace"
discover_orphan_attach_helpers() { printf 'helpers-no-receipt\n' >> "$trace"; return 0; }
fake_green_rc=0
FLYWHEEL_CMUX_CONVERGE_OBSERVATION_SECONDS=1 run_converge_runners --handover >/dev/null 2>&1 || fake_green_rc=$?
if [[ "$fake_green_rc" != 0 && "$(cat "$trace")" == *helpers-no-receipt* \
    && "$(cat "$trace")" != *$'\nstock'* ]]; then
  ok "operator convergence rejects a cleanup entry that returned without a conclusive receipt"
else
  bad "operator convergence accepted a fake-green cleanup rc=$fake_green_rc trace=[$(tr '\n' ';' < "$trace")]"
fi

: > "$trace"
maintenance_entry_allowed() { return 1; }
maintenance_refusal_rc=0
run_converge_runners --handover >/dev/null 2>"$TMP/maintenance-refusal.err" || maintenance_refusal_rc=$?
if [[ "$maintenance_refusal_rc" != 0 ]] \
    && grep -q 'maintenance authority refused' "$TMP/maintenance-refusal.err"; then
  ok "operator convergence logs a maintenance-authority refusal"
else
  bad "maintenance refusal was silent rc=$maintenance_refusal_rc err=[$(cat "$TMP/maintenance-refusal.err")]"
fi

: > "$trace"
dry_rc=0
FLYWHEEL_CMUX_DRY_RUN=1 run_converge_runners --handover >/dev/null 2>&1 || dry_rc=$?
if [[ "$dry_rc" == 0 && ! -s "$trace" ]]; then
  ok "dry-run performs no claim, lease, state, sleep, or mutation side effect"
else
  bad "dry-run escaped into handover rc=$dry_rc trace=[$(tr '\n' ';' < "$trace")]"
fi

alert_out="$TMP/alert.out"
alert_rc=0
ROOT="$ROOT" /bin/bash -c '
  source "$ROOT/scripts/flywheel-cmux-sync.sh"
  flywheel_alert() { return 2; }
  set -e
  _alert_cmux_cleanup title body signature
  printf "survived\n"
' >"$alert_out" 2>&1 || alert_rc=$?
if [[ "$alert_rc" == 0 && "$(cat "$alert_out")" == survived ]]; then
  ok "alert delivery failure cannot overwrite a completed cleanup result under errexit"
else
  bad "alert delivery failure escaped into cleanup rc=$alert_rc out=[$(cat "$alert_out")]"
fi

if cmux_mutator_command_matches \
    '/bin/bash /tmp/flywheel-cmux-sync.sh --converge-runners --handover'; then
  ok "process census recognizes the convergence mutator"
else
  bad "process census omits --converge-runners"
fi

noop_mutation() { printf 'mutated\n' >> "$TMP/mutation"; }
acquire_mutator_lease() { return 1; }
strict_busy_rc=0
run_mutator_once reaper noop_mutation strict >/dev/null 2>"$TMP/strict-busy.err" || strict_busy_rc=$?
acquire_mutator_lease() { return 2; }
strict_malformed_rc=0
run_mutator_once reaper noop_mutation strict >/dev/null 2>"$TMP/strict-malformed.err" || strict_malformed_rc=$?
acquire_mutator_lease() { return 0; }
maintenance_entry_allowed() { return 1; }
release_mutator_lease() { :; }
strict_maintenance_rc=0
run_mutator_once reaper noop_mutation strict >/dev/null 2>"$TMP/strict-maintenance.err" || strict_maintenance_rc=$?
if [[ "$strict_busy_rc" != 0 && "$strict_malformed_rc" != 0 \
    && "$strict_maintenance_rc" != 0 && ! -e "$TMP/mutation" \
    && "$(grep -l -- '--converge-runners --handover' "$TMP"/strict-*.err | wc -l | tr -d ' ')" == 3 ]]; then
  ok "strict legacy operator entries fail loud on every zero-mutation lease exit"
else
  bad "strict zero-mutation exits busy=$strict_busy_rc malformed=$strict_malformed_rc maintenance=$strict_maintenance_rc"
fi

oneshot_rc=0
ROOT="$ROOT" /bin/bash -c '
  source "$ROOT/scripts/flywheel-cmux-sync.sh"
  orphan_pin_refs() {
    printf "workspace:1\tFLY-2048-dead-one\nworkspace:2\tFLY-2048-dead-two\n"
  }
  close_orphan_workspace_pin_if_still_orphan() {
    [[ "$1" == workspace:1 ]] && return 2
    return 0
  }
  cmux_call() { :; }
  reap_orphan_pins_oneshot
' >/dev/null 2>&1 || oneshot_rc=$?
if [[ "$oneshot_rc" == 2 ]]; then
  ok "operator convergence fails loud when any exact close is uncertain"
else
  bad "operator convergence swallowed an uncertain close rc=$oneshot_rc"
fi

once_err="$TMP/once.err"
(
  pgrep() { return 0; }
  sync_once
) >/dev/null 2>"$once_err"
once_rc=$?
if [[ "$once_rc" != 0 ]] && grep -q -- '--converge-runners --handover' "$once_err"; then
  ok "sync_once watcher guard fails loud and points at the executable path"
else
  bad "sync_once still fake-greens rc=$once_rc err=[$(cat "$once_err")]"
fi

printf '\nFLY-2048 cmux convergence: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
