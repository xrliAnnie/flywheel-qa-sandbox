import { escapeHtml } from "../bridge/xhs-review-html.js";
import { type LabelKey, label } from "./labels.js";
import type {
	Cell,
	DependencyReviewEntry,
	EpicItem,
	EpicPage,
	Provenance,
	Signal,
	StuckItem,
} from "./model.js";

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
): string {
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

function blockerList(item: EpicItem): string {
	if (!item.blocked_by.value) {
		return escapeHtml(item.blocked_by.missing?.reason ?? label("cell.missing"));
	}
	if (item.blocked_by.value.length === 0) {
		return escapeHtml(label("page.no_dependency"));
	}
	return item.blocked_by.value
		.map((blocker) => {
			const reference = safeLinearLink(
				blocker.url,
				`${blocker.identifier} · ${blocker.title}`,
			);
			const scope = blocker.in_scope
				? ""
				: ` ${escapeHtml(label("page.external_dependency"))}`;
			return `${reference}${scope} <small>${escapeHtml(
				label("page.blocker_state", { state: blocker.blocker_state_type }),
			)}</small>`;
		})
		.join("<br>");
}

function dependentList(item: EpicItem): string {
	if (!item.blocks.value || item.blocks.value.length === 0) {
		return escapeHtml(label("page.no_dependents"));
	}
	return item.blocks.value
		.map((dependent) =>
			safeLinearLink(
				dependent.url,
				`${dependent.identifier} · ${dependent.title}`,
			),
		)
		.join("<br>");
}

function whySummary(item: EpicItem): string {
	if (!item.blocks.value || item.blocks.value.length === 0) {
		return label("page.no_dependents");
	}
	return label("page.unlocks", {
		items: item.blocks.value
			.map((entry) => `${entry.identifier} · ${entry.title}`)
			.join(", "),
	});
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

function renderItem(item: EpicItem, index: number, now: Date): string {
	const path = `/items/${index}`;
	const title =
		item.title.value ?? item.title.missing?.reason ?? label("cell.missing");
	const state =
		item.state.value?.name ??
		item.state.missing?.reason ??
		label("cell.missing");
	const issueUrl = item.url.value;
	const sourceLink =
		typeof issueUrl === "string"
			? safeLinearLink(issueUrl, issueUrl)
			: escapeHtml(label("page.none"));
	const auditCells = itemCells(item);
	return `<article class="item-card">
	<div class="card-head">
		<h3>${escapeHtml(item.identifier)} · ${escapeHtml(title)} · ${escapeHtml(state)}</h3>
		<div class="badges"><span>P${escapeHtml(String(item.priority.value ?? 0))}</span><span>${escapeHtml(item.founder_named.value ? label("page.founder_yes") : label("page.founder_no"))}</span></div>
	</div>
	<div class="card-rows">
		<div class="card-row"><b>${escapeHtml(label("page.what"))}</b><span>${escapeHtml(title)}</span></div>
		<div class="card-row"><b>${escapeHtml(label("page.why"))}</b><span>${escapeHtml(whySummary(item))}<small>${derivedRuleNote(item.blocks.provenance)}</small></span></div>
		<div class="card-row"><b>${escapeHtml(label("page.done_outcome"))}</b><span>${escapeHtml(acceptanceSummary(item))}</span></div>
		<div class="dependency-rows">
			<div class="card-row"><b>${escapeHtml(label("page.waiting_for"))}</b><span>${blockerList(item)}</span></div>
			<div class="card-row"><b>${escapeHtml(label("page.waiting_on_me"))}</b><span>${dependentList(item)}<small>${derivedRuleNote(item.blocks.provenance)}</small></span></div>
		</div>
		<div class="card-row"><b>${escapeHtml(label("cell.item.state"))}</b><span>${escapeHtml(state)} (${escapeHtml(item.state.value?.type ?? label("cell.missing"))})</span></div>
		<div class="card-row"><b>${escapeHtml(label("page.accounted_execution"))}</b><span>${escapeHtml(executionSummary(item))}<small>${escapeHtml(label("cell.ledger_note"))}</small></span></div>
		<div class="card-row"><b>${escapeHtml(label("section.stuck"))}</b><span>${signalList(item.signals.filter((signal) => signal.kind !== "waiting_founder"))}</span></div>
		<div class="card-row"><b>${escapeHtml(label("section.waiting_founder"))}</b><span>${signalList(item.signals.filter((signal) => signal.kind === "waiting_founder"))}</span></div>
		<div class="card-row"><b>founder</b><span>${escapeHtml(item.founder_named.value ? label("page.founder_yes") : label("page.founder_no"))}</span></div>
	</div>
	<footer class="card-meta"><span><b>${escapeHtml(label("page.source_link"))}:</b> ${sourceLink}</span> · <span><b>${escapeHtml(label("cell.observed_at"))}:</b> ${escapeHtml(item.title.observed_at)}</span>${item.title.source_updated_at ? ` · <span><b>${escapeHtml(label("cell.source_updated_at"))}:</b> ${escapeHtml(item.title.source_updated_at)}</span>` : ""}
		<details class="audit"><summary>${escapeHtml(label("page.all_cells", { count: auditCells.length }))}</summary><div class="audit-list">${auditCells
			.map(([field, name, cell]) =>
				renderAuditCell(`${path}/${field}`, name, cell, now),
			)
			.join("")}</div></details>
	</footer>
</article>`;
}

function renderOverviewCell(
	path: string,
	title: string,
	content: string,
	cell: Cell<unknown>,
	now: Date,
	className = "overview-card",
): string {
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

export function renderEpicPageHtml(page: EpicPage, now = new Date()): string {
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
		["roots", "cell.header.roots", page.header.roots],
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
	</style>
</head>
<body><main>
	<header data-generated-at="${escapeHtml(page.generated_at)}">
		<div class="eyebrow">${escapeHtml(label("page.overview"))}</div>
		<h1>${escapeHtml(page.key.project_name)} · ${escapeHtml(label("page.title"))}</h1>
		<div class="lede"><span>${page.header.roots.value?.length ?? 0} ${escapeHtml(label("page.roots_unit"))}</span><span>${page.items.length} ${escapeHtml(label("page.items_unit"))}</span><span>${escapeHtml(label("page.generated_at"))}: ${escapeHtml(page.generated_at)}</span><span>${escapeHtml(label("page.scope_rule_note"))}</span></div>
		<details class="audit"><summary>${escapeHtml(label("page.all_cells", { count: headerCells.length }))}</summary><div class="audit-list">${headerCells.map(([field, name, cell]) => renderAuditCell(`/header/${field}`, name, cell, now)).join("")}</div></details>
	</header>
	${renderFreshness(page)}
	${renderOverviewCell("/ready_items", label("section.ready"), readyContent, page.ready_items, now, "ready-card")}
	${renderOverviewCell("/stuck_items", label("section.stuck"), stuckSummary(page), page.stuck_items, now)}
	<article class="overview-card"><h2>${escapeHtml(label("section.waiting_founder"))}</h2><div class="overview-value">${waitingFounderSummary(page)}</div></article>
	${renderOverviewCell("/dependency_review", label("section.review"), renderDependencyReview(page.dependency_review.value ?? []), page.dependency_review, now)}
	${renderOverviewCell("/header/roots", label("section.scope"), rootsContent || escapeHtml(label("page.none")), page.header.roots, now)}
	<div class="overview-grid">
		${renderOverviewCell("/founder_items", label("section.founder"), founder.length > 0 ? founder.map((id) => `<span class="root-pill">${escapeHtml(id)}</span>`).join("") : escapeHtml(label("founder.none")), page.founder_items, now)}
		${renderOverviewCell("/done_definition", label("section.done"), escapeHtml(`terminal_state=${page.done_definition.value?.terminal_state ?? label("page.none")}`), page.done_definition, now)}
		${renderOverviewCell("/gaps", label("section.gaps"), page.gaps.value?.length ? escapeHtml(`${page.gaps.value.length} ${label("page.gaps_unit")}`) : escapeHtml(label("page.none")), page.gaps, now)}
	</div>
	<div class="section-title"><h2>${escapeHtml(label("section.what"))}</h2><span>${page.items.length} ${escapeHtml(label("page.items_unit"))} · ${escapeHtml(label("cell.ledger_note"))}</span></div>
	${page.items.map((item, index) => renderItem(item, index, now)).join("")}
</main><script nonce="__CSP_NONCE__">(()=>{const root=document.querySelector("[data-generated-at]");const age=document.querySelector("[data-opened-age]");if(!root||!age)return;const update=()=>{const generated=Date.parse(root.getAttribute("data-generated-at")||"");if(Number.isFinite(generated)){const minutes=Math.max(0,Math.floor((Date.now()-generated)/60000));age.textContent="你打开时它已 "+minutes+" 分钟旧";}};update();setInterval(update,60000);})();</script></body></html>`;
}
