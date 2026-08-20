#!/usr/bin/env bash
# FLY-1814 D1: the manifest suite must propagate its validator's failures.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

FIXTURE_ROOT="$TMP_ROOT/repo"
mkdir -p \
  "$FIXTURE_ROOT/scripts/__tests__" \
  "$FIXTURE_ROOT/scripts/launchd" \
  "$FIXTURE_ROOT/scripts/lib" \
  "$FIXTURE_ROOT/scripts/r4" \
  "$FIXTURE_ROOT/packages/token-usage" \
  "$FIXTURE_ROOT/doc/engineer/implementation"

cp "$REPO_ROOT/scripts/__tests__/launchd-units-manifest.test.sh" \
  "$FIXTURE_ROOT/scripts/__tests__/"
cp "$REPO_ROOT/scripts/lib/converge-nonlead-daemons.sh" \
  "$FIXTURE_ROOT/scripts/lib/"
cp "$REPO_ROOT/scripts/launchd/"*.plist "$FIXTURE_ROOT/scripts/launchd/"
cp "$REPO_ROOT/scripts/package-onboard.sh" \
  "$REPO_ROOT/scripts/package-onboard-files.allow" \
  "$FIXTURE_ROOT/scripts/"
cp "$REPO_ROOT/scripts/r4/r4-window.sh" "$FIXTURE_ROOT/scripts/r4/"
cp "$REPO_ROOT/packages/token-usage/README.md" "$FIXTURE_ROOT/packages/token-usage/"
cp "$REPO_ROOT/doc/engineer/implementation/FLY-222-a0-a10-runbook.md" \
  "$FIXTURE_ROOT/doc/engineer/implementation/"

# Remove the note from the first row, producing four TSV fields while leaving
# the rest of the real manifest and fixture untouched.
awk -F '\t' -v OFS='\t' '
  /^#/ || NF == 0 { print; next }
  !mutated { print $1, $2, $3, $4; mutated = 1; next }
  { print }
' "$REPO_ROOT/scripts/launchd/units.manifest" \
  > "$FIXTURE_ROOT/scripts/launchd/units.manifest"

set +e
output="$(/bin/bash "$FIXTURE_ROOT/scripts/__tests__/launchd-units-manifest.test.sh" 2>&1)"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  printf 'FAIL: malformed four-field manifest returned status 0\n%s\n' "$output" >&2
  exit 1
fi
if [[ "$output" != *"expected exactly 5 TSV fields"* ]]; then
  printf 'FAIL: malformed manifest failed for the wrong reason (status=%s)\n%s\n' \
    "$status" "$output" >&2
  exit 1
fi

echo "PASS: malformed validator input propagates a nonzero shell status"
