#!/usr/bin/env bash
# FLY-1764: every root shell suite must be explicitly classified. The CI job
# intentionally does not glob: several suites require macOS, launchd, Discord,
# or live operator state. A new suite therefore belongs either in ci.yml's
# literal enumeration or in the reviewed manual-only inventory.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI_FILE="$ROOT/.github/workflows/ci.yml"
EXEMPTIONS_FILE="$ROOT/scripts/__tests__/ci-shell-suite-manual-only.txt"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

find "$ROOT/scripts/__tests__" -maxdepth 1 -type f -name '*.test.sh' \
  | sed "s#^$ROOT/##" \
  | LC_ALL=C sort -u >"$TMP/all"

grep -Eo 'bash[[:space:]]+scripts/__tests__/[A-Za-z0-9._/-]+\.test\.sh' "$CI_FILE" \
  | sed -E 's/^bash[[:space:]]+//' \
  | LC_ALL=C sort -u >"$TMP/enumerated"

sed -E '/^[[:space:]]*(#|$)/d; s/[[:space:]]+$//' "$EXEMPTIONS_FILE" \
  | LC_ALL=C sort -u >"$TMP/manual-only"

# FLY-1775: the generalized room's Node contract suites are all hermetic and
# must ride the same CI step. Keep this family explicit so adding a new RPC or
# driver suite cannot silently leave its only coverage local-only.
find "$ROOT/scripts/__tests__" -maxdepth 1 -type f -name 'qa-generalized-*.test.mjs' \
  | sed "s#^$ROOT/##" \
  | LC_ALL=C sort -u >"$TMP/all-generalized-node"

grep -Eo 'node[[:space:]]+--test[[:space:]]+scripts/__tests__/qa-generalized-[A-Za-z0-9._/-]+\.test\.mjs' "$CI_FILE" \
  | sed -E 's/^node[[:space:]]+--test[[:space:]]+//' \
  | LC_ALL=C sort -u >"$TMP/enumerated-generalized-node"

LC_ALL=C comm -23 "$TMP/all" <(LC_ALL=C sort -u "$TMP/enumerated" "$TMP/manual-only") >"$TMP/unclassified"
LC_ALL=C comm -12 "$TMP/enumerated" "$TMP/manual-only" >"$TMP/overlap"
LC_ALL=C comm -13 "$TMP/all" "$TMP/enumerated" >"$TMP/stale-enumerated"
: >"$TMP/stale-manual"
while IFS= read -r suite; do
  if [[ "$suite" != scripts/*.sh || ! -f "$ROOT/$suite" ]]; then
    printf '%s\n' "$suite" >>"$TMP/stale-manual"
  fi
done <"$TMP/manual-only"
LC_ALL=C comm -23 "$TMP/all-generalized-node" "$TMP/enumerated-generalized-node" >"$TMP/missing-generalized-node"
LC_ALL=C comm -13 "$TMP/all-generalized-node" "$TMP/enumerated-generalized-node" >"$TMP/stale-generalized-node"

failed=0
report_nonempty() {
  local title="$1" file="$2"
  if [[ -s "$file" ]]; then
    printf '[FAIL] %s:\n' "$title" >&2
    sed 's/^/  - /' "$file" >&2
    failed=1
  fi
}

report_nonempty "shell suites missing from both ci.yml and the manual-only inventory" "$TMP/unclassified"
report_nonempty "shell suites classified as both CI and manual-only" "$TMP/overlap"
report_nonempty "ci.yml enumerates missing shell suites" "$TMP/stale-enumerated"
report_nonempty "manual-only inventory contains missing shell suites" "$TMP/stale-manual"
report_nonempty "generalized Node suites missing from ci.yml" "$TMP/missing-generalized-node"
report_nonempty "ci.yml enumerates missing generalized Node suites" "$TMP/stale-generalized-node"

if (( failed != 0 )); then
  exit 1
fi

printf '[PASS] %s shell suites are explicitly classified (%s CI, %s manual-only)\n' \
  "$(wc -l <"$TMP/all" | tr -d ' ')" \
  "$(wc -l <"$TMP/enumerated" | tr -d ' ')" \
  "$(wc -l <"$TMP/manual-only" | tr -d ' ')"
printf '[PASS] %s generalized Node suites are explicitly enumerated in CI\n' \
  "$(wc -l <"$TMP/all-generalized-node" | tr -d ' ')"
