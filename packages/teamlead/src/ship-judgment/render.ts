import { OVERALL_LABELS, POINT_LABELS } from "./contract.js";
import type { DeliveryView } from "./delivery.js";

function text(value: string, limit: number): string {
	let result = "";
	for (const point of value) {
		const code = point.codePointAt(0)!;
		const escaped = (code < 32 || code === 127 ? " " : point)
			.replace(/@/g, "@\u200b")
			.replace(/</g, "＜")
			.replace(/>/g, "＞")
			.replace(/[\\`*_{}[\]()~|]/g, "\\$&");
		if (result.length + escaped.length > limit - 1) return `${result}…`;
		result += escaped;
	}
	return result;
}
function citation(value: unknown, point: string): string {
	if (!value || typeof value !== "object") return "";
	const part = (value as Record<string, unknown>)[point];
	if (!part || typeof part !== "object") return "";
	const evidence = (part as { evidence?: unknown }).evidence;
	if (!Array.isArray(evidence)) return "";
	const quote = evidence.find(
		(item) => item && typeof item.quote === "string",
	)?.quote;
	return quote ? `\n   依据：${text(quote, 100)}` : "";
}

/** Plain bounded Discord text, not an approval card; citations remain untrusted display data. */
export function renderJudgmentMessage(
	view: DeliveryView,
	legacySummary = "暂不可得",
): string {
	const overlaps = view.mechanical.overlaps
		.slice(0, 3)
		.map(
			(item) =>
				`${text(item.repo_identity, 40)} #${item.pr_number} ${text(item.path, 60)}`,
		)
		.join("；");
	const content = [
		`**机器试判：${OVERALL_LABELS[view.overall]}** · dry_run`,
		`① PRD / 设计对齐：${POINT_LABELS[view.alignment]}${citation(view.evaluation, "alignment")}`,
		`② 合并与在飞文件：${POINT_LABELS[view.conflict]}${overlaps ? `\n   同改：${overlaps}` : ""}`,
		`③ QA 用例覆盖：${POINT_LABELS[view.coverage]}${citation(view.evaluation, "coverage")}`,
		`检查范围：${text(view.mechanical.scope, 100)}；${view.mechanical.checkedRepos} 仓，在飞 PR ${view.mechanical.openPrCount ?? "未取全"}。`,
		`截至 ${view.mechanical.checkedAt} 的试判；后续检查可能待更新，仍由你批准。`,
		`旧窄口三闸/样本统计（非本次语义得分）：${text(legacySummary, 120)}`,
		`\`${text(view.marker, 220)} opinion:${text(view.opinionId, 200)}\``,
	].join("\n");
	if (content.length > 2000)
		throw new Error("judgment_message_budget_exceeded");
	return content;
}
