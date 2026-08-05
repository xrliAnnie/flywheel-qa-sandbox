import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const PROVENANCE_COLUMNS = [
	"sender_lease_key",
	"sender_generation",
	"sender_holder_pid",
	"sender_holder_start",
	"writer_pid",
	"writer_start",
] as const;

describe("FLY-1309 CommDB provenance migration", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-commdb-"));
		dbPath = join(dir, "comm.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function columns(table: string): string[] {
		const raw = new Database(dbPath, { readonly: true });
		try {
			return (
				raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
					name: string;
				}>
			).map((column) => column.name);
		} finally {
			raw.close();
		}
	}

	it("stores provenance in one sender_ref while preserving the read projection", () => {
		const db = new CommDB(dbPath);
		db.close();
		expect(columns("mailbox")).toContain("sender_ref");
		expect(columns("mailbox")).not.toEqual(
			expect.arrayContaining([...PROVENANCE_COLUMNS]),
		);
		expect(columns("mailbox_message_projection")).toEqual(
			expect.arrayContaining([...PROVENANCE_COLUMNS]),
		);
	});

	it("rejects a pre-cutover provenance schema until FLY-1572 migration runs", () => {
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
			  expires_at DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours'))
			);
			INSERT INTO messages (id, from_agent, to_agent, type, content)
			VALUES ('legacy-1', 'eng-lead', 'runner-1', 'instruction', 'keep me');
		`);
		legacy.close();

		expect(() => new CommDB(dbPath)).toThrow(/FLY-1572 mailbox migration/);
	});

	it("round-trips pane-holder and writer provenance for instructions and responses", () => {
		const db = new CommDB(dbPath);
		const provenance = {
			senderLeaseKey: "flywheel-eng-lead",
			senderGeneration: 7,
			senderHolderPid: 200,
			senderHolderStart: "Thu Jul 16 01:00:01 2026",
			writerPid: 300,
			writerStart: "Thu Jul 16 01:00:02 2026",
		};
		const instructionId = db.insertInstruction(
			"eng-lead",
			"runner-1",
			"do the thing",
			{ provenance },
		);
		expect(db.getMessageById(instructionId)).toMatchObject({
			sender_lease_key: provenance.senderLeaseKey,
			sender_generation: provenance.senderGeneration,
			sender_holder_pid: provenance.senderHolderPid,
			sender_holder_start: provenance.senderHolderStart,
			writer_pid: provenance.writerPid,
			writer_start: provenance.writerStart,
		});

		const questionId = db.insertQuestion("runner-1", "eng-lead", "which way?");
		db.insertResponse(questionId, "eng-lead", "way A", provenance);
		expect(db.getResponse(questionId)).toMatchObject({
			sender_lease_key: provenance.senderLeaseKey,
			sender_generation: provenance.senderGeneration,
			sender_holder_pid: provenance.senderHolderPid,
			sender_holder_start: provenance.senderHolderStart,
			writer_pid: provenance.writerPid,
			writer_start: provenance.writerStart,
		});
		db.close();
	});

	it("keeps the legacy call shape byte-compatible with null provenance", () => {
		const db = new CommDB(dbPath);
		const id = db.insertInstruction("eng-lead", "runner-1", "legacy");
		expect(db.getMessageById(id)).toMatchObject({
			sender_lease_key: null,
			sender_generation: null,
			sender_holder_pid: null,
			sender_holder_start: null,
			writer_pid: null,
			writer_start: null,
		});
		db.close();
	});
});
