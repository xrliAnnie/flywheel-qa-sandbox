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
