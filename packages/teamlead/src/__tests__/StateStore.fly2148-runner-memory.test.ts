import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-2148 StateStore runner-memory evidence", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => store.close());

	it("creates all five nullable columns and migrates idempotently", () => {
		store.migrate();
		const rows = store.db.exec("PRAGMA table_info(sessions)")[0]?.values ?? [];
		const names = rows.map((row) => row[1]);
		expect(names).toEqual(
			expect.arrayContaining([
				"runner_memory_arm",
				"runner_memory_dir",
				"runner_memory_spawn",
				"runner_memory_closeout",
				"runner_memory_receipt",
			]),
		);
	});

	it("round-trips upsert evidence and preserves it when a later upsert omits it", () => {
		store.upsertSession({
			execution_id: "exec-memory",
			issue_id: "FLY-2148",
			project_name: "flywheel",
			status: "running",
			runner_memory_arm: "role",
			runner_memory_dir: "/tmp/memory",
			runner_memory_spawn: '{"sha16":"0123456789abcdef"}',
			runner_memory_closeout: "written",
			runner_memory_receipt: '{"state":"written"}',
		});
		expect(store.getSession("exec-memory")).toMatchObject({
			runner_memory_arm: "role",
			runner_memory_dir: "/tmp/memory",
			runner_memory_spawn: '{"sha16":"0123456789abcdef"}',
			runner_memory_closeout: "written",
			runner_memory_receipt: '{"state":"written"}',
		});

		store.upsertSession({
			execution_id: "exec-memory",
			issue_id: "FLY-2148",
			project_name: "flywheel",
			status: "awaiting_review",
		});
		expect(store.getSession("exec-memory")).toMatchObject({
			runner_memory_arm: "role",
			runner_memory_closeout: "written",
		});
	});

	it("atomically replaces attribution and clears stale role-only fields", () => {
		store.upsertSession({
			execution_id: "exec-memory",
			issue_id: "FLY-2148",
			project_name: "flywheel",
			status: "running",
		});
		expect(
			store.patchRunnerMemorySelection("exec-memory", {
				arm: "role",
				dir: "/tmp/memory",
				spawn: '{"sha16":"0123456789abcdef"}',
			}),
		).toBe(true);
		expect(store.getSession("exec-memory")).toMatchObject({
			runner_memory_arm: "role",
			runner_memory_dir: "/tmp/memory",
		});

		expect(
			store.patchRunnerMemorySelection("exec-memory", {
				arm: "off",
				dir: null,
				spawn: null,
			}),
		).toBe(true);
		expect(store.getSession("exec-memory")).toMatchObject({
			runner_memory_arm: "off",
			runner_memory_dir: undefined,
			runner_memory_spawn: undefined,
		});
		expect(
			store.patchRunnerMemorySelection("missing", {
				arm: "off",
				dir: null,
				spawn: null,
			}),
		).toBe(false);
	});

	it("keeps enum reads closed and supports direct over-budget queries", () => {
		store.upsertSession({
			execution_id: "exec-memory",
			issue_id: "FLY-2148",
			project_name: "flywheel",
			status: "running",
		});
		store.db.run(
			"UPDATE sessions SET runner_memory_arm='invalid', runner_memory_closeout='done' WHERE execution_id='exec-memory'",
		);
		expect(store.getSession("exec-memory")).toMatchObject({
			runner_memory_arm: undefined,
			runner_memory_closeout: undefined,
		});
		store.patchSessionMetadata("exec-memory", {
			runner_memory_closeout: "over_budget",
			runner_memory_receipt: '{"state":"over_budget"}',
		});
		const result = store.db.exec(
			"SELECT COUNT(*) FROM sessions WHERE runner_memory_closeout='over_budget'",
		);
		expect(result[0]?.values[0]?.[0]).toBe(1);
	});
});
