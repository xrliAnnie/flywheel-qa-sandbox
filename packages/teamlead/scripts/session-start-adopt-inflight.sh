#!/bin/bash
# FLY-1751/FLY-1716: after /clear, reclaim in-flight batches and make the new
# Claude session authoritative for the next restart. Authority failures are
# fail-closed for side effects but never block Claude's SessionStart.
set -uo pipefail

input="$(head -c 65536 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0

parsed="$(printf '%s' "$input" | jq -er '
  select(.hook_event_name == "SessionStart")
  | [.source, .agent_type, .session_id]
  | select(all(.[]; type == "string" and length > 0))
  | @tsv
' 2>/dev/null || true)"
[ -n "$parsed" ] || exit 0

IFS=$'\t' read -r source agent_type new_session_id <<< "$parsed"
[ "$source" = "clear" ] || exit 0
[[ "$new_session_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || exit 0

lead_id="${LEAD_ID:-}"
flywheel_lead_id="${FLYWHEEL_LEAD_ID:-}"
project_name="${FLYWHEEL_PROJECT_NAME:-}"
launch_gen="${FLYWHEEL_LEAD_LAUNCH_GEN:-}"
session_id_file="${FLYWHEEL_SESSION_ID_FILE:-}"
[ -n "$lead_id" ] || exit 0
[ "$agent_type" = "$lead_id" ] || exit 0
[ "$lead_id" = "$flywheel_lead_id" ] || exit 0
[ -n "$project_name" ] || exit 0
[[ "$launch_gen" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || exit 0
[[ "$session_id_file" = /* ]] || exit 0
case "$project_name:$lead_id" in
  */*|*..*) exit 0 ;;
esac

state_root="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
identity="${project_name}-${lead_id}"
gen_file="${state_root}/state/lead-launch-gen/${identity}.gen"
lock_dir="${state_root}/state/lead-authority-lock/${identity}"
receipt_dir="${state_root}/state/lead-clear-receipt/${identity}"
receipt_file="${receipt_dir}/${launch_gen}-${new_session_id}.json"
audit_file="${receipt_dir}/audit.jsonl"

clear_audit() {
  local event="$1" detail="${2:-}" line
  mkdir -p "$receipt_dir" 2>/dev/null || return 0
  line="$(jq -nc \
    --arg event "$event" \
    --arg detail "$detail" \
    --arg gen "$launch_gen" \
    --arg sessionId "$new_session_id" \
    --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    '{event:$event,detail:$detail,gen:$gen,newSessionId:$sessionId,ts:$ts}')" \
    || return 0
  printf '%s\n' "$line" >> "$audit_file" 2>/dev/null || true
}

clear_atomic_write() {
  local target="$1" contents="$2" tmp
  tmp="${target}.tmp.$$"
  if (umask 077 && printf '%s\n' "$contents" > "$tmp") \
    && mv "$tmp" "$target"; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  return 1
}

authority_lib="${FLYWHEEL_LEAD_AUTHORITY_LIB:-}"
if [ -z "$authority_lib" ] || [ ! -f "$authority_lib" ]; then
  clear_audit authority_library_missing "$authority_lib"
  exit 0
fi
# shellcheck source=lib/lead-session-authority.sh
# Runtime path is injected by the launcher.
# shellcheck disable=SC1091
source "$authority_lib" || {
  clear_audit authority_library_failed "$authority_lib"
  exit 0
}

lock_timeout="${FLYWHEEL_LEAD_AUTHORITY_TIMEOUT_SEC:-2}"
if ! lead_authority_lock_acquire "$lock_dir" "$lock_timeout"; then
  clear_audit lock_timeout "${lock_timeout}s"
  exit 0
fi

release_and_exit() {
  if ! lead_authority_lock_release; then
    clear_audit lock_release_failed
  fi
  exit 0
}

current_gen=""
if [ -f "$gen_file" ]; then
  IFS= read -r current_gen < "$gen_file" || current_gen=""
fi
if [ "$current_gen" != "$launch_gen" ]; then
  clear_audit generation_fenced "current=${current_gen:-missing}"
  release_and_exit
fi

# Claude Code runs SessionStart hooks synchronously and kills timed-out hooks
# without retrying them. That upstream serial contract prevents first-time B/C
# reorder within one generation. Keyed receipts still make completed/pending
# replay and every cross-generation delivery independently safe.
if [ -e "$receipt_file" ]; then
  claim_status="$(jq -er '.status | select(. == "pending" or . == "completed")' \
    "$receipt_file" 2>/dev/null || true)"
  case "$claim_status" in
    completed)
      clear_audit replay_completed
      release_and_exit
      ;;
    pending)
      clear_audit replay_pending
      release_and_exit
      ;;
    *)
      clear_audit claim_malformed
      release_and_exit
      ;;
  esac
fi

if ! mkdir -p "$receipt_dir" 2>/dev/null; then
  printf '[session-start-adopt-inflight] claim directory creation failed\n' >&2
  release_and_exit
fi
pending="$(jq -nc \
  --arg gen "$launch_gen" \
  --arg sessionId "$new_session_id" \
  --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  '{status:"pending",key:{gen:$gen,newSessionId:$sessionId},ts:$ts}')" \
  || release_and_exit
if ! clear_atomic_write "$receipt_file" "$pending"; then
  clear_audit claim_persist_failed
  release_and_exit
fi

# Business effects are independent best-effort steps. A durable pending claim
# exists before any of them, so a crash replay cannot duplicate adoption or
# roll the session pointer backward.
adopt_ok=false
adopt_count=0
adopt_reason="dependency_missing"
comm_cli="${FLYWHEEL_COMM_CLI:-}"
if [ -n "$comm_cli" ] && [ -f "$comm_cli" ] && [ -n "${FLYWHEEL_COMM_DB:-}" ]; then
  adopt_output=""
  adopt_rc=0
  adopt_output="$(node "$comm_cli" adopt-inflight \
    --recipient "$lead_id" --kind lead 2>&1)" || adopt_rc=$?
  if [ "$adopt_rc" -eq 0 ]; then
    parsed_count="$(printf '%s\n' "$adopt_output" \
      | sed -n 's/^adopted: \([0-9][0-9]*\)$/\1/p' \
      | head -1)"
    if [ -n "$parsed_count" ]; then
      adopt_ok=true
      adopt_count="$parsed_count"
      adopt_reason="ok"
    else
      adopt_reason="unexpected_output"
      [ -z "$adopt_output" ] || printf \
        '[session-start-adopt-inflight] unexpected adopt-inflight output\n' >&2
    fi
  else
    adopt_reason="exit_${adopt_rc}"
    printf '[session-start-adopt-inflight] adopt-inflight failed (exit %s): %s\n' \
      "$adopt_rc" "$adopt_output" >&2
  fi
fi

writeback_ok=false
writeback_reason="history_failed"
old_session_id=""
if [ -f "$session_id_file" ]; then
  IFS= read -r old_session_id < "$session_id_file" || old_session_id=""
fi
if [ "$old_session_id" = "$new_session_id" ]; then
  writeback_ok=true
  writeback_reason="already_current"
else
  history_line="$(jq -nc \
    --arg oldSessionId "$old_session_id" \
    --arg newSessionId "$new_session_id" \
    --arg gen "$launch_gen" \
    --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    '{oldSessionId:$oldSessionId,newSessionId:$newSessionId,gen:$gen,ts:$ts}')"
  if printf '%s\n' "$history_line" >> "${session_id_file}.history" 2>/dev/null; then
    if clear_atomic_write "$session_id_file" "$new_session_id"; then
      writeback_ok=true
      writeback_reason="updated"
    else
      writeback_reason="session_write_failed"
    fi
  fi
fi

bootstrap_ok=false
bootstrap_path="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/agents/${lead_id}.md"
if [ -f "$bootstrap_path" ] \
  && printf '[clear-bootstrap] 新会话已接力。请重新读取 %s 与当前 workspace 的 CLAUDE.md/AGENTS.md，并继续处理 in-flight mailbox。\n' \
    "$bootstrap_path"; then
  bootstrap_ok=true
else
  printf '[session-start-adopt-inflight] identity file missing; clear bootstrap unavailable: %s\n' \
    "$bootstrap_path" >&2
fi
if [ "$adopt_ok" = true ] && [ "$adopt_count" -gt 0 ]; then
  printf '[adopt-inflight] 已把上一现场的 %s 条在途消息重新排队，稍后将重投本会话（注意 [lead-instruction <id>] 幂等：已处理过的指令不要重做）\n' \
    "$adopt_count"
fi

completed="$(jq -nc \
  --arg gen "$launch_gen" \
  --arg sessionId "$new_session_id" \
  --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --arg adoptReason "$adopt_reason" \
  --argjson adoptOk "$adopt_ok" \
  --argjson adoptCount "$adopt_count" \
  --arg writebackReason "$writeback_reason" \
  --argjson writebackOk "$writeback_ok" \
  --argjson bootstrapOk "$bootstrap_ok" \
  '{
    status:"completed",
    key:{gen:$gen,newSessionId:$sessionId},
    steps:{
      fence:{ok:true},
      claim:{ok:true,state:"created"},
      adopt:{ok:$adoptOk,count:$adoptCount,reason:$adoptReason},
      writeback:{ok:$writebackOk,reason:$writebackReason},
      bootstrap:{ok:$bootstrapOk}
    },
    ts:$ts
  }')"
if ! clear_atomic_write "$receipt_file" "$completed"; then
  printf '[session-start-adopt-inflight] completed receipt write failed; pending claim retained\n' >&2
  clear_audit completed_receipt_failed
fi
release_and_exit
