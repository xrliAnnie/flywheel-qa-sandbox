#!/usr/bin/env bash
# Shared pre-pull guard for the FLY-1676 Discord plugin pointer cutover.
#
# Returns:
#   0  the target selects discord@flywheel-plugins and the live checker is legacy
#   1  no cutover is required
#   2  the target launcher could not be read
discord_pointer_cutover_required() {
  local target="${1:-origin/main}"
  local incoming_launcher="" checker="${HOME}/.flywheel/bin/check-discord-plugin.sh"
  local live_contract=""

  if ! incoming_launcher="$(git -C "$FLYWHEEL_DIR" show \
    "${target}:packages/teamlead/scripts/claude-lead.sh" 2>/dev/null)"; then
    return 2
  fi
  if ! grep -Fq \
    'CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")' \
    <<< "$incoming_launcher"; then
    return 1
  fi
  if [[ -x "$checker" ]]; then
    live_contract="$($checker --print-contract 2>/dev/null || true)"
  fi
  [[ "$live_contract" != "discord@flywheel-plugins/v1" ]]
}
