import { OVERALL_LABELS, POINT_LABELS } from "./contract.js";
import type { DeliveryView } from "./delivery.js";
import { evidenceSummary, semanticLabel } from "./evidence-labels.js";

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
	if (view.evidence) return renderEvidenceMessage(view, legacySummary);
	const overlaps = view.mechanical.overlaps
		.slice(0, 3)
		.map(
			(item) =>
				`${text(item.repo_identity, 40)} #${item.pr_number} ${text(item.path, 60)}`,
		)
		.join("；");
	const inputUnavailable =
		view.mechanical.reason.startsWith("input_unavailable:") ||
		[
			"project_sources_unavailable",
			"repository_not_configured",
			"repository_configuration_changed",
		].includes(view.mechanical.reason);
	const content = [
		`**机器试判：${OVERALL_LABELS[view.overall]}** · dry_run`,
		`① PRD / 设计对齐：${POINT_LABELS[view.alignment]}${citation(view.evaluation, "alignment")}`,
		`② 合并与在飞文件：${POINT_LABELS[view.conflict]}${overlaps ? `\n   同改：${overlaps}` : ""}`,
		`③ QA 用例覆盖：${POINT_LABELS[view.coverage]}${citation(view.evaluation, "coverage")}`,
		inputUnavailable
			? `输入不可得：${text(view.mechanical.reason.replace(/^input_unavailable:/, ""), 100)}；三项按已得证据判`
			: `检查范围：${text(view.mechanical.scope, 100)}；${view.mechanical.checkedRepos} 仓，在飞 PR ${view.mechanical.openPrCount ?? "未取全"}。`,
		`截至 ${view.mechanical.checkedAt} 的试判；后续检查可能待更新，仍由你批准。`,
		`旧窄口三闸/样本统计（非本次语义得分）：${text(legacySummary, 120)}`,
		`\`${text(view.marker, 220)} opinion:${text(view.opinionId, 200)}\``,
	].join("\n");
	if (content.length > 2000)
		throw new Error("judgment_message_budget_exceeded");
	return content;
}

function renderEvidenceMessage(
	view: DeliveryView,
	legacySummary: string,
): string {
	const ledger = view.evidence!,
		summary = evidenceSummary(ledger);
	const failed = [ledger.alignment, ledger.conflict, ledger.coverage]
		.flatMap((p, i) => (p.verdict === "fail" ? [["①", "②", "③"][i]] : []))
		.join(" / ");
	const title = failed
		? `不可自动批：${failed}`
		: view.overall === "can"
			? "可自动批（若开自动批）"
			: view.overall === "undetermined"
				? `缺证据：${summary.missing.join("；") || "判定输入"}`
				: `不可自动批：${failed}`;
	const lines = [
		`**机器试判：${title}** · dry_run`,
		`① PRD / 设计对齐：${summary.alignment}`,
		`② 合并与在飞文件：${summary.conflict}`,
		`③ QA 用例覆盖：${summary.coverage}`,
		`缺证据：${summary.missing.join("；") || "无"}`,
		`语义复核：${semanticLabel(ledger.semantic)}`,
		ledger.input.status === "unavailable"
			? `输入不可得：${text(ledger.input.reason, 80)}；三项按已得证据判`
			: `检查范围：${text(view.mechanical.scope, 80)}；${view.mechanical.checkedRepos} 仓，在飞 PR ${view.mechanical.openPrCount ?? "未取全"}。`,
		`截至 ${text(view.mechanical.checkedAt, 40)} 的试判；后续检查可能待更新，仍由你批准。`,
		`旧窄口三闸/样本统计（非本次语义得分）：${text(legacySummary, 100)}`,
		`\`${text(view.marker, 160)} opinion:${text(view.opinionId, 100)}\``,
	];
	let omitted = 0;
	const append = (line: number, value: string) => {
		const addition = ` · ${value}`;
		// Reserve space for the omission count before adding optional detail.
		if (lines.join("\n").length + addition.length <= 1860)
			lines[line] += addition;
		else omitted++;
	};
	const refs = (point: "alignment" | "coverage") => [
		...new Set([
			...ledger[point].refs,
			...ledger.targets.flatMap(
				(t) => (point === "alignment" ? t.a : t.c).refs,
			),
		]),
	];
	const evidenceText = (index: number) => {
		const ref = ledger.evidence[index]!;
		const label =
			ref.label === "blob_unverified"
				? "设计评审 APPROVED（blob 未核）"
				: ref.label;
		return `${text(label, 70)} ${text(ref.id, 70)}`;
	};
	for (const index of refs("alignment")) append(1, evidenceText(index));
	for (const index of refs("coverage")) append(3, evidenceText(index));
	for (const index of ledger.conflict.refs) append(2, evidenceText(index));
	for (const overlap of view.mechanical.overlaps)
		append(
			2,
			`同改：${text(overlap.repo_identity, 30)} #${overlap.pr_number} ${text(overlap.path, 70)}`,
		);
	for (const point of ["alignment", "coverage"]) {
		const quote = citation(view.evaluation, point).trim();
		if (quote) append(5, quote);
	}
	if (omitted) lines.push(`（+${omitted} 条省略）`);
	const content = lines.join("\n");
	if (content.length > 1900)
		throw new Error("judgment_message_budget_exceeded");
	return content;
}
