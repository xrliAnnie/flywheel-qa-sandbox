import type { LinearActiveScopeSnapshot } from "../../../bridge/linear-epic-query.js";
import type { EpicItemFacts } from "../../../StateStore.js";

const OBSERVED_AT = "2026-09-03T04:00:00Z";

function child(
	number: number,
	blockedBy: number[],
): LinearActiveScopeSnapshot["items"][number] {
	return {
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
