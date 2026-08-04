/** Full-id consumption evidence used by the retained read-only CommDB reader. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGapReader } from "../detection-gap-scan.js";

describe("M8 reader — full-id consumption receipt (real sqlite)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1282-unconsumed-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const SCHEMA = `
		CREATE TABLE messages (
			id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
			type TEXT NOT NULL, content TEXT NOT NULL, parent_id TEXT,
			read_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			expires_at DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours')),
			checkpoint TEXT, delivered_at DATETIME, content_ref TEXT, content_type TEXT
		);
		CREATE TABLE runner_declared_states (
			execution_id TEXT PRIMARY KEY, kind TEXT NOT NULL, reason TEXT,
			created_at INTEGER NOT NULL, expires_at INTEGER, updated_at INTEGER NOT NULL
		);
	`;

	function seedDb(path: string): Database.Database {
		const db = new Database(path);
		db.exec(SCHEMA);
		return db;
	}

	function insertInstruction(
		db: Database.Database,
		id: string,
		opts: { deliveredAgoMin: number },
	): void {
		db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, created_at, expires_at, delivered_at)
			 VALUES (?, 'bridge', 'exec-b1', 'instruction', 'do the thing', datetime('now', ?), datetime('now','+72 hours'), datetime('now', ?))`,
		).run(
			id,
			`-${opts.deliveredAgoMin} minutes`,
			`-${opts.deliveredAgoMin} minutes`,
		);
	}

	function insertRunnerReport(
		db: Database.Database,
		content: string,
		opts: { createdAgoMin: number },
	): void {
		db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, created_at, expires_at)
			 VALUES (hex(randomblob(8)), 'exec-b1', 'eng-lead', 'question', ?, datetime('now', ?), datetime('now','+72 hours'))`,
		).run(content, `-${opts.createdAgoMin} minutes`);
	}

	function readAge(path: string, v2: boolean): number | null {
		const reader = openGapReader(path);
		expect(reader).not.toBeNull();
		const ev = reader!.evidenceFor("exec-b1", null, Date.now(), {
			deliveryUnconsumedV2: v2,
		});
		reader!.close();
		return ev.oldestUnconsumedDeliveryAgeMs;
	}

	it("full-id receipt clears the instruction (V2); V1 still reports it", () => {
		const path = join(dir, "comm.db");
		const db = seedDb(path);
		insertInstruction(db, "f53f69c0-e778-4786-83f0-beec2365c6d9", {
			deliveredAgoMin: 45,
		});
		insertRunnerReport(
			db,
			"DONE: [lead-instruction f53f69c0-e778-4786-83f0-beec2365c6d9] evidence folded",
			{ createdAgoMin: 40 },
		);
		db.close();
		expect(readAge(path, true)).toBeNull(); // V2: consumed
		expect(readAge(path, false)).toBeGreaterThan(2_000_000); // V1: legacy
	});

	it("A/B counterexample: report references only A → B stays unconsumed", () => {
		const path = join(dir, "comm.db");
		const db = seedDb(path);
		insertInstruction(db, "aaaaaaaa-1111", { deliveredAgoMin: 50 });
		insertInstruction(db, "bbbbbbbb-2222", { deliveredAgoMin: 45 });
		insertRunnerReport(db, "DONE: [lead-instruction aaaaaaaa-1111] did A", {
			createdAgoMin: 30,
		});
		db.close();
		const age = readAge(path, true);
		expect(age).not.toBeNull();
		// oldest remaining = B (45min), not A (50min, consumed)
		expect(age!).toBeGreaterThan(2_500_000);
		expect(age!).toBeLessThan(2_900_000);
	});

	it("8-char prefix does NOT clear (full id only)", () => {
		const path = join(dir, "comm.db");
		const db = seedDb(path);
		insertInstruction(db, "f53f69c0-e778-4786-83f0-beec2365c6d9", {
			deliveredAgoMin: 45,
		});
		insertRunnerReport(db, "DONE: [lead-instruction f53f69c0] short ref", {
			createdAgoMin: 40,
		});
		db.close();
		expect(readAge(path, true)).toBeGreaterThan(2_000_000);
	});

	it("cross-second race: report BEFORE the delivered_at stamp still clears (no time comparison)", () => {
		// send.ts stamps delivered_at only after the mailbox wake returns; the
		// runner can quote the full id before the stamp lands. R12 #1: the
		// receipt must not depend on created_at vs delivered_at ordering.
		const path = join(dir, "comm.db");
		const db = seedDb(path);
		insertInstruction(db, "cccccccc-3333", { deliveredAgoMin: 30 });
		// report timestamped EARLIER than the delivery stamp
		insertRunnerReport(db, "DONE: [lead-instruction cccccccc-3333] done", {
			createdAgoMin: 31,
		});
		db.close();
		expect(readAge(path, true)).toBeNull();
	});

	it("old-template report (no id at all) still triggers — the honest residual", () => {
		const path = join(dir, "comm.db");
		const db = seedDb(path);
		insertInstruction(db, "dddddddd-4444", { deliveredAgoMin: 45 });
		insertRunnerReport(db, "DONE: finished the retest | commits: abc", {
			createdAgoMin: 10,
		});
		db.close();
		expect(readAge(path, true)).toBeGreaterThan(2_000_000);
	});

	it("EXPLAIN QUERY PLAN: outer query drives off the to_agent index (shape lock)", () => {
		const path = join(dir, "comm.db");
		const db = seedDb(path);
		db.exec(
			"CREATE INDEX idx_messages_to_agent ON messages(to_agent, type, created_at)",
		);
		const plan = db
			.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT MIN(m.delivered_at) AS oldest FROM messages m
				 WHERE m.to_agent = ? AND m.type = 'instruction'
				   AND m.delivered_at IS NOT NULL AND m.read_at IS NULL
				   AND NOT EXISTS (
				     SELECT 1 FROM messages r
				     WHERE r.from_agent = m.to_agent AND instr(r.content, m.id) > 0
				   )`,
			)
			.all("exec-b1") as Array<{ detail: string }>;
		db.close();
		const details = plan.map((p) => p.detail).join(" | ");
		expect(details).toMatch(/idx_messages_to_agent/);
	});
});
