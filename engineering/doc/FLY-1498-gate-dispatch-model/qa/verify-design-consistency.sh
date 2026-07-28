#!/bin/bash
# FLY-1498 QA — design consistency checker.
#
# Mechanically verifies the acceptance criteria the plan states for itself
# (plan.md §4.1) plus founder-requirement traceability (issue brief, 5 items).
#
# Deliberately NOT wired into CI: the design doc is a handoff authority that
# downstream implementation issues consume and supersede; a permanent CI guard
# would be a protective mechanism nobody asked for (issue brief's
# anti-over-reaction rule). Run it by hand to reproduce the QA evidence.
#
# Usage:
#   ./verify-design-consistency.sh            # verify the real docs
#   ./verify-design-consistency.sh --selftest # negative control: corrupt copies,
#                                             # assert every check actually fails
#
# Exit 0 = all checks pass.

set -u
# Deterministic byte semantics across interactive UTF-8 shells and C/POSIX
# launchd/CI shells. Multi-byte punctuation is matched as complete alternatives
# below, never as a byte-wise bracket expression.
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
FINAL="$REPO_ROOT/doc/engineer/plan/v2/design-FINAL-v2.md"
DETAIL="$REPO_ROOT/doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md"
DELTA="$REPO_ROOT/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final-r5-delta.md"
MAPPING="$REPO_ROOT/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final.md"
PLAN="$REPO_ROOT/engineering/doc/FLY-1498-gate-dispatch-model/plan.md"

PASS=0
FAIL=0

ok() {
	PASS=$((PASS + 1))
	printf '  PASS  %s\n' "$1"
}

bad() {
	FAIL=$((FAIL + 1))
	printf '  FAIL  %s\n' "$1"
}

# require_in <label> <file> <pattern>  — pattern must appear
require_in() {
	if grep -qE "$3" "$2"; then ok "$1"; else bad "$1 (missing: $3)"; fi
}

# Old-vocabulary terms may be mentioned only in an explicit, term-local removal
# phrase. A generic negation elsewhere in the same paragraph MUST NOT exempt the
# whole paragraph: "obligations drives gates; agents must not bypass it" is
# still live old design.

# Fold soft-wrapped markdown into logical blocks: a new block starts at a blank
# line, a heading, a table row, or a list bullet; everything else continues the
# previous block.
fold_blocks() {
	awk '
		/^[[:space:]]*$/ { if (buf != "") { print buf; buf = "" } ; next }
		/^(#|\||[[:space:]]*([-*]|[0-9]+\.)[[:space:]])/ {
			if (buf != "") print buf
			buf = $0
			next
		}
		{ buf = (buf == "" ? $0 : buf " " $0) }
		END { if (buf != "") print buf }
	' "$1"
}

# Split folded markdown blocks into sentence-sized units so a removal phrase
# cannot excuse an unrelated live use elsewhere in a long block.
fold_sentences() {
	fold_blocks "$1" | awk '{
		gsub(/。|；|;/, "\n")
		print
	}' | sed '/^[[:space:]]*$/d'
}

check_old_vocab() {
	local label="$1" file="$2" sentences term allowed term_offenders offenders=""
	sentences="$(fold_sentences "$file")"
	for term in 'obligations?' 'ownerLeadId' 'rework_of' 'successor'; do
		case "$term" in
			'obligations?')
				allowed='(不建|不使用|不复用|删除|退役|移除|作废|drop).{0,192}obligations?|obligations?.{0,240}(删除|退役|移除|作废|不保留|不再|由新的 forward migration 删除)'
				;;
			'ownerLeadId')
				allowed='(不建|不使用|不复用|删除|退役|移除|作废).{0,192}ownerLeadId|ownerLeadId.{0,240}(删除|退役|移除|作废|不保留|不新增|零命中|consumer 删除)'
				;;
			'rework_of')
				allowed='(不建|不创建|删除|移除|作废|无).{0,128}rework_of|rework_of.{0,128}(删除|移除|作废|不保留|不再)'
				;;
			'successor')
				allowed='(不建|不创建|删除|移除|作废|无).{0,128}successor|successor.{0,128}(删除|移除|作废|不继承|不保留|不再)'
				;;
		esac
		term_offenders="$(printf '%s\n' "$sentences" | grep -E "$term" | grep -vE "$allowed" || true)"
		if [ -n "$term_offenders" ]; then
			offenders="${offenders}${offenders:+$'\n'}[$term] $term_offenders"
		fi
	done
	if [ -z "$offenders" ]; then
		ok "$label — abolished vocabulary appears only in term-local removal context"
	else
		bad "$label — abolished vocabulary used as live design:"
		printf '%s\n' "$offenders" | cut -c1-160 | sed 's/^/          /'
	fi
}

run_checks() {
	echo "== plan §4.1-1 : ship predicate is exactly the three generic items =="
	require_in "FINAL states 前置恰三条" "$FINAL" '前置恰三条'
	require_in "FINAL excludes review/QA/docs/role from ship predicate" "$FINAL" 'review/QA/docs/session role 不在 ship 谓词'
	require_in "FINAL excludes CI as a fourth predicate" "$FINAL" 'CI 不是第四条 ship 谓词'
	require_in "DETAIL ship predicate excludes review/QA/docs/role" "$DETAIL" 'review、QA、docs、session role 不在该谓词'

	echo "== plan §4.1-2 : DAG engine carries no pipeline-shape branching =="
	require_in "DETAIL forbids node-name literals in the engine" "$DETAIL" '引擎不得出现 design/implement/qa/template 名字面量'
	require_in "FINAL forbids node-name literals in the engine" "$FINAL" '引擎零 design/implement/qa/template 名字面量'
	require_in "DETAIL: three-stage is just data shape" "$DETAIL" '三段式是三行两边|三段式只是普通图'

	echo "== plan §4.1-3 : abolished v2 vocabulary is not live design =="
	check_old_vocab "FINAL" "$FINAL"
	check_old_vocab "DETAIL" "$DETAIL"
	require_in "FINAL drops obligations via forward migration" "$FINAL" '存量 obligations 由新的 forward migration 删除'

	echo "== plan §4.1-4 : DETAIL and FINAL agree on the shared contract =="
	for pat in 'actions' 'action_attempt_no|attempt_no' 'canonical_worktree' 'merge-base' 'span_tip' 'adopt_writer_gap|lost_open_attempt'; do
		if grep -qE "$pat" "$FINAL" && grep -qE "$pat" "$DETAIL"; then
			ok "both docs carry: $pat"
		else
			bad "term only in one doc: $pat"
		fi
	done
	# retry/reconcile policy numbers must agree literally
	for num in '5min' '6' '2min' '15min'; do
		if grep -qE "reconcile=5min|executing_reconcile_after = 5min|max attempts=6|max_attempts = 6|retry base=2min|retry_base = 2min|cap=15min|retry_cap = 15min" "$FINAL" \
			&& grep -qE "5min|6|2min|15min" "$DETAIL"; then :; fi
	done
	if grep -qE 'executing reconcile=5min.*max attempts=6.*retry base=2min.*cap=15min' "$FINAL" \
		&& grep -qE 'executing_reconcile_after = 5min' "$DETAIL" \
		&& grep -qE 'max_attempts = 6' "$DETAIL" \
		&& grep -qE 'retry_base = 2min' "$DETAIL" \
		&& grep -qE 'retry_cap = 15min' "$DETAIL"; then
		ok "retry/reconcile policy numbers agree (5min / 6 / 2min / 15min)"
	else
		bad "retry/reconcile policy numbers disagree between FINAL and DETAIL"
	fi
	if grep -qE '2 / 4 / 8 / 15 / 15min' "$DETAIL" && grep -qE '2/4/8/15/15min' "$FINAL"; then
		ok "retry interval ladder agrees (2/4/8/15/15min)"
	else
		bad "retry interval ladder disagrees"
	fi
	if grep -qE 'mint 点恰好两个' "$DETAIL" && grep -qE '签发点恰二' "$FINAL"; then
		ok "capability mint points agree (exactly two)"
	else
		bad "capability mint points disagree"
	fi

	echo "== plan §4.1-5 : the r5 delta declares itself non-authoritative =="
	require_in "r5-delta marked 非权威" "$DELTA" '非权威'

	echo "== founder brief : five requirements are anchored in the design =="
	require_in "req1 contract+evidence in one transaction" "$DETAIL" '合同满足证据与完成状态同一事务提交'
	require_in "req2 contract derived from actual output" "$DETAIL" 'derived\(classify\(canonical_diff'
	require_in "req2 docs-only/test-only derive no code review" "$DETAIL" 'test-only.*无 code review|docs-only.*无 code review'
	require_in "req2 node name/phase/role excluded from derivation" "$DETAIL" '节点名、phase、role、三段式位置都不参与派生'
	require_in "req3 ship is an action, not a node" "$DETAIL" 'ship 是 agent 外部动作，不是 DAG 节点|ship 是动作'
	require_in "req4 single generic dispatch eligibility" "$DETAIL" '唯一 dispatch eligibility'
	require_in "req5 PRD single ships with no code review" "$DETAIL" 'PRD 单：docs task 完成后 gate/approve/ship 畅通'
	require_in "req5 QA contract is a verdict, not code review" "$DETAIL" 'QA 单：verdict \+ test-only diff 只满足 verdict'
	require_in "anti-over-reaction table exists for founder to cut" "$DETAIL" '反 over-reaction 与诚实边界'

	echo "== table budget stays at 17 (obligations out, actions in) =="
	if grep -qE '17 张表' "$FINAL" && grep -qE '\*\*actions\*\*' "$FINAL"; then
		ok "FINAL declares the 17-table budget with actions added"
	else
		bad "FINAL table budget/actions declaration missing"
	fi
	require_in "0001/0002 checksums declared untouched" "$FINAL" '0001 和 0002|0001/0002 逐字不改'

	echo "== QA M-1 regression : tasks schema migration carries completion/dispatch contracts =="
	require_in "FINAL gives tasks contract_json storage" "$FINAL" 'tasks:.*contract_json'
	require_in "FINAL gives tasks writes_repo storage" "$FINAL" 'tasks:.*writes_repo'
	require_in "DETAIL hands off tasks rebuild" "$DETAIL" '重建 tasks|tasks.*前向.*重建'
	require_in "MAPPING counts three changed existing tables" "$MAPPING" '改变的三张存量表'
	require_in "MAPPING fixes contract_json + writes_repo columns" "$MAPPING" 'contract_json.*writes_repo'
	require_in "MAPPING removes rework_of + lineage_root_id" "$MAPPING" 'rework_of.*lineage_root_id|lineage_root_id.*rework_of'
	require_in "PLAN includes tasks in atomic forward migration" "$PLAN" '重建 tasks'

	echo "== reviewer-family exhaustion : mixed-author product code has a selected exit =="
	require_in "DETAIL fails closed with typed reviewer-family exhaustion" "$DETAIL" 'review_family_exhausted'
	require_in "DETAIL selects an authenticated third-party family" "$DETAIL" '第三方.*reviewer family|third-party.*reviewer family'
	require_in "MAPPING forbids disclosure as product-code review evidence" "$MAPPING" '披露.*不能.*product-code|product-code.*不能.*披露'
}

if [ "${1:-}" = "--selftest" ]; then
	# Targeted negative controls. Each assertion added for QA M-1 and reviewer
	# exhaustion gets its own deliberate corruption and must emit its own label;
	# an aggregate threshold would let a new check remain tautological forever.
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	ORIG_FINAL="$FINAL"
	ORIG_DETAIL="$DETAIL"
	ORIG_DELTA="$DELTA"
	ORIG_MAPPING="$MAPPING"
	ORIG_PLAN="$PLAN"
	SELFTEST_TOTAL=0
	SELFTEST_FAILED=0

	prepare_case() {
		local name="$1" root="$TMP/$1"
		mkdir -p "$root/doc/engineer/plan/v2/design-chain" \
			"$root/engineering/doc/FLY-1498-gate-dispatch-model"
		cp "$ORIG_FINAL" "$root/doc/engineer/plan/v2/design-FINAL-v2.md"
		cp "$ORIG_DETAIL" "$root/doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md"
		cp "$ORIG_DELTA" "$root/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final-r5-delta.md"
		cp "$ORIG_MAPPING" "$root/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final.md"
		cp "$ORIG_PLAN" "$root/engineering/doc/FLY-1498-gate-dispatch-model/plan.md"
		FINAL="$root/doc/engineer/plan/v2/design-FINAL-v2.md"
		DETAIL="$root/doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md"
		DELTA="$root/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final-r5-delta.md"
		MAPPING="$root/engineering/doc/FLY-1498-gate-dispatch-model/mapping-v2final.md"
		PLAN="$root/engineering/doc/FLY-1498-gate-dispatch-model/plan.md"
	}

	mutate() {
		local file="$1" expression="$2"
		sed "$expression" "$file" >"$file.tmp"
		mv "$file.tmp" "$file"
	}

	expect_failure() {
		local expected_label="$1" output
		SELFTEST_TOTAL=$((SELFTEST_TOTAL + 1))
		output="$(PASS=0 FAIL=0 run_checks 2>&1)"
		if printf '%s\n' "$output" | grep -Fq "FAIL  $expected_label"; then
			printf '  PASS  negative control: %s\n' "$expected_label"
		else
			printf '  FAIL  negative control stayed green: %s\n' "$expected_label"
			SELFTEST_FAILED=$((SELFTEST_FAILED + 1))
		fi
	}

	echo "### TARGETED NEGATIVE CONTROLS"

	prepare_case ship-count
	mutate "$FINAL" 's/前置恰三条/前置四条/'
	expect_failure "FINAL states 前置恰三条"

	prepare_case ship-ci
	mutate "$FINAL" 's/CI 不是第四条 ship 谓词/CI 是第四条 ship 谓词/'
	expect_failure "FINAL excludes CI as a fourth predicate"

	prepare_case old-vocab
	printf '\n- gates 由 obligations 病历卡驱动 ownerLeadId 销账，任何 agent 不得绕过。\n' >>"$FINAL"
	expect_failure "FINAL — abolished vocabulary"

	prepare_case dag-literal
	mutate "$DETAIL" 's/引擎不得出现 design\/implement\/qa\/template 名字面量/引擎按 design\/implement\/qa 分支/'
	expect_failure "DETAIL forbids node-name literals in the engine"

	prepare_case delta-authority
	mutate "$DELTA" 's/非权威/权威/g'
	expect_failure "r5-delta marked 非权威"

	prepare_case m1-final-contract
	mutate "$FINAL" 's/contract_json/contract_blob/g'
	expect_failure "FINAL gives tasks contract_json storage"

	prepare_case m1-final-writes
	mutate "$FINAL" 's/writes_repo/repo_write_flag/g'
	expect_failure "FINAL gives tasks writes_repo storage"

	prepare_case m1-detail-rebuild
	mutate "$DETAIL" 's/重建 tasks/迁移 tasks/g'
	expect_failure "DETAIL hands off tasks rebuild"

	prepare_case m1-mapping-count
	mutate "$MAPPING" 's/改变的三张存量表/改变的两张存量表/g'
	expect_failure "MAPPING counts three changed existing tables"

	prepare_case m1-mapping-columns
	mutate "$MAPPING" 's/contract_json/contract_blob/g; s/writes_repo/repo_write_flag/g'
	expect_failure "MAPPING fixes contract_json + writes_repo columns"

	prepare_case m1-mapping-removals
	mutate "$MAPPING" 's/rework_of/old_rework_link/g; s/lineage_root_id/old_lineage_key/g'
	expect_failure "MAPPING removes rework_of + lineage_root_id"

	prepare_case m1-plan-rebuild
	mutate "$PLAN" 's/重建 tasks/迁移 tasks/g'
	expect_failure "PLAN includes tasks in atomic forward migration"

	prepare_case reviewer-exhausted-event
	mutate "$DETAIL" 's/review_family_exhausted/reviewer_pool_empty/g'
	expect_failure "DETAIL fails closed with typed reviewer-family exhaustion"

	prepare_case reviewer-third-family
	mutate "$DETAIL" 's/第三方 reviewer family/额外 reviewer family/g'
	expect_failure "DETAIL selects an authenticated third-party family"

	prepare_case reviewer-no-disclosure
	mutate "$MAPPING" 's/披露不能/披露可以/g'
	expect_failure "MAPPING forbids disclosure as product-code review evidence"

	echo
	if [ "$SELFTEST_FAILED" -eq 0 ] && [ "$SELFTEST_TOTAL" -eq 15 ]; then
		echo "SELFTEST PASS — all $SELFTEST_TOTAL targeted corruptions triggered their own assertions"
		exit 0
	fi
	echo "SELFTEST FAIL — $SELFTEST_FAILED of $SELFTEST_TOTAL targeted corruptions stayed green"
	exit 1
fi

echo "### FLY-1498 design consistency — $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
echo
run_checks
echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
