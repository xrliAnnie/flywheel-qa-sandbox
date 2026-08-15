#!/bin/bash
# FLY-1716: the undocumented percent override must not propagate on any active surface.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ACTIVE=(
  "$ROOT/packages/teamlead/scripts/claude-lead.sh"
  "$ROOT/packages/teamlead/scripts/__tests__"
  "$ROOT/packages/teamlead/src"
)

if rg -n 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' "${ACTIVE[@]}" \
  --glob '!**/dist/**' --glob '!**/node_modules/**'; then
  printf 'FAIL: retired test-only auto-compact override remains on an active surface\n' >&2
  exit 1
fi
printf 'PASS: retired test-only auto-compact override is absent from active runtime/config/test surfaces\n'
