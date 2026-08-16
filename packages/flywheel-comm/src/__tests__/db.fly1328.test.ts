/**
 * FLY-1328 — runner close cascades the retirement of its own unanswered asks.
 *
 * FLY-1185's closeout contract zeroed branch / worktree / runner / cmux / thread
 * / Linear / MCP but never the CommDB ask queue, so a closed runner's asks sat
 * in the Lead's `pending` list forever and drowned live ones.
 *
 * Closing a runner permanently retires its aged asks while preserving the
 * delivery grace window and review-gate ownership rules.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const HOUR_MS = 60 * 60 * 1000;

function backdate(dbPath: string, questionId: string, sqlOffset: string): void {
	const raw = new Database(dbPath);
	raw
		.prepare(
			`UPDATE mailbox SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) WHERE id = ?`,
		)
		.run(sqlOffset, questionId);
	raw.close();
}

function readRow(
	dbPath: string,
	questionId: string,
): Record<string, unknown> | undefined {
	const raw = new Database(dbPath, { readonly: true });
	const row = raw
		.prepare("SELECT * FROM mailbox_message_projection WHERE id = ?")
		.get(questionId) as Record<string, unknown> | undefined;
	raw.close();
	return row;
}

function expiresAtMs(dbPath: string, questionId: string): number {
	const row = readRow(dbPath, questionId);
	return Date.parse(String(row?.expires_at));
}

describe("FLY-1328 CommDB ask cascade on finalizeSession", () => {
	let db: CommDB;
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-fly1328-db-"));
		dbPath = join(tmpDir, "comm.db");
		db = new CommDB(dbPath);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// already closed by a test that reopens
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── T1: migration ────────────────────────────────────────────────────────
	it("T1a: rejects a pre-cutover messages database until FLY-1572 migration runs", () => {
		const legacyPath = join(tmpDir, "legacy.db");
		const raw = new Database(legacyPath);
		// Pre-FLY-1279 shape: no 'ack_receipt' in the type CHECK, no resolved_via.
		raw.exec(`
			CREATE TABLE messages (
			  id          TEXT PRIMARY KEY,
			  from_agent  TEXT NOT NULL,
			  to_agent    TEXT NOT NULL,
			  type        TEXT NOT NULL CHECK(type IN ('question','response','instruction','progress')),
			  content     TEXT NOT NULL,
			  parent_id   TEXT,
			  read_at     DATETIME,
			  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
			  expires_at  DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours')),
			  FOREIGN KEY (parent_id) REFERENCES messages(id)
			);
			INSERT INTO messages (id, from_agent, to_agent, type, content)
			VALUES ('legacy-q', 'exec-legacy', 'lead', 'question', 'historic ask');
		`);
		raw.close();

		expect(() => new CommDB(legacyPath)).toThrow(/FLY-1572 mailbox migration/);
	});

	it("T1b: re-opening an already-migrated database is idempotent", () => {
		const reopened = new CommDB(dbPath);
		reopened.close();
		const check = new Database(dbPath, { readonly: true });
		const resolvedVia = (
			check.prepare("PRAGMA table_info(mailbox)").all() as Array<{
				name: string;
			}>
		).filter((c) => c.name === "resolved_via");
		check.close();
		expect(resolvedVia).toHaveLength(1);
	});

	it("T1c: a second opener of a live database does not re-run the ADD", () => {
		// Named for what this actually proves. It does NOT exercise the
		// duplicate-column catch (db.ts): the second opener's PRAGMA already sees
		// resolved_via, so it never reaches the ALTER. Reproducing the real race
		// needs two processes interleaved between the PRAGMA read and the ALTER;
		// the catch path itself is the established delivered_at/relay_state
		// pattern. Left honest rather than dressed up as race coverage.
		const racePath = join(tmpDir, "race.db");
		const a = new CommDB(racePath);
		expect(() => {
			const b = new CommDB(racePath);
			b.close();
		}).not.toThrow();
		a.close();
	});

	// ── T2: cascade ──────────────────────────────────────────────────────────
	it("T2: retires the closing runner's aged checkpoint-less asks with resolved_via=owner_closed", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1328", "lead");
		const ask = db.insertQuestion("exec-a", "lead", "which approach?");
		const report = db.insertQuestion("exec-a", "lead", "DONE: shipped", {
			kind: "report",
		});
		backdate(dbPath, ask, "-16 minutes");
		backdate(dbPath, report, "-16 minutes");

		const result = db.finalizeSession("exec-a");
		expect(result.retiredAskCount).toBe(2);
		expect(result.retiredQuestionCount).toBe(0); // gate count semantics unchanged

		for (const qid of [ask, report]) {
			const row = readRow(dbPath, qid);
			expect(row?.relay_state).toBe("terminal_disposed");
			expect(row?.resolved_via).toBe("owner_closed");
			expect(row?.resolved_at).toBeTruthy();
			expect(db.isQuestionPending(qid)).toBe(false);
		}
	});

	it("T2b: keeps the retired ask alive for a 1h forensic window, then purges it", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1328", "lead");
		const ask = db.insertQuestion("exec-a", "lead", "which approach?");
		backdate(dbPath, ask, "-16 minutes");
		db.finalizeSession("exec-a");

		const ttlMs = expiresAtMs(dbPath, ask) - Date.now();
		expect(ttlMs).toBeGreaterThan(0.5 * HOUR_MS);
		expect(ttlMs).toBeLessThanOrEqual(1.05 * HOUR_MS);

		// A fresh open runs purgeExpired — the forensic row must survive it.
		db.close();
		const reopened = new CommDB(dbPath);
		reopened.close();
		expect(readRow(dbPath, ask)?.resolved_via).toBe("owner_closed");

		// Once the forensic TTL lapses, the terminal row remains until the common
		// mailbox retention window also lapses.
		const raw = new Database(dbPath);
		raw
			.prepare(
				`UPDATE mailbox SET expires_at = datetime('now', '-1 hour'),
				 acked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-73 hours') WHERE id = ?`,
			)
			.run(ask);
		raw.close();
		const afterTtl = new CommDB(dbPath);
		afterTtl.close();
		expect(readRow(dbPath, ask)).toBeUndefined();
		db = new CommDB(dbPath);
	});

	it("T3: spares asks inside the 15-minute delivery grace window", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1328", "lead");
		const fresh = db.insertQuestion("exec-a", "lead", "just asked");
		backdate(dbPath, fresh, "-5 minutes");

		expect(db.finalizeSession("exec-a").retiredAskCount).toBe(0);
		const row = readRow(dbPath, fresh);
		expect(row?.relay_state).toBe("open");
		expect(row?.resolved_via).toBeNull();
		expect(db.isQuestionPending(fresh)).toBe(true);
	});

	it("T4: never touches an ask that already has an answer", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1328", "lead");
		const answered = db.insertQuestion("exec-a", "lead", "answered ask");
		backdate(dbPath, answered, "-16 minutes");
		db.insertResponse(answered, "lead", "here you go");
		const before = readRow(dbPath, answered);

		expect(db.finalizeSession("exec-a").retiredAskCount).toBe(0);
		expect(readRow(dbPath, answered)).toEqual(before);
	});

	it("T5: leaves the existing gate contract intact (review gates survive, gates carry resolved_via)", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1328", "lead");
		const brainstorm = db.insertQuestion("exec-a", "lead", "design?", {
			checkpoint: "brainstorm",
		});
		const reviewDesign = db.insertQuestion("exec-a", "lead", "review?", {
			checkpoint: "review_design",
		});
		backdate(dbPath, brainstorm, "-16 minutes");
		backdate(dbPath, reviewDesign, "-16 minutes");

		const result = db.finalizeSession("exec-a");
		expect(result.retiredQuestionCount).toBe(1);
		expect(result.retiredAskCount).toBe(0);
		expect(readRow(dbPath, brainstorm)?.relay_state).toBe("terminal_disposed");
		expect(readRow(dbPath, brainstorm)?.resolved_via).toBe("owner_closed");
		// FLY-1257 defect ④: a review gate is the reviewer's credential, not the
		// author's — it must outlive the author's teardown.
		expect(readRow(dbPath, reviewDesign)?.relay_state).toBe("open");
		expect(db.isQuestionPending(reviewDesign)).toBe(true);
	});

	it("T7: never touches another runner's asks", () => {
		db.registerSession("exec-a", "window-a", "proj", "FLY-1328", "lead");
		db.registerSession("exec-b", "window-b", "proj", "FLY-OTHER", "lead");
		const mine = db.insertQuestion("exec-a", "lead", "mine");
		const theirs = db.insertQuestion("exec-b", "lead", "theirs");
		backdate(dbPath, mine, "-16 minutes");
		backdate(dbPath, theirs, "-16 minutes");

		expect(db.finalizeSession("exec-a").retiredAskCount).toBe(1);
		expect(readRow(dbPath, theirs)?.relay_state).toBe("open");
		expect(db.isQuestionPending(theirs)).toBe(true);
	});
});
