import { CONCURRENCY_INSUFFICIENT_MSG, summarizeIssue } from "./metrics.mjs";

const LABELS = Object.freeze({
	infra_incident: { name: "基建事故", color: "#ff453a" },
	gate_waiting_human: { name: "人工 gate", color: "#ff9f0a" },
	rework_loop: { name: "返工", color: "#af52de" },
	qa_running: { name: "独立 QA", color: "#32ade6" },
	review_running: { name: "Cross-family review", color: "#5856d6" },
	ci_waiting: { name: "CI 等待", color: "#007aff" },
	working: { name: "设计 / 编码", color: "#34c759" },
	idle_gap: { name: "空转等待", color: "#8e8e93" },
	unmeasurable: { name: "无法测量", color: "#d1d1d6" },
});

const CATEGORY_NAMES = Object.freeze({
	value_work: "价值工作",
	necessary_process: "必要流程",
	mechanism_waste: "机制损耗",
	execution_waste: "执行返工",
	human_wait: "人工等待",
	unknown: "未知",
});

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function duration(ms) {
	if (!Number.isFinite(ms)) return "—";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function percent(value) {
	return `${(value * 100).toFixed(1)}%`;
}

function formatTime(ms) {
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "America/Los_Angeles",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(ms));
}

function verdictCopy(verdict, sampleCount) {
	const qualifying = verdict.qualifying_issues ?? [];
	const evidenceBase = `达到结论门槛的 ${qualifying.length} 个已关闭样本${qualifying.length > 0 ? `（${qualifying.join("、")}）` : ""}`;
	if (verdict.kind === "mechanism") return `${evidenceBase}中，慢主要在机制。`;
	if (verdict.kind === "execution") return `${evidenceBase}中，慢主要在执行。`;
	return `这 ${sampleCount} 个样本中，数据指向混合，或覆盖不足以裁决机制 vs 执行。`;
}

function aggregate(reports) {
	const totals = Object.fromEntries(
		Object.keys(CATEGORY_NAMES).map((key) => [key, 0]),
	);
	const issueMetrics = [];
	for (const report of reports) {
		if (report.kind !== "analyzed") continue;
		const metrics = summarizeIssue(report);
		issueMetrics.push(metrics);
		if (report.closed) {
			for (const [key, value] of Object.entries(metrics.totals))
				totals[key] += value;
		}
	}
	const classifiable = Object.entries(totals)
		.filter(([key]) => key !== "unknown")
		.reduce((sum, [, value]) => sum + value, 0);
	return { totals, classifiable, issueMetrics };
}

function aggregateBar(totals, denominator) {
	return Object.entries(totals)
		.filter(([category, value]) => category !== "unknown" && value > 0)
		.map(
			([category, value]) =>
				`<span class="agg-${category}" style="width:${((value / denominator) * 100).toFixed(4)}%" title="${escapeHtml(CATEGORY_NAMES[category])} ${percent(value / denominator)}"></span>`,
		)
		.join("");
}

function renderIssue(report) {
	if (report.kind === "no_verdict") {
		return `<article class="issue-card no-verdict"><div class="issue-head"><h3>${escapeHtml(report.issue)}</h3><span class="pill red">数据源不可用</span></div><p>${escapeHtml(report.failed_sources.map((item) => `${item.source}/${item.kind}`).join("、"))}</p></article>`;
	}
	const total = report.end_ms - report.t0;
	const metrics = summarizeIssue(report);
	const unknown = metrics.totals.unknown;
	const inFlight = report.segments
		.filter((item) => item.in_flight)
		.reduce((sum, item) => sum + item.end_ms - item.start_ms, 0);
	const reworkCount = report.segments.filter(
		(item) => item.label === "rework_loop",
	).length;
	const segments = report.segments
		.map((segment) => {
			const meta = LABELS[segment.label];
			const width = Math.max(
				((segment.end_ms - segment.start_ms) / total) * 100,
				0.18,
			);
			const evidence = segment.evidence
				.map(
					(item) =>
						`<li><code>${escapeHtml(item.key)}</code> — ${escapeHtml(item.summary)}</li>`,
				)
				.join("");
			return `<details class="timeline-segment seg-${escapeHtml(segment.label)}" style="flex:${width} 1 0%;--seg:${meta.color}"><summary title="${escapeHtml(meta.name)} · ${duration(segment.end_ms - segment.start_ms)}"><span>${escapeHtml(meta.name)}</span></summary><div class="segment-pop"><strong>${escapeHtml(meta.name)}${segment.sublabel ? ` · ${escapeHtml(segment.sublabel)}` : ""}</strong><div>${formatTime(segment.start_ms)} → ${formatTime(segment.end_ms)} · ${duration(segment.end_ms - segment.start_ms)}${segment.in_flight ? " · 进行中" : ""}</div><ul>${evidence}</ul></div></details>`;
		})
		.join("");
	const coverageRate = metrics.coverage_rate;
	return `<article class="issue-card"><div class="issue-head"><div><h3>${escapeHtml(report.issue)}</h3><p>${formatTime(report.t0)} → ${formatTime(report.end_ms)} · ${duration(total)}</p></div><div class="issue-pills"><span class="pill">覆盖 ${percent(coverageRate)}</span><span class="pill">返工段 ${reworkCount}</span>${report.closed ? "" : '<span class="pill amber">进行中</span>'}</div></div><div class="timeline" aria-label="${escapeHtml(report.issue)} wall-clock timeline">${segments}</div><div class="known-row"><span>已分类 ${duration(metrics.classifiable)}</span><span>无法测量 ${duration(unknown)}</span><span>进行中 ${duration(inFlight)}</span></div></article>`;
}

function renderSuggestion(item) {
	const id = escapeHtml(item.id);
	return `<article class="rec-card" data-id="${id}" data-title="${escapeHtml(item.title)}" data-saving="${escapeHtml(item.saving)}" data-cost="${escapeHtml(item.cost)}"><div class="rec-top"><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.rationale)}</p></div><div class="rec-meta"><span class="pill green">节省 ${escapeHtml(item.saving)}</span><span class="pill">成本 ${escapeHtml(item.cost)}</span></div></div><div class="decision"><input type="radio" id="${id}-build" name="${id}-decision" value="建"><label for="${id}-build">建</label><input type="radio" id="${id}-skip" name="${id}-decision" value="不建"><label for="${id}-skip">不建</label></div><textarea class="comment" placeholder="评论 / 条件 / 不同意的原因"></textarea></article>`;
}

export function renderReport({
	reports,
	verdict,
	manifests,
	suggestions,
	asOf,
}) {
	const summary = aggregate(reports);
	const analyzed = reports.filter((item) => item.kind === "analyzed");
	const pooled =
		summary.classifiable > 0
			? aggregateBar(summary.totals, summary.classifiable)
			: "";
	const perIssue = summary.issueMetrics
		.map((item) => {
			const bars =
				item.classifiable > 0
					? aggregateBar(item.totals, item.classifiable)
					: "";
			return `<div class="norm-row"><span>${escapeHtml(item.issue)}</span><div class="aggregate-bar">${bars}</div><b>${percent(item.coverage_rate)}</b></div>`;
		})
		.join("");
	const legend = Object.entries(CATEGORY_NAMES)
		.filter(([key]) => key !== "unknown")
		.map(
			([key, name]) =>
				`<span><i class="dot agg-${key}"></i>${escapeHtml(name)}</span>`,
		)
		.join("");
	const rawVerdict = verdict.pooled
		? `Pooled 机制 ${percent(verdict.pooled.mechanism)} / 执行 ${percent(verdict.pooled.execution)}；Per-issue median 机制 ${percent(verdict.median.mechanism)} / 执行 ${percent(verdict.median.execution)}。`
		: "达到 ≥80% 可分类覆盖的已关闭 issue 少于 2 个，结论保持 inconclusive。";
	const manifestRows = manifests
		.map(
			(item) =>
				`<tr><td>${escapeHtml(item.source_id)}</td><td><code>${escapeHtml(item.content_sha256)}</code></td><td>${escapeHtml(item.schema_version ?? "—")}</td></tr>`,
		)
		.join("");
	const coverageRows = analyzed
		.flatMap((report) =>
			report.coverage.map(
				(item) =>
					`<tr><td>${escapeHtml(report.issue)}</td><td>${escapeHtml(item.source)}</td><td>${escapeHtml(item.authoritative_kind)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.note)}</td></tr>`,
			),
		)
		.join("");
	const script = `
(function(){
  var key='fly1327-cycle-time-decisions-v1';
  var cards=Array.from(document.querySelectorAll('.rec-card'));
  function snapshot(){return cards.map(function(card){var selected=card.querySelector('input[type=radio]:checked');return{id:card.dataset.id,title:card.dataset.title,decision:selected?selected.value:'',comment:(card.querySelector('.comment').value||'').trim(),saving:card.dataset.saving,cost:card.dataset.cost};});}
  function save(){try{localStorage.setItem(key,JSON.stringify(snapshot()));}catch(e){}}
  function restore(){try{var rows=JSON.parse(localStorage.getItem(key)||'[]');rows.forEach(function(row){var card=document.querySelector('.rec-card[data-id="'+CSS.escape(row.id)+'"]');if(!card)return;var radio=Array.from(card.querySelectorAll('input[type=radio]')).find(function(input){return input.value===row.decision;});if(radio)radio.checked=true;card.querySelector('.comment').value=row.comment||'';});}catch(e){}}
  function exportFeedback(){var text=JSON.stringify({issue:'FLY-1327',decisions:snapshot()},null,2);var out=document.getElementById('feedback-output');out.hidden=false;out.value=text;out.focus();out.select();try{out.setSelectionRange(0,text.length);}catch(e){}var copied=false;try{copied=document.execCommand('copy');}catch(e){}var status=document.getElementById('copy-status');if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){status.textContent='已复制，可贴回 issue thread';},function(){status.textContent=copied?'已复制，可贴回 issue thread':'已选中文本，请长按复制';});}else{status.textContent=copied?'已复制，可贴回 issue thread':'已选中文本，请长按复制';}}
  restore();
  cards.forEach(function(card){card.addEventListener('change',save);card.addEventListener('input',save);});
  var button=document.getElementById('copy-feedback');if(button)button.addEventListener('click',exportFeedback);
})();`;

	return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FLY-1327 Issue 周期时间分解</title><style>
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--muted:#6e6e73;--line:#e5e5e7;--blue:#007aff;--green:#34c759;--amber:#ff9f0a;--red:#ff453a;--shadow:0 10px 35px rgba(0,0,0,.06)}*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;line-height:1.5}.page{max-width:960px;margin:auto;padding:40px 18px 80px}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--blue)}h1{font-size:clamp(30px,6vw,56px);line-height:1.04;letter-spacing:-.04em;margin:10px 0 14px}.lead{font-size:18px;color:var(--muted);max-width:760px}.hero,.card,.issue-card,.rec-card{background:var(--card);border:1px solid rgba(0,0,0,.045);border-radius:22px;box-shadow:var(--shadow)}.hero{padding:28px;margin:28px 0}.hero strong{font-size:24px;line-height:1.25}.hero p{color:var(--muted);margin-bottom:0}.section{margin-top:36px}.section>h2{font-size:24px;letter-spacing:-.02em;margin-bottom:14px}.card{padding:22px}.view-label{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--muted);margin:14px 0 7px}.aggregate-bar{height:28px;display:flex;overflow:hidden;border-radius:9px;background:#ececef}.aggregate-bar>span{min-width:2px}.agg-value_work{background:#34c759}.agg-necessary_process{background:#007aff}.agg-mechanism_waste{background:#ff9f0a}.agg-execution_waste{background:#af52de}.agg-human_wait{background:#8e8e93}.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:13px;font-size:12px;color:var(--muted)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.norm-row{display:grid;grid-template-columns:110px 1fr 50px;align-items:center;gap:10px;margin:9px 0;font-size:12px}.norm-row .aggregate-bar{height:18px}.issue-card{padding:20px;margin:14px 0}.issue-head,.rec-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.issue-head h3,.rec-card h3{font-size:18px;margin:0}.issue-head p,.rec-card p{margin:3px 0;color:var(--muted);font-size:13px}.issue-pills,.rec-meta{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.pill{display:inline-flex;padding:4px 9px;border-radius:999px;background:#f0f0f2;color:#515154;font-size:11px;font-weight:650}.pill.green{background:#e9f8ed;color:#187934}.pill.amber{background:#fff3de;color:#9a6100}.pill.red{background:#ffebe9;color:#b42318}.timeline{display:flex;align-items:stretch;height:64px;margin:18px 0 10px;border-radius:12px;overflow:visible;background:#eee}.timeline-segment{position:relative;min-width:3px;margin:0;border-right:1px solid rgba(255,255,255,.7)}.timeline-segment:first-child summary{border-radius:12px 0 0 12px}.timeline-segment:last-child summary{border-radius:0 12px 12px 0}.timeline-segment summary{list-style:none;height:64px;background:var(--seg);cursor:pointer;overflow:hidden;color:#fff;display:flex;align-items:center;justify-content:center}.timeline-segment summary::-webkit-details-marker{display:none}.timeline-segment summary span{font-size:10px;font-weight:700;writing-mode:vertical-rl;max-height:54px}.seg-unmeasurable summary{background:repeating-linear-gradient(135deg,#d1d1d6,#d1d1d6 5px,#e5e5ea 5px,#e5e5ea 10px);color:#515154}.segment-pop{display:none}.timeline-segment[open]{z-index:20}.timeline-segment[open] .segment-pop{display:block;position:absolute;left:0;top:70px;width:min(360px,80vw);background:#1d1d1f;color:#fff;padding:14px;border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.25);font-size:12px}.segment-pop ul{padding-left:18px;margin-bottom:0}.segment-pop code{white-space:normal;word-break:break-all}.known-row{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted)}.no-verdict{border-color:#ffd0cc}.rec-card{padding:20px;margin:14px 0}.decision{display:inline-flex;border:1px solid #d2d2d7;border-radius:10px;overflow:hidden;margin:14px 0 8px}.decision input{position:absolute;opacity:0;pointer-events:none}.decision label{padding:8px 22px;background:#fff;cursor:pointer;border-right:1px solid #d2d2d7}.decision label:last-child{border:0}.decision input:checked+label{background:#1d1d1f;color:#fff}.comment,#feedback-output{display:block;width:100%;min-height:58px;border:1px solid #d2d2d7;border-radius:12px;padding:10px;font:inherit;resize:vertical}.export{position:sticky;bottom:12px;background:rgba(245,245,247,.9);backdrop-filter:blur(15px);padding:12px 0;z-index:30}.button{border:0;border-radius:12px;background:#1d1d1f;color:#fff;padding:12px 18px;font-size:14px;font-weight:700;cursor:pointer}#copy-status{font-size:12px;color:var(--muted);margin-left:10px}#feedback-output{margin-top:9px;background:#fff;font-family:"SF Mono",monospace;font-size:11px}.caveat{border-left:4px solid var(--amber)}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:9px 6px;border-bottom:1px solid var(--line);vertical-align:top}td code{word-break:break-all}.method{color:var(--muted);font-size:13px}.method li{margin:7px 0}@media(max-width:640px){.page{padding-top:24px}.hero,.card,.issue-card,.rec-card{border-radius:16px}.issue-head,.rec-top{display:block}.issue-pills,.rec-meta{justify-content:flex-start;margin-top:10px}.norm-row{grid-template-columns:74px 1fr 42px}.timeline{height:52px}.timeline-segment summary{height:52px}.timeline-segment summary span{display:none}}
</style></head><body><main class="page"><div class="eyebrow">FLY-1327 · As-of ${escapeHtml(asOf)} · America/Los_Angeles</div><h1>Issue 周期时间<br>到底花在哪</h1><p class="lead">4 个对比样本的全生命周期墙钟分解。所有区间互斥，段和严格等于墙钟；测不到的明确标「无法测量」。</p><section class="hero"><strong>${escapeHtml(verdictCopy(verdict, reports.length))}</strong><p>${escapeHtml(rawVerdict)}</p></section><section class="section"><h2>全部样本汇总</h2><div class="card"><div class="view-label"><b>Pooled · 按墙钟加权</b><span>仅 closed、非 in-flight、可分类段</span></div><div class="aggregate-bar">${pooled}</div><div class="legend">${legend}</div><div class="view-label"><b>Per-issue · 每单归一</b><span>右侧为可分类覆盖</span></div>${perIssue}</div></section><section class="section"><h2>逐 issue 时间轴</h2>${reports.map(renderIssue).join("")}</section><section class="section"><h2>并发 × load</h2><div class="card caveat"><strong>${escapeHtml(CONCURRENCY_INSUFFICIENT_MSG)}</strong><p class="method">每个并发档需 ≥60 覆盖分钟且 ≥2 个独立 issue 才能定量；本次只保留描述性结论，不输出方向性估计。</p></div></section><section class="section"><h2>机制优化建议</h2><p class="method">每项节省是独立 counterfactual，上界基于本样本已测时长，<b>不可相加</b>。</p>${suggestions.map(renderSuggestion).join("")}<div class="export"><button class="button" id="copy-feedback">复制我的决定</button><span id="copy-status"></span><textarea id="feedback-output" hidden readonly></textarea></div></section><section class="section"><h2>方法与审计</h2><div class="card method"><ol><li>主线标签优先级：基建事故 → 人工 gate → 返工 → QA → review → CI → 工作 → 空转。</li><li>Linear createdAt / completedAt 定义生命周期；SQLite/CommDB 冻结快照；GitHub CI 按 head 分轮。</li><li>进行中与无法测量不进入已完成占比；night / load 只作解释变量，不作为机制证据。</li><li>结论门槛：closed 且覆盖 ≥80%；至少 2 个 issue；Pooled 与 per-issue median 同向且主导占比 ≥30%。</li></ol><h3>覆盖度</h3><table><thead><tr><th>Issue</th><th>Source</th><th>Kind</th><th>Status</th><th>Note</th></tr></thead><tbody>${coverageRows}</tbody></table><h3>Canonical manifests</h3><table><thead><tr><th>Source</th><th>SHA-256</th><th>Schema</th></tr></thead><tbody>${manifestRows}</tbody></table></div></section></main><script nonce="__CSP_NONCE__">${script}</script></body></html>`;
}
