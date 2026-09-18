import { describe, expect, it, vi } from "vitest";
import type { CoSPorts } from "./ports.js";
import { planSummaryRound } from "./summary-absorption.js";

describe("summary absorption business", () => {
	it("plans review material and durable questions without executing transport", async () => {
		const ports = {
			request: vi.fn(() => {
				throw new Error("planning must not send");
			}),
		} as unknown as CoSPorts;
		const summary = {
			pr: 42,
			path: "summaries/flywheel/2026-09-08--eng-lead--01.md",
			project: "flywheel",
			lead: "flywheel-eng-lead",
			facts: "The implementation is ready.",
			judgment: "",
		};
		const result = await planSummaryRound(
			{
				roundId: "summary-absorption:2026-09-08T20:00:00.000Z",
				summaries: [
					summary,
					{ ...summary, pr: 43, judgment: "Deploy after QA." },
				],
			},
			ports,
		);
		expect(result).not.toHaveProperty("mergeCandidates");
		expect(result.reviewCandidates).toEqual([
			{ ...summary, pr: 43, judgment: "Deploy after QA." },
		]);
		expect(result.pendingQuestions).toEqual([
			expect.objectContaining({
				pr: 42,
				requestId: "summary-absorption:2026-09-08T20:00:00.000Z:pr:42",
				revision: 1,
				to: { project: "flywheel", leadId: "flywheel-eng-lead" },
				reason: "judgment_missing",
			}),
		]);
		expect(ports.request).not.toHaveBeenCalled();
	});
	it("validates the round identity even when no questions need sending", async () => {
		await expect(
			planSummaryRound({ roundId: "invalid", summaries: [] }, {} as CoSPorts),
		).rejects.toThrow(/round/);
	});
});
