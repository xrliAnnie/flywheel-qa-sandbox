/**
 * FLY-709 — shared read-only renderer for feature-flag views (Apple-card style).
 *
 * One source of truth for the `FlagView → HTML` presentation, reused by BOTH the
 * localhost Fleet Console (which fetches the card fragment + wires toggles) and
 * the phone report — so the two never drift. Apple-light cards (html-report-style):
 * white card, 12px radius, subtle shadow, 4px LEFT-BORDER color-coding by category
 * (feature=blue / kill-switch=amber / governance=purple). Read-only by itself;
 * an interactive `control` slot (console button / phone checkbox) is injected per
 * surface for the `direct`-toggleable flags only.
 */

import type { FlagView } from "flywheel-config";

/** HTML-escape (attributes + text). */
export function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** 生效路径 label (how a change to this flag takes effect). */
export function effectLabel(flag: FlagView): string {
	if (flag.source === "project_config") return "新 run 生效";
	if (flag.readTimings.includes("cli_invocation")) return "命令级";
	if (flag.readTimings.every((t) => t === "call_time")) return "热生效";
	return "需重启";
}

/** Human category label (clearer bilingual labels — Annie found the raw terms confusing). */
export function categoryLabel(cat: FlagView["category"]): string {
	if (cat === "kill_switch") return "紧急开关 kill-switch";
	if (cat === "governance_gate") return "治理门 governance";
	return "功能开关 feature";
}

/** One-line definition of each category (⑤ — Annie was confused by the 3 types). */
export function categoryDefinition(cat: FlagView["category"]): string {
	if (cat === "kill_switch")
		return "出问题时一键关停某个子系统的「保护/急停」开关。多为默认开着(保护生效),紧急时设 =0 关停。";
	if (cat === "governance_gate")
		return "安全 / 审批红线(如 founder 同意门、写权限门)。永远只读 —— 绝不能在这个面板上改。";
	return "打开 / 关闭一个产品功能。默认多为开着,关掉 = 停用这个功能。";
}

/**
 * A plain-language sentence for what toggling THIS flag does — derived from its
 * polarity / category / scope, so every flag reads clearly even when the registry
 * description is terse (④). This is the "让她知道具体在干嘛" line.
 */
export function effectSentence(flag: FlagView): string {
	if (flag.dormant) return "已登记但 runtime 暂不加载(预留项),只读。";
	if (flag.category === "governance_gate")
		return "治理门:安全/审批红线,永远只读、绝不在此改。";
	const proj =
		flag.scope === "project" ? "每个项目单独设,改后对新 run 生效。" : "";
	if (flag.valueKind !== "bool") {
		return `取值型(非开关),当前值见上方。${proj}`;
	}
	// FlagView carries `default` (the spec default); for a bool flag, default===true
	// means default-on (a kill-switch that's ON by default).
	const defaultOn = flag.default === true;
	const base = defaultOn
		? flag.category === "kill_switch"
			? "默认开着(保护生效);紧急时设 =0 关停。"
			: "默认开着;设 =0 关掉这个功能。"
		: flag.category === "kill_switch"
			? "默认关;设 =1 启用这道保护。"
			: "默认关;设 =1 打开这个功能。";
	return `${base}${proj ? ` ${proj}` : ""}`;
}

/** The category legend — 3 cards explaining the difference (⑤). */
export function renderCategoryLegend(): string {
	const cats: FlagView["category"][] = [
		"feature",
		"kill_switch",
		"governance_gate",
	];
	const cards = cats
		.map(
			(c) =>
				`<div class="ffleg ${categoryClass(c)}"><div class="ffleg-t">${esc(categoryLabel(c))}</div><div class="ffleg-d">${esc(categoryDefinition(c))}</div></div>`,
		)
		.join("");
	return `<div class="ffleg-wrap">${cards}</div>`;
}

/** CSS class suffix for a category (drives the left-border color). */
export function categoryClass(cat: FlagView["category"]): string {
	return cat === "governance_gate"
		? "ffc-gov"
		: cat === "kill_switch"
			? "ffc-kill"
			: "ffc-feat";
}

/**
 * A flag is offered a direct toggle only when it is an env, bridge-global,
 * call-time, non-governance, non-dormant `direct` flag (registry invariant). The
 * server re-checks on stage/apply — this is only which cards show a control.
 */
export function isFlagViewDirectToggleable(flag: FlagView): boolean {
	return (
		flag.toggleable === "direct" &&
		flag.scope === "bridge_global" &&
		flag.source === "env" &&
		!flag.dormant &&
		flag.readTimings.length > 0 &&
		flag.readTimings.every((t) => t === "call_time")
	);
}

function boolBadge(on: boolean): string {
	return on
		? '<span class="ff-badge ff-on">ON</span>'
		: '<span class="ff-badge ff-off">OFF</span>';
}

/** Render the current-state badge for a flag view (read-only). */
export function renderFlagState(flag: FlagView): string {
	// A malformed value (e.g. an invalid DECISION_MODE the real parser rejects)
	// must be shown as an explicit error, never as a blank/empty valid state.
	if (flag.error) {
		return `<span class="ff-badge ff-err">⚠ ${esc(flag.error)}</span>`;
	}
	if (flag.dormant) {
		return '<span class="ff-badge ff-dim">validated-only (dormant)</span>';
	}
	if (flag.scope === "project") {
		const rows = flag.effectiveByProject ?? [];
		if (rows.length === 0) {
			return '<span class="ff-badge ff-dim">no project</span>';
		}
		return rows
			.map((r) => {
				const name = esc(r.projectName);
				if (r.error !== undefined) {
					return `<span class="ff-proj">${name}: <span class="ff-badge ff-err">error</span></span>`;
				}
				const val =
					flag.valueKind === "bool"
						? boolBadge(r.value === true)
						: `<span class="ff-badge ff-val">${esc(String(r.value ?? ""))}</span>`;
				return `<span class="ff-proj">${name}: ${val}</span>`;
			})
			.join(" ");
	}
	// bridge_global
	if (flag.valueKind === "bool") return boolBadge(flag.effective === true);
	return `<span class="ff-badge ff-val">${esc(String(flag.effective ?? ""))}</span>`;
}

/** How the per-card interactive control is rendered (differs by surface). */
export type FlagControlMode = "none" | "console" | "phone";

/** The in-card control for a direct-toggleable flag (console button / phone checkbox). */
function renderFlagControl(flag: FlagView, mode: FlagControlMode): string {
	if (mode === "none" || !isFlagViewDirectToggleable(flag)) return "";
	const on = flag.effective === true;
	const to = on ? "off" : "on";
	if (mode === "console") {
		return `<button type="button" class="ffc-btn" data-ff-apply data-ff-name="${esc(flag.name)}" data-ff-to="${to}">切到 ${on ? "OFF" : "ON"}</button>`;
	}
	// phone: a checkbox that the copy-paste script reads to build the command
	return `<label class="ffc-check"><input type="checkbox" data-ff-toggle data-ff-name="${esc(flag.name)}" data-ff-to="${to}"> 改为 ${on ? "OFF" : "ON"}</label>`;
}

/** Render one flag as an Apple card (read-only body + optional control). */
export function renderFlagCard(
	flag: FlagView,
	mode: FlagControlMode = "none",
): string {
	const name = esc(flag.envVar ?? flag.configKey ?? flag.name);
	const cat = categoryLabel(flag.category);
	const catClass =
		flag.category === "governance_gate"
			? "ff-gov"
			: flag.category === "kill_switch"
				? "ff-kill"
				: "ff-feat";
	const control = renderFlagControl(flag, mode);
	return [
		`<div class="ffc ${categoryClass(flag.category)}">`,
		'<div class="ffc-head">',
		`<code class="ffc-name">${name}</code>`,
		`<span class="ffc-state">${renderFlagState(flag)}</span>`,
		"</div>",
		`<div class="ffc-desc">${esc(flag.description)}</div>`,
		`<div class="ffc-effect">${esc(effectSentence(flag))}</div>`,
		'<div class="ffc-foot">',
		`<span class="ff-badge ${catClass}">${esc(cat)}</span>`,
		`<span class="ff-badge ff-eff">${esc(effectLabel(flag))}</span>`,
		control,
		"</div>",
		"</div>",
	].join("");
}

/** The CSS for the feature-flag cards (shared by console + phone report). */
export const FEATURE_FLAG_CSS = `
.ff-cat-title{font-weight:650;color:#1d1d1f;margin:16px 0 6px;font-size:14px}
.ff-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.ffc{background:#fff;border-radius:12px;padding:13px 15px;box-shadow:0 1px 3px rgba(0,0,0,.06);
  border-left:4px solid #86868b}
.ffc-feat{border-left-color:#007aff}
.ffc-kill{border-left-color:#ff9500}
.ffc-gov{border-left-color:#af52de}
.ffc-head{display:flex;align-items:center;gap:8px}
.ffc-name{font-family:'SF Mono',monospace;font-size:12px;color:#1a365d;font-weight:600}
.ffc-state{margin-left:auto;text-align:right}
.ffc-desc{color:#1d1d1f;font-size:12px;margin:6px 0 4px;line-height:1.45}
.ffc-effect{color:#86868b;font-size:11px;margin:0 0 9px;line-height:1.45}
.ffc-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ffleg-wrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin:6px 0 14px}
.ffleg{background:#fff;border-radius:12px;padding:11px 14px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid #86868b}
.ffleg.ffc-feat{border-left-color:#007aff}
.ffleg.ffc-kill{border-left-color:#ff9500}
.ffleg.ffc-gov{border-left-color:#af52de}
.ffleg-t{font-weight:650;font-size:12.5px;margin-bottom:3px}
.ffleg-d{color:#86868b;font-size:11.5px;line-height:1.5}
.ffc-btn{margin-left:auto;border:1px solid #007aff;background:#007aff;color:#fff;border-radius:8px;
  padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.ffc-btn:disabled{opacity:.5;cursor:default}
.ffc-check{margin-left:auto;font-size:12px;color:#1d1d1f;display:flex;align-items:center;gap:5px;cursor:pointer}
.ff-badge{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:600}
.ff-on{background:#e3f7ea;color:#248a3d}
.ff-off{background:#f0f0f2;color:#86868b}
.ff-dim{background:#f0f0f2;color:#86868b}
.ff-err{background:#ffe5e3;color:#d70015}
.ff-val{background:#e8f0fe;color:#1a365d;font-family:'SF Mono',monospace}
.ff-feat{background:#e8f0fe;color:#007aff}
.ff-kill{background:#fff3e0;color:#c66a00}
.ff-gov{background:#f3e8fe;color:#8944ab}
.ff-eff{background:#f5f5f7;color:#48484a}
.ff-proj{display:inline-block;margin-right:8px}
`;

/**
 * Render the whole feature-flags view as ONE flat list of Apple cards (Annie:
 * "别分三类,一个 feature flag 够了" — don't split into 3 categories). Each card
 * keeps its left-border color + governance stays locked (non-toggleable), but
 * there is no category grouping/legend to confuse the founder. `opts.legend` is
 * retained for byte-compat but ignored (the 3-type legend was removed).
 */
export function renderFeatureFlagsHtml(
	flags: FlagView[],
	mode: FlagControlMode = "none",
	_opts: { legend?: boolean } = {},
): string {
	if (flags.length === 0) return '<p class="ff-empty">无 feature flag。</p>';
	return [
		'<div class="ff-grid">',
		...flags.map((f) => renderFlagCard(f, mode)),
		"</div>",
	].join("\n");
}
