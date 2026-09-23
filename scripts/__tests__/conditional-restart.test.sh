#!/usr/bin/env bash
# FLY-2654: final pre-stop revalidation and zero-stop-effect checkout restore.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2654-final-check.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

export HOME="$TMP/home"
export FLYWHEEL_DIR="$TMP/repo"
export DEPLOYED_SHA_FILE="$TMP/deployed-sha"
mkdir -p "$HOME" "$FLYWHEEL_DIR"
git init -q "$FLYWHEEL_DIR"
git -C "$FLYWHEEL_DIR" config user.email fly2654@example.test
git -C "$FLYWHEEL_DIR" config user.name FLY-2654
printf 'old\n' > "$FLYWHEEL_DIR/state"
git -C "$FLYWHEEL_DIR" add state
git -C "$FLYWHEEL_DIR" commit -qm old
FROM="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)"
printf 'new\n' > "$FLYWHEEL_DIR/state"
git -C "$FLYWHEEL_DIR" commit -qam new
TARGET="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)"
git -C "$FLYWHEEL_DIR" update-ref refs/remotes/origin/main "$TARGET"
printf '%s\n' "$FROM" > "$DEPLOYED_SHA_FILE"

TICKET="$TMP/ticket.json"
INDEX="$TMP/index.json"
CLI="$TMP/restart-request.js"
REQUEST_ID=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
DIGEST="$(printf 'a%.0s' {1..64})"
jq -n --arg id "$REQUEST_ID" --arg digest "$DIGEST" \
  '{schemaVersion:3,kind:"lead-closeout-restart",decisionId:$id,waveId:"wave-1",requestDigest:$digest}' > "$TICKET"
jq -n --arg id "$REQUEST_ID" --arg digest "$DIGEST" '{schemaVersion:1,intents:{key:{requestId:$id,requestDigest:$digest,revision:1,state:"prepared",updatedAt:"2026-09-18T05:00:00Z",waveId:"wave-1"}}}' > "$INDEX"
cat > "$CLI" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CLI_LOG"
command="$1"; shift
case "$command" in
  intent-state)
    while [ "$#" -gt 0 ]; do
      case "$1" in --index) index="$2"; shift 2 ;; *) shift 2 2>/dev/null || shift ;; esac
    done
    jq -er '.intents[] | .state' "$index"
    ;;
  verify) exit "${VERIFY_RC:-0}" ;;
  transition)
    [ "${TRANSITION_RC:-0}" = 0 ] || exit "$TRANSITION_RC"
    while [ "$#" -gt 0 ]; do
      case "$1" in --index) index="$2"; shift 2 ;; *) shift 2 2>/dev/null || shift ;; esac
    done
    jq '.intents[].state="started"' "$index" > "$index.tmp" && mv "$index.tmp" "$index"
    ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$CLI"
export CLI_LOG="$TMP/cli.log"
: > "$CLI_LOG"

export FLYWHEEL_URGENT_RESTART_TICKET="$TICKET"
export FLYWHEEL_URGENT_RESTART_INDEX="$INDEX"
export FLYWHEEL_URGENT_RESTART_TARGET_SHA="$TARGET"
export FLYWHEEL_URGENT_RESTART_FROM_SHA="$FROM"
export FLYWHEEL_URGENT_RESTART_PRE_MERGE_HEAD="$FROM"
export FLYWHEEL_URGENT_RESTART_TRIGGER_SHA="$TARGET"
export FLYWHEEL_URGENT_RESTART_WAVE_ID=wave-1
export FLYWHEEL_URGENT_RESTART_NODE=bash
export FLYWHEEL_URGENT_RESTART_CLI="$CLI"
# shellcheck source=/dev/null
source "$ROOT/scripts/lib/conditional-restart.sh"

guard_line="$(rg -n 'if ! conditional_restart_final_check' "$ROOT/scripts/restart-services.sh" | cut -d: -f1)"
stop_line="$(rg -n 'if ! stop_bridge' "$ROOT/scripts/restart-services.sh" | tail -1 | cut -d: -f1)"
if [[ "$guard_line" =~ ^[0-9]+$ && "$stop_line" =~ ^[0-9]+$ && "$guard_line" -lt "$stop_line" ]] \
  && rg -q 'return 82' "$ROOT/scripts/restart-services.sh"; then
    pass "restart-services mounts the final guard before the service-stop boundary"
else
    fail "restart-services final guard ordering drifted (guard=$guard_line stop=$stop_line)"
fi

if conditional_restart_final_check \
  && jq -e '.intents[].state == "started"' "$INDEX" >/dev/null \
  && grep -q '^verify ' "$CLI_LOG" && grep -q '^transition ' "$CLI_LOG"; then
  pass "v3 exact live evidence enters started only at the final pre-stop check"
else
  fail "v3 exact live evidence was rejected or not atomically started"
fi
jq '.intents[].state="prepared"' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
: > "$CLI_LOG"
VERIFY_RC=1
export VERIFY_RC
if ! conditional_restart_final_check \
  && jq -e '.intents[].state == "prepared"' "$INDEX" >/dev/null \
  && ! grep -q '^transition ' "$CLI_LOG"; then
  pass "source revalidation failure blocks before start and stop"
else
  fail "source revalidation failure passed or consumed the intent"
fi
VERIFY_RC=0
export VERIFY_RC
jq '.intents.key.state="unknown"' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
if ! conditional_restart_final_check; then pass "non-started one-use state blocks before stop"; else fail "non-started intent passed"; fi
jq '.intents.key.state="prepared"' "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
printf 'dirty\n' >> "$FLYWHEEL_DIR/state"
if ! conditional_restart_final_check; then pass "dirty checkout blocks before stop"; else fail "dirty checkout passed"; fi
git -C "$FLYWHEEL_DIR" reset --hard -q "$TARGET"

jq -n --arg id "$REQUEST_ID" --arg digest "$DIGEST" \
  '{schemaVersion:2,kind:"authorized-urgent-restart",requestId:$id,requestDigest:$digest}' > "$TICKET"
jq -n --arg id "$REQUEST_ID" --arg digest "$DIGEST" '{schemaVersion:1,intents:{key:{requestId:$id,requestDigest:$digest,state:"started",updatedAt:"2026-09-18T05:00:00Z",waveId:"wave-1"}}}' > "$INDEX"
: > "$CLI_LOG"
if conditional_restart_final_check \
  && grep -q -- '--allow-started-v2-recovery --index' "$CLI_LOG" \
  && ! grep -q '^transition ' "$CLI_LOG"; then
  pass "already-started v2 is recovery-only and cannot cross started again"
else
  fail "started v2 recovery compatibility drifted"
fi

if conditional_restart_restore_premerge \
  && [ "$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)" = "$FROM" ] \
  && [ "$(cat "$DEPLOYED_SHA_FILE")" = "$FROM" ]; then
    pass "zero-stop-effect failure restores only the pre-merge checkout"
else
    fail "pre-merge checkout restore failed"
fi
if ! conditional_restart_restore_premerge; then pass "restore is one-shot and refuses a changed HEAD"; else fail "restore repeated after HEAD changed"; fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
