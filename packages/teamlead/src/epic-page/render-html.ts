import { createHash } from "node:crypto";
import { escapeHtml } from "../bridge/xhs-review-html.js";
import {
	attentionActionText,
	attentionAudience,
	attentionLink,
	attentionMissing,
	attentionPublicKey,
	attentionSourceText,
	attentionSummary,
	attentionWait,
} from "./attention-presentation.js";
import { AuditDictionary, judgmentSummary } from "./audit-dictionary.js";
import { AuditSidecar } from "./audit-sidecar.js";
import { renderDiscordLinkPair } from "./discord-link.js";
import {
	buildFounderView,
	type ChildView,
	type EpicView,
	type ViewProvenance,
} from "./founder-view.js";
import { epicIntakeStatus } from "./intake.js";
import { type LabelKey, label, leadNoteRoleLabel } from "./labels.js";
import { DEFAULT_LEAD_NOTE_FADE_DAYS, leadNoteAge } from "./lead-note.js";
import type { Cell, EpicItem, EpicPage, Provenance } from "./model.js";

export interface EpicOptionalRows {
	judgmentRows?: number;
	historyRows?: number;
}

const DISCORD_LINK_UPGRADE_SCRIPT =
	'(()=>{let u=navigator.userAgent;if(/Android|iP|Mobile/i.test(u)||u.includes("Macintosh")&&navigator.maxTouchPoints>1||!/(Chrome|Safari)\\//.test(u))return;for(let a of document.querySelectorAll("[data-discord-app]"))a.href=a.href.replace("https://discord.com/channels/","discord://-/channels/")})();';

class RenderAudit extends AuditDictionary {
	appendix: string[] = [];
	judgmentCount = 0;
	omittedJudgments = 0;
	constructor(
		readonly sidecar?: AuditSidecar,
		readonly limits: EpicOptionalRows = {},
	) {
		super();
	}
}
function compactAudit(
	audit: AuditSidecar,
	value: unknown,
	observed: string,
): string {
	return `<span data-audit-ref="${audit.add(value)}">出处 #${audit.add(value)} · ${escapeHtml(observed)}</span>`;
}
function auditFooter(audit: AuditSidecar): string {
	const json = audit.json();
	const hash = createHash("sha256").update(json).digest("hex");
	return `<footer id="epic-audit">审计出处：<a href="${hash}/index.audit.json">完整出处</a> · SHA-256 ${hash} · ${audit.count} 条 · ${Buffer.byteLength(json)} B</footer>`;
}

const FOUNDER_DECIDED_RULES = new Set([
	"scope.v2",
	"scope.v3",
	"counts.v1",
	"ready.v1",
	"dependents.v1",
]);
const SHUTTLE_CYCLE_MS = 12 * 60 * 60_000;

function relativeTime(iso: string, now: Date): string {
	const minutes = Math.max(
		0,
		Math.floor((now.getTime() - Date.parse(iso)) / 60_000),
	);
	return label("time.minutes_ago", { n: minutes });
}

function shuttleDriftAge(driftSince: string | null, now: Date): string {
	if (driftSince === null) return "落后时间未知";
	const hours = Math.max(
		0,
		Math.floor((now.getTime() - Date.parse(driftSince)) / 3_600_000),
	);
	return `已确认至少落后 ${hours} 小时`;
}

function shuttleSourceIsStale(observedAt: string | null, now: Date): boolean {
	return (
		observedAt === null ||
		now.getTime() - Date.parse(observedAt) > SHUTTLE_CYCLE_MS
	);
}

function rawCellValue(cell: Cell<unknown>): unknown {
	return cell.value === null
		? `${cell.missing?.reason ?? label("cell.missing")}${
				cell.missing?.detail ? `:${cell.missing.detail}` : ""
			}`
		: cell.value;
}

function htmlValue(value: unknown): string {
	return escapeHtml(typeof value === "string" ? value : JSON.stringify(value));
}

function safeLinearLink(url: string, text: string): string {
	const match =
		/^https:\/\/linear\.app\/([^/?#]+)\/issue\/([A-Za-z]+-\d+)(?:[/?#]|$)/.exec(
			url,
		);
	return match
		? `<a href="https://linear.app/${escapeHtml(match[1]!)}/issue/${escapeHtml(match[2]!)}">${escapeHtml(text)}</a>`
		: escapeHtml(text);
}

function htmlProvenance(provenance: Provenance): string {
	if (provenance.kind === "lead_note")
		return escapeHtml(`${provenance.role} · ${provenance.written_at}`);
	if (provenance.kind === "linear") {
		const text = [
			label("cell.linear"),
			`${provenance.entity}:${provenance.id}`,
			provenance.field,
		]
			.filter(Boolean)
			.join(" · ");
		return provenance.url
			? `${escapeHtml(text)} · ${safeLinearLink(provenance.url, provenance.url)}`
			: escapeHtml(text);
	}
	if (provenance.kind === "statestore" || provenance.kind === "commdb") {
		return escapeHtml(
			`${provenance.table} · ${JSON.stringify(provenance.key)}`,
		);
	}
	return escapeHtml(
		`${provenance.rule} · ${label("cell.derived_from", {
			from: provenance.from.join(", ") || "[]",
		})}`,
	);
}

function derivedRuleNote(provenance: Provenance): string {
	if (provenance.kind !== "derived") return "";
	const ruling = FOUNDER_DECIDED_RULES.has(provenance.rule)
		? label("page.decided_rule_note", { rule: provenance.rule })
		: label("page.default_rule_note", { rule: provenance.rule });
	return `${escapeHtml(ruling)} · ${escapeHtml(
		label("cell.derived_from", {
			from: provenance.from.join(", ") || "[]",
		}),
	)}`;
}

function renderAuditCell(
	path: string,
	name: LabelKey,
	cell: Cell<unknown>,
	now: Date,
	dictionary: RenderAudit,
): string {
	if (dictionary.sidecar)
		return `<div class="audit-cell" data-cell="${escapeHtml(path)}" data-audit="${dictionary.sidecar.add(cell)}"><b>${escapeHtml(label(name))}</b>${compactAudit(dictionary.sidecar, cell, cell.observed_at)}</div>`;
	return `<div class="audit-cell" data-cell="${escapeHtml(path)}">
	<b>${escapeHtml(label(name))}:</b> <code>${htmlValue(rawCellValue(cell))}</code>
	<span>${escapeHtml(label("cell.provenance"))}: ${htmlProvenance(cell.provenance)}</span>
	<span>${escapeHtml(label("cell.observed_at"))}: ${escapeHtml(cell.observed_at)} (${escapeHtml(relativeTime(cell.observed_at, now))})</span>
	${cell.source_updated_at ? `<span>${escapeHtml(label("cell.source_updated_at"))}: ${escapeHtml(cell.source_updated_at)} (${escapeHtml(relativeTime(cell.source_updated_at, now))})</span>` : ""}
	${cell.provenance.kind === "derived" ? `<span class="rule-note">${derivedRuleNote(cell.provenance)}</span>` : ""}
</div>`;
}

function itemCells(
	item: EpicItem,
): Array<[field: string, name: LabelKey, cell: Cell<unknown>]> {
	return [
		["parent", "cell.item.parent", item.parent],
		["title", "cell.item.title", item.title],
		["url", "cell.item.url", item.url],
		["state", "cell.item.state", item.state],
		["priority", "cell.item.priority", item.priority],
		["blocked_by", "cell.item.blocked_by", item.blocked_by],
		["blocks", "cell.item.blocks", item.blocks],
		["acceptance", "cell.item.acceptance", item.acceptance],
		["founder_named", "cell.item.founder_named", item.founder_named],
		["session", "cell.item.session", item.session],
		["run", "cell.item.run", item.run],
		["attempt", "cell.item.attempt", item.attempt],
		["gates", "cell.item.gates", item.gates],
		["carriers", "cell.item.carriers", item.carriers],
		["land", "cell.item.land", item.land],
	];
}

function executionSummary(item: EpicItem): string {
	const missing = [
		item.session,
		item.run,
		item.attempt,
		item.gates,
		item.carriers,
		item.land,
	].filter((cell) => cell.value === null);
	if (missing.length > 0) {
		return `${label("cell.missing")}: ${missing
			.map((cell) => cell.missing?.reason ?? label("cell.missing"))
			.join(", ")}`;
	}

	const session = item.session.value;
	const latest = session?.latest[0];
	const run = item.run.value?.[0];
	const attempt = item.attempt.value?.[0];
	const land = item.land.value?.[0];
	const parts = [
		latest
			? `${latest.status}/${latest.role ?? ""}(${latest.execution_id8})`
			: label("page.none"),
		`ledger_live_count=${session?.ledger_live_count ?? 0}`,
		`machine_running_count=${session?.machine_running_count ?? 0}`,
	];
	if (run) parts.push(`${run.current_node_label}/${run.status}`);
	if (attempt) parts.push(`${attempt.state}#${attempt.attempt}`);
	if ((item.gates.value?.length ?? 0) > 0)
		parts.push(`${label("cell.item.gates")}:${item.gates.value?.length}`);
	if ((item.carriers.value?.length ?? 0) > 0)
		parts.push(`${label("cell.item.carriers")}:${item.carriers.value?.length}`);
	if (land) parts.push(`PR #${land.pr_number}/${land.state}`);
	return parts.join(" · ");
}

function acceptanceSummary(item: EpicItem): string {
	if (!item.acceptance.value) return label("page.missing_acceptance");
	const compact = item.acceptance.value.text.trim().replace(/\s+/g, " ");
	const characters = [...compact];
	return characters.length > 240
		? `${characters.slice(0, 239).join("")}…`
		: compact;
}

function renderViewRule(view: ViewProvenance, dictionary: RenderAudit): string {
	if (dictionary.sidecar)
		return `<div class="view-rule" data-view-rule="${view.rule}" data-audit="${dictionary.sidecar.add(view)}">${escapeHtml(view.rule)} · ${compactAudit(dictionary.sidecar, view, view.observedAt)}</div>`;
	return `<div class="view-rule" data-view-rule="${view.rule}" data-view-from="${escapeHtml(view.from.join(","))}" data-view-observed="${escapeHtml(view.observedAt)}">${escapeHtml(label("view.rule_note", { rule: view.rule, from: view.from.join(", "), at: view.observedAt }))}</div>`;
}

function blockersText(child: ChildView): string {
	const entries = child.blockers.map(
		(b) =>
			b.identifier +
			(b.where === "outside"
				? label("blocker.outside")
				: b.where === "other_epic"
					? b.otherRoot
						? label("blocker.other_epic", { root: b.otherRoot })
						: label("blocker.unattached")
					: ""),
	);
	return (
		entries.slice(0, 3).join(" / ") +
		(entries.length > 3 ? label("blocker.more", { n: entries.length }) : "")
	);
}
function childBadge(child: ChildView): string {
	if (child.cls === "free") return label("child.idle");
	if (child.cls === "waiting")
		return label("child.waiting", { blockers: blockersText(child) });
	if (child.cls === null)
		return label("child.unknown_type", { state: child.stateName });
	if (child.cls === "done" || child.cls === "canceled") return child.stateName;
	if (
		child.cls === "stopped_stuck" &&
		child.progress.kind === "stopped_stuck" &&
		child.progress.reason === "no_first_heartbeat"
	)
		return label("child.stopped_stuck_no_heartbeat");
	if (
		child.cls === "evidence_gap" &&
		child.progress.kind === "evidence_gap" &&
		child.progress.reason === "awaiting_first_heartbeat"
	)
		return label("child.evidence_starting");
	return label(`child.${child.cls}`);
}
function progressText(child: ChildView): string {
	if (child.cls === "free") return label("progress.idle");
	const value = child.progress;
	if (value.kind === "live")
		return label("progress.live", {
			node: value.node,
			attempt: value.attempt ?? label("progress.unknown"),
			status: value.status ?? label("progress.unknown"),
		});
	if (value.kind === "missing")
		return label("progress.missing", { reasons: value.reasons.join(", ") });
	if (value.kind === "waiting" || value.kind === "free")
		return label(`progress.${value.kind}`, {
			blockers: value.blockers.join(" / "),
		});
	if (value.kind === "evidence_gap")
		return label(`progress.evidence_gap.${value.reason}`);
	if (
		value.kind === "stopped_acceptance" &&
		value.reason === "other_live_session"
	)
		return label("progress.stopped_acceptance_other_live_session");
	if (value.kind === "stopped_stuck" && value.reason === "run_held")
		return label(
			value.otherLiveSession
				? "progress.stopped_stuck.run_held_other_live_session"
				: "progress.stopped_stuck.run_held",
		);
	if (value.kind === "stopped_stuck" && value.reason === "declared_blocked")
		return label(
			value.otherLiveSession
				? "progress.stopped_stuck.declared_blocked_other_live_session"
				: "progress.stopped_stuck.declared_blocked",
		);
	if (value.kind === "stopped_stuck" && value.reason === "runner_stopped")
		return label(
			value.otherLiveSession
				? "progress.stopped_stuck.runner_stopped_other_live_session"
				: "progress.stopped_stuck.runner_stopped",
		);
	if (value.kind === "stopped_stuck" && value.reason === "no_first_heartbeat")
		return label("progress.stopped_stuck_no_heartbeat");
	return label(`progress.${value.kind}`);
}
function renderDependencyAudit(
	entries: Array<{ identifier: string; title: string }>,
	dictionary: RenderAudit,
): string {
	return entries.length
		? entries
				.map((entry) => {
					const chars = [...entry.title];
					const short =
						chars.length > 40 ? `${chars.slice(0, 39).join("")}…` : entry.title;
					return `<span data-fulltext="${dictionary.text(entry.title)}">${escapeHtml(entry.identifier)} · <span class="dep-title">${escapeHtml(short)}</span></span>`;
				})
				.join("; ")
		: "[]";
}
function renderChildAudit(
	item: EpicItem,
	child: ChildView,
	dictionary: RenderAudit,
): string {
	if (dictionary.sidecar) {
		const id = dictionary.sidecar.add(item);
		const viewId = dictionary.sidecar.add({
			progress: child.progress.view,
			blockerScope: child.blockerScope,
		});
		return `<p class="audit" data-item-audit="${id}" data-view-audit="${viewId}"><a href="#epic-audit">${escapeHtml(label("cell.provenance"))} #${id}</a></p>`;
	}
	const cells = itemCells(item)
		.map(([field, name, cell]) => {
			if (dictionary.sidecar)
				return `<div class="audit-cell" data-cell="/items/${child.itemIndex}/${field}" data-audit="${dictionary.sidecar.add(cell)}"><b>${escapeHtml(label(name))}</b>${compactAudit(dictionary.sidecar, cell, cell.observed_at)}</div>`;
			const value =
				field === "acceptance" && cell.value !== null
					? acceptanceSummary(item)
					: rawCellValue(cell);
			const content =
				field === "blocked_by" && item.blocked_by.value
					? renderDependencyAudit(item.blocked_by.value, dictionary)
					: field === "blocks" && item.blocks.value
						? renderDependencyAudit(item.blocks.value, dictionary)
						: htmlValue(value);
			const link =
				field === "acceptance" && item.url.value
					? safeLinearLink(item.url.value, label("audit.acceptance_source"))
					: "";
			return `<div class="audit-cell" data-cell="/items/${child.itemIndex}/${field}" data-src="${dictionary.add(cell)}"><b>${escapeHtml(label(name))}</b><code>${content}</code>${link}</div>`;
		})
		.join("");
	return `<details class="audit"><summary>${escapeHtml(label("page.all_cells", { count: 15 }))}</summary><div class="audit-head">${item.url.value ? safeLinearLink(item.url.value, item.url.value) : ""} · ${escapeHtml(executionSummary(item))}</div><div class="audit-list">${cells}</div>${child.blockerScope ? renderViewRule(child.blockerScope, dictionary) : ""}${renderViewRule(child.progress.view, dictionary)}</details>`;
}
function renderJudgment(item: EpicItem, dictionary: RenderAudit): string {
	const cell = item.ship_judgment;
	if (!cell) return "";
	const summary = escapeHtml(judgmentSummary(cell));
	if (dictionary.sidecar) {
		const id = dictionary.sidecar.add(cell);
		if (
			dictionary.judgmentCount++ >= (dictionary.limits.judgmentRows ?? Infinity)
		) {
			dictionary.omittedJudgments++;
			return "";
		}
		return `<div data-judgment>${summary} <a href="__EPIC_JUDGMENT_AUDIT__#${id}">依据 #${id}</a></div>`;
	}
	return `<details data-judgment data-src="${dictionary.add(cell)}"><summary>${summary}</summary><code>${htmlValue(cell)}</code></details>`;
}
function renderJudgmentHistory(
	page: EpicPage,
	dictionary: RenderAudit,
): string {
	const cell = page.ship_judgment_history;
	if (!cell) return "";
	dictionary.sidecar?.add(cell);
	return "<footer data-history-on-demand><strong>机器试判历史按需生成</strong>：需要查看时，由 Lead 运行 <code>flywheel-comm ship-judgment-history render</code>。</footer>";
}
function renderLeadNotes(
	notes: Cell<string>[] | undefined,
	now: Date,
	fadeDays: number,
): string {
	return (notes ?? [])
		.map((note) => {
			if (note.provenance.kind !== "lead_note")
				throw new Error("invalid lead-note provenance");
			const { role, written_at } = note.provenance;
			const age = leadNoteAge(written_at, now, fadeDays);
			const roleLabel = leadNoteRoleLabel(role);
			return `<div class="leadnote${age.stale ? " lead-note-stale" : ""}" data-lead-written-at="${escapeHtml(written_at)}" data-lead-role="${escapeHtml(roleLabel)}" data-lead-fade-days="${fadeDays}"><b>💬 判断</b><div class="ln-body" title="${escapeHtml(note.value ?? "")}">${escapeHtml(note.value ?? "")}</div><div class="ln-meta"><span data-lead-relative>${escapeHtml(roleLabel)} · ${escapeHtml(age.relative)}</span><span data-lead-stale${age.stale ? "" : " hidden"}> · ${escapeHtml(label("lead_note.stale"))}</span><time hidden datetime="${escapeHtml(written_at)}">${escapeHtml(written_at)}</time><small hidden>${escapeHtml(label("lead_note.disclosure"))}</small></div></div>`;
		})
		.join("");
}

function renderChild(
	page: EpicPage,
	child: ChildView,
	dictionary: RenderAudit,
	now: Date,
): string {
	const item = page.items[child.itemIndex]!;
	dictionary.appendix.push(
		renderChildAudit(item, child, dictionary) +
			renderJudgment(item, dictionary) +
			renderLeadNotes(
				item.lead_note,
				now,
				page.lead_note_policy?.value?.fade_after_days ??
					DEFAULT_LEAD_NOTE_FADE_DAYS,
			),
	);
	const url = item.thread_url?.value;
	const thread = url
		? renderDiscordLinkPair(url, "跳 Discord ↗", "jump", child.identifier) ||
			`<span class="jump-off">Discord 链接不可用</span>`
		: `<span class="jump-off">这张单还没有 thread</span>`;
	const liveBlockers =
		child.cls === "live" && child.blockers.length > 0
			? `<span class="s s-blocked">${escapeHtml(label("child.waiting", { blockers: blockersText(child) }))}</span>`
			: "";
	return `<div class="kid" data-item="${escapeHtml(child.identifier)}" data-class="${child.cls ?? "unknown"}"><div class="kid-h"><span class="s s-${child.cls ?? "unknown"}">${escapeHtml(childBadge(child))}</span>${liveBlockers}<span class="s st-linear">${escapeHtml(child.stateName)}</span><span class="kid-id mono">${child.url ? safeLinearLink(child.url, child.identifier) : escapeHtml(child.identifier)}</span><span class="kid-t">${escapeHtml(child.title)}</span></div><div class="kid-a">↳ ${escapeHtml(progressText(child))} · ${thread}</div></div>`;
}

function shortEpicTitle(title: string): string {
	const withoutPrefix = title.replace(/^\[[^\]]*\]\s*/, "").trim() || title;
	const chars = [...withoutPrefix];
	return chars.length > 32 ? `${chars.slice(0, 31).join("")}…` : withoutPrefix;
}

function countsText(epic: EpicView): string {
	if (!epic.counts)
		return label("counts.missing", {
			type: epic.countsMissing?.detail ?? label("progress.unknown"),
		});
	return `${epic.counts.live} 在跑 · ${epic.counts.stopped_acceptance + epic.counts.stopped_stuck} 停着 · ${epic.counts.evidence_gap} 说不准 · ${epic.counts.waiting + epic.counts.free + epic.counts.idle} 未开始 · 共 ${epic.counts.total}`;
}
function renderRootProjection(
	page: EpicPage,
	epic: EpicView,
	dictionary: RenderAudit,
): string {
	const cell = page.header.roots;
	if (dictionary.sidecar)
		return `<div class="audit-cell" data-source-cell="/header/roots" data-source-value="/header/roots/value/${epic.rootIndex}" data-audit="${dictionary.sidecar.add(cell)}">${escapeHtml(epic.identifier)} · ${compactAudit(dictionary.sidecar, cell, cell.observed_at)}</div>`;
	return `<div class="audit-cell" data-source-cell="/header/roots" data-source-value="/header/roots/value/${epic.rootIndex}"><b>${escapeHtml(label("audit.root_projection"))}</b><span>${safeLinearLink(epic.url, epic.identifier)} · ${escapeHtml(epic.title)} · ${escapeHtml(epic.state.name)}</span><span>${htmlProvenance(cell.provenance)}</span><span>${escapeHtml(cell.observed_at)}</span>${cell.source_updated_at ? `<span>${escapeHtml(cell.source_updated_at)}</span>` : ""}</div>`;
}
function renderEpic(
	page: EpicPage,
	epic: EpicView,
	now: Date,
	dictionary: RenderAudit,
): string {
	const notes = page.header.roots.value?.[epic.rootIndex]?.lead_note;
	const fadeDays =
		page.lead_note_policy?.value?.fade_after_days ??
		DEFAULT_LEAD_NOTE_FADE_DAYS;
	const terminal = [
		epic.terminal.done ? label("terminal.done", { n: epic.terminal.done }) : "",
		epic.terminal.canceled
			? label("terminal.canceled", { n: epic.terminal.canceled })
			: "",
	]
		.filter(Boolean)
		.join(" · ");
	const rootAudit = dictionary.sidecar
		? `<div class="audit" data-root-audit="${dictionary.sidecar.add({
				root: page.header.roots.value?.[epic.rootIndex],
				counts: page.header.root_counts[epic.rootIndex],
				waiting: epic.allWaitingOn,
				terminal: epic.terminal,
			})}"><a href="#epic-audit">${escapeHtml(label("cell.provenance"))}</a></div>`
		: `<details class="audit"><summary>${escapeHtml(label("cell.provenance"))}</summary>${renderRootProjection(page, epic, dictionary)}${renderAuditCell(`/header/root_counts/${epic.rootIndex}`, "cell.header.root_counts", page.header.root_counts[epic.rootIndex]!, now, dictionary)}${epic.allWaitingOn ? renderViewRule(epic.allWaitingOn.view, dictionary) : ""}${epic.terminal.view ? renderViewRule(epic.terminal.view, dictionary) : ""}</details>`;
	dictionary.appendix.push(rootAudit);
	const judgment =
		renderLeadNotes(notes, now, fadeDays) ||
		`<div class="leadnote"><b>💬 判断</b><div class="ln-body">还没有人写过</div></div>`;
	return `<details class="epic ${epic.counts?.live ? "e-live" : "e-idle"}" data-root="${escapeHtml(epic.identifier)}" data-state-type="${escapeHtml(epic.state.type)}"><summary><span class="e-st st-linear">${escapeHtml(epic.state.name)}</span><span class="e-id mono">${safeLinearLink(epic.url, epic.identifier)}</span><span class="e-n" title="${escapeHtml(epic.title)}">${escapeHtml(shortEpicTitle(epic.title))}</span>${epicIntakeStatus(page.header.roots.value![epic.rootIndex]!) ? `<span class="e-intake">${escapeHtml(epicIntakeStatus(page.header.roots.value![epic.rootIndex]!)!)}</span>` : ""}<span class="e-c">${escapeHtml(countsText(epic))}</span></summary><div class="e-b">${judgment}${epic.children.map((c) => renderChild(page, c, dictionary, now)).join("")}${terminal ? `<p class="terminal-tail kid-tail">另有 ${escapeHtml(terminal)}(不展示)</p>` : ""}</div></details>`;
}

function renderAttention(
	page: EpicPage,
	now: Date,
	dictionary: RenderAudit,
): string {
	const deploymentRows = (page.deployment?.value?.units ?? []).filter(
		(unit) => unit.episodeId !== null && unit.founderAware,
	);
	const renderDeploymentRows = () =>
		deploymentRows
			.map(
				(unit) =>
					`<article class="u-row" data-shuttle-founder="${escapeHtml(unit.unitId)}"><div class="u-l"><span class="u-kind k-gate">需要你知道，Lead 处理中</span><span class="mono">${escapeHtml(unit.projectName)}</span><span class="u-t">${escapeHtml(unit.displayName)}</span></div><div class="u-act">▶ ${escapeHtml(unit.reasonDisplay)}</div><div class="u-r"><span class="u-since">${escapeHtml(unit.behindCommits === null ? "落后提交数未知" : `落后 ${unit.behindCommits} 个提交`)}</span><span>${escapeHtml(shuttleDriftAge(unit.driftSince, now))}</span><span>${escapeHtml(`日志 ${unit.logRef}`)}</span></div></article>`,
			)
			.join("");
	if (page.schema_version === 1)
		return `<section data-attention-section><h2 class="sec">⚡ 现在要你看 · ${deploymentRows.length} 件</h2><div class="urgent">${renderDeploymentRows()}</div><p>${escapeHtml(label("attention.legacy"))}</p></section>`;
	const rows = attentionAudience(page, true);
	return `<section data-attention-section><h2 class="sec">⚡ 现在要你看 · ${rows.length + deploymentRows.length} 件</h2><div class="urgent">${renderDeploymentRows()}${rows
		.map(({ item, olderQuestions }) => {
			dictionary.appendix.push(
				`<details class="attention-sources"><summary>${escapeHtml(label("attention.sources", { n: item.sources.length }))}</summary><ul>${item.sources.map((source) => `<li>${escapeHtml(attentionSourceText(source, now))}</li>`).join("")}</ul></details>`,
			);
			const link = attentionLink(page, item);
			const where = link.url
				? renderDiscordLinkPair(
						link.url,
						"跳 Discord ↗",
						"jump",
						item.identifier.value ?? label("attention.unknown"),
					) ||
					`<span class="jump-off" aria-disabled="true">Discord 链接不可用</span>`
				: `<span class="jump-off" aria-disabled="true" title="${escapeHtml(attentionMissing(link.reason))}">${escapeHtml(label("attention.no_link"))}</span>`;
			const question = item.sources.every(
				(source) => source.fact.value?.kind === "question",
			);
			return `<article class="u-row" data-attention-key="${attentionPublicKey(page.key.project_name, item.key)}"><div class="u-l" data-attention-part="what"><span class="u-kind ${question ? "k-ask" : "k-gate"}">${escapeHtml(item.kind.value ?? label("attention.unknown"))}</span><span class="mono">${escapeHtml(item.identifier.value ?? label("attention.unknown"))}</span><span class="u-t">${escapeHtml(item.title.value ?? label("attention.unknown"))}</span></div><div class="u-act" data-attention-part="action">▶ ${escapeHtml(attentionActionText(item))}</div><div class="u-r"><span class="u-since" data-attention-part="wait">${escapeHtml(attentionWait(item.since, now))}</span><span data-attention-part="where">${where}</span></div>${olderQuestions ? `<span class="u-scope">${escapeHtml(label("attention.older_questions", { n: olderQuestions }))}</span>` : ""}</article>`;
		})
		.join(
			"",
		)}</div><p class="note attention-status">${escapeHtml(attentionSummary(page, rows.length + deploymentRows.length))}</p></section>`;
}

function renderDeployment(page: EpicPage, now: Date): string {
	const deployment = page.deployment?.value;
	if (!deployment)
		return '<section data-shuttle-status><h2 class="sec">班车状态</h2><p class="note">班车状态尚未采集（旧页面不代表健康）。</p></section>';
	const stale = shuttleSourceIsStale(deployment.observedAt, now);
	const activeIds = new Set(deployment.activeIncidents);
	const active = deployment.units.filter((unit) => activeIds.has(unit.unitId));
	const hasExpectedSkips = deployment.units.some(
		(unit) => unit.outcome === "skipped" && unit.expected,
	);
	const source =
		deployment.sourceStatus === "unavailable"
			? "状态来源不可用；以下为最后一次成功投影，不视为当前健康。"
			: stale
				? "班车停跑/读数过期；超过一个班次没有新记录，不视为当前健康。"
				: deployment.sourceStatus === "truncated"
					? `状态已截断（展示 ${deployment.retained}/${deployment.total}）。`
					: `已采集 ${deployment.total} 个部署单元。`;
	const body = active.length
		? active
				.map(
					(unit) =>
						`<article class="u-row" data-shuttle-unit="${escapeHtml(unit.unitId)}"><div class="u-l"><span class="u-kind k-gate">${escapeHtml(`${unit.outcome}:${unit.reason}`)}</span><span class="mono">${escapeHtml(unit.projectName)}</span><span class="u-t">${escapeHtml(unit.displayName)}</span></div><div class="u-act">${escapeHtml(unit.reasonDisplay)}</div><div class="u-r"><span>${escapeHtml(unit.behindCommits === null ? "落后提交数未知" : `落后 ${unit.behindCommits} 个提交`)}</span><span>${escapeHtml(shuttleDriftAge(unit.driftSince, now))}</span><span>${escapeHtml(`连续 ${unit.consecutiveScheduledBad} 班`)}</span><span>${escapeHtml(`告警 ${unit.deliveryState ?? "待记录"}`)}</span><span>${escapeHtml(`日志 ${unit.logRef}`)}</span></div></article>`,
				)
				.join("")
		: deployment.sourceStatus === "unavailable"
			? "<p data-shuttle-unknown>无法判定当前班车是否健康。</p>"
			: stale
				? "<p data-shuttle-stale>班车停跑/读数过期。</p>"
				: hasExpectedSkips
					? "<p data-shuttle-unverified>部分单元本班未验证；未发现新异常，但不能声明全部正常。</p>"
					: "<p data-shuttle-healthy>班车全部单元正常。</p>";
	return `<section data-shuttle-status><h2 class="sec">班车状态</h2><p class="note">${escapeHtml(source)}</p><div class="urgent">${body}</div></section>`;
}

const VOICE_HEALTH_STALE_MS = 90_000;
const VOICE_REASON_TEXT = {
	bridge_connect_failed: "无法连接本机 Bridge",
	bridge_timeout_headers: "Bridge 响应头超时",
	bridge_timeout_body: "Bridge 响应体超时",
	bridge_auth_rejected: "Bridge 拒绝认证",
	bridge_http_error: "Bridge 返回错误",
	bridge_protocol_invalid: "Bridge 响应格式无效",
	startup_config_invalid: "启动配置无效",
	startup_lock_unavailable: "启动锁不可用",
	startup_not_ready: "启动后未就绪",
	session_create_failed: "语音会话创建失败",
	session_runtime_failed: "语音会话运行失败",
	lease_lost: "语音租约丢失",
	heartbeat_stale: "语音心跳过期",
	health_observation_unavailable: "健康记录不可用",
	demand_source_unavailable: "会话需求来源不可用",
	unknown_failure: "未知语音故障",
} as const;

function renderVoiceHealth(page: EpicPage, now: Date): string {
	if (page.key.project_name !== "flywheel") return "";
	const health = page.voiceHealth?.value;
	if (!health)
		return '<section data-voice-health data-voice-health-unknown><h2 class="sec">语音健康</h2><p class="note">语音健康尚未采集（旧页面不代表健康）。</p></section>';
	const observed = health.observedAt
		? Date.parse(health.observedAt)
		: Number.NaN;
	const stale =
		!Number.isFinite(observed) ||
		now.getTime() - observed > VOICE_HEALTH_STALE_MS;
	const lastSuccess = health.lastIterationSuccessAt
		? `最近完整成功：${health.lastIterationSuccessAt}。`
		: "尚无完整成功记录。";
	// FLY-2693 review R5: an unavailable source, an unknown state or a stale
	// reading is a caveat on the incident list, never a reason to hide it. The
	// projection deliberately retains active incidents through those states and
	// the JSON still carries them, so both human surfaces keep rendering them
	// (same contract as renderDeployment).
	const caveat =
		health.sourceStatus === "unavailable"
			? "unavailable"
			: stale
				? "stale"
				: health.status === "unknown" || health.demandState === "unknown"
					? "unknown"
					: health.sourceStatus === "truncated"
						? "truncated"
						: null;
	const caveatText =
		caveat === "unavailable"
			? "状态来源不可用；以下为最后一次成功投影，不视为当前健康。"
			: caveat === "stale"
				? "语音读数过期；以下为最后一次读数，不视为当前健康。"
				: caveat === "unknown"
					? "无法确认当前语音健康。"
					: caveat === "truncated"
						? "活动故障列表已截断，仅展示最早的一部分。"
						: "";
	const caveatAttr = caveat
		? ` data-voice-health-caveat="${escapeHtml(caveat)}"`
		: "";
	if (health.activeIncidents.length > 0) {
		const incidents = health.activeIncidents
			.map(
				(incident) =>
					`<article class="u-row"><div class="u-l"><span class="u-kind k-gate">语音不可用</span><span class="u-t">${escapeHtml(VOICE_REASON_TEXT[incident.reasonClass])}</span></div><div class="u-r"><span>${escapeHtml(`自 ${incident.openedAt}`)}</span><span>${escapeHtml(`告警 ${incident.deliveryState ?? "待记录"}`)}</span></div></article>`,
			)
			.join("");
		const note = caveatText
			? `${escapeHtml(caveatText)} 有会话需求，语音不可用。连续失败 ${health.failureStreak} 次。${escapeHtml(lastSuccess)}`
			: `有会话需求，语音不可用。连续失败 ${health.failureStreak} 次。${escapeHtml(lastSuccess)}`;
		return `<section data-voice-health data-voice-health-unhealthy${caveatAttr}><h2 class="sec">语音健康</h2><p class="note">${note}</p><div class="urgent">${incidents}</div></section>`;
	}
	if (caveat === "unavailable" || caveat === "stale" || caveat === "unknown") {
		const detail =
			caveat === "stale"
				? "语音读数过期；无法确认当前语音健康。"
				: "无法确认当前语音健康。";
		return `<section data-voice-health data-voice-health-unknown${caveatAttr}><h2 class="sec">语音健康</h2><p class="note">${escapeHtml(detail)} ${escapeHtml(lastSuccess)}</p></section>`;
	}
	if (health.demandState === "none" && health.status === "dormant")
		return `<section data-voice-health data-voice-health-dormant><h2 class="sec">语音健康</h2><p class="note">无会话需求，正常休眠。${escapeHtml(lastSuccess)}</p></section>`;
	if (health.status === "unhealthy")
		return `<section data-voice-health data-voice-health-unhealthy${caveatAttr}><h2 class="sec">语音健康</h2><p class="note">${caveatText ? `${escapeHtml(caveatText)} ` : ""}有会话需求，语音不可用。连续失败 ${health.failureStreak} 次。${escapeHtml(lastSuccess)}</p></section>`;
	if (health.status === "starting")
		return `<section data-voice-health data-voice-health-starting><h2 class="sec">语音健康</h2><p class="note">有会话需求，语音正在启动或等待 live。${escapeHtml(lastSuccess)}</p></section>`;
	return `<section data-voice-health data-voice-health-healthy><h2 class="sec">语音健康</h2><p class="note">有会话需求，语音健康正常。${escapeHtml(lastSuccess)}</p></section>`;
}

function renderLeadAttention(page: EpicPage, now: Date): string {
	if (page.schema_version !== 2) return "";
	const rows = attentionAudience(page, false);
	if (!rows.length) return "";
	return `<details class="lead-panel" data-lead-attention><summary>${escapeHtml(label("section.waiting_lead"))}（${rows.length}）</summary>${rows
		.map(({ item, olderQuestions }) => {
			const link = attentionLink(page, item);
			const title = [
				item.identifier.value ?? label("attention.unknown"),
				item.title.value ?? label("attention.unknown"),
			].join(" · ");
			const diagnostic = item.sources.some(
				(source) => source.fact.value?.kind !== "lead_question",
			)
				? ` · ${escapeHtml(item.kind.value ?? label("attention.unknown"))} · ${escapeHtml(item.action.value ?? label("attention.unknown"))}`
				: "";
			const destination = link.url
				? renderDiscordLinkPair(link.url, title, undefined, title) ||
					`${escapeHtml(title)} · Discord 链接不可用`
				: escapeHtml(title);
			return `<p data-lead-question>${diagnostic}${destination} · ${escapeHtml(attentionWait(item.since, now))}${olderQuestions ? ` · ${escapeHtml(label("attention.older_questions", { n: olderQuestions }))}` : ""}</p>`;
		})
		.join("")}</details>`;
}

/** Single-response diagnostic preview retains its inline audit for offline use. */
export function renderEpicPageHtml(page: EpicPage, now = new Date()): string {
	return renderHtml(page, now, new RenderAudit());
}
export interface EpicPageBundle {
	html: string;
	audit: {
		json: string;
		sha256: string;
		path: string;
		entries: number;
		bytes: number;
	};
}
/** Hosted publication: HTML and its immutable, hash-bound audit object. */
export function renderEpicPageBundle(
	page: EpicPage,
	now = new Date(),
	limits: EpicOptionalRows = {},
): EpicPageBundle {
	const sidecar = new AuditSidecar();
	const html = renderHtml(page, now, new RenderAudit(sidecar, limits));
	const json = sidecar.json();
	const sha256 = createHash("sha256").update(json).digest("hex");
	return {
		html: html.replaceAll(
			'href="__EPIC_JUDGMENT_AUDIT__#',
			`href="${sha256}/index.audit.json#`,
		),
		audit: {
			json,
			sha256,
			path: `${sha256}/index.audit.json`,
			entries: sidecar.count,
			bytes: Buffer.byteLength(json),
		},
	};
}
function renderHtml(
	page: EpicPage,
	now: Date,
	dictionary: RenderAudit,
): string {
	if (dictionary.sidecar) {
		dictionary.sidecar.add(page.freshness);
		dictionary.sidecar.add(page.stuck_items);
		dictionary.sidecar.add(page.dependency_review);
		if (page.schema_version === 2) dictionary.sidecar.add(page.attention);
	}
	const scopeUnavailable =
		page.schema_version === 2 && page.epic_scope.value === null;
	const view = scopeUnavailable ? null : buildFounderView(page);
	const headerCells: Array<[string, LabelKey, Cell<unknown>]> = [
		[
			"scope_definition",
			"cell.header.scope_definition",
			page.header.scope_definition,
		],
		["items", "cell.header.items", page.header.items],
	];
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>${escapeHtml(label("page.title"))} · ${escapeHtml(page.key.project_name)}</title>
	<style>
:root{color-scheme:light;--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#86868b;--navy:#1a365d;--blue:#007aff;--green:#34c759;--line:#e5e5ea}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,system-ui,"PingFang SC","Helvetica Neue",Arial,sans-serif}main{max-width:960px;margin:0 auto;padding:26px 18px 80px}a{color:var(--blue);overflow-wrap:anywhere}summary:focus-visible,a:focus-visible{outline:2px solid var(--blue);outline-offset:3px}.note,.lead-panel{color:var(--dim);font-size:13px}.mono{font-family:"SF Mono",Menlo,monospace;font-size:12.5px;color:var(--navy);font-weight:600}.kid,.epic,.mock-bar,footer{overflow-wrap:anywhere}.e-n{flex:1;min-width:0}.audit-cell{display:grid;margin:8px 0}.audit-cell code{white-space:pre-wrap;overflow-wrap:anywhere}.audit,.view-rule,footer{font-size:11px;color:var(--dim)}.lead-panel{margin-top:16px}.lead-panel>summary{cursor:pointer}.e-st,.s{max-width:100%;white-space:normal!important}.s-waiting{background:#fff2dd;color:#a35c00}.s-free{background:#eeeef0;color:#6e6e73}.m-h h1{font-size:19px;margin:0 0 3px}.lead-note-stale{opacity:.75}.epic-hidden{font-size:12px;color:var(--dim)}@media(max-width:600px){main{padding:16px 10px 60px}.e-c{flex-basis:100%;margin-left:20px!important}}
  .mock{background:#eef0f3;border:1px solid var(--line);border-radius:12px;padding:14px;margin:14px 0}
  .mock-bar{font-size:12px;color:var(--dim);margin-bottom:10px;font-family:"SF Mono",Menlo,monospace}
  .m-h{background:#fff;border-radius:10px;padding:13px 15px;border:1px solid var(--line)}
  .m-t{font-size:19px;font-weight:700;color:var(--navy);margin:0 0 3px}
  .sec{font-size:12.5px;font-weight:700;color:var(--dim);letter-spacing:.3px;margin:16px 0 8px}
  .urgent{background:#fff;border-radius:10px;border-left:4px solid var(--red);border-top:1px solid var(--line);border-right:1px solid var(--line);border-bottom:1px solid var(--line);overflow:hidden}
  .u-row{padding:11px 14px;border-bottom:1px solid var(--line)}
  .u-row:last-child{border-bottom:none}
  .u-l{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .u-kind{font-size:11px;font-weight:700;padding:3px 8px;border-radius:20px;white-space:nowrap}
  .k-gate{background:#ffe9e7;color:#c92a20}.k-ask{background:#fff2dd;color:#a35c00}.k-named{background:#efe6ff;color:#6d33b8}
  .u-t{color:var(--dim);font-size:12.5px}
  .u-scope{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
  .u-act{font-size:13.5px;font-weight:600;color:var(--navy);margin:6px 0 4px}
  .u-r{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .u-since{font-size:12px;color:var(--dim)}
  .jump{font-size:12px;padding:3px 9px;border-radius:7px;border:1px solid var(--blue);color:var(--blue);text-decoration:none}
  .discord-links{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}[data-discord-fallback]{font-size:11px;color:var(--dim)}
  .jump-off{font-size:12px;padding:3px 9px;border-radius:7px;border:1px dashed #c7c7cc;color:#a1a1a6;background:#fafafa;cursor:not-allowed}
  .epic{background:#fff;border-radius:10px;border:1px solid var(--line);border-left:4px solid var(--green);margin-bottom:8px;overflow:hidden}
  .epic.e-idle{border-left-color:var(--dim)}
  .epic summary{cursor:pointer;padding:12px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;list-style:none}
  .epic summary::-webkit-details-marker{display:none}
  .epic summary::before{content:"▸";color:var(--dim);font-size:12px}
  .epic[open] summary::before{content:"▾"}
  .e-st{font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap}
  .st-live{background:#e3f6e9;color:#1f7a37}.st-idle{background:#eeeef0;color:#6e6e73}
  .st-linear{background:#e3f6e9;color:#1f7a37}
  .e-n{font-weight:600}
  .e-c{margin-left:auto;font-size:12px;color:var(--dim)}
  .e-b{padding:2px 14px 12px;border-top:1px solid var(--line)}
  .leadnote{background:#f6f9ff;border:1px dashed #c3d7f5;border-radius:9px;padding:9px 11px;margin:9px 0;font-size:13px}
  .sample-tag{font-size:10.5px;font-weight:700;background:#fff4e5;color:#8a4b00;border-radius:20px;padding:2px 8px;margin-left:6px}
  .ln-body{margin-top:5px;color:#4a4a4f}
  .ln-meta{margin-top:5px;font-size:11px;color:var(--dim)}
  .kid{padding:10px 0;border-bottom:1px solid var(--line)}
  .kid:last-child{border-bottom:none}
  .kid-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .kid-t{font-size:12.5px}
  .s{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;white-space:nowrap}
  .s-live{background:#e3f6e9;color:#1f7a37}.s-idle{background:#eeeef0;color:#6e6e73}.s-wait,.s-blocked{background:#fff2dd;color:#a35c00}
  .s-stopped_acceptance{background:#eef1f5;color:#50545b}.s-stopped_stuck{background:#ffe8e6;color:#a62b1f}.s-evidence_gap{background:#fff2dd;color:#8a4b00}
  .kid-a{font-size:12.5px;color:#4a4a4f;margin-top:3px}
  .kid-tail{font-size:12px;color:var(--dim);padding-top:9px}
  .empty{color:var(--dim);font-size:13px;padding:10px 0}
  @media(max-width:700px){main{padding:16px 10px 60px}.card{padding:15px 14px}}

.mock a.mono{color:inherit;text-decoration:none}.mock a.mono:hover{text-decoration:underline}
</style>
</head>
<body><main><div class="mock">
	<div class="mock-bar" data-generated-at="${escapeHtml(page.generated_at)}">🔒 一个固定链接 · 手机能开 · 按需刷新 · 页面快照截至 ${escapeHtml(page.generated_at)} · <span data-opened-age>${escapeHtml(relativeTime(page.generated_at, now))}</span></div>
	<div class="m-h"><h1 class="m-t">${escapeHtml(page.key.project_name)} · 现在在做什么</h1><div class="note">全部默认收起,点开才展开</div></div>
	${renderAttention(page, now, dictionary)}
	${renderDeployment(page, now)}
	${renderVoiceHealth(page, now)}
	${
		view === null
			? `<p class="scope-unavailable">${escapeHtml(label("attention.scope_unavailable"))}</p>`
			: `
 <div class="sec">在做的 Epic(全做完的已拿掉;Linear 状态单列;在跑按机器会话)</div>
 ${view.epics.length ? view.epics.map((epic) => renderEpic(page, epic, now, dictionary)).join("") : `<p>${escapeHtml(label("epic.none"))}</p>`}
 ${view.hiddenDoneEpics && view.hiddenDoneEpics.count > 0 ? `<details class="lead-panel"><summary>已完成的 Epic</summary><div class="epic-hidden">${escapeHtml(label("epic.hidden_done", { n: view.hiddenDoneEpics.count }))}<details class="audit"><summary>${escapeHtml(label("cell.provenance"))}</summary>${renderViewRule(view.hiddenDoneEpics.view, dictionary)}</details></div></details>` : ""}
 ${view.unattached.length ? `<details class="lead-panel"><summary>未挂 Epic 的子单</summary><section class="unattached"><h2>${escapeHtml(label("epic.unattached"))}</h2>${view.unattached.map((c) => renderChild(page, c, dictionary, now)).join("")}</section></details>` : ""}
	<details class="lead-panel"><summary>${escapeHtml(label("cell.provenance"))}</summary>
	${renderAuditCell("/dependency_review", "cell.provenance", page.dependency_review, now, dictionary)}
	${headerCells.map(([field, name, cell]) => renderAuditCell(`/header/${field}`, name, cell, now, dictionary)).join("")}
	${[
		["/header/roots", "cell.header.roots", page.header.roots],
		["/ready_items", "cell.provenance", page.ready_items],
		["/founder_items", "cell.provenance", page.founder_items],
		["/done_definition", "cell.provenance", page.done_definition],
		["/gaps", "cell.provenance", page.gaps],
	]
		.map(([path, name, cell]) =>
			renderAuditCell(
				path as string,
				name as LabelKey,
				cell as Cell<unknown>,
				now,
				dictionary,
			),
		)
		.join("")}
	</details>`
	}
<details class="lead-panel"><summary>出处与补充记录</summary>${dictionary.appendix.join("")}${renderLeadAttention(page, now)}
</details>
${renderJudgmentHistory(page, dictionary)}
${dictionary.omittedJudgments ? "<p>机器意见摘要已缩减；完整依据见审计附件。</p>" : ""}
${dictionary.sidecar ? auditFooter(dictionary.sidecar) : ""}</div></main>${dictionary.sidecar ? "" : `<script type="application/json" id="epic-audit-data">${dictionary.json()}</script>`}<script nonce="__CSP_NONCE__">${DISCORD_LINK_UPGRADE_SCRIPT}${dictionary.sidecar ? "" : '(()=>{const data=JSON.parse(document.getElementById("epic-audit-data").textContent);document.querySelectorAll("[data-fulltext]").forEach(e=>{e.title=data.texts[Number(e.getAttribute("data-fulltext"))];});document.querySelectorAll("[data-src]").forEach(cell=>{const [source,observed,updated]=data.cells[Number(cell.getAttribute("data-src"))];const p=data.sources[source];let text=p.kind==="linear"?p.entity+":"+p.id+" · "+p.field:p.kind==="derived"?p.rule+" · "+p.from.join(", "):p.table+" · "+JSON.stringify(p.key);text+=" · 看到 "+data.times[observed];if(updated!==undefined)text+=" · 源 "+data.times[updated];const span=document.createElement("span");span.className="cell-source";span.textContent=text;cell.append(span);});})();'}(()=>{const root=document.querySelector("[data-generated-at]");const age=document.querySelector("[data-opened-age]");const update=()=>{document.querySelectorAll("[data-lead-written-at]").forEach(note=>{const written=Date.parse(note.getAttribute("data-lead-written-at")||"");const days=Number(note.getAttribute("data-lead-fade-days"));if(!Number.isFinite(written)||!Number.isFinite(days)||days<=0)return;const elapsed=Math.max(0,Date.now()-written);const hours=Math.floor(elapsed/3600000);const relative=note.querySelector("[data-lead-relative]");if(relative)relative.textContent=note.getAttribute("data-lead-role")+" · "+(hours<1?"刚写":hours+" 小时前写");const stale=elapsed>days*86400000;note.classList.toggle("lead-note-stale",stale);const badge=note.querySelector("[data-lead-stale]");if(badge)badge.hidden=!stale;});if(!root||!age)return;const generated=Date.parse(root.getAttribute("data-generated-at")||"");if(Number.isFinite(generated)){const minutes=Math.max(0,Math.floor((Date.now()-generated)/60000));age.textContent="你打开时它已 "+minutes+" 分钟旧";}};update();setInterval(update,60000);})();</script></body></html>`;
}
