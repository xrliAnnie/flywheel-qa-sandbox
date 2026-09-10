import { describe, expect, it } from "vitest";
import {
	buildFounderView,
	compareIdentifier,
	identifierKey,
} from "../founder-view.js";
import { generateEpicPage } from "../generate.js";
import { resolvePointer } from "../model.js";
import {
	EPIC_SHAPE_NOW,
	epicShapeSnapshotV3,
	permuteSnapshot,
	v3ItemFacts,
} from "./fixtures/epic-shape.js";

function* permutations(values: string[]): Generator<string[]> {
	if (!values.length) {
		yield [];
		return;
	}
	for (const [index, value] of values.entries())
		for (const rest of permutations(values.filter((_, i) => i !== index)))
			yield [value, ...rest];
}

describe("identifier total order", () => {
	it("orders every permutation identically without losing large-number precision", () => {
		const ids = [
			"EPX-2",
			"EPX-10",
			"EPX-1x",
			"epx-3",
			"ZZZ",
			"EPX-02",
			"EPX-0",
		];
		for (const permutation of permutations(ids))
			expect(permutation.sort(compareIdentifier)).toEqual([
				"EPX-0",
				"EPX-02",
				"EPX-2",
				"EPX-10",
				"epx-3",
				"EPX-1x",
				"ZZZ",
			]);
		expect(
			["EPX-9007199254740993", "EPX-9007199254740992"].sort(compareIdentifier),
		).toEqual(["EPX-9007199254740992", "EPX-9007199254740993"]);
		expect(identifierKey("EPX-02")).toEqual([0, "EPX", 1, "2", "EPX-02"]);
		expect(identifierKey("EPX-2")).toEqual([0, "EPX", 1, "2", "EPX-2"]);
	});
});

function pageV3() {
	const snapshot = epicShapeSnapshotV3();
	return generateEpicPage({
		snapshot,
		itemFacts: v3ItemFacts(snapshot),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "scan",
	});
}
describe("founder view", () => {
	it("shows open roots in stable order and retains only terminal counts", () => {
		const view = buildFounderView(pageV3());
		expect(view.scopeUnavailable).toBe(false);
		expect(view.epics.map((e) => e.identifier)).toEqual([
			"EPX-100",
			"EPX-200",
			"EPX-400",
		]);
		expect(view.hiddenDoneEpics?.count).toBe(1);
		const epic = view.epics[0]!;
		expect(epic.counts).toBeNull();
		expect(epic.countsMissing?.reason).toBe("unknown_state_type");
		expect(epic.children.map((c) => c.identifier)).toEqual([
			"EPX-1",
			"EPX-2",
			"EPX-3",
			"EPX-4",
			"EPX-5",
			"EPX-6",
			"EPX-7",
			"EPX-999",
			"EPX-1000",
			"EPX-11",
		]);
		expect(epic.terminal).toMatchObject({ done: 1, canceled: 1 });
		expect(view.unattached.map((c) => c.identifier)).toEqual(["EPX-10"]);
	});
	it("identifies same-epic, cross-epic and outside blockers and whole-epic waits", () => {
		const view = buildFounderView(pageV3());
		const children = view.epics[0]!.children;
		expect(
			children.find((c) => c.identifier === "EPX-2")!.blockers[0],
		).toMatchObject({ identifier: "EPX-1", where: "same_epic" });
		expect(
			children.find((c) => c.identifier === "EPX-3")!.blockers[0],
		).toMatchObject({
			identifier: "EPX-20",
			where: "other_epic",
			otherRoot: "EPX-200",
		});
		expect(
			children.find((c) => c.identifier === "EPX-4")!.blockers[0],
		).toMatchObject({ identifier: "EPX-90", where: "outside" });
		expect(view.epics[2]!.allWaitingOn?.blockers).toEqual(["EPX-20", "EPX-90"]);
		expect(view.epics[0]!.allWaitingOn).toBeNull();
	});
	it("reads machine progress and preserves all five source paths even for missing or idle facts", () => {
		const page = pageV3();
		const child = (id: string) =>
			buildFounderView(page)
				.epics.flatMap((e) => e.children)
				.find((c) => c.identifier === id)!;
		expect(child("EPX-1").progress).toMatchObject({
			kind: "live",
			node: "实现",
			attempt: 2,
			status: "running",
		});
		for (const [id, field] of [
			["EPX-6", "run"],
			["EPX-3", "session"],
		] as const) {
			const i = page.items.findIndex((c) => c.identifier === id);
			page.items[i]![field] = {
				...page.items[i]![field],
				value: null,
				missing: { reason: "statestore_error" },
			};
			expect(child(id).progress).toMatchObject({
				kind: "missing",
				reasons: ["statestore_error"],
			});
			expect(child(id).progress.view.from).toEqual(
				["attempt", "blocked_by", "run", "session", "state"].map(
					(k) => `/items/${i}/${k}`,
				),
			);
		}
		expect(child("EPX-7").progress.kind).toBe("idle");
		expect(child("EPX-7").progress.view.from).toHaveLength(5);
	});
});

it("attaches resolvable provenance with time ordering to all six display rules", () => {
	const page = pageV3();
	page.items[0]!.state.observed_at = "2026-09-03T04:00:01.999Z";
	const view = buildFounderView(page);
	const provenance = [
		view.order,
		view.hiddenDoneEpics?.view,
		...view.epics.flatMap((e) => [
			e.allWaitingOn?.view,
			e.terminal.view,
			...e.children.flatMap((c) => [c.blockerScope, c.progress.view]),
		]),
	].filter((p) => p != null);
	expect(new Set(provenance.map((p) => p.rule)).size).toBe(6);
	for (const p of provenance) {
		expect(p.from).toEqual([...new Set(p.from)].sort());
		const times = p.from.map((path) => {
			expect(path).not.toContain("*");
			const cell = resolvePointer(page, path);
			expect(cell).toMatchObject({
				observed_at: expect.any(String),
				provenance: expect.any(Object),
			});
			return (cell as { observed_at: string }).observed_at;
		});
		expect(p.observedAt).toBe(
			times
				.sort(
					(a, b) =>
						Date.parse(a) - Date.parse(b) || (a < b ? -1 : a > b ? 1 : 0),
				)
				.at(-1),
		);
	}
	expect(view.order?.observedAt).toBe("2026-09-03T04:00:01.999Z");
	const cross = view.epics[0]!.children.find((c) => c.identifier === "EPX-3")!
		.blockerScope!;
	expect(cross.from).toEqual([
		"/header/items",
		"/header/roots",
		"/items/13/parent",
		"/items/2/blocked_by",
		"/items/2/parent",
	]);
});

it("preserves grouping and descendants when raw inputs are permuted together", () => {
	const source = epicShapeSnapshotV3();
	source.items.push(
		{
			...structuredClone(source.items[0]!),
			id: "unattached-a",
			identifier: "EPX-1x",
			state: { name: "Todo", type: "unstarted" },
			parent: { id: "unattached-b", identifier: "EPX-77" },
		},
		{
			...structuredClone(source.items[0]!),
			id: "unattached-b",
			identifier: "EPX-77",
			state: { name: "Todo", type: "unstarted" },
			parent: null,
		},
	);
	source.descendantIds = source.items.map((i) => i.id);
	const generate = (seed: number) => {
		const input = permuteSnapshot(source, v3ItemFacts(source), undefined, seed);
		return buildFounderView(
			generateEpicPage({
				...input,
				now: EPIC_SHAPE_NOW,
				projectName: "example",
				trigger: "scan",
			}),
		);
	};
	function semantic(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(semantic);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.filter(
						([k]) =>
							!["itemIndex", "rootIndex", "from", "observedAt"].includes(k),
					)
					.map(([k, v]) => [k, semantic(v)]),
			);
		return value;
	}
	expect(semantic(generate(1))).toEqual(semantic(generate(2)));
	expect(generate(1).unattached.map((c) => c.identifier)).toEqual([
		"EPX-10",
		"EPX-77",
		"EPX-1x",
	]);
});

it("groups roots by Linear type without consulting priority or counts", () => {
	const page = pageV3();
	page.header.roots.value![0]!.state = { name: "Future", type: "future" };
	page.header.roots.value![1]!.state = { name: "Todo", type: "unstarted" };
	expect(buildFounderView(page).epics.map((e) => e.identifier)).toEqual([
		"EPX-400",
		"EPX-200",
		"EPX-100",
	]);
});

it("keeps identifier order when same-state roots have conflicting live counts", () => {
	const snapshot = epicShapeSnapshotV3();
	const root = snapshot.roots[0]!;
	const item = snapshot.items[0]!;
	snapshot.roots = [10, 20, 30].map((n) => ({
		...structuredClone(root),
		id: `root-${n}`,
		identifier: `EPX-${n}`,
	}));
	snapshot.items = snapshot.roots.flatMap((parent, index) =>
		Array.from({ length: 3 }, (_, i) => ({
			...structuredClone(item),
			id: `${parent.id}-child-${i}`,
			identifier: `KID-${index * 3 + i}`,
			parent: { id: parent.id, identifier: parent.identifier },
			blockedBy: [],
			state:
				i < [1, 3, 0][index]!
					? { name: "In Progress", type: "started" }
					: { name: "Todo", type: "unstarted" },
		})),
	);
	snapshot.descendantIds = snapshot.items.map((child) => child.id);
	const page = generateEpicPage({
		snapshot,
		itemFacts: v3ItemFacts(snapshot),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "scan",
	});
	expect(
		buildFounderView(page).epics.map((epic) => [
			epic.identifier,
			epic.counts?.live,
		]),
	).toEqual([
		["EPX-10", 1],
		["EPX-20", 3],
		["EPX-30", 0],
	]);
});

it("handles absent live runs and free children without inventing execution facts", () => {
	const page = pageV3();
	page.items[0]!.run.value = [];
	const view = buildFounderView(page);
	expect(view.epics[0]!.children[0]!.progress.kind).toBe("live_no_run");
	expect(
		view.epics[0]!.children.find((c) => c.identifier === "EPX-5")!.progress,
	).toMatchObject({ kind: "free", blockers: ["EPX-30"] });
	for (const epic of view.epics.filter((e) => e.counts !== null)) {
		expect(
			epic.children.length + epic.terminal.done + epic.terminal.canceled,
		).toBe(epic.counts!.total);
		for (const cls of ["live", "waiting", "free", "idle"] as const)
			expect(epic.children.filter((c) => c.cls === cls).length).toBe(
				epic.counts![cls],
			);
	}
});

it("represents an empty known scope with an observed zero hidden count", () => {
	const page = pageV3();
	page.header.roots.value = [];
	page.header.root_counts = [];
	page.items = [];
	const view = buildFounderView(page);
	expect(view.epics).toEqual([]);
	expect(view.hiddenDoneEpics?.count).toBe(0);
	expect(view.hiddenDoneEpics?.view.from).toEqual(["/header/roots"]);
});

it("treats an in-scope blocker absent from items as outside (G4)", () => {
	const page = pageV3();
	const blocker = page.items[1]!.blocked_by.value![0]!;
	blocker.identifier = "MISSING-1";
	blocker.in_scope = true;
	const child = buildFounderView(page).epics[0]!.children.find(
		(c) => c.identifier === "EPX-2",
	)!;
	expect(child.blockers).toEqual([
		{ identifier: "MISSING-1", where: "outside" },
	]);
});

it("does not invent a shared Epic for two unattached children", () => {
	const page = pageV3();
	page.items[1]!.parent.value = null;
	page.items[0]!.parent.value = null;
	const child = buildFounderView(page).unattached.find(
		(c) => c.identifier === "EPX-2",
	)!;
	expect(child.blockers[0]).toEqual({
		identifier: "EPX-1",
		where: "other_epic",
	});
});
