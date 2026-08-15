#!/bin/bash
# FLY-1716: /clear writeback, generation fencing, and keyed replay ledger.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/packages/teamlead/scripts/session-start-adopt-inflight.sh"
AUTHORITY_LIB="$ROOT/packages/teamlead/scripts/lib/lead-session-authority.sh"
TMP="$(mktemp -d /tmp/fly1716-clear-authority.XXXXXX)"
PASS=0
FAIL=0
trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/node" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$FLY1716_CALLS"
if [ "${FLY1716_NODE_FAIL:-0}" = 1 ]; then
  printf 'fixture failure\n' >&2
  exit 17
fi
printf 'adopted: %s\n' "${FLY1716_ADOPTED:-0}"
SH
chmod +x "$TMP/bin/node"

old_id="20000000-0000-4000-8000-000000000001"
gen_a="30000000-0000-4000-8000-000000000001"

setup_case() {
  local name="$1"
  CASE_ROOT="$TMP/$name"
  STATE_ROOT="$CASE_ROOT/state-root"
  PROJECT_NAME="fixture-project"
  LEAD_ID="fixture-lead"
  IDENTITY="${PROJECT_NAME}-${LEAD_ID}"
  SESSION_FILE="$CASE_ROOT/sessions/${IDENTITY}.session-id"
  GEN_FILE="$STATE_ROOT/state/lead-launch-gen/${IDENTITY}.gen"
  RECEIPT_DIR="$STATE_ROOT/state/lead-clear-receipt/${IDENTITY}"
  AUDIT_FILE="$RECEIPT_DIR/audit.jsonl"
  CALLS="$CASE_ROOT/calls"
  STDOUT_FILE="$CASE_ROOT/stdout"
  STDERR_FILE="$CASE_ROOT/stderr"
  COMM_CLI="$CASE_ROOT/comm-cli.js"
  COMM_DB="$CASE_ROOT/comm.db"
  HOME_DIR="$CASE_ROOT/home"
  IDENTITY_FILE="$HOME_DIR/.claude/agents/${LEAD_ID}.md"
  mkdir -p "$(dirname "$SESSION_FILE")" "$(dirname "$GEN_FILE")" \
    "$(dirname "$IDENTITY_FILE")"
  printf '# fixture Lead identity\n' > "$IDENTITY_FILE"
  printf '%s\n' "$old_id" > "$SESSION_FILE"
  printf '%s\n' "$gen_a" > "$GEN_FILE"
  : > "$CALLS"
  : > "$COMM_CLI"
  : > "$COMM_DB"
}

clear_input() {
  local session_id="$1"
  printf '{"hook_event_name":"SessionStart","source":"clear","agent_type":"%s","session_id":"%s"}' \
    "$LEAD_ID" "$session_id"
}

run_hook() {
  local session_id="$1" launch_gen="${2:-$gen_a}" timeout="${3:-2}"
  : > "$STDOUT_FILE"
  : > "$STDERR_FILE"
  printf '%s' "$(clear_input "$session_id")" | env \
    PATH="$TMP/bin:$PATH" \
    FLY1716_CALLS="$CALLS" \
    FLY1716_ADOPTED="${FLY1716_ADOPTED:-0}" \
    FLY1716_NODE_FAIL="${FLY1716_NODE_FAIL:-0}" \
    LEAD_ID="$LEAD_ID" \
    FLYWHEEL_LEAD_ID="$LEAD_ID" \
    FLYWHEEL_PROJECT_NAME="$PROJECT_NAME" \
    FLYWHEEL_LEAD_LAUNCH_GEN="$launch_gen" \
    FLYWHEEL_SESSION_ID_FILE="$SESSION_FILE" \
    FLYWHEEL_LEAD_AUTHORITY_LIB="$AUTHORITY_LIB" \
    FLYWHEEL_LEAD_AUTHORITY_TIMEOUT_SEC="$timeout" \
    FLYWHEEL_STATE_DIR="$STATE_ROOT" \
    FLYWHEEL_COMM_CLI="$COMM_CLI" \
    FLYWHEEL_COMM_DB="$COMM_DB" \
    HOME="$HOME_DIR" \
    LEAD_WORKSPACE= \
    bash "$HOOK" > "$STDOUT_FILE" 2> "$STDERR_FILE"
}

new_a="20000000-0000-4000-8000-000000000002"
setup_case normal
FLY1716_ADOPTED=3 run_hook "$new_a"
receipt_a="$RECEIPT_DIR/${gen_a}-${new_a}.json"
if [ "$(cat "$SESSION_FILE")" = "$new_a" ] \
  && [ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 1 ] \
  && grep -q "$old_id" "${SESSION_FILE}.history" \
  && grep -q '3 条在途消息' "$STDOUT_FILE" \
  && grep -q 'clear-bootstrap' "$STDOUT_FILE" \
  && grep -Fq "$IDENTITY_FILE" "$STDOUT_FILE" \
  && jq -e '.status == "completed" and .steps.fence.ok == true and
    .steps.claim.state == "created" and .steps.adopt.ok == true and
    .steps.adopt.count == 3 and .steps.writeback.ok == true and
    .steps.bootstrap.ok == true' "$receipt_a" >/dev/null; then
  ok "clear adopts once, writes the new session ID, bootstraps, and completes its keyed receipt"
else
  bad "normal clear handoff did not complete every durable step"
fi

setup_case stale-generation
new_stale="20000000-0000-4000-8000-000000000003"
gen_b="30000000-0000-4000-8000-000000000002"
printf '%s\n' "$gen_b" > "$GEN_FILE"
run_hook "$new_stale" "$gen_a"
if [ "$(cat "$SESSION_FILE")" = "$old_id" ] \
  && [ ! -s "$CALLS" ] \
  && rg -q 'generation_fenced' "$AUDIT_FILE"; then
  ok "an old launcher generation is fenced before every business side effect"
else
  bad "stale generation reached a business side effect"
fi

setup_case toctou
new_toctou="20000000-0000-4000-8000-000000000004"
lock_dir="$STATE_ROOT/state/lead-authority-lock/$IDENTITY"
mkdir -p "$lock_dir"
printf '%s\t%s\tparent-hold\n' "$$" "$(date +%s)" > "$lock_dir/owner"
run_hook "$new_toctou" "$gen_a" 2 &
hook_pid=$!
sleep 0.2
printf '%s\n' "$gen_b" > "$GEN_FILE"
rm -f "$lock_dir/owner"
rmdir "$lock_dir"
wait "$hook_pid"
if [ "$(cat "$SESSION_FILE")" = "$old_id" ] \
  && [ ! -s "$CALLS" ] \
  && rg -q 'generation_fenced' "$AUDIT_FILE"; then
  ok "generation is rechecked after lock acquisition, closing the launcher TOCTOU"
else
  bad "TOCTOU generation rotation was not fenced"
fi

setup_case replay
new_b="20000000-0000-4000-8000-000000000005"
new_c="20000000-0000-4000-8000-000000000006"
run_hook "$new_b"
run_hook "$new_c"
run_hook "$new_b"
if [ "$(cat "$SESSION_FILE")" = "$new_c" ] \
  && [ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 2 ] \
  && jq -e '.status == "completed"' "$RECEIPT_DIR/${gen_a}-${new_b}.json" >/dev/null \
  && jq -e '.status == "completed"' "$RECEIPT_DIR/${gen_a}-${new_c}.json" >/dev/null; then
  ok "B completed → C completed → replay B is a pure no-op and cannot roll back C"
else
  bad "completed replay repeated adoption or rolled back the session ID"
fi

setup_case pending-replay
new_pending="20000000-0000-4000-8000-000000000007"
mkdir -p "$RECEIPT_DIR"
jq -nc --arg gen "$gen_a" --arg session "$new_pending" '{
  status:"pending",key:{gen:$gen,newSessionId:$session}
}' > "$RECEIPT_DIR/${gen_a}-${new_pending}.json"
run_hook "$new_pending"
if [ "$(cat "$SESSION_FILE")" = "$old_id" ] \
  && [ ! -s "$CALLS" ] \
  && jq -e '.status == "pending"' "$RECEIPT_DIR/${gen_a}-${new_pending}.json" >/dev/null; then
  ok "a pending replay performs zero business side effects"
else
  bad "pending replay repeated a business side effect"
fi

setup_case malformed-claim
new_malformed="20000000-0000-4000-8000-000000000008"
mkdir -p "$RECEIPT_DIR"
printf '{bad-json\n' > "$RECEIPT_DIR/${gen_a}-${new_malformed}.json"
run_hook "$new_malformed"
if [ "$(cat "$SESSION_FILE")" = "$old_id" ] \
  && [ ! -s "$CALLS" ] \
  && rg -q 'claim_malformed' "$AUDIT_FILE"; then
  ok "a malformed keyed receipt is an authority failure with zero side effects"
else
  bad "malformed keyed receipt reached a business side effect"
fi

setup_case invalid-session
run_hook 'not-a-uuid'
if [ "$(cat "$SESSION_FILE")" = "$old_id" ] && [ ! -s "$CALLS" ]; then
  ok "a malformed SessionStart session_id is rejected before the lock"
else
  bad "malformed session_id reached a business side effect"
fi

setup_case adopt-failure
new_adopt_fail="20000000-0000-4000-8000-000000000009"
FLY1716_NODE_FAIL=1 run_hook "$new_adopt_fail"
if [ "$(cat "$SESSION_FILE")" = "$new_adopt_fail" ] \
  && grep -q 'clear-bootstrap' "$STDOUT_FILE" \
  && jq -e '.status == "completed" and .steps.adopt.ok == false and
    .steps.writeback.ok == true and .steps.bootstrap.ok == true' \
    "$RECEIPT_DIR/${gen_a}-${new_adopt_fail}.json" >/dev/null; then
  ok "adoption failure is recorded but does not short-circuit writeback or bootstrap"
else
  bad "adoption failure short-circuited an independent business step"
fi

setup_case writeback-failure
new_write_fail="20000000-0000-4000-8000-000000000010"
chmod 500 "$(dirname "$SESSION_FILE")"
run_hook "$new_write_fail"
chmod 700 "$(dirname "$SESSION_FILE")"
if [ "$(cat "$SESSION_FILE")" = "$old_id" ] \
  && [ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 1 ] \
  && grep -q 'clear-bootstrap' "$STDOUT_FILE" \
  && jq -e '.status == "completed" and .steps.adopt.ok == true and
    .steps.writeback.ok == false and .steps.bootstrap.ok == true' \
    "$RECEIPT_DIR/${gen_a}-${new_write_fail}.json" >/dev/null; then
  ok "writeback failure is recorded without suppressing adoption or bootstrap"
else
  bad "writeback failure short-circuited another business step"
fi

setup_case bootstrap-missing
new_bootstrap_missing="20000000-0000-4000-8000-000000000013"
rm -f "$IDENTITY_FILE"
run_hook "$new_bootstrap_missing"
if [ "$(cat "$SESSION_FILE")" = "$new_bootstrap_missing" ] \
  && [ "$(wc -l < "$CALLS" | tr -d ' ')" -eq 1 ] \
  && ! grep -q 'clear-bootstrap' "$STDOUT_FILE" \
  && grep -q 'identity file missing' "$STDERR_FILE" \
  && jq -e '.status == "completed" and .steps.adopt.ok == true and
    .steps.writeback.ok == true and .steps.bootstrap.ok == false' \
    "$RECEIPT_DIR/${gen_a}-${new_bootstrap_missing}.json" >/dev/null; then
  ok "a missing real identity file is visible and recorded without short-circuiting continuity"
else
  bad "missing identity file was falsely reported as a successful bootstrap"
fi

setup_case lock-timeout
new_lock="20000000-0000-4000-8000-000000000011"
lock_dir="$STATE_ROOT/state/lead-authority-lock/$IDENTITY"
mkdir -p "$lock_dir"
printf '%s\t%s\tparent-hold\n' "$$" "$(date +%s)" > "$lock_dir/owner"
run_hook "$new_lock" "$gen_a" 0
if [ "$(cat "$SESSION_FILE")" = "$old_id" ] \
  && [ ! -s "$CALLS" ] \
  && rg -q 'lock_timeout' "$AUDIT_FILE"; then
  ok "hook lock timeout is fail-closed and audited"
else
  bad "hook lock timeout reached a business side effect"
fi

setup_case claim-failure
new_claim="20000000-0000-4000-8000-000000000012"
mkdir -p "$(dirname "$RECEIPT_DIR")"
printf 'blocks-directory\n' > "$RECEIPT_DIR"
run_hook "$new_claim"
if [ "$(cat "$SESSION_FILE")" = "$old_id" ] && [ ! -s "$CALLS" ]; then
  ok "claim persistence failure occurs before every business side effect"
else
  bad "claim persistence failure reached a business side effect"
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
