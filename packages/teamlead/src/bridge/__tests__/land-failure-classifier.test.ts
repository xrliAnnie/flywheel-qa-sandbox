import { describe, expect, it } from "vitest";
import {
	classifyLandFailure,
	extractBoundedFailedStepLog,
	type LandFailureEvidence,
} from "../land-failure-classifier.js";

const HEAD = "a".repeat(40);

function evidence(
	overrides: Partial<LandFailureEvidence> = {},
): LandFailureEvidence {
	return {
		approvedHead: HEAD,
		pr: {
			state: "OPEN",
			headSha: HEAD,
			mergeStateStatus: "CLEAN",
			isDraft: false,
			reviewDecision: "APPROVED",
			checks: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
		},
		...overrides,
	};
}

describe("land failure classifier", () => {
	it.each([
		["DIRTY", "merge_conflict", "merge_conflict"],
		["UNKNOWN", "unknown", "mergeability_pending"],
		["BLOCKED", "policy_blocked", "policy_blocked"],
		["CLEAN", "unknown", "ship_failure_unknown"],
		["BEHIND", "unknown", "ship_failure_unknown"],
		["HAS_HOOKS", "unknown", "ship_failure_unknown"],
		["UNSTABLE", "unknown", "ship_failure_unknown"],
	] as const)(
		"classifies mergeStateStatus=%s without inventing a cause",
		(mergeStateStatus, kind, reason) => {
			expect(
				classifyLandFailure(
					evidence({
						pr: {
							...evidence().pr,
							mergeStateStatus,
						},
					}),
				),
			).toEqual({ kind, reason });
		},
	);

	it("fails closed on a future mergeStateStatus enum", () => {
		expect(
			classifyLandFailure(
				evidence({
					pr: {
						...evidence().pr,
						mergeStateStatus: "FUTURE_GITHUB_STATE",
					},
				}),
			),
		).toEqual({ kind: "unknown", reason: "merge_state_unknown" });
	});

	it("treats a draft as a terminal policy block", () => {
		expect(
			classifyLandFailure(
				evidence({ pr: { ...evidence().pr, isDraft: true } }),
			),
		).toEqual({ kind: "policy_blocked", reason: "policy_blocked" });
	});

	it("keeps a transient BLOCKED PR in alignment when checks are pending", () => {
		expect(
			classifyLandFailure(
				evidence({
					pr: {
						...evidence().pr,
						mergeStateStatus: "BLOCKED",
						checks: [{ status: "IN_PROGRESS", conclusion: null }],
					},
				}),
			),
		).toEqual({ kind: "unknown", reason: "policy_alignment_pending" });
	});

	it("recognizes an exact-head merge independently of a losing workflow", () => {
		expect(
			classifyLandFailure(
				evidence({
					pr: { ...evidence().pr, state: "MERGED" },
					workflow: {
						conclusion: "failure",
						failedStep: { number: 9, name: "✅ Merge PR" },
						structuredReason: "merge_conflict",
					},
				}),
			),
		).toEqual({ kind: "merged_externally", reason: "merged_externally" });
	});

	it("recognizes a moved head before interpreting stale failure evidence", () => {
		expect(
			classifyLandFailure(
				evidence({
					pr: { ...evidence().pr, headSha: "b".repeat(40) },
					workflow: {
						conclusion: "failure",
						failedStep: { number: 9, name: "✅ Merge PR" },
						structuredReason: "merge_conflict",
					},
				}),
			),
		).toEqual({ kind: "head_moved", reason: "head_moved" });
	});

	it.each(["cancelled", "timed_out"])(
		"classifies a %s workflow as cancelled",
		(conclusion) => {
			expect(
				classifyLandFailure(evidence({ workflow: { conclusion } })),
			).toEqual({
				kind: "cancelled",
				reason: "ship_workflow_failed:cancelled",
			});
		},
	);

	it("uses the failed step envelope to distinguish CI from merge failure", () => {
		expect(
			classifyLandFailure(
				evidence({
					workflow: {
						conclusion: "failure",
						failedStep: { number: 8, name: "Test" },
						structuredReason: "merge_conflict",
					},
				}),
			),
		).toEqual({
			kind: "ci_failure",
			reason: "ship_workflow_failed:ci_failure",
		});
	});

	it.each([
		["merge_conflict", "merge_conflict", "merge_conflict"],
		["head_moved", "head_moved", "head_moved"],
		["external_outage", "external_outage", "external_outage"],
		["merge_error:5xx", "external_outage", "external_outage"],
	] as const)(
		"maps structured merge receipt %s to %s",
		(structuredReason, kind, reason) => {
			expect(
				classifyLandFailure(
					evidence({
						workflow: {
							conclusion: "failure",
							failedStep: { number: 9, name: "✅ Merge PR" },
							structuredReason,
						},
					}),
				),
			).toEqual({ kind, reason });
		},
	);

	it("keeps a recovered CLEAN probe subordinate to a framed outage receipt", () => {
		expect(
			classifyLandFailure(
				evidence({
					workflow: {
						conclusion: "failure",
						failedStep: { number: 9, name: "✅ Merge PR" },
						failedStepLog:
							"RequestError [HttpError]: Service unavailable (status 503)",
					},
				}),
			),
		).toEqual({ kind: "external_outage", reason: "external_outage" });
	});

	it("does not mine a 503 token printed by an earlier test step", () => {
		expect(
			classifyLandFailure(
				evidence({
					workflow: {
						conclusion: "failure",
						failedStep: { number: 9, name: "✅ Merge PR" },
						failedStepLog: "merge failed for an unclassified reason",
					},
				}),
			),
		).toEqual({ kind: "unknown", reason: "ship_failure_unknown" });
	});

	it("normalizes probe transport failures as external outage", () => {
		expect(
			classifyLandFailure(evidence({ probeErrorClass: "rate_limit" })),
		).toEqual({ kind: "external_outage", reason: "external_outage" });
	});
});

describe("failed Actions step framing", () => {
	const log = [
		"2026-08-17T10:00:00.000Z Test output mentions HTTP 503 as fixture data",
		"2026-08-17T10:01:00.000Z Test finished",
		"2026-08-17T10:02:00.000Z RequestError [HttpError]: Pull Request is not mergeable (status 405)",
		"2026-08-17T10:03:00.000Z Report failure",
	].join("\n");

	it("extracts only the uniquely identified failed step time window", () => {
		expect(
			extractBoundedFailedStepLog({
				log,
				failedStep: { number: 9, name: "✅ Merge PR" },
				steps: [
					{
						number: 8,
						name: "Test",
						startedAt: "2026-08-17T09:59:00.000Z",
						completedAt: "2026-08-17T10:01:59.999Z",
					},
					{
						number: 9,
						name: "✅ Merge PR",
						startedAt: "2026-08-17T10:02:00.000Z",
						completedAt: "2026-08-17T10:02:59.999Z",
					},
				],
			}),
		).toBe(
			"2026-08-17T10:02:00.000Z RequestError [HttpError]: Pull Request is not mergeable (status 405)",
		);
	});

	it("fails closed when step identity is ambiguous", () => {
		expect(
			extractBoundedFailedStepLog({
				log,
				failedStep: { number: 9, name: "✅ Merge PR" },
				steps: [
					{
						number: 9,
						name: "✅ Merge PR",
						startedAt: "2026-08-17T10:02:00.000Z",
						completedAt: "2026-08-17T10:02:59.999Z",
					},
					{
						number: 9,
						name: "✅ Merge PR",
						startedAt: "2026-08-17T10:02:00.000Z",
						completedAt: "2026-08-17T10:02:59.999Z",
					},
				],
			}),
		).toBeNull();
	});

	it("rejects a log larger than the 256KB evidence budget", () => {
		expect(
			extractBoundedFailedStepLog({
				log: "x".repeat(256 * 1024 + 1),
				failedStep: { number: 9, name: "✅ Merge PR" },
				steps: [
					{
						number: 9,
						name: "✅ Merge PR",
						startedAt: "2026-08-17T10:02:00.000Z",
						completedAt: "2026-08-17T10:02:59.999Z",
					},
				],
			}),
		).toBeNull();
	});
});
