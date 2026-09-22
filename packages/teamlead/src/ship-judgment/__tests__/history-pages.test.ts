import { expect, it } from "vitest";
import {
	type HistoryRow,
	historyContentDigest,
	renderHistoryDocument,
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
	total: 40,
};
it("renders every bounded escaped row in one local-only document", () => {
	const rows = Array.from({ length: 40 }, (_, n) => ({
		...row,
		questionId: `q-${n}`,
		auditId: `audit-${n}`,
		issue: `FLY-${n} ${"<img src=x onerror=alert(1)> & 文".repeat(30)}`,
		summary: '<script>alert("x")</script>&中文'.repeat(1000),
	}));
	const html = renderHistoryDocument(rows, options);
	expect(Buffer.byteLength(html)).toBeLessThanOrEqual(32 * 1024 * 1024);
	expect(html).toContain("Content-Security-Policy");
	expect(html).toContain("共 40 张卡");
	expect(html).toContain("机器试判历史（按需生成）");
	expect(html).toContain("本文件仅在 Lead 明确请求时生成，不会自动上传");
	expect(html).not.toContain("下一页");
	expect(html).not.toMatch(/<script|<[^>]+onerror=|<img|fetch\(/);
	expect(html).toContain("data-discord-app");
	expect(html).toContain(
		'href="https://discord.com/channels/@me/123456789012345679/123456789012345680"',
	);
	expect(html).toContain(
		'data-discord-fallback href="https://discord.com/channels/@me/123456789012345679/123456789012345680"',
	);
	expect(html).toContain('aria-label="FLY-0 Discord 网页版"');
	const rendered = html.match(/<tr data-audit=[\s\S]*?<\/tr>/g)!;
	expect(rendered).toHaveLength(40);
	for (const line of rendered)
		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
	expect(html).toContain("&lt;");
	expect(html).toContain("audit-39");
});
it("rejects an invalid timestamp, total mismatch and untrusted row link", () => {
	expect(() =>
		renderHistoryDocument([row], { asOf: "not-utc", total: 1 }),
	).toThrow();
	expect(() =>
		renderHistoryDocument([row], { asOf: options.asOf, total: 2 }),
	).toThrow();
	expect(() =>
		renderHistoryDocument([{ ...row, cardUrl: "javascript:alert(1)" }], {
			asOf: options.asOf,
			total: 1,
		}),
	).toThrow();
});
it("uses content-only stable digest and labels empty, unknown and historical sources honestly", () => {
	expect(historyContentDigest([row])).toBe(historyContentDigest([{ ...row }]));
	expect(historyContentDigest([row])).not.toBe(
		historyContentDigest([{ ...row, clarification: "pending" }]),
	);
	const html = renderHistoryDocument([], {
		asOf: options.asOf,
		total: 0,
	});
	expect(html).toContain("暂无历史记录");
	const unknown = renderHistoryDocument(
		[
			{
				...row,
				source: "legacy_retro",
				overall: null,
				decision: null,
				authorship: "unknown",
			},
		],
		{ ...options, total: 1 },
	);
	expect(unknown).toContain("历史补录");
	expect(unknown).toContain("暂无意见");
	expect(unknown).toContain("待决定");
});

it("keeps the largest enumerated row states and identifiers inside the hardened byte budgets", () => {
	const rows = Array.from({ length: 20 }, (_, n) => ({
		...row,
		questionId: `q${n}`,
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
	const html = renderHistoryDocument(rows, { ...options, total: 20 });
	const lines = html.match(/<tr data-audit=[\s\S]*?<\/tr>/g)!;
	expect(lines).toHaveLength(20);
	for (const line of lines)
		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
	expect(Buffer.byteLength(html)).toBeLessThanOrEqual(32 * 1024 * 1024);
	expect(html).toContain("历史补录：取消（作者未核验）");
});
