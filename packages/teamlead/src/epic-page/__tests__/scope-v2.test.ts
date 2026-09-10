import { canonicalJsonString } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { generateEpicPage } from "../generate.js";
import {
	assertEpicPage,
	type EpicPage,
	EpicPageSchemaError,
} from "../model.js";
import { summarizeEpicResidual } from "../residual.js";
import {
	computeDependencyReview,
	computeRootCounts,
	isSchedulable,
} from "../rules.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
	filterV1,
	epicShapeSnapshotV2 as snapshotV2,
} from "./fixtures/epic-shape.js";

function generate(snapshot = epicShapeSnapshot()) {
	return generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "scan",
	});
}
const zero = {
	live: 0,
	waiting: 0,
	free: 0,
	idle: 0,
	done: 0,
	canceled: 0,
	total: 0,
};
function refreshCounts(page: EpicPage) {
	page.header.root_counts = computeRootCounts(
		page.items,
		page.header.roots.value!,
	).map((result) => ({
		value: result.value,
		provenance: { kind: "derived", rule: "counts.v1", from: result.from },
		observed_at: page.generated_at,
		...(result.missing ? { missing: result.missing } : {}),
	}));
}

describe("scope.v2 projection and regression", () => {
	it("keeps the complete subtree, honest parent Cells and root counts", () => {
		const page = generate(snapshotV2());
		expect(page.header.scope_definition.value).toEqual({
			root_state_type: "started",
			daily_title_contains: "日常",
			item_state_filter: "none",
		});
		expect(page.header.scope_definition.provenance).toMatchObject({
			rule: "scope.v2",
		});
		expect(page.header.items.provenance).toMatchObject({ field: "subtree" });
		expect(page.header.root_counts.map((cell) => cell.value)).toEqual([
			{
				root: "EPX-100",
				counts: { ...zero, idle: 2, waiting: 5, free: 1, total: 8 },
			},
			{ root: "EPX-200", counts: { ...zero, idle: 1, total: 1 } },
		]);
		for (const [index, item] of page.items.entries())
			expect(item.parent).toMatchObject({
				value: snapshotV2().items[index]!.parent!.identifier,
				provenance: {
					kind: "linear",
					entity: "issue",
					id: snapshotV2().items[index]!.id,
					field: "parent",
				},
			});
		expect(
			page.items[6]!.blocks.value?.map((item) => item.identifier),
		).toContain("EPX-9");
		expect(
			page.items[5]!.blocks.value?.map((item) => item.identifier),
		).toContain("EPX-8");
		expect(page.items[8]!.blocked_by.value![0]!.in_scope).toBe(true);
	});
	it("emits no_parent and a gap without assigning a root", () => {
		const snapshot = epicShapeSnapshot();
		snapshot.items[0]!.parent = null;
		const page = generate(snapshot);
		expect(page.items[0]!.parent).toMatchObject({
			value: null,
			missing: { reason: "no_parent" },
		});
		expect(page.gaps.value).toContainEqual({
			item: "EPX-1",
			face: "parent",
			reason: "no_parent",
		});
		expect(page.header.root_counts[0]!.value!.counts.total).toBe(4);
	});
	it("preserves all three rule values on a frozen snapshot, including backlog signals", () => {
		const snapshot = snapshotV2();
		function withSignals(s: typeof snapshot) {
			const page = generate(s);
			const signals = page.items.map((item) => ({
				signals:
					item.identifier === "EPX-7"
						? [
								{
									kind: "question_pending" as const,
									since: page.generated_at,
									execution_id8: "exec7",
									observed_at: page.generated_at,
									provenance: {
										kind: "commdb" as const,
										table: "questions",
										key: { issue_identifier: "EPX-7" },
									},
								},
							]
						: [],
				signal_sources: structuredClone(item.signal_sources),
			}));
			for (const signal of signals)
				signal.signal_sources.commdb.value!.signals = signal.signals.length;
			return generateEpicPage({
				snapshot: s,
				itemFacts: s.items.map(() => emptyItemFacts()),
				itemSignals: signals,
				now: EPIC_SHAPE_NOW,
				projectName: "example",
				trigger: "scan",
			});
		}
		const page = withSignals(snapshot),
			old = withSignals(filterV1(snapshot));
		for (const key of [
			"ready_items",
			"dependency_review",
			"stuck_items",
		] as const)
			expect(canonicalJsonString(page[key].value)).toBe(
				canonicalJsonString(old[key].value),
			);
		expect(
			page.items.find((item) => item.identifier === "EPX-7")!.signals,
		).toHaveLength(1);
	});
	it("preserves residual values even when a backlog session is unreadable", () => {
		const snapshot = snapshotV2(),
			oldSnapshot = filterV1(snapshot);
		const page = generate(snapshot),
			old = generate(oldSnapshot);
		page.items[5]!.session = {
			...page.items[5]!.session,
			value: null,
			missing: { reason: "statestore_error" },
		};
		const summarize = (p: EpicPage, s: typeof snapshot) =>
			summarizeEpicResidual({
				materialized: { page: p, snapshot: s },
				leadId: "example-eng-lead",
				resolveOwner: () => ({
					agentId: "example-eng-lead",
					matchMethod: "general",
					canSpawn: true,
				}),
				trigger: "roster",
			});
		expect(summarize(page, snapshot)).toEqual(summarize(old, oldSnapshot));
	});
	it("excludes backlog cycles and canceled blockers while retaining explanatory cross-domain edges", () => {
		const page = generate(snapshotV2());
		const a = page.items[8]!,
			b = page.items[6]!;
		const base = { ...a.blocked_by.value![0]!, in_scope: false };
		const alone = structuredClone(a);
		alone.blocked_by.value = [base];
		// Every other schedulable item is removed so all_blocked is nonempty.
		expect(computeDependencyReview([a, b], [])).toEqual(
			computeDependencyReview([alone], []),
		);
		expect(computeDependencyReview([a, b], [])).toEqual([
			{
				kind: "all_blocked",
				non_terminal: 1,
				blocking_edges: [
					{
						blocker: "EPX-7",
						blocked: "EPX-9",
						blocker_state_type: "backlog",
						in_scope: false,
					},
				],
				blocking_edges_truncated: false,
			},
		]);
		const c = structuredClone(b);
		c.identifier = "EPX-C";
		b.blocked_by.value = [
			{ ...base, identifier: c.identifier },
			{ ...base, identifier: "OUT", blocker_state_type: "canceled" },
		];
		c.blocked_by.value = [{ ...base, identifier: b.identifier }];
		expect(computeDependencyReview([b, c], [])).toEqual([]);
		expect(isSchedulable(b)).toBe(false);
		const roots = page.header.roots.value!;
		expect(computeRootCounts([a, b], roots)[0]!.value!.counts.waiting).toBe(1);
	});
});

describe("counts.v1", () => {
	it("classifies six states, treats canceled blockers as waiting and emits zeros for empty roots", () => {
		const page = generate();
		const template = page.items[0]!;
		const items = [
			"started",
			"backlog",
			"unstarted",
			"triage",
			"completed",
			"canceled",
		].map((type, i) => ({
			...structuredClone(template),
			identifier: `X-${i}`,
			state: { ...template.state, value: { name: type, type } },
		}));
		const blocker = {
			identifier: "OUT",
			title: "Outside",
			url: "https://linear.app/out",
			in_scope: false,
			blocker_state_type: "canceled",
		};
		items[1]!.blocked_by.value = [blocker];
		items[2]!.blocked_by.value = [
			{ ...blocker, blocker_state_type: "completed" },
		];
		const counts = computeRootCounts(items, page.header.roots.value!);
		expect(counts.map((result) => result.value)).toEqual([
			{
				root: "EPX-100",
				counts: {
					live: 1,
					waiting: 1,
					free: 1,
					idle: 1,
					done: 1,
					canceled: 1,
					total: 6,
				},
			},
			{ root: "EPX-200", counts: zero },
		]);
		expect(counts[0]!.from).toEqual([
			"/header/roots",
			...items.map((_, i) => `/items/${i}/parent`),
			...items.flatMap((_, i) => [
				`/items/${i}/state`,
				`/items/${i}/blocked_by`,
			]),
		]);
		expect(computeRootCounts(items, page.header.roots.value!)).toEqual(counts);
	});
	it("follows nested parents and rejects dangling or cyclic chains", () => {
		const page = generate();
		page.items[1]!.parent.value = "EPX-1";
		expect(
			computeRootCounts(page.items, page.header.roots.value!)[0]!.value!.counts
				.total,
		).toBe(5);
		page.items[0]!.parent.value = "unknown";
		expect(() =>
			computeRootCounts(page.items, page.header.roots.value!),
		).toThrow(EpicPageSchemaError);
		page.items[0]!.parent.value = "EPX-2";
		expect(() =>
			computeRootCounts(page.items, page.header.roots.value!),
		).toThrow(EpicPageSchemaError);
	});
	it("makes only the affected root missing for unknown state types", () => {
		const snapshot = epicShapeSnapshot();
		snapshot.items[0]!.state.type = "future";
		const page = generate(snapshot);
		expect(page.header.root_counts[0]).toMatchObject({
			value: null,
			missing: { reason: "unknown_state_type", detail: "future" },
		});
		expect(page.header.root_counts[1]!.value!.counts).toEqual(zero);
		expect(() => assertEpicPage(page)).not.toThrow();
	});
	it.each(["state", "blocked_by"] as const)(
		"rejects null %s in the pure function and validator",
		(key) => {
			const page = generate();
			page.items[0]![key].value = null;
			page.items[0]![key].missing = { reason: "statestore_error" };
			expect(() =>
				computeRootCounts(page.items, page.header.roots.value!),
			).toThrow(EpicPageSchemaError);
			expect(() => assertEpicPage(page)).toThrow(EpicPageSchemaError);
		},
	);
	it.each([
		"backlog",
		"unstarted",
		"triage",
		"started",
		"completed",
		"canceled",
	])("pins schedulable domain for %s", (type) => {
		const item = generate().items[0]!;
		item.state.value!.type = type;
		expect(isSchedulable(item)).toBe(type !== "backlog");
	});
});

describe("scope.v2 validator negative guards", () => {
	const mutations: Array<[string, (page: any) => void]> = [
		[
			"old rule",
			(p) => {
				p.header.scope_definition.provenance.rule = "scope.v1";
			},
		],
		[
			"old filter key",
			(p) => {
				p.header.scope_definition.value.excluded_item_state_type = "backlog";
			},
		],
		[
			"wrong filter",
			(p) => {
				p.header.scope_definition.value.item_state_filter = "backlog";
			},
		],
		[
			"missing counts",
			(p) => {
				delete p.header.root_counts;
			},
		],
		[
			"count length",
			(p) => {
				p.header.root_counts.pop();
			},
		],
		[
			"count root order",
			(p) => {
				p.header.root_counts.reverse();
			},
		],
		[
			"total mismatch",
			(p) => {
				p.header.root_counts[0].value.counts.total++;
			},
		],
		[
			"tampered counts",
			(p) => {
				p.header.root_counts[0].value.counts.idle--;
				p.header.root_counts[0].value.counts.waiting++;
			},
		],
		[
			"negative count",
			(p) => {
				p.header.root_counts[0].value.counts.live = -1;
			},
		],
		[
			"fraction count",
			(p) => {
				p.header.root_counts[0].value.counts.live = 0.5;
			},
		],
		[
			"wrong count provenance",
			(p) => {
				p.header.root_counts[0].provenance.rule = "ready.v1";
			},
		],
		[
			"incomplete count pointers",
			(p) => {
				p.header.root_counts[0].provenance.from.pop();
			},
		],
		[
			"null roots",
			(p) => {
				p.header.roots.value = null;
				p.header.roots.missing = { reason: "no_children" };
			},
		],
		[
			"duplicate roots",
			(p) => {
				p.header.roots.value[1] = p.header.roots.value[0];
			},
		],
		[
			"root item collision",
			(p) => {
				p.header.roots.value[0].identifier = p.items[0].identifier;
			},
		],
		[
			"numeric parent",
			(p) => {
				p.items[0].parent.value = 5;
			},
		],
		[
			"wrong parent source id",
			(p) => {
				p.items[0].parent.provenance.id = "other";
			},
		],
		[
			"wrong parent field",
			(p) => {
				p.items[0].parent.provenance.field = "title";
			},
		],
		[
			"wrong parent missing reason",
			(p) => {
				p.items[0].parent.value = null;
				p.items[0].parent.missing = { reason: "statestore_error" };
			},
		],
	];
	it.each(mutations)("rejects %s", (_name, mutate) => {
		const page = generate();
		mutate(page);
		expect(() => assertEpicPage(page)).toThrow(EpicPageSchemaError);
	});
	it("rejects no_parent without its gap", () => {
		const page = generate();
		page.items[0]!.parent.value = null;
		page.items[0]!.parent.missing = { reason: "no_parent" };
		refreshCounts(page);
		expect(() => assertEpicPage(page)).toThrow(/absent from gaps/);
	});
});

describe("scope.v2 capacity", () => {
	it("fits 200 parent-bearing children across six roots in the existing document bound", () => {
		const snapshot = snapshotV2();
		snapshot.roots = Array.from({ length: 6 }, (_, index) => ({
			...snapshot.roots[0]!,
			id: `root-${index}`,
			identifier: `ROOT-${index}`,
		}));
		const source = snapshot.items;
		snapshot.items = Array.from({ length: 200 }, (_, index) => {
			const root = snapshot.roots[index % 6]!;
			return {
				...structuredClone(source[index % source.length]!),
				id: `capacity-${index}`,
				identifier: `CAP-${index}`,
				parent: { id: root.id, identifier: root.identifier },
			};
		});
		snapshot.descendantIds = snapshot.items.map((item) => item.id);
		const page = generate(snapshot);
		const bytes = Buffer.byteLength(canonicalJsonString(page), "utf8");
		expect(bytes).toBeLessThanOrEqual(1_507_328);
		expect(
			page.header.root_counts.reduce(
				(sum, cell) => sum + cell.value!.counts.total,
				0,
			),
		).toBe(200);
		console.info(
			`FLY-2482 capacity: 200 items / 6 roots / ${bytes} document bytes`,
		);
	});
});
