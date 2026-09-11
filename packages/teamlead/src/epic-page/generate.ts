import type { LinearActiveScopeSnapshot } from "../bridge/linear-epic-query.js";
import type { ProjectLinearBinding } from "../ProjectConfig.js";
import type {
	EpicItemFacts,
	EpicPageFactRead,
	EpicPageFreshnessRead,
	EpicPagePublicationRead,
	EpicPageTrigger,
	LeadNoteRecord,
} from "../StateStore.js";
import { type AttentionInput, buildAttention } from "./attention.js";
import { buildFreshness } from "./freshness.js";
import { DEFAULT_LEAD_NOTE_FADE_DAYS } from "./lead-note.js";
import type { EpicPageV1, EpicPageV2 } from "./model.js";
import {
	assertEpicPage,
	type Cell,
	type EpicItem,
	type EpicPage,
	type RefreshReason,
} from "./model.js";
import {
	computeDependencyReview,
	computeGaps,
	computeReady,
	computeRootCounts,
	doneDefinition,
	isFounderNamed,
	isSchedulable,
} from "./rules.js";
import type { EpicPageItemSignals } from "./signals.js";

export interface GenerateEpicPageInput {
	leadNotes?: LeadNoteRecord[];
	leadNoteFadeDays?: number;
	snapshot: LinearActiveScopeSnapshot;
	itemFacts: EpicItemFacts[];
	now: Date;
	projectName: string;
	trigger: EpicPageTrigger;
	version?: number;
	reasons?: RefreshReason[];
	itemSignals?: EpicPageItemSignals[];
	freshness?: {
		history: EpicPageFreshnessRead;
		publication?: EpicPagePublicationRead;
		scanSchedule?: { leadId: string; intervalMs: number };
	};
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

export interface GenerateAttentionEpicPageInput
	extends Omit<GenerateEpicPageInput, "snapshot"> {
	snapshot: LinearActiveScopeSnapshot | null;
	scopeBinding: ProjectLinearBinding;
	attention: AttentionInput;
	/** Only for an unsubmitted candidate immediately passed through the byte budget. */
	deferSizeValidation?: boolean;
}

/** Legacy v1 generation, retained for old-document fixtures and compatibility tests. */
export function generateEpicPage(input: GenerateEpicPageInput): EpicPageV1 {
	return generatePage(input) as EpicPageV1;
}
export function generateAttentionEpicPage(
	input: GenerateAttentionEpicPageInput,
): EpicPageV2 {
	if (!input.attention || !input.scopeBinding?.team)
		throw new Error(
			"Explicit attention sources and project binding are required",
		);
	return generatePage(input) as EpicPageV2;
}
function generatePage(
	input: GenerateEpicPageInput | GenerateAttentionEpicPageInput,
): EpicPage {
	const withAttention = "attention" in input;
	const generatedAt = input.now.toISOString();
	const snapshot: LinearActiveScopeSnapshot = input.snapshot ?? {
		fetchedAt: generatedAt,
		descendantIds: [],
		boundary: {
			teamKey: withAttention ? input.scopeBinding.team : "",
			project: withAttention ? (input.scopeBinding.project ?? null) : null,
			label: withAttention ? (input.scopeBinding.label ?? null) : null,
		},
		roots: [],
		items: [],
	};
	const extension = withAttention
		? buildAttention(input.attention, generatedAt)
		: null;
	if (input.itemFacts.length !== snapshot.items.length) {
		throw new Error("Epic item facts must match the Linear scope snapshot");
	}
	if (input.itemSignals && input.itemSignals.length !== snapshot.items.length) {
		throw new Error("Epic item signals must match the Linear scope snapshot");
	}
	const notesByIssue = new Map<string, Cell<string>[]>();
	for (const note of [...(input.leadNotes ?? [])].sort((a, b) =>
		a.role < b.role ? -1 : a.role > b.role ? 1 : 0,
	)) {
		const notes = notesByIssue.get(note.issue_uuid) ?? [];
		notes.push({
			value: note.text,
			provenance: {
				kind: "lead_note",
				role: note.role,
				written_at: note.written_at,
			},
			observed_at: generatedAt,
			source_updated_at: note.written_at,
		});
		notesByIssue.set(note.issue_uuid, notes);
	}
	const version = input.version ?? 1;
	const reasons =
		input.reasons ??
		(input.trigger === "event"
			? (["session_completed"] as const)
			: ([input.trigger] as const));
	const linearObservedAt = snapshot.fetchedAt;
	const items: EpicItem[] = snapshot.items.map((child, index) => {
		const facts = input.itemFacts[index]!;
		const itemSignals = input.itemSignals?.[index];
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
			...(notesByIssue.has(child.id)
				? { lead_note: notesByIssue.get(child.id)! }
				: {}),
			parent: {
				...linearCell(child.parent?.identifier ?? null, {
					...issueSource,
					entity: "issue",
					field: "parent",
				}),
				...(child.parent ? {} : { missing: { reason: "no_parent" as const } }),
			},
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
			signals: itemSignals?.signals ?? [],
			signal_sources: itemSignals?.signal_sources ?? {
				statestore: {
					value: { signals: 0 },
					provenance: {
						kind: "statestore",
						table: "sessions",
						key: {
							issue_id: child.id,
							issue_identifier: child.identifier,
						},
					},
					observed_at: generatedAt,
				},
				commdb: {
					value: { signals: 0 },
					provenance: {
						kind: "commdb",
						table: "questions",
						key: { issue_identifier: child.identifier },
					},
					observed_at: generatedAt,
				},
			},
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
	const readyItems = computeReady(items);
	const stuckItems = items
		.filter(isSchedulable)
		.flatMap((item) =>
			item.signals
				.filter(
					(
						signal,
					): signal is typeof signal & {
						kind: Exclude<typeof signal.kind, "waiting_founder">;
					} => signal.kind !== "waiting_founder",
				)
				.map((signal) => ({
					item: item.identifier,
					kind: signal.kind,
					since: signal.since,
					execution_id8: signal.execution_id8,
				})),
		)
		.sort(
			(left, right) =>
				left.since.localeCompare(right.since) ||
				left.item.localeCompare(right.item) ||
				left.kind.localeCompare(right.kind),
		);
	const stuckPointers = items.flatMap((item, itemIndex) =>
		!isSchedulable(item)
			? []
			: [
					...item.signals.flatMap((signal, signalIndex) =>
						signal.kind === "waiting_founder"
							? []
							: [`/items/${itemIndex}/signals/${signalIndex}`],
					),
					`/items/${itemIndex}/signal_sources/statestore`,
					`/items/${itemIndex}/signal_sources/commdb`,
				],
	);
	const sourceCells = [
		...snapshot.roots.flatMap((root, index) =>
			(notesByIssue.get(root.id) ?? []).map((note, noteIndex) => ({
				path: `/header/roots/value/${index}/lead_note/${noteIndex}`,
				observedAt: note.observed_at,
			})),
		),
		...items.flatMap((item, index) =>
			(item.lead_note ?? []).map((note, noteIndex) => ({
				path: `/items/${index}/lead_note/${noteIndex}`,
				observedAt: note.observed_at,
			})),
		),
		{ path: "/header/roots", observedAt: linearObservedAt },
		{ path: "/header/items", observedAt: linearObservedAt },
		...items.flatMap((item, index) => [
			{ path: `/items/${index}/parent`, observedAt: item.parent.observed_at },
			{ path: `/items/${index}/title`, observedAt: item.title.observed_at },
			{ path: `/items/${index}/url`, observedAt: item.url.observed_at },
			{ path: `/items/${index}/state`, observedAt: item.state.observed_at },
			{
				path: `/items/${index}/priority`,
				observedAt: item.priority.observed_at,
			},
			{
				path: `/items/${index}/blocked_by`,
				observedAt: item.blocked_by.observed_at,
			},
			{
				path: `/items/${index}/acceptance`,
				observedAt: item.acceptance.observed_at,
			},
			{
				path: `/items/${index}/founder_named`,
				observedAt: item.founder_named.observed_at,
			},
			{ path: `/items/${index}/session`, observedAt: item.session.observed_at },
			{ path: `/items/${index}/run`, observedAt: item.run.observed_at },
			{ path: `/items/${index}/attempt`, observedAt: item.attempt.observed_at },
			{ path: `/items/${index}/gates`, observedAt: item.gates.observed_at },
			{
				path: `/items/${index}/carriers`,
				observedAt: item.carriers.observed_at,
			},
			{ path: `/items/${index}/land`, observedAt: item.land.observed_at },
			{
				path: `/items/${index}/signal_sources/statestore`,
				observedAt: item.signal_sources.statestore.observed_at,
			},
			{
				path: `/items/${index}/signal_sources/commdb`,
				observedAt: item.signal_sources.commdb.observed_at,
			},
		]),
	];
	if (extension) {
		const collect = (value: unknown, path: string) => {
			if (!value || typeof value !== "object") return;
			if ("value" in value && "observed_at" in value && "provenance" in value) {
				const cell = value as Cell<unknown>;
				if (cell.provenance.kind !== "derived")
					sourceCells.push({ path, observedAt: cell.observed_at });
				return;
			}
			for (const [key, child] of Object.entries(value))
				collect(child, `${path}/${key}`);
		};
		collect(extension, "");
	}
	const freshness = buildFreshness({
		projectName: input.projectName,
		generatedAt,
		version,
		trigger: input.trigger,
		reasons: [...reasons].sort() as RefreshReason[],
		history: input.freshness?.history ?? {
			publish_failures_since_last_published: 0,
		},
		publication: input.freshness?.publication,
		sourceCells,
		scanSchedule: input.freshness?.scanSchedule,
	});
	const legacy: EpicPageV1 = {
		schema_version: 1,
		key: { project_name: input.projectName },
		generated_at: generatedAt,
		generator: {
			version: "epic-page/1",
			trigger: input.trigger,
			reasons: [...reasons].sort() as RefreshReason[],
		},
		header: {
			root_counts: computeRootCounts(items, snapshot.roots).map((result) => ({
				value: result.value,
				provenance: { kind: "derived", rule: "counts.v1", from: result.from },
				observed_at: generatedAt,
				...(result.missing ? { missing: result.missing } : {}),
			})),
			scope_definition: {
				value: {
					root_state_type: "started",
					daily_title_contains: "日常",
					item_state_filter: "none",
				},
				provenance: {
					kind: "derived",
					rule: "scope.v2",
					from: ["/header/roots", "/header/items"],
				},
				observed_at: generatedAt,
			},
			roots: linearCell(
				snapshot.roots.map((root) => ({
					identifier: root.identifier,
					title: root.title,
					url: root.url,
					state: root.state,
					...(notesByIssue.has(root.id)
						? { lead_note: notesByIssue.get(root.id)! }
						: {}),
				})),
				{
					entity: "issues",
					id: snapshot.boundary.teamKey,
					field: "state.type=started,parent=null,children!=null",
					observedAt: linearObservedAt,
				},
			),
			items: linearCell(
				items.map((item) => item.identifier),
				{
					entity: "children",
					id:
						snapshot.roots.map((root) => root.id).join(",") ||
						snapshot.boundary.teamKey,
					field: "subtree",
					observedAt: linearObservedAt,
				},
			),
		},
		items,
		lead_note_policy: {
			value: {
				fade_after_days: input.leadNoteFadeDays ?? DEFAULT_LEAD_NOTE_FADE_DAYS,
			},
			provenance: { kind: "derived", rule: "lead_note_fade.v1", from: [] },
			observed_at: generatedAt,
		},
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
			value: readyItems,
			provenance: {
				kind: "derived",
				rule: "ready.v1",
				from: itemPointers(["state", "priority", "blocked_by"]),
			},
			observed_at: generatedAt,
		},
		dependency_review: {
			value: computeDependencyReview(items, readyItems),
			provenance: {
				kind: "derived",
				rule: "subtraction.v1",
				from: [...itemPointers(["state", "blocked_by"]), "/ready_items"],
			},
			observed_at: generatedAt,
		},
		freshness,
		stuck_items: {
			value: stuckItems,
			provenance: {
				kind: "derived",
				rule: "signals.v1",
				from: stuckPointers,
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
	let page: EpicPage = legacy;
	if (extension && withAttention) {
		page = {
			...legacy,
			...extension,
			schema_version: 2,
			generator: { ...legacy.generator, version: "epic-page/2" },
			epic_scope: linearCell(
				{ available: true as const },
				{
					entity: "issues",
					id: input.scopeBinding.team,
					field: "active_scope",
					observedAt: snapshot.fetchedAt,
				},
			),
		};
		if (input.snapshot === null) {
			for (const cell of [
				page.epic_scope,
				page.header.roots,
				page.header.items,
				page.founder_items,
				page.ready_items,
				page.dependency_review,
				page.stuck_items,
				page.gaps,
			]) {
				cell.value = null;
				cell.missing = { reason: "epic_scope_unavailable" };
			}
		}
	}
	assertEpicPage(page, {
		deferSizeValidation: withAttention && input.deferSizeValidation,
	});
	return page;
}
