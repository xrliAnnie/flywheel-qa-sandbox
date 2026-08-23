#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SELF="$ROOT/scripts/__tests__/test-auto-approve-identity.test.sh"
SCRIPT="$ROOT/scripts/test-auto-approve.sh"
GENERALIZED="$ROOT/scripts/qa-529-generalized-e2e.mjs"
DEPLOY="$ROOT/scripts/test-deploy.sh"
DRIVER="$ROOT/scripts/qa-fly-60-driver.sh"
REPORT="$ROOT/scripts/qa-fly-60-report-html.sh"
SUITE="$ROOT/packages/qa-framework/suites/fly-60-hard-gate.md"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1981-auto-approve.XXXXXX")"
SLOT_ID=1
SLOT_ROOT="$TMP/slots"
SLOT_DIR="$SLOT_ROOT/flywheel-test-slot-${SLOT_ID}"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_source_contract() {
  local live_slot_pattern='/tmp/flywheel-test''-slot-'
  if rg -n "$live_slot_pattern" "$SELF" >/dev/null; then
    fail "contract test must never name or mutate a live slot path"
  fi
  rg -q 'TEST_AUTO_APPROVE_SLOT_ROOT' "$SCRIPT" || \
    fail "helper must expose a temporary slot-root seam for isolated tests"
  if rg -n -e 'approval-intent' -e 'flywheel-comm respond' -e 'COMM_CLI' \
    -e 'lead-identity resolve' "$SCRIPT" >/dev/null; then
    fail "auto-approve helper must not use approval-intent respond or project a Lead identity"
  fi
  if rg -n -U 'holder\.question_id,[[:space:][:print:]]{0,240}"approve"' \
    "$GENERALIZED" >/dev/null; then
    fail "529 founder approval must not use holder-bound flywheel-comm respond"
  fi
  rg -q '/api/actions/approve' "$SCRIPT" || fail "helper must POST /api/actions/approve"
  rg -q '/api/actions/approve' "$GENERALIZED" || fail "529 driver must POST /api/actions/approve"
  rg -Fq 'body: JSON.stringify({ execution_id: holder.source_execution_id })' \
    "$GENERALIZED" || fail "529 approve body must be exactly holder execution_id"
  if rg -n 'leadId|lead_id' "$SCRIPT" >/dev/null; then
    fail "helper approve request must not contain leadId"
  fi
  if rg -n 'FLYWHEEL_FOUNDER_ATTRIBUTION_GATE' "$DEPLOY" >/dev/null; then
    fail "test-deploy must not inject the retired attribution bypass"
  fi
  if rg -n 'resolveFounderAttributionGateOn|ATTRIBUTION_GATE_KEY' \
    "$ROOT/packages/flywheel-comm/src" --glob '!__tests__/**' >/dev/null; then
    fail "flywheel-comm must not retain an active attribution-gate resolver"
  fi
  if rg -n 'flywheel-comm respond.*approve' "$DEPLOY" >/dev/null; then
    fail "test identity must not teach Lead-attributed ship approval"
  fi
  if rg -ni 'getPendingGateByRunner|gateUnblocked[^[:alnum:]]*false|pending[- ]gate.*fallback' \
    "$DEPLOY" >/dev/null; then
    fail "test-deploy must not teach an unbound/pending-gate approval fallback"
  fi
  if rg -n 'gate approve_to_ship' "$DEPLOY" | rg -v -- '--no-block' \
    >/dev/null; then
    fail "every test-deploy approve gate example must be non-blocking"
  fi
  for source in "$DEPLOY" "$REPORT"; do
    rg -q 'gate approve_to_ship --no-block' "$source" || \
      fail "$(basename "$source") must document the non-blocking gate"
    rg -q 'complete --route needs_review --question-id' "$source" || \
      fail "$(basename "$source") must document the bound review handoff"
    rg -q '/api/actions/approve' "$source" || \
      fail "$(basename "$source") must document the approval endpoint"
    rg -q 'verify-approval' "$source" || \
      fail "$(basename "$source") must document final ship authority"
  done
  if rg -ni 'approveExecution.*deadlock|production.*(bypass|never).*endpoint|flywheel-comm respond' \
    "$REPORT" >/dev/null; then
    fail "report generator must not render the retired approval narrative"
  fi
  if rg -n 'HP_RESPOND_TIMEOUT_S' "$DRIVER" >/dev/null; then
    fail "FLY-60 driver must not retain the unused respond fallback timeout"
  fi
  if rg -ni 'HP-7 fallback|HP-6 state \(gate-blocked\)' "$SUITE" "$DRIVER" \
    >/dev/null; then
    fail "FLY-60 docs/driver must call HP-6 a durable awaiting_review handoff"
  fi
  if rg -ni 'pane is owned by.*flywheel-comm gate.*polling process' "$SUITE" \
    >/dev/null; then
    fail "FLY-60 suite must not describe the retired blocking gate process"
  fi
}

mkdir -p "$TMP/home/.flywheel/comm/test-slot-${SLOT_ID}" "$TMP/bin" "$SLOT_DIR/state"
: > "$TMP/home/.flywheel/comm/test-slot-${SLOT_ID}/comm.db"
: > "$SLOT_DIR/teamlead.db"
printf '%s\n' '{"slots":[{"bridgePort":9876,"botName":"test-lead"}]}' \
  > "$TMP/home/.flywheel/test-slots.json"

cat > "$TMP/bin/sqlite3" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SQLITE_CALLS"
query="${*: -1}"
case "$query" in
  *"FROM sessions"*)
    if [[ -f "$AUTO_APPROVE_MARKER" ]]; then
      printf 'approved_to_ship|question-1|%040d\n' 0
    else
      printf '%s\n' "${SQLITE_SESSION_ROW:-awaiting_review|question-1|0000000000000000000000000000000000000000}"
    fi
    ;;
  *"FROM mailbox_message_projection q"*)
    [[ "${GATE_STATE:-open}" == "open" ]] && \
      printf 'question-1|execution-1|approve_to_ship\n'
    ;;
  *"FROM mailbox_message_projection r"*)
    if [[ -f "$AUTO_APPROVE_MARKER" ]]; then
      printf 'bridge|{"approved":true}\n'
    fi
    ;;
esac
SH

cat > "$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *"/health"* ]]; then
  exit 0
fi
printf '%s\n' "$*" >> "$CURL_CALLS"
printf '%s\n' "$*" > "$CURL_LAST_CALL"
touch "$AUTO_APPROVE_MARKER"
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
if [[ "${CURL_AMBIGUOUS_FAILURE:-0}" == "1" ]]; then
  [[ -n "$output" ]] && printf '%s\n' '{"success":false,"message":"connection reset after commit"}' > "$output"
  printf '000'
  exit 7
fi
[[ -n "$output" ]] && printf '%s\n' '{"success":true,"gateUnblocked":true}' > "$output"
printf '200'
SH
chmod +x "$TMP/bin/sqlite3" "$TMP/bin/curl"

run_helper() {
  local name="$1"
  shift
  rm -f "$TMP/approved" "$TMP/curl.calls" "$TMP/curl.last"
  : > "$TMP/sqlite.calls"
  HOME="$TMP/home" \
    PATH="$TMP/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TEST_AUTO_APPROVE_SLOT_ROOT="$SLOT_ROOT" \
    AUTO_APPROVE_MARKER="$TMP/approved" \
    CURL_CALLS="$TMP/curl.calls" \
    CURL_LAST_CALL="$TMP/curl.last" \
    SQLITE_CALLS="$TMP/sqlite.calls" \
    "$@" \
    bash "$SCRIPT" "$SLOT_ID" execution-1 --timeout 10 --poll-interval 1 \
    >"$TMP/${name}.stdout" 2>"$TMP/${name}.stderr"
}

assert_source_contract

# Rendered HTML and stable Markdown must carry the same current wire as source.
REPORT_EVIDENCE="$TMP/report-run"
REPORT_STABLE="$TMP/stable-report.md"
mkdir -p "$REPORT_EVIDENCE/hp"
printf '%s\n' 'verdict=PASS' 'note=isolated report fixture' \
  > "$REPORT_EVIDENCE/hp/verdict.txt"
bash "$REPORT" --evidence-dir "$REPORT_EVIDENCE" --stable-md "$REPORT_STABLE" \
  >/dev/null
for rendered in "$REPORT_EVIDENCE/report.html" "$REPORT_STABLE"; do
  rg -q 'gate approve_to_ship --no-block' "$rendered" || \
    fail "generated $(basename "$rendered") omitted the non-blocking gate"
  rg -q 'complete --route needs_review --question-id' "$rendered" || \
    fail "generated $(basename "$rendered") omitted the bound review handoff"
  rg -q '/api/actions/approve' "$rendered" || \
    fail "generated $(basename "$rendered") omitted the approval endpoint"
  rg -q 'verify-approval' "$rendered" || \
    fail "generated $(basename "$rendered") omitted final ship authority"
  if rg -ni 'approveExecution.*deadlock|production.*(bypass|never).*endpoint|flywheel-comm respond' \
    "$rendered" >/dev/null; then
    fail "generated $(basename "$rendered") contains the retired approval narrative"
  fi
done

# No token file: endpoint remains usable in ordinary loopback-only QA rooms.
if ! run_helper tokenless env; then
  cat "$TMP/tokenless.stderr" >&2
  fail "tokenless endpoint approval failed"
fi
[[ "$(wc -l < "$TMP/curl.calls" | tr -d ' ')" == "1" ]] || \
  fail "tokenless success must POST exactly once"
grep -q -- '--data-binary {"execution_id":"execution-1"}' "$TMP/curl.last" || \
  fail "approve body must be exactly execution_id"
if grep -qi 'authorization:' "$TMP/curl.last"; then
  fail "tokenless room must not send an empty Authorization header"
fi
grep -Fq "$SLOT_DIR/teamlead.db" "$TMP/sqlite.calls" || \
  fail "helper did not read the isolated temporary StateStore"
grep -Fq "$TMP/home/.flywheel/comm/test-slot-${SLOT_ID}/comm.db" \
  "$TMP/sqlite.calls" || fail "helper did not read the isolated temporary CommDB"

# Optional slot-local master token is sent as Bearer, never in the body.
printf '%s\n' 'slot-secret' > "$SLOT_DIR/state/api-token"
chmod 600 "$SLOT_DIR/state/api-token"
if ! run_helper bearer env; then
  cat "$TMP/bearer.stderr" >&2
  fail "Bearer endpoint approval failed"
fi
grep -q -- 'Authorization: Bearer slot-secret' "$TMP/curl.last" || \
  fail "slot token must be sent as Bearer"
grep -q -- '--data-binary {"execution_id":"execution-1"}' "$TMP/curl.last" || \
  fail "Bearer request body gained extra fields"
if grep -Eq 'leadId|lead_id' "$TMP/curl.last"; then
  fail "approve request must not contain a Lead identity"
fi

# The helper accepts only the exact legacy review state and complete binding.
for case_name in running unbound missing_question missing_head; do
  case "$case_name" in
    running) row='running|question-1|0000000000000000000000000000000000000000' ;;
    unbound) row='awaiting_review|unbound|0000000000000000000000000000000000000000' ;;
    missing_question) row='awaiting_review||0000000000000000000000000000000000000000' ;;
    missing_head) row='awaiting_review|question-1|' ;;
  esac
  set +e
  SQLITE_SESSION_ROW="$row" run_helper "$case_name" env
  rc=$?
  set -e
  [[ "$rc" -eq 3 ]] || fail "$case_name must time out/refuse before POST (rc=$rc)"
  [[ ! -s "$TMP/curl.calls" ]] || fail "$case_name must not call approve endpoint"
done

# Resolved, superseded, and disposed questions are all closed. Expiry is not
# checked here: unanswered protected gates deliberately remain durable/open.
for gate_state in resolved superseded disposed; do
  set +e
  GATE_STATE="$gate_state" run_helper "$gate_state" env
  rc=$?
  set -e
  [[ "$rc" -eq 3 ]] || fail "$gate_state gate must be refused (rc=$rc)"
  [[ ! -s "$TMP/curl.calls" ]] || fail "$gate_state gate must not POST"
done

# If the HTTP connection fails after the Bridge commits, reconcile the exact
# durable writer response plus approved_to_ship instead of blindly retrying.
if ! run_helper ambiguous env CURL_AMBIGUOUS_FAILURE=1; then
  cat "$TMP/ambiguous.stderr" >&2
  fail "ambiguous committed request did not reconcile"
fi
grep -q 'reconciled durable approval' "$TMP/ambiguous.stderr" || \
  fail "ambiguous HTTP failure must be reconciled from durable authority"

printf 'PASS: FLY-1981 auto-approve endpoint contract\n'
