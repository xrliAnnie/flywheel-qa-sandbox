#!/bin/bash
# FLY-1663: persistent, one-shot Lead exit receipt helpers.
# Source-only. This is intentionally not a supervisor: there are no sleeps,
# process probes, locks, loops, or restart decisions here.

lead_body_write_receipt() {
  local receipt_file="$1"
  local lead_key="$2"
  local session_id="$3"
  local exit_code="$4"
  local duration_seconds="$5"
  local is_resume="$6"
  local session_file="$7"
  local previous_failures=0 failures=0 action=resume-next-launch
  local receipt_dir tmp written_at

  case "$exit_code" in ''|*[!0-9]*) return 2 ;; esac
  case "$duration_seconds" in ''|*[!0-9]*) return 2 ;; esac
  case "$is_resume" in true|false) ;; *) return 2 ;; esac
  [ -n "$receipt_file" ] && [ -n "$lead_key" ] || return 2
  command -v jq >/dev/null 2>&1 || return 1

  receipt_dir="${receipt_file%/*}"
  [ "$receipt_dir" != "$receipt_file" ] || receipt_dir=.
  mkdir -p "$receipt_dir" || return 1
  chmod 700 "$receipt_dir" 2>/dev/null || return 1

  if [ -f "$receipt_file" ] \
    && jq -e --arg key "$lead_key" '.leadKey == $key' "$receipt_file" >/dev/null 2>&1; then
    previous_failures="$(jq -r '.consecutiveQuickResumeFailures // 0' "$receipt_file" 2>/dev/null || printf 0)"
    case "$previous_failures" in ''|*[!0-9]*) previous_failures=0 ;; esac
  fi

  if [ "$is_resume" = true ] && [ "$exit_code" -ne 0 ] && [ "$duration_seconds" -lt 60 ]; then
    failures=$((previous_failures + 1))
  else
    failures=0
  fi

  if [ "$failures" -ge 3 ]; then
    action=fresh-next-launch
    rm -f "$session_file" || return 1
  elif [ -z "$session_id" ]; then
    action=fresh-next-launch
  fi

  written_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" || return 1
  tmp="${receipt_file}.tmp.$$"
  umask 077
  jq -n \
    --arg leadKey "$lead_key" \
    --arg sessionId "$session_id" \
    --argjson exitCode "$exit_code" \
    --argjson durationSeconds "$duration_seconds" \
    --argjson isResume "$is_resume" \
    --argjson failures "$failures" \
    --arg action "$action" \
    --arg writtenAt "$written_at" \
    '{schemaVersion: 1, leadKey: $leadKey, sessionId: $sessionId,
      exitCode: $exitCode, durationSeconds: $durationSeconds,
      isResume: $isResume, consecutiveQuickResumeFailures: $failures,
      action: $action, writtenAt: $writtenAt}' > "$tmp" \
    && jq empty "$tmp" >/dev/null 2>&1 \
    && chmod 600 "$tmp" \
    && mv "$tmp" "$receipt_file" \
    || { rm -f "$tmp"; return 1; }
}
