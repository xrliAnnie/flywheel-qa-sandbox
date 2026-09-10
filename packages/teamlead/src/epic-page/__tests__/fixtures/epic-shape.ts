import type { LinearActiveScopeSnapshot } from "../../../bridge/linear-epic-query.js";
import type { EpicItemFacts } from "../../../StateStore.js";

const OBSERVED_AT = "2026-09-03T04:00:00Z";

function child(
	number: number,
	blockedBy: number[],
): LinearActiveScopeSnapshot["items"][number] {
	return {
		parent: { id: "epic-uuid", identifier: "EPX-100" },
		id: `child-uuid-${number}`,
		identifier: `EPX-${number}`,
		title: `Task ${String.fromCharCode(64 + number)}`,
		url: `https://linear.app/example/issue/EPX-${number}`,
		priority: number === 5 ? 0 : number,
		updatedAt: "2026-09-03T03:30:00Z",
		state: { name: "Todo", type: "unstarted" },
		labels: [],
		blockedBy: blockedBy.map((blocker) => ({
			id: `child-uuid-${blocker}`,
			identifier: `EPX-${blocker}`,
			title: `Task ${String.fromCharCode(64 + blocker)}`,
			url: `https://linear.app/example/issue/EPX-${blocker}`,
			stateType: "unstarted",
			inScope: true,
		})),
		acceptance: { text: `Task ${number} is complete.`, truncated: false },
	};
}

export function epicShapeSnapshot(): LinearActiveScopeSnapshot {
	return {
		fetchedAt: OBSERVED_AT,
		descendantIds: [
			"child-uuid-1",
			"child-uuid-2",
			"child-uuid-3",
			"child-uuid-4",
			"child-uuid-5",
		],
		boundary: { teamKey: "EPX", project: "Example", label: "Example" },
		roots: [
			{
				id: "epic-uuid",
				identifier: "EPX-100",
				title: "Example Epic",
				url: "https://linear.app/example/issue/EPX-100",
				updatedAt: "2026-09-03T03:00:00Z",
				state: { name: "In Progress", type: "started" },
			},
			{
				id: "daily-uuid",
				identifier: "EPX-200",
				title: "日常",
				url: "https://linear.app/example/issue/EPX-200",
				updatedAt: "2026-09-03T03:10:00Z",
				state: { name: "In Progress", type: "started" },
			},
		],
		items: [
			child(1, []),
			child(2, [1]),
			child(3, [1]),
			child(4, [1, 2, 3]),
			child(5, []),
		],
	};
}

export function emptyItemFacts(): EpicItemFacts {
	return {
		session: {
			ok: true,
			value: { latest: [], ledger_live_count: 0 },
		},
		run: { ok: true, value: [] },
		attempt: { ok: true, value: [] },
		gates: { ok: true, value: [] },
		carriers: { ok: true, value: [] },
		land: { ok: true, value: [] },
	};
}

export const EPIC_SHAPE_NOW = new Date("2026-09-03T04:00:01Z");

export function epicShapeSnapshotV2() {
	const snapshot = epicShapeSnapshot();
	for (const [number, parent, blockedBy] of [
		[
			6,
			0,
			[
				{
					id: "outside",
					identifier: "EPX-90",
					title: "Outside",
					url: "https://linear.app/90",
					stateType: "completed",
					inScope: false,
				},
			],
		],
		[7, 1, []],
		[
			8,
			0,
			[
				{
					id: "child-uuid-6",
					identifier: "EPX-6",
					title: "Six",
					url: "https://linear.app/6",
					stateType: "backlog",
					inScope: true,
				},
			],
		],
		[
			9,
			0,
			[
				{
					id: "child-uuid-7",
					identifier: "EPX-7",
					title: "Seven",
					url: "https://linear.app/7",
					stateType: "backlog",
					inScope: true,
				},
			],
		],
	] as const) {
		const root = snapshot.roots[parent]!;
		snapshot.items.push({
			...snapshot.items[0]!,
			id: `child-uuid-${number}`,
			identifier: `EPX-${number}`,
			parent: { id: root.id, identifier: root.identifier },
			state: {
				name: number === 9 ? "Todo" : "Backlog",
				type: number === 9 ? "unstarted" : "backlog",
			},
			blockedBy: structuredClone([...blockedBy]),
		});
	}
	snapshot.descendantIds = snapshot.items.map((item) => item.id);
	return snapshot;
}
export function filterV1(snapshot: ReturnType<typeof epicShapeSnapshotV2>) {
	const result = structuredClone(snapshot);
	result.items = result.items.filter((item) => item.state.type !== "backlog");
	const ids = new Set(result.items.map((item) => item.id));
	for (const item of result.items)
		for (const blocker of item.blockedBy) blocker.inScope = ids.has(blocker.id);
	return result;
}

export function epicShapeSnapshotV3(): LinearActiveScopeSnapshot {
	const snapshot = epicShapeSnapshot();
	const base = snapshot.roots[0]!;
	snapshot.roots.push(
		{ ...base, id: "epic-300", identifier: "EPX-300", title: "Finished Epic" },
		{ ...base, id: "epic-400", identifier: "EPX-400", title: "Waiting Epic" },
	);
	const specs: Array<[number, number | null, string, number[]]> = [
		[1, 100, "started", []],
		[2, 100, "unstarted", [1]],
		[3, 100, "unstarted", [20]],
		[4, 100, "backlog", [90]],
		[5, 100, "unstarted", [30]],
		[6, 100, "unstarted", []],
		[7, 100, "backlog", []],
		[8, 100, "completed", []],
		[9, 100, "canceled", []],
		[10, null, "unstarted", []],
		[11, 100, "future", []],
		[999, 100, "unstarted", []],
		[1000, 100, "unstarted", []],
		[20, 200, "unstarted", []],
		[30, 300, "completed", []],
		[31, 300, "canceled", []],
		[40, 400, "unstarted", [20, 90]],
		[41, 400, "backlog", [90]],
	];
	snapshot.items = specs.map(([number, parent, type, blocked]) => {
		const root = snapshot.roots.find((r) => r.identifier === `EPX-${parent}`);
		return {
			...child(number, blocked),
			parent: root ? { id: root.id, identifier: root.identifier } : null,
			state: { type, name: type === "started" ? "In Progress" : type },
			blockedBy: blocked.map((n) => ({
				id: `child-uuid-${n}`,
				identifier: `EPX-${n}`,
				title: `Task ${n}`,
				url: `https://linear.app/example/issue/EPX-${n}`,
				stateType: specs.find((s) => s[0] === n)?.[2] ?? "unstarted",
				inScope: specs.some((s) => s[0] === n),
			})),
		};
	});
	snapshot.descendantIds = snapshot.items.map((i) => i.id);
	return snapshot;
}

export function v3ItemFacts(
	snapshot: LinearActiveScopeSnapshot,
): EpicItemFacts[] {
	return snapshot.items.map((item) => {
		const facts = emptyItemFacts();
		if (item.identifier === "EPX-1") {
			facts.run = {
				ok: true,
				value: [
					{
						run_id: "run-v3",
						status: "active",
						current_node_id: "implement",
						current_node_label: "实现",
						label_source: "manifest",
						template_id: "tpl",
					},
				],
			};
			facts.attempt = {
				ok: true,
				value: [{ state: "running", attempt: 2, ledger_open: true }],
			};
			facts.session = {
				ok: true,
				value: {
					ledger_live_count: 1,
					latest: [
						{
							status: "running",
							execution_id8: "execv3",
							role: "implement",
							branch: "example",
						},
					],
				},
			};
		}
		return facts;
	});
}

export function permuteSnapshot(
	source: LinearActiveScopeSnapshot,
	facts: EpicItemFacts[],
	signals: import("../../generate.js").GenerateEpicPageInput["itemSignals"],
	seed: number,
) {
	function shuffled<T>(values: T[]): T[] {
		const result = [...values];
		for (let i = result.length - 1; i > 0; i--) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const j = seed % (i + 1);
			[result[i], result[j]] = [result[j]!, result[i]!];
		}
		return result;
	}
	const snapshot = structuredClone(source);
	const rows = shuffled(
		source.items.map((item, i) => ({
			id: item.id,
			facts: facts[i]!,
			signals: signals?.[i],
		})),
	);
	const byId = new Map(snapshot.items.map((item) => [item.id, item]));
	snapshot.items = rows.map((row) => byId.get(row.id)!);
	snapshot.roots = shuffled(snapshot.roots);
	snapshot.descendantIds = snapshot.items.map((item) => item.id);
	return {
		snapshot,
		itemFacts: rows.map((row) => structuredClone(row.facts)),
		...(signals
			? { itemSignals: rows.map((row) => structuredClone(row.signals!)) }
			: {}),
	};
}
