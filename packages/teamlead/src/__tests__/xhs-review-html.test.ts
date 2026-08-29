/**
 * FLY-286 PR-2: review HTML builder tests (escaping, URL allowlist, controls).
 */

import type { XiaohongshuAnalysisRun } from "flywheel-comm/xiaohongshu-analysis-store";
import { describe, expect, it } from "vitest";
import {
	buildReviewHtml,
	escapeHtml,
	safeNoteUrl,
} from "../bridge/xhs-review-html.js";

describe("escapeHtml", () => {
	it("escapes the dangerous chars", () => {
		expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
	});
});

describe("safeNoteUrl", () => {
	it("accepts https allowlisted hosts incl. subdomains", () => {
		expect(safeNoteUrl("https://www.xiaohongshu.com/explore/abc")).toBe(
			"https://www.xiaohongshu.com/explore/abc",
		);
		expect(safeNoteUrl("https://xhslink.com/x")).toBe("https://xhslink.com/x");
	});
	it("rejects javascript:, non-https, foreign host, malformed", () => {
		expect(safeNoteUrl("javascript:alert(1)")).toBeNull();
		expect(safeNoteUrl("http://www.xiaohongshu.com/x")).toBeNull(); // not https
		expect(safeNoteUrl("https://evil.com/x")).toBeNull();
		expect(safeNoteUrl("https://notxiaohongshu.com/x")).toBeNull(); // suffix trick
		expect(safeNoteUrl("not a url")).toBeNull();
	});
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
		sourceWindow: { fetched: 2, total: 2, capped: false },
		posts: [
			{
				noteId: "n1",
				title: "<script>alert(1)</script>",
				url: "https://www.xiaohongshu.com/explore/n1",
				mediaKinds: ["text"],
				summary: "useful & <b>bold</b>",
				judgment: { useful: true, reason: "r" },
				createdIssue: { issueId: "FLY-900", opId: "op1", state: "triage" },
				status: "created",
			},
			{
				noteId: "n2",
				title: "candidate one",
				url: "javascript:alert(2)",
				mediaKinds: ["video"],
				summary: "maybe",
				judgment: { useful: true, reason: "r" },
				candidateIssue: { title: "t", body: "b" },
				status: "candidate",
			},
		],
		summary: { analyzed: 2, created: 1, candidates: 1, skipped: 0 },
		review: { reportToken: "rep1" },
	};
}

describe("buildReviewHtml", () => {
	const html = buildReviewHtml({
		run: mockRun(),
		nonce: "NONCE123",
		sessionToken: "SESS456",
		reportToken: "rep-tok",
	});

	it("escapes XSS in title/summary (no raw <script>)", () => {
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	it("renders a safe note URL as a link, an unsafe one as inert text", () => {
		expect(html).toContain('href="https://www.xiaohongshu.com/explore/n1"');
		// the javascript: url must NOT become an href
		expect(html).not.toContain('href="javascript:');
		expect(html).toContain("javascript:alert(2)".replace(/&/g, "&amp;")); // inert, escaped text
	});

	it("renders structured controls per post status", () => {
		// created → keep / close_created / edit
		expect(html).toContain('name="action" value="close_created"');
		expect(html).toContain('name="action" value="keep"');
		// candidate → promote_candidate / skip / edit
		expect(html).toContain('name="action" value="promote_candidate"');
	});

	it("embeds the session token (not any apiToken) + plain form POST", () => {
		expect(html).toContain('name="sessionToken" value="SESS456"');
		expect(html).not.toMatch(/TEAMLEAD_API_TOKEN|Bearer/i);
	});

	it("posts to an ABSOLUTE action path that resolves to the mounted route (codex R1#1)", () => {
		expect(html).toContain('action="/xhs-review/rep-tok/action"');
		// the relative-form bug would have resolved to /xhs-review/action
		expect(html).not.toContain('action="action"');
		// prove it resolves against the served page URL to the mounted POST route
		const pageUrl = "http://127.0.0.1:9876/xhs-review/rep-tok";
		const resolved = new URL("/xhs-review/rep-tok/action", pageUrl);
		expect(resolved.pathname).toBe("/xhs-review/rep-tok/action");
	});
});
