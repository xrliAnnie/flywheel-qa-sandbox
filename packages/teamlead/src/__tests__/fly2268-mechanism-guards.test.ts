import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
});

function rawStateDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

describe("FLY-2268 mechanism guards", () => {
	it("adds only the two approved StateStore tables and no CommDB table", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const stateNames = rawStateDb(store)
			.prepare(
				`SELECT name FROM sqlite_master
				  WHERE type = 'table' AND name IN (
				    'workflow_resident_hold',
				    'workflow_completion_drain_challenge'
				  ) ORDER BY name`,
			)
			.all() as Array<{ name: string }>;
		expect(stateNames.map(({ name }) => name)).toEqual([
			"workflow_completion_drain_challenge",
			"workflow_resident_hold",
		]);
		const indexes = rawStateDb(store)
			.prepare(
				`SELECT name FROM sqlite_master
				  WHERE type = 'index' AND name IN (
				    'idx_wrh_expiring',
				    'idx_wcdc_issued_by_submission'
				  ) ORDER BY name`,
			)
			.all() as Array<{ name: string }>;
		expect(indexes.map(({ name }) => name)).toEqual([
			"idx_wcdc_issued_by_submission",
			"idx_wrh_expiring",
		]);

		const comm = new CommDB(":memory:");
		commDbs.push(comm);
		const rawComm = (comm as unknown as { db: Database.Database }).db;
		expect(
			rawComm
				.prepare(
					`SELECT name FROM sqlite_master
					  WHERE type = 'table' AND name IN (
					    'workflow_resident_hold',
					    'workflow_completion_drain_challenge'
					  )`,
				)
				.all(),
		).toEqual([]);
	});

	it("pins the approved CommDB columns and exact shutdown request key", () => {
		const comm = new CommDB(":memory:");
		commDbs.push(comm);
		const raw = (comm as unknown as { db: Database.Database }).db;
		const turn = raw
			.prepare("PRAGMA table_info(three_stage_turn)")
			.all() as Array<{
			name: string;
		}>;
		const wakes = raw
			.prepare("PRAGMA table_info(runner_phase_wakes)")
			.all() as Array<{
			name: string;
		}>;
		const shutdown = raw
			.prepare("PRAGMA table_info(runner_shutdown_controls)")
			.all() as Array<{ name: string; pk: number }>;
		expect(
			turn.filter(({ name }) =>
				["active_turn_id", "turn_generation"].includes(name),
			),
		).toHaveLength(2);
		expect(wakes.filter(({ name }) => name === "turn_generation")).toHaveLength(
			1,
		);
		expect(
			shutdown
				.filter(({ pk }) => pk > 0)
				.sort((a, b) => a.pk - b.pk)
				.map(({ name }) => name),
		).toEqual(["execution_id", "request_id"]);
		expect(shutdown.some(({ name }) => name === "settlement_reason")).toBe(
			true,
		);
	});

	it("keeps resident mechanisms role-neutral and free of runtime knobs", () => {
		const root = resolve(process.cwd(), "../..");
		const roleNeutral = [
			"packages/teamlead/src/bridge/resident-receiver-supervisor.ts",
			"packages/teamlead/src/bridge/resident-hold.ts",
			"packages/teamlead/src/bridge/completion-drain.ts",
		];
		for (const relativePath of roleNeutral) {
			const source = readFileSync(resolve(root, relativePath), "utf8");
			expect(source, relativePath).not.toMatch(/\b(?:qa|implement|design)\b/i);
			expect(source, relativePath).not.toContain("process.env");
		}
		const barrierPath = "packages/claude-runner/src/codex-turn-barrier.ts";
		const barrier = readFileSync(resolve(root, barrierPath), "utf8");
		expect(barrier, barrierPath).not.toContain("process.env");
		expect(
			readFileSync(
				resolve(root, "packages/teamlead/src/bridge/resident-hold.ts"),
				"utf8",
			),
		).toContain("RESIDENT_GRACE_MS = 1_800_000");
		expect(barrier).toContain("TURN_BARRIER_RETRY_MS = 60_000");
	});

	it("claims resident wake ownership only at the two actor wake boundaries", () => {
		const root = resolve(process.cwd(), "../..");
		const supervisor = readFileSync(
			resolve(
				root,
				"packages/teamlead/src/bridge/resident-receiver-supervisor.ts",
			),
			"utf8",
		);
		const plugin = readFileSync(
			resolve(root, "packages/teamlead/src/bridge/plugin.ts"),
			"utf8",
		);
		const fence = readFileSync(
			resolve(root, "packages/teamlead/src/bridge/resident-wake-fence.ts"),
			"utf8",
		);

		expect(supervisor).not.toContain("wakeResidentHold");
		expect(plugin.match(/deliverResidentWake\(/g)).toHaveLength(2);
		expect(plugin).not.toContain("store.wakeResidentHold");
		expect(fence.match(/store\.wakeResidentHold\(/g)).toHaveLength(1);
		expect(fence.indexOf("const result = await deliver()")).toBeLessThan(
			fence.indexOf("store.wakeResidentHold"),
		);
	});
});
