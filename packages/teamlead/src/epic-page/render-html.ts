import { createHash } from "node:crypto";
import { escapeHtml } from "../bridge/xhs-review-html.js";
import { AuditDictionary } from "./audit-dictionary.js";
import { AuditSidecar } from "./audit-sidecar.js";
import {
	buildFounderView,
	type ChildView,
	type EpicView,
	type ViewProvenance,
} from "./founder-view.js";
import { type LabelKey, label, leadNoteRoleLabel } from "./labels.js";
import { DEFAULT_LEAD_NOTE_FADE_DAYS, leadNoteAge } from "./lead-note.js";
import type {
	Cell,
	DependencyReviewEntry,
	EpicItem,
	EpicPage,
	Provenance,
	Signal,
	StuckItem,
} from "./model.js";

class RenderAudit extends AuditDictionary {
	constructor(readonly sidecar?: AuditSidecar) {
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
	return `<footer>审计出处：<a href="${hash}/index.audit.json">${hash}/index.audit.json</a> · SHA-256 ${hash} · ${audit.count} 条 · ${Buffer.byteLength(json)} B</footer>`;
}

const FOUNDER_DECIDED_RULES = new Set([
	"scope.v2",
	"counts.v1",
	"ready.v1",
	"dependents.v1",
]);

function relativeTime(iso: string, now: Date): string {
	const minutes = Math.max(
		0,
		Math.floor((now.getTime() - Date.parse(iso)) / 60_000),
	);
	return label("time.minutes_ago", { n: minutes });
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
	return url.startsWith("https://linear.app/")
		? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`
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

function triggerLabel(trigger: EpicPage["generator"]["trigger"]): string {
	return label(`freshness.trigger.${trigger}` as LabelKey);
}

function signalLabel(signal: Pick<Signal, "kind" | "reason">): string {
	return signal.kind === "runner_stopped"
		? label("signal.kind.runner_stopped", { reason: signal.reason ?? "error" })
		: label(`signal.kind.${signal.kind}` as LabelKey);
}

function signalSummary(signal: Signal): string {
	return `${signalLabel(signal)} · ${signal.execution_id8} · ${signal.since}`;
}

function signalList(signals: Signal[]): string {
	return signals.length > 0
		? signals
				.map(
					(signal) =>
						`<span class="signal-pill">${escapeHtml(signalSummary(signal))}</span>`,
				)
				.join("")
		: escapeHtml(label("page.signal_none"));
}

function stuckSignal(page: EpicPage, stuck: StuckItem): Signal | undefined {
	return page.items
		.find((item) => item.identifier === stuck.item)
		?.signals.find(
			(signal) =>
				signal.kind === stuck.kind &&
				signal.execution_id8 === stuck.execution_id8,
		);
}

function stuckSummary(page: EpicPage): string {
	const stuck = page.stuck_items.value ?? [];
	return stuck.length > 0
		? stuck
				.map((entry) => {
					const signal = stuckSignal(page, entry);
					const kind = signal
						? signalLabel(signal)
						: label(`signal.kind.${entry.kind}` as LabelKey);
					return `<span class="signal-pill">${escapeHtml(`${entry.item} · ${kind} · ${entry.execution_id8} · ${entry.since}`)}</span>`;
				})
				.join("")
		: escapeHtml(label("page.signal_none"));
}

function waitingFounderSummary(page: EpicPage): string {
	const waiting = page.items.flatMap((item) =>
		item.signals
			.filter((signal) => signal.kind === "waiting_founder")
			.map((signal) => ({ item: item.identifier, signal })),
	);
	return waiting.length > 0
		? waiting
				.map(
					({ item, signal }) =>
						`<span class="signal-pill">${escapeHtml(`${item} · ${signalSummary(signal)}`)}</span>`,
				)
				.join("")
		: escapeHtml(label("page.signal_none"));
}

function observedAtAtPath(page: EpicPage, path: string): string | undefined {
	let cursor: unknown = page;
	for (const part of path.split("/").filter(Boolean)) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = Array.isArray(cursor)
			? cursor[Number(part)]
			: (cursor as Record<string, unknown>)[part];
	}
	if (cursor === null || typeof cursor !== "object") return undefined;
	const observedAt = (cursor as Record<string, unknown>).observed_at;
	return typeof observedAt === "string" ? observedAt : undefined;
}

function renderFreshness(page: EpicPage): string {
	const freshness = page.freshness;
	const current = freshness.current.value;
	const lastGenerated = freshness.last_generated.value;
	const lastPublished = freshness.last_published.value;
	const failureCount = freshness.publish_failures.value?.count ?? 0;
	const lastPublishFailure = freshness.last_publish_failure;
	const hosted = freshness.hosted.value;
	const oldestPath = freshness.oldest_source.value?.path;
	const oldestObservedAt = oldestPath
		? observedAtAtPath(page, oldestPath)
		: undefined;
	const rows: Array<[string, string]> = [
		[
			label("freshness.current"),
			current
				? `v${current.version} · ${triggerLabel(current.trigger)} · ${current.reasons.join(", ")}`
				: label("page.none"),
		],
		[
			label("freshness.last_generated"),
			lastGenerated
				? `v${lastGenerated.version} · ${triggerLabel(lastGenerated.trigger)} · ${freshness.last_generated.source_updated_at ?? label("page.none")}`
				: label("page.none"),
		],
		[
			label("freshness.last_published"),
			lastPublished
				? `v${lastPublished.version} · ${triggerLabel(lastPublished.trigger)} · ${freshness.last_published.source_updated_at ?? label("page.none")}`
				: label("page.none"),
		],
		[
			label("freshness.failures", {
				n: failureCount,
				token:
					failureCount > 0
						? (lastPublishFailure.value?.token ?? label("page.none"))
						: label("page.none"),
				at:
					failureCount > 0
						? (lastPublishFailure.source_updated_at ?? label("page.none"))
						: label("page.none"),
			}),
			"",
		],
		[
			label("freshness.hosted", {
				token8: hosted?.token8 ?? label("page.none"),
				at: freshness.hosted.source_updated_at ?? label("page.none"),
			}),
			"",
		],
		[
			label("freshness.oldest_source"),
			oldestPath
				? `${oldestPath} @ ${oldestObservedAt ?? label("page.none")}`
				: label("page.none"),
		],
		[
			label("freshness.next_scan"),
			freshness.next_scan.value
				? `${freshness.next_scan.value.expected_in_seconds} 秒后`
				: label("page.none"),
		],
	];
	return `<section class="freshness-card">
	<h2>${escapeHtml(label("page.freshness"))}</h2>
	<div class="freshness-grid">${rows
		.map(([name, value]) =>
			value
				? `<div><b>${escapeHtml(name)}</b><span>${escapeHtml(value)}</span></div>`
				: `<div><span>${escapeHtml(name)}</span></div>`,
		)
		.join("")}</div>
	<div class="freshness-age" data-opened-age>${escapeHtml(label("freshness.opened_age", { minutes: 0 }))}</div>
</section>`;
}

function renderLeadNotes(
	notes: Cell<string>[] | undefined,
	now: Date,
	fadeDays: number,
	compact = false,
): string {
	return (notes ?? [])
		.map((note) => {
			if (note.provenance.kind !== "lead_note")
				throw new Error("invalid lead-note provenance");
			const { written_at, role } = note.provenance;
			const age = leadNoteAge(written_at, now, fadeDays);
			const roleLabel = leadNoteRoleLabel(role);
			const tag = compact ? "span" : "aside";
			const textTag = compact ? "span" : "p";
			return `<${tag} class="lead-note${compact ? " lead-note-compact" : ""}${age.stale ? " lead-note-stale" : ""}" data-lead-written-at="${escapeHtml(written_at)}" data-lead-fade-days="${escapeHtml(String(fadeDays))}" data-lead-role="${escapeHtml(roleLabel)}"><b>${escapeHtml(label("lead_note.title"))}</b><${textTag} class="lead-note-text" title="${escapeHtml(note.value ?? "")}">${escapeHtml(note.value ?? "")}</${textTag}><span data-lead-relative>${escapeHtml(`${roleLabel} · ${age.relative}`)}</span><time datetime="${escapeHtml(written_at)}">${escapeHtml(written_at)}</time><span data-lead-stale${age.stale ? "" : " hidden"}>${escapeHtml(label("lead_note.stale"))}</span><small>${escapeHtml(label("lead_note.disclosure"))}</small></${tag}>`;
		})
		.join("");
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
	if (child.cls === "waiting")
		return label("child.waiting", { blockers: blockersText(child) });
	if (child.cls === null)
		return label("child.unknown_type", { state: child.stateName });
	if (child.cls === "done" || child.cls === "canceled") return child.stateName;
	return label(`child.${child.cls}`);
}
function progressText(child: ChildView): string {
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
function renderChild(
	page: EpicPage,
	child: ChildView,
	dictionary: RenderAudit,
	now: Date,
): string {
	const item = page.items[child.itemIndex]!;
	const signals = item.signals.length
		? `<div class="kid-signals">${item.signals.some((s) => s.kind !== "waiting_founder") ? signalList(item.signals.filter((s) => s.kind !== "waiting_founder")) : ""}${item.signals.some((s) => s.kind === "waiting_founder") ? signalList(item.signals.filter((s) => s.kind === "waiting_founder")) : ""}</div>`
		: "";
	return `<div class="kid" data-item="${escapeHtml(child.identifier)}" data-class="${child.cls ?? "unknown"}"><div class="kid-h"><span class="s s-${child.cls ?? "unknown"}">${escapeHtml(childBadge(child))}</span><span class="kid-id">${child.url ? safeLinearLink(child.url, child.identifier) : escapeHtml(child.identifier)}</span><span>${escapeHtml(child.title)}</span></div><div class="kid-a" data-machine-line>${escapeHtml(progressText(child))} <span class="src">${escapeHtml(label("progress.source"))}</span></div>${renderLeadNotes(item.lead_note, now, page.lead_note_policy?.value?.fade_after_days ?? DEFAULT_LEAD_NOTE_FADE_DAYS)}${signals}${renderChildAudit(item, child, dictionary)}</div>`;
}
function countsText(epic: EpicView): string {
	if (!epic.counts)
		return label("counts.missing", {
			type: epic.countsMissing?.detail ?? label("progress.unknown"),
		});
	return (["live", "waiting", "free", "idle", "total"] as const)
		.filter((k) => k === "live" || k === "total" || epic.counts![k] > 0)
		.map((k) => label(`counts.${k}`, { n: epic.counts![k] }))
		.join(" · ");
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
	return `<details class="epic" data-root="${escapeHtml(epic.identifier)}" data-state-type="${escapeHtml(epic.state.type)}"><summary><span class="e-st">${escapeHtml(epic.state.name)}</span><span class="e-id">${escapeHtml(epic.identifier)}</span><span class="e-n">${escapeHtml(epic.title)}</span><span class="e-c">${escapeHtml(countsText(epic))}</span>${epic.allWaitingOn ? `<span class="e-wait">${escapeHtml(label("epic.all_waiting", { blockers: epic.allWaitingOn.blockers.join(" / ") }))}</span>` : ""}${renderLeadNotes(notes, now, fadeDays, true)}</summary><div class="e-b">${renderLeadNotes(notes, now, fadeDays)}${epic.children.map((c) => renderChild(page, c, dictionary, now)).join("")}${terminal ? `<p class="terminal-tail">${escapeHtml(label("epic.terminal_tail", { tail: terminal }))}</p>` : ""}<details class="audit"><summary>${escapeHtml(label("cell.provenance"))}</summary>${renderRootProjection(page, epic, dictionary)}${renderAuditCell(`/header/root_counts/${epic.rootIndex}`, "cell.header.root_counts", page.header.root_counts[epic.rootIndex]!, now, dictionary)}${epic.allWaitingOn ? renderViewRule(epic.allWaitingOn.view, dictionary) : ""}${epic.terminal.view ? renderViewRule(epic.terminal.view, dictionary) : ""}</details></div></details>`;
}

function renderOverviewCell(
	path: string,
	title: string,
	content: string,
	cell: Cell<unknown>,
	now: Date,
	dictionary: RenderAudit,
	className = "overview-card",
): string {
	if (dictionary.sidecar)
		return `<article class="${className}" data-cell="${escapeHtml(path)}" data-audit="${dictionary.sidecar.add(cell)}"><h2>${escapeHtml(title)}</h2><div class="overview-value">${content}</div>${compactAudit(dictionary.sidecar, cell, cell.observed_at)}</article>`;
	return `<article class="${className}" data-cell="${escapeHtml(path)}">
	<h2>${escapeHtml(title)}</h2>
	<div class="overview-value">${content}</div>
	<div class="overview-meta"><details class="audit"><summary>${escapeHtml(label("page.all_cells", { count: 1 }))}</summary><div class="audit-cell"><span>${htmlValue(rawCellValue(cell))}</span><span>${escapeHtml(label("cell.provenance"))}: ${htmlProvenance(cell.provenance)}</span><span>${escapeHtml(label("cell.observed_at"))}: ${escapeHtml(cell.observed_at)} (${escapeHtml(relativeTime(cell.observed_at, now))})</span>${cell.source_updated_at ? `<span>${escapeHtml(label("cell.source_updated_at"))}: ${escapeHtml(cell.source_updated_at)}</span>` : ""}${cell.provenance.kind === "derived" ? `<span class="rule-note">${derivedRuleNote(cell.provenance)}</span>` : ""}</div></details></div>
</article>`;
}

function renderDependencyReview(entries: DependencyReviewEntry[]): string {
	if (entries.length === 0) return escapeHtml(label("review.none"));
	return entries
		.map((entry) => {
			if (entry.kind === "canceled_blocker") {
				return `<p>${escapeHtml(
					label("review.canceled_blocker", {
						item: entry.item,
						blocker: entry.blocker,
					}),
				)}</p>`;
			}
			if (entry.kind === "dependency_cycle") {
				return `<p>${escapeHtml(
					label("review.cycle", { members: entry.members.join(" ↔ ") }),
				)}</p>`;
			}
			const edges = entry.blocking_edges
				.map(
					(edge) =>
						`<li>${escapeHtml(
							label("review.blocking_edge", {
								blocked: edge.blocked,
								blocker: edge.blocker,
								state: edge.blocker_state_type,
								scope: edge.in_scope ? "" : label("page.external_dependency"),
							}),
						)}</li>`,
				)
				.join("");
			return `<p>${escapeHtml(
				label("review.all_blocked", { n: entry.non_terminal }),
			)}</p><ul>${edges}</ul>${
				entry.blocking_edges_truncated
					? `<p>${escapeHtml(label("review.blocking_edges_truncated"))}</p>`
					: ""
			}`;
		})
		.join("");
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
): EpicPageBundle {
	const sidecar = new AuditSidecar();
	const html = renderHtml(page, now, new RenderAudit(sidecar));
	const json = sidecar.json();
	const sha256 = createHash("sha256").update(json).digest("hex");
	return {
		html,
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
	const view = buildFounderView(page);
	const ready = page.ready_items.value ?? [];
	const founder = page.founder_items.value ?? [];
	const itemById = new Map(page.items.map((item) => [item.identifier, item]));
	const readyContent =
		ready.length > 0
			? ready
					.map((identifier) => {
						const item = itemById.get(identifier);
						const text = item?.title.value
							? `${identifier} · ${item.title.value}`
							: identifier;
						return item?.url.value
							? `<span class="ready-pill">${safeLinearLink(item.url.value, text)}</span>`
							: `<span class="ready-pill">${escapeHtml(text)}</span>`;
					})
					.join("")
			: escapeHtml(label("page.none"));
	const rootsContent = (page.header.roots.value ?? [])
		.map(
			(root) =>
				`<span class="root-pill">${safeLinearLink(root.url, `${root.identifier} · ${root.title}`)} <small>${escapeHtml(root.state.name)}</small></span>`,
		)
		.join("");
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
		:root{color-scheme:light;--bg:#f3f4f6;--card:#fff;--ink:#182230;--muted:#667085;--line:#e4e7ec;--blue:#175cd3;--blue-soft:#eff4ff;--green:#067647;--green-soft:#ecfdf3;--amber:#93370d}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif}main{max-width:1020px;margin:0 auto;padding:28px 18px 72px}header,.freshness-card,.overview-card,.ready-card,.item-card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 3px rgba(16,24,40,.05)}header{padding:22px 24px;margin-bottom:12px}h1{margin:2px 0 8px;font-size:27px;letter-spacing:-.025em}h2{font-size:17px;margin:0}h3{margin:0;font-size:16px}.eyebrow{font-size:12px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.06em}.lede{display:flex;flex-wrap:wrap;gap:8px 14px;color:var(--muted)}a{color:var(--blue);text-decoration:none;overflow-wrap:anywhere}a:hover{text-decoration:underline}.freshness-card{padding:18px 22px;margin:12px 0}.freshness-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 18px;margin-top:9px}.freshness-grid div{display:grid;gap:1px}.freshness-grid b{color:var(--muted);font-size:12px}.freshness-age{color:var(--blue);font-weight:650;margin-top:9px}.ready-card{border:1px solid #abefc6;background:linear-gradient(135deg,#fff 0%,var(--green-soft) 100%);padding:20px 22px;margin:12px 0}.ready-card h2{color:var(--green)}.ready-card .overview-value{font-size:16px}.ready-pill,.root-pill,.signal-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:6px 10px;margin:3px 5px 3px 0}.ready-pill{background:#fff;border:1px solid #abefc6}.root-pill{background:var(--blue-soft);border:1px solid #d1e0ff}.signal-pill{background:#fff7ed;border:1px solid #fed7aa}.root-pill small{color:var(--muted)}.overview-grid{display:grid;grid-template-columns:1.2fr .8fr .8fr;gap:10px;margin:10px 0 24px}.overview-card{padding:16px}.overview-value{font-size:15px;margin:8px 0}.overview-meta,.card-meta,.audit-cell{color:var(--muted);font-size:11px}.overview-meta{border-top:1px solid #ececef;padding-top:8px;overflow-wrap:anywhere}.section-title{display:flex;justify-content:space-between;align-items:baseline;margin:28px 2px 10px}.section-title span{color:var(--muted);font-size:12px}.item-card{border-left:5px solid var(--blue);padding:15px 17px;margin:10px 0}.card-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:10px}.badges{display:flex;gap:5px;flex:0 0 auto}.badges span{font-size:11px;font-weight:650;padding:2px 7px;border-radius:999px;background:var(--blue-soft);color:#174a78}.card-rows{display:grid;gap:3px}.card-row{display:grid;grid-template-columns:112px 1fr;gap:10px;padding:3px 0}.card-row>b{color:var(--muted);font-weight:550}.card-row small{display:block;color:var(--muted);font-size:10.5px;margin-top:1px}.dependency-rows{background:#f8fafc;border:1px solid var(--line);border-radius:10px;padding:7px 10px;margin:4px 0}.card-meta{border-top:1px solid #ececef;margin-top:11px;padding-top:8px;line-height:1.45;overflow-wrap:anywhere}.audit{display:inline-block;margin-left:6px}.audit summary{cursor:pointer;color:var(--blue)}.audit-list{display:grid;gap:6px;margin-top:8px}.audit-cell{display:grid;gap:2px;padding:7px;background:#fafafa;border-radius:8px}.audit-cell code{white-space:pre-wrap;overflow-wrap:anywhere;color:#344054}.rule-note{color:var(--amber)}@media(max-width:760px){main{padding:18px 10px 52px}.overview-grid,.freshness-grid{grid-template-columns:1fr}.card-head{display:block}.badges{margin-top:7px}.card-row{grid-template-columns:92px 1fr}header{padding:18px}.item-card{padding:13px 12px}}
.epic{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}.epic>summary{cursor:pointer;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:16px}.epic>summary:before{content:"▸";color:var(--muted)}.epic[open]>summary:before{content:"▾"}.e-st,.s{font-size:12px;border-radius:6px;padding:3px 7px;background:#f2f4f7;color:#344054}.epic[data-state-type=started] .e-st,.s-live{background:#ecfdf3;color:#05603a}.e-id,.kid-id{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px}.e-n{font-weight:650;flex:1;min-width:120px}.e-c{font-size:12px;color:var(--muted)}.e-wait{flex-basis:100%;margin-left:20px;color:var(--amber)}.e-b{padding:0 16px 16px}.kid{padding:14px 0;border-top:1px solid var(--line)}.kid-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.kid-a{margin:6px 0;color:#475467}.src{font-size:11px;color:var(--muted);margin-left:8px}.s-waiting{background:#fff4e5;color:#93370d}.s-free{background:#eff4ff;color:#174a78}.audit{display:block;margin:7px 0}.audit-head,.view-rule{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.view-rule{padding:6px 0}.lead-panel{margin-top:28px}.lead-panel>summary{cursor:pointer;color:var(--muted);padding:12px 0}.terminal-tail,.epic-hidden{color:var(--muted);font-size:12px}.unattached{margin-top:24px}.order-audit>summary{font-size:11px;color:var(--muted)}summary:focus-visible,a:focus-visible{outline:2px solid var(--blue);outline-offset:4px}.kid,.epic{overflow-wrap:anywhere}@media(max-width:600px){.e-c{flex-basis:100%;margin-left:20px}.e-b{padding:0 12px 12px}.epic>summary{padding:14px 12px}.kid-h{gap:6px}}

	footer{overflow-wrap:anywhere}
		.lead-note{background:#eff6ff;border-left:3px solid #3b82f6;border-radius:6px;padding:10px 12px;margin:7px 0;overflow-wrap:anywhere;color:#1e3a5f}.lead-note p{margin:5px 0;font-size:14px}.lead-note time,.lead-note small{display:block;font-size:11px;color:#475467}.lead-note [data-lead-stale]{margin-left:8px;font-size:11px}.lead-note-stale{background:#f8fafc;border-left-color:#cbd5e1;color:#334155}.root-entry{min-width:0}
.lead-note-compact{display:block;flex-basis:100%;min-width:0;max-width:100%;margin:0}.lead-note-compact .lead-note-text{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lead-note-compact time,.lead-note-compact small{display:block}
</style>
</head>
<body><main>
	<!-- Slot A: merged renderAttention(page, now) is first, including legacy fallback. -->
	<header data-generated-at="${escapeHtml(page.generated_at)}">
		<div class="eyebrow">${escapeHtml(label("page.overview"))}</div>
		<h1>${escapeHtml(page.key.project_name)} · ${escapeHtml(label("page.title"))}</h1>
		<div class="lede"><span>${page.header.roots.value?.length ?? 0} ${escapeHtml(label("page.roots_unit"))}</span><span>${page.items.length} ${escapeHtml(label("page.items_unit"))}</span><span>${escapeHtml(label("page.generated_at"))}: ${escapeHtml(page.generated_at)}</span><span>${escapeHtml(label("page.scope_rule_note"))}</span></div>
	</header>
 <div class="section-title"><h2>${escapeHtml(label("section.epics"))}</h2><span>${escapeHtml(label("section.epics_count", { n: view.epics.length }))}</span></div>
 <details class="audit order-audit"><summary>${escapeHtml(label("view.order_desc"))}</summary>${view.order ? renderViewRule(view.order, dictionary) : ""}</details>
 ${view.epics.length ? view.epics.map((epic) => renderEpic(page, epic, now, dictionary)).join("") : `<p>${escapeHtml(label("epic.none"))}</p>`}
 ${view.hiddenDoneEpics && view.hiddenDoneEpics.count > 0 ? `<div class="epic-hidden">${escapeHtml(label("epic.hidden_done", { n: view.hiddenDoneEpics.count }))}<details class="audit"><summary>${escapeHtml(label("cell.provenance"))}</summary>${renderViewRule(view.hiddenDoneEpics.view, dictionary)}</details></div>` : ""}
 ${view.unattached.length ? `<section class="unattached"><h2>${escapeHtml(label("epic.unattached"))}</h2>${view.unattached.map((c) => renderChild(page, c, dictionary, now)).join("")}</section>` : ""}
 <details class="lead-panel"><summary>${escapeHtml(label("section.lead_panel"))}</summary>
 ${headerCells.map(([field, name, cell]) => renderAuditCell(`/header/${field}`, name, cell, now, dictionary)).join("")}

	${renderFreshness(page)}
	${renderOverviewCell("/ready_items", label("section.ready"), readyContent, page.ready_items, now, dictionary, "ready-card")}
	${renderOverviewCell("/stuck_items", label("section.stuck"), stuckSummary(page), page.stuck_items, now, dictionary)}
	<article class="overview-card"><h2>${escapeHtml(label("section.waiting_founder"))}</h2><div class="overview-value">${waitingFounderSummary(page)}</div></article>
	${renderOverviewCell("/dependency_review", label("section.review"), renderDependencyReview(page.dependency_review.value ?? []), page.dependency_review, now, dictionary)}
	${renderOverviewCell("/header/roots", label("section.scope"), rootsContent || escapeHtml(label("page.none")), page.header.roots, now, dictionary)}
	<div class="overview-grid">
		${renderOverviewCell("/founder_items", label("section.founder"), founder.length > 0 ? founder.map((id) => `<span class="root-pill">${escapeHtml(id)}</span>`).join("") : escapeHtml(label("founder.none")), page.founder_items, now, dictionary)}
		${renderOverviewCell("/done_definition", label("section.done"), escapeHtml(`terminal_state=${page.done_definition.value?.terminal_state ?? label("page.none")}`), page.done_definition, now, dictionary)}
		${renderOverviewCell("/gaps", label("section.gaps"), page.gaps.value?.length ? escapeHtml(`${page.gaps.value.length} ${label("page.gaps_unit")}`) : escapeHtml(label("page.none")), page.gaps, now, dictionary)}
	</div>
 </details>
${dictionary.sidecar ? auditFooter(dictionary.sidecar) : ""}</main>${dictionary.sidecar ? "" : `<script type="application/json" id="epic-audit-data">${dictionary.json()}</script>`}<script nonce="__CSP_NONCE__">${dictionary.sidecar ? "" : '(()=>{const data=JSON.parse(document.getElementById("epic-audit-data").textContent);document.querySelectorAll("[data-fulltext]").forEach(e=>{e.title=data.texts[Number(e.getAttribute("data-fulltext"))];});document.querySelectorAll("[data-src]").forEach(cell=>{const [source,observed,updated]=data.cells[Number(cell.getAttribute("data-src"))];const p=data.sources[source];let text=p.kind==="linear"?p.entity+":"+p.id+" · "+p.field:p.kind==="derived"?p.rule+" · "+p.from.join(", "):p.table+" · "+JSON.stringify(p.key);text+=" · 看到 "+data.times[observed];if(updated!==undefined)text+=" · 源 "+data.times[updated];const span=document.createElement("span");span.className="cell-source";span.textContent=text;cell.append(span);});})();'}(()=>{const root=document.querySelector("[data-generated-at]");const age=document.querySelector("[data-opened-age]");const update=()=>{document.querySelectorAll("[data-lead-written-at]").forEach(note=>{const written=Date.parse(note.getAttribute("data-lead-written-at")||"");const days=Number(note.getAttribute("data-lead-fade-days"));if(!Number.isFinite(written)||!Number.isFinite(days)||days<=0)return;const elapsed=Math.max(0,Date.now()-written);const hours=Math.floor(elapsed/3600000);const relative=note.querySelector("[data-lead-relative]");if(relative)relative.textContent=note.getAttribute("data-lead-role")+" · "+(hours<1?"刚写":hours+" 小时前写");const stale=elapsed>days*86400000;note.classList.toggle("lead-note-stale",stale);const badge=note.querySelector("[data-lead-stale]");if(badge)badge.hidden=!stale;});if(!root||!age)return;const generated=Date.parse(root.getAttribute("data-generated-at")||"");if(Number.isFinite(generated)){const minutes=Math.max(0,Math.floor((Date.now()-generated)/60000));age.textContent="你打开时它已 "+minutes+" 分钟旧";}};update();setInterval(update,60000);})();</script></body></html>`;
}
