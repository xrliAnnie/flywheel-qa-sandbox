import type {
	DagDispatchFact,
	DagFlagPanel,
	DagPreset,
} from "./dag-flag-panel.js";
import { esc } from "./feature-flag-render.js";

function dispatchLabel(label: string, fact: DagDispatchFact): string {
	const state =
		fact.state === "ready"
			? "READY"
			: fact.state === "degraded"
				? "DEGRADED"
				: "OFF";
	const detail = fact.missing.length
		? ` · ${fact.state === "degraded" ? "分歧" : "缺"}: ${fact.missing.join(", ")}`
		: "";
	return `<div class="dag-fact"><strong>${esc(label)}</strong><span class="dag-state dag-${fact.state}">${state}</span><span>${esc(detail)}</span></div>`;
}

function presetButton(label: string, preset: DagPreset): string {
	if (!preset.enabled) {
		return `<button type="button" class="dag-command" disabled title="${esc(preset.disabledReason ?? "当前不可安全操作")}">${esc(label)}</button>`;
	}
	if (!preset.phase1Command) {
		return `<button type="button" class="dag-command" disabled>${esc(label)}（无需变更）</button>`;
	}
	return `<button type="button" class="dag-command" data-dag-copy="${esc(`${preset.phase1Command} && flywheel-comm feature-flags report`)}">${esc(label)}</button>`;
}

export function renderDagFlagPanelHtml(
	panel: DagFlagPanel,
	interactive: boolean,
): string {
	const readerLabel = {
		forced_legacy: "legacy（应急回退生效）",
		claims: "claims",
		blocked_fail_closed: "无 reader（fail-closed）",
		degraded: "DEGRADED（来源分歧）",
	}[panel.shipReader];
	const phase2 = panel.presets.enableV2.phase2Command;
	const actions = interactive
		? [
				'<div class="dag-actions">',
				presetButton("开 DAG v1 · 第一阶段", panel.presets.enableV1),
				presetButton("开 DAG v2 · 第一阶段", panel.presets.enableV2),
				presetButton("彻底关 DAG", panel.presets.disable),
				phase2
					? `<button type="button" class="dag-command dag-phase2" data-dag-copy="${esc(`${phase2} && flywheel-comm feature-flags report`)}">确认 claims 后关闭 legacy 回退 · 第二阶段</button>`
					: '<button type="button" class="dag-command dag-phase2" disabled>第二阶段需打开新报告确认 claims reader</button>',
				"</div>",
				'<p class="dag-help">第一阶段命令使用 <code>&amp;&amp;</code> 失败即停；命令末尾自动重发本报告，完成后打开新链接，确认 ship reader=claims，再复制第二阶段。</p>',
			].join("")
		: "";
	return [
		'<section class="dag-panel">',
		'<div class="dag-title"><h2>DAG 控制</h2><span>五杆三事实</span></div>',
		dispatchLabel("v1 dispatch", panel.v1Dispatch),
		dispatchLabel("v2 dispatch", panel.v2Dispatch),
		`<div class="dag-fact"><strong>ship reader</strong><span class="dag-state">${esc(readerLabel)}</span></div>`,
		panel.degradedFlags.length
			? `<p class="dag-warning">⚠ 来源分歧/不可用: ${esc(panel.degradedFlags.join(", "))}；方向性 preset 已禁用。</p>`
			: "",
		actions,
		"</section>",
	].join("");
}

export const DAG_FLAG_PANEL_CSS = `
.dag-panel{background:#fff;border-radius:12px;padding:15px 17px;box-shadow:0 1px 3px rgba(0,0,0,.06);margin:0 0 16px;border-left:4px solid #34c759}
.dag-title{display:flex;align-items:baseline;gap:9px;margin-bottom:9px}.dag-title h2{font-size:16px;margin:0}.dag-title span{font-size:11px;color:#86868b}
.dag-fact{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding:4px 0}.dag-fact strong{min-width:92px}
.dag-state{font-size:11px;font-weight:700;border-radius:20px;background:#f0f0f2;padding:2px 8px}.dag-ready{background:#e3f7ea;color:#248a3d}.dag-degraded{background:#fff3e0;color:#c66a00}
.dag-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}.dag-command{border:1px solid #007aff;background:#007aff;color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer}.dag-command:disabled{opacity:.45;cursor:default}.dag-phase2{background:#5856d6;border-color:#5856d6}
.dag-help,.dag-warning{font-size:11px;line-height:1.45;margin:8px 0 0;color:#6e6e73}.dag-warning{color:#c66a00}
`;
