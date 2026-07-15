import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewRuling } from "../commands/review-ruling.js";

class ExitSentinel extends Error {
	constructor(public code: number) {
		super(`exit ${code}`);
	}
}

describe("review-ruling", () => {
	beforeEach(() => {
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ExitSentinel(code ?? 0);
		}) as never);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => vi.restoreAllMocks());

	const env = {
		FLYWHEEL_BRIDGE_URL: "http://bridge.test",
		FLYWHEEL_INGEST_TOKEN: "token",
	} as NodeJS.ProcessEnv;

	async function run(opts: Parameters<typeof reviewRuling>[0]) {
		try {
			await reviewRuling({ env, ...opts });
			throw new Error("did not exit");
		} catch (err) {
			if (err instanceof ExitSentinel) return err.code;
			throw err;
		}
	}

	it("records an overruled finding through the authenticated Bridge endpoint", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						accepted: true,
						ruling: { ruling_id: "ruling-1", disposition: "overruled" },
					}),
					{ status: 201 },
				),
		);
		expect(
			await run({
				project: "flywheel",
				issue: "FLY-1251",
				finding: "metadata-lease",
				disposition: "overruled",
				reason: "Correctness wins.",
				lead: "flywheel-eng-lead",
				execId: "lead-exec",
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("http://bridge.test/review-rulings");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer token",
		);
		expect(JSON.parse(String(init.body))).toEqual({
			projectName: "flywheel",
			issue: "FLY-1251",
			findingKey: "metadata-lease",
			disposition: "overruled",
			rationale: "Correctness wins.",
			ruledBy: "flywheel-eng-lead",
			executionId: "lead-exec",
		});
	});

	it("supports exact request/index follow-up rulings", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ accepted: true, ruling: {} }), {
					status: 201,
				}),
		);
		expect(
			await run({
				project: "flywheel",
				issue: "FLY-1251",
				requestId: "req-8",
				findingIndex: 0,
				disposition: "follow-up",
				followUp: "FLY-1274",
				reason: "Tracked separately.",
				lead: "flywheel-eng-lead",
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).toBe(0);
		expect(
			JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)),
		).toMatchObject({
			requestId: "req-8",
			findingIndex: 0,
			disposition: "follow_up",
			followUpIssue: "FLY-1274",
		});
	});

	it("revokes by ruling id without requiring an issue locator", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ accepted: true, ruling: {} }), {
					status: 200,
				}),
		);
		expect(
			await run({
				project: "flywheel",
				revoke: "ruling-1",
				reason: "New evidence.",
				lead: "flywheel-eng-lead",
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).toBe(0);
		expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
			projectName: "flywheel",
			revokeRulingId: "ruling-1",
			rationale: "New evidence.",
			ruledBy: "flywheel-eng-lead",
		});
	});

	it("rejects malformed mutually-exclusive locators before the network", async () => {
		const fetchImpl = vi.fn();
		for (const opts of [
			{
				project: "flywheel",
				issue: "FLY-1251",
				disposition: "overruled",
				reason: "why",
				lead: "lead",
			},
			{
				project: "flywheel",
				issue: "FLY-1251",
				finding: "one",
				requestId: "two",
				findingIndex: 0,
				disposition: "overruled",
				reason: "why",
				lead: "lead",
			},
			{
				project: "flywheel",
				issue: "FLY-1251",
				finding: "one",
				disposition: "follow-up",
				reason: "why",
				lead: "lead",
			},
		]) {
			expect(
				await run({ ...opts, fetchImpl: fetchImpl as unknown as typeof fetch }),
			).toBe(1);
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns nonzero once on Bridge rejection or network failure", async () => {
		const base = {
			project: "flywheel",
			issue: "FLY-1251",
			finding: "one",
			disposition: "overruled",
			reason: "why",
			lead: "lead",
		};
		const rejected = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ accepted: false, reason: "finding_not_found" }),
					{ status: 400 },
				),
		);
		expect(
			await run({
				...base,
				fetchImpl: rejected as unknown as typeof fetch,
			}),
		).toBe(2);
		expect(rejected).toHaveBeenCalledTimes(1);

		const failed = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		expect(
			await run({ ...base, fetchImpl: failed as unknown as typeof fetch }),
		).toBe(2);
		expect(failed).toHaveBeenCalledTimes(1);
	});
});
