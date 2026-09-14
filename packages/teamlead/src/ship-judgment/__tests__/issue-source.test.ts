import { describe, expect, it, vi } from "vitest";
import type { LinearIssue } from "../../bridge/linear-query.js";
import { readJudgmentIssueSource } from "../issue-source.js";

describe("current Linear source", () => {
	it("uses exact lookup and freezes identity/revision without including credentials", async () => {
		const issue = {
			id: "12345678-1234-4234-8234-123456789012",
			identifier: "FLY-2399",
			title: "Learning",
			description: "R1: preserve scope",
			updatedAt: "2026-09-10T00:00:00Z",
		} as LinearIssue;
		const lookup = vi.fn(async () => issue);
		const signal = new AbortController().signal;
		const source = await readJudgmentIssueSource(
			"FLY-2399",
			"private-api-key",
			signal,
			lookup,
		);
		expect(source).toMatchObject({
			body: "# Learning\n\nR1: preserve scope",
			format: "text",
		});
		expect(lookup).toHaveBeenCalledWith("private-api-key", "FLY-2399", 20000);
		expect(source?.revision).toContain(issue.id);
		expect(JSON.stringify(source)).not.toContain("private-api-key");
		for (const changed of [
			{ identifier: "FLY-1" },
			{ id: "invalid" },
			{ updatedAt: "unknown" },
			{ description: "x".repeat(262145) },
		]) {
			expect(
				await readJudgmentIssueSource("FLY-2399", "key", signal, async () => ({
					...issue,
					...changed,
				})),
			).toBeNull();
		}
		const abort = new AbortController();
		abort.abort();
		const count = lookup.mock.calls.length;
		expect(
			await readJudgmentIssueSource("FLY-2399", "key", abort.signal, lookup),
		).toBeNull();
		expect(lookup).toHaveBeenCalledTimes(count);
		expect(
			await readJudgmentIssueSource("FLY-2399", "key", signal, async () => {
				throw new Error("secret upstream body");
			}),
		).toBeNull();
	});
});
