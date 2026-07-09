#!/usr/bin/env bash
# FLY-1023 M7 (shared from M1): stuck → human-handoff summary generator.
#
# buddy_escalate <state-dir> <where> <error_code> <hint>
#   Builds a SANITIZED support summary — enough to locate the problem
#   (cursor, done steps, the failing step/phase, its error_code + hint),
#   never a stack trace, never a secret:
#     · the whole summary passes scan_for_secrets before landing (a flagged
#       hint is replaced by a generic line — fail-safe, not fail-open);
#     · written atomically 0600 to <state-dir>/support-summary-<epoch>.json;
#     · journal buddy.escalated=true via the step CLI (proper lock + v2).
#   Prints the summary PATH on stdout; all progress goes to stderr.
#   Return: 0 = summary landed · 1 = could not land one.
#
# Recovery contract: a human fixes the issue, clears the flag
# (flywheel-buddy-steps.sh state set escalated false), and the next run
# resumes from the journal cursor — escalation is a hand-off, not an end.

_BE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fleet-sanitize.sh
source "$_BE_SCRIPT_DIR/fleet-sanitize.sh"

buddy_escalate() {
  local state_dir="$1" where="$2" error_code="$3" hint="${4:-}"
  [ -n "$state_dir" ] && [ -n "$where" ] && [ -n "$error_code" ] || {
    echo "buddy_escalate: usage: buddy_escalate <state-dir> <where> <error_code> [hint]" >&2
    return 1
  }
  mkdir -p "$state_dir" 2>/dev/null
  chmod go-w "$state_dir" 2>/dev/null || true

  # a hint that trips the secret scan is REPLACED, never partially redacted.
  if [ -n "$hint" ] && ! scan_string_for_secrets "$hint" >/dev/null 2>&1; then
    hint="(details withheld — the original message looked like it contained a credential)"
  fi

  local jf="$state_dir/setup-state.json" cursor="" done_steps='[]'
  if [ -f "$jf" ]; then
    cursor="$(jq -r '.buddy.cursor // empty' "$jf" 2>/dev/null)"
    done_steps="$(jq -c '[.steps | to_entries[] | select(.value.status=="done") | .key]' "$jf" 2>/dev/null || echo '[]')"
  fi

  local ts out tmp
  ts="$(date +%s)"
  out="$state_dir/support-summary-$ts.json"
  tmp="$(mktemp "$state_dir/.tmp-summary.XXXXXX")" || return 1
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  jq -n \
    --arg ts "$ts" --arg w "$where" --arg ec "$error_code" --arg h "$hint" \
    --arg cur "$cursor" --argjson done "$done_steps" \
    '{generatedAt:($ts|tonumber), where:$w, error_code:$ec, hint:$h,
      cursor:$cur, doneSteps:$done, escalated:true}' > "$tmp" \
    || { rm -f "$tmp"; return 1; }

  # belt over braces: the ASSEMBLED summary must also scan clean.
  if ! scan_for_secrets "$tmp" >/dev/null 2>&1; then
    jq '.hint = "(details withheld — sanitizer flagged the assembled summary)"' "$tmp" > "$tmp.2" \
      && mv "$tmp.2" "$tmp" && chmod 600 "$tmp"
    scan_for_secrets "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; echo "buddy_escalate: could not produce a clean summary" >&2; return 1; }
  fi
  mv "$tmp" "$out" || { rm -f "$tmp"; return 1; }

  # journal flag (best-effort — the summary file is the primary artifact).
  FLYWHEEL_SETUP_STATE_DIR="$state_dir" \
    bash "$_BE_SCRIPT_DIR/../flywheel-buddy-steps.sh" state set escalated true >/dev/null 2>&1 || true

  printf '%s\n' "$out"
  return 0
}
