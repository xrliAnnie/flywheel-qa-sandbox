import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	installObservationStorage,
	OBSERVATION_MIGRATION_ID,
} from "../observation-cursor.js";

function sourceDatabase() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE state_store_migration(migration_id TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
		CREATE TABLE session_events(id INTEGER PRIMARY KEY AUTOINCREMENT,project_name TEXT,source TEXT,event_type TEXT,payload TEXT,issue_id TEXT,ts TEXT);
		CREATE TABLE workflow_founder_gate_verdict(verdict_id TEXT PRIMARY KEY,recorded_at TEXT);
		CREATE TABLE workflow_gate_holder(question_id TEXT PRIMARY KEY,run_id TEXT);
		CREATE TABLE workflow_run(run_id TEXT PRIMARY KEY,project_name TEXT,issue_id TEXT);
	`);
	return db;
}

describe("observation storage migration", () => {
	it("isolates migration failure during StateStore startup and disables old observation SQL", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fly2563-migration-"));
		const path = join(directory, "store.db");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let store: StateStore | undefined;
		try {
			store = await StateStore.create(path);
			expect(store.getShipJudgmentObservationStorage()).toEqual({
				status: "ready",
				reason: null,
			});
			store.close();
			store = undefined;
			const raw = new Database(path);
			try {
				raw.exec(
					"DROP INDEX idx_fly2563_verdict_cursor; CREATE INDEX idx_fly2563_verdict_cursor ON workflow_founder_gate_verdict(verdict_id)",
				);
			} finally {
				raw.close();
			}
			store = await StateStore.create(path);
			expect(store.getShipJudgmentObservationStorage()).toEqual({
				status: "unavailable",
				reason: "schema_drift",
			});
			expect(() => store!.getShipJudgmentOutcomes()).toThrow(
				"observation_storage_unavailable",
			);
			expect(warn).toHaveBeenCalled();
			// Unrelated authoritative store access remains usable after failure.
			expect(store.getSession("missing")).toBeUndefined();
		} finally {
			store?.close();
			warn.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("installs atomically and resumes existing progress on repeated startup", () => {
		const db = sourceDatabase();
		try {
			installObservationStorage(db);
			expect(
				db
					.prepare(
						"SELECT source_kind,last_event_id,last_recorded_at FROM ship_judgment_observation_cursor ORDER BY source_kind",
					)
					.all(),
			).toEqual([
				{ source_kind: "b2", last_event_id: 0, last_recorded_at: "" },
				{ source_kind: "closeout", last_event_id: 0, last_recorded_at: "" },
			]);
			db.exec(
				"UPDATE ship_judgment_observation_cursor SET last_event_id=123 WHERE source_kind='closeout'",
			);
			installObservationStorage(db);
			expect(
				db
					.prepare(
						"SELECT last_event_id FROM ship_judgment_observation_cursor WHERE source_kind='closeout'",
					)
					.get(),
			).toEqual({ last_event_id: 123 });
			expect(
				db.prepare("SELECT migration_id FROM state_store_migration").all(),
			).toEqual([{ migration_id: OBSERVATION_MIGRATION_ID }]);
			expect(
				db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all(),
			).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("keeps the emergency index and uses the source-id index without a temporary sort", () => {
		const db = sourceDatabase();
		try {
			db.exec(`CREATE INDEX idx_session_events_closeout_canceled ON session_events(project_name,source,issue_id,ts)
			 WHERE event_type='closeout_report' AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.disposition')='canceled'`);
			const emergency = db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE name='idx_session_events_closeout_canceled'",
				)
				.get();
			db.exec(`INSERT INTO session_events(project_name,source,event_type,payload) VALUES
			 ('flywheel','bridge.lifecycle-closeout','closeout_report','invalid json'),
			 ('flywheel','bridge.lifecycle-closeout','closeout_report','{"disposition":"canceled"}')`);
			installObservationStorage(db);
			expect(
				db
					.prepare(
						"SELECT sql FROM sqlite_master WHERE name='idx_session_events_closeout_canceled'",
					)
					.get(),
			).toEqual(emergency);
			const query = `SELECT id FROM session_events INDEXED BY idx_fly2563_closeout_cursor
			 WHERE project_name=? AND source='bridge.lifecycle-closeout' AND event_type='closeout_report'
			 AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.disposition')='canceled'
			 AND id>? ORDER BY id LIMIT 32`;
			expect(db.prepare(query).all("flywheel", 0)).toEqual([{ id: 2 }]);
			const plan = JSON.stringify(
				db.prepare(`EXPLAIN QUERY PLAN ${query}`).all("flywheel", 0),
			);
			expect(plan).toContain("idx_fly2563_closeout_cursor");
			expect(plan).not.toContain("TEMP B-TREE");
		} finally {
			db.close();
		}
	});

	it("rejects a same-name different definition and rolls back every new object", () => {
		const db = sourceDatabase();
		try {
			db.exec(
				"CREATE INDEX idx_fly2563_verdict_cursor ON workflow_founder_gate_verdict(verdict_id,recorded_at)",
			);
			expect(() => installObservationStorage(db)).toThrow(
				"observation_schema_drift",
			);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE name='idx_fly2563_closeout_cursor' OR name LIKE 'ship_judgment_observation_%'",
					)
					.all(),
			).toEqual([]);
			expect(db.prepare("SELECT * FROM state_store_migration").all()).toEqual(
				[],
			);
		} finally {
			db.close();
		}
	});

	it("rolls back DDL and cursor initialization when the migration receipt cannot commit", () => {
		const db = sourceDatabase();
		try {
			db.exec(
				"CREATE TRIGGER reject_receipt BEFORE INSERT ON state_store_migration BEGIN SELECT RAISE(ABORT,'receipt rejected'); END",
			);
			expect(() => installObservationStorage(db)).toThrow("receipt rejected");
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE name LIKE 'idx_fly2563_%' OR name LIKE 'ship_judgment_observation_%'",
					)
					.all(),
			).toEqual([]);
		} finally {
			db.close();
		}
	});
});
