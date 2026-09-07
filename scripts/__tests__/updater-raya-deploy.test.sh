#!/usr/bin/env bash
# FLY-2385: hermetic contract for the scheduled Raya deployment pass.
# shellcheck disable=SC2034,SC2329
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/lib/updater-raya-deploy.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2385-raya.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }
expect_eq() {
  local want="$1" got="$2" label="$3"
  if [[ "$got" == "$want" ]]; then pass "$label"; else fail "$label (want=$want got=$got)"; fi
}
read_count() { local value=""; value="$(cat "$1" 2>/dev/null || true)"; printf '%s\n' "${value:-0}"; }

if [[ ! -f "$LIB" ]]; then
  fail "Raya updater source library exists"
  printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
  exit 1
fi

REMOTE="$TMP/raya.git"
SEED="$TMP/seed"
export HOME="$TMP/home"
export FLYWHEEL_HOME="$TMP/flywheel"
export RAYA_HOME="$FLYWHEEL_HOME/raya"
export RAYA_CODE_DIR="$RAYA_HOME/code"
export RAYA_STATE_DIR="$RAYA_HOME/data/state"
export RAYA_METRICS_DIR="$RAYA_HOME/data/metrics"
export RAYA_DEPLOYED_SHA_FILE="$RAYA_HOME/deployed-sha"
export RAYA_DEPLOY_RECEIPT="$RAYA_HOME/deploy-receipt.json"
export RAYA_DEPLOY_LOCK_DIR="$RAYA_HOME/deploy.lock.d"
export RAYA_BRAIN_PID_FILE="$RAYA_METRICS_DIR/run/brain.pid"
export RAYA_VOICE_PID_FILE="$RAYA_METRICS_DIR/run/voice.pid"
export RAYA_PLIST_DIR="$HOME/Library/LaunchAgents"
export UPDATE_FLYWHEEL_SOURCED=1
export RAYA_FETCH_TIMEOUT_SECONDS=20
export RAYA_HEALTH_TRIES=3
export RAYA_HEALTH_INTERVAL_SECONDS=0
export RAYA_SESSION_GRACE_SECONDS=3
export RAYA_SESSION_POLL_SECONDS=1
mkdir -p "$HOME" "$FLYWHEEL_HOME" "$RAYA_HOME" "$RAYA_PLIST_DIR"

git init -q --bare "$REMOTE"
git init -q "$SEED"
git -C "$SEED" config user.email fly2385@example.test
git -C "$SEED" config user.name FLY-2385
git -C "$SEED" checkout -qb main
mkdir -p "$SEED/apps/brain/dist" "$SEED/apps/voice/dist" "$SEED/packages/contracts"
printf 'brain-a\n' > "$SEED/apps/brain/dist/cli.js"
printf 'voice-a\n' > "$SEED/apps/voice/dist/cli.js"
printf 'lock-a\n' > "$SEED/pnpm-lock.yaml"
git -C "$SEED" add .
git -C "$SEED" commit -qm A
SHA_A="$(git -C "$SEED" rev-parse HEAD)"
git -C "$SEED" remote add origin "$REMOTE"
git -C "$SEED" push -q -u origin main
git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/main
git clone -q "$REMOTE" "$RAYA_CODE_DIR"
git -C "$RAYA_CODE_DIR" config user.email fly2385@example.test
git -C "$RAYA_CODE_DIR" config user.name FLY-2385
printf 'brain-b\n' > "$SEED/apps/brain/dist/cli.js"
printf 'voice-b\n' > "$SEED/apps/voice/dist/cli.js"
git -C "$SEED" add .
git -C "$SEED" commit -qm B
SHA_B="$(git -C "$SEED" rev-parse HEAD)"
git -C "$SEED" push -q origin main
git -C "$RAYA_CODE_DIR" fetch -q origin

mkdir -p "$RAYA_METRICS_DIR/run" "$RAYA_STATE_DIR"
printf 'RAYA_HOME=%s\nRAYA_METRICS_DIR=%s\nRAYA_STATE_DIR=%s\nRAYA_DISCORD_TEXT_CHANNEL_ID=test-channel\n' \
  "$RAYA_HOME" "$RAYA_METRICS_DIR" "$RAYA_STATE_DIR" > "$RAYA_HOME/raya.env"

# shellcheck source=/dev/null
source "$LIB"
PRODUCTION_NOTICE_DEFINITION="$(declare -f raya_notify_interruption)"
PRODUCTION_INSTALL_DEFINITION="$(declare -f raya_pnpm_install)"
PRODUCTION_BUILD_DEFINITION="$(declare -f raya_pnpm_build)"

required_functions=(
  raya_configure_runtime_paths raya_host_capable raya_lock_acquire raya_lock_release
  raya_validate_launchd_identity raya_assert_checkout raya_session_active
  raya_write_receipt raya_finish updater_raya_pass
)
for fn in "${required_functions[@]}"; do
  declare -F "$fn" >/dev/null 2>&1 || fail "source library exports $fn"
done

if declare -F raya_run_bounded_in_checkout >/dev/null 2>&1 \
  && [[ "${RAYA_INSTALL_TIMEOUT_SECONDS:-}" =~ ^[1-9][0-9]*$ ]] \
  && [[ "${RAYA_BUILD_TIMEOUT_SECONDS:-}" =~ ^[1-9][0-9]*$ ]] \
  && declare -f raya_pnpm_install | grep -q 'raya_run_bounded_in_checkout.*RAYA_INSTALL_TIMEOUT_SECONDS' \
  && declare -f raya_pnpm_build | grep -q 'raya_run_bounded_in_checkout.*RAYA_BUILD_TIMEOUT_SECONDS'; then
  pass "install and build are bounded while the updater singleton is held"
else
  fail "install or build lacks an explicit bounded-run ceiling"
fi

CALLS="$TMP/calls"
ALERTS="$TMP/alerts"
NOTICES="$TMP/notices"
BUILD_COUNT="$TMP/build-count"
SLEEP_COUNT="$TMP/sleep-count"
FETCH_COUNT="$TMP/fetch-count"
KICK_COUNT="$TMP/kick-count"
LAUNCHD="$TMP/launchd"
mkdir -p "$LAUNCHD"

label_app() { [[ "$1" == com.xrli.raya.brain ]] && printf brain || printf voice; }
write_job() {
  local app="$1" state="$2" pid="$3" start="$4"
  printf '%s\n' "$state" > "$LAUNCHD/$app.state"
  printf '%s\n' "$pid" > "$LAUNCHD/$app.pid"
  printf '%s\n' "$start" > "$LAUNCHD/$app.start"
}
job_state() { cat "$LAUNCHD/$1.state"; }
job_pid() { cat "$LAUNCHD/$1.pid"; }

raya_git() { git -C "$RAYA_CODE_DIR" "$@"; }
raya_git_fetch_bounded() {
  local n=0
  n="$(cat "$FETCH_COUNT" 2>/dev/null || printf 0)"; n=$((n + 1)); printf '%s\n' "$n" > "$FETCH_COUNT"
  if (( n <= ${FETCH_FAIL_UNTIL:-0} )); then return "${FETCH_FAIL_RC:-1}"; fi
  git -C "$RAYA_CODE_DIR" fetch origin '+refs/heads/main:refs/remotes/origin/main' --quiet || return
  if [[ "${FETCH_MUTATE_HEAD:-0}" == 1 ]]; then git -C "$RAYA_CODE_DIR" reset --hard -q "$SHA_B"; fi
}
raya_pnpm_install() { printf 'install|%s\n' "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" >> "$CALLS"; }
raya_pnpm_build() {
  local n=0
  n="$(cat "$BUILD_COUNT" 2>/dev/null || printf 0)"
  n=$((n + 1)); printf '%s\n' "$n" > "$BUILD_COUNT"
  printf 'build|%s\n' "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" >> "$CALLS"
  if [[ "${BUILD_MUTATE_TRACKED:-0}" == 1 ]]; then printf 'operator-byte\n' >> "$RAYA_CODE_DIR/apps/brain/dist/cli.js"; fi
  if [[ "${BUILD_BUMP_BRAIN:-0}" == 1 ]]; then write_job brain running 777 start-777; fi
  if [[ "${BUILD_STOP_VOICE:-0}" == 1 ]]; then write_job voice exited 200 start-200; rm -f "$RAYA_STATE_DIR/voice-mode.requested"; fi
  if [[ "${BUILD_DROP_VOICE:-0}" == 1 ]]; then write_job voice exited 200 start-200; touch "$RAYA_STATE_DIR/voice-mode.requested"; fi
  case ",${BUILD_FAIL_AT:-0}," in *",$n,"*) return 1 ;; esac
  return 0
}
raya_preflight() { printf 'preflight\n' >> "$CALLS"; [[ "${PREFLIGHT_FAIL:-0}" != 1 ]]; }
raya_launchd_print() {
  local label="$1" app state pid program cwd env_file
  app="$(label_app "$label")"; state="$(job_state "$app")"; pid="$(job_pid "$app")"
  [[ "$state" != unloaded ]] || return 1
  program="${JOB_PROGRAM:-/bin/sh}"; [[ "$app" != voice || -z "${JOB_PROGRAM_VOICE:-}" ]] || program="$JOB_PROGRAM_VOICE"
  cwd="${JOB_CWD:-${JOB_CODE_DIR:-$RAYA_CODE_DIR}}"
  env_file="${JOB_ENV_FILE:-${JOB_RAYA_HOME:-$RAYA_HOME}/raya.env}"
  if [[ -n "${JOB_ENV_DECOY:-}" ]]; then
    printf 'inherited environment = {\n\tRAYA_ENV_FILE => %s\n}\n' "$JOB_ENV_DECOY"
  fi
  printf 'path = gui/501/%s\nstate = %s\nprogram = %s\narguments = {\n\t%s\n\t%s/apps/%s/dist/cli.js\n\trun\n' \
    "$label" "$state" "$program" "$program" "${JOB_CODE_DIR:-$RAYA_CODE_DIR}" "$app"
  [[ "${JOB_ARG_EXTRA:-0}" != 1 ]] || printf '\textra\n'
  printf '}\nworking directory = %s\nenvironment = {\n\tRAYA_ENV_FILE => %s\n}\n' "$cwd" "$env_file"
  [[ "$state" != running || "${JOB_NO_PID_APP:-}" == "$app" ]] || printf 'pid = %s\n' "$pid"
}
raya_plist_program_arguments() {
  local app; app="$(label_app "$1")"
  jq -nc --arg p "${PLIST_PROGRAM:-${JOB_PROGRAM:-/bin/sh}}" \
    --arg e "${PLIST_CODE_DIR:-${JOB_CODE_DIR:-$RAYA_CODE_DIR}}/apps/$app/dist/cli.js" \
    '[ $p, $e, "run" ]'
}
raya_process_start() {
  local pid="$1" app
  if [[ "$pid" == "$$" ]]; then printf 'updater-start\n'; return; fi
  for app in brain voice; do
    [[ "$(job_pid "$app")" != "$pid" ]] || { cat "$LAUNCHD/$app.start"; return; }
  done
  return 1
}
raya_kickstart() {
  local app old new count=0
  app="$(label_app "$1")"; old="$(job_pid "$app")"; new=$((old + 100))
  count="$(cat "$KICK_COUNT" 2>/dev/null || printf 0)"; count=$((count + 1)); printf '%s\n' "$count" > "$KICK_COUNT"
  printf 'kick|%s\n' "$app" >> "$CALLS"
  [[ "${KICK_FAIL_APP:-}" != "$app" && "${KICK_FAIL_AT:-0}" != "$count" ]] || return 1
  write_job "$app" running "$new" "start-$new"
  [[ "$app" == brain ]] && printf '%s\n' "$new" > "$RAYA_BRAIN_PID_FILE"
  [[ "$app" == voice ]] && printf '%s\n' "$new" > "$RAYA_VOICE_PID_FILE"
  if [[ "${KICK_EXIT_AT:-0}" == "$count" ]]; then write_job "$app" exited "$new" "start-$new"; fi
  if [[ "${VOICE_START_AFTER_BRAIN_KICK:-0}" == 1 && "$app" == brain ]]; then
    write_job voice running 250 start-250
    printf '250\n' > "$RAYA_VOICE_PID_FILE"
  fi
  if [[ "${MUTATE_AFTER_BRAIN_KICK:-0}" == 1 && "$app" == brain ]]; then
    printf 'late-operator-byte\n' >> "$RAYA_CODE_DIR/apps/brain/dist/cli.js"
  fi
  return 0
}
raya_sleep() {
  local n=0
  [[ "$1" != 0 ]] || return 0
  n="$(cat "$SLEEP_COUNT" 2>/dev/null || printf 0)"; n=$((n + 1)); printf '%s\n' "$n" > "$SLEEP_COUNT"
  if [[ "${SESSION_CLEAR_AFTER:-0}" == "$n" ]]; then rm -f "$RAYA_STATE_DIR/voice-mode.requested"; write_job voice exited 200 start-200; fi
}
raya_now() { printf '%s\n' "${FAKE_NOW:-2000000000}"; }
raya_alert() { printf '%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" >> "$ALERTS"; }
raya_notify_interruption() { printf '%s\n' "$1" >> "$NOTICES"; [[ "${NOTICE_FAIL:-0}" != 1 ]]; }

reset_case() {
  local head="${1:-$SHA_A}" target="${2:-$SHA_A}"
  git --git-dir="$REMOTE" update-ref refs/heads/main "$target"
  git -C "$RAYA_CODE_DIR" reset --hard -q "$head"
  git -C "$RAYA_CODE_DIR" checkout -q main
  git -C "$RAYA_CODE_DIR" clean -fdq
  git -C "$RAYA_CODE_DIR" update-ref refs/remotes/origin/main "$target"
  rm -rf "$RAYA_DEPLOY_LOCK_DIR" "$RAYA_DEPLOYED_SHA_FILE" "$RAYA_DEPLOY_RECEIPT" \
    "$RAYA_STATE_DIR/voice-mode.requested" "$RAYA_STATE_DIR/meeting.json"
  mkdir -p "$RAYA_METRICS_DIR/run" "$RAYA_STATE_DIR"
  printf 'RAYA_HOME=%s\nRAYA_METRICS_DIR=%s\nRAYA_STATE_DIR=%s\nRAYA_DISCORD_TEXT_CHANNEL_ID=test-channel\n' \
    "$RAYA_HOME" "$RAYA_METRICS_DIR" "$RAYA_STATE_DIR" > "$RAYA_HOME/raya.env"
  : > "$CALLS"; : > "$ALERTS"; : > "$NOTICES"; : > "$BUILD_COUNT"; : > "$SLEEP_COUNT"
  : > "$FETCH_COUNT"; : > "$KICK_COUNT"
  write_job brain running 100 start-100
  write_job voice exited 200 start-200
  printf '100\n' > "$RAYA_BRAIN_PID_FILE"
  rm -f "$RAYA_VOICE_PID_FILE"
  JOB_PROGRAM=/bin/sh JOB_PROGRAM_VOICE="" JOB_CODE_DIR="$RAYA_CODE_DIR" JOB_RAYA_HOME="$RAYA_HOME"
  JOB_CWD="" JOB_ENV_FILE="" JOB_ENV_DECOY="" JOB_ARG_EXTRA=0 JOB_NO_PID_APP=""
  PLIST_PROGRAM=/bin/sh PLIST_CODE_DIR="$RAYA_CODE_DIR"
  BUILD_FAIL_AT=0 BUILD_MUTATE_TRACKED=0 BUILD_BUMP_BRAIN=0 BUILD_STOP_VOICE=0 BUILD_DROP_VOICE=0
  PREFLIGHT_FAIL=0 KICK_FAIL_APP="" KICK_FAIL_AT=0 KICK_EXIT_AT=0 NOTICE_FAIL=0 SESSION_CLEAR_AFTER=0
  VOICE_START_AFTER_BRAIN_KICK=0
  MUTATE_AFTER_BRAIN_KICK=0
  FETCH_FAIL_UNTIL=0 FETCH_FAIL_RC=1 FETCH_MUTATE_HEAD=0
  FAKE_NOW=2000000000
  RAYA_LOCK_OWNED=0 RAYA_DEPLOY_STATE="" RAYA_DEPLOY_DETAIL=""
  RAYA_CHECKOUT_BEFORE="" RAYA_TARGET="" RAYA_ROLLBACK_SHA="" RAYA_LEDGER_STATE=""
}

run_pass() {
  if [[ "${RAYA_TEST_TRACE:-0}" == 1 ]]; then updater_raya_pass; else updater_raya_pass >/dev/null 2>&1; fi
}

reset_case "$SHA_A" "$SHA_A"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
run_pass; rc=$?
expect_eq 0 "$rc" "current checkout succeeds"
expect_eq current "$RAYA_DEPLOY_STATE" "current checkout records current state"
expect_eq 0 "$(grep -c '^kick|' "$CALLS" || true)" "current checkout does not restart"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
run_pass; rc=$?
expect_eq 0 "$rc" "behind checkout deploys"
expect_eq "$SHA_B" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "behind checkout fast-forwards to origin/main"
expect_eq "$SHA_B" "$(cat "$RAYA_DEPLOYED_SHA_FILE")" "successful deploy advances deployed-sha"
expect_eq deployed "$(jq -r .outcome "$RAYA_DEPLOY_RECEIPT")" "successful deploy writes deployed receipt first"
expect_eq 1 "$(grep -c '^kick|brain$' "$CALLS")" "successful deploy replaces brain"

reset_case "$SHA_B" "$SHA_B"
run_pass; rc=$?
expect_eq 0 "$rc" "missing ledger bootstraps at current origin/main"
expect_eq "$SHA_B" "$(cat "$RAYA_DEPLOYED_SHA_FILE")" "bootstrap writes deployed-sha after verification"

reset_case "$SHA_A" "$SHA_B"
printf 'dirty\n' >> "$RAYA_CODE_DIR/apps/brain/dist/cli.js"
run_pass; rc=$?
expect_eq 1 "$rc" "dirty checkout is refused"
expect_eq dirty "$RAYA_DEPLOY_STATE" "dirty checkout has a distinct state"
expect_eq "$SHA_A" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "dirty refusal does not move HEAD"

reset_case "$SHA_A" "$SHA_B"
printf '  %s \r\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
printf 'dirty\n' >> "$RAYA_CODE_DIR/apps/brain/dist/cli.js"
run_pass; rc=$?
expect_eq "$SHA_A" "$(jq -r .deployed_sha "$RAYA_DEPLOY_RECEIPT")" \
  "refusal receipt normalizes the same deployed anchor used for rollback"

reset_case "$SHA_A" "$SHA_B"
printf 'local\n' > "$RAYA_CODE_DIR/local.txt"
git -C "$RAYA_CODE_DIR" add local.txt
git -C "$RAYA_CODE_DIR" commit -qm local
local_sha="$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)"
run_pass; rc=$?
expect_eq 1 "$rc" "diverged checkout is refused"
expect_eq diverged "$RAYA_DEPLOY_STATE" "diverged checkout has a distinct state"
expect_eq "$local_sha" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "diverged refusal preserves local HEAD"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
BUILD_FAIL_AT=1 run_pass; rc=$?
expect_eq 0 "$rc" "forward build failure rolls back to known-good"
expect_eq rolled_back "$RAYA_DEPLOY_STATE" "known-good rollback is explicit"
expect_eq "$SHA_A" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "rollback restores known-good HEAD"
expect_eq 0 "$(grep -c '^kick|' "$CALLS" || true)" "pre-cutover rollback preserves unchanged process generation"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
export BOUNDED_CALLS="$TMP/bounded.calls"
timeout_runner="$TMP/bounded-timeout.sh"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >> "${BOUNDED_CALLS:?}"' 'exit 124' > "$timeout_runner"
chmod +x "$timeout_runner"
saved_install_definition="$(declare -f raya_pnpm_install)"
eval "$PRODUCTION_INSTALL_DEFINITION"
UPDATER_BOUNDED_RUN="$timeout_runner" run_pass; rc=$?
eval "$saved_install_definition"
expect_eq 3 "$rc" "install timeout fails loud when rollback dependencies cannot be rebuilt"
expect_eq "$SHA_A" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "install timeout leaves checkout on the old head"
expect_eq 0 "$(grep -c '^kick|' "$CALLS" || true)" "install timeout never restarts a Raya service"
expect_eq "600 pnpm install --frozen-lockfile" "$(sed -n '1p' "$BOUNDED_CALLS")" \
  "install timeout uses the explicit production ceiling"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
: > "$BOUNDED_CALLS"
saved_build_definition="$(declare -f raya_pnpm_build)"
eval "$PRODUCTION_BUILD_DEFINITION"
UPDATER_BOUNDED_RUN="$timeout_runner" run_pass; rc=$?
eval "$saved_build_definition"
expect_eq 3 "$rc" "build timeout fails loud when rollback dependencies cannot be rebuilt"
expect_eq "$SHA_A" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "build timeout leaves checkout on the old head"
expect_eq 0 "$(grep -c '^kick|' "$CALLS" || true)" "build timeout never restarts a Raya service"
expect_eq "600 pnpm build" "$(sed -n '1p' "$BOUNDED_CALLS")" \
  "build timeout uses the explicit production ceiling"

reset_case "$SHA_A" "$SHA_B"
BUILD_FAIL_AT=1 run_pass; rc=$?
expect_eq 3 "$rc" "bootstrap build failure is terminal without a reset anchor"
expect_eq failed "$RAYA_DEPLOY_STATE" "no-known-good failure is explicit"
expect_eq "$SHA_B" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "no-known-good failure never guesses a reset target"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
write_job voice running 200 start-200
printf '200\n' > "$RAYA_VOICE_PID_FILE"
run_pass; rc=$?
expect_eq 0 "$rc" "running voice deploy succeeds"
expect_eq 1 "$(grep -c '^kick|voice$' "$CALLS")" "voice running at cutover is replaced"
expect_eq replaced "$(jq -r .voice "$RAYA_DEPLOY_RECEIPT")" "voice replacement is receipted"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
JOB_CODE_DIR="$TMP/wrong-worktree"
run_pass; rc=$?
expect_eq 1 "$rc" "launchd worktree drift is refused"
expect_eq identity_drift "$RAYA_DEPLOY_STATE" "identity drift has a distinct state"
expect_eq 0 "$(grep -c '^install|' "$CALLS" || true)" "identity drift refuses before checkout build"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
JOB_ENV_DECOY="$TMP/inherited-debug.env" run_pass; rc=$?
expect_eq 0 "$rc" "job identity ignores inherited launchd environment decoys"
expect_eq deployed "$RAYA_DEPLOY_STATE" "job environment block remains the identity authority"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
touch "$RAYA_STATE_DIR/voice-mode.requested"
write_job voice running 200 start-200
printf '200\n' > "$RAYA_VOICE_PID_FILE"
SESSION_CLEAR_AFTER=2 run_pass; rc=$?
expect_eq 0 "$rc" "active session waits before mutation then deploys"
expect_eq 2 "$(cat "$SLEEP_COUNT")" "session grace polls until the session clears"
expect_eq 0 "$(wc -l < "$NOTICES" | tr -d ' ')" "cleared session is not sent an interruption notice"

# Lock ownership is pid+start bound: live/uninspectable owners stay put, while
# dead or reused pids are reclaimable. Only this process may release its lock.
reset_case
mkdir -p "$RAYA_DEPLOY_LOCK_DIR"
printf '%s\nupdater-start\n1\n' "$$" > "$TMP/lock-lines"
sed -n '1p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/pid"
sed -n '2p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/start"
sed -n '3p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/created"
raya_lock_acquire; lock_rc=$?
expect_eq 75 "$lock_rc" "live pid+start lock is never reclaimed"
expect_eq live "${RAYA_LOCK_FAILURE:-}" "live lock contention is classified separately"
printf 'different-start\n' > "$RAYA_DEPLOY_LOCK_DIR/start"
raya_lock_acquire; lock_rc=$?
expect_eq 0 "$lock_rc" "pid reuse with a different start is reclaimed"
raya_lock_release

reset_case
mkdir -p "$RAYA_DEPLOY_LOCK_DIR"
printf '%s\nupdater-start\n1\n' "$$" > "$TMP/lock-lines"
sed -n '1p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/pid"
sed -n '2p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/start"
sed -n '3p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/created"
saved_process_start="$(declare -f raya_process_start)"
raya_process_start() { return 1; }
raya_lock_acquire; lock_rc=$?
eval "$saved_process_start"
expect_eq 75 "$lock_rc" "live owner with unreadable start is never reclaimed"

reset_case
saved_lock_writer="$(declare -f raya_lock_write_owner)"
raya_lock_write_owner() { return 1; }
raya_lock_acquire; lock_rc=$?
eval "$saved_lock_writer"
expect_eq 75 "$lock_rc" "lock owner write failure is fail closed"
expect_eq state "${RAYA_LOCK_FAILURE:-}" "lock owner write failure has a distinct alert class"
expect_eq no "$([[ -e "$RAYA_DEPLOY_LOCK_DIR" ]] && printf yes || printf no)" "failed lock initialization leaves no ownerless lock"

reset_case
saved_raya_home_for_lock="$RAYA_HOME"
saved_raya_lock_for_home="$RAYA_DEPLOY_LOCK_DIR"
blocked_raya_home="$TMP/raya-home-file"
printf 'not-a-directory\n' > "$blocked_raya_home"
RAYA_HOME="$blocked_raya_home/child"
RAYA_DEPLOY_LOCK_DIR="$RAYA_HOME/deploy.lock.d"
run_pass; rc=$?
expect_eq 1 "$rc" "unwritable Raya home refuses the deploy pass"
expect_eq home-unwritable "$RAYA_DEPLOY_DETAIL" "Raya home initialization failure is not reported as lock contention"
expect_eq 1 "$(grep -c 'raya-home-unwritable' "$ALERTS" || true)" "Raya home initialization failure has a distinct alert class"
RAYA_HOME="$saved_raya_home_for_lock"
RAYA_DEPLOY_LOCK_DIR="$saved_raya_lock_for_home"

reset_case
mkdir -p "$RAYA_DEPLOY_LOCK_DIR"
printf '99999999\ndead-start\n1\n' > "$TMP/lock-lines"
sed -n '1p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/pid"
sed -n '2p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/start"
sed -n '3p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/created"
raya_lock_acquire; lock_rc=$?
expect_eq 0 "$lock_rc" "dead lock owner is reclaimed"
raya_lock_release

reset_case
mkdir -p "$RAYA_DEPLOY_LOCK_DIR"
printf '99999999\nforeign-start\n1\n' > "$TMP/lock-lines"
sed -n '1p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/pid"
sed -n '2p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/start"
sed -n '3p' "$TMP/lock-lines" > "$RAYA_DEPLOY_LOCK_DIR/created"
RAYA_LOCK_OWNED=1
raya_lock_release
expect_eq yes "$([[ -e "$RAYA_DEPLOY_LOCK_DIR" ]] && printf yes || printf no)" "lock release never removes a foreign owner"

reset_case "$SHA_A" "$SHA_B"
FETCH_FAIL_UNTIL=3 run_pass; rc=$?
expect_eq 2 "$rc" "three failed Raya fetch attempts are reported"
expect_eq 3 "$(cat "$FETCH_COUNT")" "Raya fetch retries exactly three times"
expect_eq fetch_failed "$RAYA_DEPLOY_STATE" "fetch failure has a distinct state"

reset_case "$SHA_A" "$SHA_B"
git -C "$RAYA_CODE_DIR" checkout -qb other
run_pass; rc=$?
expect_eq wrong_branch "$RAYA_DEPLOY_STATE" "non-main branch is refused before fetch"
expect_eq 0 "$(read_count "$FETCH_COUNT")" "wrong branch performs zero network work"

reset_case "$SHA_A" "$SHA_B"
git -C "$RAYA_CODE_DIR" checkout -q --detach
run_pass; rc=$?
expect_eq wrong_branch "$RAYA_DEPLOY_STATE" "detached checkout is refused"

reset_case "$SHA_A" "$SHA_B"
git -C "$RAYA_CODE_DIR" remote set-url origin https://example.test/not-raya.git
run_pass; rc=$?
expect_eq remote_mismatch "$RAYA_DEPLOY_STATE" "unexpected origin URL is refused"
expect_eq 0 "$(read_count "$FETCH_COUNT")" "remote mismatch performs zero fetches"
git -C "$RAYA_CODE_DIR" remote set-url origin "$REMOTE"

reset_case "$SHA_B" "$SHA_B"
printf 'not-a-sha\n' > "$RAYA_DEPLOYED_SHA_FILE"
run_pass; rc=$?
expect_eq 0 "$rc" "invalid deployed ledger enters safe bootstrap"
expect_eq invalid "$(jq -r .ledger "$RAYA_DEPLOY_RECEIPT")" "invalid ledger classification is receipted"

reset_case "$SHA_A" "$SHA_B"
printf '  %s \r\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
BUILD_FAIL_AT=1 run_pass; rc=$?
expect_eq 0 "$rc" "deployed ledger tolerates surrounding transport whitespace"
expect_eq rolled_back "$RAYA_DEPLOY_STATE" "trimmed deployed ledger remains the rollback anchor"
expect_eq "$SHA_A" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "trimmed deployed ledger restores known-good HEAD"

reset_case "$SHA_B" "$SHA_B"
printf '%s\n' "$local_sha" > "$RAYA_DEPLOYED_SHA_FILE"
run_pass; rc=$?
expect_eq 0 "$rc" "non-ancestor deployed ledger enters safe bootstrap"
expect_eq not_ancestor "$(jq -r .ledger "$RAYA_DEPLOY_RECEIPT")" "non-ancestor ledger classification is receipted"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
saved_raya_git="$(declare -f raya_git)"
raya_git() {
  if [[ "$1" == merge-base && "$2" == --is-ancestor && "$3" == "$SHA_A" ]]; then return 2; fi
  git -C "$RAYA_CODE_DIR" "$@"
}
run_pass; rc=$?
eval "$saved_raya_git"
expect_eq 1 "$rc" "ledger ancestry probe error refuses deployment"
expect_eq ledger_probe_error "$RAYA_DEPLOY_STATE" "ledger probe error is not downgraded to invalid"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
PREFLIGHT_FAIL=1 run_pass; rc=$?
expect_eq 0 "$rc" "preflight failure rolls back to known-good"
expect_eq rolled_back "$RAYA_DEPLOY_STATE" "preflight is fail closed"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
KICK_EXIT_AT=1 run_pass; rc=$?
expect_eq 0 "$rc" "failed forward brain verification recovers known-good"
expect_eq rolled_back "$RAYA_DEPLOY_STATE" "post-cutover recovery is receipted as rolled_back"
expect_eq 2 "$(grep -c '^kick|brain$' "$CALLS")" "post-cutover recovery replaces brain again on restored bytes"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
KICK_EXIT_AT=1 VOICE_START_AFTER_BRAIN_KICK=1 run_pass; rc=$?
expect_eq 0 "$rc" "failed brain cutover recovers when voice starts during verification"
expect_eq 1 "$(grep -c '^kick|voice$' "$CALLS" || true)" \
  "rollback restarts voice that began after the cutover sample"

reset_case "$SHA_B" "$SHA_B"
write_job voice running 200 start-200
printf '200\n' > "$RAYA_VOICE_PID_FILE"
KICK_EXIT_AT=2 run_pass; rc=$?
expect_eq 3 "$rc" "voice cutover failure without known-good remains failed"
expect_eq 1 "$(grep -c 'raya-deploy-failed-no-known-good' "$ALERTS")" "successful unanchored process recovery remains an unverified-version failure"
expect_eq 2 "$(grep -c '^kick|voice$' "$CALLS")" "unanchored recovery retries a voice that was touched"

reset_case "$SHA_B" "$SHA_B"
write_job voice running 200 start-200
printf '200\n' > "$RAYA_VOICE_PID_FILE"
KICK_FAIL_APP=voice run_pass; rc=$?
expect_eq 3 "$rc" "persistent unanchored voice replacement failure is terminal"
expect_eq 1 "$(grep -c 'raya-voice-down-after-rollback' "$ALERTS")" "persistent unanchored voice failure uses the voice-down severe class"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
BUILD_FAIL_AT=1,2 run_pass; rc=$?
expect_eq 3 "$rc" "rollback rebuild failure is terminal"
expect_eq failed "$RAYA_DEPLOY_STATE" "rollback rebuild failure is explicit"
expect_eq 1 "$(grep -c 'raya-deploy-rollback-failed' "$ALERTS")" "rollback rebuild failure emits its severe class"

for drift in extra cwd env pid program env-config; do
  reset_case "$SHA_A" "$SHA_B"
  printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
  case "$drift" in
    extra) JOB_ARG_EXTRA=1 ;;
    cwd) JOB_CWD="$TMP/wrong-cwd" ;;
    env) JOB_ENV_FILE="$TMP/wrong.env" ;;
    pid) JOB_NO_PID_APP=brain ;;
    program) JOB_PROGRAM_VOICE=/bin/bash ;;
    env-config) printf 'RAYA_HOME=%s\nRAYA_METRICS_DIR=%s\nRAYA_STATE_DIR=%s\n' "$RAYA_HOME" "$TMP/wrong-metrics" "$RAYA_STATE_DIR" > "$RAYA_HOME/raya.env" ;;
  esac
  run_pass; rc=$?
  if [[ "$drift" == pid ]]; then
    expect_eq observe_failed "$RAYA_DEPLOY_STATE" "running launchd job without pid is an observation failure"
    expect_eq "observe_failed:$RAYA_BRAIN_LABEL" "$(jq -r .identity "$RAYA_DEPLOY_RECEIPT")" \
      "observation failure receipt does not claim launchd identity is healthy"
  else
    expect_eq identity_drift "$RAYA_DEPLOY_STATE" "launchd identity drift is rejected: $drift"
  fi
done

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
FETCH_MUTATE_HEAD=1 run_pass; rc=$?
expect_eq 1 "$rc" "concurrent HEAD move during fetch is refused"
expect_eq mutated "$RAYA_DEPLOY_STATE" "post-fetch fence detects concurrent mutation"
expect_eq 0 "$(grep -c '^install|' "$CALLS" || true)" "post-fetch mutation never reaches install"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
BUILD_MUTATE_TRACKED=1 run_pass; rc=$?
expect_eq 3 "$rc" "tracked mutation during build blocks rollback reset"
expect_eq rollback_blocked_mutation "$RAYA_DEPLOY_STATE" "rollback fence preserves concurrent bytes"
if grep -q 'operator-byte' "$RAYA_CODE_DIR/apps/brain/dist/cli.js"; then
  pass "rollback fence preserves the distinguishable concurrent mutation"
else
  fail "rollback fence erased a concurrent tracked mutation"
fi

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
printf '{bad json\n' > "$RAYA_STATE_DIR/meeting.json"
run_pass; rc=$?
expect_eq session_state_unreadable "$RAYA_DEPLOY_STATE" "malformed session state refuses before checkout mutation"
expect_eq "$SHA_A" "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" "malformed session state leaves checkout unchanged"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
jq -n '{status:"scheduled"}' > "$RAYA_STATE_DIR/meeting.json"
run_pass; rc=$?
expect_eq 0 "$(read_count "$SLEEP_COUNT")" "scheduled meeting does not trigger session grace"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
touch "$RAYA_STATE_DIR/voice-mode.requested"
run_pass; rc=$?
expect_eq 0 "$rc" "exhausted session grace proceeds under the Lead ruling"
expect_eq "exhausted:3" "$(jq -r .session_grace "$RAYA_DEPLOY_RECEIPT")" "session grace exhaustion is receipted"
expect_eq 1 "$(wc -l < "$NOTICES" | tr -d ' ')" "active cutover sends one interruption notice"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
saved_receipt_writer="$(declare -f raya_write_receipt)"
raya_write_receipt() { return 1; }
run_pass; rc=$?
eval "$saved_receipt_writer"
expect_eq 3 "$rc" "receipt write failure fails the deployment transaction"
expect_eq "$SHA_A" "$(cat "$RAYA_DEPLOYED_SHA_FILE")" "receipt failure never advances deployed-sha"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
saved_sha_writer="$(declare -f raya_write_deployed_sha)"
raya_write_deployed_sha() { return 1; }
run_pass; rc=$?
eval "$saved_sha_writer"
expect_eq 3 "$rc" "deployed-sha write failure is fail loud"
expect_eq deployed "$(jq -r .outcome "$RAYA_DEPLOY_RECEIPT")" "receipt remains truthful when the later sha write fails"
expect_eq "$SHA_A" "$(cat "$RAYA_DEPLOYED_SHA_FILE")" "failed sha write preserves the previous known-good anchor"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
BUILD_BUMP_BRAIN=1 BUILD_FAIL_AT=1 run_pass; rc=$?
expect_eq 0 "$rc" "pre-cutover process generation change is recovered on restored bytes"
expect_eq replaced "$(jq -r .generation.brain "$RAYA_DEPLOY_RECEIPT")" "brain generation replacement is explicit"
expect_eq 1 "$(grep -c '^kick|brain$' "$CALLS")" "changed brain generation gets one managed replacement"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
write_job voice running 200 start-200
printf '200\n' > "$RAYA_VOICE_PID_FILE"
touch "$RAYA_STATE_DIR/voice-mode.requested"
SESSION_CLEAR_AFTER=1 BUILD_STOP_VOICE=1 BUILD_FAIL_AT=1 run_pass; rc=$?
expect_eq stopped_by_user "$(jq -r .generation.voice "$RAYA_DEPLOY_RECEIPT")" "voice stopped by its user during build is not relaunched"
expect_eq 0 "$(grep -c '^kick|voice$' "$CALLS" || true)" "user-stopped voice remains stopped"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
write_job voice running 200 start-200
printf '200\n' > "$RAYA_VOICE_PID_FILE"
touch "$RAYA_STATE_DIR/voice-mode.requested"
SESSION_CLEAR_AFTER=1 BUILD_DROP_VOICE=1 BUILD_FAIL_AT=1 run_pass; rc=$?
expect_eq recovered "$(jq -r .generation.voice "$RAYA_DEPLOY_RECEIPT")" "desired voice lost during build is recovered from restored bytes"
expect_eq 1 "$(grep -c '^kick|voice$' "$CALLS" || true)" "desired down voice gets one managed recovery"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
write_job brain exited 100 start-100
rm -f "$RAYA_BRAIN_PID_FILE"
run_pass; rc=$?
expect_eq 0 "$rc" "cold brain start is supported"
expect_eq deployed "$RAYA_DEPLOY_STATE" "cold brain is verified before deployment succeeds"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
MUTATE_AFTER_BRAIN_KICK=1 run_pass; rc=$?
expect_eq rollback_blocked_mutation "$RAYA_DEPLOY_STATE" "final ledger fence blocks a post-restart checkout mutation"
expect_eq 1 "$(read_count "$BUILD_COUNT")" "final ledger fence does not reset or rebuild concurrent bytes"

reset_case "$SHA_A" "$SHA_B"
printf '%s\n' "$SHA_A" > "$RAYA_DEPLOYED_SHA_FILE"
BUILD_BUMP_BRAIN=1 run_pass; rc=$?
expect_eq 100 "$(jq -r .gen_before.brain.pid "$RAYA_DEPLOY_RECEIPT")" "receipt preserves the baseline process pid identity"
expect_eq start-100 "$(jq -r .gen_before.brain.start "$RAYA_DEPLOY_RECEIPT")" "receipt preserves the baseline process start identity"
expect_eq 777 "$(jq -r .brain_pid.before "$RAYA_DEPLOY_RECEIPT")" "receipt records the distinct cutover brain pid"
expect_eq 877 "$(jq -r .brain_pid.after "$RAYA_DEPLOY_RECEIPT")" "receipt records the verified replacement brain pid"

saved_observe_job="$(declare -f raya_observe_job)"
saved_health_tries="$RAYA_HEALTH_TRIES"
replacement_samples=0
raya_observe_job() {
  replacement_samples=$((replacement_samples + 1))
  RAYA_OBS_PID=300 RAYA_OBS_START=start-300
  if [[ "$replacement_samples" == 2 ]]; then RAYA_OBS_STATE=exited; else RAYA_OBS_STATE=running; fi
  return 0
}
printf '300\n' > "$RAYA_BRAIN_PID_FILE"
RAYA_HEALTH_TRIES=4
raya_wait_for_replacement brain 100; replacement_rc=$?
eval "$saved_observe_job"
RAYA_HEALTH_TRIES="$saved_health_tries"
expect_eq 0 "$replacement_rc" "replacement verification accepts two adjacent healthy samples"
expect_eq 4 "$replacement_samples" "an unhealthy middle sample resets replacement stability"

saved_sourced="$UPDATE_FLYWHEEL_SOURCED"
saved_raya_home="$RAYA_HOME"
UPDATE_FLYWHEEL_SOURCED=0
RAYA_HOME="$TMP/diverted-raya"
RAYA_CODE_DIR="$TMP/diverted-code"
raya_configure_runtime_paths
expect_eq "$FLYWHEEL_HOME/raya" "$RAYA_HOME" "production pins Raya state under the updater home"
expect_eq "$FLYWHEEL_HOME/raya/code" "$RAYA_CODE_DIR" "production refuses a diverted Raya checkout"
UPDATE_FLYWHEEL_SOURCED="$saved_sourced"
RAYA_HOME="$saved_raya_home"
raya_configure_runtime_paths

eval "$PRODUCTION_NOTICE_DEFINITION"
NOTICE_CURL_ARGS="$TMP/notice-curl.args"
NOTICE_CURL_STDIN="$TMP/notice-curl.stdin"
curl() { printf '%s\n' "$*" > "$NOTICE_CURL_ARGS"; sed -n '1,3p' > "$NOTICE_CURL_STDIN"; }
export CLAUDE_INFRA_BOT_TOKEN=not-on-argv
# shellcheck disable=SC2218
raya_notify_interruption abcdef12; notice_rc=$?
expect_eq 0 "$notice_rc" "production interruption notice uses the configured Raya channel"
if ! grep -q 'not-on-argv' "$NOTICE_CURL_ARGS" \
  && grep -q 'channels/test-channel/messages' "$NOTICE_CURL_ARGS" \
  && grep -q 'not-on-argv' "$NOTICE_CURL_STDIN"; then
  pass "interruption token travels through curl stdin configuration only"
else
  fail "interruption notification leaked its token or used the wrong endpoint"
fi
raya_notify_interruption() { printf '%s\n' "$1" >> "$NOTICES"; [[ "${NOTICE_FAIL:-0}" != 1 ]]; }

receipt_keys='["brain_pid","checked_at","checkout_before","deployed_sha","failure","gen_before","generation","head","identity","interrupt_notice","ledger","node_bin","origin_main","outcome","preflight_rc","rollback_sha","schemaVersion","session_at_cutover","session_grace","state","voice","voice_pid"]'
if jq -e --argjson expected "$receipt_keys" 'keys == $expected' "$RAYA_DEPLOY_RECEIPT" >/dev/null; then
  pass "receipt schema has the pinned key set"
else
  fail "receipt schema drifted: $(jq -c keys "$RAYA_DEPLOY_RECEIPT" 2>/dev/null)"
fi

reset_guard='pkill|kill -9|bootout|bootstrap|launchctl[[:space:]]+load|reset --hard "?\$\{?RAYA_(NEW_HEAD|TARGET|CHECKOUT_BEFORE)'
if printf '%s\n' 'raya_git reset --hard "$RAYA_TARGET"' | rg -q "$reset_guard"; then
  pass "reset guard recognizes the real transaction variable names"
else
  fail "reset guard misses a reset through a real transaction variable"
fi
if ! rg -n "$reset_guard" "$LIB"; then
  pass "library contains no unmanaged process or unverified reset escape hatch"
else
  fail "library contains a forbidden process/reset primitive"
fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
