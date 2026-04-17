#!/bin/bash
# FLY-83: regenerate blocked-prompt fixtures used by test-expect-prompts.sh.
# Each fixture interleaves ANSI colour escapes between words — same as what
# Claude Code's Ink TUI emits. The word-boundary regex in claude-lead.sh
# expect script skips the ANSI bytes without per-byte stripping.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/test-fixtures/lead-prompts"
mkdir -p "$DIR"

# ANSI helpers. \x1b = ESC. `printf '\x1b'` works on macOS + Linux.
RED=$'\x1b[31m'
GREEN=$'\x1b[32m'
YELLOW=$'\x1b[33m'
BLUE=$'\x1b[38;5;153m'
DIM=$'\x1b[2m'
RESET=$'\x1b[0m'
RESET39=$'\x1b[39m'

{
  printf '%sClaude Code v1.2.3%s\n' "$DIM" "$RESET"
  printf '%s>%s thinking...\n' "$GREEN" "$RESET"
  printf '\n'
  printf '%srate%s %slimit%s reached for your plan.\n' "$RED" "$RESET39" "$RED" "$RESET"
  printf 'please %stry%s again at %s14:30%s.\n' "$YELLOW" "$RESET39" "$BLUE" "$RESET"
  printf '> '
} > "${DIR}/rate-limit.ansi"

{
  printf '%susage%s%s limit%s reset in 1h 12m.\n' "$RED" "$RESET39" "$RED" "$RESET"
  printf 'continuing paused sessions after reset.\n'
  printf '> '
} > "${DIR}/usage-limit.ansi"

{
  printf '%slogin%s %sexpired%s — please reauth.\n' "$RED" "$RESET39" "$RED" "$RESET"
  printf '%s$%s claude login\n' "$DIM" "$RESET"
  printf 'then retry the command.\n'
  printf '> '
} > "${DIR}/login-expired.ansi"

{
  printf '%spermission%s %srequired%s to %swrite%s %sfile%s %s/tmp/example%s\n' \
    "$YELLOW" "$RESET39" "$YELLOW" "$RESET39" "$GREEN" "$RESET39" "$GREEN" "$RESET39" "$BLUE" "$RESET"
  printf 'approve? [y/N] '
} > "${DIR}/permission-file.ansi"

{
  printf '%s>%s %sready%s for input\n' "$GREEN" "$RESET" "$GREEN" "$RESET"
  printf '%scursor:%s typing\n' "$DIM" "$RESET"
  printf 'context: 42%% used\n'
} > "${DIR}/normal-running.ansi"

echo "Fixtures regenerated under ${DIR}:"
ls -1 "$DIR"/*.ansi
