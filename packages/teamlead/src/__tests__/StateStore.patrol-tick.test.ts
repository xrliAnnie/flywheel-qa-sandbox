import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1687 StateStore patrol read models", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	it("returns exactly the six non-terminal statuses for one project", () => {
		const included = [
			"running",
			"ship_parked",
			"awaiting_review",
			"approved_to_ship",
			"pending",
			"design_done",
		];
		for (const [index, status] of [
			...included,
			"completed",
			"failed",
		].entries()) {
			store.upsertSession({
				execution_id: `exec-${index}`,
				issue_id: `issue-${index}`,
				project_name: "foo_bar",
				status,
			});
		}
		store.upsertSession({
			execution_id: "other-project",
			issue_id: "other-issue",
			project_name: "fooxbar",
			status: "running",
		});

		expect(
			store
				.getPatrolRosterSessions("foo_bar")
				.map((session) => session.status)
				.sort(),
		).toEqual([...included].sort());
	});

	it("scopes the chain head by exact session_key, including underscore projects", () => {
		const exact = "patrol:foo_bar:eng-lead";
		const lookalike = "patrol:fooxbar:eng-lead";
		const first = store.appendLeadEvent(
			"eng-lead",
			"tick-exact-1",
			"patrol_tick",
			JSON.stringify({
				event_type: "patrol_tick",
				execution_id: "x",
				issue_id: "",
			}),
			exact,
		);
		store.appendLeadEvent(
			"eng-lead",
			"tick-lookalike",
			"patrol_tick",
			JSON.stringify({
				event_type: "patrol_tick",
				execution_id: "y",
				issue_id: "",
			}),
			lookalike,
		);
		const latest = store.appendLeadEvent(
			"eng-lead",
			"tick-exact-2",
			"patrol_tick",
			JSON.stringify({
				event_type: "patrol_tick",
				execution_id: "z",
				issue_id: "",
			}),
			exact,
		);

		expect(first).not.toBe(latest);
		expect(store.getLatestPatrolTickEvent("eng-lead", exact)?.seq).toBe(latest);
		expect(
			store.getLatestPatrolTickEvent("eng-lead", lookalike)?.event_id,
		).toBe("tick-lookalike");
	});

	it("uses the patrol composite index without a temp ORDER BY b-tree", () => {
		const db = (
			store as unknown as {
				db: {
					exec(sql: string): Array<{
						columns: string[];
						values: unknown[][];
					}>;
				};
			}
		).db;
		const plan = db.exec(
			`EXPLAIN QUERY PLAN
			 SELECT * FROM lead_events
			 WHERE lead_id = 'eng-lead'
			   AND event_type = 'patrol_tick'
			   AND session_key = 'patrol:foo_bar:eng-lead'
			 ORDER BY seq DESC LIMIT 1`,
		)[0];
		const detailIndex = plan?.columns.indexOf("detail") ?? -1;
		const details =
			detailIndex < 0
				? ""
				: (plan?.values ?? [])
						.map((row) => String(row[detailIndex]))
						.join("\n");
		expect(details).toContain("idx_lead_events_patrol");
		expect(details).not.toContain("USE TEMP B-TREE");
	});
});
