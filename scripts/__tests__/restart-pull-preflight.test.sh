#!/usr/bin/env bash
# FLY-1729: restart-services must update the production main checkout before
# making any build or service-restart decision.
# shellcheck disable=SC2016 # child-shell/fixture bodies intentionally expand later
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESTART_SCRIPT="$REPO_ROOT/scripts/restart-services.sh"
GUARD_LIB="$REPO_ROOT/scripts/lib/discord-pointer-guard.sh"
BOUNDED_RUN="$REPO_ROOT/scripts/lib/bounded-run.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1729-preflight.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASSED=0
FAILED=0

pass() { printf '  OK %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  FAIL %s\n' "$1"; FAILED=$((FAILED + 1)); }

FUNCTION_FILE="$TMP_ROOT/preflight-function.sh"
sed -n '/^preflight_pull_latest_main()/,/^}/p' "$RESTART_SCRIPT" > "$FUNCTION_FILE"
if [[ ! -s "$FUNCTION_FILE" ]]; then
  fail "restart-services.sh defines preflight_pull_latest_main"
  printf '\nrestart-pull-preflight: PASSED=%s FAILED=%s\n' "$PASSED" "$FAILED"
  exit 1
fi
pass "restart-services.sh defines preflight_pull_latest_main"

setup_repo() {
  local name="$1" root
  root="$TMP_ROOT/$name"
  CASE_ROOT="$root"
  ORIGIN="$root/origin.git"
  SEED="$root/seed"
  CHECKOUT="$root/checkout"
  CASE_HOME="$root/home"
  LOG_FILE="$root/preflight.log"
  SEVERE_FILE="$root/severe.log"
  WARNING_FILE="$root/warning.log"
  CUTOVER_ARG_FILE="$root/cutover-arg.log"
  mkdir -p "$root" "$CASE_HOME/.flywheel/bin"
  git init -q --bare "$ORIGIN"
  git init -q "$SEED"
  git -C "$SEED" config user.email fly1729@example.test
  git -C "$SEED" config user.name fly1729
  git -C "$SEED" checkout -qb main
  mkdir -p "$SEED/packages/teamlead/scripts"
  printf 'base\n' > "$SEED/tracked.txt"
  printf '#!/usr/bin/env bash\n' > "$SEED/packages/teamlead/scripts/claude-lead.sh"
  git -C "$SEED" add .
  git -C "$SEED" commit -qm base
  git -C "$SEED" remote add origin "$ORIGIN"
  git -C "$SEED" push -qu origin main
  git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  git clone -q "$ORIGIN" "$CHECKOUT"
  git -C "$CHECKOUT" config user.email fly1729@example.test
  git -C "$CHECKOUT" config user.name fly1729
  : > "$LOG_FILE"
  : > "$SEVERE_FILE"
  : > "$WARNING_FILE"
  : > "$CUTOVER_ARG_FILE"
}

push_remote_commit() {
  local message="$1" payload="$2"
  printf '%s\n' "$payload" >> "$SEED/tracked.txt"
  git -C "$SEED" add tracked.txt
  git -C "$SEED" commit -qm "$message"
  git -C "$SEED" push -q origin main
  git -C "$SEED" rev-parse HEAD
}

run_preflight() {
  local dry_run="$1" bounded_bin="${2:-$BOUNDED_RUN}"
  env \
    FLYWHEEL_DIR="$CHECKOUT" \
    HOME="$CASE_HOME" \
    DRY_RUN="$dry_run" \
    FLYWHEEL_RESTART_BOUNDED_RUN_BIN="$bounded_bin" \
    PREFLIGHT_TEST_LOG="$LOG_FILE" \
    PREFLIGHT_TEST_SEVERE="$SEVERE_FILE" \
    PREFLIGHT_TEST_WARNING="$WARNING_FILE" \
    PREFLIGHT_TEST_CUTOVER_ARG="$CUTOVER_ARG_FILE" \
    CUTOVER_RC="${CUTOVER_RC:-1}" \
    bash -c '
      set -uo pipefail
      source "$1"
      log() { printf "%s\n" "$*" | tee -a "$PREFLIGHT_TEST_LOG"; }
      alert_severe() { printf "%s|%s|%s\n" "${1:-}" "${2:-}" "${3:-}" >> "$PREFLIGHT_TEST_SEVERE"; }
      alert_warning() { printf "%s|%s|%s\n" "${1:-}" "${2:-}" "${3:-}" >> "$PREFLIGHT_TEST_WARNING"; }
      discord_pointer_cutover_required() {
        printf "%s\n" "${1:-}" >> "$PREFLIGHT_TEST_CUTOVER_ARG"
        return "$CUTOVER_RC"
      }
      # This suite isolates Git preflight behavior. FLY-2190 host-gate behavior
      # is exercised by host-tmux-selection-restart-mounts.test.sh.
      restart_host_tmux_gate() { return 0; }
      preflight_pull_latest_main
    ' _ "$FUNCTION_FILE"
}

assert_no_alerts() {
  [[ ! -s "$SEVERE_FILE" && ! -s "$WARNING_FILE" ]]
}

printf 'Test: behind checkout fast-forwards to the fetched immutable target\n'
setup_repo behind
old_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
target="$(push_remote_commit remote-1 one)"
target="$(push_remote_commit remote-2 two)"
if run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$target" ]] \
  && grep -Fq "pulled ${old_head:0:7} -> ${target:0:7}" "$LOG_FILE" \
  && [[ "$(tail -1 "$CUTOVER_ARG_FILE")" == "$target" ]] \
  && assert_no_alerts; then
  pass "behind checkout reaches origin/main and the guard receives the immutable SHA"
else
  fail "behind checkout did not fast-forward cleanly: $(tail -8 "$LOG_FILE")"
fi

printf 'Test: already-current checkout is a no-op after the safety guard\n'
setup_repo current
before_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
before_reflog="$(git -C "$CHECKOUT" reflog -1 --format=%H%n%gs)"
if run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$before_head" ]] \
  && [[ "$(git -C "$CHECKOUT" reflog -1 --format=%H%n%gs)" == "$before_reflog" ]] \
  && [[ "$(tail -1 "$CUTOVER_ARG_FILE")" == "$before_head" ]] \
  && grep -Fq 'already at origin/main' "$LOG_FILE" \
  && assert_no_alerts; then
  pass "already-current checkout creates no merge/reflog entry"
else
  fail "already-current checkout was not an exact no-op"
fi

printf 'Test: dirty checkout fails loudly without changing HEAD or local bytes\n'
setup_repo dirty
dirty_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
printf 'operator edit\n' >> "$CHECKOUT/tracked.txt"
dirty_bytes="$(git -C "$CHECKOUT" diff -- tracked.txt)"
dirty_output="$(run_preflight false 2>&1)" && dirty_rc=0 || dirty_rc=$?
if (( dirty_rc != 0 )) \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$dirty_head" ]] \
  && [[ "$(git -C "$CHECKOUT" diff -- tracked.txt)" == "$dirty_bytes" ]] \
  && grep -q '^restart-preflight-dirty|' "$SEVERE_FILE" \
  && grep -Fq 'tracked.txt' <<< "$dirty_output" \
  && grep -Fq 'tracked.txt' "$SEVERE_FILE" \
  && [[ "$(wc -l < "$SEVERE_FILE" | tr -d ' ')" == 1 ]] \
  && [[ ! -s "$WARNING_FILE" ]]; then
  pass "tracked dirty checkout is preserved and names the path in stdout and its typed alert"
else
  fail "tracked dirty checkout failure was silent, pathless, or mutated local state"
fi

printf 'Test: unrelated untracked files survive a safe fast-forward\n'
setup_repo untracked-safe
printf 'local operator note\n' > "$CHECKOUT/stray-note.md"
untracked_bytes="$(cat "$CHECKOUT/stray-note.md")"
untracked_target="$(push_remote_commit remote-with-unrelated-change remote)"
if run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$untracked_target" ]] \
  && [[ "$(cat "$CHECKOUT/stray-note.md")" == "$untracked_bytes" ]] \
  && [[ "$(git -C "$CHECKOUT" status --porcelain -- stray-note.md)" == '?? stray-note.md' ]] \
  && assert_no_alerts; then
  pass "unrelated untracked bytes are preserved while main reaches the fetched target"
else
  fail "an unrelated untracked file blocked or was changed by the safe fast-forward"
fi

printf 'Test: an untracked path collision remains fail-loud and byte-preserving\n'
setup_repo untracked-collision
printf 'local collision bytes\n' > "$CHECKOUT/future.txt"
collision_bytes="$(cat "$CHECKOUT/future.txt")"
collision_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
printf 'remote tracked bytes\n' > "$SEED/future.txt"
git -C "$SEED" add future.txt
git -C "$SEED" commit -qm remote-adds-colliding-path
git -C "$SEED" push -q origin main
collision_target="$(git -C "$SEED" rev-parse HEAD)"
collision_output="$(run_preflight false 2>&1)" && collision_rc=0 || collision_rc=$?
if (( collision_rc != 0 )) \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$collision_head" ]] \
  && [[ "$(git -C "$CHECKOUT" rev-parse origin/main)" == "$collision_target" ]] \
  && [[ "$(cat "$CHECKOUT/future.txt")" == "$collision_bytes" ]] \
  && grep -q '^restart-preflight-nonff|' "$SEVERE_FILE" \
  && grep -Fq 'future.txt' <<< "$collision_output" \
  && grep -Fq 'future.txt' "$SEVERE_FILE" \
  && [[ "$(wc -l < "$SEVERE_FILE" | tr -d ' ')" == 1 ]]; then
  pass "merge --ff-only rejects a real untracked collision and names the preserved path"
else
  fail "a real untracked collision was overwritten, misclassified, or pathless"
fi

printf 'Test: fetch updates origin/main even when the checkout has no default fetch refspec\n'
setup_repo explicit-refspec
explicit_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
explicit_target="$(push_remote_commit explicit-fetch-target remote)"
git -C "$CHECKOUT" config --unset-all remote.origin.fetch
if run_preflight false >/dev/null 2>&1 \
  && [[ "$explicit_head" != "$explicit_target" ]] \
  && [[ "$(git -C "$CHECKOUT" rev-parse origin/main)" == "$explicit_target" ]] \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$explicit_target" ]] \
  && assert_no_alerts; then
  pass "explicit fetch refspec makes origin/main authoritative independent of clone config"
else
  fail "fetch succeeded without advancing origin/main to the remote main target"
fi

printf 'Test: wrong branch and detached HEAD cannot be advanced\n'
setup_repo branch
git -C "$CHECKOUT" checkout -qb topic
topic_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
if ! run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$topic_head" ]] \
  && grep -q '^restart-preflight-not-on-main|' "$SEVERE_FILE"; then
  pass "topic branch is rejected without moving its pointer"
else
  fail "topic branch was accepted or moved"
fi
setup_repo detached
detached_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
git -C "$CHECKOUT" checkout -q --detach
if ! run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$detached_head" ]] \
  && grep -q '^restart-preflight-not-on-main|' "$SEVERE_FILE"; then
  pass "detached HEAD is rejected without mutation"
else
  fail "detached HEAD was accepted or moved"
fi

printf 'Test: local-ahead and diverged histories are distinct fail-loud states\n'
setup_repo ahead
printf 'local only\n' >> "$CHECKOUT/tracked.txt"
git -C "$CHECKOUT" add tracked.txt
git -C "$CHECKOUT" commit -qm local-ahead
ahead_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
if ! run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$ahead_head" ]] \
  && grep -q '^restart-preflight-local-ahead|' "$SEVERE_FILE"; then
  pass "local-only commit is never deployed as origin/main"
else
  fail "local-ahead history was not rejected distinctly"
fi
setup_repo diverged
printf 'local fork\n' >> "$CHECKOUT/tracked.txt"
git -C "$CHECKOUT" add tracked.txt
git -C "$CHECKOUT" commit -qm local-fork
diverged_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
push_remote_commit remote-fork remote >/dev/null
if ! run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$diverged_head" ]] \
  && grep -q '^restart-preflight-diverged|' "$SEVERE_FILE"; then
  pass "diverged history is rejected without reset or merge"
else
  fail "diverged history was not rejected distinctly"
fi

printf 'Test: fetch failure is visible and stops before restart decisions\n'
setup_repo fetch-fail
git -C "$CHECKOUT" remote set-url origin "$CASE_ROOT/missing-origin.git"
fetch_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
if ! run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$fetch_head" ]] \
  && grep -q '^restart-preflight-fetch-failed|' "$WARNING_FILE" \
  && [[ ! -s "$SEVERE_FILE" ]]; then
  pass "fetch failure emits one transient warning and leaves HEAD unchanged"
else
  fail "fetch failure was silent, misclassified, or mutated HEAD"
fi

printf 'Test: bounded fetch tooling failures are classified without a hang\n'
setup_repo bounded-missing
missing_runner="$CASE_ROOT/does-not-exist"
if ! run_preflight false "$missing_runner" >/dev/null 2>&1 \
  && grep -q '^restart-preflight-bounded-run-missing|' "$SEVERE_FILE" \
  && [[ ! -s "$WARNING_FILE" ]]; then
  pass "missing bounded runner is a deterministic severe failure"
else
  fail "missing bounded runner was treated as a transient fetch failure"
fi
setup_repo bounded-timeout
timeout_runner="$CASE_ROOT/timeout-bounded"
printf '#!/usr/bin/env bash\nexit 124\n' > "$timeout_runner"
chmod +x "$timeout_runner"
if ! run_preflight false "$timeout_runner" >/dev/null 2>&1 \
  && grep -q '^restart-preflight-fetch-failed|' "$WARNING_FILE" \
  && [[ ! -s "$SEVERE_FILE" ]]; then
  pass "bounded fetch timeout is visible as a transient fetch failure"
else
  fail "bounded fetch timeout was silent or misclassified"
fi

printf 'Test: fetch-window races are rechecked before topology or merge\n'
setup_repo race-dirty
race_target="$(push_remote_commit remote-race remote)"
race_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
race_runner="$CASE_ROOT/race-bounded"
printf '#!/usr/bin/env bash\nshift\n"$@" || exit $?\nprintf "race edit\\n" >> "$RACE_CHECKOUT/tracked.txt"\n' > "$race_runner"
chmod +x "$race_runner"
export RACE_CHECKOUT="$CHECKOUT"
if ! run_preflight false "$race_runner" >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$race_head" ]] \
  && [[ "$(git -C "$CHECKOUT" rev-parse origin/main)" == "$race_target" ]] \
  && grep -q '^restart-preflight-dirty|' "$SEVERE_FILE"; then
  pass "a checkout dirtied during fetch is caught before merge"
else
  fail "fetch-window dirty race escaped the second clean check"
fi
unset RACE_CHECKOUT

setup_repo race-branch
branch_target="$(push_remote_commit remote-branch-race remote)"
branch_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
branch_runner="$CASE_ROOT/branch-race-bounded"
printf '#!/usr/bin/env bash\nshift\n"$@" || exit $?\ngit -C "$RACE_CHECKOUT" checkout -qb topic-during-fetch\n' > "$branch_runner"
chmod +x "$branch_runner"
export RACE_CHECKOUT="$CHECKOUT"
if ! run_preflight false "$branch_runner" >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$branch_head" ]] \
  && [[ "$(git -C "$CHECKOUT" rev-parse origin/main)" == "$branch_target" ]] \
  && [[ "$(git -C "$CHECKOUT" rev-parse topic-during-fetch)" == "$branch_head" ]] \
  && grep -q '^restart-preflight-not-on-main|' "$SEVERE_FILE"; then
  pass "a clean branch switch during fetch cannot advance the topic pointer"
else
  fail "fetch-window branch switch escaped the second branch check"
fi
unset RACE_CHECKOUT

printf 'Test: cutover guard covers behind and already-current targets\n'
setup_repo cutover-behind
cutover_target="$(push_remote_commit selector-coming remote)"
cutover_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
export CUTOVER_RC=0
if ! run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$cutover_head" ]] \
  && [[ "$(tail -1 "$CUTOVER_ARG_FILE")" == "$cutover_target" ]] \
  && grep -q '^restart-preflight-cutover-required|' "$SEVERE_FILE"; then
  pass "cutover requirement blocks a behind checkout before merge"
else
  fail "cutover guard did not block the behind target"
fi
setup_repo cutover-current
cutover_current="$(git -C "$CHECKOUT" rev-parse HEAD)"
if ! run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$cutover_current" ]] \
  && [[ "$(tail -1 "$CUTOVER_ARG_FILE")" == "$cutover_current" ]] \
  && grep -q '^restart-preflight-cutover-required|' "$SEVERE_FILE"; then
  pass "already-current target cannot bypass the cutover guard"
else
  fail "already-current target bypassed the cutover guard"
fi
unset CUTOVER_RC

printf 'Test: dry-run fetches truth, prints the full target SHA, and never merges\n'
setup_repo dry-behind
dry_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
dry_tracking_before="$(git -C "$CHECKOUT" rev-parse origin/main)"
dry_target="$(push_remote_commit dry-target remote)"
if run_preflight true >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$dry_head" ]] \
  && [[ "$dry_tracking_before" != "$dry_target" ]] \
  && [[ "$(git -C "$CHECKOUT" rev-parse origin/main)" == "$dry_target" ]] \
  && grep -Fq "$dry_target" "$LOG_FILE" \
  && grep -Fq 'DRY RUN: would pull' "$LOG_FILE" \
  && assert_no_alerts; then
  pass "dry-run reports the fetched target SHA while leaving HEAD unchanged"
else
  fail "dry-run target report was stale, incomplete, or mutating"
fi

printf 'Test: dry-run failure is explicit but never pages Discord\n'
setup_repo dry-dirty
printf 'operator edit\n' >> "$CHECKOUT/tracked.txt"
if ! run_preflight true >/dev/null 2>&1 \
  && grep -Fq 'PREFLIGHT WOULD FAIL: dirty checkout' "$LOG_FILE" \
  && assert_no_alerts; then
  pass "dry-run dirty failure stays on stdout with zero alerts"
else
  fail "dry-run dirty failure alerted or lacked an explicit reason"
fi

setup_repo dry-ahead
printf 'local dry-run only\n' >> "$CHECKOUT/tracked.txt"
git -C "$CHECKOUT" add tracked.txt
git -C "$CHECKOUT" commit -qm local-dry-ahead
dry_ahead_head="$(git -C "$CHECKOUT" rev-parse HEAD)"
if ! run_preflight true >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$dry_ahead_head" ]] \
  && grep -Fq 'PREFLIGHT WOULD FAIL: local-ahead' "$LOG_FILE" \
  && assert_no_alerts; then
  pass "dry-run classifies local-ahead without merge or alert"
else
  fail "dry-run local-ahead path was not explicit and mutation-free"
fi

printf 'Test: dry-run clean probe does not refresh the Git index\n'
setup_repo dry-index
touch "$CHECKOUT/tracked.txt"
index_before="$(git hash-object "$CHECKOUT/.git/index")"
if run_preflight true >/dev/null 2>&1 \
  && [[ "$(git hash-object "$CHECKOUT/.git/index")" == "$index_before" ]] \
  && assert_no_alerts; then
  pass "GIT_OPTIONAL_LOCKS=0 keeps dry-run index bytes unchanged"
else
  fail "dry-run status refreshed or changed the Git index"
fi

printf 'Test: post-merge hooks cannot smuggle dirty state into the restart\n'
setup_repo postmerge-dirty
postmerge_target="$(push_remote_commit postmerge-target remote)"
cat > "$CHECKOUT/.git/hooks/post-merge" <<'EOF'
#!/usr/bin/env bash
printf 'hook mutation\n' >> tracked.txt
EOF
chmod +x "$CHECKOUT/.git/hooks/post-merge"
if ! run_preflight false >/dev/null 2>&1 \
  && [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" == "$postmerge_target" ]] \
  && [[ -n "$(git -C "$CHECKOUT" status --porcelain)" ]] \
  && grep -q '^restart-preflight-postmerge-dirty|' "$SEVERE_FILE"; then
  pass "post-merge dirty state fails loudly before build/service mutation"
else
  fail "post-merge hook mutation escaped the cleanliness verification"
fi

printf 'Test: shared Discord pointer guard distinguishes unreadable targets\n'
if [[ ! -f "$GUARD_LIB" ]]; then
  fail "shared discord-pointer-guard.sh exists"
else
  setup_repo guard-tristate
  env FLYWHEEL_DIR="$CHECKOUT" HOME="$CASE_HOME" bash -c '
    source "$1"
    discord_pointer_cutover_required deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
  ' _ "$GUARD_LIB" >/dev/null 2>&1
  guard_rc=$?
  if (( guard_rc == 2 )); then
    pass "shared guard returns rc=2 for an unreadable target"
  else
    fail "shared guard collapsed an unreadable target into not-required (rc=$guard_rc)"
  fi

  base_target="$(git -C "$CHECKOUT" rev-parse HEAD)"
  printf '%s\n' 'CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")' \
    > "$CHECKOUT/packages/teamlead/scripts/claude-lead.sh"
  git -C "$CHECKOUT" add packages/teamlead/scripts/claude-lead.sh
  git -C "$CHECKOUT" commit -qm selector-target
  selector_target="$(git -C "$CHECKOUT" rev-parse HEAD)"
  env FLYWHEEL_DIR="$CHECKOUT" HOME="$CASE_HOME" bash -c \
    'source "$1"; discord_pointer_cutover_required "$2"' \
    _ "$GUARD_LIB" "$base_target" >/dev/null 2>&1
  base_rc=$?
  env FLYWHEEL_DIR="$CHECKOUT" HOME="$CASE_HOME" bash -c \
    'source "$1"; discord_pointer_cutover_required "$2"' \
    _ "$GUARD_LIB" "$selector_target" >/dev/null 2>&1
  selector_rc=$?
  if (( base_rc == 1 && selector_rc == 0 )); then
    pass "shared guard follows the supplied immutable target instead of origin/main"
  else
    fail "shared guard ignored its target parameter (base=$base_rc selector=$selector_rc)"
  fi
fi

printf '\nrestart-pull-preflight: PASSED=%s FAILED=%s\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
