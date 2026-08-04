/** Read-only CommDB evidence used by retained runner liveness confirmation. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGapReader } from "../detection-gap-scan.js";

describe("openGapReader — readonly tri-state degradation", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1048-gap-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const FULL_SCHEMA = `
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

	function makeDb(path: string, schema: string): Database.Database {
		const db = new Database(path);
		db.exec(schema);
		return db;
	}

	it("full schema: reads declared park, pending asks, outbound, unconsumed deliveries", () => {
		const path = join(dir, "comm.db");
		const db = makeDb(path, FULL_SCHEMA);
		db.prepare(
			"INSERT INTO runner_declared_states VALUES ('exec-1','parked','waiting review',?,NULL,?)",
		).run(Date.now() - 3_600_000, Date.now() - 3_600_000);
		// Unanswered non-blocking ask, 40min old.
		db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, created_at, expires_at)
			 VALUES ('q1','exec-1','eng-lead','question','need input', datetime('now','-40 minutes'), datetime('now','+72 hours'))`,
		).run();
		// Delivered-but-unread instruction, 35min old.
		db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, created_at, expires_at, delivered_at)
			 VALUES ('i1','bridge','exec-1','instruction','do x', datetime('now','-35 minutes'), datetime('now','+72 hours'), datetime('now','-35 minutes'))`,
		).run();
		// A BLOCKING gate from another exec (must not leak into exec-1 counts).
		db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, checkpoint, created_at, expires_at)
			 VALUES ('g1','exec-2','eng-lead','question','approve?', 'approve_to_ship', datetime('now','-5 minutes'), datetime('now','+72 hours'))`,
		).run();
		db.close();

		const reader = openGapReader(path);
		expect(reader).not.toBeNull();
		const ev = reader!.evidenceFor("exec-1", "eng-lead", Date.now());
		reader!.close();
		expect(ev.declaredParked).toBe(true);
		expect(ev.pendingQuestionCount).toBe(1);
		// PR-B (Codex R1 HIGH): the ask has checkpoint NULL — it must never
		// count as b_parked corroboration.
		expect(ev.pendingBlockingGateCount).toBe(0);
		expect(ev.outbound.readable).toBe(true);
		if (ev.outbound.readable) {
			// The ask itself is exec→lead traffic.
			expect(ev.outbound.latestAgeMs).toBeGreaterThan(2_000_000);
		}
		expect(ev.oldestUnansweredAskAgeMs).toBeGreaterThan(2_000_000);
		expect(ev.oldestUnconsumedDeliveryAgeMs).toBeGreaterThan(1_900_000);
	});

	it("missing runner_declared_states table → declaredParked null, rest works", () => {
		const path = join(dir, "comm.db");
		makeDb(
			path,
			FULL_SCHEMA.replace(/CREATE TABLE runner_declared_states[\s\S]*?\);/, ""),
		).close();
		const reader = openGapReader(path);
		const ev = reader!.evidenceFor("exec-1", "eng-lead", Date.now());
		reader!.close();
		expect(ev.declaredParked).toBeNull();
		expect(ev.pendingQuestionCount).toBe(0);
	});

	it("missing delivered_at / checkpoint columns → those signals degrade to null", () => {
		const path = join(dir, "comm.db");
		makeDb(
			path,
			`CREATE TABLE messages (
				id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
				type TEXT NOT NULL, content TEXT NOT NULL, parent_id TEXT,
				read_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				expires_at DATETIME NOT NULL DEFAULT (datetime('now', '+72 hours'))
			);`,
		).close();
		const reader = openGapReader(path);
		const ev = reader!.evidenceFor("exec-1", "eng-lead", Date.now());
		reader!.close();
		expect(ev.oldestUnconsumedDeliveryAgeMs).toBeNull();
		expect(ev.oldestUnansweredAskAgeMs).toBeNull();
		expect(ev.pendingBlockingGateCount).toBeNull();
		// Outbound query needs no optional column → still readable.
		expect(ev.outbound.readable).toBe(true);
	});

	it("missing db file → openGapReader returns null (project skipped fail-closed)", () => {
		expect(openGapReader(join(dir, "nope", "comm.db"))).toBeNull();
	});
});

/**
 * Codex PR-C R5 finding 1 (HIGH): a successful SQL query is NOT a completed
 * judgement when its selected timestamp cannot be parsed — collapsing that
 * case into the "no matching row" shape (readable:true, age null) lets a
 * PERSISTENT overdue ask/delivery be absence-cleared. Unparsable non-null
 * timestamps must mark the signal unreadable.
 */
describe("openGapReader — unparsable non-null timestamps are UNREADABLE (Codex R5 #1)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1048-gap-r5-"));
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

	it("a garbage created_at on the oldest unanswered ask → askSignalReadable false", () => {
		const path = join(dir, "comm.db");
		const db = new Database(path);
		db.exec(SCHEMA);
		db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, created_at, expires_at)
			 VALUES ('q1','exec-1','eng-lead','question','need input', 'not-a-timestamp', datetime('now','+72 hours'))`,
		).run();
		db.close();
		const reader = openGapReader(path);
		const ev = reader!.evidenceFor("exec-1", "eng-lead", Date.now());
		reader!.close();
		expect(ev.askSignalReadable).toBe(false);
		expect(ev.oldestUnansweredAskAgeMs).toBeNull();
	});

	it("a garbage delivered_at on the oldest unconsumed delivery → unconsumedSignalReadable false", () => {
		const path = join(dir, "comm.db");
		const db = new Database(path);
		db.exec(SCHEMA);
		db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, created_at, expires_at, delivered_at)
			 VALUES ('i1','bridge','exec-1','instruction','do x', datetime('now','-35 minutes'), datetime('now','+72 hours'), 'garbage')`,
		).run();
		db.close();
		const reader = openGapReader(path);
		const ev = reader!.evidenceFor("exec-1", "eng-lead", Date.now());
		reader!.close();
		expect(ev.unconsumedSignalReadable).toBe(false);
	});

	it("a garbage latest outbound timestamp → outbound unreadable (gap1 judgement cannot run)", () => {
		const path = join(dir, "comm.db");
		const db = new Database(path);
		db.exec(SCHEMA);
		db.prepare(
			`INSERT INTO messages (id, from_agent, to_agent, type, content, created_at, expires_at)
			 VALUES ('m1','exec-1','eng-lead','response','ok', 'broken-ts', datetime('now','+72 hours'))`,
		).run();
		db.close();
		const reader = openGapReader(path);
		const ev = reader!.evidenceFor("exec-1", "eng-lead", Date.now());
		reader!.close();
		expect(ev.outbound.readable).toBe(false);
	});
});
