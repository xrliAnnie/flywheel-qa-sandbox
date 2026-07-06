/**
 * FLY-286 PR-2: web-local ReviewChannel adapter — integration over the REAL
 * local stores + locator (mock run via deliver(), no live pipeline).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLocalAnalysisStore,
	createLocalFeedbackStore,
	type XiaohongshuAnalysisRun,
} from "flywheel-comm/xiaohongshu-analysis-store";
import {
	readLocator,
	writeLocator,
} from "flywheel-comm/xiaohongshu-review-locator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebLocalReviewChannel } from "../bridge/xhs-review-channel.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "xhs-chan-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

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
				status: "candidate",
				candidateIssue: { title: "t", body: "b" },
			},
		],
		summary: { analyzed: 1, created: 0, candidates: 1, skipped: 0 },
		review: null,
	};
}

function makeChannel() {
	let n = 0;
	return createWebLocalReviewChannel({
		analysis: createLocalAnalysisStore(dir),
		feedback: createLocalFeedbackStore(dir),
		writeLocator: (loc) => writeLocator(dir, loc),
		readLocator: (t) => readLocator(dir, t),
		baseUrl: "http://127.0.0.1:9876/",
		randomToken: () => `tok${++n}`,
		now: () => "2026-06-17T01:00:00Z",
	});
}

describe("web-local ReviewChannel", () => {
	it("deliver persists run + locator and returns a localhost URL", () => {
		const ch = makeChannel();
		const { reportToken, url } = ch.deliver(mockRun());
		expect(reportToken).toBe("tok1");
		expect(url).toBe("http://127.0.0.1:9876/xhs-review/tok1");
		// the run is persisted + resolvable via the locator
		const back = createLocalAnalysisStore(dir).readRun(
			"flywheel",
			"c1",
			"run-1",
		);
		expect(back?.posts[0]?.noteId).toBe("n1");
		// persisted run is marked DELIVERED (codex code R1#3)
		expect(back?.review?.reportToken).toBe("tok1");
		expect(back?.review?.deliveredAt).toBe("2026-06-17T01:00:00Z");
		expect(readLocator(dir, "tok1")?.runToken).toBe("run-1");
	});

	it("collectFeedback resolves a reportToken back to the feedback file", () => {
		const ch = makeChannel();
		const { reportToken } = ch.deliver(mockRun());
		// no feedback yet
		expect(ch.collectFeedback(reportToken)).toBeNull();
		// write some feedback then collect
		createLocalFeedbackStore(dir).writeFeedback("flywheel", "c1", {
			schemaVersion: 1,
			runToken: "run-1",
			comments: [],
			actions: [{ noteId: "n1", action: "promote_candidate", at: "t" }],
			consumedActions: [],
		});
		expect(ch.collectFeedback(reportToken)?.actions[0]?.action).toBe(
			"promote_candidate",
		);
		// unknown reportToken → null
		expect(ch.collectFeedback("nope")).toBeNull();
	});
});
