#!/usr/bin/env bash
# Text contract for the active runner prompts, not proof of runner behavior.
# Negative fixtures use the same assertions without editing the shared prompts.
set -euo pipefail
cd "$(dirname "$0")/../.."

roles=(
  .flywheel/agents/engineering/engineer-executor.md
  .flywheel/agents/engineering/qa-executor.md
  .flywheel/agents/general-executor.md
)
helper=packages/qa-framework/agents/qa-parallel-executor.md
qa_failure='Any red current-HEAD CI job means FAIL; report it to the author rather than changing product code.'
helper_rule='Follow local targeted verification rules from the engineering role; do not use `scripts/pre-ship-check.sh` as a local completion gate.'
helper_example='pnpm --filter "<pkg>" --fail-if-no-match exec vitest run <test-file>'

require_text() {
  if ! grep -Fq -- "$2" "$1"; then
    printf 'FAIL: %s missing: %s\n' "$1" "$2" >&2
    return 1
  fi
}

check_contract() {
  local root=$1 file required grep_result
  for file in "${roles[@]}" "$helper"; do
    test -s "$root/$file" || { printf 'FAIL: missing file %s\n' "$file" >&2; return 1; }
  done
  for file in "${roles[@]}"; do
    for required in \
      'Local targeted verification' 'pnpm lint' '--fail-if-no-match' \
      'actual selected package names' 'Check every selected package' \
      'owning package plus test files in direct consumers' \
      'scripts/__tests__/*.test.sh' 'Zero selected packages' \
      'missing required scripts without a verified equivalent' 'zero collected tests' \
      'NOT a pass even with exit 0' 'documentation-only change' \
      'Do not run the full package suite locally' \
      'this rule overrides broader skill/helper defaults' \
      'complete CI job set' 'exact reviewed commit' 'exact-head CI' \
      'Missing, pending, cancelled or skipped required jobs are not green' \
      'Every red current-HEAD CI job must be handled'; do
      require_text "$root/$file" "$required" || return 1
    done
    if grep -Eq 'pnpm test:packages:run|PACKAGE_GATE_RECEIPT|pnpm -r build|Self-verify — FULL REPO' "$root/$file"; then
      printf 'FAIL: obsolete local gate in %s\n' "$file" >&2
      return 1
    else
      grep_result=$?
      test "$grep_result" -eq 1 || return "$grep_result"
    fi
  done
  require_text "$root/${roles[0]}" 'targeted local verification' || return 1
  require_text "$root/${roles[1]}" "$qa_failure" || return 1
  require_text "$root/$helper" "$helper_rule" || return 1
  require_text "$root/$helper" "$helper_example" || return 1
}

check_contract .
printf '%s\n' 'PASS: 3 active roles and QA helper entry'

fixture=$(mktemp -d "${TMPDIR:-/tmp}/fly2753-contract.XXXXXX")
trap 'rm -rf "$fixture"' EXIT
for file in "${roles[@]}" "$helper"; do
  mkdir -p "$fixture/$(dirname "$file")"
  cp "$file" "$fixture/$file"
done
check_contract "$fixture"

expect_rejected() {
  if check_contract "$fixture" > "$fixture/result" 2>&1; then
    printf 'FAIL: accepted mutation %s\n' "$1" >&2
    exit 1
  fi
  require_text "$fixture/result" "$2"
  printf 'PASS: rejects %s\n' "$1"
}

printf '\nRun pnpm test:packages:run locally.\n' >> "$fixture/${roles[0]}"
expect_rejected 'restored full-suite gate' 'obsolete local gate'
cp "${roles[0]}" "$fixture/${roles[0]}"

for needle in 'zero collected tests' 'direct consumers'; do
  sed "s/$needle/REMOVED/g" "${roles[0]}" > "$fixture/${roles[0]}"
  expect_rejected "removed $needle guard" "$needle"
  cp "${roles[0]}" "$fixture/${roles[0]}"
done

sed '/Any red current-HEAD CI job means FAIL/d' "${roles[1]}" > "$fixture/${roles[1]}"
expect_rejected 'removed QA CI-failure duty' "$qa_failure"
cp "${roles[1]}" "$fixture/${roles[1]}"

sed '/local completion gate/d' "$helper" > "$fixture/$helper"
expect_rejected 'removed helper prohibition' "$helper_rule"
sed '/| \*\*Worker\*\*/d' "$helper" > "$fixture/$helper"
expect_rejected 'removed explicit package test example' "$helper_example"
cp "$helper" "$fixture/$helper"

rm "$fixture/${roles[2]}"
expect_rejected 'missing active role file' 'missing file'
printf '%s\n' 'FLY-2753 PASS: 4 prompt files checked; 7 negative fixtures rejected'
