import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../StateStore.js";

const at = "2026-09-14T20:00:00.000Z";
const input = () => ({
	issueUuid: "test-uuid",
	identifier: "TEST-1",
	startedAt: at,
	intakeAt: at,
	observedAt: at,
	projectName: "test",
	leadId: "test-lead",
	bindingDigest: "test-binding",
	sourceSpanIds: ["span-1"],
	backfill: false,
	active: true,
	hasChildIssues: false,
});
describe("durable Epic intake admission", () => {
	let store: StateStore;
	let db: Database.Database;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
	});
	afterEach(() => store.close());
	it("atomically records one journal row and freezes the episode owner and intake time", () => {
		const first = store.recordEpicIntake(input());
		const replay = store.recordEpicIntake({
			...input(),
			leadId: "other",
			intakeAt: "2026-09-14T20:01:00.000Z",
		});
		expect(replay).toEqual(first);
		expect(first).toMatchObject({
			leadId: "test-lead",
			intakeAt: at,
			workState: "pending",
			pageDirty: true,
		});
		expect(db.prepare("SELECT COUNT(*) AS n FROM lead_events").get()).toEqual({
			n: 1,
		});
		expect(db.prepare("SELECT ack_required FROM lead_events").get()).toEqual({
			ack_required: 0,
		});
	});
	it.each(["sessions", "workflow_run"])(
		"excludes a childless root with a project dispatch in %s including terminal dispatch",
		(table) => {
			if (table === "sessions")
				db.prepare(
					"INSERT INTO sessions(execution_id, issue_id, issue_identifier, project_name, status) VALUES ('exec', 'test-uuid', 'TEST-1', 'test', 'failed')",
				).run();
			else
				db.prepare(
					"INSERT INTO workflow_run(run_id, issue_id, project_name, status) VALUES ('run', 'test-uuid', 'test', 'completed')",
				).run();
			expect(store.hasEpicDispatchRecord("test", "test-uuid", "TEST-1")).toBe(
				true,
			);
			expect(store.recordEpicIntake(input())).toBeNull();
			expect(
				store.recordEpicIntake({ ...input(), hasChildIssues: true }),
			).not.toBeNull();
		},
	);
	it("uses saved workflow aliases and keeps project boundaries", () => {
		db.prepare(
			"INSERT INTO workflow_run(run_id, issue_id, project_name) VALUES ('run', 'TEST-1', 'other')",
		).run();
		db.prepare(
			"INSERT INTO workflow_run_issue_alias(run_id,issue_alias) VALUES ('run','test-uuid')",
		).run();
		expect(store.hasEpicDispatchRecord("test", "test-uuid", "TEST-1")).toBe(
			false,
		);
		expect(store.hasEpicDispatchRecord("other", "test-uuid", "TEST-1")).toBe(
			true,
		);
		expect(store.recordEpicIntake(input())).not.toBeNull();
	});
	it("rolls back the journal if episode insertion fails", () => {
		db.exec(
			"CREATE TRIGGER fail_intake BEFORE INSERT ON epic_intakes BEGIN SELECT RAISE(ABORT, 'injected'); END;",
		);
		expect(() => store.recordEpicIntake(input())).toThrow("injected");
		expect(db.prepare("SELECT COUNT(*) AS n FROM lead_events").get()).toEqual({
			n: 0,
		});
	});
	it("checks dispatch again inside admission instead of trusting earlier collection", () => {
		expect(store.hasEpicDispatchRecord("test", "test-uuid", "TEST-1")).toBe(
			false,
		);
		db.prepare(
			"INSERT INTO sessions(execution_id, issue_id, project_name) VALUES ('exec', 'test-uuid', 'test')",
		).run();
		expect(store.recordEpicIntake(input())).toBeNull();
	});
	it("does not create a second event after the journal row is archived or removed", () => {
		const first = store.recordEpicIntake(input());
		db.exec("DELETE FROM lead_events");
		expect(store.recordEpicIntake(input())).toEqual(first);
		expect(db.prepare("SELECT COUNT(*) AS n FROM lead_events").get()).toEqual({
			n: 0,
		});
	});
	it("propagates database failure rather than assuming no dispatch", () => {
		const check = vi
			.spyOn(store, "hasEpicDispatchRecord")
			.mockImplementation(() => {
				throw new Error("SQLITE_BUSY");
			});
		expect(() => store.recordEpicIntake(input())).toThrow("SQLITE_BUSY");
		check.mockRestore();
	});
	it("keeps the original bootstrap identity and only advances successful scan cursors", () => {
		expect(store.beginEpicIntakeScan("test", at)).toEqual({
			bootstrapStartedAt: at,
			bootstrapCompleted: false,
			lastSuccessfulScanStartedAt: null,
		});
		expect(
			store.beginEpicIntakeScan("test", "2026-09-14T20:01:00.000Z")
				.bootstrapStartedAt,
		).toBe(at);
		store.completeEpicIntakeScan("test", "2026-09-14T20:01:00.000Z");
		store.completeEpicIntakeScan("test", at);
		expect(store.beginEpicIntakeScan("test", at)).toEqual({
			bootstrapStartedAt: at,
			bootstrapCompleted: true,
			lastSuccessfulScanStartedAt: "2026-09-14T20:01:00.000Z",
		});
	});
	it("preserves episode and bootstrap deduplication across a real database reopen", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fly2557-store-"));
		let diskStore = await StateStore.create(join(directory, "test.db"));
		try {
			diskStore.beginEpicIntakeScan("test", at);
			const first = diskStore.recordEpicIntake(input());
			diskStore.completeEpicIntakeScan("test", at);
			diskStore.close();
			diskStore = await StateStore.create(join(directory, "test.db"));
			expect(diskStore.recordEpicIntake(input())).toEqual(first);
			expect(
				diskStore.beginEpicIntakeScan("test", "2026-09-14T20:01:00.000Z"),
			).toEqual({
				bootstrapStartedAt: at,
				bootstrapCompleted: true,
				lastSuccessfulScanStartedAt: at,
			});
		} finally {
			diskStore.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("clears only the exact intake revision covered by a successful publication", () => {
		const row = store.recordEpicIntake(input())!;
		store.setEpicIntakeActive(row.eventUid, false, "2026-09-14T20:01:00.000Z");
		store.clearPublishedEpicIntakes([row]);
		expect(store.listEpicIntakes("test")[0].pageDirty).toBe(true);
		const current = store.listEpicIntakes("test")[0];
		store.clearPublishedEpicIntakes([current]);
		expect(store.listEpicIntakes("test")[0].pageDirty).toBe(false);
	});
});
