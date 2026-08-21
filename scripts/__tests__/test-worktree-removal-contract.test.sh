#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

anchored_occurrences() {
  local file="$1" pattern="$2" expected="$3" line start context count
  count=$(rg -n "$pattern" "$file" | wc -l | tr -d ' ')
  [[ "$count" -eq "$expected" ]] || return 1
  while IFS=: read -r line _; do
    [[ -n "$line" ]] || continue
    start=$((line > 10 ? line - 10 : 1))
    context=$(sed -n "${start},${line}p" "$file")
    grep -q 'FLY-1759 reap-first\|FLY-1759 domain allowlist' <<< "$context" || return 1
  done < <(rg -n "$pattern" "$file")
}

echo "Test: FLY-1759 all production teardown commands are reap-first anchored"

cleanup="$ROOT/.claude/orchestrator/cleanup-agent.sh"
reap_line=$(rg -n 'reap_worktree_processes' "$cleanup" | head -1 | cut -d: -f1)
rename_line=$(rg -n 'mv "\$agent_worktree" "\$tmp_path"' "$cleanup" | head -1 | cut -d: -f1)
if [[ -n "$reap_line" && -n "$rename_line" && "$reap_line" -lt "$rename_line" ]] \
    && rg -q 'lib/reap-worktree.sh' "$cleanup"; then
  pass "cleanup-agent sources the reaper and calls it before rename"
else
  fail "cleanup-agent is missing a reap-before-rename call"
fi

manager="$ROOT/packages/edge-worker/src/WorktreeManager.ts"
if anchored_occurrences "$manager" '"worktree", "remove"' 2; then
  pass "both TypeScript git-remove primitives have adjacent reap-first anchors"
else
  fail "TypeScript git-remove primitive count/anchor drifted"
fi

spin="$ROOT/.claude/commands/spin.md"
if anchored_occurrences "$spin" 'git worktree remove' 2; then
  pass "both spin teardown commands carry reap-first instructions"
else
  fail "spin teardown count/anchor drifted"
fi

orchestrator="$ROOT/.claude/commands/orchestrator.md"
if anchored_occurrences "$orchestrator" 'git worktree remove' 7; then
  pass "orchestrator teardown references are reap-first or domain-allowlisted"
else
  fail "orchestrator teardown reference count/anchor drifted"
fi

if [[ "$(rg -n 'git[^\n]*worktree remove' "$ROOT/scripts/test-teardown.sh" | wc -l | tr -d ' ')" -eq 1 \
    && "$(rg -n 'git[^\n]*worktree remove' "$ROOT/scripts/test-restart-services.sh" | wc -l | tr -d ' ')" -eq 1 ]]; then
  pass "FLY-1482 QA-domain shell removals remain an exact two-entry allowlist"
else
  fail "QA-domain worktree removal allowlist drifted"
fi

ci="$ROOT/.github/workflows/ci.yml"
unit_section=$(sed -n '/^  unit-tests:/,/^  script-tests:/p' "$ci")
if grep -q 'bash scripts/ci-apt-install.sh tmux lsof' <<< "$unit_section" \
    && [[ "$(rg -n 'bash scripts/__tests__/test-reap-worktree-lib.test.sh' "$ci" | wc -l | tr -d ' ')" -eq 1 ]] \
    && [[ "$(rg -n 'bash scripts/__tests__/test-worktree-removal-contract.test.sh' "$ci" | wc -l | tr -d ' ')" -eq 1 ]]; then
  pass "Ubuntu unit/script jobs explicitly verify every FLY-1759 dependency and suite"
else
  fail "CI is missing lsof or an explicit FLY-1759 shell-suite invocation"
fi

echo "Test: FLY-1759 mutation control catches a new naked removal"
mutation=$(mktemp)
cp "$spin" "$mutation"
printf '\ngit worktree remove /tmp/rogue\n' >> "$mutation"
if anchored_occurrences "$mutation" 'git worktree remove' 3; then
  fail "mutation fixture passed despite a naked removal"
else
  pass "injected unanchored removal makes the contract guard red"
fi
rm -f "$mutation"

echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
