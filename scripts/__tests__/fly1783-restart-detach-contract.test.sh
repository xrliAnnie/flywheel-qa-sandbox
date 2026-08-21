#!/usr/bin/env bash
# FLY-1783: detached restart code must never grow a session-leader retry or a
# launchd one-shot submission fallback. A failed detach stops and reports.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FILES=(
  "$ROOT/scripts/restart-services.sh"
  "$ROOT/scripts/request-restart.sh"
  "$ROOT/scripts/update-flywheel.sh"
)
FORBIDDEN='\bsetsid\b|launchctl[[:space:]]+submit'

require_readable_files() {
  local file
  for file in "$@"; do
    if [[ ! -f "$file" || ! -r "$file" ]]; then
      printf '[FAIL] guarded restart script is missing or unreadable: %s\n' "$file" >&2
      return 1
    fi
  done
}

require_readable_files "${FILES[@]}" || exit 1

# Mutation control: a renamed/deleted guarded path must fail before grep. This
# prevents grep rc=2 from being mistaken for the clean rc=1 no-match result.
if require_readable_files "$TMP/deliberately-missing.sh" >/dev/null 2>&1; then
  printf '[FAIL] missing-file mutation control did not trip\n' >&2
  exit 1
fi

grep_rc=0
grep -En "$FORBIDDEN" "${FILES[@]}" >"$TMP/source-hits" || grep_rc=$?
if [[ "$grep_rc" -eq 0 ]]; then
  printf '[FAIL] forbidden detached-restart fallback found:\n' >&2
  sed 's/^/  /' "$TMP/source-hits" >&2
  exit 1
elif [[ "$grep_rc" -ne 1 ]]; then
  printf '[FAIL] could not scan every guarded restart script (grep rc=%s)\n' "$grep_rc" >&2
  exit 1
fi

# Mutation control: prove the predicate catches both forbidden mechanisms.
cp "$ROOT/scripts/restart-services.sh" "$TMP/mutant.sh"
printf '\nsetsid /bin/true\nlaunchctl submit -l com.test -- /bin/true\n' >>"$TMP/mutant.sh"
if ! grep -Eq "$FORBIDDEN" "$TMP/mutant.sh"; then
  printf '[FAIL] mutation control did not trip the forbidden-token predicate\n' >&2
  exit 1
fi

printf '[PASS] detached restart scripts contain no forbidden fallback; mutation control trips\n'
