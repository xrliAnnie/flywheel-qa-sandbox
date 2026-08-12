import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("detection settlement-lineage retirement", () => {
	it("drops the entire legacy column family together and preserves episode data", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1645-detection-lineage-"));
		roots.push(root);
		const dbPath = join(root, "state.db");
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE detection_escalations (
				target_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				episode_fingerprint TEXT NOT NULL,
				issue_id TEXT,
				owner_lead_id TEXT,
				first_detected_at_ms INTEGER NOT NULL,
				lead_notified_at_ms INTEGER,
				lead_ack_at_ms INTEGER,
				founder_paged_at_ms INTEGER,
				clearing_since_ms INTEGER,
				status TEXT NOT NULL DEFAULT 'NEW',
				attempts INTEGER NOT NULL DEFAULT 0,
				resolved_via TEXT,
				source_receipt_id TEXT,
				source_execution_id TEXT,
				source_question_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (target_key, kind, episode_fingerprint)
			);
			INSERT INTO detection_escalations
				(target_key, kind, episode_fingerprint, issue_id, owner_lead_id,
				 first_detected_at_ms, status, attempts, source_receipt_id,
				 source_execution_id, source_question_id)
			VALUES
				('exec-1', 'wake_failed', 'fp-1', 'FLY-1', 'lead-1',
				 1000, 'LEAD_NOTIFIED', 2, 'legacy-root', 'exec-1', 'q-1');
			CREATE INDEX idx_detection_escalations_source_receipt
				ON detection_escalations(source_receipt_id);
		`);
		legacy.close();

		const store = await StateStore.create(dbPath);
		expect(
			store.getDetectionEscalation("exec-1", "wake_failed", "fp-1"),
		).toMatchObject({
			issue_id: "FLY-1",
			owner_lead_id: "lead-1",
			status: "LEAD_NOTIFIED",
			attempts: 2,
		});
		store.close();

		const migrated = new Database(dbPath, { readonly: true });
		const columns = migrated
			.prepare("PRAGMA table_info(detection_escalations)")
			.all()
			.map((row) => (row as { name: string }).name);
		expect(columns).not.toContain("source_receipt_id");
		expect(columns).not.toContain("source_execution_id");
		expect(columns).not.toContain("source_question_id");
		expect(
			migrated
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_detection_escalations_source_receipt'",
				)
				.get(),
		).toBeUndefined();
		expect(
			migrated
				.prepare(
					"SELECT target_key, kind, episode_fingerprint, status, attempts FROM detection_escalations",
				)
				.get(),
		).toEqual({
			target_key: "exec-1",
			kind: "wake_failed",
			episode_fingerprint: "fp-1",
			status: "LEAD_NOTIFIED",
			attempts: 2,
		});
		migrated.close();

		const reopened = await StateStore.create(dbPath);
		expect(
			reopened.getDetectionEscalation("exec-1", "wake_failed", "fp-1"),
		).toMatchObject({ status: "LEAD_NOTIFIED", attempts: 2 });
		reopened.close();
	});

	it("rolls the whole family back to inert tombstones when SQLite rejects a drop", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1645-detection-tombstone-"));
		roots.push(root);
		const dbPath = join(root, "state.db");
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE detection_escalations (
				target_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				episode_fingerprint TEXT NOT NULL,
				issue_id TEXT,
				owner_lead_id TEXT,
				first_detected_at_ms INTEGER NOT NULL,
				lead_notified_at_ms INTEGER,
				lead_ack_at_ms INTEGER,
				founder_paged_at_ms INTEGER,
				clearing_since_ms INTEGER,
				status TEXT NOT NULL DEFAULT 'NEW',
				attempts INTEGER NOT NULL DEFAULT 0,
				resolved_via TEXT,
				source_receipt_id TEXT,
				source_execution_id TEXT,
				source_question_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (target_key, kind, episode_fingerprint)
			);
			INSERT INTO detection_escalations
				(target_key, kind, episode_fingerprint, first_detected_at_ms,
				 source_receipt_id, source_execution_id, source_question_id)
			VALUES ('exec-2', 'wake_failed', 'fp-2', 2000, 'root-2', 'exec-2', 'q-2');
			CREATE TRIGGER detection_lineage_guard
			AFTER UPDATE OF source_receipt_id ON detection_escalations
			BEGIN
				SELECT NEW.source_receipt_id;
			END;
		`);
		legacy.close();

		const store = await StateStore.create(dbPath);
		expect(
			store.getDetectionEscalation("exec-2", "wake_failed", "fp-2"),
		).toMatchObject({ status: "NEW", attempts: 0 });
		store.close();

		const tombstoned = new Database(dbPath, { readonly: true });
		const columns = tombstoned
			.prepare("PRAGMA table_info(detection_escalations)")
			.all()
			.map((row) => (row as { name: string }).name);
		expect(columns).toEqual(
			expect.arrayContaining([
				"source_receipt_id",
				"source_execution_id",
				"source_question_id",
			]),
		);
		tombstoned.close();
	});
});
