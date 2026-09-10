import { describe, expect, it } from "vitest";
import {
	isExplicitFounderKickback,
	isFixedFounderCardApproval,
	resolveFounderReworkRoute,
	resolveWorkflowReworkTarget,
} from "../workflow-rework-hint.js";

describe("FLY-2461 bilingual founder approval", () => {
	it("accepts the founder's observed Chinese approval", () => {
		expect(isFixedFounderCardApproval("通过")).toBe(true);
	});
	it.each([
		"可以",
		"同意",
		"批准",
		"行",
		"上线",
		"look good to me",
		"通过！。",
	])("rejects %s", (text) => {
		expect(isFixedFounderCardApproval(text)).toBe(false);
	});
	it.each(["通过", "approve", "APPROVE"])(
		"normalizes punctuation and whitespace for %s",
		(text) => expect(isFixedFounderCardApproval(`  ${text}！  `)).toBe(true),
	);
	it.each([
		"不通过",
		"可以吗",
		"通过？",
		"行不行",
		"通过以后再说",
		"可以了",
		"都可以了",
		"通过了",
		"LGTM",
		"approved",
		"通过 👍",
		"批准 ✅",
		"approve?",
	])("rejects non-protocol text %s", (text) =>
		expect(isFixedFounderCardApproval(text)).toBe(false),
	);
	// Keep this language matrix in sync whenever kickback gains a language.
	// It locks current en/zh parity, not discovery of future language additions.
	it.each([
		{
			language: "en",
			approvals: ["approve"],
			kickbacks: ["design:", "implement:", "qa:"],
		},
		{
			language: "zh",
			approvals: ["通过"],
			kickbacks: ["打回", "设计:", "实现:", "测试:"],
		},
	])(
		"approval covers kickback language $language",
		({ approvals, kickbacks }) => {
			expect(kickbacks.every(isExplicitFounderKickback)).toBe(true);
			expect(approvals.every(isFixedFounderCardApproval)).toBe(true);
		},
	);
});

function topology(designId: string) {
	return {
		manifest: {
			edges: [
				{ from: designId, to: "implement" },
				{ from: "implement", to: "qa" },
				{ from: "qa", to: "founder_gate" },
			],
			loops: [
				{ from: "founder_gate", to: "implement" },
				{ from: "qa", to: "implement" },
			],
		},
		resolved: {
			nodes: [
				{ id: designId, type: "design", dispatch: {} },
				{ id: "implement", type: "implement", dispatch: {} },
				{ id: "qa", type: "qa", dispatch: {} },
				{ id: "founder_gate", type: "gate" },
			],
		},
	};
}

describe("semantic workflow rework targets", () => {
	it.each([
		["old English", "design", "design"],
		["old Chinese", "design", "设计"],
		["new English", "eng_design", "design"],
		["new Chinese", "eng_design", "设计"],
	] as const)(
		"resolves %s design through the pinned node type",
		(_, designId, token) => {
			const route = resolveFounderReworkRoute(topology(designId), token);
			expect(route).toEqual({
				semanticTarget: "design",
				targetNodeId: designId,
				invalidationScope: [designId, "implement", "qa"],
				verificationPolicy: [
					"design_review",
					"code_review",
					"qa_retest",
					"founder_gate",
				],
			});
		},
	);

	it.each([
		["implement", "implement", ["implement", "qa"]],
		["实现", "implement", ["implement", "qa"]],
		["qa", "qa", ["qa"]],
		["测试", "qa", ["qa"]],
	] as const)(
		"resolves %s and derives its reachable executable route",
		(token, id, scope) => {
			const route = resolveFounderReworkRoute(topology("eng_design"), token);
			expect(route.targetNodeId).toBe(id);
			expect(route.invalidationScope).toEqual(scope);
		},
	);

	it("keeps an exact custom node id available to the operator path", () => {
		const value = topology("eng_design");
		value.resolved.nodes.splice(1, 0, {
			id: "security_review",
			type: "implement",
			dispatch: {},
		});
		expect(resolveWorkflowReworkTarget(value, "security_review").id).toBe(
			"security_review",
		);
	});

	it("fails loudly when a semantic target is absent or ambiguous", () => {
		const value = topology("eng_design");
		value.resolved.nodes.splice(1, 0, {
			id: "second_design",
			type: "design",
			dispatch: {},
		});
		expect(() => resolveFounderReworkRoute(value, "design")).toThrow(
			/ambiguous.*design/i,
		);
		expect(() =>
			resolveFounderReworkRoute(topology("eng_design"), "review"),
		).toThrow(/unknown.*review/i);
	});
});
