/**
 * FLY-1048 Task A6: cheap gap/state scan (zero token, minutes-scale).
 *
 * PR-A contract: the scan OBSERVES only (registry + debug logs + query API) —
 * no user-visible notification leg exists until PR-C. Judgements are pure
 * functions; CommDB reads degrade per-table/per-column (openReadonly skips
 * migrations, so an old comm.db may miss tables/columns — that must read as
 * "no signal", never throw, never false-positive).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSuspicionRegistry,
	evaluatedGapConditions,
	evaluateGapSuspicion,
	type GapCommEvidence,
	type GapScanInput,
	openGapReader,
} from "../detection-gap-scan.js";

const NOW = 1_700_000_000_000;
const THRESHOLDS = {
	askUnansweredMs: 1_800_000,
	unconsumedMs: 1_800_000,
	progressStallMs: 2_700_000,
	commWindowMs: 1_800_000,
};

function baseInput(over: {
	session?: Partial<GapScanInput["session"]>;
	comm?: Partial<GapCommEvidence>;
	founderNotified?: boolean | null;
}): GapScanInput {
	return {
		session: {
			executionId: "exec-1",
			projectName: "flywheel",
			status: "running",
			lastActivityAtMs: NOW - 60_000,
			...over.session,
		},
		comm: {
			declaredParked: false,
			pendingQuestionCount: 0,
			pendingBlockingGateCount: 0,
			outbound: { readable: true, latestAgeMs: 60_000 },
			oldestUnansweredAskAgeMs: null,
			askSignalReadable: true,
			oldestUnconsumedDeliveryAgeMs: null,
			unconsumedSignalReadable: true,
			...over.comm,
		},
		founderNotified:
			over.founderNotified === undefined ? false : over.founderNotified,
		nowMs: NOW,
		thresholds: THRESHOLDS,
	};
}

const kinds = (input: GapScanInput) =>
	evaluateGapSuspicion(input).map((r) => r.kind);

describe("evaluateGapSuspicion — gap1 parked_unreported (漏①)", () => {
	it("declared parked + no pending question + no lead comm + no founder evidence → triggers", () => {
		const input = baseInput({
			comm: {
				declaredParked: true,
				outbound: { readable: true, latestAgeMs: null },
			},
		});
		expect(kinds(input)).toContain("gap1_parked_unreported");
	});

	it("awaiting_review WITHOUT any pending question → triggers (evidence-missing park)", () => {
		const input = baseInput({
			session: { status: "awaiting_review" },
			comm: { outbound: { readable: true, latestAgeMs: null } },
		});
		expect(kinds(input)).toContain("gap1_parked_unreported");
	});

	it("R1 silence rule: founder already notified → NEVER triggers", () => {
		const input = baseInput({
			comm: {
				declaredParked: true,
				outbound: { readable: true, latestAgeMs: null },
			},
			founderNotified: true,
		});
		expect(kinds(input)).not.toContain("gap1_parked_unreported");
	});

	it("a pending question IS the reporting artifact → no trigger", () => {
		const input = baseInput({
			comm: {
				declaredParked: true,
				pendingQuestionCount: 1,
				outbound: { readable: true, latestAgeMs: null },
			},
		});
		expect(kinds(input)).not.toContain("gap1_parked_unreported");
	});

	it("recent lead comm within the window → no trigger", () => {
		const input = baseInput({
			comm: {
				declaredParked: true,
				outbound: { readable: true, latestAgeMs: 120_000 },
			},
		});
		expect(kinds(input)).not.toContain("gap1_parked_unreported");
	});

	it("degrades to silence when any required signal is unreadable (fail-closed)", () => {
		for (const comm of [
			{ pendingQuestionCount: null },
			{ outbound: { readable: false as const } },
		]) {
			const input = baseInput({
				comm: {
					declaredParked: true,
					outbound: { readable: true, latestAgeMs: null },
					...comm,
				},
			});
			expect(kinds(input)).not.toContain("gap1_parked_unreported");
		}
		const noEvents = baseInput({
			comm: {
				declaredParked: true,
				outbound: { readable: true, latestAgeMs: null },
			},
			founderNotified: null,
		});
		expect(kinds(noEvents)).not.toContain("gap1_parked_unreported");
	});
});

describe("evaluateGapSuspicion — gap2 ask_unanswered (漏②, non-blocking ask)", () => {
	it("unanswered non-blocking ask over threshold → triggers", () => {
		const input = baseInput({
			comm: { oldestUnansweredAskAgeMs: 1_900_000 },
		});
		expect(kinds(input)).toContain("gap2_ask_unanswered");
	});

	it("under threshold / no asks → no trigger", () => {
		expect(
			kinds(baseInput({ comm: { oldestUnansweredAskAgeMs: 600_000 } })),
		).not.toContain("gap2_ask_unanswered");
		expect(
			kinds(baseInput({ comm: { oldestUnansweredAskAgeMs: null } })),
		).not.toContain("gap2_ask_unanswered");
	});
});

describe("evaluateGapSuspicion — delivery_unconsumed (D6)", () => {
	it("delivered-but-unread over threshold → triggers", () => {
		const input = baseInput({
			comm: { oldestUnconsumedDeliveryAgeMs: 1_900_000 },
		});
		expect(kinds(input)).toContain("delivery_unconsumed");
	});

	it("no signal → no trigger", () => {
		expect(
			kinds(baseInput({ comm: { oldestUnconsumedDeliveryAgeMs: null } })),
		).not.toContain("delivery_unconsumed");
	});
});

describe("evaluateGapSuspicion — pane_progress_suspect (feeds A7 only)", () => {
	it("running session stalled past the progress threshold → suspect", () => {
		const input = baseInput({
			session: { lastActivityAtMs: NOW - 3_000_000 },
		});
		expect(kinds(input)).toContain("pane_progress_suspect");
	});

	it("non-running or recently-active sessions are not suspects", () => {
		expect(
			kinds(
				baseInput({
					session: {
						status: "awaiting_review",
						lastActivityAtMs: NOW - 3_000_000,
					},
					comm: { pendingQuestionCount: 1 },
				}),
			),
		).not.toContain("pane_progress_suspect");
		expect(
			kinds(baseInput({ session: { lastActivityAtMs: NOW - 60_000 } })),
		).not.toContain("pane_progress_suspect");
	});
});

describe("SuspicionRegistry", () => {
	it("keeps firstSeenMs across sweeps and drops cleared conditions", () => {
		const reg = createSuspicionRegistry();
		reg.sweep(
			[
				{
					kind: "gap2_ask_unanswered",
					targetKey: "exec-1",
					projectName: "flywheel",
					firstSeenMs: NOW,
					evidence: "ask 31min unanswered",
				},
			],
			NOW,
		);
		reg.sweep(
			[
				{
					kind: "gap2_ask_unanswered",
					targetKey: "exec-1",
					projectName: "flywheel",
					firstSeenMs: NOW + 300_000,
					evidence: "ask 36min unanswered",
				},
				{
					kind: "pane_progress_suspect",
					targetKey: "exec-2",
					projectName: "flywheel",
					firstSeenMs: NOW + 300_000,
					evidence: "no activity 46min",
				},
			],
			NOW + 300_000,
		);
		const snap = reg.snapshot();
		expect(snap).toHaveLength(2);
		expect(snap.find((r) => r.targetKey === "exec-1")?.firstSeenMs).toBe(NOW);
		// Third sweep: exec-1 recovered → dropped; exec-2 persists.
		reg.sweep(
			[
				{
					kind: "pane_progress_suspect",
					targetKey: "exec-2",
					projectName: "flywheel",
					firstSeenMs: NOW + 600_000,
					evidence: "no activity 51min",
				},
			],
			NOW + 600_000,
		);
		expect(reg.snapshot()).toHaveLength(1);
		expect(reg.snapshot()[0]!.targetKey).toBe("exec-2");
	});
});

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
		).run(NOW - 3_600_000, NOW - 3_600_000);
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
 * Codex PR-C R4 finding 1 (HIGH): absence of a suspicion record is durable
 * "condition cleared" evidence ONLY when the kind's judgement actually ran
 * with every required signal readable. A degraded signal (missing schema,
 * unreadable founder evidence) suppresses the record WITHOUT proving the
 * condition cleared — such kinds must not appear in the evaluated set.
 */
describe("evaluatedGapConditions (Codex R4 #1 — signal-level observability)", () => {
	it("all signals readable → all three escalation kinds evaluated", () => {
		const set = evaluatedGapConditions(baseInput({}));
		expect(set.has("gap1_parked_unreported")).toBe(true);
		expect(set.has("gap2_ask_unanswered")).toBe(true);
		expect(set.has("delivery_unconsumed")).toBe(true);
	});

	it("ask signal unreadable → gap2 NOT evaluated (others unaffected)", () => {
		const set = evaluatedGapConditions(
			baseInput({ comm: { askSignalReadable: false } }),
		);
		expect(set.has("gap2_ask_unanswered")).toBe(false);
		expect(set.has("delivery_unconsumed")).toBe(true);
	});

	it("unconsumed signal unreadable → delivery_unconsumed NOT evaluated", () => {
		const set = evaluatedGapConditions(
			baseInput({ comm: { unconsumedSignalReadable: false } }),
		);
		expect(set.has("delivery_unconsumed")).toBe(false);
		expect(set.has("gap2_ask_unanswered")).toBe(true);
	});

	it("founder evidence unreadable (null) → gap1 NOT evaluated", () => {
		const set = evaluatedGapConditions(baseInput({ founderNotified: null }));
		expect(set.has("gap1_parked_unreported")).toBe(false);
	});

	it("pending-question count unreadable → gap1 NOT evaluated", () => {
		const set = evaluatedGapConditions(
			baseInput({ comm: { pendingQuestionCount: null } }),
		);
		expect(set.has("gap1_parked_unreported")).toBe(false);
	});

	it("outbound unreadable → gap1 NOT evaluated", () => {
		const set = evaluatedGapConditions(
			baseInput({ comm: { outbound: { readable: false } } }),
		);
		expect(set.has("gap1_parked_unreported")).toBe(false);
	});

	it("declaredParked unreadable on a NON-awaiting session → gap1 NOT evaluated (parkedish itself unknowable)", () => {
		const set = evaluatedGapConditions(
			baseInput({ comm: { declaredParked: null } }),
		);
		expect(set.has("gap1_parked_unreported")).toBe(false);
	});

	it("declaredParked unreadable but status IS awaiting_review → gap1 still evaluated (parkedish provable from status)", () => {
		const set = evaluatedGapConditions(
			baseInput({
				session: { status: "awaiting_review" },
				comm: { declaredParked: null },
			}),
		);
		expect(set.has("gap1_parked_unreported")).toBe(true);
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
