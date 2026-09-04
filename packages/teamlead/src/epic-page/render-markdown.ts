import { escapeMarkdownTableCell } from "./escape.js";
import { type LabelKey, label } from "./labels.js";
import type { Cell, EpicItem, EpicPage, Provenance } from "./model.js";

const FOUNDER_DECIDED_RULES = new Set([
	"scope.v1",
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

function markdownText(value: unknown): string {
	return escapeMarkdownTableCell(
		typeof value === "string" ? value : JSON.stringify(value),
	);
}

function markdownLink(url: string, text: string): string {
	return url.startsWith("https://linear.app/")
		? `[${markdownText(text)}](<${url}>)`
		: markdownText(text);
}

function markdownProvenance(provenance: Provenance): string {
	if (provenance.kind === "linear") {
		return markdownText(
			[
				label("cell.linear"),
				`${provenance.entity}:${provenance.id}`,
				provenance.field,
				provenance.url,
			]
				.filter(Boolean)
				.join(" · "),
		);
	}
	if (provenance.kind === "statestore") {
		return markdownText(
			`${provenance.table} · ${JSON.stringify(provenance.key)}`,
		);
	}
	return markdownText(
		`${provenance.rule} · ${label("cell.derived_from", {
			from: provenance.from.join(", ") || "[]",
		})}`,
	);
}

function derivedRuleNote(provenance: Provenance): string | null {
	if (provenance.kind !== "derived") return null;
	const ruling = FOUNDER_DECIDED_RULES.has(provenance.rule)
		? label("page.decided_rule_note", { rule: provenance.rule })
		: label("page.default_rule_note", { rule: provenance.rule });
	return `${ruling} · ${label("cell.derived_from", {
		from: provenance.from.join(", ") || "[]",
	})}`;
}

function renderCell(
	path: string,
	name: LabelKey,
	cell: Cell<unknown>,
	now: Date,
): string {
	const value =
		cell.value === null
			? `${cell.missing?.reason ?? label("cell.missing")}${
					cell.missing?.detail ? `:${cell.missing.detail}` : ""
				}`
			: markdownText(cell.value);
	const rule = derivedRuleNote(cell.provenance);
	return [
		`<!-- cell:${path} -->`,
		`**${label(name)}**`,
		`- ${label("cell.value")}: ${value}`,
		`- ${label("cell.provenance")}: ${markdownProvenance(cell.provenance)}`,
		`- ${label("cell.observed_at")}: ${cell.observed_at} (${relativeTime(cell.observed_at, now)})`,
		...(cell.source_updated_at
			? [
					`- ${label("cell.source_updated_at")}: ${cell.source_updated_at} (${relativeTime(cell.source_updated_at, now)})`,
				]
			: []),
		...(rule ? [`- ${markdownText(rule)}`] : []),
		"",
	].join("\n");
}

function executionSummary(item: EpicItem): string {
	const execution = item.session.value?.latest[0];
	return item.session.value
		? `${execution ? `${execution.status}/${execution.role ?? ""}(${execution.execution_id8})` : label("page.none")} · ledger_live_count=${item.session.value.ledger_live_count}`
		: (item.session.missing?.reason ?? label("page.none"));
}

function blockerSummary(item: EpicItem): string {
	if (!item.blocked_by.value) {
		return item.blocked_by.missing?.reason ?? label("cell.missing");
	}
	if (item.blocked_by.value.length === 0) return label("page.no_dependency");
	return item.blocked_by.value
		.map((blocker) => {
			const scope = blocker.in_scope
				? ""
				: ` ${label("page.external_dependency")}`;
			return `${markdownLink(blocker.url, `${blocker.identifier} · ${blocker.title}`)}${scope} · ${label("page.blocker_state", { state: blocker.blocker_state_type })}`;
		})
		.join("; ");
}

function dependentSummary(item: EpicItem): string {
	if (!item.blocks.value || item.blocks.value.length === 0) {
		return label("page.no_dependents");
	}
	return item.blocks.value
		.map((dependent) =>
			markdownLink(
				dependent.url,
				`${dependent.identifier} · ${dependent.title}`,
			),
		)
		.join("; ");
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

function renderItem(item: EpicItem, index: number, now: Date): string {
	const path = `/items/${index}`;
	const title = item.title.value ?? label("cell.missing");
	const state = item.state.value?.name ?? label("cell.missing");
	const acceptance =
		item.acceptance.value?.text ?? label("page.missing_acceptance");
	const dependents = dependentSummary(item);
	const why = item.blocks.value?.length
		? label("page.unlocks", {
				items: item.blocks.value
					.map((entry) => `${entry.identifier} · ${entry.title}`)
					.join(", "),
			})
		: label("page.no_dependents");
	return [
		`### ${markdownText(`${item.identifier} · ${title} · ${state}`)}`,
		`- **${label("page.what")}**: ${markdownText(title)}`,
		`- **${label("page.why")}**: ${markdownText(why)}`,
		`- **${label("page.done_outcome")}**: ${markdownText(acceptance)}`,
		`- **${label("page.waiting_for")}**: ${blockerSummary(item)}`,
		`- **${label("page.waiting_on_me")}**: ${dependents}`,
		`- **${label("cell.item.state")}**: ${markdownText(`${state} (${item.state.value?.type ?? label("cell.missing")})`)}`,
		`- **${label("page.accounted_execution")}**: ${markdownText(executionSummary(item))} · ${label("cell.ledger_note")}`,
		`- **founder**: ${item.founder_named.value ? label("page.founder_yes") : label("page.founder_no")}`,
		`- **${label("page.source_link")}**: ${item.url.value ? markdownLink(item.url.value, item.url.value) : label("page.none")} · **${label("cell.observed_at")}**: ${item.title.observed_at}${item.title.source_updated_at ? ` · **${label("cell.source_updated_at")}**: ${item.title.source_updated_at}` : ""}`,
		"",
		...itemCells(item).map(([field, name, cell]) =>
			renderCell(`${path}/${field}`, name, cell, now),
		),
	].join("\n");
}

export function renderEpicPageMarkdown(
	page: EpicPage,
	now = new Date(),
): string {
	const ready = page.ready_items.value ?? [];
	const founder = page.founder_items.value ?? [];
	const itemById = new Map(page.items.map((item) => [item.identifier, item]));
	const readySummary = ready.length
		? ready
				.map((identifier) => {
					const item = itemById.get(identifier);
					return item?.url.value
						? markdownLink(
								item.url.value,
								`${identifier} · ${item.title.value ?? ""}`,
							)
						: markdownText(identifier);
				})
				.join(", ")
		: label("page.none");
	const roots = (page.header.roots.value ?? [])
		.map((root) => markdownLink(root.url, `${root.identifier} · ${root.title}`))
		.join(", ");
	return [
		`# ${label("page.title")}: ${markdownText(page.key.project_name)}`,
		`${label("page.generated_at")}: ${page.generated_at}`,
		`## ${label("section.ready")}`,
		label("page.ready_rule_note"),
		readySummary,
		renderCell("/ready_items", "cell.ready_items", page.ready_items, now),
		`## ${label("section.scope")}`,
		roots || label("page.none"),
		renderCell(
			"/header/scope_definition",
			"cell.header.scope_definition",
			page.header.scope_definition,
			now,
		),
		renderCell("/header/roots", "cell.header.roots", page.header.roots, now),
		renderCell("/header/items", "cell.header.items", page.header.items, now),
		`## ${label("section.founder")}`,
		founder.length > 0
			? founder.map(markdownText).join(", ")
			: label("founder.none"),
		renderCell("/founder_items", "cell.founder_items", page.founder_items, now),
		`## ${label("section.done")}`,
		renderCell(
			"/done_definition",
			"cell.done_definition",
			page.done_definition,
			now,
		),
		`## ${label("section.gaps")}`,
		renderCell("/gaps", "cell.gaps", page.gaps, now),
		`## ${label("section.what")}`,
		...page.items.map((item, index) => renderItem(item, index, now)),
	].join("\n\n");
}
