import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

it("atomically reserves one occurrence per lane and preserves it across reopening", async () => {
	const root = await mkdtemp(join(tmpdir(), "beta-store-"));
	let store = await StateStore.create(join(root, "state.db"));
	try {
		const binding = {
			projectName: "a",
			repositoryId: 1,
			canonicalRepo: "test/a",
			workflowId: 2,
			defaultBranch: "main",
			bindingRevision: "binding-a",
		};
		store.betaSchedules.bind(binding, 0, 6 * 3600000);
		const first = store.betaSchedules.reserve(
			"a",
			6 * 3600000,
			"a".repeat(40),
			6 * 3600000,
		);
		expect(first?.state).toBe("prepared");
		expect(first?.occurrenceId).toMatch(/^[a-f0-9]{64}$/);
		expect(
			store.betaSchedules.reserve(
				"a",
				6 * 3600000,
				"b".repeat(40),
				6 * 3600000,
			),
		).toBeNull();
		store.close();
		store = await StateStore.create(join(root, "state.db"));
		expect(store.betaSchedules.active("a")).toEqual(first);
		expect(() =>
			store.betaSchedules.bind({ ...binding, repositoryId: 3 }, 0, 1),
		).toThrow("binding");
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("stores auditable binding and occurrence columns and rejects future or malformed reservations", async () => {
	const store = await StateStore.create(":memory:");
	try {
		store.betaSchedules.bind(
			{
				projectName: "a",
				repositoryId: 1,
				canonicalRepo: "test/a",
				workflowId: 2,
				defaultBranch: "main",
				bindingRevision: "r",
			},
			0,
			100,
		);
		expect(() => store.betaSchedules.reserve("a", 100, "invalid", 100)).toThrow(
			"source",
		);
		expect(
			store.betaSchedules.reserve("a", 100, "a".repeat(40), 99),
		).toBeNull();
		const db = (
			store as unknown as {
				db: { raw: { prepare(sql: string): { all(): { name: string }[] } } };
			}
		).db.raw;
		const columns = db
			.prepare("PRAGMA table_info(beta_schedule_occurrences)")
			.all()
			.map((r) => r.name);
		expect(columns).toEqual(
			expect.arrayContaining([
				"source_commit",
				"state",
				"attempt_count",
				"run_ids_json",
				"created_at_ms",
				"settled_at_ms",
			]),
		);
	} finally {
		store.close();
	}
});

it("guards dispatch ownership and only advances the settled project's next grid point", async () => {
	const store = await StateStore.create(":memory:");
	try {
		for (const name of ["a", "b"])
			store.betaSchedules.bind(
				{
					projectName: name,
					repositoryId: 1,
					canonicalRepo: `test/${name}`,
					workflowId: 2,
					defaultBranch: "main",
					bindingRevision: name,
				},
				0,
				100,
			);
		const first = store.betaSchedules.reserve("a", 100, "a".repeat(40), 100)!;
		expect(
			store.betaSchedules.transition("a", first.occurrenceId, "prepared", {
				state: "dispatching",
				attemptCount: 1,
			}),
		).toBe(true);
		expect(
			store.betaSchedules.transition("a", first.occurrenceId, "prepared", {
				state: "dispatching",
				attemptCount: 1,
			}),
		).toBe(false);
		expect(() =>
			store.betaSchedules.settle("a", first.occurrenceId, 350, 100),
		).toThrow("terminal");
		expect(
			store.betaSchedules.transition("a", first.occurrenceId, "dispatching", {
				state: "succeeded",
			}),
		).toBe(true);
		store.betaSchedules.settle("a", first.occurrenceId, 350, 100);
		expect(store.betaSchedules.lane("a")?.nextDueAtMs).toBe(400);
		expect(store.betaSchedules.lane("b")?.nextDueAtMs).toBe(100);
		expect(store.betaSchedules.active("a")).toBeNull();
		expect(
			store.betaSchedules.reserve("a", 100, "a".repeat(40), 500),
		).toBeNull();
	} finally {
		store.close();
	}
});

it("recalculates idle cadence only when interval changes, coalesces downtime and freezes active due", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const hour = 3600000;
		store.betaSchedules.bind(
			{
				projectName: "a",
				repositoryId: 1,
				canonicalRepo: "test/a",
				workflowId: 2,
				defaultBranch: "main",
				bindingRevision: "r",
			},
			0,
			6 * hour,
		);
		expect(store.betaSchedules.due("a", 24 * hour, 6 * hour)).toBeNull();
		expect(store.betaSchedules.lane("a")?.nextDueAtMs).toBe(24 * hour);
		expect(store.betaSchedules.due("a", 6 * hour, 19 * hour)).toBe(18 * hour);
		const active = store.betaSchedules.reserve(
			"a",
			18 * hour,
			"a".repeat(40),
			19 * hour,
		)!;
		expect(store.betaSchedules.due("a", 24 * hour, 30 * hour)).toBeNull();
		expect(store.betaSchedules.active("a")?.scheduledAtMs).toBe(18 * hour);
		store.betaSchedules.transition("a", active.occurrenceId, "prepared", {
			state: "succeeded",
		});
		store.betaSchedules.settle("a", active.occurrenceId, 80 * hour, 24 * hour);
		expect(store.betaSchedules.due("a", 24 * hour, 80 * hour)).toBeNull();
		expect(store.betaSchedules.lane("a")?.nextDueAtMs).toBe(90 * hour);
		expect(store.betaSchedules.due("a", 24 * hour, 10 * hour)).toBeNull();
		expect(store.betaSchedules.due("a", 24 * hour, 162 * hour)).toBe(
			162 * hour,
		);
	} finally {
		store.close();
	}
});

it("keeps 6h and 24h ledgers independent over 48h", async () => {
	const store = await StateStore.create(":memory:");
	const hour = 3600000;
	try {
		const counts = { a: 0, b: 0 };
		for (const [name, interval] of [
			["a", 6],
			["b", 24],
		] as const) {
			store.betaSchedules.bind(
				{
					projectName: name,
					repositoryId: interval,
					canonicalRepo: `test/${name}`,
					workflowId: 2,
					defaultBranch: "main",
					bindingRevision: name,
				},
				0,
				interval * hour,
			);
		}
		for (let time = 0; time <= 48 * hour; time += hour) {
			for (const [name, interval] of [
				["a", 6],
				["b", 24],
			] as const) {
				const due = store.betaSchedules.due(name, interval * hour, time);
				if (due === null) continue;
				const occurrence = store.betaSchedules.reserve(
					name,
					due,
					"a".repeat(40),
					time,
				)!;
				counts[name]++;
				store.betaSchedules.transition(
					name,
					occurrence.occurrenceId,
					"prepared",
					{ state: "succeeded" },
				);
				store.betaSchedules.settle(
					name,
					occurrence.occurrenceId,
					time,
					interval * hour,
				);
			}
		}
		expect(counts).toEqual({ a: 8, b: 2 });
	} finally {
		store.close();
	}
});
