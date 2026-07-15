/**
 * FLY-967 P5 — the assistant's two read-only Live tools (lookup_issue /
 * board_snapshot) against a mocked Bridge HTTP. Every call carries the
 * projectName scope (Codex R1 #4) and the bearer token travels in headers,
 * never in the URL. Failures inject explicit text — a silent tool would hang
 * the Live turn forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AssistantToolDeps,
	buildAssistantTools,
} from "../assistant/tools.js";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("assistant tools (FLY-967 P5)", () => {
	let calls: FetchCall[];
	let nextResponse: () => Promise<Response>;
	let deps: AssistantToolDeps;

	beforeEach(() => {
		calls = [];
		nextResponse = async () =>
			jsonResponse(200, {
				matchType: "identifier",
				issue: {
					identifier: "FLY-967",
					title: "纯 Gemini Live 语音助理",
					state: "In Progress",
					assignee: "runner",
					url: "https://linear.app/t/issue/FLY-967",
					updatedAt: "2026-07-07T10:00:00.000Z",
				},
			});
		deps = {
			bridgeUrl: "http://127.0.0.1:9876",
			apiToken: "secret-token",
			projectName: "flywheel",
			timeoutMs: 5000,
			fetchImpl: (async (url: string | URL, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} });
				return nextResponse();
			}) as unknown as typeof fetch,
		};
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function tools() {
		const [lookup, board] = buildAssistantTools(deps);
		return { lookup, board };
	}

	const signal = () => ({ signal: new AbortController().signal });

	it("declares both tools with schemas the model can actually call", () => {
		const { lookup, board } = tools();
		expect(lookup.declaration.name).toBe("lookup_issue");
		expect(lookup.declaration.description).toMatch(/read-only/i);
		expect(lookup.declaration.parameters).toMatchObject({
			type: "OBJECT",
			required: ["query"],
		});
		expect(board.declaration.name).toBe("board_snapshot");
		expect(board.declaration.parameters).toMatchObject({ type: "OBJECT" });
	});

	it("lookup_issue: identifier hit → single-issue summary text", async () => {
		const { lookup } = tools();
		const out = await lookup.handler({ query: "FLY-967" }, signal());
		expect(out).toContain("FLY-967");
		expect(out).toContain("纯 Gemini Live 语音助理");
		expect(out).toContain("In Progress");
	});

	it("every call carries projectName scope + bearer header, token never in URL", async () => {
		const { lookup, board } = tools();
		await lookup.handler({ query: "FLY-967" }, signal());
		nextResponse = async () => jsonResponse(200, { issues: [], count: 0 });
		await board.handler({}, signal());
		expect(calls).toHaveLength(2);
		for (const c of calls) {
			expect(c.url).toContain("projectName=flywheel");
			expect(c.url).not.toContain("secret-token");
			expect((c.init.headers as Record<string, string>).Authorization).toBe(
				"Bearer secret-token",
			);
		}
		expect(calls[0].url).toContain("/api/linear/issue?");
		expect(calls[1].url).toContain("/api/linear/issues?");
		expect(calls[1].url).toContain("slim=1");
	});

	it("lookup_issue: keyword match → short list text", async () => {
		nextResponse = async () =>
			jsonResponse(200, {
				matchType: "keyword",
				issues: [
					{ identifier: "FLY-967", title: "语音助理", state: "In Progress" },
					{ identifier: "FLY-545", title: "Huddle B", state: "In Review" },
				],
				count: 2,
			});
		const { lookup } = tools();
		const out = await lookup.handler({ query: "voice" }, signal());
		expect(out).toContain("FLY-967");
		expect(out).toContain("FLY-545");
		expect(out).toContain("In Review");
	});

	it("lookup_issue: 404 → explicit 没找到 text (not a throw)", async () => {
		nextResponse = async () =>
			jsonResponse(404, { error: 'no issue matched "ghost"' });
		const { lookup } = tools();
		const out = await lookup.handler({ query: "ghost" }, signal());
		expect(out).toContain("没找到");
		expect(out).toContain("ghost");
	});

	it("HTTP failure injects explicit error text, never silence", async () => {
		nextResponse = async () => jsonResponse(502, { error: "Linear API error" });
		const { lookup } = tools();
		const out = await lookup.handler({ query: "FLY-1" }, signal());
		expect(out).toMatch(/查询失败/);
	});

	it("timeout aborts the fetch and injects explicit timeout text", async () => {
		vi.useFakeTimers();
		deps.fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			});
		}) as unknown as typeof fetch;
		const { lookup } = tools();
		const p = lookup.handler({ query: "FLY-967" }, signal());
		await vi.advanceTimersByTimeAsync(5001);
		const out = await p;
		expect(out).toMatch(/超时/);
	});

	it("caller abort (barge-in / cancellation) propagates to the fetch", async () => {
		let fetchAborted = false;
		deps.fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					fetchAborted = true;
					reject(new Error("aborted"));
				});
			});
		}) as unknown as typeof fetch;
		const { lookup } = tools();
		const ac = new AbortController();
		const p = lookup.handler({ query: "FLY-967" }, { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toThrow();
		expect(fetchAborted).toBe(true);
	});

	it("board_snapshot: groups issues by state, honors state filter, truncates at 2k", async () => {
		nextResponse = async () =>
			jsonResponse(200, {
				issues: [
					{ identifier: "FLY-967", title: "语音助理", state: "In Progress" },
					{ identifier: "FLY-545", title: "Huddle B", state: "In Progress" },
					{ identifier: "FLY-546", title: "语音批准", state: "Todo" },
				],
				count: 3,
			});
		const { board } = tools();
		const out = await board.handler({ state: "In Progress" }, signal());
		// the route's `state` param filters by Linear state TYPE, so the
		// name-level filter ("In Progress") is applied client-side — the URL
		// must NOT carry it.
		expect(calls[0].url).not.toContain("state=");
		expect(out).toContain("In Progress");
		expect(out).toContain("FLY-967");
		expect(out).not.toContain("FLY-546"); // Todo filtered out by name

		nextResponse = async () =>
			jsonResponse(200, {
				issues: Array.from({ length: 200 }, (_, i) => ({
					identifier: `FLY-${i}`,
					title: `很长的标题${"填充".repeat(20)}`,
					state: "Todo",
				})),
				count: 200,
			});
		const big = await board.handler({}, signal());
		expect(big.length).toBeLessThanOrEqual(2000);
	});

	it("board_snapshot: empty board is explicit", async () => {
		nextResponse = async () => jsonResponse(200, { issues: [], count: 0 });
		const { board } = tools();
		const out = await board.handler({}, signal());
		expect(out).toContain("没有");
	});

	it("malformed args (missing query) get explicit text, not a crash", async () => {
		const { lookup } = tools();
		const out = await lookup.handler({}, signal());
		expect(out).toMatch(/需要.*query|缺少/);
		expect(calls).toHaveLength(0); // no pointless HTTP call
	});
});
