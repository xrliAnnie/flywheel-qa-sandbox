import { expect, it } from "vitest";
import { validateBetaReceipt } from "../beta-release-receipt.js";

const expected = {
	projectName: "a",
	repositoryId: 1,
	workflowId: 2,
	runId: 3,
	scheduleKey: "a".repeat(64),
	sourceCommit: "b".repeat(40),
};
const receipt = {
	schemaVersion: 1,
	...expected,
	outcome: "published",
	publishedSourceCommit: expected.sourceCommit,
	publishedVersion: "beta-bbbb",
	publishedAt: "2026-09-11T00:00:00.000Z",
};
it("requires a bound real publication receipt, not merely a successful run", () => {
	expect(validateBetaReceipt(receipt, expected)).toEqual(receipt);
	for (const patch of [
		{ projectName: "other" },
		{ scheduleKey: "c".repeat(64) },
		{ runId: 4 },
		{ sourceCommit: "c".repeat(40) },
		{ publishedSourceCommit: "c".repeat(40) },
		{ publishedVersion: null },
		{ publishedAt: "yesterday" },
		{ extra: true },
		{ outcome: "superseded" },
	]) {
		expect(() =>
			validateBetaReceipt({ ...receipt, ...patch }, expected),
		).toThrow("beta_receipt_invalid");
	}
	expect(
		validateBetaReceipt(
			{
				...receipt,
				outcome: "not_activated",
				publishedSourceCommit: null,
				publishedVersion: null,
				publishedAt: null,
			},
			expected,
		).outcome,
	).toBe("not_activated");
	expect(() =>
		validateBetaReceipt({ ...receipt, outcome: "not_activated" }, expected),
	).toThrow();
});
