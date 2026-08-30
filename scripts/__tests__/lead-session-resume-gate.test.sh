#!/bin/bash
# FLY-1716: a Lead may resume only when the previous transcript is provably safe.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE_LIB="$ROOT/packages/teamlead/scripts/lib/lead-session-resume-gate.sh"
AUTHORITY_LIB="$ROOT/packages/teamlead/scripts/lib/lead-session-authority.sh"
READER="$ROOT/packages/teamlead/scripts/lib/session-ctx-usage.mjs"
TMP="$(mktemp -d /tmp/fly1716-resume-gate.XXXXXX)"
PASS=0
FAIL=0
trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }
log() { printf '%s\n' "$*" >> "$TMP/gate.log"; }

if [ ! -f "$GATE_LIB" ] || [ ! -f "$AUTHORITY_LIB" ]; then
  bad "resume-gate and shared authority libraries exist"
  printf '%d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

SCRIPT_DIR="$ROOT/packages/teamlead/scripts"
FLYWHEEL_ROOT="$ROOT"
# shellcheck disable=SC1090
source "$GATE_LIB"

assistant_line() {
  local input="$1" output="${2:-0}" model="${3:-claude-haiku-4-5-20251001}"
  jq -nc --arg model "$model" --argjson input "$input" --argjson output "$output" '{
    type:"assistant",
    message:{model:$model,role:"assistant",usage:{
      input_tokens:$input,
      cache_read_input_tokens:0,
      cache_creation_input_tokens:0,
      output_tokens:$output
    }}
  }'
}

setup_case() {
  local name="$1" session_id="$2" model="${3:-claude-haiku-4-5-20251001}"
  CASE_ROOT="$TMP/$name"
  FLYWHEEL_STATE_DIR="$CASE_ROOT/state-root"
  CLAUDE_CONFIG_DIR="$CASE_ROOT/claude-config"
  LEAD_WORKSPACE="$CASE_ROOT/workspace"
  PROJECT_NAME="fixture-project"
  LEAD_ID="fixture-lead"
  SESSION_ID_FILE="$CASE_ROOT/sessions/${PROJECT_NAME}-${LEAD_ID}.session-id"
  FLYWHEEL_LEAD_CTX_RESUME_GATE=1
  FLYWHEEL_LEAD_CTX_RESUME_MAX=70
  FLYWHEEL_LEAD_AUTHORITY_TIMEOUT_SEC=1
  _FLY1496_PRE_RESOLVED_RESULT="$(jq -nc --arg model "$model" '{ok:true,decision:{model:$model}}')"
  mkdir -p "$(dirname "$SESSION_ID_FILE")" "$LEAD_WORKSPACE" "$CLAUDE_CONFIG_DIR"
  if [ -n "$session_id" ]; then
    printf '%s\n' "$session_id" > "$SESSION_ID_FILE"
  fi
  TRANSCRIPT_DIR="$CLAUDE_CONFIG_DIR/projects/$(_lead_session_project_slug "$LEAD_WORKSPACE")"
  TRANSCRIPT_FILE="$TRANSCRIPT_DIR/${session_id}.jsonl"
  mkdir -p "$TRANSCRIPT_DIR"
}

receipt_file() {
  printf '%s/state/lead-launch-gate/%s-%s.json' \
    "$FLYWHEEL_STATE_DIR" "$PROJECT_NAME" "$LEAD_ID"
}

safe_id="10000000-0000-4000-8000-000000000001"
setup_case safe "$safe_id"
assistant_line 10000 > "$TRANSCRIPT_FILE"
if lead_session_prepare \
  && [ "$_v2_is_resume" = true ] \
  && [ "$_v2_session_id" = "$safe_id" ] \
  && [ ! -e "${SESSION_ID_FILE}.parked-safe_resume" ] \
  && jq -e '.verdict == "safe_resume" and .action == "resumed" and .window == 200000' \
    "$(receipt_file)" >/dev/null; then
  ok "a provably safe 200k session resumes with an audit receipt"
else
  bad "safe session did not resume"
fi

unsafe_id="10000000-0000-4000-8000-000000000002"
setup_case unsafe "$unsafe_id"
assistant_line 140000 > "$TRANSCRIPT_FILE"
if lead_session_prepare \
  && [ "$_v2_is_resume" = false ] \
  && [ -z "$_v2_session_id" ] \
  && [ ! -e "$SESSION_ID_FILE" ] \
  && find "$(dirname "$SESSION_ID_FILE")" -maxdepth 1 \
    -name "$(basename "$SESSION_ID_FILE").parked-unsafe-ctx70pct-*" -print | grep -q . \
  && jq -e '.verdict == "unsafe" and .action == "parked" and .estTokens == 140001' \
    "$(receipt_file)" >/dev/null; then
  ok "an unsafe session is parked before launch"
else
  bad "unsafe session was not parked"
fi

unknown_id="10000000-0000-4000-8000-000000000003"
setup_case unknown "$unknown_id"
if lead_session_prepare \
  && [ "$_v2_is_resume" = false ] \
  && find "$(dirname "$SESSION_ID_FILE")" -maxdepth 1 \
    -name "$(basename "$SESSION_ID_FILE").parked-unknown-ctxnapct-*" -print | grep -q . \
  && jq -e '.verdict == "unknown" and .reason == "transcript_missing" and .action == "parked"' \
    "$(receipt_file)" >/dev/null; then
  ok "an unknown transcript fails closed to parked+fresh"
else
  bad "unknown transcript did not fail closed"
fi

retired_bypass_id="10000000-0000-4000-8000-000000000004"
setup_case retired-bypass "$retired_bypass_id"
FLYWHEEL_LEAD_CTX_RESUME_GATE=0
if lead_session_prepare \
  && [ "$_v2_is_resume" = false ] \
  && [ ! -e "$SESSION_ID_FILE" ] \
  && jq -e '.gate == "enabled" and .verdict == "unknown" and .action == "parked"' \
    "$(receipt_file)" >/dev/null; then
  ok "the retired bypass cannot resume an unverified session"
else
  bad "retired bypass skipped the resume safety gate"
fi

million_id="10000000-0000-4000-8000-000000000005"
setup_case million "$million_id" 'claude-opus-5[1m]'
assistant_line 700000 0 'claude-opus-5' > "$TRANSCRIPT_FILE"
if lead_session_prepare \
  && [ "$_v2_is_resume" = false ] \
  && jq -e '.window == 1000000 and .verdict == "unsafe"' "$(receipt_file)" >/dev/null; then
  ok "the frozen canonical model decision selects the 1M reader window"
else
  bad "1M model decision and gate window diverged"
fi

# Anonymized from the 2026-08-15 production QA cross-check: Claude Code's
# statusline reported 52% for the same Sonnet 5 session whose last assistant
# usage was 524,777 tokens. The two independent measurements imply a 1M window.
measured_id="10000000-0000-4000-8000-000000000014"
setup_case measured-sonnet "$measured_id" 'claude-sonnet-5'
cp "$ROOT/scripts/__tests__/fixtures/fly1716/belle-transcript.jsonl" "$TRANSCRIPT_FILE"
reported_pct="$(jq -r '.context_window.used_percentage' \
  "$ROOT/scripts/__tests__/fixtures/fly1716/belle-statusline.json")"
if lead_session_prepare \
  && [ "$_v2_is_resume" = true ] \
  && [ "$_v2_session_id" = "$measured_id" ] \
  && jq -e --argjson reported "$reported_pct" '
    .model == "claude-sonnet-5" and .window == 1000000 and
    .windowSource == "qa_same_session_measurement_2026_08_15" and
    .base == 524777 and .verdict == "safe_resume" and .action == "resumed" and
    ((.base * 100 / .window) | floor) == $reported
  ' "$(receipt_file)" >/dev/null; then
  ok "the measured Sonnet 5 fixture agrees with Claude's real 52% statusline"
else
  bad "the measured Sonnet 5 fixture was assigned the wrong context window"
fi

fable_band_id="10000000-0000-4000-8000-000000000015"
setup_case fable-failure-band "$fable_band_id" 'claude-fable-5'
assistant_line 180000 0 'claude-fable-5' > "$TRANSCRIPT_FILE"
if lead_session_prepare \
  && [ "$_v2_is_resume" = true ] \
  && jq -e '.window == 1000000 and .verdict == "safe_resume" and
    .estTokens == 180001' "$(receipt_file)" >/dev/null; then
  ok "a healthy Fable 5 session in the former 140k-200k failure band resumes"
else
  bad "Fable 5 still uses the false 200k window in the production failure band"
fi

unknown_model_id="10000000-0000-4000-8000-000000000016"
setup_case unknown-model "$unknown_model_id" 'claude-future-unknown'
assistant_line 10000 0 'claude-future-unknown' > "$TRANSCRIPT_FILE"
if lead_session_prepare \
  && [ "$_v2_is_resume" = false ] \
  && jq -e '.window == null and .windowSource == "unknown_model_fail_closed" and
    .verdict == "unknown" and .reason == "unknown_model_window" and
    .action == "parked"' "$(receipt_file)" >/dev/null; then
  ok "an unknown model window is explicit and fails closed instead of guessing"
else
  bad "an unknown model silently inherited a guessed context window"
fi

setup_case fresh ""
if lead_session_prepare \
  && [ "$_v2_is_resume" = false ] \
  && [ -z "$_v2_session_id" ] \
  && jq -e '.verdict == "no_session" and .action == "fresh"' "$(receipt_file)" >/dev/null; then
  ok "an absent session stays on the existing fresh path"
else
  bad "fresh path did not receive a launch generation and receipt"
fi

invalid_threshold_id="10000000-0000-4000-8000-000000000009"
setup_case invalid-threshold "$invalid_threshold_id"
assistant_line 10000 > "$TRANSCRIPT_FILE"
FLYWHEEL_LEAD_CTX_RESUME_MAX=70.5
if lead_session_prepare \
  && [ "$_v2_is_resume" = false ] \
  && jq -e '.verdict == "unknown" and .reason == "invalid_threshold" and
    .threshold == null and .action == "parked"' "$(receipt_file)" >/dev/null; then
  if grep -q 'WARNING: Context resume gate returned unknown.*invalid_threshold' "$TMP/gate.log"; then
    ok "an invalid configured threshold fails closed and emits a searchable warning"
  else
    bad "invalid configured threshold was not visible in the launcher log"
  fi
else
  bad "invalid configured threshold did not fail closed"
fi

lock_id="10000000-0000-4000-8000-000000000006"
setup_case lock-timeout "$lock_id"
assistant_line 10000 > "$TRANSCRIPT_FILE"
lock_dir="$FLYWHEEL_STATE_DIR/state/lead-authority-lock/${PROJECT_NAME}-${LEAD_ID}"
mkdir -p "$lock_dir"
printf '%s\t%s\tfixture-owner\n' "$$" "$(date +%s)" > "$lock_dir/owner"
FLYWHEEL_LEAD_AUTHORITY_TIMEOUT_SEC=0
if ! lead_session_prepare && [ "$(cat "$SESSION_ID_FILE")" = "$lock_id" ]; then
  ok "launcher authority-lock timeout aborts without session mutation"
else
  bad "authority-lock timeout did not fail closed"
fi

gen_id="10000000-0000-4000-8000-000000000007"
setup_case gen-failure "$gen_id"
assistant_line 10000 > "$TRANSCRIPT_FILE"
mkdir -p "$FLYWHEEL_STATE_DIR/state/lead-launch-gen"
chmod 500 "$FLYWHEEL_STATE_DIR/state/lead-launch-gen"
if ! lead_session_prepare && [ "$(cat "$SESSION_ID_FILE")" = "$gen_id" ]; then
  ok "generation persistence failure aborts without session mutation"
else
  bad "generation write failure did not fail closed"
fi
chmod 700 "$FLYWHEEL_STATE_DIR/state/lead-launch-gen"

history_id="10000000-0000-4000-8000-000000000008"
setup_case history "$history_id"
assistant_line 10000 > "$TRANSCRIPT_FILE"
lead_session_prepare >/dev/null
lead_session_prepare >/dev/null
history_file="$(receipt_file).history"
if [ -f "$history_file" ] && [ "$(wc -l < "$history_file" | tr -d ' ')" -eq 1 ]; then
  ok "each launch receipt archives the previous value as JSONL history"
else
  bad "launch receipt history was not append-only"
fi

slug="$(_lead_session_project_slug '/Users/xiaorongli/.flywheel/lead-workspace/flywheel-cos-lead')"
if [ "$slug" = '-Users-xiaorongli--flywheel-lead-workspace-flywheel-cos-lead' ]; then
  ok "Claude project slug derivation matches the real Cass transcript directory"
else
  bad "Claude project slug derivation drifted ($slug)"
fi

production_slug_id="10000000-0000-4000-8000-000000000010"
setup_case production-slug "$production_slug_id"
LEAD_WORKSPACE="$CASE_ROOT/home/.flywheel/lead-workspace/$LEAD_ID"
expected_slug="$(printf '%s' "$LEAD_WORKSPACE" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
TRANSCRIPT_DIR="$CLAUDE_CONFIG_DIR/projects/$expected_slug"
TRANSCRIPT_FILE="$TRANSCRIPT_DIR/${production_slug_id}.jsonl"
mkdir -p "$TRANSCRIPT_DIR"
assistant_line 10000 > "$TRANSCRIPT_FILE"
if lead_session_prepare \
  && [ "$_v2_is_resume" = true ] \
  && [ "$_v2_session_id" = "$production_slug_id" ] \
  && ! find "$(dirname "$SESSION_ID_FILE")" -maxdepth 1 \
    -name "$(basename "$SESSION_ID_FILE").parked-*" -print | grep -q .; then
  ok "a healthy production-shaped .flywheel transcript resumes instead of silently parking"
else
  bad "production-shaped healthy transcript did not resume"
fi

packaged_id="10000000-0000-4000-8000-000000000011"
setup_case packaged-reader "$packaged_id"
assistant_line 10000 > "$TRANSCRIPT_FILE"
source_script_dir="$SCRIPT_DIR"
source_flywheel_root="$FLYWHEEL_ROOT"
SCRIPT_DIR="$CASE_ROOT/node_modules/flywheel-teamlead/scripts"
FLYWHEEL_ROOT="$CASE_ROOT"
mkdir -p "$SCRIPT_DIR/lib"
cp "$READER" "$SCRIPT_DIR/lib/session-ctx-usage.mjs"
if lead_session_prepare \
  && [ "$_v2_is_resume" = true ] \
  && jq -e '.verdict == "safe_resume" and .action == "resumed"' \
    "$(receipt_file)" >/dev/null; then
  ok "the packaged launcher resolves the reader from its shipped scripts/lib closure"
else
  bad "packaged launcher could not resolve the shipped context reader"
fi
SCRIPT_DIR="$source_script_dir"
FLYWHEEL_ROOT="$source_flywheel_root"

receipt_failure_id="10000000-0000-4000-8000-000000000012"
setup_case receipt-failure "$receipt_failure_id"
assistant_line 10000 > "$TRANSCRIPT_FILE"
mkdir -p "$FLYWHEEL_STATE_DIR/state"
printf 'blocks receipt directory\n' > "$FLYWHEEL_STATE_DIR/state/lead-launch-gate"
if lead_session_prepare \
  && [ "$_v2_is_resume" = true ] \
  && [ "$(cat "$SESSION_ID_FILE")" = "$receipt_failure_id" ] \
  && grep -q 'WARNING: failed to persist Lead context gate receipt' "$TMP/gate.log"; then
  ok "an audit-receipt failure warns without preventing a safe Lead launch"
else
  bad "audit-receipt failure incorrectly aborted or mutated the Lead launch"
fi

dead_owner_id="10000000-0000-4000-8000-000000000013"
setup_case dead-owner "$dead_owner_id"
assistant_line 10000 > "$TRANSCRIPT_FILE"
dead_lock_dir="$FLYWHEEL_STATE_DIR/state/lead-authority-lock/${PROJECT_NAME}-${LEAD_ID}"
mkdir -p "$dead_lock_dir"
printf '999999999\t%s\tdead-owner\n' "$(date +%s)" > "$dead_lock_dir/owner"
FLYWHEEL_LEAD_AUTHORITY_TIMEOUT_SEC=0
if lead_session_prepare \
  && [ "$_v2_is_resume" = true ] \
  && [ ! -e "$dead_lock_dir" ]; then
  ok "a provably dead lock owner is reaped immediately"
else
  bad "dead lock owner waited for the malformed-lock stale window"
fi

resolver_body_count="$(grep -c 'await import(process.env.FLY1496_ENTRY)' \
  "$ROOT/packages/teamlead/scripts/claude-lead.sh")"
if [ "$resolver_body_count" -eq 1 ] \
  && grep -q '^[[:space:]]*_pre_resolve_lead_model_decision$' "$ROOT/packages/teamlead/scripts/claude-lead.sh" \
  && grep -q '_fly1496_result="\$_FLY1496_PRE_RESOLVED_RESULT"' \
    "$ROOT/packages/teamlead/scripts/claude-lead.sh"; then
  ok "resume gate and launcher share one frozen canonical model decision"
else
  bad "model resolution is duplicated or not shared with the launcher"
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
