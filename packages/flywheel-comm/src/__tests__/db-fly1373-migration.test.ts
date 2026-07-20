import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("FLY-1373 message deadline migration", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1373-migration-"));
		dbPath = join(dir, "comm.db");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("creates deadline_at on a fresh database", () => {
		new CommDB(dbPath).close();
		const raw = new Database(dbPath, { readonly: true });
		try {
			const columns = raw
				.prepare("PRAGMA table_info(messages)")
				.all() as Array<{
				name: string;
			}>;
			expect(columns.map(({ name }) => name)).toContain("deadline_at");
		} finally {
			raw.close();
		}
	});

	it("preserves deadline_at and its data through the pre-ack rebuild", () => {
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE messages (
			  id TEXT PRIMARY KEY,
			  from_agent TEXT NOT NULL,
			  to_agent TEXT NOT NULL,
			  type TEXT NOT NULL CHECK(type IN ('question','response','instruction','progress')),
			  content TEXT NOT NULL,
			  parent_id TEXT,
			  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			  expires_at DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours')),
			  deadline_at TEXT
			);
			INSERT INTO messages (id, from_agent, to_agent, type, content, deadline_at)
			VALUES ('legacy-q', 'runner', 'lead-a', 'question', 'keep me', '2026-07-20T08:30:00.000Z');
		`);
		legacy.close();

		const migrated = new CommDB(dbPath);
		try {
			expect(migrated.getMessageById("legacy-q")).toMatchObject({
				content: "keep me",
				deadline_at: "2026-07-20T08:30:00.000Z",
			});
		} finally {
			migrated.close();
		}
	});
});
