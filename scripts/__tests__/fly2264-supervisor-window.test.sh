#!/usr/bin/env bash
# FLY-2274: hermetic supervisor manifest / recovery window tests.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GENERATOR="$ROOT/scripts/cutover/FLY-2264/generate-supervisor-labels.sh"
SAMPLE="$ROOT/scripts/cutover/FLY-2264/supervisor-labels.txt"
TMP="$(mktemp -d -t fly2264-supervisors.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }

make_plist() {
  local dir="$1" filename_label="$2" plist_label="${3:-$2}"
  python3 - "$dir/${filename_label}.plist" "$plist_label" <<'PY'
import plistlib, sys
with open(sys.argv[1], "wb") as handle:
    plistlib.dump({"Label": sys.argv[2], "ProgramArguments": ["/usr/bin/true"]}, handle)
PY
}

FIXED_LABELS='com.flywheel.bridge
com.flywheel.bridge-liveness-probe
com.flywheel.cmux-watcher'
LEAD_LABELS='com.flywheel.lead.flywheel-claude-infra-bot-lead
com.flywheel.lead.flywheel-codex-infra-bot-lead
com.flywheel.lead.flywheel-flywheel-cos-lead
com.flywheel.lead.flywheel-flywheel-eng-lead
com.flywheel.lead.flywheel-flywheel-product-lead
com.flywheel.lead.geoforge3d-cos-lead
com.flywheel.lead.geoforge3d-ops-lead
com.flywheel.lead.geoforge3d-product-lead
com.flywheel.lead.growth-mufasa-lead
com.flywheel.lead.growth-rafiki-lead
com.flywheel.lead.growth-reflection-lead
com.flywheel.lead.joycon-typeless-joycon-lead
com.flywheel.lead.personal-assistant-belle-lead
com.flywheel.lead.tidal-echo-sub-lead
com.flywheel.lead.tidal-echo-tidal-echo-content-lead
com.flywheel.lead.tidal-echo-tidal-echo-cos-lead'
EXPECTED="$(printf '%s\n%s\n' "$FIXED_LABELS" "$LEAD_LABELS" | LC_ALL=C sort)"

fixture_dir="$TMP/good"
mkdir -p "$fixture_dir"
while IFS= read -r label; do
  [ -n "$label" ] && make_plist "$fixture_dir" "$label"
done <<EOF
$EXPECTED
EOF
make_plist "$fixture_dir" com.flywheel.updater
make_plist "$fixture_dir" com.flywheel.quota-monitor

echo "Test: generator emits the reviewed 19-label census and reports exclusions"
out=""; err="$TMP/generator.err"; rc=0
out=$("$GENERATOR" "$fixture_dir" 2>"$err") || rc=$?
if [ "$rc" -eq 0 ] \
    && [ "$out" = "$EXPECTED" ] \
    && grep -qF 'excluded: com.flywheel.updater' "$err" \
    && grep -qF 'excluded: com.flywheel.quota-monitor' "$err" \
    && ! printf '%s\n' "$out" | grep -qF 'com.flywheel.updater'; then
  pass "generator separates the exact manifest from exclusion diagnostics"
else
  fail "generator contract rc=$rc out=$out err=$(tr '\n' ' ' <"$err" 2>/dev/null)"
fi

echo "Test: reviewed sample exactly matches the production census"
if [ -f "$SAMPLE" ] && [ "$(cat "$SAMPLE")" = "$EXPECTED" ]; then
  pass "supervisor-labels.txt is the exact sorted 19-label sample"
else
  fail "supervisor-labels.txt missing or stale"
fi

echo "Test: missing fixed labels fail closed"
missing_dir="$TMP/missing"
cp -R "$fixture_dir" "$missing_dir"
rm "$missing_dir/com.flywheel.cmux-watcher.plist"
if "$GENERATOR" "$missing_dir" >"$TMP/missing.out" 2>"$TMP/missing.err"; then
  fail "generator accepted a missing fixed label"
elif grep -qF 'missing required label: com.flywheel.cmux-watcher' "$TMP/missing.err"; then
  pass "missing fixed label is named and rejected"
else
  fail "missing fixed label diagnostic is ambiguous"
fi

echo "Test: filename/Label mismatch and symlink plists fail closed"
mismatch_dir="$TMP/mismatch"
cp -R "$fixture_dir" "$mismatch_dir"
make_plist "$mismatch_dir" com.flywheel.bridge com.flywheel.not-bridge
symlink_dir="$TMP/symlink"
cp -R "$fixture_dir" "$symlink_dir"
rm "$symlink_dir/com.flywheel.bridge.plist"
ln -s "$fixture_dir/com.flywheel.bridge.plist" "$symlink_dir/com.flywheel.bridge.plist"
if "$GENERATOR" "$mismatch_dir" >"$TMP/mismatch.out" 2>"$TMP/mismatch.err"; then
  fail "generator accepted a filename/Label mismatch"
elif ! grep -qF 'label mismatch' "$TMP/mismatch.err"; then
  fail "mismatch diagnostic is ambiguous"
elif "$GENERATOR" "$symlink_dir" >"$TMP/symlink.out" 2>"$TMP/symlink.err"; then
  fail "generator accepted a symlink plist"
elif grep -qF 'symlink plist' "$TMP/symlink.err"; then
  pass "mismatch and symlink plists are rejected"
else
  fail "symlink diagnostic is ambiguous"
fi

BOOTOUT="$ROOT/scripts/cutover/FLY-2264/bootout-supervisors.sh"
RESTORE="$ROOT/scripts/cutover/FLY-2264/restore-supervisors.sh"
WINDOW_HOME="$TMP/window-home"
WINDOW_AGENTS="$WINDOW_HOME/Library/LaunchAgents"
STATE="$TMP/launchctl-state"
CALLS="$TMP/launchctl.calls"
RECOVERY="$TMP/supervisor-recovery.json"
mkdir -p "$WINDOW_AGENTS" "$STATE/loaded" "$TMP/bin"
cp "$fixture_dir"/*.plist "$WINDOW_AGENTS/"
cp "$SAMPLE" "$TMP/supervisor-labels.txt"

cat >"$TMP/bin/launchctl" <<'STUB'
#!/usr/bin/env bash
set -u
verb="${1:-}"
shift || true
case "$verb" in
  print)
    target="${1:-}"
    label="${target##*/}"
    printf 'print %s\n' "$target" >>"${FLY2264_TEST_CALLS:?}"
    if [[ "${FLY2264_TEST_UNKNOWN_PRINT_LABEL:-}" == "$label" ]]; then
      printf 'launchctl transport unavailable for %s\n' "$label" >&2
      exit 5
    fi
    if [[ "${FLY2264_TEST_UNKNOWN_AFTER_BOOTOUT_LABEL:-}" == "$label" ]] \
        && [[ -f "${FLY2264_TEST_STATE:?}/booted-out/$label" ]]; then
      printf 'launchctl transport unavailable after bootout for %s\n' "$label" >&2
      exit 5
    fi
    if [[ "${FLY2264_TEST_SLOW_LABEL:-}" == "$label" \
        || "${FLY2264_TEST_SECOND_SLOW_LABEL:-}" == "$label" ]] \
        && [[ -f "${FLY2264_TEST_STATE:?}/pending/$label" ]]; then
      polls_file="${FLY2264_TEST_STATE:?}/slow-polls-$label"
      polls=0
      [[ ! -f "$polls_file" ]] || polls="$(cat "$polls_file")"
      polls=$((polls + 1))
      printf '%s\n' "$polls" >"$polls_file"
      if [[ "$polls" -eq 1 ]]; then
        grep -c '^bootout ' "${FLY2264_TEST_CALLS:?}" \
          >"${FLY2264_TEST_STATE:?}/bootouts-at-first-slow-poll"
      fi
      exit_after="${FLY2264_TEST_SLOW_EXIT_AFTER_POLLS:-3}"
      if [[ "$exit_after" =~ ^[0-9]+$ ]] && [[ "$polls" -ge "$exit_after" ]]; then
        rm -f "${FLY2264_TEST_STATE:?}/loaded/$label" "${FLY2264_TEST_STATE:?}/pending/$label"
      fi
    fi
    if [[ -f "${FLY2264_TEST_STATE:?}/loaded/$label" ]]; then
      printf 'gui service = {\n\tpid = 4242\n}\n'
      exit 0
    fi
    printf 'Bad request.\nCould not find service "%s" in domain for user\n' "$label" >&2
    exit 113
    ;;
  print-disabled)
    printf 'print-disabled %s\n' "${1:-}" >>"${FLY2264_TEST_CALLS:?}"
    printf 'disabled services = {\n'
    if [[ "${FLY2264_TEST_UPDATER_DISABLED:-0}" == 1 ]]; then
      printf '\t"com.flywheel.updater" => true\n'
    fi
    printf '}\n'
    ;;
  bootout)
    target="${1:-}"
    label="${target##*/}"
    if [[ ! -f "${FLY2264_TEST_RECOVERY:?}" ]] \
        || ! jq -e '.entries | length == 19' "${FLY2264_TEST_RECOVERY}" >/dev/null 2>&1; then
      printf 'bootout-before-recovery %s\n' "$label" >>"${FLY2264_TEST_CALLS:?}"
      exit 77
    fi
    printf 'bootout %s\n' "$target" >>"${FLY2264_TEST_CALLS:?}"
    [[ "${FLY2264_TEST_BOOTOUT_FAIL_LABEL:-}" != "$label" ]] || exit 9
    mkdir -p "${FLY2264_TEST_STATE:?}/booted-out"
    : >"${FLY2264_TEST_STATE:?}/booted-out/$label"
    if [[ "${FLY2264_TEST_SLOW_LABEL:-}" == "$label" \
        || "${FLY2264_TEST_SECOND_SLOW_LABEL:-}" == "$label" ]]; then
      mkdir -p "${FLY2264_TEST_STATE:?}/pending"
      : >"${FLY2264_TEST_STATE:?}/pending/$label"
    else
      rm -f "${FLY2264_TEST_STATE:?}/loaded/$label"
    fi
    ;;
  bootstrap)
    domain="${1:-}"
    plist="${2:-}"
    label="$(basename "$plist" .plist)"
    printf 'bootstrap %s %s\n' "$domain" "$plist" >>"${FLY2264_TEST_CALLS:?}"
    [[ "${FLY2264_TEST_BOOTSTRAP_FAIL_LABEL:-}" != "$label" ]] || exit 8
    : >"${FLY2264_TEST_STATE:?}/loaded/$label"
    ;;
  *) printf 'unexpected launchctl verb: %s\n' "$verb" >&2; exit 64 ;;
esac
STUB
cat >"$TMP/bin/date" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "$*" = '+%s' ] && [ -n "${FLY2264_TEST_FAKE_EPOCH_FILE:-}" ]; then
  value="$(cat "$FLY2264_TEST_FAKE_EPOCH_FILE")"
  printf '%s\n' "$value"
  printf '%s\n' "$((value + ${FLY2264_TEST_FAKE_EPOCH_STEP:-1}))" \
    >"$FLY2264_TEST_FAKE_EPOCH_FILE"
  exit 0
fi
exec /bin/date "$@"
STUB
cat >"$TMP/bin/sleep" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "${FLY2264_TEST_NO_SLEEP:-0}" = 1 ]; then
  printf 'sleep %s\n' "$*" >>"${FLY2264_TEST_CALLS:?}"
  exit 0
fi
exec /bin/sleep "$@"
STUB
chmod +x "$TMP/bin/launchctl" "$TMP/bin/date" "$TMP/bin/sleep"

export PATH="$TMP/bin:$PATH"
export FLY2264_TEST_STATE="$STATE"
export FLY2264_TEST_CALLS="$CALLS"
export FLY2264_TEST_RECOVERY="$RECOVERY"

reset_updater_queues() {
  rm -rf "$WINDOW_HOME/.flywheel/self-ship-urgent.d"
  mkdir -p "$WINDOW_HOME/.flywheel/self-ship-urgent.d"
}

load_all_supervisors() {
  rm -rf "$STATE/loaded" "$STATE/pending" "$STATE/booted-out"
  rm -f "$STATE"/slow-polls-* "$STATE/bootouts-at-first-slow-poll"
  mkdir -p "$STATE/loaded" "$STATE/pending" "$STATE/booted-out"
  while IFS= read -r label; do
    [ -n "$label" ] && : >"$STATE/loaded/$label"
  done <"$SAMPLE"
  : >"$STATE/loaded/com.flywheel.updater"
  : >"$CALLS"
  rm -f "$RECOVERY"
  reset_updater_queues
}

echo "Test: bootout publishes complete recovery before mutation and preserves updater"
load_all_supervisors
rc=0
HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" >"$TMP/bootout.out" 2>"$TMP/bootout.err" || rc=$?
bootout_count=$(grep -c '^bootout ' "$CALLS" || true)
remaining=0
while IFS= read -r label; do
  [ ! -e "$STATE/loaded/$label" ] || remaining=$((remaining + 1))
done <"$SAMPLE"
mode=$(stat -c %a "$RECOVERY" 2>/dev/null || stat -f %Lp "$RECOVERY" 2>/dev/null || true)
if [ "$rc" -eq 0 ] && [ "$bootout_count" -eq 19 ] && [ "$remaining" -eq 0 ] \
    && [ -f "$STATE/loaded/com.flywheel.updater" ] && [ "$mode" = 600 ] \
    && jq -e '.schemaVersion == 1 and (.entries | length == 19)' "$RECOVERY" >/dev/null \
    && jq -e '[.entries[].loaded] | all' "$RECOVERY" >/dev/null \
    && ! grep -q 'bootout .*com.flywheel.updater' "$CALLS"; then
  pass "bootout is recovery-first, complete, and updater-safe"
else
  fail "bootout contract rc=$rc count=$bootout_count remaining=$remaining mode=$mode err=$(tr '\n' ' ' <"$TMP/bootout.err" 2>/dev/null)"
fi

echo "Test: restore is Bridge-first and re-establishes every original loaded label"
: >"$CALLS"
rc=0
HOME="$WINDOW_HOME" "$RESTORE" "$RECOVERY" >"$TMP/restore.out" 2>"$TMP/restore.err" || rc=$?
first_bootstrap=$(grep '^bootstrap ' "$CALLS" | head -1 || true)
bootstrap_count=$(grep -c '^bootstrap ' "$CALLS" || true)
loaded_count=0
while IFS= read -r label; do
  [ -f "$STATE/loaded/$label" ] && loaded_count=$((loaded_count + 1))
done <"$SAMPLE"
if [ "$rc" -eq 0 ] && [ "$bootstrap_count" -eq 19 ] && [ "$loaded_count" -eq 19 ] \
    && [[ "$first_bootstrap" == *'/com.flywheel.bridge.plist' ]] \
    && ! grep -q 'bootstrap .*com.flywheel.updater' "$CALLS"; then
  pass "restore bootstraps Bridge first and closes all 19 states"
else
  fail "restore contract rc=$rc count=$bootstrap_count loaded=$loaded_count first=$first_bootstrap"
fi

echo "Test: a safely pre-unloaded updater permits the complete supervisor cycle"
load_all_supervisors
rm "$STATE/loaded/com.flywheel.updater"
preunloaded_bootout_rc=0
HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" \
  >"$TMP/preunloaded-bootout.out" 2>"$TMP/preunloaded-bootout.err" || preunloaded_bootout_rc=$?
preunloaded_bootouts=$(grep -c '^bootout ' "$CALLS" || true)
: >"$CALLS"
preunloaded_restore_rc=0
HOME="$WINDOW_HOME" "$RESTORE" "$RECOVERY" \
  >"$TMP/preunloaded-restore.out" 2>"$TMP/preunloaded-restore.err" || preunloaded_restore_rc=$?
preunloaded_bootstraps=$(grep -c '^bootstrap ' "$CALLS" || true)
if [ "$preunloaded_bootout_rc" -eq 0 ] && [ "$preunloaded_restore_rc" -eq 0 ] \
    && [ "$preunloaded_bootouts" -eq 19 ] && [ "$preunloaded_bootstraps" -eq 19 ] \
    && [ ! -e "$STATE/loaded/com.flywheel.updater" ] \
    && ! grep -Eq '^(bootout|bootstrap).*com\.flywheel\.updater' "$CALLS"; then
  pass "pre-unloaded updater remains absent while all 19 supervisors cycle"
else
  fail "pre-unloaded updater cycle bootout=$preunloaded_bootout_rc/$preunloaded_bootouts restore=$preunloaded_restore_rc/$preunloaded_bootstraps bootout_err=$(tr '\n' ' ' <"$TMP/preunloaded-bootout.err" 2>/dev/null) restore_err=$(tr '\n' ' ' <"$TMP/preunloaded-restore.err" 2>/dev/null)"
fi
: >"$STATE/loaded/com.flywheel.updater"

echo "Test: restored recovery can drive a fresh bootout retry without hand deletion"
: >"$CALLS"
retry_rc=0
HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" >"$TMP/retry.out" 2>"$TMP/retry.err" || retry_rc=$?
retry_bootouts=$(grep -c '^bootout ' "$CALLS" || true)
if [ "$retry_rc" -eq 0 ] && [ "$retry_bootouts" -eq 19 ] \
    && jq -e '[.entries[].loaded] | all' "$RECOVERY" >/dev/null; then
  pass "validated recovery is atomically refreshed and bootout is re-runnable"
else
  fail "bootout retry rc=$retry_rc count=$retry_bootouts err=$(tr '\n' ' ' <"$TMP/retry.err")"
fi

echo "Test: all supervisor bootouts are issued before a slow exit is polled"
load_all_supervisors
slow_rc=0
FLY2264_TEST_SLOW_LABEL=com.flywheel.bridge \
  FLY2264_TEST_SLOW_EXIT_AFTER_POLLS=3 \
  HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" \
  >"$TMP/slow.out" 2>"$TMP/slow.err" || slow_rc=$?
slow_bootouts=$(grep -c '^bootout ' "$CALLS" || true)
slow_polls=$(cat "$STATE/slow-polls-com.flywheel.bridge" 2>/dev/null || printf '0\n')
bootouts_at_first_slow_poll=$(cat "$STATE/bootouts-at-first-slow-poll" 2>/dev/null || printf '0\n')
if [ "$slow_rc" -eq 0 ] && [ "$slow_bootouts" -eq 19 ] \
    && [ "$slow_polls" -ge 3 ] && [ "$bootouts_at_first_slow_poll" -eq 19 ]; then
  pass "all 19 bootouts precede bounded convergence polling"
else
  fail "slow-exit ordering rc=$slow_rc bootouts=$slow_bootouts polls=$slow_polls first_poll_after=$bootouts_at_first_slow_poll err=$(tr '\n' ' ' <"$TMP/slow.err")"
fi

echo "Test: a never-exiting supervisor stops at the shared 90-second convergence deadline"
load_all_supervisors
FAKE_EPOCH="$STATE/fake-epoch"
printf '100\n' >"$FAKE_EPOCH"
timeout_rc=0
FLY2264_TEST_SLOW_LABEL=com.flywheel.bridge \
  FLY2264_TEST_SLOW_EXIT_AFTER_POLLS=never \
  FLY2264_TEST_FAKE_EPOCH_FILE="$FAKE_EPOCH" \
  FLY2264_TEST_FAKE_EPOCH_STEP=20 \
  FLY2264_TEST_NO_SLEEP=1 \
  HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" \
  >"$TMP/timeout.out" 2>"$TMP/timeout.err" || timeout_rc=$?
timeout_bootouts=$(grep -c '^bootout ' "$CALLS" || true)
timeout_polls=$(cat "$STATE/slow-polls-com.flywheel.bridge" 2>/dev/null || printf '0\n')
if [ "$timeout_rc" -ne 0 ] && [ "$timeout_bootouts" -eq 19 ] && [ "$timeout_polls" -eq 5 ] \
    && grep -qF 'label did not become absent within shared 90-second convergence deadline: com.flywheel.bridge' \
      "$TMP/timeout.err" \
    && [ ! -s "$TMP/timeout.out" ]; then
  pass "deadline exhaustion names the slow label without a wall-clock sleep"
else
  fail "slow-exit deadline rc=$timeout_rc bootouts=$timeout_bootouts polls=$timeout_polls out=$(tr '\n' ' ' <"$TMP/timeout.out") err=$(tr '\n' ' ' <"$TMP/timeout.err")"
fi

echo "Test: multiple slow supervisors share one 90-second convergence deadline"
load_all_supervisors
SHARED_FAKE_EPOCH="$STATE/shared-fake-epoch"
printf '100\n' >"$SHARED_FAKE_EPOCH"
shared_timeout_rc=0
FLY2264_TEST_SLOW_LABEL=com.flywheel.bridge \
  FLY2264_TEST_SECOND_SLOW_LABEL=com.flywheel.bridge-liveness-probe \
  FLY2264_TEST_SLOW_EXIT_AFTER_POLLS=never \
  FLY2264_TEST_FAKE_EPOCH_FILE="$SHARED_FAKE_EPOCH" \
  FLY2264_TEST_FAKE_EPOCH_STEP=45 \
  FLY2264_TEST_NO_SLEEP=1 \
  HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" \
  >"$TMP/shared-timeout.out" 2>"$TMP/shared-timeout.err" || shared_timeout_rc=$?
shared_timeout_bootouts=$(grep -c '^bootout ' "$CALLS" || true)
shared_bridge_polls=$(cat "$STATE/slow-polls-com.flywheel.bridge" 2>/dev/null || printf '0\n')
shared_probe_polls=$(cat "$STATE/slow-polls-com.flywheel.bridge-liveness-probe" 2>/dev/null || printf '0\n')
if [ "$shared_timeout_rc" -ne 0 ] && [ "$shared_timeout_bootouts" -eq 19 ] \
    && [ "$shared_bridge_polls" -eq 2 ] && [ "$shared_probe_polls" -eq 2 ] \
    && grep -qF 'label did not become absent within shared 90-second convergence deadline: com.flywheel.bridge' \
      "$TMP/shared-timeout.err" \
    && grep -qF 'label did not become absent within shared 90-second convergence deadline: com.flywheel.bridge-liveness-probe' \
      "$TMP/shared-timeout.err" \
    && [ ! -s "$TMP/shared-timeout.out" ]; then
  pass "all pending labels consume one bounded convergence budget"
else
  fail "shared deadline rc=$shared_timeout_rc bootouts=$shared_timeout_bootouts bridge_polls=$shared_bridge_polls probe_polls=$shared_probe_polls out=$(tr '\n' ' ' <"$TMP/shared-timeout.out") err=$(tr '\n' ' ' <"$TMP/shared-timeout.err")"
fi

echo "Test: an unknown convergence state fails after the complete bootout round"
load_all_supervisors
unknown_rc=0
FLY2264_TEST_UNKNOWN_AFTER_BOOTOUT_LABEL=com.flywheel.bridge \
  HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" \
  >"$TMP/unknown-after.out" 2>"$TMP/unknown-after.err" || unknown_rc=$?
unknown_bootouts=$(grep -c '^bootout ' "$CALLS" || true)
if [ "$unknown_rc" -ne 0 ] && [ "$unknown_bootouts" -eq 19 ] \
    && grep -qF 'post-bootout state unknown for com.flywheel.bridge' "$TMP/unknown-after.err" \
    && [ ! -s "$TMP/unknown-after.out" ]; then
  pass "unknown convergence state fails closed after all bootout requests"
else
  fail "unknown convergence rc=$unknown_rc bootouts=$unknown_bootouts out=$(tr '\n' ' ' <"$TMP/unknown-after.out") err=$(tr '\n' ' ' <"$TMP/unknown-after.err")"
fi

echo "Test: a queued updater ticket cannot block emergency supervisor restore"
load_all_supervisors
HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" \
  >"$TMP/queued-setup.out" 2>"$TMP/queued-setup.err"
: >"$WINDOW_HOME/.flywheel/self-ship-urgent.d/retry.urgent.json"
: >"$CALLS"
queued_restore_rc=0
HOME="$WINDOW_HOME" "$RESTORE" "$RECOVERY" \
  >"$TMP/queued-restore.out" 2>"$TMP/queued-restore.err" || queued_restore_rc=$?
queued_restore_bootstraps=$(grep -c '^bootstrap ' "$CALLS" || true)
if [ "$queued_restore_rc" -eq 0 ] && [ "$queued_restore_bootstraps" -eq 19 ] \
    && [ -f "$WINDOW_HOME/.flywheel/self-ship-urgent.d/retry.urgent.json" ]; then
  pass "supervisor recovery ignores but never consumes queued updater tickets"
else
  fail "queued-ticket restore rc=$queued_restore_rc count=$queued_restore_bootstraps err=$(tr '\n' ' ' <"$TMP/queued-restore.err")"
fi

echo "Test: pre-existing unloaded drift publishes recovery then fails before mutation"
load_all_supervisors
rm "$STATE/loaded/com.flywheel.lead.geoforge3d-ops-lead"
if HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" >"$TMP/unloaded.out" 2>"$TMP/unloaded.err"; then
  fail "bootout accepted a pre-existing unloaded supervisor"
elif grep -q '^bootout ' "$CALLS"; then
  fail "bootout mutated launchd after detecting unloaded drift"
elif jq -e '.entries[] | select(.label == "com.flywheel.lead.geoforge3d-ops-lead") | .loaded == false' "$RECOVERY" >/dev/null \
    && grep -qF 'pre-existing unloaded supervisor: com.flywheel.lead.geoforge3d-ops-lead' "$TMP/unloaded.err"; then
  pass "unloaded drift is durable and fails before the first bootout"
else
  fail "unloaded drift recovery/diagnostic missing"
fi

echo "Test: updater queue entries and unsafe queue path shapes fail before mutation"
queue_negative=1
for state_name in loaded absent; do
  for queue_name in self-ship-urgent.d; do
    load_all_supervisors
    [ "$state_name" = loaded ] || rm "$STATE/loaded/com.flywheel.updater"
    : >"$WINDOW_HOME/.flywheel/$queue_name/token.json"
    if HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" \
        >"$TMP/queue-${state_name}-${queue_name}.out" 2>"$TMP/queue-${state_name}-${queue_name}.err"; then
      queue_negative=0
    elif grep -q '^bootout ' "$CALLS" \
        || grep -qF 'updater must remain loaded and enabled' "$TMP/queue-${state_name}-${queue_name}.err" \
        || ! grep -qF "updater queue is not empty: $WINDOW_HOME/.flywheel/$queue_name" \
          "$TMP/queue-${state_name}-${queue_name}.err"; then
      queue_negative=0
    fi
  done
done
for shape in symlink file; do
  load_all_supervisors
  queue_path="$WINDOW_HOME/.flywheel/self-ship-urgent.d"
  rm -rf "$queue_path"
  if [ "$shape" = symlink ]; then
    queue_target="$WINDOW_HOME/.flywheel/updater-queue-target"
    mkdir -p "$queue_target"
    ln -s "$queue_target" "$queue_path"
  else
    : >"$queue_path"
  fi
  if HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" \
      >"$TMP/queue-$shape.out" 2>"$TMP/queue-$shape.err"; then
    queue_negative=0
  elif grep -q '^bootout ' "$CALLS" \
      || ! grep -qF "updater queue path is not a real directory: $queue_path" "$TMP/queue-$shape.err"; then
    queue_negative=0
  fi
done
if [ "$queue_negative" -eq 1 ]; then
  pass "both updater states require an empty real urgent queue before mutation"
else
  fail "updater queue safety matrix"
fi

echo "Test: disabled updater and manifest drift both fail before mutation"
load_all_supervisors
if FLY2264_TEST_UPDATER_DISABLED=1 HOME="$WINDOW_HOME" "$BOOTOUT" "$TMP/supervisor-labels.txt" >"$TMP/disabled.out" 2>"$TMP/disabled.err"; then
  fail "bootout accepted a disabled updater"
elif grep -q '^bootout ' "$CALLS"; then
  fail "bootout mutated with updater disabled"
else
  drift_labels="$TMP/drift-labels.txt"
  sed '/com.flywheel.lead.geoforge3d-ops-lead/d' "$SAMPLE" >"$drift_labels"
  : >"$CALLS"
  if HOME="$WINDOW_HOME" "$BOOTOUT" "$drift_labels" >"$TMP/drift.out" 2>"$TMP/drift.err"; then
    fail "bootout accepted manifest drift"
  elif grep -q '^bootout ' "$CALLS"; then
    fail "bootout mutated after manifest drift"
  else
    pass "updater disabled and manifest drift are zero-mutation failures"
  fi
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
