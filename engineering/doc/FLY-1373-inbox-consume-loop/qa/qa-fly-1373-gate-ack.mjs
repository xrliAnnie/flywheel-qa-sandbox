#!/usr/bin/env node
/** FLY-1373 验收④ 独立核验 — gate 类 API 拒 Lead-ack（founder 绑定保护）。 */
const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1373";
const { classifyApprovalIntent, hasApprovalIntent } = await import(
	`${ROOT}/packages/flywheel-comm/dist/approval-intent.js`
);

let pass = 0,
	fail = 0;
const notes = [];
function check(name, cond, detail = "") {
	if (cond) {
		pass++;
		console.log(`  ✅ ${name}`);
	} else {
		fail++;
		console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("[A] 必须判为 approve → 会被 403 挡住的 Lead-ack");
const MUST_REJECT = [
	'{"approved": true}',
	'{"approved":true,"note":"lgtm"}',
	"approved",
	"Approved",
	"APPROVED",
	"approve",
	"lgtm",
	"LGTM",
	"ship it",
	"go ahead",
	"merge it",
	"批准",
	"同意",
	"同意上线",
	"可以 merge",
	"可以 ship",
	"  approved  ",
	'"approved"',
];
for (const a of MUST_REJECT) {
	check(
		`拒绝: ${JSON.stringify(a)}`,
		hasApprovalIntent(a) === true,
		`实判 ${classifyApprovalIntent(a)}`,
	);
}

console.log("\n[B] 必须放行 — Lead 的纯评论 / changes-requested（不能误伤）");
const MUST_ALLOW = [
	"changes_requested",
	'{"approved": false}',
	'{"decision":"changes_requested"}',
	"not approved",
	"do not approve",
	"reject",
	"rejected",
	"request changes",
	"needs more tests",
	"needs work",
	"这块逻辑我看了下,priority 排序没问题",
	"I read the diff; the ordering looks consistent with the plan.",
	"question: does this handle the codex backend?",
];
for (const a of MUST_ALLOW) {
	check(
		`放行: ${JSON.stringify(a.slice(0, 40))}`,
		hasApprovalIntent(a) === false,
		`实判 ${classifyApprovalIntent(a)}`,
	);
}

console.log("\n[C] 对抗探测 — 能否用变体绕过 403（发现即为真缺口）");
const EVASION = [
	"Approved!",
	"approved.",
	"approved :)",
	"lgtm!",
	"LGTM 👍",
	"ship it!",
	'{"approved":  true}',
	'{ "approved" : true }',
];
for (const a of EVASION) {
	const blocked = hasApprovalIntent(a);
	if (blocked) {
		pass++;
		console.log(`  ✅ 变体仍被拦: ${JSON.stringify(a)}`);
	} else {
		console.log(
			`  ⚠️  变体绕过: ${JSON.stringify(a)} → ${classifyApprovalIntent(a)}`,
		);
		notes.push(`可绕过: ${JSON.stringify(a)}`);
	}
}

console.log("\n[D] 前缀伪装 — 批准词埋在句中（分类器只锚定开头）");
const EMBEDDED = [
	"I think this is approved",
	"the runner said lgtm",
	"顺便说一句 批准",
];
for (const a of EMBEDDED) {
	const blocked = hasApprovalIntent(a);
	console.log(
		`  ${blocked ? "拦截" : "放行"}: ${JSON.stringify(a)} → ${classifyApprovalIntent(a)}`,
	);
}
console.log(
	"  ℹ️  设计上锚定开头(^)：句中提及不算批准意图 = 有意为之，避免误伤讨论。",
);

console.log(`\n${"─".repeat(60)}`);
console.log(`验收④ 分类器: ${pass} PASS / ${fail} FAIL`);
if (notes.length) {
	console.log("⚠️ 观察项:");
	for (const n of notes) console.log(`  - ${n}`);
}
process.exit(fail === 0 ? 0 : 1);
