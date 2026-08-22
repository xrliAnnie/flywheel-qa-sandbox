/**
 * FLY-709 — the phone feature-flag report (publish-report artifact), Apple-light.
 *
 * A complete, self-contained HTML document (needs a <head> — report-registry
 * rejects HTML without one) that Annie opens on her phone. It reuses the shared
 * Apple-card renderer (feature-flag-render.ts) so it never drifts from the Fleet
 * Console. The localhost console renders the SAME cards natively (it fetches the
 * data it already has), so there is no iframe here — this file is only the phone.
 *
 *   interactive=false (default) → READ-ONLY cards. No script. Byte-compat.
 *   interactive=true            → COPY-PASTE (Annie's locked control model): each
 *                                 direct flag gets a checkbox; a nonce'd script
 *                                 builds the `flywheel-comm feature-flags apply …`
 *                                 commands into a copy textarea — ZERO network
 *                                 callback (served under `default-src 'none'`).
 *                                 Annie copies → pastes to a Lead → the Lead runs it.
 */

import type { FlagView } from "flywheel-config";
import {
	esc,
	FEATURE_FLAG_CSS,
	renderFeatureFlagsHtml,
} from "./feature-flag-render.js";
import { APPLY_COMMAND_JS } from "./fleet-apply-command.js";
import type { ConsoleSnapshot } from "./fleet-console-model.js";

/**
 * FLY-709 P4: the report input — the console snapshot (or any subset of it).
 * A plain FlagView[] is also accepted for backward compatibility with the
 * flags-only report shape.
 */
export type FlagReportData = FlagView[] | ConsoleSnapshot;

export interface FlagReportOptions {
	/** false/undefined = read-only cards; true = the phone copy-paste page. */
	interactive?: boolean;
	/** Optional generated-at label (pass in; the renderer stays pure/deterministic). */
	generatedAt?: string;
}

const BASE_CSS = `
body{font-family:-apple-system,system-ui,sans-serif;background:#f5f5f7;color:#1d1d1f;margin:0;padding:16px}
.wrap{max-width:960px;margin:0 auto}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px 18px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#86868b;font-size:13px;margin:0 0 8px}
.note{color:#86868b;font-size:12px;margin-top:12px;line-height:1.5}
.ff-copy{width:100%;box-sizing:border-box;margin-top:12px;border:1px solid #d5d5da;border-radius:8px;
  padding:8px;font-family:'SF Mono',monospace;font-size:12px;background:#fff;color:#1d1d1f;resize:vertical}
.ff-copy-bar{display:flex;align-items:center;gap:10px;margin-top:8px}
.ff-copy-n{color:#86868b;font-size:12px}
.ff-copy-btn{margin-left:auto;border:none;background:#1a365d;color:#fff;border-radius:8px;
  padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
h2.ff-sec{font-size:16px;margin:18px 0 8px}
.cfg-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f0f0f2;
  flex-wrap:wrap;font-size:13px}
.cfg-row:last-child{border-bottom:none}
.cfg-name{font-weight:650;min-width:120px}
.cfg-dim{color:#86868b;font-size:12px}
.cfg-row select{border:1px solid #d5d5da;border-radius:8px;background:#fff;color:#1d1d1f;
  font-family:inherit;font-size:13px;padding:3px 6px;max-width:190px}
.cfg-note{color:#86868b;font-size:12px;margin:6px 0 0;line-height:1.5}
`;

/** The phone copy-paste surface (textarea + copy button + nonce'd script). */
function copyPasteSurface(): string {
	// Opt-in nonce'd script (report-registry mints the real nonce + a matching
	// `script-src 'nonce-…'` CSP at serve time). CSP `default-src 'none'` blocks
	// ALL network — this script only reads checkboxes + builds copy text locally.
	const script = [
		'<script nonce="__CSP_NONCE__">',
		APPLY_COMMAND_JS,
		"(function(){",
		"  function q(id){return document.getElementById(id);}",
		'  var boxes=document.querySelectorAll("[data-ff-toggle]");',
		'  var out=q("ffCopyText"), count=q("ffCount");',
		"  var page=document.body;",
		'  var fleetScript=page.getAttribute("data-fleet-script")||"";',
		'  var commCli=page.getAttribute("data-comm-cli")||"";',
		"  function selDiffs(group){",
		"    // group: lead key / project / cron index — selects carry data-current.",
		"    var sels=document.querySelectorAll('[data-cfg-group=\"'+group+'\"]');",
		"    var change={}, any=false;",
		"    for (var i=0;i<sels.length;i++){",
		"      var sel=sels[i];",
		'      if (sel.value===sel.getAttribute("data-current")) continue;',
		'      change[sel.getAttribute("data-cfg-kind")] = sel.value==="__default__" ? null : sel.value;',
		"      any=true;",
		"    }",
		"    return any?change:null;",
		"  }",
		"  function rebuild(){",
		"    var lines=[];",
		"    for (var i=0;i<boxes.length;i++){",
		"      var b=boxes[i];",
		"      if (b.checked){",
		'        var name=b.getAttribute("data-ff-name");',
		'        var to=b.getAttribute("data-ff-to");',
		'        lines.push("flywheel-comm feature-flags apply --name "+name+" --to "+to+" --reason phone-report");',
		"      }",
		"    }",
		"    // FLY-1356: enum direct flags (skill_framework_mode) — a changed",
		"    // dropdown becomes an apply line with the target value.",
		'    var enumSels=document.querySelectorAll("[data-ff-enum]");',
		"    for (var i=0;i<enumSels.length;i++){",
		"      var s=enumSels[i];",
		'      if (s.value!==s.getAttribute("data-current")){',
		'        lines.push("flywheel-comm feature-flags apply --name "+s.getAttribute("data-ff-name")+" --to "+s.value+" --reason phone-report");',
		"      }",
		"    }",
		"    // FLY-709 P4: Lead model/effort/backend rows → fleet apply lines.",
		'    var leadRows=document.querySelectorAll("[data-lead-row]");',
		"    var leadChanges=[];",
		"    for (var i=0;i<leadRows.length;i++){",
		'      var key=leadRows[i].getAttribute("data-lead-row");',
		"      var d=selDiffs(key);",
		"      if(!d) continue;",
		"      var ch={key:key};",
		"      if (d.model!==undefined) ch.toModel=d.model;",
		"      if (d.effort!==undefined) ch.toEffort=d.effort;",
		'      if (d.backend!==undefined) ch.backendNote={from:leadRows[i].getAttribute("data-lead-backend"), to:d.backend===null?"claude-code":d.backend};',
		"      leadChanges.push(ch);",
		"    }",
		'    if (leadChanges.length){ var lt=FleetCmd.leadCommands(fleetScript, leadChanges); if(lt) lines=lines.concat(lt.split("\\n")); }',
		"    // Runner defaults + cron rows → runner-config apply lines.",
		'    var rrRows=document.querySelectorAll("[data-runner-row]");',
		"    for (var i=0;i<rrRows.length;i++){",
		'      var proj=rrRows[i].getAttribute("data-runner-row");',
		'      var rd=selDiffs("rr:"+proj);',
		"      if(!rd) continue;",
		"      var cmd=FleetCmd.runnerCommand(commCli, proj, rd);",
		"      if(cmd) lines.push(cmd);",
		"    }",
		'    var cronRows=document.querySelectorAll("[data-cron-row]");',
		"    for (var i=0;i<cronRows.length;i++){",
		'      var cidx=cronRows[i].getAttribute("data-cron-row");',
		'      var cd=selDiffs("cron:"+cidx);',
		"      if(!cd) continue;",
		'      var ccmd=FleetCmd.runnerCommand(commCli, cronRows[i].getAttribute("data-cron-project"), cd, cronRows[i].getAttribute("data-cron-id"));',
		"      if(ccmd) lines.push(ccmd);",
		"    }",
		'    if(out) out.value=lines.join("\\n");',
		"    if(count) count.textContent=String(lines.length);",
		"  }",
		'  for (var i=0;i<boxes.length;i++){ boxes[i].addEventListener("change", rebuild); }',
		'  var enumCtls=document.querySelectorAll("[data-ff-enum]");',
		'  for (var i=0;i<enumCtls.length;i++){ enumCtls[i].addEventListener("change", rebuild); }',
		'  var cfgSels=document.querySelectorAll("[data-cfg-group]");',
		'  for (var i=0;i<cfgSels.length;i++){ cfgSels[i].addEventListener("change", rebuild); }',
		'  var copyBtn=q("ffCopyBtn");',
		"  if (copyBtn){",
		'    copyBtn.addEventListener("click", function(){',
		"      if(!out) return;",
		"      out.focus(); out.select();",
		"      var ok=false;",
		'      try{ ok=document.execCommand("copy"); }catch(e){}',
		"      if(!ok && navigator.clipboard){ navigator.clipboard.writeText(out.value); }",
		'      copyBtn.textContent="已复制 ✓";',
		'      setTimeout(function(){ copyBtn.textContent="复制给 Lead"; }, 1500);',
		"    });",
		"  }",
		"  rebuild();",
		"})();",
		"</script>",
	].join("\n");
	return [
		'<div class="card">',
		'<div class="sub">勾选要改的热 flag → 复制下面的命令粘给 Lead 执行（页面本身不改任何东西）。</div>',
		'<textarea id="ffCopyText" class="ff-copy" readonly rows="4" placeholder="勾选上面的 flag，这里会生成要粘给 Lead 的命令"></textarea>',
		'<div class="ff-copy-bar"><span class="ff-copy-n"><b id="ffCount">0</b> 条命令</span>',
		'<button type="button" id="ffCopyBtn" class="ff-copy-btn">复制给 Lead</button></div>',
		"</div>",
		script,
	].join("\n");
}

/** A <select> row cell: value "__default__" = null (remove override). */
function cfgSelect(
	group: string,
	kind: string,
	current: string | null,
	options: ReadonlyArray<{ value: string; label: string }>,
	defLabel: string,
): string {
	const cur = current === null ? "__default__" : current;
	const opts = [
		`<option value="__default__"${cur === "__default__" ? " selected" : ""}>${esc(defLabel)}</option>`,
		...options.map(
			(o) =>
				`<option value="${esc(o.value)}"${cur === o.value ? " selected" : ""}>${esc(o.label)}</option>`,
		),
	].join("");
	return `<select data-cfg-group="${esc(group)}" data-cfg-kind="${esc(kind)}" data-current="${esc(cur)}">${opts}</select>`;
}

const LEAD_BACKEND_LABELS: Record<string, string> = {
	"claude-code": "Claude Code",
	"codex-app-server": "Codex",
};

/** FLY-709 P4: interactive Lead model/effort/backend rows (copy-paste only). */
function leadConfigSection(leads: ConsoleSnapshot["leads"]): string {
	if (!leads.length) return "";
	const rows = leads
		.map((l) => {
			const tierOpts = l.tierOptions
				.filter((t) => t.id !== null)
				.map((t) => ({ value: String(t.id), label: t.label }));
			const effortOpts = (l.effortOptions ?? [])
				.filter((t) => t.id !== null)
				.map((t) => ({ value: String(t.id), label: t.label }));
			const backendOpts = l.backendOptions.map((b) => ({
				value: b.backend,
				label: LEAD_BACKEND_LABELS[b.backend] ?? b.backend,
			}));
			return [
				`<div class="cfg-row" data-lead-row="${esc(l.key)}" data-lead-backend="${esc(l.currentBackend)}">`,
				`<span class="cfg-name">${esc(l.displayName)}<br><span class="cfg-dim">${esc(l.projectName)}</span></span>`,
				cfgSelect(l.key, "backend", l.currentBackend, backendOpts, "(当前)"),
				cfgSelect(l.key, "model", l.currentModelId, tierOpts, "Account 默认"),
				cfgSelect(l.key, "effort", l.currentEffort, effortOpts, "默认"),
				"</div>",
			].join("");
		})
		.join("\n");
	return [
		'<div class="card">',
		'<h2 class="ff-sec">👥 Lead 模型 / Effort / 后端</h2>',
		rows,
		'<p class="cfg-note">改动会生成 fleet apply 命令进下面的复制框。后端切换不能自动 apply —— 会生成「需人工 cutover」说明（受管切换 = FLY-264 未做）。Antigravity / Kimi 仅存在于 runner 层（见下方 Runner 默认区）。</p>',
		"</div>",
	].join("\n");
}

/** FLY-709 P4.3/P4.4: runner-default + cron rows (runner-config apply). */
function runnerCronSections(snap: ConsoleSnapshot): string {
	const caps = snap.runnerCapabilities;
	if (!caps) return "";
	const asOpts = (xs: readonly string[]) =>
		xs.map((x) => ({ value: x, label: x }));
	const parts: string[] = [];
	const runners = snap.projectRunnerDefaults ?? [];
	if (runners.length) {
		const rows = runners
			.map((r) =>
				r.error
					? `<div class="cfg-row"><span class="cfg-name">${esc(r.projectName)}</span><span class="cfg-dim">配置错误: ${esc(r.error)}</span></div>`
					: [
							`<div class="cfg-row" data-runner-row="${esc(r.projectName)}">`,
							`<span class="cfg-name">${esc(r.projectName)}</span>`,
							cfgSelect(
								`rr:${r.projectName}`,
								"backend",
								r.backend,
								asOpts(caps.backends),
								"默认 (claude-tmux)",
							),
							cfgSelect(
								`rr:${r.projectName}`,
								"model",
								r.model,
								asOpts(caps.models),
								"账户默认",
							),
							cfgSelect(
								`rr:${r.projectName}`,
								"effort",
								r.effort,
								asOpts(caps.efforts),
								"默认",
							),
							"</div>",
						].join(""),
			)
			.join("\n");
		parts.push(
			'<div class="card">',
			'<h2 class="ff-sec">🤖 Runner 默认（per-项目 roles.runner）</h2>',
			rows,
			'<p class="cfg-note">生成 runner-config apply 命令；写项目 config.yaml，对新 run 热生效。effort 仅 claude-tmux 支持（写入端强制）。</p>',
			"</div>",
		);
	}
	const crons = snap.cronModels ?? [];
	if (crons.length) {
		const rows = crons
			.map((c, i) =>
				[
					`<div class="cfg-row" data-cron-row="${i}" data-cron-project="${esc(c.projectName)}" data-cron-id="${esc(c.collectionId)}">`,
					`<span class="cfg-name">${esc(c.label)}<br><span class="cfg-dim">${esc(c.projectName)} · ${esc(c.leadId)}</span></span>`,
					cfgSelect(
						`cron:${i}`,
						"model",
						c.model,
						asOpts(caps.models),
						"默认(项目/账户)",
					),
					"</div>",
				].join(""),
			)
			.join("\n");
		parts.push(
			'<div class="card">',
			'<h2 class="ff-sec">⏰ Cron 每日任务模型</h2>',
			rows,
			'<p class="cfg-note">每日重复 issue（如小红书学习）的 runner 模型；生成带 --cron 的 runner-config apply 命令。</p>',
			"</div>",
		);
	}
	return parts.join("\n");
}

/** Render the full standalone feature-flag report document (Apple-light cards). */
export function renderFlagReport(
	data: FlagReportData,
	opts: FlagReportOptions = {},
): string {
	const snap: ConsoleSnapshot = Array.isArray(data)
		? { leads: [], featureFlags: data }
		: data;
	const flags = snap.featureFlags ?? [];
	const interactive = opts.interactive === true;
	const genLine = opts.generatedAt
		? `<p class="sub">生成于 ${esc(opts.generatedAt)}</p>`
		: "";
	const subCopy = interactive
		? "Flywheel fleet 控制台 —— 勾/选要改的项，复制命令粘给 Lead 执行。"
		: "Flywheel 全部 feature flag 的当前状态（只读）。";
	const bodyAttrs = interactive
		? ` data-fleet-script="${esc(snap.fleetScriptPath ?? "")}" data-comm-cli="${esc(snap.commCliPath ?? "")}"`
		: "";
	return [
		"<!doctype html>",
		'<html lang="zh"><head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>Flywheel Feature Flags</title>",
		`<style>${BASE_CSS}${FEATURE_FLAG_CSS}</style>`,
		`</head><body${bodyAttrs}><div class="wrap">`,
		'<div class="card">',
		"<h1>Fleet 控制台</h1>",
		`<p class="sub">${subCopy}</p>`,
		genLine,
		'<p class="note">治理门（如 founder-consent）与 dormant 项只读，永不在此 toggle。生效路径：热生效=改后即生效；需重启=改 .env 后要重启 Bridge；新 run 生效=改项目 config 对新 run 生效。</p>',
		"</div>",
		interactive ? leadConfigSection(snap.leads) : "",
		interactive ? runnerCronSections(snap) : "",
		renderFeatureFlagsHtml(flags, interactive ? "phone" : "none"),
		interactive ? copyPasteSurface() : "",
		"</div></body></html>",
	].join("\n");
}
