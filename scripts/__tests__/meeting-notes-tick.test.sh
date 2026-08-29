#!/bin/bash
# FLY-2033 tick wrapper: lock, fail-loud preflight, command, and alert fallback.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER="$REPO_ROOT/scripts/meeting-notes-tick.sh"
SCHEDULER_SOURCE="$REPO_ROOT/scripts/meeting-notes-scheduler.ts"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fly2033-tick.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

FIXTURE="$TMP_ROOT/repo"
mkdir -p "$FIXTURE/scripts" "$FIXTURE/packages/teamlead/dist" "$FIXTURE/.flywheel" "$TMP_ROOT/home"
cp "$WRAPPER" "$FIXTURE/scripts/meeting-notes-tick.sh"
touch "$FIXTURE/packages/teamlead/dist/meeting-notes-scheduler.js"
touch "$FIXTURE/packages/teamlead/dist/meeting-notes-config.js"
printf 'meetingStateDir: /tmp\n' > "$FIXTURE/.flywheel/meeting-notes.yaml"

cat > "$FIXTURE/scripts/lead-alert.sh" <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >> "${ALERT_CALLS:?}"
printf '%s\n' "${ALERT_RECEIPT:-sent}"
exit "${ALERT_RC:-0}"
FAKE
chmod +x "$FIXTURE/scripts/lead-alert.sh"

cat > "$TMP_ROOT/fake-pnpm" <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >> "${SCHEDULER_CALLS:?}"
exit "${SCHEDULER_RC:-0}"
FAKE
chmod +x "$TMP_ROOT/fake-pnpm"

run_tick() {
  HOME="$TMP_ROOT/home" \
  FLYWHEEL_DIR="$FIXTURE" \
  FLYWHEEL_MEETING_NOTES_CONFIG="$FIXTURE/.flywheel/meeting-notes.yaml" \
  FLYWHEEL_MEETING_NOTES_LOG="$TMP_ROOT/tick.log" \
  FLYWHEEL_MEETING_NOTES_LOCKDIR="$TMP_ROOT/tick.lock" \
  FLYWHEEL_MEETING_NOTES_PNPM="$TMP_ROOT/fake-pnpm" \
  ALERT_CALLS="$TMP_ROOT/alerts" \
  SCHEDULER_CALLS="$TMP_ROOT/scheduler" \
  "$@" bash "$FIXTURE/scripts/meeting-notes-tick.sh"
}

rm -f "$FIXTURE/.flywheel/meeting-notes.yaml" "$TMP_ROOT/alerts"
run_tick env >"$TMP_ROOT/missing.out" 2>&1; rc=$?
if [ "$rc" -eq 1 ] && grep -q -- '--kind meeting_notes_failed' "$TMP_ROOT/alerts" \
  && grep -q 'failureClass=config' "$TMP_ROOT/alerts"; then
  ok "missing config fails loud through meeting_notes_failed"
else
  bad "missing config did not fail loud rc=$rc"
fi
printf 'meetingStateDir: /tmp\n' > "$FIXTURE/.flywheel/meeting-notes.yaml"

rm -f "$TMP_ROOT/scheduler"
mkdir "$TMP_ROOT/tick.lock"
run_tick env >"$TMP_ROOT/locked.out" 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$TMP_ROOT/scheduler" ]; then
  ok "fresh lock skips without overlapping scheduler"
else
  bad "fresh lock overlap guard failed rc=$rc"
fi
rmdir "$TMP_ROOT/tick.lock"

rm -f "$TMP_ROOT/scheduler"
mkdir "$TMP_ROOT/tick.lock"
touch -t 200001010000 "$TMP_ROOT/tick.lock"
run_tick env >"$TMP_ROOT/stale.out" 2>&1; rc=$?
if [ "$rc" -eq 0 ] && grep -q '^exec tsx scripts/meeting-notes-scheduler.ts$' "$TMP_ROOT/scheduler" \
  && [ ! -e "$TMP_ROOT/tick.lock" ]; then
  ok "stale empty lock is reaped and scheduler runs once"
else
  bad "stale lock recovery failed rc=$rc"
fi

rm -f "$TMP_ROOT/scheduler" "$TMP_ROOT/alerts"
run_tick env SCHEDULER_RC=23 >"$TMP_ROOT/fail.out" 2>&1; rc=$?
if [ "$rc" -eq 23 ] && grep -q 'failureClass=bridge' "$TMP_ROOT/alerts" \
  && grep -q 'scheduler exited rc=23' "$TMP_ROOT/alerts"; then
  ok "scheduler failure preserves rc and emits fallback alert"
else
  bad "scheduler failure was not surfaced rc=$rc"
fi

rm -f "$TMP_ROOT/scheduler" "$TMP_ROOT/alerts"
run_tick env SCHEDULER_RC=2 >"$TMP_ROOT/already-alerted.out" 2>&1; rc=$?
if [ "$rc" -eq 2 ] && [ ! -e "$TMP_ROOT/alerts" ] \
  && grep -q 'scheduler failed after delivering its own alert' "$TMP_ROOT/tick.log"; then
  ok "scheduler-owned alert receipt suppresses the wrapper duplicate"
else
  bad "scheduler-owned alert was duplicated rc=$rc"
fi

if grep -q 'state{name type} comments(first:100)' "$SCHEDULER_SOURCE" \
  && ! grep -q 'comments: await issueComments' "$SCHEDULER_SOURCE"; then
  ok "Linear issue pagination batches initial comments instead of one request per issue"
else
  bad "Linear comment polling remains an unbounded N+1"
fi

if grep -q 'entry.name.startsWith(".")' "$SCHEDULER_SOURCE"; then
  ok "dotfiles in the Raya archive root are ignored"
else
  bad "dotfiles trigger a permanent false-positive archive alert"
fi

if grep -q 'modified=$(stat -c %Y "$LOCKDIR".*stat -f %m "$LOCKDIR"' "$WRAPPER"; then
  ok "lock mtime probes GNU stat before the BSD fallback"
else
  bad "BSD stat probing can contaminate the GNU lock timestamp"
fi

rm -f "$TMP_ROOT/scheduler" "$TMP_ROOT/alerts"
run_tick env ALERT_RECEIPT=dead_lettered ALERT_RC=2 SCHEDULER_RC=9 >"$TMP_ROOT/alert-fail.out" 2>&1; rc=$?
if [ "$rc" -eq 9 ] && grep -q 'alert delivery unproven' "$TMP_ROOT/tick.log"; then
  ok "unproven alert delivery is visible while scheduler rc remains authoritative"
else
  bad "alert delivery failure was swallowed rc=$rc"
fi

echo "FLY-2033 meeting notes tick: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
