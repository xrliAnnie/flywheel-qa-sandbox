import { z } from "zod";
import { injectHeadMeta } from "../bridge/report-registry.js";
import { canonicalDigest, OVERALL_LABELS, overallSchema } from "./contract.js";
export const HISTORY_TEMPLATE_VERSION = "ship-judgment-history-v1";
export const HISTORY_PAGE_ROWS = 20;
const utc = z
	.string()
	.datetime()
	.refine((value) => new Date(value).toISOString() === value);
export const historyRowSchema = z
	.object({
		questionId: z.string().min(1).max(200),
		issue: z.string(),
		auditId: z
			.string()
			.regex(/^[a-zA-Z0-9:_.-]{1,240}$/)
			.nullable(),
		source: z.enum([
			"machine",
			"lead_manual",
			"legacy_retro",
			"auto_narrow_gate",
		]),
		overall: overallSchema.nullable(),
		decision: z.enum(["approved", "rework", "canceled"]).nullable(),
		decisionSource: z.enum([
			"machine",
			"lead_manual",
			"legacy_retro",
			"auto_narrow_gate",
		]),
		decisionAuditId: z.string().nullable(),
		clarificationAuditId: z.string().nullable(),
		authorship: z.enum(["founder_verified", "lead_proxy", "auto", "unknown"]),
		clarification: z.enum(["none", "pending", "explained", "unavailable"]),
		summary: z.string(),
		cardUrl: z
			.string()
			.regex(
				/^https:\/\/discord\.com\/channels\/(?:@me|\d{17,20})\/\d{17,20}\/\d{17,20}$/,
			)
			.nullable(),
		updatedAt: utc,
	})
	.strict();
export type HistoryRow = z.infer<typeof historyRowSchema>;
interface PageOptions {
	asOf: string;
	page: number;
	pageCount: number;
	total: number;
	reportOrigin: string;
	nextUrl?: string;
}
const escapeHistoryHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			]!,
	);
/** Truncate complete code points after escaping, so entities cannot be split. */
function bounded(value: string, maxBytes: number) {
	let result = "",
		bytes = 0;
	for (const point of value) {
		const escaped = escapeHistoryHtml(point.codePointAt(0)! < 32 ? " " : point);
		const size = Buffer.byteLength(escaped);
		if (bytes + size > maxBytes - 3) return result + "…";
		result += escaped;
		bytes += size;
	}
	return result;
}
const sources = {
	machine: "机器试判",
	lead_manual: "Lead 人工判断",
	legacy_retro: "历史补录",
	auto_narrow_gate: "窄口自动批",
} as const;
const decisions = {
	approved: "批准",
	rework: "打回",
	canceled: "取消",
} as const;
const clarifications = {
	none: "",
	pending: "分歧待澄清",
	explained: "历史决定已解释",
	unavailable: "分歧待澄清（发送不可用）",
} as const;
export function historyContentDigest(rows: HistoryRow[]): string {
	return canonicalDigest({
		template: HISTORY_TEMPLATE_VERSION,
		rows: rows.map((row) => historyRowSchema.parse(row)),
	});
}
function renderRow(row: HistoryRow) {
	const audit = row.auditId ?? "none";
	const decision = row.decision
		? (row.decisionSource === "machine"
				? ""
				: sources[row.decisionSource] + "：") + decisions[row.decision]
		: "待决定";
	const attribution =
		row.decision &&
		row.authorship !== "founder_verified" &&
		row.authorship !== "auto"
			? "（作者未核验）"
			: "";
	const html = `<tr data-audit="${escapeHistoryHtml(audit)}"><td>${bounded(row.issue, 180)}${row.cardUrl ? ` <a href="${escapeHistoryHtml(row.cardUrl)}" rel="noreferrer">原卡</a>` : "（原卡链接缺失）"}</td><td>${sources[row.source]}：${row.overall ? OVERALL_LABELS[row.overall] : "暂无意见"}</td><td>${decision}${attribution} ${clarifications[row.clarification]}</td><td>${bounded(row.summary, 560)}<br><small>审计 ${escapeHistoryHtml(audit)}</small></td></tr>`;
	if (Buffer.byteLength(html) > 2048)
		throw new Error("history_row_budget_exceeded");
	return html;
}
/** Fully static output. Callers may supply only a next page already verified as published. */
export function renderHistoryPage(
	input: HistoryRow[],
	options: PageOptions,
): string {
	const rows = input.map((row) => historyRowSchema.parse(row));
	utc.parse(options.asOf);
	const { page, pageCount, total } = options;
	if (
		!Number.isSafeInteger(total) ||
		total < 0 ||
		!Number.isSafeInteger(page) ||
		page < 1 ||
		!Number.isSafeInteger(pageCount) ||
		pageCount !== Math.max(1, Math.ceil(total / HISTORY_PAGE_ROWS)) ||
		page > pageCount ||
		rows.length !==
			Math.min(
				HISTORY_PAGE_ROWS,
				Math.max(0, total - (page - 1) * HISTORY_PAGE_ROWS),
			)
	)
		throw new Error("invalid_history_pagination");
	const origin = new URL(options.reportOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.origin !== options.reportOrigin
	)
		throw new Error("invalid_history_origin");
	let next = "";
	if (page < pageCount) {
		if (!options.nextUrl) throw new Error("history_next_page_required");
		const url = new URL(options.nextUrl);
		if (
			url.protocol !== "https:" ||
			url.origin !== origin.origin ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new Error("invalid_history_next_url");
		next = `<a rel="next" href="${escapeHistoryHtml(url.href)}">下一页</a>`;
	} else if (options.nextUrl) throw new Error("unexpected_history_next_page");
	const html = injectHeadMeta(
		`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>机器试判历史</title><style>body{font:16px system-ui,sans-serif;margin:24px;color:#222;line-height:1.6}main{max-width:1100px;margin:auto}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #ddd;overflow-wrap:anywhere}small,footer{color:#555}a{color:#174da0}</style></head><body><main><h1>机器试判历史</h1><p>截至 ${escapeHistoryHtml(options.asOf)} 的近 30 天记录 · 共 ${total} 张卡 · 第 ${page} / ${pageCount} 页</p><p>机器意见不改变批准。可见不代表已读，判断一致不代表质量准确。</p>${rows.length ? `<table><thead><tr><th>事项</th><th>来源与意见</th><th>决定与解释</th><th>依据摘要</th></tr></thead><tbody>${rows.map(renderRow).join("")}</tbody></table>` : "<p>暂无历史记录</p>"}<footer><p>${page > 1 ? "上一页请使用浏览器返回。 " : ""}${next}</p><p>完整记录可按审计 ID 查询；历史补录与人工记录不计入前瞻比较。</p></footer></main></body></html>`,
	);
	if (Buffer.byteLength(html) > 65536)
		throw new Error("history_page_budget_exceeded");
	return html;
}
