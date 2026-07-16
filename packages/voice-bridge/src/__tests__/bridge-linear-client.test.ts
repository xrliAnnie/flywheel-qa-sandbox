/**
 * FLY-545 PR-2 — BridgeLinearClient route-contract tests (mock fetch).
 * The shapes must stay byte-aligned with the Bridge proxy handlers
 * (create-issue on main; comment + issue-lookup per the P12 contract).
 */
import { describe, expect, it, vi } from "vitest";
import {
	BridgeLinearClient,
	BridgeLinearError,
} from "../linear/BridgeLinearClient.js";

function client(
	responses: Array<{ status: number; body: unknown }>,
	calls: Array<{ url: string; init: RequestInit }> = [],
) {
	let i = 0;
	const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
		calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
		const r = responses[Math.min(i++, responses.length - 1)] ?? {
			status: 200,
			body: {},
		};
		return new Response(JSON.stringify(r.body), { status: r.status });
	});
	return {
		c: new BridgeLinearClient({
			bridgeUrl: "http://127.0.0.1:9876/",
			apiToken: "secret-token",
			projectName: "flywheel",
			fetchFn: fetchFn as unknown as typeof fetch,
		}),
		calls,
		fetchFn,
	};
}

describe("createIssue", () => {
	it("POSTs title+description+projectName and unwraps the issue envelope", async () => {
		const { c, calls } = client([
			{
				status: 200,
				body: {
					ok: true,
					issue: { id: "uuid-1", identifier: "FLY-999", url: "https://l/999" },
				},
			},
		]);
		const created = await c.createIssue({
			title: "2026-07-07 15:00 · huddle(Annie, Tadashi)",
			description: "参与者: …",
		});
		expect(created).toEqual({
			id: "uuid-1",
			identifier: "FLY-999",
			url: "https://l/999",
		});
		expect(calls[0]?.url).toBe("http://127.0.0.1:9876/api/linear/create-issue");
		expect(calls[0]?.init.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			title: "2026-07-07 15:00 · huddle(Annie, Tadashi)",
			description: "参与者: …",
			projectName: "flywheel",
		});
		expect(
			(calls[0]?.init.headers as Record<string, string>).authorization,
		).toBe("Bearer secret-token");
	});

	it("an issue-less 200 is still an error (no silent half-success)", async () => {
		const { c } = client([{ status: 200, body: { ok: true } }]);
		await expect(c.createIssue({ title: "t" })).rejects.toThrow(
			/no issue identifier/,
		);
	});
});

describe("comment / setStatus / lookupIssue", () => {
	it("comment POSTs issueId+body+projectName", async () => {
		const { c, calls } = client([{ status: 200, body: { ok: true } }]);
		await c.comment("FLY-999", "## 会议纪要\n…");
		expect(calls[0]?.url).toBe("http://127.0.0.1:9876/api/linear/comment");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			issueId: "FLY-999",
			body: "## 会议纪要\n…",
			projectName: "flywheel",
		});
	});

	it("setStatus PATCHes update-issue with a state NAME", async () => {
		const { c, calls } = client([{ status: 200, body: { ok: true } }]);
		await c.setStatus("FLY-999", "Done");
		expect(calls[0]?.url).toBe("http://127.0.0.1:9876/api/linear/update-issue");
		expect(calls[0]?.init.method).toBe("PATCH");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			issueId: "FLY-999",
			status: "Done",
		});
	});

	it("lookupIssue GETs with query/projectName/limit and returns the match envelope", async () => {
		const { c, calls } = client([
			{
				status: 200,
				body: { matchType: "identifier", issue: { identifier: "FLY-545" } },
			},
		]);
		const r = await c.lookupIssue("FLY-545");
		expect(r.matchType).toBe("identifier");
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:9876/api/linear/issue?query=FLY-545&projectName=flywheel&limit=5",
		);
		expect(calls[0]?.init.method).toBe("GET");
	});
});

describe("failure semantics", () => {
	it("non-2xx throws BridgeLinearError with the server's error text + status", async () => {
		const { c } = client([
			{ status: 404, body: { error: 'issue "FLY-0" not found' } },
		]);
		const err = await c.comment("FLY-0", "x").catch((e) => e);
		expect(err).toBeInstanceOf(BridgeLinearError);
		expect((err as BridgeLinearError).status).toBe(404);
		expect((err as Error).message).toContain('issue "FLY-0" not found');
	});

	it("network failure throws with status 0 and never leaks the token", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("ECONNREFUSED 127.0.0.1:9876");
		});
		const c = new BridgeLinearClient({
			bridgeUrl: "http://127.0.0.1:9876",
			apiToken: "secret-token",
			projectName: "flywheel",
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const err = await c.lookupIssue("FLY-1").catch((e) => e);
		expect(err).toBeInstanceOf(BridgeLinearError);
		expect((err as BridgeLinearError).status).toBe(0);
		expect((err as Error).message).not.toContain("secret-token");
	});
});
