import { describe, expect, it } from "vitest";
import {
	resolveFounderReworkRoute,
	resolveWorkflowReworkTarget,
} from "../workflow-rework-hint.js";

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
