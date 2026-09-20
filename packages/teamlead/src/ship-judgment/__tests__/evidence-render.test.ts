import { expect, it } from "vitest";
import { aggregateJudgment, type ShipJudgmentBinding } from "../contract.js";
import type { DeliveryView } from "../delivery.js";
import { buildEvidenceLedger } from "../evidence-ledger.js";
import { renderJudgmentMessage } from "../render.js";
import { HEAD, NOW } from "./binding-fixture.js";
import { evidenceMaterials } from "./evidence-fixture.js";

const binding: ShipJudgmentBinding = {
	projectName: "flywheel",
	runId: "r",
	issueId: "FLY-2553",
	questionId: "q",
	cardMessageId: "123456789012345678",
	threadId: "123456789012345679",
	manifestRevision: 0,
	targets: [
		{
			repo_identity: "__main__",
			repo_slug: "owner/repo",
			pr_number: 1194,
			head_sha: HEAD,
		},
	],
};
function view(scenario = "pass"): DeliveryView {
	const materials = evidenceMaterials(binding, NOW);
	if (scenario === "missing_qa") delete materials.targets[0]!.qaAuthority;
	if (scenario === "conflict") {
		materials.mechanical.verdict = "fail";
		materials.mechanical.overlaps = [
			{ repo_identity: "__main__", pr_number: 77, path: "fix.ts" },
		];
	}
	if (scenario === "input")
		materials.input = {
			status: "unavailable",
			reason: "linear_credentials_missing",
		};
	const evidence = buildEvidenceLedger(materials, binding, {
		status: "evaluated",
		evaluationId: "evaluation",
		modelSnapshotDigest: "f".repeat(64),
		alignment: scenario === "veto" ? "fail" : "pass",
		coverage: "pass",
	});
	return {
		opinionId: "opinion",
		questionId: "q",
		threadId: binding.threadId,
		cardMessageId: binding.cardMessageId,
		marker: "ship-judgment:q",
		mode: "dry_run",
		overall: aggregateJudgment(
			evidence.alignment.verdict,
			evidence.conflict.verdict,
			evidence.coverage.verdict,
		),
		alignment: evidence.alignment.verdict,
		conflict: evidence.conflict.verdict,
		coverage: evidence.coverage.verdict,
		mechanical: materials.mechanical,
		evaluation:
			scenario === "veto"
				? { alignment: { evidence: [{ quote: "requirement omitted" }] } }
				: null,
		evidence,
	};
}

it("headlines a known alignment failure even when QA evidence is missing", () => {
	const source = view("missing_qa");
	source.evidence!.alignment.verdict = "fail";
	source.alignment = "fail";
	source.overall = aggregateJudgment("fail", "pass", "undetermined");
	const message = renderJudgmentMessage(source);
	expect(message.split("\n")[0]).toBe(
		"**三点机器判断：不可自动批：①** · dry_run",
	);
	expect(message).toContain("③ QA 用例覆盖：缺 QA 判决");
});

it.each([
	[
		"pass",
		"三点均通过",
		"① PRD / 设计对齐：通过",
		"② 合并与在飞文件：通过",
		"③ QA 用例覆盖：通过",
	],
	[
		"conflict",
		"不可自动批：②",
		"① PRD / 设计对齐：通过",
		"② 合并与在飞文件：不通过",
		"③ QA 用例覆盖：通过",
	],
	[
		"missing_qa",
		"缺证据：③ QA 判决",
		"① PRD / 设计对齐：通过",
		"② 合并与在飞文件：通过",
		"③ QA 用例覆盖：缺 QA 判决",
	],
	[
		"input",
		"缺证据：① 输入；③ 输入",
		"① PRD / 设计对齐：缺 输入",
		"② 合并与在飞文件：通过",
		"③ QA 用例覆盖：缺 输入",
	],
	[
		"veto",
		"不可自动批：①",
		"① PRD / 设计对齐：不通过",
		"② 合并与在飞文件：通过",
		"③ QA 用例覆盖：通过",
	],
])(
	"renders the three-line %s decision snapshot",
	(scenario, title, a, b, c) => {
		const message = renderJudgmentMessage(view(scenario));
		expect(
			message
				.split("\n")
				.slice(0, 4)
				.map((line) => line.split(" · ")[0]),
		).toEqual([`**三点机器判断：${title}**`, a, b, c]);
		expect(message).not.toMatch(/不可判定|待补证/);
		expect(message).toContain("code-r5");
		if (scenario !== "missing_qa") expect(message).toContain("1148");
		if (scenario === "input") {
			expect(message).toContain("输入不可得：linear");
			expect(message).not.toContain("0 仓");
		}
		if (scenario === "veto") expect(message).toContain("语义复核：不通过");
		else expect(message).toContain("语义复核：通过");
		expect(message).toContain("approved");
		expect(message).not.toMatch(/旧窄口|三闸|纯文档/);
		expect(message.length).toBeLessThanOrEqual(2000);
	},
);

it("distinguishes an undecided semantic layer from a semantic pass", () => {
	const source = view();
	source.evidence!.semantic = {
		status: "undetermined",
		evaluationId: "eval",
		modelSnapshotDigest: "f".repeat(64),
		alignmentVeto: false,
		coverageVeto: false,
	};
	expect(renderJudgmentMessage(source)).toContain(
		"语义复核：已跑，未形成有效判定",
	);
	expect(renderJudgmentMessage(source)).not.toContain("语义复核：通过");
});

it("budgets the entire message with 50 targets, 64 refs and escaped Unicode", () => {
	const multi = {
		...binding,
		targets: Array.from({ length: 50 }, (_, i) => ({
			...binding.targets[0]!,
			repo_identity: `仓库-${i}-${"r".repeat(100)}`,
		})),
	};
	const materials = evidenceMaterials(multi, NOW);
	materials.targets.forEach((target, i) => {
		target.designApproval!.requestId = `design-${i}`;
		target.codeReview!.requestId = `code-${i}`;
		target.qaAuthority!.claimId = `claim-${i}`;
	});
	const evidence = buildEvidenceLedger(materials, multi, {
		status: "evaluated",
		evaluationId: "evaluation",
		modelSnapshotDigest: "f".repeat(64),
		alignment: "pass",
		coverage: "pass",
	});
	expect(evidence.evidence).toHaveLength(64);
	const huge = "😀@everyone\\`[x](https://evil.invalid)".repeat(1000);
	const result = renderJudgmentMessage({
		...view(),
		evidence,
		marker: huge,
		opinionId: huge,
		evaluation: { alignment: { evidence: [{ quote: huge }] } },
	});
	expect(result.length).toBeLessThanOrEqual(1900);
	expect(result).toContain("条省略");
	expect(result).not.toContain("@everyone");
	expect(result).toContain("③ QA 用例覆盖：通过");
});
