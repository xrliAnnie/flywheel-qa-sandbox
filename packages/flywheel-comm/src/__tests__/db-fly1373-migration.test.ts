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

	it("creates deadline_at on the unified mailbox", () => {
		new CommDB(dbPath).close();
		const raw = new Database(dbPath, { readonly: true });
		try {
			const columns = raw.prepare("PRAGMA table_info(mailbox)").all() as Array<{
				name: string;
			}>;
			expect(columns.map(({ name }) => name)).toContain("deadline_at");
		} finally {
			raw.close();
		}
	});

	it("round-trips deadline_at through the message projection", () => {
		const migrated = new CommDB(dbPath);
		try {
			const id = migrated.insertQuestion("runner", "lead-a", "keep me", {
				deadlineAt: "2026-07-20T08:30:00.000Z",
			});
			expect(migrated.getMessageById(id)).toMatchObject({
				content: "keep me",
				deadline_at: "2026-07-20T08:30:00.000Z",
			});
		} finally {
			migrated.close();
		}
	});
});
