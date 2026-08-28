#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/verify-summary-prefix-pair.sh"
TMP="$(mktemp -d /tmp/fly2030-prefix.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

init_repo() {
  local repo="$1"
  git init -q "$repo"
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@example.com
}

mkdir -p "$TMP/raya/summaries" \
  "$TMP/flywheel/packages/teamlead/lead-rules-base" \
  "$TMP/flywheel/packages/flywheel-comm/src"
init_repo "$TMP/raya"
init_repo "$TMP/flywheel"

printf '%s\n' '## Path — the single fixed prefix is `summaries/`' \
  > "$TMP/raya/summaries/README.md"
printf '%s\n' 'every file lies under the single fixed prefix `summaries/`; AND' \
  > "$TMP/flywheel/packages/teamlead/lead-rules-base/founder-only-authority.md"
printf '%s\n' 'export const SUMMARY_PREFIX = "summaries/";' \
  > "$TMP/flywheel/packages/flywheel-comm/src/summary-contract.ts"
git -C "$TMP/raya" add .
git -C "$TMP/raya" commit -qm raya
git -C "$TMP/flywheel" add .
git -C "$TMP/flywheel" commit -qm flywheel
RAYA_HEAD="$(git -C "$TMP/raya" rev-parse HEAD)"
FLYWHEEL_HEAD="$(git -C "$TMP/flywheel" rev-parse HEAD)"

output="$(bash "$SUT" \
  --raya-repo "$TMP/raya" --raya-head "$RAYA_HEAD" \
  --flywheel-repo "$TMP/flywheel" --flywheel-head "$FLYWHEEL_HEAD")"
grep -q '"ok":true' <<<"$output"
echo "PASS: exact heads with one shared summaries/ prefix"

printf '%s\n' 'export const SUMMARY_PREFIX = "status/";' \
  > "$TMP/flywheel/packages/flywheel-comm/src/summary-contract.ts"
git -C "$TMP/flywheel" add .
git -C "$TMP/flywheel" commit -qm drift
DRIFT_HEAD="$(git -C "$TMP/flywheel" rev-parse HEAD)"
if bash "$SUT" \
  --raya-repo "$TMP/raya" --raya-head "$RAYA_HEAD" \
  --flywheel-repo "$TMP/flywheel" --flywheel-head "$DRIFT_HEAD" \
  >"$TMP/drift.out" 2>&1; then
  echo "FAIL: prefix drift was accepted" >&2
  exit 1
fi
grep -q "expected summaries/" "$TMP/drift.out"
echo "PASS: prefix drift fails closed"

if bash "$SUT" \
  --raya-repo "$TMP/raya" --raya-head HEAD \
  --flywheel-repo "$TMP/flywheel" --flywheel-head "$DRIFT_HEAD" \
  >"$TMP/symbolic.out" 2>&1; then
  echo "FAIL: symbolic head was accepted" >&2
  exit 1
fi
grep -q "invalid Raya head SHA" "$TMP/symbolic.out"
echo "PASS: symbolic refs cannot bypass exact-head fence"
