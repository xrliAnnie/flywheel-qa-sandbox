import type { LinearActiveScopeSnapshot } from "../bridge/linear-epic-query.js";
import type {
	EpicItemFacts,
	EpicPageFactRead,
	EpicPageTrigger,
} from "../StateStore.js";
import {
	assertEpicPage,
	type Cell,
	type EpicItem,
	type EpicPage,
} from "./model.js";
import {
	computeGaps,
	computeReady,
	doneDefinition,
	isFounderNamed,
} from "./rules.js";

export interface GenerateEpicPageInput {
	snapshot: LinearActiveScopeSnapshot;
	itemFacts: EpicItemFacts[];
	now: Date;
	projectName: string;
	trigger: EpicPageTrigger;
}

function linearCell<T>(
	value: T,
	input: {
		entity: "issue" | "issues" | "relation" | "label" | "children";
		id: string;
		field?: string;
		url?: string;
		observedAt: string;
		sourceUpdatedAt?: string;
	},
): Cell<T> {
	return {
		value,
		provenance: {
			kind: "linear",
			entity: input.entity,
			id: input.id,
			...(input.field ? { field: input.field } : {}),
			...(input.url ? { url: input.url } : {}),
		},
		observed_at: input.observedAt,
		...(input.sourceUpdatedAt
			? { source_updated_at: input.sourceUpdatedAt }
			: {}),
	};
}

function statestoreCell<T>(
	fact: EpicPageFactRead<T>,
	table: string,
	child: LinearActiveScopeSnapshot["items"][number],
	observedAt: string,
): Cell<T> {
	const base = {
		provenance: {
			kind: "statestore" as const,
			table,
			key: { issue_id: child.id, issue_identifier: child.identifier },
		},
		observed_at: observedAt,
	};
	if (!fact.ok) {
		return {
			...base,
			value: null,
			missing: { reason: "statestore_error", detail: fact.table },
		};
	}
	return {
		...base,
		value: fact.value,
		...(fact.source_updated_at
			? { source_updated_at: fact.source_updated_at }
			: {}),
	};
}

export function generateEpicPage(input: GenerateEpicPageInput): EpicPage {
	if (input.itemFacts.length !== input.snapshot.items.length) {
		throw new Error("Epic item facts must match the Linear scope snapshot");
	}
	const generatedAt = input.now.toISOString();
	const linearObservedAt = input.snapshot.fetchedAt;
	const items: EpicItem[] = input.snapshot.items.map((child, index) => {
		const facts = input.itemFacts[index]!;
		const issueSource = {
			id: child.id,
			url: child.url,
			observedAt: linearObservedAt,
			sourceUpdatedAt: child.updatedAt,
		};
		const acceptance: EpicItem["acceptance"] = child.acceptance
			? linearCell(child.acceptance, {
					...issueSource,
					entity: "issue",
					field: "description",
				})
			: {
					...linearCell(null, {
						...issueSource,
						entity: "issue",
						field: "description",
					}),
					missing: { reason: "no_acceptance_section" },
				};
		return {
			identifier: child.identifier,
			title: linearCell(child.title, {
				...issueSource,
				entity: "issue",
				field: "title",
			}),
			url: linearCell(child.url, {
				...issueSource,
				entity: "issue",
				field: "url",
			}),
			state: linearCell(child.state, {
				...issueSource,
				entity: "issue",
				field: "state",
			}),
			priority: linearCell(child.priority, {
				...issueSource,
				entity: "issue",
				field: "priority",
			}),
			blocked_by: linearCell(
				child.blockedBy.map((blocker) => ({
					identifier: blocker.identifier,
					title: blocker.title,
					url: blocker.url,
					in_scope: blocker.inScope,
					blocker_state_type: blocker.stateType,
				})),
				{
					...issueSource,
					entity: "relation",
					field: "inverseRelations",
				},
			),
			blocks: {
				value: [],
				provenance: {
					kind: "derived",
					rule: "dependents.v1",
					from: [],
				},
				observed_at: generatedAt,
			},
			acceptance,
			founder_named: linearCell(isFounderNamed(child.labels), {
				...issueSource,
				entity: "label",
				field: "labels",
			}),
			session: statestoreCell(facts.session, "sessions", child, generatedAt),
			run: statestoreCell(facts.run, "workflow_run", child, generatedAt),
			attempt: statestoreCell(
				facts.attempt,
				"workflow_run_node",
				child,
				generatedAt,
			),
			gates: statestoreCell(
				facts.gates,
				"workflow_gate_holder",
				child,
				generatedAt,
			),
			carriers: statestoreCell(
				facts.carriers,
				"workflow_carrier_delivery",
				child,
				generatedAt,
			),
			land: statestoreCell(facts.land, "land_operation", child, generatedAt),
			signals: [],
		};
	});
	for (const item of items) {
		const dependents = items.flatMap((candidate, index) =>
			candidate.blocked_by.value?.some(
				(blocker) => blocker.in_scope && blocker.identifier === item.identifier,
			)
				? [{ candidate, index }]
				: [],
		);
		item.blocks = {
			value: dependents.map(({ candidate }) => ({
				identifier: candidate.identifier,
				title: candidate.title.value!,
				url: candidate.url.value!,
				state_type: candidate.state.value!.type,
			})),
			provenance: {
				kind: "derived",
				rule: "dependents.v1",
				from: dependents.map(({ index }) => `/items/${index}/blocked_by`),
			},
			observed_at: generatedAt,
		};
	}

	const founderItems = items
		.filter((item) => item.founder_named.value === true)
		.map((item) => item.identifier);
	const gaps =
		items.length === 0
			? [
					{
						item: input.projectName,
						face: "what" as const,
						reason: "no_children" as const,
					},
				]
			: computeGaps(items);

	const itemPointers = (cells: string[]) =>
		items.flatMap((_item, index) =>
			cells.map((cell) => `/items/${index}/${cell}`),
		);
	const page: EpicPage = {
		schema_version: 1,
		key: { project_name: input.projectName },
		generated_at: generatedAt,
		generator: { version: "epic-page/1", trigger: input.trigger },
		header: {
			scope_definition: {
				value: {
					root_state_type: "started",
					daily_title_contains: "日常",
					excluded_item_state_type: "backlog",
				},
				provenance: {
					kind: "derived",
					rule: "scope.v1",
					from: ["/header/roots", "/header/items"],
				},
				observed_at: generatedAt,
			},
			roots: linearCell(
				input.snapshot.roots.map((root) => ({
					identifier: root.identifier,
					title: root.title,
					url: root.url,
					state: root.state,
				})),
				{
					entity: "issues",
					id: input.snapshot.boundary.teamKey,
					field: "state.type=started,parent=null,children!=null",
					observedAt: linearObservedAt,
				},
			),
			items: linearCell(
				items.map((item) => item.identifier),
				{
					entity: "children",
					id: input.snapshot.roots.map((root) => root.id).join(","),
					field: "subtree,state.type!=backlog",
					observedAt: linearObservedAt,
				},
			),
		},
		items,
		done_definition: doneDefinition(generatedAt),
		founder_items: {
			value: founderItems,
			provenance: {
				kind: "derived",
				rule: "founder.v1",
				from: itemPointers(["founder_named"]),
			},
			observed_at: generatedAt,
		},
		ready_items: {
			value: computeReady(items),
			provenance: {
				kind: "derived",
				rule: "ready.v1",
				from: itemPointers(["state", "priority", "blocked_by"]),
			},
			observed_at: generatedAt,
		},
		gaps: {
			value: gaps,
			provenance: {
				kind: "derived",
				rule: "gaps.v1",
				from:
					items.length === 0
						? ["/header/items"]
						: itemPointers([
								"title",
								"acceptance",
								"founder_named",
								"session",
								"run",
								"attempt",
								"gates",
								"carriers",
								"land",
							]),
			},
			observed_at: generatedAt,
		},
	};
	assertEpicPage(page);
	return page;
}
