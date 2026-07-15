import { formatUsd } from "../pricing.js";
import type { ReportModel } from "./build-report.js";

function fmtTok(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
	if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
	return String(Math.round(n));
}
function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Plain-text daily report for terminal stdout. */
export function renderReportText(m: ReportModel): string {
	const L: string[] = [];
	L.push(`每日 Token 用量报告 — ${m.reportDay} (${m.timezone})`);
	L.push("范围 = 仅 Claude Code 用量（Codex 暂未并入，见 FLY-714）");
	if (m.warning) L.push(`⚠ ${m.warning}`);
	L.push(
		`总用量 ${fmtTok(m.total.tokens)} tokens · ${formatUsd(m.total.cost)} 成本估算  ` +
			`[in ${fmtTok(m.total.input)} / out ${fmtTok(m.total.output)} / cacheR ${fmtTok(m.total.cacheRead)} / cacheW ${fmtTok(m.total.cacheWrite)}]`,
	);
	if (m.comparison) {
		const b = m.comparison.before;
		const a = m.comparison.after;
		const pct = b.avgTokens
			? ((a.avgTokens - b.avgTokens) / b.avgTokens) * 100
			: 0;
		L.push(
			`改动前后: ${b.label} ${fmtTok(b.avgTokens)}/天 → ${a.label} ${fmtTok(a.avgTokens)}/天 (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`,
		);
	}
	L.push("");
	L.push("按项目 (项目总量 = runner+主仓 + 其 Leads):");
	for (const p of m.projects) {
		L.push(
			`  ${pad(p.name, 18)} ${pad(fmtTok(p.tokens), 8)} ${formatUsd(p.cost)}`,
		);
		for (const l of p.leads)
			L.push(
				`      lead  ${pad(l.name, 24)} ${pad(fmtTok(l.tokens), 8)} ${formatUsd(l.cost)}`,
			);
		for (const i of p.issues)
			L.push(
				`      done  ${pad(i.id, 24)} ${pad(fmtTok(i.tokens), 8)} ${formatUsd(i.cost)}`,
			);
		if (p.inprogCount)
			L.push(
				`      (+${p.inprogCount} 进行中 ${fmtTok(p.inprogTokens)}, 完成后计入)`,
			);
	}
	L.push("");
	L.push("按模型:");
	for (const mm of m.models)
		L.push(
			`  ${pad(mm.name, 28)} ${pad(fmtTok(mm.tokens), 8)} ${formatUsd(mm.cost)}`,
		);
	L.push("");
	L.push("Leads 排名 (全 fleet):");
	for (const l of m.leadsAll)
		L.push(
			`  ${pad(l.name, 28)} ${pad(fmtTok(l.tokens), 8)} ${formatUsd(l.cost)}`,
		);
	L.push("");
	L.push(
		"USD = 按各模型公开 API 单价 × token 用量估算的成本（订阅制下为参考成本，非实际账单）",
	);
	return L.join("\n");
}
