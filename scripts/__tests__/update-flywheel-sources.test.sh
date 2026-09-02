#!/usr/bin/env bash
# FLY-1959: updater accepts only schedule drift or founder urgent tokens.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UPDATER="$ROOT/scripts/update-flywheel.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1959-updater.XXXXXX")"
cleanup_test() { rm -rf "$TMP"; }
trap cleanup_test EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

export HOME="$TMP/home"
export FLYWHEEL_HOME="$TMP/state"
export FLYWHEEL_STATE_DIR="$FLYWHEEL_HOME"
export SELF_SHIP_URGENT_DIR="$FLYWHEEL_HOME/self-ship-urgent.d"
export SELF_SHIP_LOCK_DIR="$FLYWHEEL_HOME/updater.lock.d"
export DEPLOYED_SHA_FILE="$FLYWHEEL_HOME/deployed-sha"
export ENV_FILE=/dev/null
export UPDATE_FLYWHEEL_SOURCED=1
export UPDATE_FLYWHEEL_CONVERGE_CMD=true
mkdir -p "$HOME" "$FLYWHEEL_HOME"

export FLYWHEEL_DIR="$TMP/repo"
git init -q "$FLYWHEEL_DIR"
git -C "$FLYWHEEL_DIR" config user.email fly1959@example.test
git -C "$FLYWHEEL_DIR" config user.name FLY-1959
printf 'one\n' > "$FLYWHEEL_DIR/state.txt"
git -C "$FLYWHEEL_DIR" add state.txt
git -C "$FLYWHEEL_DIR" commit -qm one
SHA1="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)"
git -C "$FLYWHEEL_DIR" update-ref refs/remotes/origin/main "$SHA1"
FOREIGN_SHA=9999999999999999999999999999999999999999

# shellcheck source=/dev/null
source "$UPDATER"
PRODUCTION_FETCH_DEFINITION="$(declare -f updater_fetch_origin)"

required_functions=(
  updater_init_dirs updater_lock_acquire updater_lock_release
  updater_token_shape_valid updater_claim_token updater_urgent_signature
  updater_scheduled_signature updater_sync_fable_model update_main
)
missing_functions=()
for fn in "${required_functions[@]}"; do
  declare -F "$fn" >/dev/null 2>&1 || missing_functions+=("$fn")
done
if [ "${#missing_functions[@]}" -ne 0 ]; then
  fail "new two-source updater API is missing: ${missing_functions[*]}"
  printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
  exit 1
fi

last_library_source_line="$(rg -n '^source "\$\{SCRIPT_DIR\}/launchd-census\.sh"$' "$UPDATER" | tail -1 | cut -d: -f1)"
last_runtime_pin_line="$(rg -n '^updater_configure_runtime_paths$' "$UPDATER" | tail -1 | cut -d: -f1)"
if [[ "$last_library_source_line" =~ ^[0-9]+$ \
  && "$last_runtime_pin_line" =~ ^[0-9]+$ \
  && "$last_runtime_pin_line" -gt "$last_library_source_line" ]]; then
  pass "production path pin runs after every library that may re-source .env"
else
  fail "runtime path pin can be overwritten by a later .env source (library=$last_library_source_line pin=$last_runtime_pin_line)"
fi

if declare -F updater_configure_runtime_paths >/dev/null 2>&1; then
  saved_sourced="$UPDATE_FLYWHEEL_SOURCED"
  saved_home="$FLYWHEEL_HOME"
  saved_urgent="$SELF_SHIP_URGENT_DIR"
  saved_lock="$SELF_SHIP_LOCK_DIR"
  sandbox_home="$HOME"
  UPDATE_FLYWHEEL_SOURCED=0
  FLYWHEEL_HOME="$TMP/diverted-state"
  SELF_SHIP_URGENT_DIR="$TMP/diverted-urgent"
  SELF_SHIP_LOCK_DIR="$TMP/diverted-lock"
  updater_configure_runtime_paths
  runtime_home="$FLYWHEEL_HOME"
  runtime_urgent="$SELF_SHIP_URGENT_DIR"
  runtime_lock="$SELF_SHIP_LOCK_DIR"
  UPDATE_FLYWHEEL_SOURCED=1
  FLYWHEEL_HOME="$saved_home"
  SELF_SHIP_URGENT_DIR="$saved_urgent"
  SELF_SHIP_LOCK_DIR="$saved_lock"
  updater_configure_runtime_paths
  if [ "$runtime_home" = "$sandbox_home/.flywheel" ] \
    && [ "$runtime_urgent" = "$sandbox_home/.flywheel/self-ship-urgent.d" ] \
    && [ "$runtime_lock" = "$sandbox_home/.flywheel/self-ship-updater.lock.d" ] \
    && [ "$FLYWHEEL_HOME" = "$saved_home" ] \
    && [ "$SELF_SHIP_URGENT_DIR" = "$saved_urgent" ] \
    && [ "$SELF_SHIP_LOCK_DIR" = "$saved_lock" ]; then
    pass "production pins plist-aligned state paths while sourced harnesses may override"
  else
    fail "runtime path pinning drifted (runtime=$runtime_home/$runtime_urgent/$runtime_lock sourced=$FLYWHEEL_HOME/$SELF_SHIP_URGENT_DIR/$SELF_SHIP_LOCK_DIR)"
  fi
  UPDATE_FLYWHEEL_SOURCED="$saved_sourced"
else
  fail "updater lacks explicit production path pinning"
fi

DEPLOY_CALLS="$TMP/deploy.calls"
ALERT_CALLS="$TMP/alert.calls"
FETCH_MODE=ok
LAUNCHD_PASS_CALLS="$TMP/launchd-pass.calls"
MODEL_SYNC_CALLS="$TMP/model-sync.calls"
: > "$DEPLOY_CALLS"
: > "$ALERT_CALLS"
: > "$LAUNCHD_PASS_CALLS"
: > "$MODEL_SYNC_CALLS"

updater_fetch_origin() {
  case "$FETCH_MODE" in
    ok) return 0 ;;
    missing) return 127 ;;
    *) return 1 ;;
  esac
}
updater_converge_bin() { :; }
updater_launchd_pass() { printf 'pass\n' >> "$LAUNCHD_PASS_CALLS"; }
updater_sync_fable_model() {
  printf 'call\n' >> "$MODEL_SYNC_CALLS"
  [ "${MODEL_SYNC_MODE:-ok}" = ok ]
}
severe_alert() { printf '%s|%s\n' "$1" "$2" >> "$ALERT_CALLS"; }
stub_deploy_ok() {
  printf 'call\n' >> "$DEPLOY_CALLS"
  git -C "$FLYWHEEL_DIR" rev-parse origin/main > "$DEPLOYED_SHA_FILE"
  return 0
}
stub_deploy_fail() { printf 'call\n' >> "$DEPLOY_CALLS"; return 3; }
stub_deploy_observe_claim() {
  printf 'call watched=%s claimed=%s\n' \
    "$(urgent_count)" \
    "$(find "${UPDATER_CLAIM_DIR:?}" -type f 2>/dev/null | wc -l | tr -d ' ')" \
    >> "$DEPLOY_CALLS"
  git -C "$FLYWHEEL_DIR" rev-parse origin/main > "$DEPLOYED_SHA_FILE"
  return 0
}
stub_deploy_late() {
  printf 'call\n' >> "$DEPLOY_CALLS"
  write_token late "$SHA1"
  git -C "$FLYWHEEL_DIR" rev-parse origin/main > "$DEPLOYED_SHA_FILE"
  return 0
}

write_token() {
  local nonce="$1" sha="$2" kind="${3:-founder-urgent-restart}"
  mkdir -p "$SELF_SHIP_URGENT_DIR"
  jq -n --arg sha "$sha" --arg kind "$kind" \
    '{schemaVersion:1,kind:$kind,targetSha:$sha,createdAt:1700000000}' \
    > "$SELF_SHIP_URGENT_DIR/${nonce}.urgent.json"
  chmod 600 "$SELF_SHIP_URGENT_DIR/${nonce}.urgent.json"
}
urgent_count() { find "$SELF_SHIP_URGENT_DIR" -type f 2>/dev/null | wc -l | tr -d ' '; }
urgent_entry_count() { find "$SELF_SHIP_URGENT_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' '; }
deploy_count() { grep -c '^call' "$DEPLOY_CALLS" 2>/dev/null || true; }
reset_case() {
  rm -rf "$SELF_SHIP_URGENT_DIR" "$SELF_SHIP_LOCK_DIR" "$FLYWHEEL_HOME"/.urgent-claim.*
  mkdir -p "$FLYWHEEL_HOME"
  : > "$DEPLOY_CALLS"
  : > "$ALERT_CALLS"
  : > "$LAUNCHD_PASS_CALLS"
  : > "$MODEL_SYNC_CALLS"
  FETCH_MODE=ok
  MODEL_SYNC_MODE=ok
  SELF_SHIP_DEPLOY_CMD=stub_deploy_ok
  UPDATER_UTC_DAY=20260821
}

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 0 ] \
  && [ "$(grep -c '^call$' "$MODEL_SYNC_CALLS")" = 1 ]; then
  pass "schedule runs one model sync inside the singleton and performs zero caught-up deploys"
else
  fail "caught-up schedule/model sync drifted (rc=$rc deploys=$(deploy_count) syncs=$(cat "$MODEL_SYNC_CALLS"))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
MODEL_SYNC_MODE=fail
update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 0 ] \
  && [ "$(grep -c '^call$' "$MODEL_SYNC_CALLS")" = 1 ] \
  && [ "$(grep -c '^pass$' "$LAUNCHD_PASS_CALLS")" = 1 ]; then
  pass "model sync failure is non-fatal and does not suppress the existing updater cycle"
else
  fail "model sync failure changed updater semantics (rc=$rc deploys=$(deploy_count) syncs=$(cat "$MODEL_SYNC_CALLS") launchd=$(cat "$LAUNCHD_PASS_CALLS"))"
fi

if declare -F updater_fetch_origin_once >/dev/null 2>&1 \
  && declare -F updater_retry_sleep >/dev/null 2>&1; then
  BOUNDED_FETCH_LOG="$TMP/bounded-fetch.log"
  export BOUNDED_FETCH_LOG
  fake_bounded_run="$TMP/fake-bounded-run"
  cat > "$fake_bounded_run" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "${GIT_TERMINAL_PROMPT:-unset}" "$*" > "$BOUNDED_FETCH_LOG"
EOF
  chmod +x "$fake_bounded_run"
  original_bounded_run="$UPDATER_BOUNDED_RUN"
  original_updater_git="$UPDATER_GIT"
  original_fetch_timeout="$UPDATER_FETCH_TIMEOUT_SECONDS"
  UPDATER_BOUNDED_RUN="$fake_bounded_run"
  UPDATER_GIT=git-sentinel
  UPDATER_FETCH_TIMEOUT_SECONDS=17
  updater_fetch_origin_once >/dev/null 2>&1; once_rc=$?
  bounded_fetch_record="$(cat "$BOUNDED_FETCH_LOG" 2>/dev/null || true)"
  UPDATER_BOUNDED_RUN="$original_bounded_run"
  UPDATER_GIT="$original_updater_git"
  UPDATER_FETCH_TIMEOUT_SECONDS="$original_fetch_timeout"

  eval "$PRODUCTION_FETCH_DEFINITION"
  fetch_attempts=0
  retry_sleeps=0
  updater_fetch_origin_once() {
    fetch_attempts=$((fetch_attempts + 1))
    return 127
  }
  updater_retry_sleep() { retry_sleeps=$((retry_sleeps + 1)); }
  updater_fetch_origin >/dev/null 2>&1; missing_rc=$?
  missing_attempts=$fetch_attempts
  missing_sleeps=$retry_sleeps

  fetch_attempts=0
  retry_sleeps=0
  updater_fetch_origin_once() {
    fetch_attempts=$((fetch_attempts + 1))
    [ "$fetch_attempts" -eq 3 ]
  }
  updater_retry_sleep() { retry_sleeps=$((retry_sleeps + 1)); }
  updater_fetch_origin >/dev/null 2>&1; rc=$?
  updater_fetch_origin() {
    case "$FETCH_MODE" in
      ok) return 0 ;;
      missing) return 127 ;;
      *) return 1 ;;
    esac
  }
  if [ "$once_rc" -eq 0 ] \
    && [ "$bounded_fetch_record" = "0|17 git-sentinel -C $FLYWHEEL_DIR fetch origin main --quiet" ] \
    && [ "$missing_rc" -eq 127 ] && [ "$missing_attempts" -eq 1 ] && [ "$missing_sleeps" -eq 0 ] \
    && [ "$rc" -eq 0 ] && [ "$fetch_attempts" -eq 3 ] && [ "$retry_sleeps" -eq 2 ]; then
    pass "origin fetch is bounded, retries transients, and fails fast when its runner is missing"
  else
    fail "origin fetch bounds/retry drifted (once=$once_rc record=$bounded_fetch_record missing=$missing_rc/$missing_attempts/$missing_sleeps rc=$rc attempts=$fetch_attempts sleeps=$retry_sleeps)"
  fi
else
  fail "origin fetch lacks bounded one-shot and retry seams"
fi

# FLY-2190: a custom state root may not have converged the gate yet. The
# updater must use the checked-out gate as its first-deploy fallback and pass
# the configured state root through both the gate and verify calls.
if declare -F updater_host_tmux_gate >/dev/null 2>&1; then
  gate_calls="$TMP/updater-host-tmux-gate.calls"
  mkdir -p "$FLYWHEEL_DIR/scripts"
  cat > "$FLYWHEEL_DIR/scripts/host-tmux-selection-gate.sh" <<'EOF'
#!/bin/bash
printf '%s|%s|%s|%s\n' "$*" "${FLYWHEEL_STATE_DIR:-}" \
  "${FLYWHEEL_HOST_TMUX_TARGET_SHA:-}" "${FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION:-}" \
  >> "${UPDATER_HOST_TMUX_GATE_CALLS:?}"
exit 0
EOF
  chmod +x "$FLYWHEEL_DIR/scripts/host-tmux-selection-gate.sh"
  rm -f "$FLYWHEEL_HOME/bin/host-tmux-selection-gate.sh"
  UPDATER_HOST_TMUX_GATE_CALLS="$gate_calls" updater_host_tmux_gate
  fallback_rc=$?
  rm -rf "$FLYWHEEL_DIR/scripts"
  if [ "$fallback_rc" -eq 0 ] \
    && grep -Fqx "gate updater|$FLYWHEEL_HOME|$SHA1|updater-fast-forward:$SHA1" "$gate_calls" \
    && grep -Fqx "verify updater|$FLYWHEEL_HOME|$SHA1|updater-fast-forward:$SHA1" "$gate_calls"; then
    pass "host tmux gate falls back to checkout and preserves a custom state root"
  else
    fail "host tmux checkout fallback missing (rc=$fallback_rc calls=$(cat "$gate_calls" 2>/dev/null))"
  fi
else
  fail "updater lacks the host tmux gate seam"
fi

if declare -F updater_git_bounded >/dev/null 2>&1 \
  && declare -F updater_merge_remote >/dev/null 2>&1 \
  && declare -F updater_host_tmux_gate >/dev/null 2>&1 \
  && declare -F updater_restart_services >/dev/null 2>&1; then
  deploy_path_calls="$TMP/default-deploy-path.calls"
  : > "$deploy_path_calls"
  saved_fetch="$(declare -f updater_fetch_origin)"
  saved_bounded_git="$(declare -f updater_git_bounded)"
  saved_merge_remote="$(declare -f updater_merge_remote)"
  saved_host_tmux_gate="$(declare -f updater_host_tmux_gate)"
  saved_restart_services="$(declare -f updater_restart_services)"
  saved_pointer_guard="$(declare -f discord_pointer_cutover_required)"
  updater_fetch_origin() { printf 'fetch\n' >> "$deploy_path_calls"; }
  updater_git_bounded() { printf 'git|%s\n' "$*" >> "$deploy_path_calls"; }
  updater_merge_remote() { printf 'merge\n' >> "$deploy_path_calls"; }
  updater_host_tmux_gate() { printf 'host-tmux-gate\n' >> "$deploy_path_calls"; }
  updater_restart_services() { printf 'restart\n' >> "$deploy_path_calls"; }
  discord_pointer_cutover_required() { return 1; }
  default_deploy >/dev/null 2>&1; rc=$?
  success_calls="$(cat "$deploy_path_calls")"
  : > "$deploy_path_calls"
  updater_host_tmux_gate() { printf 'host-tmux-gate\n' >> "$deploy_path_calls"; return 42; }
  default_deploy >/dev/null 2>&1; gate_held_rc=$?
  gate_held_calls="$(cat "$deploy_path_calls")"
  : > "$deploy_path_calls"
  updater_fetch_origin() { return 127; }
  default_deploy >/dev/null 2>&1; missing_deploy_rc=$?
  missing_deploy_calls="$(cat "$deploy_path_calls")"
  eval "$saved_fetch"
  eval "$saved_bounded_git"
  eval "$saved_merge_remote"
  eval "$saved_host_tmux_gate"
  eval "$saved_restart_services"
  eval "$saved_pointer_guard"
  if [ "$rc" -eq 0 ] \
    && [ "$success_calls" = $'fetch\nhost-tmux-gate\nmerge\nrestart' ] \
    && ! printf '%s\n' "$success_calls" | grep -q '^git|' \
    && [ "$gate_held_rc" -eq 3 ] \
    && [ "$gate_held_calls" = $'fetch\nhost-tmux-gate' ] \
    && [ "$missing_deploy_rc" -eq 127 ] && [ -z "$missing_deploy_calls" ]; then
    pass "default deploy gates the frozen target before merge and refuses held targets"
  else
    fail "default deploy host-tmux ordering drifted (rc=$rc calls=$success_calls held=$gate_held_rc/$gate_held_calls missing=$missing_deploy_rc/$missing_deploy_calls)"
  fi
else
  fail "default deploy lacks bounded-fetch/host-gate/local-merge/restart seams"
fi

reset_case
printf '%040d\n' 0 > "$DEPLOYED_SHA_FILE"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 1 ]; then
  pass "schedule drift performs exactly one deploy"
else
  fail "schedule drift did not deploy once (rc=$rc calls=$(deploy_count))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
write_token batch-a "$SHA1"
write_token batch-b "$SHA1"
before_status="$(git -C "$FLYWHEEL_DIR" status --porcelain)"
SELF_SHIP_DEPLOY_CMD=stub_deploy_observe_claim update_main >/dev/null 2>&1; rc=$?
after_status="$(git -C "$FLYWHEEL_DIR" status --porcelain)"
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 1 ] \
  && grep -q '^call watched=0 claimed=2$' "$DEPLOY_CALLS" \
  && [ -z "$before_status" ] && [ -z "$after_status" ] \
  && [ "$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-claim.*' | wc -l | tr -d ' ')" = 0 ]; then
  pass "urgent batch claims before one deploy without dirtying checkout"
else
  fail "urgent claim/deploy drifted (rc=$rc calls=$(cat "$DEPLOY_CALLS") before=$before_status after=$after_status)"
fi

reset_case
write_token current "$SHA1"
SELF_SHIP_DEPLOY_CMD=stub_deploy_late update_main >/dev/null 2>&1; rc=$?
first_calls="$(deploy_count)"
left_after_first="$(urgent_count)"
: > "$DEPLOY_CALLS"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] \
  && [ "$first_calls" = 1 ] && [ "$left_after_first" = 1 ] \
  && [ "$(deploy_count)" = 1 ] && [ "$(urgent_count)" = 0 ]; then
  pass "late same-SHA token survives snapshot and triggers the next invocation"
else
  fail "late token was lost or deduped (rc=$rc/$rc2 first=$first_calls left=$left_after_first second=$(deploy_count))"
fi

reset_case
write_token fail-once "$SHA1"
SELF_SHIP_DEPLOY_CMD=stub_deploy_fail update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 1 ] && [ "$(urgent_count)" = 0 ] \
  && [ "$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-claim.*' | wc -l | tr -d ' ')" = 0 ] \
  && grep -q '^urgent-deploy-failed-fail-once.urgent.json|' "$ALERT_CALLS"; then
  pass "urgent deploy failure is claim-once, alerting, and non-retrying"
else
  fail "urgent failure retained/retried/silenced (rc=$rc calls=$(deploy_count) urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
updater_init_dirs
printf '{ bad json\n' > "$SELF_SHIP_URGENT_DIR/bad-json.urgent.json"
write_token wrong-kind "$SHA1" wrong-kind
write_token foreign "$FOREIGN_SHA"
printf 'junk\n' > "$SELF_SHIP_URGENT_DIR/junk.txt"
mkdir -p "$SELF_SHIP_URGENT_DIR/nested.urgent.json"
printf 'must not survive claim cleanup\n' > "$SELF_SHIP_URGENT_DIR/nested.urgent.json/child"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_entry_count)" = 0 ] \
  && [ "$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-claim.*' | wc -l | tr -d ' ')" = 0 ] \
  && [ "$(grep -c '^urgent-invalid-' "$ALERT_CALLS" || true)" = 5 ]; then
  pass "provably invalid entries are removed, alerted individually, and never deploy"
else
  fail "invalid token policy drifted (rc=$rc calls=$(deploy_count) urgent=$(urgent_entry_count) claims=$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-claim.*' | wc -l | tr -d ' ') alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token hold-on-fetch "$SHA1"
FETCH_MODE=fail
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && grep -q '^urgent-probe-indeterminate-hold-on-fetch.urgent.json|' "$ALERT_CALLS"; then
  pass "indeterminate fetch failure consumes the claim once and cannot relaunch QueueDirectories"
else
  fail "indeterminate fetch token retried, deployed, or went silent (rc=$rc calls=$(deploy_count) urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token missing-bounded-runner "$SHA1"
FETCH_MODE=missing
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 127 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && grep -q '^urgent-probe-runtime-missing-missing-bounded-runner.urgent.json|' "$ALERT_CALLS"; then
  pass "missing bounded runner is fail-fast and reported without blaming the network"
else
  fail "missing bounded runner was misclassified (rc=$rc calls=$(deploy_count) urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token probe-error "$SHA1"
original_target_state="$(declare -f updater_token_target_state)"
updater_token_target_state() { printf 'indeterminate\n'; }
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
eval "$original_target_state"
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && grep -q '^urgent-probe-indeterminate-probe-error.urgent.json|' "$ALERT_CALLS"; then
  pass "indeterminate ancestry probe consumes the claim once and cannot wedge later tickets"
else
  fail "indeterminate probe token retried, deployed, or went silent (rc=$rc calls=$(deploy_count) urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token signal-before-probe-alert "$SHA1"
FETCH_MODE=fail
original_urgent_alert="$(declare -f updater_alert_urgent)"
signal_before_alert=1
updater_alert_urgent() {
  if [ "$1" = probe-indeterminate ] && [ "$signal_before_alert" -eq 1 ]; then
    signal_before_alert=0
    updater_signal_cleanup
  fi
  severe_alert "$(updater_urgent_signature "$1" "$2")" "$3"
}
( update_main ) >/dev/null 2>&1; rc=$?
eval "$original_urgent_alert"
if [ "$rc" -eq 130 ] && [ "$(urgent_count)" = 0 ] \
  && grep -q '^urgent-interrupted-signal-before-probe-alert.urgent.json|' "$ALERT_CALLS"; then
  pass "signal between indeterminate claim and primary alert gets interrupted-ticket coverage"
else
  fail "indeterminate claim-to-alert signal window was silent (rc=$rc urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
UPDATER_CLAIMED=1
UPDATER_COMPLETED=1
UPDATER_ALERTED=1
UPDATER_CLAIMED_BASENAMES=(existing.urgent.json)
updater_alert_consumed_no_deploy invalid consumed.urgent.json test >/dev/null 2>&1
if [ "$UPDATER_CLAIMED" -eq 1 ] && [ "$UPDATER_COMPLETED" -eq 1 ] \
  && [ "$UPDATER_ALERTED" -eq 1 ] \
  && [ "${UPDATER_CLAIMED_BASENAMES[*]-}" = existing.urgent.json ]; then
  pass "consumed-ticket alert helper restores the caller's claim state"
else
  fail "consumed-ticket helper clobbered claim state (${UPDATER_CLAIMED}/${UPDATER_COMPLETED}/${UPDATER_ALERTED}/${UPDATER_CLAIMED_BASENAMES[*]-})"
fi

reset_case
updater_init_dirs
claim_dir="$(mktemp -d "${FLYWHEEL_HOME}/.urgent-claim.XXXXXX")"
watched_device="$(stat -c %d "$SELF_SHIP_URGENT_DIR" 2>/dev/null || stat -f %d "$SELF_SHIP_URGENT_DIR")"
claim_device="$(stat -c %d "$claim_dir" 2>/dev/null || stat -f %d "$claim_dir")"
case "$claim_dir" in "$FLYWHEEL_DIR"/*) inside_repo=1 ;; *) inside_repo=0 ;; esac
rm -rf "$claim_dir"
if [ "$watched_device" = "$claim_device" ] && [ "$inside_repo" -eq 0 ]; then
  pass "claim directory is on the watched device and outside the git checkout"
else
  fail "claim directory placement is unsafe (watched=$watched_device claim=$claim_device path=$claim_dir)"
fi

reset_case
UPDATER_CLAIM_DIR="$(mktemp -d "${FLYWHEEL_HOME}/.urgent-claim.XXXXXX")"
printf '{}\n' > "$UPDATER_CLAIM_DIR/interrupted.urgent.json"
UPDATER_CLAIMED=1
UPDATER_COMPLETED=0
UPDATER_ALERTED=0
UPDATER_CLEANUP_DONE=0
UPDATER_CLAIMED_BASENAMES=(interrupted.urgent.json)
( updater_signal_cleanup ) >/dev/null 2>&1
signal_rc=$?
if [ "$signal_rc" -eq 130 ] && [ ! -e "$UPDATER_CLAIM_DIR" ] \
  && grep -q '^urgent-interrupted-interrupted.urgent.json|' "$ALERT_CALLS"; then
  pass "TERM/INT cleanup alerts for a claimed but incomplete urgent ticket"
else
  fail "signal cleanup lost the at-most-once warning (rc=$signal_rc dir=$([ -e "$UPDATER_CLAIM_DIR" ] && echo yes || echo no) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
mkdir -p "$SELF_SHIP_LOCK_DIR"
printf '12345\n' > "$SELF_SHIP_LOCK_DIR/pid"
printf 'update-flywheel\n' > "$SELF_SHIP_LOCK_DIR/ident"
updater_pid_alive() { return 0; }
updater_pid_command() { printf '/bin/bash /repo/scripts/update-flywheel.sh\n'; }
updater_lock_acquire update-flywheel >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 75 ] && [ "$(cat "$SELF_SHIP_LOCK_DIR/pid")" = 12345 ]; then
  pass "live identity-matching lock is never reclaimed"
else
  fail "live matching lock was reclaimed (rc=$rc owner=$(cat "$SELF_SHIP_LOCK_DIR/pid" 2>/dev/null))"
fi

updater_pid_command() { return 1; }
updater_lock_acquire update-flywheel >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 75 ] && [ "$(cat "$SELF_SHIP_LOCK_DIR/pid")" = 12345 ]; then
  pass "live uninspectable lock is never reclaimed"
else
  fail "live uninspectable lock was reclaimed (rc=$rc owner=$(cat "$SELF_SHIP_LOCK_DIR/pid" 2>/dev/null))"
fi

updater_pid_command() { printf '/usr/bin/unrelated-process\n'; }
updater_lock_acquire update-flywheel >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$SELF_SHIP_LOCK_DIR/pid")" = "$$" ]; then
  pass "live inspectable PID reuse is reclaimed"
else
  fail "PID reuse was not reclaimed (rc=$rc owner=$(cat "$SELF_SHIP_LOCK_DIR/pid" 2>/dev/null))"
fi
updater_lock_release

mkdir -p "$SELF_SHIP_LOCK_DIR"
printf '12345\n' > "$SELF_SHIP_LOCK_DIR/pid"
updater_pid_alive() { return 1; }
updater_lock_acquire update-flywheel >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$SELF_SHIP_LOCK_DIR/pid")" = "$$" ]; then
  pass "dead-owner stale lock is reclaimed"
else
  fail "dead lock was not reclaimed (rc=$rc owner=$(cat "$SELF_SHIP_LOCK_DIR/pid" 2>/dev/null))"
fi
updater_lock_release

reset_case
original_lock_writer="$(declare -f _updater_lock_write_owner)"
_updater_lock_write_owner() { return 1; }
lock_output="$(update_main 2>&1)"; rc=$?
eval "$original_lock_writer"
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] \
  && [[ "$lock_output" == *"could not persist singleton lock owner"* ]] \
  && grep -q '^lock-state-failed-scheduled-' "$ALERT_CALLS"; then
  pass "lock owner write failure is fail-loud and distinct from live contention"
else
  fail "lock state failure was reported as benign contention (rc=$rc calls=$(deploy_count) output=$lock_output alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
original_init_dirs="$(declare -f updater_init_dirs)"
updater_init_dirs() { return 1; }
init_output="$(update_main 2>&1)"; rc=$?
eval "$original_init_dirs"
if [ "$rc" -eq 1 ] && [ "$(deploy_count)" = 0 ] \
  && [[ "$init_output" == *"could not initialize updater state directories"* ]] \
  && grep -q '^init-failed-scheduled-' "$ALERT_CALLS"; then
  pass "state-directory initialization failure is independently alerted"
else
  fail "state-directory initialization failure became silent (rc=$rc calls=$(deploy_count) output=$init_output alerts=$(cat "$ALERT_CALLS"))"
fi

# Exercise the real durable dedup implementation with every output/state seam
# redirected to the sandbox and curl shadowed before any production PATH entry.
ALERT_BIN="$TMP/alert-bin"
mkdir -p "$ALERT_BIN" "$TMP/alert-home"
cat > "$ALERT_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '204'
EOF
chmod +x "$ALERT_BIN/curl"
export FLYWHEEL_CLAIMS_DB="$TMP/alert-home/claims.db"
export FLYWHEEL_ALERT_QUEUE_DIR="$TMP/alert-home/queue"
export FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/alert-home/deadletter"
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=sandbox-channel
export FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLY1959_FAKE_TOKEN
export FLY1959_FAKE_TOKEN=sandbox-token

send_real_alert() {
  local signature="$1"
  PATH="$ALERT_BIN:$PATH" HOME="$TMP/alert-home" \
    "$ROOT/scripts/lead-alert.sh" --project flywheel --lead updater \
      --kind deploy_failed --severity severe --title test --body test \
      --signature "$signature" --strict-delivery >/dev/null 2>&1
}

rm -f "$FLYWHEEL_CLAIMS_DB"
sig_same="$(updater_urgent_signature deploy-failed same.urgent.json)"
sig_other="$(updater_urgent_signature deploy-failed other.urgent.json)"
send_real_alert "$sig_same"
send_real_alert "$sig_same"
send_real_alert "$sig_other"
urgent_receipts="$(sqlite3 "$FLYWHEEL_CLAIMS_DB" "select count(*) from alert_deliveries where state='sent';")"
UPDATER_UTC_DAY=20260821
sig_day1="$(updater_scheduled_signature deploy-failed)"
send_real_alert "$sig_day1"
send_real_alert "$sig_day1"
UPDATER_UTC_DAY=20260822
sig_day2="$(updater_scheduled_signature deploy-failed)"
send_real_alert "$sig_day2"
all_receipts="$(sqlite3 "$FLYWHEEL_CLAIMS_DB" "select count(*) from alert_deliveries where state='sent';")"
if [ "$urgent_receipts" = 2 ] && [ "$all_receipts" = 4 ] \
  && [ "$sig_same" != "$sig_other" ] && [ "$sig_day1" != "$sig_day2" ]; then
  pass "real lead-alert dedups one urgent ticket/day and preserves new ticket/day alerts"
else
  fail "real alert dedup drifted (urgent=$urgent_receipts all=$all_receipts sigs=$sig_same/$sig_other/$sig_day1/$sig_day2)"
fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
