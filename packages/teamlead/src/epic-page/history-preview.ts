import { escapeHtml } from "../bridge/xhs-review-html.js";
import { OVERALL_LABELS } from "../ship-judgment/contract.js";
import type { EpicHistory } from "../ship-judgment/epic-history.js";
import type { Cell } from "./model.js";

const sources = {
	machine: "机器试判",
	lead_manual: "Lead 人工判断",
	legacy_retro: "历史补录",
	auto_narrow_gate: "窄口自动批",
};
const decisions = { approved: "批准", rework: "打回", canceled: "取消" };
function bounded(text: string, max: number): string {
	let result = "";
	for (const point of text) {
		const escaped = escapeHtml(point.codePointAt(0)! < 32 ? " " : point);
		if (Buffer.byteLength(result) + Buffer.byteLength(escaped) > max - 3)
			return result + "…";
		result += escaped;
	}
	return result;
}
/** Shared static HTML is valid in the Markdown artifact too; no script or remote read. */
export function renderHistoryPreview(
	cell: Cell<EpicHistory> | undefined,
	rowLimit = 20,
): string {
	if (!cell) return "";
	const history = cell.value;
	if (!history)
		return "<section data-judgment-history><h2>机器意见历史</h2><p>预览读取失败</p></section>";
	const rows = history.readError
		? []
		: history.rows.slice(0, Math.max(0, Math.min(20, Math.floor(rowLimit))));
	const url =
		history.url && Buffer.byteLength(escapeHtml(history.url)) <= 512
			? history.url
			: null;
	const entry = url
		? `<a href="${escapeHtml(url)}" rel="noreferrer">查看近 30 天历史</a>`
		: "历史入口尚不可用";
	const status = history.readError
		? "预览读取失败"
		: `最近 ${rows.length} / ${history.total} 条`;
	const failure = history.error
		? url
			? " · 更新失败，保留上次发布"
			: " · 更新失败"
		: history.dirty
			? " · 等待更新"
			: "";
	const content = rows
		.map((row) => {
			const decision = row.decision
				? `${sources[row.decisionSource]}：${decisions[row.decision]}`
				: "待决定";
			const author =
				row.decision &&
				row.authorship !== "founder_verified" &&
				row.authorship !== "auto"
					? "（作者未核验）"
					: "";
			const clarification = {
				none: "",
				pending: " · 分歧待澄清",
				explained: " · 历史决定已解释",
				unavailable: " · 分歧待澄清（发送不可用）",
			}[row.clarification];
			return `<li data-history-row>${bounded(row.issue, 96)} · ${sources[row.source]}：${row.overall ? OVERALL_LABELS[row.overall] : "暂无意见"} · ${decision}${author}${clarification} · ${bounded(row.summary, 160)}${row.cardUrl ? ` <a href="${escapeHtml(row.cardUrl)}" rel="noreferrer">原卡</a>` : ""}</li>`;
		})
		.join("");
	const html = `<section data-judgment-history><h2>机器意见历史</h2><p>${status}${failure} · ${entry}</p>${history.publishedAsOf ? `<p>历史发布快照：${escapeHtml(history.publishedAsOf)}</p>` : ""}${rows.length ? `<ol>${content}</ol>` : ""}</section>`;
	if (
		Buffer.byteLength(html) > 16384 ||
		(rows.length === 0 && Buffer.byteLength(html) > 1024)
	)
		throw new Error("epic_history_preview_budget_exceeded");
	return html;
}
