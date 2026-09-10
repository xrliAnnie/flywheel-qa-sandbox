import { generateEpicPage } from "../../generate.js";
import {
	EPIC_SHAPE_NOW,
	epicShapeSnapshotV3,
	v3ItemFacts,
} from "./epic-shape.js";

// E1 baseline; C5 adds merged attention and one 280-character note per issue.
export function pageForBudgetBase(n: number) {
	if (n < 8 || n > 200)
		throw new Error("budget fixture requires 8..200 children");
	const snapshot = epicShapeSnapshotV3();
	const rootTemplate = snapshot.roots[0]!,
		itemTemplate = snapshot.items[0]!;
	snapshot.roots = Array.from({ length: 8 }, (_, i) => ({
		...structuredClone(rootTemplate),
		id: `budget-root-${i}`,
		identifier: `ROOT-${i}`,
		title: "项".repeat(120),
		url: `https://linear.app/example/issue/ROOT-${i}`,
	}));
	snapshot.items = Array.from({ length: n }, (_, i) => {
		const root = snapshot.roots[i % 8]!;
		return {
			...structuredClone(itemTemplate),
			id: `budget-item-${i}`,
			identifier: `BUD-${i}`,
			title: "任".repeat(120),
			url: `https://linear.app/example/issue/BUD-${i}`,
			parent: { id: root.id, identifier: root.identifier },
			state: {
				name: i % 2 ? "Todo" : "In Progress",
				type: i % 2 ? "unstarted" : "started",
			},
			acceptance: { text: "A".repeat(4096), truncated: false },
			blockedBy: [1, 2, 3].map((offset) => ({
				id: `budget-item-${(i + offset) % n}`,
				identifier: `BUD-${(i + offset) % n}`,
				title: "挡".repeat(120),
				url: `https://linear.app/example/issue/BUD-${(i + offset) % n}`,
				stateType: "started",
				inScope: true,
			})),
		};
	});
	snapshot.descendantIds = snapshot.items.map((i) => i.id);
	const facts = v3ItemFacts(epicShapeSnapshotV3())[0]!;
	const at = EPIC_SHAPE_NOW.toISOString();
	return generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => structuredClone(facts)),
		itemSignals: snapshot.items.map((item) => ({
			signals: [
				{
					kind: "question_pending",
					since: at,
					execution_id8: "budget01",
					observed_at: at,
					provenance: {
						kind: "commdb",
						table: "questions",
						key: { issue_identifier: item.identifier },
					},
				},
			],
			signal_sources: {
				statestore: {
					value: { signals: 0 },
					observed_at: at,
					provenance: {
						kind: "statestore",
						table: "sessions",
						key: { issue_id: item.id },
					},
				},
				commdb: {
					value: { signals: 1 },
					observed_at: at,
					provenance: {
						kind: "commdb",
						table: "questions",
						key: { issue_identifier: item.identifier },
					},
				},
			},
		})),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "manual",
	});
}
