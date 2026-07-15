/**
 * FLY-1041 Fix A (backstop) — superseded-ship-gate sweeper in the GatePoller
 * relay loop.
 *
 * The event-route retire (main path) can miss a window (crash between rebind
 * and retire, manual gate fire). The sweeper converges those: a pending
 * approve_to_ship gate whose session is bound to a STRICTLY NEWER question is
 * superseded → retire + audit + skip relay/card this tick.
 *
 * CONSERVATIVE by design: same-second (SQLite 1s resolution) or missing data
 * NEVER retires — a false negative costs pending-gate noise until TTL; a false
 * positive would kill the founder's only bindable gate.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	GatePoller,
	type GatePollerConfig,
	isSupersededShipGate,
} from "../gate-poller.js";

const NOW = "2026-07-09 10:00:10";
const EARLIER = "2026-07-09 10:00:05";

describe("isSupersededShipGate (pure judgement — FLY-1041)", () => {
	const gate = (
		over: Partial<{
			id: string;
			checkpoint: string | null;
			created_at: string;
		}> = {},
	) => ({
		id: "q-old",
		checkpoint: "approve_to_ship" as string | null,
		created_at: EARLIER,
		...over,
	});

	it("true: bound question is STRICTLY newer than this pending gate", () => {
		expect(
			isSupersededShipGate(
				gate(),
				{ review_question_id: "q-new" },
				{ created_at: NOW },
			),
		).toBe(true);
	});

	it("false: same-second creation (SQLite 1s resolution) — NEVER widen to >=", () => {
		expect(
			isSupersededShipGate(
				gate({ created_at: NOW }),
				{ review_question_id: "q-new" },
				{ created_at: NOW },
			),
		).toBe(false);
	});

	it("false: this gate IS the bound question", () => {
		expect(
			isSupersededShipGate(
				gate({ id: "q-new" }),
				{ review_question_id: "q-new" },
				{ created_at: NOW },
			),
		).toBe(false);
	});

	it("false: no binding / unbound sentinel", () => {
		expect(isSupersededShipGate(gate(), {}, { created_at: NOW })).toBe(false);
		expect(
			isSupersededShipGate(
				gate(),
				{ review_question_id: "unbound" },
				{ created_at: NOW },
			),
		).toBe(false);
	});

	it("false: bound question row missing (rebind window — new gate fired, complete not yet arrived)", () => {
		expect(
			isSupersededShipGate(gate(), { review_question_id: "q-new" }, undefined),
		).toBe(false);
	});

	it("false: unparseable created_at on either side", () => {
		expect(
			isSupersededShipGate(
				gate({ created_at: "garbage" }),
				{ review_question_id: "q-new" },
				{ created_at: NOW },
			),
		).toBe(false);
		expect(
			isSupersededShipGate(
				gate(),
				{ review_question_id: "q-new" },
				{ created_at: "garbage" },
			),
		).toBe(false);
	});

	it("false: non-ship checkpoint", () => {
		expect(
			isSupersededShipGate(
				gate({ checkpoint: "brainstorm" }),
				{ review_question_id: "q-new" },
				{ created_at: NOW },
			),
		).toBe(false);
	});
});

describe("GatePoller.maybeSweepSupersededShipGate (integration with real CommDB)", () => {
	let tmp: string;
	let dbPath: string;
	let insertedEvents: Array<Record<string, unknown>>;

	type Priv = {
		maybeSweepSupersededShipGate(
			question: {
				id: string;
				from_agent: string;
				content: string;
				created_at: string;
				checkpoint: string | null;
				content_type: string;
				content_ref: string | null;
			},
			session: Session,
			dbPath: string,
		): boolean;
	};

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fly1041-sweeper-"));
		dbPath = join(tmp, "comm.db");
		insertedEvents = [];
		delete process.env.FLYWHEEL_SHIP_GATE_RETIRE;
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_SHIP_GATE_RETIRE;
		rmSync(tmp, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function makePoller(): Priv {
		const store = {
			insertEvent: vi.fn((e: Record<string, unknown>) => {
				insertedEvents.push(e);
				return true;
			}),
		} as unknown as GatePollerConfig["store"];
		return new GatePoller({
			pollIntervalMs: 3_000,
			projects: [],
			store,
			runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
			chatThreadsEnabled: true,
		}) as unknown as Priv;
	}

	function makeSession(boundQid: string): Session {
		return {
			execution_id: "exec-sw",
			issue_id: "FLY-1041",
			project_name: "flywheel",
			status: "awaiting_review",
			review_question_id: boundQid,
		} as Session;
	}

	function pendingRow(db: CommDB, qid: string) {
		const row = db.getMessageById(qid);
		if (!row) throw new Error(`missing row ${qid}`);
		return {
			id: row.id,
			from_agent: row.from_agent,
			content: row.content,
			created_at: row.created_at,
			checkpoint: row.checkpoint,
			content_type: row.content_type,
			content_ref: row.content_ref,
		};
	}

	it("sweeps a superseded gate: retired from pending + audit event + returns true (skip relay)", async () => {
		const db = new CommDB(dbPath);
		const q1 = db.insertQuestion("exec-sw", "lead", "old gate", {
			checkpoint: "approve_to_ship",
		});
		// SQLite created_at has 1s resolution — the strictly-later judgement
		// needs a real second boundary between the two gates.
		await new Promise((r) => setTimeout(r, 1_100));
		const q2 = db.insertQuestion("exec-sw", "lead", "new gate", {
			checkpoint: "approve_to_ship",
		});

		const poller = makePoller();
		const swept = poller.maybeSweepSupersededShipGate(
			pendingRow(db, q1),
			makeSession(q2),
			dbPath,
		);

		expect(swept).toBe(true);
		expect(db.getPendingQuestions("lead").map((q) => q.id)).toEqual([q2]);
		expect(insertedEvents).toHaveLength(1);
		expect(insertedEvents[0]).toMatchObject({
			event_id: `ship-gate-superseded-${q1}`,
			event_type: "ship_gate_superseded",
			payload: {
				supersededQid: q1,
				newQid: q2,
				by: "gate-poller-sweeper",
			},
		});
		db.close();
	}, 15_000);

	it("same-second pair is NOT swept (conservative tradeoff — accepted noise over false kill)", () => {
		const db = new CommDB(dbPath);
		const q1 = db.insertQuestion("exec-sw", "lead", "old gate", {
			checkpoint: "approve_to_ship",
		});
		const q2 = db.insertQuestion("exec-sw", "lead", "new gate", {
			checkpoint: "approve_to_ship",
		});

		const poller = makePoller();
		const swept = poller.maybeSweepSupersededShipGate(
			pendingRow(db, q1),
			makeSession(q2),
			dbPath,
		);

		expect(swept).toBe(false);
		expect(db.getPendingQuestions("lead").map((q) => q.id)).toContain(q1);
		expect(insertedEvents).toHaveLength(0);
		db.close();
	});

	it("the CURRENT bound gate is never swept", () => {
		const db = new CommDB(dbPath);
		const q1 = db.insertQuestion("exec-sw", "lead", "current gate", {
			checkpoint: "approve_to_ship",
		});
		const poller = makePoller();
		expect(
			poller.maybeSweepSupersededShipGate(
				pendingRow(db, q1),
				makeSession(q1),
				dbPath,
			),
		).toBe(false);
		expect(db.getPendingQuestions("lead").map((q) => q.id)).toContain(q1);
		db.close();
	});

	it("bound question missing from comm.db → not swept (rebind window safety)", () => {
		const db = new CommDB(dbPath);
		const q1 = db.insertQuestion("exec-sw", "lead", "old gate", {
			checkpoint: "approve_to_ship",
		});
		const poller = makePoller();
		expect(
			poller.maybeSweepSupersededShipGate(
				pendingRow(db, q1),
				makeSession("99999999-9999-9999-9999-999999999999"),
				dbPath,
			),
		).toBe(false);
		db.close();
	});

	it("FLYWHEEL_SHIP_GATE_RETIRE=0 disables the sweeper (byte-compat sentinel)", async () => {
		process.env.FLYWHEEL_SHIP_GATE_RETIRE = "0";
		const db = new CommDB(dbPath);
		const q1 = db.insertQuestion("exec-sw", "lead", "old gate", {
			checkpoint: "approve_to_ship",
		});
		await new Promise((r) => setTimeout(r, 1_100));
		const q2 = db.insertQuestion("exec-sw", "lead", "new gate", {
			checkpoint: "approve_to_ship",
		});
		const poller = makePoller();
		expect(
			poller.maybeSweepSupersededShipGate(
				pendingRow(db, q1),
				makeSession(q2),
				dbPath,
			),
		).toBe(false);
		expect(db.getPendingQuestions("lead").map((q) => q.id)).toContain(q1);
		db.close();
	}, 15_000);
});
