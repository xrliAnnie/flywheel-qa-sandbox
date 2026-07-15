import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1279 Lead delivery journal migration", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps historical events ACK-exempt while adding the durable state machine", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1279-lead-event-migrate-"));
		dirs.push(dir);
		const dbPath = join(dir, "teamlead.db");
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE lead_events (
			  seq INTEGER PRIMARY KEY AUTOINCREMENT,
			  lead_id TEXT NOT NULL,
			  event_id TEXT NOT NULL,
			  event_type TEXT NOT NULL,
			  payload TEXT NOT NULL,
			  session_key TEXT,
			  delivered_at TEXT,
			  delivery_attempts INTEGER NOT NULL DEFAULT 0,
			  last_delivery_error TEXT,
			  created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			INSERT INTO lead_events
			  (lead_id, event_id, event_type, payload, session_key, delivered_at)
			VALUES
			  ('lead-old', 'event-old', 'gate_question', '{}', 'exec-old', datetime('now'));
		`);
		legacy.close();

		const store = await StateStore.create(dbPath);
		try {
			const row = store.getLeadEventBySeq(1);
			expect(row).toMatchObject({
				lead_id: "lead-old",
				ack_required: false,
				ack_owner_lead_id: "lead-old",
				ack_owner_epoch: 0,
			});
			expect(store.listOpenAckLeadEvents()).toEqual([]);
			expect(store.getActiveDeliverySecretId()).toBeNull();
		} finally {
			store.close();
		}
	});
});
