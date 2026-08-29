/**
 * FLY-286 PR-3: deliverReviewArtifacts (pure) tests.
 */

import { describe, expect, it } from "vitest";
import type {
	XiaohongshuAnalysisRun,
	XiaohongshuMediaKind,
} from "../xiaohongshu-analysis-store.js";
import {
	deliverReviewArtifacts,
	validateBaseUrl,
} from "../xiaohongshu-review-delivery.js";
import type { ReviewLocator } from "../xiaohongshu-review-locator.js";

function run(): XiaohongshuAnalysisRun {
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
				title: "t",
				url: "https://www.xiaohongshu.com/explore/n1",
				mediaKinds: ["text"] as XiaohongshuMediaKind[],
				summary: "s",
				judgment: { useful: true, reason: "r" },
				status: "candidate",
			},
		],
		summary: { analyzed: 1, created: 0, candidates: 1, skipped: 0 },
		review: null,
	};
}

describe("validateBaseUrl", () => {
	it("trims trailing slash + accepts http(s)", () => {
		expect(validateBaseUrl("http://127.0.0.1:9876/")).toBe(
			"http://127.0.0.1:9876",
		);
		expect(validateBaseUrl("https://x.example")).toBe("https://x.example");
	});
	it("rejects empty / malformed / non-http(s)", () => {
		expect(() => validateBaseUrl("")).toThrow();
		expect(() => validateBaseUrl("not a url")).toThrow(/invalid base URL/);
		expect(() => validateBaseUrl("ftp://x")).toThrow(/http\(s\)/);
	});
});

describe("deliverReviewArtifacts", () => {
	it("mints token, writes locator FIRST then delivered run, returns url", () => {
		const writes: string[] = [];
		let locator: ReviewLocator | undefined;
		let deliveredReview: unknown;
		const out = deliverReviewArtifacts({
			writeLocator: (l) => {
				writes.push("locator");
				locator = l;
			},
			writeRun: (r) => {
				writes.push("run");
				deliveredReview = r.review;
			},
			run: run(),
			baseUrl: "http://127.0.0.1:9876",
			randomToken: () => "tok1",
			now: () => "2026-06-17T01:00:00Z",
		});
		expect(out.reportToken).toBe("tok1");
		expect(out.url).toBe("http://127.0.0.1:9876/xhs-review/tok1");
		expect(writes).toEqual(["locator", "run"]); // locator FIRST (R1#5)
		expect(locator?.runToken).toBe("run-1");
		expect(deliveredReview).toEqual({
			reportToken: "tok1",
			deliveredAt: "2026-06-17T01:00:00Z",
		});
	});

	it("a run-write failure throws AFTER the (harmless) locator write, no URL returned", () => {
		const writes: string[] = [];
		expect(() =>
			deliverReviewArtifacts({
				writeLocator: () => writes.push("locator"),
				writeRun: () => {
					throw new Error("disk full");
				},
				run: run(),
				baseUrl: "http://127.0.0.1:9876",
				randomToken: () => "tok1",
				now: () => "t",
			}),
		).toThrow(/disk full/);
		expect(writes).toEqual(["locator"]); // orphan locator is harmless (route 404s)
	});
});
