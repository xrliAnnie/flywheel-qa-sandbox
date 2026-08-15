#!/usr/bin/env bash
# FLY-1787: prompt-contract guard for Flywheel CoS routing and reply discipline.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IDENTITY="$ROOT/.lead/flywheel-cos-lead/identity.md"
BASE_RULES="$ROOT/packages/teamlead/lead-rules-base/cos-lead-rules.md"

PASS=0
FAIL=0

pass() {
	PASS=$((PASS + 1))
	printf '  PASS: %s\n' "$1"
}

fail() {
	FAIL=$((FAIL + 1))
	printf '  FAIL: %s\n' "$1"
}

assert_contains() {
	local file="$1" needle="$2" label="$3"
	if grep -qF -- "$needle" "$file"; then
		pass "$label"
	else
		fail "$label (missing: $needle)"
	fi
}

assert_not_contains() {
	local file="$1" needle="$2" label="$3"
	if grep -qF -- "$needle" "$file"; then
		fail "$label (unexpected: $needle)"
	else
		pass "$label"
	fi
}

assert_same_line() {
	local file="$1" anchor="$2" needle="$3" label="$4"
	if grep -F -- "$anchor" "$file" | grep -qF -- "$needle"; then
		pass "$label"
	else
		fail "$label ($anchor must share a line with $needle)"
	fi
}

assert_cardinality_order() {
	local two one none
	two="$(grep -nF -- '1. **Two or more dept labels**' "$IDENTITY" | head -n 1 | cut -d: -f1 || true)"
	one="$(grep -nF -- '2. **Exactly ONE dept label**' "$IDENTITY" | head -n 1 | cut -d: -f1 || true)"
	none="$(grep -nF -- '3. **NO dept label**' "$IDENTITY" | head -n 1 | cut -d: -f1 || true)"
	if [[ -n "$two" && -n "$one" && -n "$none" && "$two" -lt "$one" && "$one" -lt "$none" ]]; then
		pass "department-label cases are cardinality-first and ordered"
	else
		fail "department-label cases missing or out of order (two=${two:-missing}, one=${one:-missing}, none=${none:-missing})"
	fi
}

printf 'Test: Flywheel CoS identity contract (FLY-1787)\n'

assert_same_line "$IDENTITY" '| Honey Lemon (flywheel-product-lead)' '1523215538820612206' \
	"Honey Lemon roster row carries her bot id"
assert_same_line "$IDENTITY" '| Honey Lemon (flywheel-product-lead)' '"Honey Lemon"' \
	"Honey Lemon roster row carries her exact name trigger"
assert_same_line "$IDENTITY" '| Tadashi (flywheel-eng-lead)' '1516207680836866219' \
	"Tadashi remains in the roster"
assert_not_contains "$IDENTITY" '[ ...existing..., "Flywheel" ]' \
	"dangerous all-label union guidance is absent"
assert_contains "$IDENTITY" 'SINGLE-SELECT' "department labels are explicitly single-select"
assert_contains "$IDENTITY" 'issue_multiple_department_labels' \
	"multiple department labels name the Bridge rejection"
assert_cardinality_order
assert_contains "$IDENTITY" 'ANY user other than you' \
	"non-self mention abstention is roster-independent"
assert_contains "$IDENTITY" '🔴 NEVER `#leads-roundtable`' \
	"product routing retains the roundtable prohibition"
assert_contains "$IDENTITY" '**swap** (replace the wrong dept label with the right one' \
	"wrong ownership uses swap semantics"
assert_contains "$IDENTITY" 'never add' "wrong ownership explicitly forbids adding a dept label"
assert_same_line "$IDENTITY" '1. **Self-reference**:' '1516205086890786917' \
	"self-reference rule pins the CoS bot id"
assert_same_line "$IDENTITY" '2. **Someone-else reference**:' '1516205086890786917' \
	"someone-else rule pins the CoS bot id"
assert_same_line "$IDENTITY" 'Your OWN bot id' '1516205086890786917' \
	"roster section pins the CoS bot id"
assert_contains "$IDENTITY" 'labels=Flywheel,Flywheel-Product' \
	"triage query covers both Flywheel departments"
assert_contains "$BASE_RULES" 'stricter project-identity abstain rule' \
	"base default-replier rule yields to stricter project abstention"
assert_not_contains "$BASE_RULES" '`identity.md` is appended **after** this file' \
	"base rules do not claim the prompt order is reversed"

printf '\nRESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
