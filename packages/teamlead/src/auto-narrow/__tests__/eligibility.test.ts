import { describe, expect, it } from "vitest";
import { evaluateAutoNarrowEligibility } from "../eligibility.js";

const base = {
	binding: {
		runId: "run-1",
		questionId: "question-1",
		gateExecutionId: "implement-1",
		repoIdentity: "__main__",
		prNumber: 1,
		headSha: "a".repeat(40),
	},
	observation: {
		run_id: "run-1",
		question_id: "question-1",
		gate_execution_id: "implement-1",
		repo_identity: "__main__",
		pr_number: 1,
		head_sha: "a".repeat(40),
		machine_class: "docs_only" as const,
		machine_reason: null,
		s2_ran_status: "satisfied" as const,
		s2_ran_reason: "ok" as const,
		s2_record_status: "satisfied" as const,
		s2_record_reason: "ok" as const,
		s2_verdict: "satisfied" as const,
		s2_basis_record_id: "strength-1",
	},
	declaration: {
		declaration_id: "11111111-1111-4111-8111-111111111111",
		declaration_seq: 1,
		question_id: "question-1",
		run_id: "run-1",
		declared_by: "flywheel-eng-lead",
		declared_class: "pure_docs" as const,
	},
	hasFounderRework: false,
	hasPendingFounderInput: false,
};

describe("auto narrow eligibility", () => {
	it("requires all three independently bound gates", () => {
		expect(evaluateAutoNarrowEligibility(base)).toEqual({
			eligible: true,
			gate1: true,
			gate2: true,
			gate3: true,
			reasonCode: "eligible",
		});
	});

	it.each([
		[
			"machine",
			{
				observation: {
					...base.observation,
					machine_class: "ship_relevant" as const,
				},
			},
			"gate1_failed",
		],
		[
			"declaration",
			{
				declaration: {
					...base.declaration,
					declared_class: "config_only" as const,
				},
			},
			"gate2_failed",
		],
		[
			"strength two",
			{
				observation: {
					...base.observation,
					s2_verdict: "unsatisfied" as const,
				},
			},
			"gate3_failed",
		],
	])("blocks when %s fails", (_label, override, reasonCode) => {
		expect(
			evaluateAutoNarrowEligibility({ ...base, ...override }),
		).toMatchObject({
			eligible: false,
			reasonCode,
		});
	});

	it("rejects facts bound to another card or head", () => {
		expect(
			evaluateAutoNarrowEligibility({
				...base,
				observation: { ...base.observation, head_sha: "b".repeat(40) },
			}),
		).toMatchObject({ eligible: false, gate1: false });
		expect(
			evaluateAutoNarrowEligibility({
				...base,
				declaration: { ...base.declaration, question_id: "question-2" },
			}),
		).toMatchObject({ eligible: false, gate2: false });
	});

	it("treats founder rework and pending founder input as hard negative guards", () => {
		for (const override of [
			{ hasFounderRework: true },
			{ hasPendingFounderInput: true },
		]) {
			expect(
				evaluateAutoNarrowEligibility({ ...base, ...override }),
			).toMatchObject({ eligible: false, reasonCode: "negative_guard" });
		}
	});
});
