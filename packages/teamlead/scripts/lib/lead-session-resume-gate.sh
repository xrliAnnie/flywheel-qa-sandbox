#!/bin/bash
# FLY-1716: resolve one launch generation and park any session that is not
# provably below the offline context threshold. Defines functions only.

_lead_authority_lib="${FLYWHEEL_LEAD_AUTHORITY_LIB:-${SCRIPT_DIR}/lib/lead-session-authority.sh}"
if [ -f "$_lead_authority_lib" ]; then
  # shellcheck source=lead-session-authority.sh
  # Source path can be overridden by the harness.
  # shellcheck disable=SC1091
  source "$_lead_authority_lib"
fi

_lead_session_project_slug() {
  local path="$1"
  printf '%s' "${path//[^a-zA-Z0-9]/-}"
}

_lead_session_model_from_decision() {
  local result="${_FLY1496_PRE_RESOLVED_RESULT:-}"
  if [ -n "$result" ] && jq -e '.ok == true' >/dev/null 2>&1 <<< "$result"; then
    jq -r '.decision.model' <<< "$result"
  else
    printf '%s\n' 'claude-fable-5'
  fi
}

_lead_session_model_window() {
  # Keep this table exact instead of inferring every unmarked model as 200k.
  # Sources:
  # - Bare Sonnet 5 and Fable 5: FLY-1716 production QA on 2026-08-15,
  #   cross-checking transcript usage against Claude Code's same-session
  #   statusline on four Leads (approximately 1M, under 1% error).
  # - [1m] and the explicit 200k compatibility ids: canonical model identities
  #   in packages/config/src/model-builtins.ts and the existing FLY-751 tier
  #   contract. Unknown ids deliberately have no numeric default: guessing high
  #   can resume a full session, while guessing low silently discards a healthy
  #   one. The restart safety guarantee therefore parks them as unknown.
  case "$1" in
    claude-fable-5|claude-sonnet-5|*"[1m]"*) printf '%s\n' 1000000 ;;
    claude-opus-5|claude-opus-4-8|claude-opus-4-6|claude-sonnet-4-6|claude-haiku-4-5-20251001)
      printf '%s\n' 200000
      ;;
    *) return 1 ;;
  esac
}

_lead_session_model_window_source() {
  case "$1" in
    claude-fable-5|claude-sonnet-5)
      printf '%s\n' qa_same_session_measurement_2026_08_15
      ;;
    *"[1m]"*) printf '%s\n' canonical_1m_model_id ;;
    claude-opus-5|claude-opus-4-8|claude-opus-4-6|claude-sonnet-4-6|claude-haiku-4-5-20251001)
      printf '%s\n' explicit_200k_compatibility_table
      ;;
    *) printf '%s\n' unknown_model_fail_closed ;;
  esac
}

_lead_session_atomic_write() {
  local target="$1" contents="$2" tmp
  tmp="${target}.tmp.$$"
  mkdir -p "$(dirname "$target")" 2>/dev/null || return 1
  if (umask 077 && printf '%s\n' "$contents" > "$tmp") \
    && mv "$tmp" "$target"; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  return 1
}

_lead_session_write_gate_receipt() {
  local target="$1" contents="$2" history line
  history="${target}.history"
  if [ -f "$target" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      printf '%s\n' "$line"
    done < "$target" >> "$history" || return 1
  fi
  _lead_session_atomic_write "$target" "$contents"
}

_lead_session_unknown_context() {
  local window="$1" threshold="$2" reason="$3"
  jq -nc --argjson window "$window" --argjson threshold "$threshold" --arg reason "$reason" '{
    verdict:"unknown",estTokens:null,base:null,tailBytes:null,
    window:$window,threshold:$threshold,reason:$reason
  }'
}

_lead_session_prepare_locked() {
  local gen_file="$1" receipt_file="$2"
  local model window window_source threshold threshold_json gen gen_tmp gate session_id ctx transcript_root
  local project_slug transcript reader verdict action gate_label pct ts parked receipt

  model="$(_lead_session_model_from_decision)"
  if ! window="$(_lead_session_model_window "$model")"; then
    window=null
  fi
  window_source="$(_lead_session_model_window_source "$model")"
  threshold="${FLYWHEEL_LEAD_CTX_RESUME_MAX:-70}"
  threshold_json=null
  if [[ "$threshold" =~ ^[1-9][0-9]*$ ]] && [ "$threshold" -le 100 ]; then
    threshold_json="$threshold"
  fi

  gen="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  [[ "$gen" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
    log "FATAL: failed to generate Lead launch generation"
    return 1
  }
  gen_tmp="${gen_file}.tmp.$$"
  mkdir -p "$(dirname "$gen_file")" 2>/dev/null || {
    log "FATAL: failed to create Lead launch generation directory"
    return 1
  }
  if ! (umask 077 && printf '%s\n' "$gen" > "$gen_tmp") \
    || ! mv "$gen_tmp" "$gen_file"; then
    rm -f "$gen_tmp" 2>/dev/null || true
    log "FATAL: failed to persist Lead launch generation"
    return 1
  fi
  # Consumed by claude-lead.sh's child env barrier.
  # shellcheck disable=SC2034
  FLYWHEEL_LEAD_LAUNCH_GEN="$gen"
  # Consumed by claude-lead.sh's child env barrier.
  # shellcheck disable=SC2034
  FLYWHEEL_SESSION_ID_FILE="$SESSION_ID_FILE"

  session_id=""
  if [ -s "$SESSION_ID_FILE" ]; then
    IFS= read -r session_id < "$SESSION_ID_FILE" || session_id=""
  fi
  _v2_session_id="$session_id"
  _v2_is_resume=false
  [ -z "$session_id" ] || _v2_is_resume=true

  gate_label="enabled"
  if [ -z "$session_id" ]; then
    action="fresh"
    ctx="$(jq -nc --argjson window "$window" --argjson threshold "$threshold_json" '{
      verdict:"no_session",estTokens:null,base:null,tailBytes:null,
      window:$window,threshold:$threshold,reason:"session_file_empty"
    }')"
  else
    if [ "$window" = null ]; then
      ctx="$(_lead_session_unknown_context "$window" "$threshold_json" unknown_model_window)"
    elif [[ ! "$session_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
      ctx="$(_lead_session_unknown_context "$window" "$threshold_json" invalid_session_id)"
    else
      transcript_root="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
      project_slug="$(_lead_session_project_slug "$LEAD_WORKSPACE")"
      transcript="${transcript_root}/projects/${project_slug}/${session_id}.jsonl"
      reader="${FLYWHEEL_SESSION_CTX_READER:-${SCRIPT_DIR}/lib/session-ctx-usage.mjs}"
      if [ -f "$reader" ]; then
        ctx="$(FLYWHEEL_LEAD_CTX_RESUME_MAX="$threshold" \
          node "$reader" --transcript "$transcript" --window "$window" 2>/dev/null || true)"
      else
        ctx=""
      fi
      if ! jq -e '.verdict == "safe_resume" or .verdict == "unsafe" or .verdict == "unknown"' \
        >/dev/null 2>&1 <<< "$ctx"; then
        ctx="$(_lead_session_unknown_context "$window" "$threshold_json" reader_invalid_output)"
      fi
    fi

    verdict="$(jq -r '.verdict' <<< "$ctx")"
    if [ "$verdict" = safe_resume ]; then
      action="resumed"
      _v2_is_resume=true
    else
      if [ "$verdict" = unknown ]; then
        log "WARNING: Context resume gate returned unknown for ${session_id}: $(jq -r '.reason' <<< "$ctx")"
      fi
      pct="na"
      if jq -e '.estTokens | type == "number"' >/dev/null 2>&1 <<< "$ctx"; then
        pct="$(jq -r '(.estTokens * 100 / .window) | floor' <<< "$ctx")"
      fi
      ts="$(date -u '+%Y%m%dT%H%M%SZ')"
      parked="${SESSION_ID_FILE}.parked-${verdict}-ctx${pct}pct-${ts}-${gen}"
      mv "$SESSION_ID_FILE" "$parked" || {
        log "FATAL: failed to park unsafe Lead session ${session_id}"
        return 1
      }
      action="parked"
      _v2_is_resume=false
      _v2_session_id=""
      log "Context resume gate: ${verdict}; parked ${session_id} before launch"
    fi
  fi

  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  receipt="$(jq -nc \
    --arg gate "$gate_label" \
    --arg sessionId "$session_id" \
    --arg gen "$gen" \
    --arg ts "$ts" \
    --arg action "$action" \
    --arg model "$model" \
    --arg windowSource "$window_source" \
    --argjson ctx "$ctx" \
    '$ctx + {gate:$gate,sessionId:$sessionId,gen:$gen,ts:$ts,action:$action,model:$model,windowSource:$windowSource}')" \
    || return 1
  if ! _lead_session_write_gate_receipt "$receipt_file" "$receipt"; then
    log "WARNING: failed to persist Lead context gate receipt: ${receipt_file}"
  fi
  return 0
}

lead_session_prepare() {
  local state_root="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
  local identity="${PROJECT_NAME}-${LEAD_ID}"
  local lock_dir="${state_root}/state/lead-authority-lock/${identity}"
  local gen_file="${state_root}/state/lead-launch-gen/${identity}.gen"
  local receipt_file="${state_root}/state/lead-launch-gate/${identity}.json"
  local timeout_sec="${FLYWHEEL_LEAD_AUTHORITY_TIMEOUT_SEC:-30}" rc=0

  if ! command -v lead_authority_lock_acquire >/dev/null 2>&1 \
    || ! lead_authority_lock_acquire "$lock_dir" "$timeout_sec"; then
    log "FATAL: timed out acquiring Lead session authority lock"
    return 1
  fi
  _lead_session_prepare_locked "$gen_file" "$receipt_file" || rc=$?
  lead_authority_lock_release || {
    log "FATAL: failed to release Lead session authority lock"
    return 1
  }
  return "$rc"
}
