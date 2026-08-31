#!/usr/bin/env bash
# FLY-1743: restart/deploy terminal-state and destructive rollback guards.
# shellcheck disable=SC2016 # fixture child shells intentionally expand later
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESTART_SCRIPT="$REPO_ROOT/scripts/restart-services.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1743-restart-consistency.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASSED=0
FAILED=0

pass() { printf '  OK %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL %s\n' "$1"; FAILED=$((FAILED + 1)); }

ROLLBACK_FUNCTION="$TMP_ROOT/rollback-function.sh"
sed -n '/^rollback_and_restart()/,/^}/p' "$RESTART_SCRIPT" > "$ROLLBACK_FUNCTION"
if [[ ! -s "$ROLLBACK_FUNCTION" ]]; then
  fail "restart-services.sh defines rollback_and_restart"
  printf '\nrestart-deploy-consistency: PASSED=%s FAILED=%s\n' "$PASSED" "$FAILED"
  exit 1
fi
pass "restart-services.sh defines rollback_and_restart"

FINALIZER_FUNCTIONS="$TMP_ROOT/finalizer-functions.sh"
awk '
  /^verify_deploy_consistency_on_exit\(\)/ { capture=1 }
  /^restart_on_exit\(\)/ { if (!capture) capture=1; in_finalizer=1 }
  capture { print }
  in_finalizer && /^}/ { exit }
' "$RESTART_SCRIPT" > "$FINALIZER_FUNCTIONS"
if ! grep -q '^restart_on_exit()' "$FINALIZER_FUNCTIONS"; then
  fail "restart-services.sh defines restart_on_exit"
  printf '\nrestart-deploy-consistency: PASSED=%s FAILED=%s\n' "$PASSED" "$FAILED"
  exit 1
fi
pass "restart-services.sh defines restart_on_exit"

printf 'Test: unreadable rollback status refuses reset --hard\n'
case_root="$TMP_ROOT/status-unreadable"
shim_bin="$case_root/bin"
git_calls="$case_root/git-calls.log"
pnpm_calls="$case_root/pnpm-calls.log"
severe_file="$case_root/severe.log"
log_file="$case_root/restart.log"
mkdir -p "$shim_bin" "$case_root/repo"
: > "$git_calls"
: > "$pnpm_calls"
: > "$severe_file"
: > "$log_file"
real_git="$(command -v git)"
cat > "$shim_bin/git" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FLY1743_GIT_CALLS"
for arg in "$@"; do
  if [[ "$arg" == "status" ]]; then
    exit 41
  fi
  if [[ "$arg" == "reset" ]]; then
    exit 0
  fi
done
exec "$FLY1743_REAL_GIT" "$@"
SHIM
chmod +x "$shim_bin/git"

set +e
env \
  PATH="$shim_bin:$PATH" \
  FLY1743_REAL_GIT="$real_git" \
  FLY1743_GIT_CALLS="$git_calls" \
  FLY1743_PNPM_CALLS="$pnpm_calls" \
  FLY1743_SEVERE_FILE="$severe_file" \
  FLY1743_LOG_FILE="$log_file" \
  FLYWHEEL_DIR="$case_root/repo" \
  bash -c '
    set -uo pipefail
    source "$1"
    log() { printf "%s\n" "$*" >> "$FLY1743_LOG_FILE"; }
    alert_severe() { printf "%s|%s|%s\n" "$1" "$2" "$3" >> "$FLY1743_SEVERE_FILE"; }
    alert_warning() { :; }
    pnpm() { printf "%s\n" "$*" >> "$FLY1743_PNPM_CALLS"; return 0; }
    restart_voice_bridge_managed() { return 0; }
    rn_parse_count() { printf "0\n"; }
    restart_bridge=false
    restart_all_leads=false
    RESTART_TERMINAL_REPORTED=false
    CURRENT_HEAD=2222222222222222222222222222222222222222
    rb_rc=0
    rollback_and_restart 1111111111111111111111111111111111111111 || rb_rc=$?
    exit "$rb_rc"
  ' _ "$ROLLBACK_FUNCTION"
status_unreadable_rc=$?
set -e

if (( status_unreadable_rc == 1 )) \
  && grep -q '^rollback-blocked-state-unreadable|' "$severe_file" \
  && ! grep -qE '(^| )reset( |$)' "$git_calls" \
  && [[ ! -s "$pnpm_calls" ]]; then
  pass "git status failure is loud and cannot reach reset or rebuild"
else
  fail "git status failure reached destructive rollback: rc=$status_unreadable_rc git='$(tr '\n' ';' < "$git_calls")' alerts='$(cat "$severe_file")'"
fi

printf 'Test: failed reset stops the voice-style rollback path\n'
case_root="$TMP_ROOT/reset-failed"
shim_bin="$case_root/bin"
git_calls="$case_root/git-calls.log"
pnpm_calls="$case_root/pnpm-calls.log"
severe_file="$case_root/severe.log"
log_file="$case_root/restart.log"
mkdir -p "$shim_bin" "$case_root/repo"
git -C "$case_root/repo" init -q
git -C "$case_root/repo" config user.email fly1743@example.test
git -C "$case_root/repo" config user.name fly1743
printf 'known good\n' > "$case_root/repo/tracked.txt"
git -C "$case_root/repo" add tracked.txt
git -C "$case_root/repo" commit -qm known-good
rollback_sha="$(git -C "$case_root/repo" rev-parse HEAD)"
: > "$git_calls"
: > "$pnpm_calls"
: > "$severe_file"
: > "$log_file"
cat > "$shim_bin/git" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FLY1743_GIT_CALLS"
for arg in "$@"; do
  if [[ "$arg" == "reset" ]]; then
    exit 42
  fi
done
exec "$FLY1743_REAL_GIT" "$@"
SHIM
chmod +x "$shim_bin/git"

set +e
env \
  PATH="$shim_bin:$PATH" \
  FLY1743_REAL_GIT="$real_git" \
  FLY1743_GIT_CALLS="$git_calls" \
  FLY1743_PNPM_CALLS="$pnpm_calls" \
  FLY1743_SEVERE_FILE="$severe_file" \
  FLY1743_LOG_FILE="$log_file" \
  FLYWHEEL_DIR="$case_root/repo" \
  bash -c '
    set -euo pipefail
    source "$1"
    log() { printf "%s\n" "$*" >> "$FLY1743_LOG_FILE"; }
    alert_severe() { printf "%s|%s|%s\n" "$1" "$2" "$3" >> "$FLY1743_SEVERE_FILE"; }
    alert_warning() { :; }
    pnpm() { printf "%s\n" "$*" >> "$FLY1743_PNPM_CALLS"; return 0; }
    restart_voice_bridge_managed() { return 0; }
    rn_parse_count() { printf "0\n"; }
    restart_bridge=false
    restart_all_leads=false
    RESTART_TERMINAL_REPORTED=false
    CURRENT_HEAD=2222222222222222222222222222222222222222
    rb_rc=0
    rollback_and_restart "$2" || rb_rc=$?
    exit "$rb_rc"
  ' _ "$ROLLBACK_FUNCTION" "$rollback_sha"
reset_failed_rc=$?
set -e

if (( reset_failed_rc == 1 )) \
  && grep -q '^rollback-reset-failed|' "$severe_file" \
  && grep -qE '(^| )reset --hard( |$)' "$git_calls" \
  && [[ ! -s "$pnpm_calls" ]]; then
  pass "reset failure is loud and cannot continue to rebuild"
else
  fail "reset failure continued in conditional context: rc=$reset_failed_rc pnpm='$(cat "$pnpm_calls")' alerts='$(cat "$severe_file")'"
fi

run_standard_rollback() {
  local root="$1" rollback_sha="$2"
  env \
    PATH="$root/bin:$PATH" \
    FLY1743_REAL_GIT="$real_git" \
    FLY1743_GIT_CALLS="$root/git-calls.log" \
    FLY1743_PNPM_CALLS="$root/pnpm-calls.log" \
    FLY1743_SEVERE_FILE="$root/severe.log" \
    FLY1743_LOG_FILE="$root/restart.log" \
    FLYWHEEL_DIR="$root/repo" \
    bash -c '
      set -euo pipefail
      source "$1"
      log() { printf "%s\n" "$*" >> "$FLY1743_LOG_FILE"; }
      alert_severe() { printf "%s|%s|%s\n" "$1" "$2" "$3" >> "$FLY1743_SEVERE_FILE"; }
      alert_warning() { :; }
      pnpm() { printf "%s\n" "$*" >> "$FLY1743_PNPM_CALLS"; return 0; }
      restart_voice_bridge_managed() { return 0; }
      rn_parse_count() { printf "0\n"; }
      restart_bridge=false
      restart_all_leads=false
      RESTART_TERMINAL_REPORTED=false
      CURRENT_HEAD=2222222222222222222222222222222222222222
      rb_rc=0
      rollback_and_restart "$2" || rb_rc=$?
      exit "$rb_rc"
    ' _ "$ROLLBACK_FUNCTION" "$rollback_sha"
}

setup_standard_rollback_repo() {
  local root="$1"
  mkdir -p "$root/bin" "$root/repo"
  git -C "$root/repo" init -q
  git -C "$root/repo" config user.email fly1743@example.test
  git -C "$root/repo" config user.name fly1743
  printf 'known good\n' > "$root/repo/tracked.txt"
  git -C "$root/repo" add tracked.txt
  git -C "$root/repo" commit -qm known-good
  : > "$root/git-calls.log"
  : > "$root/pnpm-calls.log"
  : > "$root/severe.log"
  : > "$root/restart.log"
  cat > "$root/bin/git" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FLY1743_GIT_CALLS"
exec "$FLY1743_REAL_GIT" "$@"
SHIM
  chmod +x "$root/bin/git"
}

printf 'Test: clean rollback still resets and rebuilds normally\n'
case_root="$TMP_ROOT/clean-success"
setup_standard_rollback_repo "$case_root"
rollback_sha="$(git -C "$case_root/repo" rev-parse HEAD)"
set +e
run_standard_rollback "$case_root" "$rollback_sha"
clean_success_rc=$?
set -e
reset_count="$(grep -cE '(^| )reset --hard( |$)' "$case_root/git-calls.log" || true)"
if (( clean_success_rc == 0 )) \
  && [[ "$reset_count" == "1" ]] \
  && [[ ! -s "$case_root/severe.log" ]] \
  && [[ "$(wc -l < "$case_root/pnpm-calls.log" | tr -d ' ')" == "2" ]]; then
  pass "clean rollback keeps its successful reset and rebuild behavior"
else
  fail "clean rollback regressed: rc=$clean_success_rc resets=$reset_count alerts='$(cat "$case_root/severe.log")'"
fi

printf 'Test: tracked dirt keeps the existing rollback refusal\n'
case_root="$TMP_ROOT/dirty-refusal"
setup_standard_rollback_repo "$case_root"
rollback_sha="$(git -C "$case_root/repo" rev-parse HEAD)"
printf 'operator edit\n' >> "$case_root/repo/tracked.txt"
dirty_bytes="$(git -C "$case_root/repo" diff -- tracked.txt)"
set +e
run_standard_rollback "$case_root" "$rollback_sha"
dirty_rc=$?
set -e
if (( dirty_rc == 1 )) \
  && grep -q '^rollback-blocked-dirty|' "$case_root/severe.log" \
  && ! grep -q '^rollback-blocked-state-unreadable|' "$case_root/severe.log" \
  && ! grep -qE '(^| )reset( |$)' "$case_root/git-calls.log" \
  && [[ ! -s "$case_root/pnpm-calls.log" ]] \
  && [[ "$(git -C "$case_root/repo" diff -- tracked.txt)" == "$dirty_bytes" ]]; then
  pass "tracked dirt remains byte-preserving and distinctly fail-loud"
else
  fail "dirty rollback behavior regressed: rc=$dirty_rc git='$(tr '\n' ';' < "$case_root/git-calls.log")' alerts='$(cat "$case_root/severe.log")'"
fi

printf 'Test: armed mismatched terminal state emits its dedicated alert\n'
case_root="$TMP_ROOT/mismatch-existing-failure"
mkdir -p "$case_root/repo" "$case_root/home/.flywheel"
git -C "$case_root/repo" init -q
git -C "$case_root/repo" config user.email fly1743@example.test
git -C "$case_root/repo" config user.name fly1743
printf 'new source\n' > "$case_root/repo/tracked.txt"
git -C "$case_root/repo" add tracked.txt
git -C "$case_root/repo" commit -qm source-head
source_head="$(git -C "$case_root/repo" rev-parse HEAD)"
deployed_sha="1111111111111111111111111111111111111111"
printf '%s\n' "$deployed_sha" > "$case_root/home/.flywheel/deployed-sha"
: > "$case_root/severe.log"
: > "$case_root/bodies.log"
set +e
env \
  FLY1743_SEVERE_FILE="$case_root/severe.log" \
  FLY1743_BODY_FILE="$case_root/bodies.log" \
  FLYWHEEL_DIR="$case_root/repo" \
  DEPLOYED_SHA_FILE="$case_root/home/.flywheel/deployed-sha" \
  bash -c '
    set -uo pipefail
    source "$1"
    log() { :; }
    alert_warning() { :; }
    alert_severe() {
      printf "%s|%s\n" "$1" "$2" >> "$FLY1743_SEVERE_FILE"
      printf "%s\n" "$3" >> "$FLY1743_BODY_FILE"
    }
    RESTART_NOTICE_STARTED=false
    RESTART_TERMINAL_REPORTED=true
    RESTART_EXIT_SIGNAL=""
    DEPLOY_CONSISTENCY_ARMED=true
    DRY_RUN=false
    LOCK_DIR="$2/lock"
    PROJECT_SHA_UPDATES_FILE=""
    LEAD_RESTART_NAMES_FILE=""
    RESTART_TRANSIENT_FILES=""
    restart_on_exit 1
  ' _ "$FINALIZER_FUNCTIONS" "$case_root"
mismatch_existing_rc=$?
set -e

if (( mismatch_existing_rc == 1 )) \
  && grep -q '^restart-source-deployed-mismatch|' "$case_root/severe.log" \
  && grep -Fq "${source_head:0:7}" "$case_root/bodies.log" \
  && grep -Fq "${deployed_sha:0:7}" "$case_root/bodies.log"; then
  pass "an existing nonzero failure keeps rc=1 and separately reports inconsistent end state"
else
  fail "armed mismatch stayed silent: rc=$mismatch_existing_rc alerts='$(cat "$case_root/severe.log")'"
fi

printf 'Test: armed mismatch upgrades an otherwise-zero exit to rc=1\n'
: > "$case_root/severe.log"
: > "$case_root/bodies.log"
set +e
mismatch_zero_output="$(env \
  FLY1743_SEVERE_FILE="$case_root/severe.log" \
  FLY1743_BODY_FILE="$case_root/bodies.log" \
  FLYWHEEL_DIR="$case_root/repo" \
  DEPLOYED_SHA_FILE="$case_root/home/.flywheel/deployed-sha" \
  bash -c '
    set -uo pipefail
    source "$1"
    log() { printf "%s\n" "$*"; }
    alert_warning() { :; }
    alert_severe() {
      printf "%s|%s\n" "$1" "$2" >> "$FLY1743_SEVERE_FILE"
      printf "%s\n" "$3" >> "$FLY1743_BODY_FILE"
    }
    RESTART_NOTICE_STARTED=false
    RESTART_TERMINAL_REPORTED=true
    RESTART_EXIT_SIGNAL=""
    DEPLOY_CONSISTENCY_ARMED=true
    DRY_RUN=false
    LOCK_DIR="$2/lock"
    PROJECT_SHA_UPDATES_FILE=""
    LEAD_RESTART_NAMES_FILE=""
    RESTART_TRANSIENT_FILES=""
    restart_on_exit 0
  ' _ "$FINALIZER_FUNCTIONS" "$case_root" 2>&1)"
mismatch_zero_rc=$?
set -e

if (( mismatch_zero_rc == 1 )) \
  && grep -q '^restart-source-deployed-mismatch|' "$case_root/severe.log" \
  && ! grep -Fq 'numeric argument required' <<< "$mismatch_zero_output"; then
  pass "mismatched success becomes rc=1 without corrupting the exit argument"
else
  fail "mismatched success lacked teeth: rc=$mismatch_zero_rc output='$mismatch_zero_output' alerts='$(cat "$case_root/severe.log")'"
fi

run_consistency_helper() {
  local root="$1" armed="$2" dry_run="$3" deployed_file="$4"
  env \
    PATH="${FLY1743_HELPER_PATH:-$PATH}" \
    FLY1743_SEVERE_FILE="$root/severe.log" \
    FLY1743_BODY_FILE="$root/bodies.log" \
    FLY1743_LOG_FILE="$root/consistency.log" \
    FLYWHEEL_DIR="$root/repo" \
    DEPLOYED_SHA_FILE="$deployed_file" \
    DEPLOY_CONSISTENCY_ARMED="$armed" \
    DRY_RUN="$dry_run" \
    bash -c '
      set -uo pipefail
      source "$1"
      log() { printf "%s\n" "$*" >> "$FLY1743_LOG_FILE"; }
      alert_severe() {
        printf "%s|%s\n" "$1" "$2" >> "$FLY1743_SEVERE_FILE"
        printf "%s\n" "$3" >> "$FLY1743_BODY_FILE"
      }
      verify_deploy_consistency_on_exit
    ' _ "$FINALIZER_FUNCTIONS"
}

reset_helper_captures() {
  local root="$1"
  : > "$root/severe.log"
  : > "$root/bodies.log"
  : > "$root/consistency.log"
}

printf 'Test: converged armed state remains silent\n'
case_root="$TMP_ROOT/mismatch-existing-failure"
printf '%s\n' "$source_head" > "$case_root/home/.flywheel/deployed-sha"
reset_helper_captures "$case_root"
if run_consistency_helper "$case_root" true false "$case_root/home/.flywheel/deployed-sha" \
  && [[ ! -s "$case_root/severe.log" ]]; then
  pass "equal source and deployed SHAs preserve the normal success path"
else
  fail "converged deploy emitted a false alert: $(cat "$case_root/severe.log")"
fi

printf 'Test: pre-arming mismatch remains out of scope\n'
printf '%s\n' "$deployed_sha" > "$case_root/home/.flywheel/deployed-sha"
reset_helper_captures "$case_root"
if run_consistency_helper "$case_root" false false "$case_root/home/.flywheel/deployed-sha" \
  && [[ ! -s "$case_root/severe.log" ]]; then
  pass "unarmed exits do not claim ownership of pre-existing mismatch"
else
  fail "unarmed exit emitted a consistency alert: $(cat "$case_root/severe.log")"
fi

printf 'Test: dry-run mismatch remains side-effect free\n'
reset_helper_captures "$case_root"
if run_consistency_helper "$case_root" true true "$case_root/home/.flywheel/deployed-sha" \
  && [[ ! -s "$case_root/severe.log" ]]; then
  pass "dry-run never pages on an intentionally unmodified ledger"
else
  fail "dry-run emitted a consistency alert: $(cat "$case_root/severe.log")"
fi

printf 'Test: missing or empty deployed ledger is an explicit mismatch\n'
missing_file="$case_root/home/.flywheel/missing-deployed-sha"
reset_helper_captures "$case_root"
set +e
run_consistency_helper "$case_root" true false "$missing_file"
missing_rc=$?
set -e
missing_alert="$(cat "$case_root/severe.log")"
missing_body="$(cat "$case_root/bodies.log")"
empty_file="$case_root/home/.flywheel/empty-deployed-sha"
: > "$empty_file"
reset_helper_captures "$case_root"
set +e
run_consistency_helper "$case_root" true false "$empty_file"
empty_rc=$?
set -e
if (( missing_rc == 1 && empty_rc == 1 )) \
  && grep -q '^restart-source-deployed-mismatch|' <<< "$missing_alert" \
  && grep -Fq 'deployed-sha=`missing`' <<< "$missing_body" \
  && grep -q '^restart-source-deployed-mismatch|' "$case_root/severe.log" \
  && grep -Fq 'deployed-sha=`missing`' "$case_root/bodies.log"; then
  pass "missing and empty ledgers render literal missing and fail nonzero"
else
  fail "missing/empty ledger classification regressed: missing_rc=$missing_rc empty_rc=$empty_rc"
fi

printf 'Test: unreadable source HEAD is unverifiable\n'
bad_root="$TMP_ROOT/head-unreadable"
mkdir -p "$bad_root/repo" "$bad_root/home/.flywheel"
printf '%s\n' "$deployed_sha" > "$bad_root/home/.flywheel/deployed-sha"
reset_helper_captures "$bad_root"
set +e
run_consistency_helper "$bad_root" true false "$bad_root/home/.flywheel/deployed-sha"
head_unreadable_rc=$?
set -e
if (( head_unreadable_rc == 1 )) \
  && grep -q '^restart-deploy-consistency-unverifiable|' "$bad_root/severe.log" \
  && ! grep -q '^restart-source-deployed-mismatch|' "$bad_root/severe.log"; then
  pass "unreadable HEAD fails closed as unverifiable"
else
  fail "unreadable HEAD was misclassified: rc=$head_unreadable_rc alerts='$(cat "$bad_root/severe.log")'"
fi

printf 'Test: unreadable existing deployed ledger is unverifiable\n'
ledger_root="$TMP_ROOT/ledger-unreadable"
mkdir -p "$ledger_root/bin" "$ledger_root/repo" "$ledger_root/home/.flywheel"
git -C "$ledger_root/repo" init -q
git -C "$ledger_root/repo" config user.email fly1743@example.test
git -C "$ledger_root/repo" config user.name fly1743
printf 'source\n' > "$ledger_root/repo/tracked.txt"
git -C "$ledger_root/repo" add tracked.txt
git -C "$ledger_root/repo" commit -qm source
printf '%s\n' "$deployed_sha" > "$ledger_root/home/.flywheel/deployed-sha"
cat > "$ledger_root/bin/cat" <<'SHIM'
#!/usr/bin/env bash
exit 55
SHIM
chmod +x "$ledger_root/bin/cat"
reset_helper_captures "$ledger_root"
set +e
FLY1743_HELPER_PATH="$ledger_root/bin:$PATH" \
  run_consistency_helper "$ledger_root" true false "$ledger_root/home/.flywheel/deployed-sha"
ledger_unreadable_rc=$?
set -e
unset FLY1743_HELPER_PATH
if (( ledger_unreadable_rc == 1 )) \
  && grep -q '^restart-deploy-consistency-unverifiable|' "$ledger_root/severe.log" \
  && ! grep -q '^restart-source-deployed-mismatch|' "$ledger_root/severe.log"; then
  pass "existing unreadable ledger fails closed as unverifiable"
else
  fail "unreadable ledger was misclassified: rc=$ledger_unreadable_rc alerts='$(cat "$ledger_root/severe.log")'"
fi

printf 'Test: deploy consistency is armed across both preflight success shapes\n'
preflight_source="$TMP_ROOT/preflight-source.sh"
sed -n '/^preflight_pull_latest_main()/,/^}/p' "$RESTART_SCRIPT" > "$preflight_source"
preflight_arm_line="$(grep -n 'DEPLOY_CONSISTENCY_ARMED=true' "$preflight_source" | head -1 | cut -d: -f1 || true)"
merge_line="$(grep -n 'merge --ff-only --quiet' "$preflight_source" | head -1 | cut -d: -f1 || true)"
top_level_arm_block="$(awk '
  /preflight_pull_latest_main \|\| exit 1/ { capture=1 }
  capture { print }
  capture && /DEPLOY_CONSISTENCY_ARMED=true/ { found=1 }
  found && /^fi$/ { exit }
' "$RESTART_SCRIPT")"
if [[ "$preflight_arm_line" =~ ^[0-9]+$ && "$merge_line" =~ ^[0-9]+$ ]] \
  && (( preflight_arm_line < merge_line )) \
  && grep -Fq 'if [[ "$DRY_RUN" != "true" ]]' <<< "$top_level_arm_block" \
  && grep -Fq 'DEPLOY_CONSISTENCY_ARMED=true' <<< "$top_level_arm_block"; then
  pass "behind merge is armed before mutation and all real preflight success is armed on return"
else
  fail "deploy-consistency arming has a signal/preflight gap: preflight_arm=${preflight_arm_line:-missing} merge=${merge_line:-missing}"
fi

printf 'Test: signal delivered at the merge return boundary stays fail-loud\n'
signal_root="$TMP_ROOT/merge-signal"
signal_origin="$signal_root/origin.git"
signal_seed="$signal_root/seed"
signal_checkout="$signal_root/checkout"
signal_home="$signal_root/home"
signal_bin="$signal_root/bin"
mkdir -p "$signal_seed" "$signal_home/.flywheel" "$signal_bin"
git init -q --bare "$signal_origin"
git -C "$signal_seed" init -q
git -C "$signal_seed" config user.email fly1743@example.test
git -C "$signal_seed" config user.name fly1743
git -C "$signal_seed" checkout -qb main
printf 'base\n' > "$signal_seed/tracked.txt"
git -C "$signal_seed" add tracked.txt
git -C "$signal_seed" commit -qm base
git -C "$signal_seed" remote add origin "$signal_origin"
git -C "$signal_seed" push -qu origin main
git -C "$signal_origin" symbolic-ref HEAD refs/heads/main
git clone -q "$signal_origin" "$signal_checkout"
signal_old_head="$(git -C "$signal_checkout" rev-parse HEAD)"
printf 'target\n' >> "$signal_seed/tracked.txt"
git -C "$signal_seed" add tracked.txt
git -C "$signal_seed" commit -qm target
git -C "$signal_seed" push -q origin main
signal_target="$(git -C "$signal_seed" rev-parse HEAD)"
printf '%s\n' "$signal_old_head" > "$signal_home/.flywheel/deployed-sha"
: > "$signal_root/severe.log"
: > "$signal_root/bodies.log"
cat > "$signal_bin/git" <<'SHIM'
#!/usr/bin/env bash
is_merge=false
for arg in "$@"; do
  [[ "$arg" == "merge" ]] && is_merge=true
done
if [[ "$is_merge" == "true" ]]; then
  "$FLY1743_REAL_GIT" "$@"
  rc=$?
  if (( rc == 0 )); then
    kill -TERM "$FLY1743_SIGNAL_PID"
  fi
  exit "$rc"
fi
exec "$FLY1743_REAL_GIT" "$@"
SHIM
chmod +x "$signal_bin/git"

set +e
env \
  PATH="$signal_bin:$PATH" \
  FLY1743_REAL_GIT="$real_git" \
  FLY1743_SEVERE_FILE="$signal_root/severe.log" \
  FLY1743_BODY_FILE="$signal_root/bodies.log" \
  FLYWHEEL_DIR="$signal_checkout" \
  DEPLOYED_SHA_FILE="$signal_home/.flywheel/deployed-sha" \
  FLYWHEEL_RESTART_BOUNDED_RUN_BIN="$REPO_ROOT/scripts/lib/bounded-run.sh" \
  bash -c '
    set -uo pipefail
    source "$1"
    source "$2"
    log() { :; }
    alert_warning() { :; }
    alert_severe() {
      printf "%s|%s\n" "$1" "$2" >> "$FLY1743_SEVERE_FILE"
      printf "%s\n" "$3" >> "$FLY1743_BODY_FILE"
    }
    discord_pointer_cutover_required() { return 1; }
    # This fixture isolates the post-merge signal boundary. Dedicated FLY-2190
    # tests exercise the host tmux gate itself.
    restart_host_tmux_gate() { return 0; }
    DEPLOY_CONSISTENCY_ARMED=false
    DRY_RUN=false
    RESTART_NOTICE_STARTED=false
    RESTART_TERMINAL_REPORTED=true
    RESTART_EXIT_SIGNAL=""
    LOCK_DIR="$3/lock"
    PROJECT_SHA_UPDATES_FILE=""
    LEAD_RESTART_NAMES_FILE=""
    RESTART_TRANSIENT_FILES=""
    export FLY1743_SIGNAL_PID="$$"
    trap '\''restart_on_exit "$?"'\'' EXIT
    trap '\''RESTART_EXIT_SIGNAL=TERM; exit 143'\'' TERM
    preflight_pull_latest_main
  ' _ "$preflight_source" "$FINALIZER_FUNCTIONS" "$signal_root"
signal_rc=$?
set -e
if (( signal_rc == 143 )) \
  && [[ "$(git -C "$signal_checkout" rev-parse HEAD)" == "$signal_target" ]] \
  && grep -q '^restart-source-deployed-mismatch|' "$signal_root/severe.log" \
  && grep -Fq "${signal_target:0:7}" "$signal_root/bodies.log" \
  && grep -Fq "${signal_old_head:0:7}" "$signal_root/bodies.log"; then
  pass "TERM at the post-merge boundary preserves rc=143 and reports the inconsistent state"
else
  fail "merge-boundary TERM stayed silent: rc=$signal_rc head=$(git -C "$signal_checkout" rev-parse HEAD) alerts='$(cat "$signal_root/severe.log")'"
fi

printf '\nrestart-deploy-consistency: PASSED=%s FAILED=%s\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
