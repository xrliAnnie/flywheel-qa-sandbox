import { describe, expect, it } from "vitest";
import {
	isWorkflowPhaseRole,
	PHASE_ROLE_SEQUENCE,
	PHASE_THREAD_BADGE,
	phaseMessageTag,
	phaseThreadBadge,
	resolveCompletionSessionRole,
} from "../phase-roles.js";

describe("DAG workflow roles", () => {
	it("derives the ordered workflow roles and badges from the node registry", () => {
		expect(PHASE_ROLE_SEQUENCE).toEqual(["design", "implement", "qa"]);
		expect(PHASE_THREAD_BADGE).toEqual({
			design: "🎨设计",
			implement: "🔨实现",
			qa: "🧪QA",
		});
		expect(phaseThreadBadge("qa")).toBe("🧪QA");
	});

	it("recognizes only DAG workflow roles", () => {
		expect(isWorkflowPhaseRole("design")).toBe(true);
		expect(isWorkflowPhaseRole("implement")).toBe(true);
		expect(isWorkflowPhaseRole("qa")).toBe(true);
		expect(isWorkflowPhaseRole("main")).toBe(false);
		expect(isWorkflowPhaseRole(undefined)).toBe(false);
	});

	it("preserves a dispatched role across completion", () => {
		expect(resolveCompletionSessionRole("design", "main")).toBe("design");
		expect(resolveCompletionSessionRole("implement", undefined)).toBe(
			"implement",
		);
		expect(resolveCompletionSessionRole("main", "qa")).toBe("qa");
		expect(resolveCompletionSessionRole(undefined, undefined)).toBe("main");
	});

	it("never invents a display model when a pending row has no runtime model", () => {
		expect(phaseMessageTag("design", "claude-fable-5")).toBe("[设计·Fable] ");
		expect(phaseMessageTag("implement", "gpt-5.6-sol")).toBe("[实现·GPT-5.6] ");
		expect(phaseMessageTag("qa", undefined)).toBe("[QA] ");
		expect(phaseMessageTag("main", "claude-opus-5")).toBe("");
	});
});
