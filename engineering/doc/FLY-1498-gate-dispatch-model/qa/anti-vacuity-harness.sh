#!/bin/bash
# FLY-1498 QA — INDEPENDENT anti-vacuity check of the assertions implement added.
#
# Does NOT trust the script's own --selftest. For each new assertion, corrupts the
# exact point that assertion claims to protect, then requires THAT SPECIFIC label
# to flip to FAIL. An assertion that stays green under its own corruption is
# vacuous and must be rejected.
#
# Runs entirely on an isolated copy — the shared worktree is never modified.

set -u
SRC="$(cd "$(dirname "$0")/../../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/doc/engineer/plan/v2/design-chain" \
         "$WORK/engineering/doc/FLY-1498-gate-dispatch-model/qa"
cp "$SRC/doc/engineer/plan/v2/design-FINAL-v2.md"                              "$WORK/doc/engineer/plan/v2/"
cp "$SRC/doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md"         "$WORK/doc/engineer/plan/v2/design-chain/"
cp "$SRC/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final.md"      "$WORK/engineering/doc/FLY-1498-gate-dispatch-model/"
cp "$SRC/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final-r5-delta.md" "$WORK/engineering/doc/FLY-1498-gate-dispatch-model/"
cp "$SRC/engineering/doc/FLY-1498-gate-dispatch-model/plan.md"                 "$WORK/engineering/doc/FLY-1498-gate-dispatch-model/"
cp "$SRC/engineering/doc/FLY-1498-gate-dispatch-model/qa/verify-design-consistency.sh" \
                                                                              "$WORK/engineering/doc/FLY-1498-gate-dispatch-model/qa/"

CHECKER="$WORK/engineering/doc/FLY-1498-gate-dispatch-model/qa/verify-design-consistency.sh"
FINAL="$WORK/doc/engineer/plan/v2/design-FINAL-v2.md"
DETAIL="$WORK/doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md"
MAPPING="$WORK/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final.md"
PLAN="$WORK/engineering/doc/FLY-1498-gate-dispatch-model/plan.md"

BASE=$(/bin/bash "$CHECKER" 2>/dev/null | tail -1)
echo "baseline on isolated copy: $BASE"
case "$BASE" in
	*"failed=0"*) echo "baseline OK" ;;
	*) echo "ABORT: isolated copy is not green; corruption results would be meaningless"; exit 1 ;;
esac
echo

PASS=0; VACUOUS=0

# check <label> <file> <perl-substitution>
check() {
	local label="$1" file="$2" subst="$3" bak out line
	bak="$(mktemp)"; cp "$file" "$bak"
	perl -pi -e "$subst" "$file"
	if cmp -s "$file" "$bak"; then
		echo "  SKIP(no-op)  $label   ← corruption did not change the file; pattern needs review"
		VACUOUS=$((VACUOUS+1)); cp "$bak" "$file"; rm -f "$bak"; return
	fi
	out="$(/bin/bash "$CHECKER" 2>/dev/null)"
	line="$(printf '%s\n' "$out" | grep -F "$label" | head -1)"
	case "$line" in
		*"FAIL"*) echo "  CAUGHT       $label"; PASS=$((PASS+1)) ;;
		*)        echo "  ❌ VACUOUS   $label   ← stayed green under its own corruption"; VACUOUS=$((VACUOUS+1)) ;;
	esac
	cp "$bak" "$file"; rm -f "$bak"
}

echo "== independent targeted negative controls (my corruptions, not the script's) =="
check "FINAL gives tasks contract_json storage"        "$FINAL"   's/contract_json/QA_BROKE_IT/g if /^- \*\*?tasks|^- tasks:/'
check "FINAL gives tasks writes_repo storage"          "$FINAL"   's/writes_repo/QA_BROKE_IT/g if /^- \*\*?tasks|^- tasks:/'
check "DETAIL hands off tasks rebuild"                 "$DETAIL"  's/重建 tasks/重建 QA_BROKE_IT/g'
check "MAPPING counts three changed existing tables"   "$MAPPING" 's/改变的三张存量表/改变的两张存量表/g'
check "MAPPING fixes contract_json + writes_repo columns" "$MAPPING" 's/contract_json/QA_BROKE_IT/g'
check "MAPPING removes rework_of + lineage_root_id"    "$MAPPING" 's/lineage_root_id/QA_BROKE_IT/g'
check "PLAN includes tasks in atomic forward migration" "$PLAN"   's/重建 tasks/重建 QA_BROKE_IT/g'
check "DETAIL fails closed with typed reviewer-family exhaustion" "$DETAIL" 's/review_family_exhausted/QA_BROKE_IT/g'
check "DETAIL selects an authenticated third-party family" "$DETAIL" 's/第三方/QA_BROKE_IT/g'
check "MAPPING forbids disclosure as product-code review evidence" "$MAPPING" 's/披露/QA_BROKE_IT/g'

echo
echo "caught=$PASS  vacuous_or_inconclusive=$VACUOUS"
[ "$VACUOUS" -eq 0 ] || exit 1
