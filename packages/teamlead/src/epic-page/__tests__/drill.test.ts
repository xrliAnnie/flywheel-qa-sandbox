import { describe, expect, it } from "vitest";
import { generateEpicPage } from "../generate.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "./fixtures/epic-shape.js";

describe("R1 continuous-progression drill", () => {
	it("always names the next work until every item is terminal", () => {
		const snapshot = epicShapeSnapshot();
		const states = [
			{ completed: [], next: ["EPX-1", "EPX-5"] },
			{ completed: [1, 5], next: ["EPX-2", "EPX-3"] },
			{ completed: [1, 2, 3, 5], next: ["EPX-4"] },
			{ completed: [1, 2, 3, 4, 5], next: [] },
		] as const;

		for (const step of states) {
			const completed = new Set(
				step.completed.map((number) => `EPX-${number}`),
			);
			for (const child of snapshot.items) {
				const isDone = completed.has(child.identifier);
				child.state = isDone
					? { name: "Done", type: "completed" }
					: { name: "Todo", type: "unstarted" };
				for (const blocker of child.blockedBy) {
					blocker.stateType = completed.has(blocker.identifier)
						? "completed"
						: "unstarted";
				}
			}
			const page = generateEpicPage({
				snapshot,
				itemFacts: snapshot.items.map(() => emptyItemFacts()),
				now: EPIC_SHAPE_NOW,
				projectName: "example",
				trigger: "manual",
			});
			expect(page.ready_items.value).toEqual([...step.next]);
			expect(page.gaps.value).toEqual([]);
			if (step.next.length === 0) {
				expect(
					page.items.every((item) =>
						["completed", "canceled"].includes(item.state.value?.type ?? ""),
					),
				).toBe(true);
			} else {
				expect(page.ready_items.value.length).toBeGreaterThan(0);
			}
		}
	});
});
