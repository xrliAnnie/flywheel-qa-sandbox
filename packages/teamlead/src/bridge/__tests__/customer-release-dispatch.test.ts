import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerReleaseDispatch } from "../customer-release/dispatch.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const now = Date.parse("2026-09-15T15:00:00Z");
const binding = {
	repository: "owner/repo",
	repositoryId: 11,
	workflowId: 22,
	workflowPath: ".github/workflows/payload-promote.yml",
	reviewedSha: "a".repeat(40),
};
const request = {
	dispatchId: "b".repeat(64),
	createdAt: now,
	inputs: { mode: "prepare", "release-id": "release-1", beta: "1.2.3-beta.1" },
};
function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const cycle = store.reserve({
		projectId: "flywheel",
		slotDate: "2026-09-15",
		releaseId: "release-1",
		activationEpoch: 1,
		policyRevision: "c".repeat(64),
		betaVersion: "1.2.3-beta.1",
		manifest: {
			versions: {
				"1.2.3-beta.1": {
					channel: "beta",
					status: "active",
					sourceCommit: "a".repeat(40),
					sha256: "d".repeat(64),
				},
			},
		},
		now,
	});
	db.prepare(
		"UPDATE customer_release_cycles SET state='preparing',revision=1 WHERE cycle_id=?",
	).run(cycle.cycleId);
	const transport = {
		dispatch: vi.fn(async () => 33),
		observe: vi.fn(async () => ({ runId: 33, state: "succeeded" as const })),
	};
	const dispatcher = new CustomerReleaseDispatch({
		store,
		transport,
		now: () => now,
	});
	return { db, store, cycle, transport, dispatcher };
}
it("dispatch intent commits before POST, survives replacement adapter, and never POSTs twice", async () => {
	const f = fixture();
	f.transport.dispatch.mockImplementation(async () => {
		expect(
			f.store
				.events(f.cycle.cycleId)
				.some((e) => e.kind === "workflow_dispatch_started"),
		).toBe(true);
		return 33;
	});
	expect(
		await f.dispatcher.tick(f.cycle.cycleId, binding, request),
	).toMatchObject({ state: "succeeded" });
	const replacement = new CustomerReleaseDispatch({
		store: new CustomerReleaseStore(f.db),
		transport: f.transport,
		now: () => now,
	});
	await replacement.tick(f.cycle.cycleId, binding, request);
	expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
});
it("ambiguous POST and crash after durable intent only permit observation", async () => {
	const f = fixture();
	f.transport.dispatch.mockRejectedValueOnce(new Error("lost reply"));
	expect(await f.dispatcher.tick(f.cycle.cycleId, binding, request)).toBeNull();
	expect(
		await f.dispatcher.tick(f.cycle.cycleId, binding, request),
	).toMatchObject({ state: "succeeded" });
	expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
});
it("reusing a dispatch id with changed candidate/workflow is rejected", async () => {
	const f = fixture();
	await f.dispatcher.tick(f.cycle.cycleId, binding, request);
	await expect(
		f.dispatcher.tick(f.cycle.cycleId, { ...binding, workflowId: 23 }, request),
	).rejects.toThrow();
	expect(f.transport.dispatch).toHaveBeenCalledTimes(1);
});
it("state invalidation or storage failure occurs before any network dispatch", async () => {
	for (const kind of ["cancel", "storage"]) {
		const f = fixture();
		if (kind === "cancel")
			f.store.cancel(f.cycle.cycleId, 1, "founder_veto", now);
		else
			f.db.exec(
				"CREATE TRIGGER fail_dispatch BEFORE INSERT ON customer_release_events WHEN NEW.kind='workflow_dispatch_started' BEGIN SELECT RAISE(ABORT,'injected'); END",
			);
		await expect(
			f.dispatcher.tick(f.cycle.cycleId, binding, request),
		).rejects.toThrow();
		expect(f.transport.dispatch).not.toHaveBeenCalled();
	}
});
