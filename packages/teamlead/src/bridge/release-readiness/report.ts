import { escapeHtml } from "../xhs-review-html.js";
import {
	isReadinessHeartbeatHealthy,
	type ReadinessInput,
	type ReleaseReadinessRecord,
} from "./evaluate.js";

export function renderReadinessReport(
	input: ReadinessInput,
	verdict: ReleaseReadinessRecord,
	day: string,
): string {
	const text = (value: unknown) =>
		escapeHtml(
			value === null || value === undefined
				? "unknown"
				: typeof value === "string"
					? value
					: JSON.stringify(value),
		);
	const table = (title: string, rows: object[]) =>
		`<section><h2>${text(title)} <small>${rows.length}</small></h2>${
			rows.length
				? `<div class="scroll"><table><thead><tr>${Object.keys(rows[0]!)
						.map((key) => `<th>${text(key)}</th>`)
						.join("")}</tr></thead><tbody>${rows
						.map(
							(row) =>
								`<tr>${Object.values(row)
									.map((value) => `<td>${text(value)}</td>`)
									.join("")}</tr>`,
						)
						.join("")}</tbody></table></div>`
				: '<p class="muted">暂无记录</p>'
		}</section>`;
	const minutes = new Map<number, boolean>();
	for (const h of input.heartbeats) {
		const minute = Math.floor(Date.parse(h.tickAt) / 60_000);
		minutes.set(
			minute,
			(minutes.get(minute) ?? true) &&
				isReadinessHeartbeatHealthy(h, input.policy.backlogAgeMaxS),
		);
	}
	const from = Math.floor(Date.parse(verdict.evidence.window.from) / 60_000);
	const to = Math.floor(Date.parse(verdict.evidence.window.to) / 60_000);
	let timeline = "";
	for (let minute = from; minute <= to; minute++) {
		if (minute === from || minute % 60 === 0)
			timeline += `${minute === from ? "" : "</div>"}<div class="hour"><time>${text(new Date(minute * 60_000).toISOString().slice(0, 16))}</time>`;
		timeline +=
			minutes.get(minute) === true
				? "<i></i>"
				: minutes.get(minute) === false
					? '<i class="bad"></i>'
					: '<i class="missing"></i>';
	}
	if (timeline) timeline += "</div>";
	const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>发布就绪日报 · ${text(day)}</title><style>
body{margin:0;background:#f4f5f7;color:#202936;font:15px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:40px 24px}header,section{background:white;border:1px solid #dfe4ea;border-radius:12px;padding:22px;margin-bottom:18px}h1{font-size:28px;margin:4px 0 14px}h2{font-size:18px;margin:0 0 12px}small,.muted{color:#667085}small{font-size:13px}code,td{overflow-wrap:anywhere}.state{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:700;background:#e8edf3}.green{background:#dbf3e7;color:#126544}.hold{background:#ffead0;color:#8a4b00}.unknown{background:#e8edf3;color:#465569}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e7ebef;padding:8px;min-width:75px}th{color:#596579}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.hour{display:flex;gap:2px;align-items:center;height:20px}.hour time{font-size:11px;width:135px;flex-shrink:0}.hour i{display:block;width:10px;height:10px;background:#46a980;flex-shrink:0}.hour .bad{background:#d77a39}.hour .missing{background:#d8dde4}.timeline{overflow-x:auto}.legend{font-size:12px;color:#667085}@media(max-width:600px){main{padding:20px 12px}header,section{padding:16px}h1{font-size:23px}}
</style></head><body><main><header><small>FLYWHEEL · ${text(day)}</small><h1>发布就绪日报 <span class="state ${text(verdict.state)}">${text(verdict.state)}</span></h1><p>版本 <strong>${text(input.subject.baseVersion)}</strong> · <code>${text(input.subject.sourceCommit)}</code></p><p>本机部署 <code>${text(input.localDeployedSha)}</code></p><p>窗口 ${text(verdict.evidence.window.from)} — ${text(verdict.evidence.window.to)}${verdict.evidence.window.windowTruncated ? " · 已按 14 天保留期截断" : ""}</p><small>评估 ${text(verdict.evaluatedAt)} · ${text(verdict.verdictId)}</small></header>
${table("判定理由", verdict.reasons)}${table("信号计数", [verdict.evidence.counts])}
<section><h2>Heartbeat 时间轴</h2><p class="legend">每格一分钟：绿 = 健康，橙 = 源不健康，灰 = 缺失。同分钟多次采样按较差结果显示。</p><div class="timeline">${timeline}</div><pre>${text(verdict.evidence.heartbeat)}</pre></section>
${table("原始事件", input.events)}${table("采集缺口", input.gaps)}${table("Bug 与待落定意图", input.bugs)}${table("Bug 源健康", input.bugSourceHealth ? [input.bugSourceHealth] : [])}${table("Outbox 盘点", [input.outbox])}${table("日报发布与扫描", input.publications)}${table("Annie 的反馈", input.founderVerdicts)}
<section><h2>本次阈值</h2><pre>${text(input.policy)}</pre></section></main></body></html>`;
	if (Buffer.byteLength(html, "utf8") > 512 * 1024)
		throw new RangeError("readiness report exceeds 512 KiB");
	return html;
}
