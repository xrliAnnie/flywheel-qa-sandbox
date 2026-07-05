// FLY-616 — eval scorecard renderer (Apple-light HTML).
//
// 泛化自 scripts/qa-fly-599/scorecard.mjs：variant→condition、漏发率→多客观质量指标 +
// cost context + 回炉率 advisory。**摊数字 + 软判定建议、Annie 定线、不自动卡**(count-first)。
// 输入 = EvalScorecardInput {meta, conditions[], comparison}。导出 renderScorecard(input)->html。

const esc = (s) =>
	String(s ?? "").replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	);

const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);
const num = (v) => (v == null ? "—" : String(v));

const OVERALL = {
	looks_hold: { label: "看起来持平 ✅", cls: "green" },
	looks_dropped: { label: "看起来掉了 ⚠️", cls: "red" },
	unclear: { label: "说不准 ❓", cls: "amber" },
};

const SOFT = {
	looks_hold: { txt: "持平", cls: "green" },
	looks_dropped: { txt: "掉了", cls: "red" },
	unclear: { txt: "说不准", cls: "amber" },
};

const METRIC_LABEL = {
	hardSuccess: "可评估 PR 产出",
	qa: "QA 过",
	ci: "CI 绿",
};

function verdictBanner(comparison) {
	if (!comparison) return "";
	const o = OVERALL[comparison.overall] ?? OVERALL.unclear;
	const reasons =
		comparison.inconclusive && comparison.reasons?.length
			? `<div class="reasons">数据不足 / 待核：${comparison.reasons.map(esc).join("、")}</div>`
			: "";
	return `<div class="verdict ${o.cls}">
    <div class="vhead">软判定建议：<b>${esc(o.label)}</b>　<span class="vdim">（${esc(comparison.baselineLabel)} → ${esc(comparison.candidateLabel)}；最终线 Annie 定，本判定不阻断）</span></div>
    ${reasons}
  </div>`;
}

function metricTable(comparison) {
	if (!comparison) return "";
	const rows = comparison.metrics
		.map((m) => {
			const s = SOFT[m.softLabel] ?? SOFT.unclear;
			const ciAdv = m.ciOverlap
				? "区间重叠（差异不确定）"
				: "区间不重叠（强 advisory）";
			return `<tr>
      <td>${esc(METRIC_LABEL[m.metric] ?? m.metric)}</td>
      <td>${m.baselineCount} (${pct(m.baselineRate)})</td>
      <td>${m.candidateCount} (${pct(m.candidateRate)})</td>
      <td class="${m.countDelta < 0 ? "neg" : m.countDelta > 0 ? "pos" : ""}">${m.countDelta >= 0 ? "+" : ""}${m.countDelta}</td>
      <td><span class="chip ${s.cls}">${s.txt}</span></td>
      <td class="dim">${esc(ciAdv)}</td>
    </tr>`;
		})
		.join("");
	return `<div class="section-title">质量信号对比（比成功个数；Wilson CI 仅 advisory，不当门）</div>
  <table><tr><th>指标</th><th>${esc(comparison.baselineLabel)}</th><th>${esc(comparison.candidateLabel)}</th><th>Δ个数</th><th>软标签</th><th>Wilson CI</th></tr>${rows}</table>`;
}

function coverageWarn(conditions) {
	const warns = [];
	for (const c of conditions) {
		const cov = c.aggregate.coverage;
		for (const k of ["hardSuccess", "qa", "ci"]) {
			if (cov[k] < 1)
				warns.push(
					`${esc(c.label)} 的「${esc(METRIC_LABEL[k] ?? k)}」coverage ${pct(cov[k])}（缺信号，不当通过）`,
				);
		}
	}
	return warns.length
		? `<div class="card amber"><b>⚠️ 信号覆盖不全</b><ul>${warns.map((w) => `<li>${w}</li>`).join("")}</ul></div>`
		: "";
}

function costCard(conditions) {
	const rows = conditions
		.map((c) => {
			const cs = c.aggregate.costSummary;
			return `<tr><td>${esc(c.label)}</td><td>${num(cs?.medianTotalTokens)}</td><td>${num(cs?.medianLinesChanged)}</td></tr>`;
		})
		.join("");
	return `<div class="card blue"><div class="section-title">成本 context（token 读 FLY-614；<b>非质量判据</b>）</div>
    <table><tr><th>condition</th><th>中位 token</th><th>中位改动行数</th></tr>${rows}</table>
    <div class="dim">token 来自 FLY-614；未接入显示「—」。成本只摊给你看「省了多少」，不进质量判定。</div></div>`;
}

function recycleCard(conditions, comparison) {
	const rows = conditions
		.map((c) => {
			const r = c.aggregate.recycle;
			const shown =
				r.observed === 0
					? "待采集 / N/A"
					: `${r.recycled}/${r.observed}（${pct(r.rate)}）`;
			return `<tr><td>${esc(c.label)}</td><td>${shown}</td></tr>`;
		})
		.join("");
	const note = comparison?.recycleAdvisory?.note
		? `<div class="dim">${esc(comparison.recycleAdvisory.note)}</div>`
		: "";
	return `<div class="card amber"><div class="section-title">回炉率 — 过 QA 后又被 reopen/返工（<b>滞后软信号·非质量判据</b>）</div>
    <table><tr><th>condition</th><th>回炉</th></tr>${rows}</table>
    <div class="dim">滞后信号：过段时间才看得出，对真实生产 issue 最有意义；v1 sandbox 集通常「待采集/N/A」。<b>不进质量判定</b>。</div>${note}</div>`;
}

function reworkCard(comparison) {
	if (!comparison) return "";
	const r = comparison.reworkAdvisory;
	const note = r.note ? `<div class="dim">${esc(r.note)}</div>` : "";
	return `<div class="card"><div class="section-title">返工轮数（advisory，不进总判定）</div>
    <div>${esc(comparison.baselineLabel)} 均 ${num(r.baselineAvg)} · ${esc(comparison.candidateLabel)} 均 ${num(r.candidateAvg)}</div>${note}</div>`;
}

function taskDetail(conditions) {
	return conditions
		.map((c) => {
			const rows = c.tasks
				.map(
					(t) =>
						`<tr><td>${esc(t.issueId)}</td><td>${esc(t.completionRoute)}</td><td>${esc(t.prOutcome)}</td><td>${esc(t.qaVerdict)}</td><td>${esc(t.ciHealth)}</td><td>${t.reworkRounds == null ? "—" : t.reworkRounds}</td><td>${t.partial ? "⚠️部分" : "✓"}</td></tr>`,
				)
				.join("");
			return `<div class="card"><div class="section-title">明细：${esc(c.label)}（n=${c.aggregate.n}）</div>
      <table><tr><th>issue</th><th>完成</th><th>PR</th><th>QA</th><th>CI</th><th>返工</th><th>完整</th></tr>${rows}</table></div>`;
		})
		.join("");
}

export function renderScorecard(input) {
	const meta = input.meta ?? {};
	const conditions = input.conditions ?? [];
	const comparison = input.comparison ?? null;
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FLY-616 eval scorecard · ${esc(meta.issue ?? "")}</title>
<style>
  :root{--bg:#f5f5f7;--ink:#1d1d1f;--dim:#86868b;--card:#fff;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,system-ui,sans-serif;line-height:1.55}
  .wrap{max-width:960px;margin:0 auto;padding:28px 18px 70px}
  h1{font-size:24px;font-weight:700;margin:0 0 4px}
  .sub{color:var(--dim);font-size:14px;margin:0 0 18px}
  .verdict{border-radius:12px;padding:16px 18px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--dim)}
  .verdict.green{border-left-color:var(--green);background:#eefaf0}
  .verdict.red{border-left-color:var(--red);background:#fff0ef}
  .verdict.amber{border-left-color:var(--amber);background:#fff8ed}
  .vhead{font-size:17px}.vdim{color:var(--dim);font-size:13px}.reasons{color:var(--dim);font-size:13px;margin-top:6px}
  .card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:14px 18px;margin:12px 0;border-left:4px solid var(--dim)}
  .card.amber{border-left-color:var(--amber)}.card.blue{border-left-color:var(--blue)}
  .section-title{font-size:15px;font-weight:650;margin:0 0 8px}
  table{width:100%;border-collapse:collapse;margin:6px 0;font-size:13px;background:#fff;border-radius:8px;overflow:hidden}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #ececed}th{background:#fafafc;color:#1a365d;font-weight:650}
  tr:last-child td{border-bottom:none}
  .chip{font-size:12px;font-weight:700;padding:2px 8px;border-radius:20px;color:#fff}
  .chip.green{background:var(--green)}.chip.red{background:var(--red)}.chip.amber{background:var(--amber)}
  .pos{color:var(--green);font-weight:650}.neg{color:var(--red);font-weight:650}.dim{color:var(--dim);font-size:12px;margin-top:6px}
  ul{margin:6px 0;padding-left:20px}
</style></head><body><div class="wrap">
<h1>FLY-616 · eval scorecard</h1>
<p class="sub">${esc(meta.issue ?? "")}${meta.date ? ` · ${esc(meta.date)}` : ""}${meta.note ? ` · ${esc(meta.note)}` : ""}　任务集 n=${(meta.taskSet ?? []).length}</p>
${verdictBanner(comparison)}
${metricTable(comparison)}
${coverageWarn(conditions)}
${costCard(conditions)}
${recycleCard(conditions, comparison)}
${reworkCard(comparison)}
${taskDetail(conditions)}
<div class="card"><div class="section-title">主观质量（优雅 / 可维护 / 真解决）</div><div class="dim">下一阶段：LLM-judge 先跟人工校准 ≥80% + 人工抽查。v1 不做。</div></div>
</div></body></html>`;
}
