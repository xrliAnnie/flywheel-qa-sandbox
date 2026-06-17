/**
 * FLY-286 PR-2: web-local review route handler tests (mock-first, injected deps).
 */

import type {
	AnalysisStore,
	FeedbackStore,
	XiaohongshuAnalysisRun,
	XiaohongshuFeedbackFile,
} from "flywheel-comm/xiaohongshu-analysis-store";
import type { ReviewLocator } from "flywheel-comm/xiaohongshu-review-locator";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createInMemoryTokenStore,
	handleGetReview,
	handlePostAction,
	type XhsReviewDeps,
} from "../bridge/xhs-review-routes.js";

const REPORT = "rep-token-1";
const LOC: ReviewLocator = {
	schemaVersion: 1,
	reportToken: REPORT,
	project: "flywheel",
	collectionId: "c1",
	runToken: "run-1",
	createdAt: "2026-06-17T00:00:00Z",
};

function mockRun(): XiaohongshuAnalysisRun {
	return {
		schemaVersion: 1,
		runToken: "run-1",
		execId: "e1",
		project: "flywheel",
		collectionId: "c1",
		collectionLabel: "claude",
		generatedAt: "2026-06-17T00:00:00Z",
		sourceWindow: { fetched: 1, total: 1, capped: false },
		posts: [
			{
				noteId: "n1",
				title: "t1",
				url: "https://www.xiaohongshu.com/explore/n1",
				mediaKinds: ["text"],
				summary: "s1",
				judgment: { useful: true, reason: "r" },
				createdIssue: { issueId: "FLY-900", opId: "op-n1", state: "triage" },
				status: "created",
			},
		],
		summary: { analyzed: 1, created: 1, candidates: 0, skipped: 0 },
		review: { reportToken: REPORT },
	};
}

let feedbackFile: XiaohongshuFeedbackFile | null;
let deps: XhsReviewDeps;

beforeEach(() => {
	feedbackFile = null;
	const analysis: AnalysisStore = {
		readRun: (p, c, r) =>
			p === LOC.project && c === LOC.collectionId && r === LOC.runToken
				? mockRun()
				: null,
		writeRun: () => {},
		listRuns: () => [],
	};
	const feedback: FeedbackStore = {
		writeFeedback: (_p, _c, fb) => {
			feedbackFile = fb;
		},
		readFeedback: () => feedbackFile,
	};
	deps = {
		analysis,
		feedback,
		readLocator: (t) => (t === REPORT ? LOC : null),
		runExclusive: async (_p, _c, fn) => fn(),
		tokens: createInMemoryTokenStore({ now: () => 1000, ttlMs: 10_000 }),
		nonce: () => "NONCE",
		now: () => "2026-06-17T01:00:00Z",
	};
});

const LOOPBACK = { host: "127.0.0.1:9876" };
const SAME_ORIGIN = { ...LOOPBACK, origin: "http://127.0.0.1:9876" };

describe("handleGetReview", () => {
	it("serves HTML + scoped CSP for a valid report (no Origin needed)", async () => {
		const res = await handleGetReview(deps, REPORT, { ...LOOPBACK });
		expect(res.status).toBe(200);
		expect(res.contentType).toContain("text/html");
		expect(String(res.body)).toContain("Xiaohongshu learning review");
		expect(res.headers?.["Content-Security-Policy"]).toContain(
			"style-src 'nonce-NONCE'",
		);
		expect(res.headers?.["Content-Security-Policy"]).toContain(
			"img-src 'none'",
		);
	});

	it("403 on non-loopback host", async () => {
		const res = await handleGetReview(deps, REPORT, { host: "evil.com" });
		expect(res.status).toBe(403);
	});

	it("404 on unknown reportToken", async () => {
		const res = await handleGetReview(deps, "nope", { ...LOOPBACK });
		expect(res.status).toBe(404);
	});
});

/** Mint a valid session token for POST tests. */
function token(): string {
	return deps.tokens.mint(REPORT);
}

describe("handlePostAction", () => {
	it("403 cross-origin / non-loopback", async () => {
		expect(
			(await handlePostAction(deps, REPORT, {}, { host: "evil.com" })).status,
		).toBe(403);
		expect(
			(await handlePostAction(deps, REPORT, {}, { ...LOOPBACK })).status,
		).toBe(403); // missing Origin on POST
	});

	it("401 on missing/forged token", async () => {
		const res = await handlePostAction(
			deps,
			REPORT,
			{ noteId: "n1", action: "keep", sessionToken: "forged" },
			{ ...SAME_ORIGIN },
		);
		expect(res.status).toBe(401);
	});

	it("401 on a cross-run token", async () => {
		const otherTok = deps.tokens.mint("other-report");
		const res = await handlePostAction(
			deps,
			REPORT,
			{ noteId: "n1", action: "keep", sessionToken: otherTok },
			{ ...SAME_ORIGIN },
		);
		expect(res.status).toBe(401);
	});

	it("401 on an expired token", async () => {
		let clock = 1000;
		deps.tokens = createInMemoryTokenStore({ now: () => clock, ttlMs: 100 });
		const tok = deps.tokens.mint(REPORT);
		clock = 2000; // past TTL
		const res = await handlePostAction(
			deps,
			REPORT,
			{ noteId: "n1", action: "keep", sessionToken: tok },
			{ ...SAME_ORIGIN },
		);
		expect(res.status).toBe(401);
	});

	it("400 on unknown noteId / bad action / long comment", async () => {
		const tok = token();
		expect(
			(
				await handlePostAction(
					deps,
					REPORT,
					{ noteId: "zzz", action: "keep", sessionToken: tok },
					{ ...SAME_ORIGIN },
				)
			).status,
		).toBe(400);
		expect(
			(
				await handlePostAction(
					deps,
					REPORT,
					{ noteId: "n1", action: "nuke", sessionToken: tok },
					{ ...SAME_ORIGIN },
				)
			).status,
		).toBe(400);
		expect(
			(
				await handlePostAction(
					deps,
					REPORT,
					{
						noteId: "n1",
						action: "keep",
						sessionToken: tok,
						comment: "x".repeat(5000),
					},
					{ ...SAME_ORIGIN },
				)
			).status,
		).toBe(400);
	});

	it("records a valid action (close_created → targetOpId) + comment", async () => {
		const tok = token();
		const res = await handlePostAction(
			deps,
			REPORT,
			{
				noteId: "n1",
				action: "close_created",
				sessionToken: tok,
				comment: "not useful",
			},
			{ ...SAME_ORIGIN },
		);
		expect(res.status).toBe(200);
		expect(feedbackFile?.actions).toHaveLength(1);
		expect(feedbackFile?.actions[0]?.action).toBe("close_created");
		expect(feedbackFile?.actions[0]?.targetOpId).toBe("op-n1");
		expect(feedbackFile?.comments[0]?.text).toBe("not useful");
	});

	it("is idempotent (duplicate POST) + replaces by noteId (latest wins)", async () => {
		const tok = token();
		const post = (action: string) =>
			handlePostAction(
				deps,
				REPORT,
				{ noteId: "n1", action, sessionToken: tok },
				{ ...SAME_ORIGIN },
			);
		await post("keep");
		await post("keep"); // duplicate → still one
		expect(feedbackFile?.actions).toHaveLength(1);
		await post("close_created"); // changed decision → replaces, still one
		expect(feedbackFile?.actions).toHaveLength(1);
		expect(feedbackFile?.actions[0]?.action).toBe("close_created");
	});

	it("404 on a malformed reportToken (GET + POST) — no 500 (codex code R1#2)", async () => {
		const g = await handleGetReview(deps, "../escape", { ...LOOPBACK });
		expect(g.status).toBe(404);
		const tok = token();
		const p = await handlePostAction(
			deps,
			"../escape",
			{ noteId: "n1", action: "keep", sessionToken: tok },
			{ ...SAME_ORIGIN },
		);
		expect(p.status).toBe(404);
	});

	it("serializes concurrent POSTs under runExclusive — both distinct notes survive (codex code R1#5)", async () => {
		// A run with two notes + a REAL serializing runExclusive (promise chain).
		const twoNoteRun = {
			...mockRun(),
			posts: [
				mockRun().posts[0],
				{ ...mockRun().posts[0], noteId: "n2", status: "candidate" as const },
			],
		};
		deps.analysis.readRun = () => twoNoteRun;
		let chain: Promise<unknown> = Promise.resolve();
		deps.runExclusive = (_p, _c, fn) => {
			const next = chain.then(() => fn());
			chain = next.catch(() => {});
			return next as Promise<never>;
		};
		const tok = token();
		const mk = (noteId: string) =>
			handlePostAction(
				deps,
				REPORT,
				{ noteId, action: "promote_candidate", sessionToken: tok },
				{ ...SAME_ORIGIN },
			);
		await Promise.all([mk("n1"), mk("n2")]); // concurrent
		expect(feedbackFile?.actions.map((a) => a.noteId).sort()).toEqual([
			"n1",
			"n2",
		]);
	});

	it("404 on an OVERLONG safe-char reportToken, BEFORE readLocator (codex code R2#1)", async () => {
		// readLocator must NOT be reached for a token the guard rejects (else the
		// fs locator could throw ENAMETOOLONG → 500).
		deps.readLocator = () => {
			throw new Error("readLocator should not be called for an overlong token");
		};
		const overlong = "a".repeat(300);
		const g = await handleGetReview(deps, overlong, { ...LOOPBACK });
		expect(g.status).toBe(404);
		const tok = createInMemoryTokenStore({
			now: () => 1000,
			ttlMs: 10_000,
		}).mint(overlong);
		const p = await handlePostAction(
			deps,
			overlong,
			{ noteId: "n1", action: "keep", sessionToken: tok },
			{ ...SAME_ORIGIN },
		);
		expect(p.status).toBe(404);
	});

	it("comments accumulate (append) + exact retry dedups (codex code R1#4)", async () => {
		const tok = token();
		const comment = (text: string) =>
			handlePostAction(
				deps,
				REPORT,
				{ noteId: "n1", action: "keep", sessionToken: tok, comment: text },
				{ ...SAME_ORIGIN },
			);
		await comment("first");
		await comment("second"); // distinct clarification → both kept
		expect(feedbackFile?.comments.map((c) => c.text)).toEqual([
			"first",
			"second",
		]);
		await comment("second"); // exact retry → no duplicate
		expect(feedbackFile?.comments.map((c) => c.text)).toEqual([
			"first",
			"second",
		]);
	});
});
