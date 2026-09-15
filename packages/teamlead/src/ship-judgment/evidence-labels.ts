import { z } from "zod";
import type { EvidenceLedger, EvidencePoint } from "./evidence-ledger.js";

export const MISSING_EVIDENCE_LABELS = {
	design_review: "设计评审",
	code_review_at_head: "当前 head 代码评审",
	pr_diff: "PR diff",
	plan_at_head: "当前 head 设计文档",
	qa_claim: "QA 判决",
	mechanical_snapshot: "机械快照",
	merge_probe: "合并预检",
	input: "输入",
} as const;
export function evidencePointLabel(point: EvidencePoint): string {
	if (point.verdict === "pass") return "通过";
	if (point.verdict === "fail") return "不通过";
	return `缺 ${point.missing.map((kind) => MISSING_EVIDENCE_LABELS[kind]).join("、") || "判定证据"}`;
}
export function semanticLabel(semantic: EvidenceLedger["semantic"]): string {
	if (semantic.status === "not_run") return "未跑";
	if (semantic.status === "undetermined") return "已跑，未形成否决";
	return semantic.alignmentVeto || semantic.coverageVeto ? "不通过" : "通过";
}
export const evidenceSummarySchema = z
	.object({
		alignment: z.string().max(160),
		conflict: z.string().max(160),
		coverage: z.string().max(160),
		missing: z.array(z.string().max(160)).max(3),
	})
	.strict();
export function evidenceSummary(ledger: EvidenceLedger) {
	const missing = [ledger.alignment, ledger.conflict, ledger.coverage].flatMap(
		(point, i) =>
			point.missing.length
				? [
						`${["①", "②", "③"][i]} ${point.missing.map((kind) => MISSING_EVIDENCE_LABELS[kind]).join("、")}`,
					]
				: [],
	);
	return evidenceSummarySchema.parse({
		alignment: evidencePointLabel(ledger.alignment),
		conflict: evidencePointLabel(ledger.conflict),
		coverage: evidencePointLabel(ledger.coverage),
		missing,
	});
}
export function evidenceSummaryText(ledger: EvidenceLedger): string {
	const summary = evidenceSummary(ledger);
	return `① ${summary.alignment}；② ${summary.conflict}；③ ${summary.coverage}；缺证据：${summary.missing.join("；") || "无"}`;
}
