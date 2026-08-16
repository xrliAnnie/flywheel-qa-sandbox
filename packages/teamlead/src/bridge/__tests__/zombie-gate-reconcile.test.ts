/**
 * FLY-1099 §5 + §7.2 — zombie gate hygiene (Z1 three-phase guarded retire /
 * Z2 active-but-unreachable) and the founder-reply reconcile (episode-salted
 * eventIds under a PERMANENT claims.db-style dedup, same-episode latching,
 * hang detection while `polling` is stuck).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { FounderReplyUnreachableReconcile } from "../founder-reply-unreachable.js";
import { GatePoller } from "../gate-poller.js";
import { defaultGetCommDbPath } from "../session-capture.js";
import {
	runZombieGateHygiene as runZombieGateHygieneRaw,
	type ZombieCommDb,
	type ZombieGateHygieneDeps,
} from "../zombie-gate-hygiene.js";

afterEach(() => {
	delete process.env.FLYWHEEL_FOUNDER_REPLY_DELIVER;
	vi.restoreAllMocks();
});

const runZombieGateHygiene = (deps: ZombieGateHygieneDeps) =>
	runZombieGateHygieneRaw({ ...deps, resolveDeadGates: true });

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function fakeZombieDb(opts: {
	commSession?: boolean;
	answered?: boolean;
	retireResult?: boolean;
	stillPending?: boolean;
	rowExists?: boolean;
}) {
	const retireShipGate = vi.fn(() => opts.retireResult ?? true);
	const retireQuestionGuarded = vi.fn(() => opts.retireResult ?? true);
	const db = {
		getSession: () => (opts.commSession ? { execution_id: "E-1" } : undefined),
		retireShipGate,
		retireQuestionGuarded,
		getResponse: () => (opts.answered ? { content: "x" } : undefined),
		getMessageById: (id: string) =>
			(opts.rowExists ?? true) ? { id } : undefined,
		isQuestionPending: () => opts.stillPending ?? false,
	} as unknown as ZombieCommDb;
	return { db, retireShipGate, retireQuestionGuarded };
}

function q(
	id: string,
	checkpoint: string | null = "approve_to_ship",
	createdAt: string | null = "2026-07-14 11:59:59",
) {
	return { id, from_agent: "E-1", checkpoint, created_at: createdAt };
}

describe("zombie gate hygiene — Z1/Z2 判定矩阵", () => {
	it("Z1: terminal StateStore session + missing CommDB row → intent + guarded retire + resolved outcome", async () => {
		const store = await freshStore();
		const storeWithSession = Object.assign(store, {
			getSession: () => ({
				status: "completed",
				issue_id: "FLY-1",
				terminal_at: "2026-07-14 12:00:00",
			}),
		});
		const { db, retireShipGate } = fakeZombieDb({ commSession: false });
		const res = await runZombieGateHygiene({
			store: storeWithSession as never,
			projectName: "proj",
			pendingGateQuestions: [q("Q-1")],
			db,
		});
		expect(retireShipGate).toHaveBeenCalledWith("Q-1");
		expect(res.resolved).toEqual(["Q-1"]);
		const events = store.getEventsByExecution("E-1");
		expect(
			events.some((e) => e.event_type === "founder_gate_zombie_resolve_intent"),
		).toBe(true);
		const outcome = events.find(
			(e) => e.event_type === "founder_gate_zombie_resolved",
		);
		expect(outcome?.payload).toMatchObject({ outcome: "resolved" });
	});

	it("Z1: MISSING StateStore session + missing CommDB row → also Z1 (issue 'unknown')", async () => {
		const store = await freshStore();
		const storeNoSession = Object.assign(store, {
			getSession: () => undefined,
		});
		const { db } = fakeZombieDb({ commSession: false });
		const res = await runZombieGateHygiene({
			store: storeNoSession as never,
			projectName: "proj",
			pendingGateQuestions: [q("Q-1")],
			db,
		});
		expect(res.resolved).toEqual(["Q-1"]);
	});

	it("Z1 uses retireQuestionGuarded for NON-ship gates (FLY-161: runner_questions excluded entirely)", async () => {
		const store = await freshStore();
		const s = Object.assign(store, {
			getSession: () => ({
				status: "failed",
				issue_id: "FLY-1",
				terminal_at: "2026-07-14 12:00:00",
			}),
		});
		const { db, retireShipGate, retireQuestionGuarded } = fakeZombieDb({
			commSession: false,
		});
		await runZombieGateHygiene({
			store: s as never,
			projectName: "proj",
			pendingGateQuestions: [q("Q-b", "brainstorm"), q("Q-r", null)],
			db,
		});
		expect(retireQuestionGuarded).toHaveBeenCalledWith("Q-b", {
			expectedFromAgent: "E-1",
			requireUnanswered: true,
		});
		expect(retireShipGate).not.toHaveBeenCalled();
		// runner_question (checkpoint null) never touched
		expect(retireQuestionGuarded).toHaveBeenCalledTimes(1);
	});

	it("Z2 (FLY-1049 shape): awaiting_review session + missing CommDB row → NEVER resolved, reported unreachable", async () => {
		const store = await freshStore();
		const s = Object.assign(store, {
			getSession: () => ({ status: "awaiting_review", issue_id: "FLY-1049" }),
		});
		const { db, retireShipGate } = fakeZombieDb({ commSession: false });
		const note = vi.fn();
		const res = await runZombieGateHygiene({
			store: s as never,
			projectName: "proj",
			pendingGateQuestions: [q("Q-1")],
			db,
			noteUnreachableRunner: note,
		});
		expect(retireShipGate).not.toHaveBeenCalled();
		expect(res.unreachable).toEqual(["Q-1"]);
		expect(note).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "E-1", issueId: "FLY-1049" }),
		);
	});

	it("live CommDB row → neither branch (wake routing intact)", async () => {
		const store = await freshStore();
		const s = Object.assign(store, {
			getSession: () => ({
				status: "completed",
				issue_id: "FLY-1",
				terminal_at: "2026-07-14 12:00:00",
			}),
		});
		const { db, retireShipGate } = fakeZombieDb({ commSession: true });
		const res = await runZombieGateHygiene({
			store: s as never,
			projectName: "proj",
			pendingGateQuestions: [q("Q-1")],
			db,
		});
		expect(retireShipGate).not.toHaveBeenCalled();
		expect(res.resolved).toEqual([]);
		expect(res.unreachable).toEqual([]);
	});

	it("production policy skips Z1 before the intent write", async () => {
		const store = await freshStore();
		const s = Object.assign(store, {
			getSession: () => ({
				status: "completed",
				issue_id: "FLY-1",
				terminal_at: "2026-07-14 12:00:00",
			}),
		});
		const { db, retireShipGate } = fakeZombieDb({ commSession: false });
		await runZombieGateHygieneRaw({
			store: s as never,
			projectName: "proj",
			pendingGateQuestions: [q("Q-1")],
			db,
			resolveDeadGates: false,
		});
		expect(retireShipGate).not.toHaveBeenCalled();
		expect(store.getEventsByExecution("E-1")).toHaveLength(0);
	});
});

describe("zombie gate hygiene — FLY-1257 terminal chronology", () => {
	async function chronologyHarness(args: {
		createdAt: string | null;
		terminalAt: string | null;
		runs?: number;
	}) {
		const store = await freshStore();
		const s = Object.assign(store, {
			getSession: () => ({
				status: "blocked",
				issue_id: "FLY-1244",
				terminal_at: args.terminalAt,
			}),
		});
		const { db, retireQuestionGuarded } = fakeZombieDb({ commSession: false });
		for (let i = 0; i < (args.runs ?? 1); i += 1) {
			await runZombieGateHygiene({
				store: s as never,
				projectName: "proj",
				// A NON-review gate: chronology governs it (review gates are exempt
				// unconditionally — see the defect ④ R5 block below — so testing
				// created_at-vs-terminal_at needs a carrier the exemption ignores).
				pendingGateQuestions: [q("Q-chronology", "brainstorm", args.createdAt)],
				db,
			});
		}
		return { store, retireQuestionGuarded };
	}

	it("gate created after terminal entry is preserved before intent audit", async () => {
		const { store, retireQuestionGuarded } = await chronologyHarness({
			createdAt: "2026-07-14 12:00:01",
			terminalAt: "2026-07-14 12:00:00",
			runs: 2,
		});
		expect(retireQuestionGuarded).not.toHaveBeenCalled();
		expect(store.getEventsByExecution("E-1")).toHaveLength(0);
	});

	it("gate created before terminal entry remains a true Z1 zombie", async () => {
		const { store, retireQuestionGuarded } = await chronologyHarness({
			createdAt: "2026-07-14 11:59:59",
			terminalAt: "2026-07-14 12:00:00",
		});
		expect(retireQuestionGuarded).toHaveBeenCalledWith("Q-chronology", {
			expectedFromAgent: "E-1",
			requireUnanswered: true,
		});
		expect(
			store
				.getEventsByExecution("E-1")
				.some((e) => e.event_type === "founder_gate_zombie_resolve_intent"),
		).toBe(true);
	});

	it.each([
		["missing terminal_at", "2026-07-14 12:00:01", null],
		["missing created_at", null, "2026-07-14 12:00:00"],
		["malformed created_at", "July 14", "2026-07-14 12:00:00"],
		["malformed terminal_at", "2026-07-14 12:00:01", "not-a-time"],
	] as const)(
		"%s fails open without an intent audit",
		async (_name, createdAt, terminalAt) => {
			const { store, retireQuestionGuarded } = await chronologyHarness({
				createdAt,
				terminalAt,
			});
			expect(retireQuestionGuarded).not.toHaveBeenCalled();
			expect(store.getEventsByExecution("E-1")).toHaveLength(0);
		},
	);

	it("same-second tie is permanently preserved across passes", async () => {
		const { store, retireQuestionGuarded } = await chronologyHarness({
			createdAt: "2026-07-14 12:00:00",
			terminalAt: "2026-07-14 12:00:00",
			runs: 2,
		});
		expect(retireQuestionGuarded).not.toHaveBeenCalled();
		expect(store.getEventsByExecution("E-1")).toHaveLength(0);
	});
});

describe("zombie gate hygiene — FLY-1257 defect ④ (R5): review gates never retired by Z1", () => {
	// review_design / review_code are answered by the cross-family REVIEWER after
	// request-review BINDS them — never by the authoring runner. Z1's "gone runner
	// ⇒ dead gate" premise is false for them, so they are exempt UNCONDITIONALLY,
	// ahead of the chronology guard, whether or not a session row survives. Delete
	// the `isReviewGateCheckpoint` short-circuit and every retire/intent assertion
	// below turns red.
	for (const reviewCheckpoint of ["review_code", "review_design"] as const) {
		it(`${reviewCheckpoint}: terminal session + gate created BEFORE terminal (would retire a non-review gate) is exempt`, async () => {
			const store = await freshStore();
			const s = Object.assign(store, {
				getSession: () => ({
					status: "blocked",
					issue_id: "FLY-1257",
					terminal_at: "2026-07-14 12:00:00",
				}),
			});
			const { db, retireQuestionGuarded } = fakeZombieDb({
				commSession: false,
			});
			const res = await runZombieGateHygiene({
				store: s as never,
				projectName: "proj",
				// created BEFORE terminal — a brainstorm gate here WOULD be retired.
				pendingGateQuestions: [
					q("Q-review", reviewCheckpoint, "2026-07-14 11:59:59"),
				],
				db,
			});
			expect(retireQuestionGuarded).not.toHaveBeenCalled();
			expect(res.resolved).toEqual([]);
			// Exempt BEFORE the intent write — zero audit side effects.
			expect(store.getEventsByExecution("E-1")).toHaveLength(0);
		});

		it(`${reviewCheckpoint}: MISSING session (the exact R5 shape after finalize deletes the row) is exempt`, async () => {
			const store = await freshStore();
			const s = Object.assign(store, { getSession: () => undefined });
			const { db, retireQuestionGuarded } = fakeZombieDb({
				commSession: false,
			});
			const res = await runZombieGateHygiene({
				store: s as never,
				projectName: "proj",
				pendingGateQuestions: [
					q("Q-review", reviewCheckpoint, "2026-07-14 11:59:59"),
				],
				db,
			});
			expect(retireQuestionGuarded).not.toHaveBeenCalled();
			expect(res.resolved).toEqual([]);
			expect(store.getEventsByExecution("E-1")).toHaveLength(0);
		});
	}

	it("a live-but-unreachable review gate is STILL surfaced by Z2 (exemption blocks retirement, not alerting)", async () => {
		const store = await freshStore();
		const s = Object.assign(store, {
			getSession: () => ({ status: "awaiting_review", issue_id: "FLY-1257" }),
		});
		const { db, retireQuestionGuarded } = fakeZombieDb({ commSession: false });
		const note = vi.fn();
		const res = await runZombieGateHygiene({
			store: s as never,
			projectName: "proj",
			pendingGateQuestions: [
				q("Q-review", "review_code", "2026-07-14 11:59:59"),
			],
			db,
			noteUnreachableRunner: note,
		});
		// Z2 (alert) runs before the exemption: a genuinely stuck review gate is
		// reported to the reconcile, not silently swallowed.
		expect(res.unreachable).toEqual(["Q-review"]);
		expect(note).toHaveBeenCalled();
		expect(retireQuestionGuarded).not.toHaveBeenCalled();
	});

	// The end-to-end R5 reproduction with the REAL CommDB: finalizeSession spares
	// the review gate but deletes the session row, and the very next zombie sweep
	// must not finish the kill. Ground truth is the real db's own pending state.
	it("finalize→zombie combined regression: a review gate spared by finalizeSession is NOT then retired by the sweep", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "fly1257-r5-"));
		const db = new CommDB(join(tmpDir, "comm.db"));
		try {
			// A blocked codex author opened a review gate the reviewer hasn't answered.
			db.registerSession("E-r5", "win-r5", "proj", "FLY-1257", "lead");
			const review = db.insertQuestion("E-r5", "reviewer", "review please", {
				checkpoint: "review_code",
			});

			// Teardown: review gate spared (HIGH-2), session row deleted — the R5 setup.
			expect(db.finalizeSession("E-r5")).toEqual({
				retiredQuestionCount: 0,
				// FLY-1328: no checkpoint-less asks on this session to cascade.
				retiredAskCount: 0,
				deletedSessionCount: 1,
			});
			expect(db.isQuestionPending(review)).toBe(true);
			expect(db.getSession("E-r5")).toBeUndefined();

			// Next zombie pass: StateStore session missing + CommDB row gone → without
			// the Z1 exemption this drops straight into retireQuestionGuarded.
			const store = await freshStore(); // getSession("E-r5") → undefined
			const res = await runZombieGateHygiene({
				store: store as never,
				projectName: "proj",
				pendingGateQuestions: [
					{
						id: review,
						from_agent: "E-r5",
						checkpoint: "review_code",
						created_at: "2026-07-14 11:59:59",
					},
				],
				db,
			});

			// Real-db ground truth: still pending, still answerable by the reviewer.
			expect(res.resolved).toEqual([]);
			expect(db.isQuestionPending(review)).toBe(true);
			expect(store.getEventsByExecution("E-r5")).toHaveLength(0);
		} finally {
			db.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("zombie gate hygiene — R2 #4 outcome re-read (false ≠ answered)", () => {
	async function outcomeHarness(dbOpts: Parameters<typeof fakeZombieDb>[0]) {
		const store = await freshStore();
		const s = Object.assign(store, {
			getSession: () => ({
				status: "completed",
				issue_id: "FLY-1",
				terminal_at: "2026-07-14 12:00:00",
			}),
		});
		const { db } = fakeZombieDb(dbOpts);
		await runZombieGateHygiene({
			store: s as never,
			projectName: "proj",
			pendingGateQuestions: [q("Q-1")],
			db,
		});
		return store
			.getEventsByExecution("E-1")
			.find((e) => e.event_type === "founder_gate_zombie_resolved");
	}

	it("mutation false + response exists → skipped_answered (history untouchable)", async () => {
		const outcome = await outcomeHarness({
			commSession: false,
			retireResult: false,
			answered: true,
		});
		expect(outcome?.payload).toMatchObject({ outcome: "skipped_answered" });
	});

	it("mutation false + row purged → purged_after_retire (NOT '答掉了')", async () => {
		const outcome = await outcomeHarness({
			commSession: false,
			retireResult: false,
			rowExists: false,
		});
		expect(outcome?.payload).toMatchObject({ outcome: "purged_after_retire" });
	});

	it("mutation false + row exists but no longer pending → already_retired (prior pass won)", async () => {
		const outcome = await outcomeHarness({
			commSession: false,
			retireResult: false,
			stillPending: false,
		});
		expect(outcome?.payload).toMatchObject({ outcome: "already_retired" });
	});

	it("mutation false + STILL pending → transient: intent kept, NO outcome event yet", async () => {
		const outcome = await outcomeHarness({
			commSession: false,
			retireResult: false,
			stillPending: true,
		});
		expect(outcome).toBeUndefined();
	});
});

describe("FounderReplyUnreachableReconcile — unreachable-runner detector", () => {
	function wd(now = 0) {
		// Permanent claims.db-style dedup: the sink remembers every eventId forever.
		const seenEventIds = new Set<string>();
		const posted: string[] = [];
		const alertSink = {
			alert: vi.fn(async (p: { eventId: string }) => {
				if (seenEventIds.has(p.eventId)) return { skipped: "duplicate" };
				seenEventIds.add(p.eventId);
				posted.push(p.eventId);
				return { sent: true };
			}),
		};
		const clock = { now };
		const reconcile = new FounderReplyUnreachableReconcile({
			alertSink: alertSink as never,
			infraRoute: () => ({ leadId: "infra-lead", projectName: "flywheel" }),
			nowMs: () => clock.now,
		});
		return {
			reconcile,
			posted,
			alertSink,
			clock,
		};
	}

	it("unreachable-runner (Z2): one alert per episode; sweep-clear ends the episode; re-detection re-alerts with a NEW salt", async () => {
		const { reconcile, posted, clock } = wd();
		const detect = () => {
			reconcile.beginUnreachableSweep();
			reconcile.noteUnreachableRunner({
				executionId: "E-9",
				issueId: "FLY-1049",
				projectName: "proj",
				questionId: "Q-9",
			});
			reconcile.endUnreachableSweep();
		};
		clock.now = 0;
		detect();
		await reconcile.tick();
		detect(); // still unreachable — same episode, already alerted
		await reconcile.tick();
		expect(
			posted.filter((e) => e.startsWith("founder-reply-unreachable-E-9")),
		).toHaveLength(1);
		// condition clears → episode ends → later re-detection = NEW episode salt
		reconcile.beginUnreachableSweep();
		reconcile.endUnreachableSweep();
		clock.now = 5000;
		detect();
		await reconcile.tick();
		expect(
			posted.filter((e) => e.startsWith("founder-reply-unreachable-E-9")),
		).toHaveLength(2);
	});
});

describe("Codex code R1 MED-1: dangling-intent reconcile", () => {
	it("intent-without-outcome (crash between mutation and audit) → outcome reconciled by re-read next pass", async () => {
		const store = await freshStore();
		const s = Object.assign(store, {
			getSession: () => ({
				status: "completed",
				issue_id: "FLY-1",
				terminal_at: "2026-07-14 12:00:00",
			}),
		});
		// Simulate the crash shape: intent exists, question already retired
		// (no longer pending), NO outcome event, and the question is no longer
		// in the pending candidate set.
		store.insertEvent({
			event_id: "founder-gate-zombie-resolve-intent-Q-crash",
			execution_id: "E-1",
			issue_id: "FLY-1",
			project_name: "proj",
			event_type: "founder_gate_zombie_resolve_intent",
			source: "test",
			payload: { questionId: "Q-crash" },
		});
		const { db } = fakeZombieDb({
			commSession: false,
			stillPending: false, // retired by the pre-crash mutation
		});
		await runZombieGateHygiene({
			store: s as never,
			projectName: "proj",
			pendingGateQuestions: [], // NOT a candidate anymore — reconcile must catch it
			db,
		});
		const outcome = store
			.getEventsByExecution("E-1")
			.find((e) => e.event_type === "founder_gate_zombie_resolved");
		expect(outcome?.payload).toMatchObject({
			questionId: "Q-crash",
			outcome: "already_retired",
			reconciled: true,
		});
	});
});

describe("Codex code R8 MED-1: GatePoller wrapper — empty filtered candidate set still reconciles dangling intents", () => {
	it("formal retirement leaves dangling legacy intent untouched and never touches the tracked gate", async () => {
		const originalHome = process.env.HOME;
		const tmpHome = join(
			tmpdir(),
			`zombie-r8-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tmpHome, { recursive: true });
		process.env.HOME = tmpHome;
		try {
			const projectName = "zombie-r8-proj";
			const dbPath = defaultGetCommDbPath(projectName);
			const db = new CommDB(dbPath);
			// The ONLY pending gate is eviction-tracked → the filter removes every
			// candidate. Before the R8 fix, the `pending.length === 0` early-continue
			// then skipped runZombieGateHygiene entirely — and with it the
			// dangling-intent reconcile, stranding Q-crash's intent forever.
			const trackedId = db.insertQuestion("E-1", "product-lead", "ship?", {
				checkpoint: "approve_to_ship",
			});
			db.close();

			const store = await StateStore.create(":memory:");
			const getSessionSpy = vi.spyOn(store, "getSession");
			store.insertEvent({
				event_id: "founder-gate-zombie-resolve-intent-Q-crash",
				execution_id: "E-1",
				issue_id: "FLY-1",
				project_name: projectName,
				event_type: "founder_gate_zombie_resolve_intent",
				source: "test",
				payload: { questionId: "Q-crash" }, // no CommDB row → purged_after_retire
			});

			const poller = new GatePoller({
				pollIntervalMs: 60_000,
				projects: [
					{
						projectName,
						projectRoot: "/tmp/zombie-r8-root",
						leads: [
							{
								agentId: "product-lead",
								chatChannel: "chat-product",
								match: { labels: ["product"] },
							},
						],
					},
				] as never,
				store,
				runtimeRegistry: { getForLead: () => undefined } as never,
			});
			(
				poller as unknown as { evictionRetryAt: Map<string, number> }
			).evictionRetryAt.set(trackedId, 999);

			await (
				poller as unknown as { zombieGateHygienePass: () => Promise<void> }
			).zombieGateHygienePass();

			// FLY-1393: the production wrapper no longer runs Z1 reconciliation.
			const outcome = store
				.getEventsByExecution("E-1")
				.find((e) => e.event_type === "founder_gate_zombie_resolved");
			expect(outcome).toBeUndefined();
			// The eviction-tracked gate was NOT zombie-handled: still pending, no
			// intent written for it, and — the Case 8c contract — zero getSession.
			const verify = new CommDB(dbPath, false);
			expect(verify.isQuestionPending(trackedId)).toBe(true);
			verify.close();
			expect(
				store
					.getEventsByExecution("E-1")
					.filter(
						(e) =>
							e.event_type === "founder_gate_zombie_resolve_intent" &&
							(e.payload as { questionId?: string }).questionId === trackedId,
					),
			).toHaveLength(0);
			expect(getSessionSpy).not.toHaveBeenCalled();
			store.close();
		} finally {
			if (originalHome !== undefined) process.env.HOME = originalHome;
			else delete process.env.HOME;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});
