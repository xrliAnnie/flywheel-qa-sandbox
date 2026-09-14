import { expect, it } from "vitest";
import {
	type HistoryRow,
	historyContentDigest,
	renderHistoryPage,
} from "../history-pages.js";

const row: HistoryRow = {
	questionId: "q",
	issue: "FLY-2399",
	auditId: "audit-1",
	source: "machine",
	overall: "can",
	decision: "approved",
	decisionSource: "machine",
	decisionAuditId: null,
	clarificationAuditId: null,
	authorship: "founder_verified",
	clarification: "none",
	summary: "Aligned",
	cardUrl:
		"https://discord.com/channels/@me/123456789012345679/123456789012345680",
	updatedAt: "2026-09-11T00:00:00.000Z",
};
const options = {
	asOf: "2026-09-11T00:00:00.000Z",
	page: 1,
	pageCount: 2,
	total: 40,
	reportOrigin: "https://reports.example.com",
	nextUrl: "https://reports.example.com/r/token",
};
it("renders twenty bounded escaped rows, hardened CSP and only a validated next-page link", () => {
	const rows = Array.from({ length: 20 }, (_, n) => ({
		...row,
		questionId: `q-${n}`,
		auditId: `audit-${n}`,
		issue: "<img src=x onerror=alert(1)> & 文".repeat(30),
		summary: '<script>alert("x")</script>&中文'.repeat(1000),
	}));
	const html = renderHistoryPage(rows, options);
	expect(Buffer.byteLength(html)).toBeLessThanOrEqual(65536);
	expect(html).toContain("Content-Security-Policy");
	expect(html).toContain("第 1 / 2 页");
	expect(html).toContain("共 40 张卡");
	expect(html).toContain('href="https://reports.example.com/r/token"');
	expect(html).not.toMatch(/<script|<[^>]+onerror=|<img|fetch\(/);
	const rendered = html.match(/<tr data-audit=[\s\S]*?<\/tr>/g)!;
	expect(rendered).toHaveLength(20);
	for (const line of rendered)
		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
	expect(html).toContain("&lt;");
	expect(html).toContain("audit-19");
});
it("rejects excess rows, invalid pagination and untrusted navigation", () => {
	for (const patch of [
		{ nextUrl: "javascript:alert(1)" },
		{ nextUrl: "https://evil.example/r/token" },
		{ page: 0 },
		{ pageCount: 1 },
		{ total: 0 },
	]) {
		expect(() => renderHistoryPage([row], { ...options, ...patch })).toThrow();
	}
	expect(() =>
		renderHistoryPage(
			Array.from({ length: 21 }, () => row),
			options,
		),
	).toThrow();
	expect(() =>
		renderHistoryPage([{ ...row, cardUrl: "javascript:alert(1)" }], options),
	).toThrow();
});
it("uses content-only stable digest and labels empty, unknown and historical sources honestly", () => {
	expect(historyContentDigest([row])).toBe(historyContentDigest([{ ...row }]));
	expect(historyContentDigest([row])).not.toBe(
		historyContentDigest([{ ...row, clarification: "pending" }]),
	);
	const html = renderHistoryPage([], {
		asOf: options.asOf,
		page: 1,
		pageCount: 1,
		total: 0,
		reportOrigin: options.reportOrigin,
	});
	expect(html).toContain("暂无历史记录");
	const unknown = renderHistoryPage(
		[
			{
				...row,
				source: "legacy_retro",
				overall: null,
				decision: null,
				authorship: "unknown",
			},
		],
		{ ...options, pageCount: 1, total: 1, nextUrl: undefined },
	);
	expect(unknown).toContain("历史补录");
	expect(unknown).toContain("暂无意见");
	expect(unknown).toContain("待决定");
});

it("keeps the largest enumerated row states and identifiers inside the hardened byte budgets", () => {
	const rows = Array.from({ length: 20 }, (_, n) => ({
		...row,
		questionId: "q" + n,
		auditId: "a".repeat(238) + n,
		source: "lead_manual" as const,
		overall: "recommend_reject" as const,
		decision: "canceled" as const,
		decisionSource: "legacy_retro" as const,
		authorship: "unknown" as const,
		clarification: "unavailable" as const,
		issue: "&".repeat(2000),
		summary: "😀<&".repeat(2000),
	}));
	const html = renderHistoryPage(rows, {
		...options,
		pageCount: 1,
		total: 20,
		nextUrl: undefined,
	});
	const lines = html.match(/<tr data-audit=[\s\S]*?<\/tr>/g)!;
	expect(lines).toHaveLength(20);
	for (const line of lines)
		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
	expect(Buffer.byteLength(html)).toBeLessThanOrEqual(65536);
	expect(html).toContain("历史补录：取消（作者未核验）");
});
