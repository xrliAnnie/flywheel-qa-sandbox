import type {
	ProjectEntry,
	ReportModel,
	TrendPoint,
	WindowAgg,
} from "./build-report.js";

const MODEL_LABEL: Record<string, string> = {
	"claude-opus-4-8": "Opus 4.8",
	"claude-opus-4-7": "Opus 4.7",
	"claude-fable-5": "Fable 5",
	"claude-sonnet-4-6": "Sonnet 4.6",
	"claude-haiku-4-5-20251001": "Haiku 4.5",
};
const MODEL_COLOR: Record<string, string> = {
	"claude-opus-4-8": "#ff3b30",
	"claude-opus-4-7": "#ff6961",
	"claude-fable-5": "#34c759",
	"claude-sonnet-4-6": "#007aff",
	"claude-haiku-4-5-20251001": "#af52de",
};
const PROJ_COLORS = [
	"#007aff",
	"#34c759",
	"#ff9500",
	"#af52de",
	"#ff3b30",
	"#5ac8fa",
];

function esc(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);
}
function fmtTok(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
	if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
	return String(Math.round(n));
}
function usd(micro: number): string {
	return `$${Math.round(micro / 1e6).toLocaleString("en-US")}`;
}

function bars(
	rows: { label: string; tokens: number; cost: number; badge?: string }[],
	color: string,
	topn = 10,
): string {
	const top = rows.slice(0, topn);
	if (!top.length) return '<div class="empty">—</div>';
	const mx = Math.max(...top.map((r) => r.tokens), 1);
	return top
		.map((r) => {
			const badge = r.badge
				? `<span class="xbadge">${esc(r.badge)}</span>`
				: "";
			return `<div class="srow"><span class="sk" title="${esc(r.label)}">${esc(r.label)}${badge}</span><span class="sbar"><span style="width:${((r.tokens / mx) * 100).toFixed(0)}%;background:${color}"></span></span><span class="sv">${fmtTok(r.tokens)}</span><span class="su">${usd(r.cost)}</span></div>`;
		})
		.join("");
}

function trendBars(points: TrendPoint[], reportDay: string): string {
	const W = 900;
	const H = 130;
	const pad = 22;
	const n = points.length || 1;
	const mx = Math.max(...points.map((p) => p.tokens), 1);
	const bw = (W - 2 * pad) / n;
	const parts: string[] = [
		`<text x="${pad}" y="12" font-size="9" fill="#86868b">峰值 ${fmtTok(mx)}/天</text>`,
	];
	points.forEach((p, i) => {
		const x = pad + i * bw;
		const h = (p.tokens / mx) * (H - 34);
		const y = H - 20 - h;
		const col = p.day === reportDay ? "#007aff" : "#c7d2e0";
		parts.push(
			`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${col}"><title>${p.day}: ${fmtTok(p.tokens)}</title></rect>`,
		);
		if (i % 4 === 0 || i === n - 1)
			parts.push(
				`<text x="${(x + bw * 0.35).toFixed(1)}" y="${H - 6}" font-size="8" fill="#86868b" text-anchor="middle">${p.day.slice(5)}</text>`,
			);
	});
	return `<svg viewBox="0 0 ${W} ${H}" width="100%">${parts.join("")}</svg>`;
}

function trendLines(
	series: { project: string; points: TrendPoint[] }[],
	days: string[],
): string {
	const W = 900;
	const H = 160;
	const pad = 26;
	const n = days.length || 1;
	const mx = Math.max(
		1,
		...series.flatMap((s) => s.points.map((p) => p.tokens)),
	);
	const X = (i: number) => pad + (n > 1 ? i * ((W - 2 * pad) / (n - 1)) : 0);
	const Y = (v: number) => H - 22 - (v / mx) * (H - 36);
	const parts: string[] = [
		`<text x="${pad}" y="12" font-size="9" fill="#86868b">峰值 ${fmtTok(mx)}/天</text>`,
	];
	series.forEach((s, j) => {
		const pts = s.points
			.map((p, i) => `${X(i).toFixed(1)},${Y(p.tokens).toFixed(1)}`)
			.join(" ");
		parts.push(
			`<polyline points="${pts}" fill="none" stroke="${PROJ_COLORS[j % PROJ_COLORS.length]}" stroke-width="2" opacity="0.9"/>`,
		);
	});
	days.forEach((d, i) => {
		if (i % 4 === 0 || i === n - 1)
			parts.push(
				`<text x="${X(i).toFixed(1)}" y="${H - 6}" font-size="8" fill="#86868b" text-anchor="middle">${d.slice(5)}</text>`,
			);
	});
	const legend = series
		.map(
			(s, j) =>
				`<span><i style="background:${PROJ_COLORS[j % PROJ_COLORS.length]}"></i>${esc(s.project)}</span>`,
		)
		.join("");
	return `<svg viewBox="0 0 ${W} ${H}" width="100%">${parts.join("")}</svg><div class="legend">${legend}</div>`;
}

function projectCard(p: ProjectEntry, maxTok: number): string {
	const head = `<div class="phead"><span class="pn">${esc(p.name)}</span><span class="pbarw"><span class="pbar" style="width:${maxTok ? ((p.tokens / maxTok) * 100).toFixed(0) : 0}%"></span></span><span class="pt">${fmtTok(p.tokens)}<small> · ${usd(p.cost)} · 含 Leads</small></span></div>`;
	const leadRows = bars(
		p.leads.map((l) => ({ label: l.name, tokens: l.tokens, cost: l.cost })),
		"#34c759",
	);
	const issueRows = bars(
		p.issues.map((i) => ({ label: i.id, tokens: i.tokens, cost: i.cost })),
		"#007aff",
	);
	const inner = `<div class="pinner"><div class="pcol"><div class="ph2">Leads（本项目）</div>${leadRows}</div><div class="pcol"><div class="ph2">已完成 Issues（当天用量）</div>${issueRows}</div></div>`;
	const foot = p.inprogCount
		? `<div class="muted">+ ${p.inprogCount} 个进行中 issue 用了 ${fmtTok(p.inprogTokens)}（完成后才计入）</div>`
		: "";
	return `<div class="card pcard">${head}${inner}${foot}</div>`;
}

function comparisonHero(before: WindowAgg, after: WindowAgg): string {
	const pct = before.avgTokens
		? ((after.avgTokens - before.avgTokens) / before.avgTokens) * 100
		: 0;
	const good = pct <= 0;
	const arrow = good ? "▼" : "▲";
	const afterCls = good ? "after" : "after-neutral";
	return `<div class="cmp"><div class="col before"><div class="tag">${esc(before.label)}</div><div class="num">${fmtTok(before.avgTokens)}<small> tok/天</small></div><div class="cost">${usd(before.avgCost)}/天 重量</div></div><div class="mid"><div class="delta ${good ? "good" : "bad"}">${arrow}${Math.abs(pct).toFixed(0)}%</div><div class="tag">用量变化</div></div><div class="col ${afterCls}"><div class="tag">${esc(after.label)}</div><div class="num">${fmtTok(after.avgTokens)}<small> tok/天</small></div><div class="cost">${usd(after.avgCost)}/天 重量</div></div></div>`;
}

const CSS = `*{box-sizing:border-box;margin:0;padding:0}body{background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,system-ui,sans-serif;line-height:1.5;padding:28px 16px}
.wrap{max-width:980px;margin:0 auto}h1{font-size:25px;font-weight:700;letter-spacing:-.02em}.sub{color:#86868b;font-size:14px;margin-top:4px}
.pill{display:inline-block;background:#34c759;color:#fff;font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px;vertical-align:middle}
.warn{background:#fff3e0;border-left:4px solid #ff9500;border-radius:10px;padding:8px 14px;font-size:12.5px;color:#9a6700;margin-top:12px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:18px 20px;overflow:hidden;margin-top:16px}
.card h2{font-size:13px;font-weight:600;color:#86868b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:12px;display:flex;justify-content:space-between}
.big{font-size:31px;font-weight:700;letter-spacing:-.02em}.big small{font-size:14px;color:#86868b;font-weight:500}
.split{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:10px 0 4px}
.legend{display:flex;gap:14px;font-size:11px;color:#86868b;flex-wrap:wrap;margin-top:6px}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
.cmp{display:grid;grid-template-columns:1fr auto 1fr}.cmp .col{padding:12px 16px}.cmp .before{background:#fbfbfd;border-radius:10px}.cmp .after{background:#f0faf2;border-radius:10px}.cmp .after-neutral{background:#fbfbfd;border-radius:10px}
.cmp .mid{display:flex;flex-direction:column;justify-content:center;align-items:center;padding:0 14px}.cmp .tag{font-size:10.5px;color:#86868b;text-transform:uppercase}
.cmp .num{font-size:24px;font-weight:700;margin:3px 0}.cmp .num small{font-size:12px;color:#86868b;font-weight:500}.cmp .cost{font-size:11.5px;color:#86868b;margin-top:5px}
.delta{font-size:23px;font-weight:700}.delta.good{color:#34c759}.delta.bad{color:#ff3b30}
.pcard .phead{display:flex;align-items:center;gap:12px;margin-bottom:12px}.pn{font-size:16px;font-weight:700;width:130px;flex:0 0 130px}
.pbarw{flex:1;background:#f0f0f2;border-radius:5px;height:10px;overflow:hidden}.pbar{display:block;height:100%;background:#1a365d;border-radius:5px}
.pt{font-family:'SF Mono',monospace;font-size:14px;font-weight:600;white-space:nowrap}.pt small{color:#86868b;font-weight:400;font-size:12px}
.pinner{display:grid;grid-template-columns:1fr 1fr;gap:18px}.ph2{font-size:11px;color:#86868b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;border-bottom:1px solid #f0f0f2;padding-bottom:4px}
.srow{display:flex;align-items:center;gap:8px;font-size:12.5px;margin:5px 0}.sk{width:130px;flex:0 0 130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sbar{flex:1;background:#f5f5f7;border-radius:4px;height:7px;overflow:hidden}.sbar span{display:block;height:100%;border-radius:4px}
.sv{width:84px;flex:0 0 84px;text-align:right;font-family:'SF Mono',monospace;font-size:11.5px}.su{width:48px;flex:0 0 48px;text-align:right;color:#86868b;font-size:10.5px}
.empty{color:#c7c7cc;font-size:12px;padding:4px 0}.muted{color:#86868b;font-size:11.5px;margin-top:10px;padding-top:8px;border-top:1px solid #f0f0f2}
.xbadge{display:inline-block;background:#eef;color:#5856d6;font-size:9.5px;font-weight:600;padding:1px 6px;border-radius:10px;margin-left:6px}
.foot{color:#86868b;font-size:11px;margin-top:22px;text-align:center}.two{display:grid;grid-template-columns:1fr;gap:16px}
.tchart{margin-top:10px}.tlabel{font-size:12px;font-weight:600;color:#1d1d1f;margin:6px 0}`;

/** Render the daily token report as a self-contained Apple-light HTML page (<head>, inline CSS). */
export function renderReportHtml(m: ReportModel): string {
	const t = m.total;
	const sp = t.input + t.output + t.cacheRead + t.cacheWrite || 1;
	const split = `<div class="split"><span style="width:${(t.input / sp) * 100}%;background:#007aff"></span><span style="width:${(t.output / sp) * 100}%;background:#34c759"></span><span style="width:${(t.cacheRead / sp) * 100}%;background:#d2d2d7"></span><span style="width:${(t.cacheWrite / sp) * 100}%;background:#ff9500"></span></div><div class="legend"><span><i style="background:#007aff"></i>input ${fmtTok(t.input)}</span><span><i style="background:#34c759"></i>output ${fmtTok(t.output)}</span><span><i style="background:#d2d2d7"></i>cache read ${fmtTok(t.cacheRead)}</span><span><i style="background:#ff9500"></i>cache write ${fmtTok(t.cacheWrite)}</span></div>`;

	const heroCard = m.comparison
		? `<div class="card"><h2>改动前后用量对比 <span>核心视图 · ponytail 灰度</span></h2>${comparisonHero(m.comparison.before, m.comparison.after)}</div>`
		: "";

	const trendDays = m.trendTotal.map((p) => p.day);
	const trendCard = `<div class="card"><h2>总用量随时间 <span>维度① 全 fleet 总量</span></h2><div class="tchart">${trendBars(m.trendTotal, m.reportDay)}</div><div class="tlabel">维度② 每个项目各自随时间</div><div class="tchart">${trendLines(m.trendByProject, trendDays)}</div></div>`;

	const summaryCard = `<div class="card"><h2>当日总用量 <span>${esc(m.reportDay)} · ${esc(m.timezone)}</span></h2><div class="big">${fmtTok(t.tokens)} <small>tokens</small> <span style="color:#86868b;font-size:18px">· ${usd(t.cost)} 重量</span></div>${split}</div>`;

	const maxTok = m.projects[0]?.tokens ?? 1;
	const projCards = m.projects
		.slice(0, 8)
		.map((p) => projectCard(p, maxTok))
		.join("");
	const projSection = `<h2 style="font-size:13px;color:#86868b;text-transform:uppercase;letter-spacing:.04em;margin:22px 4px 0">按项目展开（项目总量[runner+主仓+Leads] → 其下 Leads + 当天已完成 issues）</h2><div class="two">${projCards}</div>`;

	const leadsTotalTok = m.leadsAll.reduce((s, l) => s + l.tokens, 0);
	const leadsTotalCost = m.leadsAll.reduce((s, l) => s + l.cost, 0);
	const leadsCard = `<div class="card"><h2>Leads 排名（全 fleet）<span>各 Lead 已计入其项目总量 · ${fmtTok(leadsTotalTok)} · ${usd(leadsTotalCost)}</span></h2>${bars(
		m.leadsAll.map((l) => ({ label: l.name, tokens: l.tokens, cost: l.cost })),
		"#34c759",
		14,
	)}<div class="muted">Lead↔项目 为一对多（每个 Lead 属一个项目）。项目头条 = 该项目 runner+主仓 + 其 Leads（1:1 折入，无重复算）。此卡是跨项目的 Lead 排名视图。</div></div>`;

	const mModelMax = Math.max(...m.models.map((x) => x.tokens), 1);
	const mModelTot = m.models.reduce((s, x) => s + x.tokens, 0) || 1;
	const modelRows = m.models
		.slice(0, 6)
		.map((mm) => {
			const col = MODEL_COLOR[mm.name] ?? "#86868b";
			return `<div class="srow"><span class="sk">${esc(MODEL_LABEL[mm.name] ?? mm.name)}</span><span class="sbar"><span style="width:${((mm.tokens / mModelMax) * 100).toFixed(0)}%;background:${col}"></span></span><span class="sv">${fmtTok(mm.tokens)} · ${((mm.tokens / mModelTot) * 100).toFixed(0)}%</span><span class="su">${usd(mm.cost)}</span></div>`;
		})
		.join("");
	const modelCard = `<div class="card"><h2>按模型 <span>tokens · 重量</span></h2>${modelRows}</div>`;

	const warnBanner = m.warning
		? `<div class="warn">${esc(m.warning)}</div>`
		: "";
	const storeNote = m.storeMode === "local" ? "（本地 fallback 数据）" : "";

	const body = `<h1>每日 Token 用量报告 <span class="pill">FLY-614</span></h1><div class="sub">${esc(m.reportDay)} · 全 fleet · 项目→(Leads + 当天已完成 issues) 嵌套 · 用量为主、重量(USD)为辅 ${storeNote}</div>${warnBanner}${heroCard}${trendCard}${summaryCard}${projSection}${leadsCard}${modelCard}`;

	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-614 每日 Token 报告 ${esc(m.reportDay)}</title><style>${CSS}</style></head><body><div class="wrap">${body}<div class="foot">FLY-614 · 数据=CC 日志真实用量 · USD=公开定价折算「重量」(非账单,订阅制) · issue=当天用量·仅已完成 · Lead↔项目=一对多(项目总量含其 Leads) · 持久化=Supabase(daily 聚合)+本地 fallback</div></div></body></html>`;
}
