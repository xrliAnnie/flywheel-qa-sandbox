import { describe, expect, it, vi } from "vitest";
import { listSummaryPulls } from "../summary-delivery-ledger.js";

const summaryPull = {
	number: 24,
	url: "https://github.com/xrliAnnie/raya/pull/24",
	state: "OPEN",
	createdAt: "2026-09-06T23:01:12Z",
	headRefName: "summary/growth/reflection-lead/269dc60b2dd3fb93",
};

function execWith(value: unknown) {
	return vi.fn(async () => ({ stdout: JSON.stringify(value), stderr: "" }));
}

describe("FLY-2382 summary delivery ledger", () => {
	it("reads every PR state with a bounded command and keeps only strict summary branches", async () => {
		const exec = execWith([
			summaryPull,
			{
				...summaryPull,
				number: 23,
				url: "https://github.com/xrliAnnie/raya/pull/23",
				state: "MERGED",
				headRefName: "feature/not-a-summary",
			},
		]);

		await expect(listSummaryPulls(exec)).resolves.toEqual({
			status: "ok",
			pulls: [
				{
					number: 24,
					url: summaryPull.url,
					state: "OPEN",
					project: "growth",
					lead: "reflection-lead",
					headRefName: summaryPull.headRefName,
					createdAt: Date.parse(summaryPull.createdAt),
				},
			],
		});
		expect(exec).toHaveBeenCalledWith(
			"gh",
			[
				"pr",
				"list",
				"--repo",
				"xrliAnnie/raya",
				"--state",
				"all",
				"--limit",
				"500",
				"--json",
				"number,url,state,createdAt,headRefName",
			],
			{ timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
		);
	});

	it("fails closed when the bounded result could be truncated", async () => {
		const pulls = Array.from({ length: 500 }, (_, index) => ({
			...summaryPull,
			number: index + 1,
			url: `https://github.com/xrliAnnie/raya/pull/${index + 1}`,
		}));
		await expect(listSummaryPulls(execWith(pulls))).resolves.toEqual({
			status: "unavailable",
			reason: "truncated at gh --limit 500",
		});
	});

	it.each([
		["root", {}, "malformed gh output: root"],
		["number", [{ ...summaryPull, number: 0 }], "malformed gh output: number"],
		[
			"state",
			[{ ...summaryPull, state: "UNKNOWN" }],
			"malformed gh output: state",
		],
		[
			"url host",
			[{ ...summaryPull, url: "https://example.com/xrliAnnie/raya/pull/24" }],
			"malformed gh output: url",
		],
		[
			"url number",
			[{ ...summaryPull, url: "https://github.com/xrliAnnie/raya/pull/25" }],
			"malformed gh output: url",
		],
		[
			"branch",
			[{ ...summaryPull, headRefName: 42 }],
			"malformed gh output: headRefName",
		],
		[
			"createdAt",
			[{ ...summaryPull, createdAt: "not-a-date" }],
			"malformed gh output: createdAt",
		],
	] as const)(
		"rejects malformed %s without partial truth",
		async (_name, value, reason) => {
			await expect(listSummaryPulls(execWith(value))).resolves.toEqual({
				status: "unavailable",
				reason,
			});
		},
	);

	it("normalizes command failures without leaking stderr", async () => {
		const failed = vi.fn(async () => {
			throw Object.assign(new Error("secret stderr"), { code: 7 });
		});
		await expect(listSummaryPulls(failed)).resolves.toEqual({
			status: "unavailable",
			reason: "gh exit 7",
		});

		const timedOut = vi.fn(async () => {
			throw Object.assign(new Error("timed out with secret stderr"), {
				killed: true,
			});
		});
		await expect(listSummaryPulls(timedOut)).resolves.toEqual({
			status: "unavailable",
			reason: "timeout",
		});
	});
});
