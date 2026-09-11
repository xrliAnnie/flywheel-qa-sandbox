import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

describe("FLY-2478 resident release", () => {
	it("migrates legacy holds without changing their state and survives reopening", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2478-migration-"));
		roots.push(root);
		const path = join(root, "state.db");
		const legacy = new Database(path);
		legacy.exec(`CREATE TABLE workflow_resident_hold (
			execution_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
			attempt INTEGER NOT NULL CHECK (attempt > 0), activation_id TEXT NOT NULL,
			vendor TEXT NOT NULL CHECK (vendor IN ('claude','codex')),
			revision INTEGER NOT NULL CHECK (revision > 0), boundary_seq INTEGER NOT NULL CHECK (boundary_seq > 0),
			state TEXT NOT NULL CHECK (state IN ('resident','woken','expired','closed')),
			grace_started_at TEXT NOT NULL, grace_expires_at TEXT NOT NULL,
			closed_reason TEXT, updated_at TEXT NOT NULL);
			INSERT INTO workflow_resident_hold VALUES ('old-exec','old-run','repair',1,'old-activation','codex',1,1,
			'resident','2026-09-11T00:00:00.000Z','2026-09-11T00:30:00.000Z',NULL,'2026-09-11T00:00:00.000Z');`);
		legacy.close();
		for (let reopen = 0; reopen < 2; reopen++) {
			const store = await StateStore.create(path);
			try {
				expect(
					rawDb(store).prepare("SELECT * FROM workflow_resident_hold").get(),
				).toMatchObject({
					execution_id: "old-exec",
					state: "resident",
					revision: 1,
					grace_expires_at: "2026-09-11T00:30:00.000Z",
					release_cause: null,
					release_source: null,
				});
			} finally {
				store.close();
			}
		}
	});
});
