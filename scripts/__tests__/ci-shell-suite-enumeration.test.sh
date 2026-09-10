#!/usr/bin/env bash
# FLY-1764: every root shell suite must be explicitly classified. The CI job
# intentionally does not glob: several suites require macOS, launchd, Discord,
# or live operator state. A new suite therefore belongs either in ci.yml's
# literal enumeration or in the reviewed manual-only inventory.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CI_FILE="${CI_SHELL_SUITE_CI_FILE:-$ROOT/.github/workflows/ci.yml}"
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

# Root Node contract suites are not discovered by any workspace test command.
# Require every one to appear literally in ci.yml so new suites cannot remain
# local-only coverage.
find "$ROOT/scripts/__tests__" -maxdepth 1 -type f -name '*.test.mjs' \
  | sed "s#^$ROOT/##" \
  | LC_ALL=C sort -u >"$TMP/all-node"

awk '{ line=$0; while (sub(/\\[[:space:]]*$/, "", line)) { if ((getline next_line) <= 0) break; line=line next_line } print line }' "$CI_FILE" \
  | grep -E 'node[[:space:]]+--test' \
  | grep -Eo 'scripts/__tests__/[A-Za-z0-9._/-]+\.test\.mjs' \
  | LC_ALL=C sort -u >"$TMP/enumerated-node"

LC_ALL=C comm -23 "$TMP/all" <(LC_ALL=C sort -u "$TMP/enumerated" "$TMP/manual-only") >"$TMP/unclassified"
LC_ALL=C comm -12 "$TMP/enumerated" "$TMP/manual-only" >"$TMP/overlap"
LC_ALL=C comm -13 "$TMP/all" "$TMP/enumerated" >"$TMP/stale-enumerated"
: >"$TMP/stale-manual"
while IFS= read -r suite; do
  if [[ "$suite" != scripts/*.sh || ! -f "$ROOT/$suite" ]]; then
    printf '%s\n' "$suite" >>"$TMP/stale-manual"
  fi
done <"$TMP/manual-only"
LC_ALL=C comm -23 "$TMP/all-node" "$TMP/enumerated-node" >"$TMP/missing-node"
LC_ALL=C comm -13 "$TMP/all-node" "$TMP/enumerated-node" >"$TMP/stale-node"

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
report_nonempty "Node suites missing from ci.yml" "$TMP/missing-node"
report_nonempty "ci.yml enumerates missing Node suites" "$TMP/stale-node"

if (( failed != 0 )); then
  exit 1
fi

# Mutation control: deleting one explicitly wired Node suite must make this
# inventory fail. The nested run skips this block to avoid recursive mutants.
if [[ "${CI_SHELL_SUITE_SKIP_MUTATION:-0}" != "1" ]]; then
  for mutation_suite in scripts/__tests__/endpoint-client-etag.test.mjs scripts/__tests__/qa-lead-diagnostics.test.mjs; do
    if [[ "$(grep -Fc "$mutation_suite" "$CI_FILE")" != "1" ]]; then
      printf '[FAIL] %s mutation target must occur exactly once in ci.yml\n' "$mutation_suite" >&2
      exit 1
    fi
    sed "\#$mutation_suite#d" "$CI_FILE" >"$TMP/ci-without-node-suite.yml"
    if CI_SHELL_SUITE_CI_FILE="$TMP/ci-without-node-suite.yml" \
      CI_SHELL_SUITE_SKIP_MUTATION=1 \
      bash "$0" >"$TMP/mutation.log" 2>&1; then
      printf '[FAIL] removing %s from ci.yml stayed green\n' "$mutation_suite" >&2
      exit 1
    fi
    if ! grep -Fq "$mutation_suite" "$TMP/mutation.log"; then
      printf '[FAIL] Node enumeration mutant did not identify %s\n' "$mutation_suite" >&2
      exit 1
    fi
  done
fi

printf '[PASS] %s shell suites are explicitly classified (%s CI, %s manual-only)\n' \
  "$(wc -l <"$TMP/all" | tr -d ' ')" \
  "$(wc -l <"$TMP/enumerated" | tr -d ' ')" \
  "$(wc -l <"$TMP/manual-only" | tr -d ' ')"
printf '[PASS] %s Node suites are explicitly enumerated in CI; endpoint-client and FLY-2455 removal mutations turn red\n' \
  "$(wc -l <"$TMP/all-node" | tr -d ' ')"
