#!/usr/bin/env bash
# FLY-1671: manual restart requests reuse the existing durable updater queue.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REQUEST="$ROOT/scripts/request-restart.sh"
UPDATER="$ROOT/scripts/update-flywheel.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1671-request.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

if [ ! -x "$REQUEST" ]; then
  fail "request-restart.sh exists and is executable"
  printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi

REMOTE_SHA=1111111111111111111111111111111111111111
LOCAL_SHA=2222222222222222222222222222222222222222
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/home"

cat > "$TMP/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'prompt=%s\t%s\n' "${GIT_TERMINAL_PROMPT:-unset}" "$*" >> "$RR_GIT_LOG"
case " $* " in
  *" ls-remote origin refs/heads/main "*)
    case "${RR_GIT_MODE:-ok}" in
      ok) printf '%s\trefs/heads/main\n' "$RR_REMOTE_SHA" ;;
      fail) printf 'simulated ls-remote failure\n' >&2; exit 2 ;;
      empty) exit 0 ;;
      multi) printf '%s\trefs/heads/main\n%s\trefs/heads/main\n' "$RR_REMOTE_SHA" "$RR_LOCAL_SHA" ;;
      malformed) printf 'not-a-sha\trefs/heads/main\n' ;;
      hang)
        printf 'simulated ls-remote stall\n' >&2
        sleep 5
        printf '%s\trefs/heads/main\n' "$RR_REMOTE_SHA"
        ;;
    esac
    ;;
  *" rev-parse origin/main "*) printf '%s\n' "$RR_LOCAL_SHA" ;;
  *) exit 64 ;;
esac
EOF
cat > "$TMP/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RR_LAUNCHCTL_LOG"
case "${1:-}" in
  print) [ "${RR_UPDATER_LOADED:-1}" = 1 ] ;;
  kickstart) [ "${RR_KICKSTART_OK:-1}" = 1 ] ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$TMP/bin/git" "$TMP/bin/launchctl"

export HOME="$TMP/home"
export FLYWHEEL_DIR="$TMP/repo"
export REQUEST_RESTART_GIT="$TMP/bin/git"
export SELF_SHIP_LAUNCHCTL="$TMP/bin/launchctl"
export SELF_SHIP_PENDING_DIR="$TMP/pending.d"
export SELF_SHIP_BLOCKED_DIR="$TMP/blocked.d"
export SELF_SHIP_TMP_DIR="$TMP/queue-tmp"
export SELF_SHIP_LOCK_DIR="$TMP/lock.d"
export RR_GIT_LOG="$TMP/git.log"
export RR_LAUNCHCTL_LOG="$TMP/launchctl.log"
export RR_REMOTE_SHA="$REMOTE_SHA"
export RR_LOCAL_SHA="$LOCAL_SHA"
export REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS=1

reset_queue() {
  rm -rf "$SELF_SHIP_PENDING_DIR" "$SELF_SHIP_BLOCKED_DIR" "$SELF_SHIP_TMP_DIR"
  : > "$RR_GIT_LOG"
  : > "$RR_LAUNCHCTL_LOG"
}
marker_count() { find "$SELF_SHIP_PENDING_DIR" -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }
marker_field() { jq -r "$1" "$(find "$SELF_SHIP_PENDING_DIR" -name '*.json' | head -1)"; }

reset_queue
out="$(RR_GIT_MODE=ok "$REQUEST" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(marker_count)" = 1 ] \
  && [ "$(marker_field .targetSha)" = "$REMOTE_SHA" ] \
  && [ "$(marker_field '.prNumber // ""')" = "" ] \
  && [ "$(marker_field '.issueIdentifier // ""')" = "" ] \
  && grep -q '^kickstart ' "$RR_LAUNCHCTL_LOG" \
  && grep -q $'^prompt=0\t.* ls-remote origin refs/heads/main$' "$RR_GIT_LOG" \
  && grep -q '已受理入队' <<<"$out" \
  && grep -q '不代表重启完成' <<<"$out"; then
  pass "remote main SHA is enqueued without fake deployment identity"
else
  fail "happy path drifted (rc=$rc markers=$(marker_count) out=$out)"
fi

for mode in fail empty multi malformed; do
  reset_queue
  out="$(RR_GIT_MODE="$mode" "$REQUEST" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$(marker_count)" = 1 ] \
    && [ "$(marker_field .targetSha)" = "$LOCAL_SHA" ] \
    && grep -q 'WARNING' <<<"$out"; then
    pass "ls-remote $mode falls back to validated local origin/main"
  else
    fail "ls-remote $mode fallback wrong (rc=$rc markers=$(marker_count) out=$out)"
  fi
done

reset_queue
started_at=$SECONDS
out="$(RR_GIT_MODE=hang "$REQUEST" 2>&1)"; rc=$?
elapsed=$((SECONDS - started_at))
if [ "$rc" -eq 0 ] && [ "$elapsed" -lt 5 ] \
  && [ "$(marker_count)" = 1 ] \
  && [ "$(marker_field .targetSha)" = "$LOCAL_SHA" ] \
  && grep -q 'simulated ls-remote stall' <<<"$out" \
  && grep -q 'rc=124' <<<"$out"; then
  pass "stalled noninteractive ls-remote is bounded, diagnosed, and falls back locally"
else
  fail "stalled ls-remote was not bounded and diagnosed (rc=$rc elapsed=$elapsed out=$out)"
fi

reset_queue
out="$(RR_GIT_MODE=fail "$REQUEST" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'simulated ls-remote failure' <<<"$out"; then
  pass "ls-remote stderr is relayed before the validated local fallback"
else
  fail "ls-remote diagnostics were discarded (rc=$rc out=$out)"
fi

reset_queue
out="$(RR_UPDATER_LOADED=0 "$REQUEST" 2>&1)"; rc=$?
if [ "$rc" -eq 69 ] && [ "$(marker_count)" = 0 ]; then
  pass "unloaded updater fails before enqueue with rc69"
else
  fail "unloaded updater did not fail cleanly (rc=$rc markers=$(marker_count) out=$out)"
fi

reset_queue
out="$(RR_KICKSTART_OK=0 "$REQUEST" 2>&1)"; rc=$?
if [ "$rc" -eq 69 ] && [ "$(marker_count)" = 1 ]; then
  pass "kickstart failure preserves the durable marker and rc69"
else
  fail "kickstart failure lost intent or rc (rc=$rc markers=$(marker_count) out=$out)"
fi

reset_queue
out="$(RR_GIT_MODE=ok "$REQUEST" --dry-run 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(marker_count)" = 0 ] \
  && grep -q 'DRY RUN' <<<"$out" \
  && ! grep -qE 'fetch|update-ref' "$RR_GIT_LOG"; then
  pass "dry-run performs no repository, queue, or Flywheel-state writes"
else
  fail "dry-run mutated state (rc=$rc markers=$(marker_count) git=$(cat "$RR_GIT_LOG") out=$out)"
fi

if ! rg -q 'restart-services\.sh' "$REQUEST" \
  && rg -q 'git -C "\$FLYWHEEL_DIR" pull origin main --ff-only' "$UPDATER" \
  && rg -q 'restart-services\.sh" --reason updater' "$UPDATER"; then
  pass "manual entry cannot bypass the updater pull-latest-main chain"
else
  fail "manual entry no longer guarantees updater ff-only pull before restart"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
