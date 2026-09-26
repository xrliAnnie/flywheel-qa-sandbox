/**
 * FLY-1099 (Codex code R4 HIGH) — the pending-dead-letter latch: when the
 * dead-letter WRITE itself fails (fully broken StateStore), the entry is
 * latched in memory, the pass stays UNHEALTHY (pass-dead watchdog escalates
 * instead of notePassSuccess silencing the episode), and the latch re-drives
 * on the next pass once the store self-heals — the Codex-named two-round
 * scenario (round 1: all writes throw; round 2: store healed, gate already
 * answered/not pending → the dead-letter still lands).
 */

import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { FounderReplyThreadCtx } from "../founder-reply-deliverer.js";
import { computeFounderPassHealthy, GatePoller } from "../gate-poller.js";

const ctx: FounderReplyThreadCtx = {
	issueId: "FLY-1",
	projectName: "proj",
	threadId: "T-1",
	botToken: "bot",
	ownerUserId: "123456789012345678",
	graceMs: 0,
	commDbPath: "/tmp/x",
	leadId: "lead",
};

/**
 * Codex R5: a REAL StateStore whose two DL-path writers throw while
 * `state.broken` — round 2 heals by restoring the real methods, so the
 * re-drive exercises the PRODUCTION markFounderReplyDeadLettered semantics
 * (incl. the missing-row create-then-mark transaction).
 */
async function brokenThenHealedRealStore() {
	const store = await StateStore.create(":memory:");
	const state = { broken: true };
	const realRecord = store.recordFounderReplyFailure.bind(store);
	const realMark = store.markFounderReplyDeadLettered.bind(store);
	store.recordFounderReplyFailure = ((args: never) => {
		if (state.broken) throw new Error("database disk image is malformed");
		return realRecord(args);
	}) as typeof store.recordFounderReplyFailure;
	store.markFounderReplyDeadLettered = ((args: never) => {
		if (state.broken) throw new Error("database disk image is malformed");
		return realMark(args);
	}) as typeof store.markFounderReplyDeadLettered;
	return { store, state };
}

function makePoller(store: unknown): GatePoller {
	return new GatePoller({
		pollIntervalMs: 3000,
		projects: [],
		store: store as never,
		runtimeRegistry: { getForLead: () => undefined } as never,
	});
}

describe("computeFounderPassHealthy (pure)", () => {
	it("all scans failed (broken-store shape: process_failed, not read_failed) → UNHEALTHY", () => {
		expect(computeFounderPassHealthy(3, 3, 0)).toBe(false);
	});
	it("one bad thread among many → still healthy (transients are normal)", () => {
		expect(computeFounderPassHealthy(3, 1, 0)).toBe(true);
	});
	it("ANY latched dead-letter → UNHEALTHY regardless of scan results (episode stays alive)", () => {
		expect(computeFounderPassHealthy(0, 0, 1)).toBe(false);
		expect(computeFounderPassHealthy(5, 0, 1)).toBe(false);
	});
	it("no scans, no latch → healthy (idle pass)", () => {
		expect(computeFounderPassHealthy(0, 0, 0)).toBe(true);
	});
});

describe("pending-dead-letter latch — two-round recovery (Codex R4)", () => {
	it("round 1: ALL DL/retry writes throw → latched (pass unhealthy); round 2: store healed, gate already answered → re-drive lands retry row + audit + emit_alert (REAL StateStore)", async () => {
		const { store, state } = await brokenThenHealedRealStore();
		const poller = makePoller(store);
		const ledger = (poller as any).founderReplyRetryLedger();

		// ── round 1: everything throws (fully broken StateStore) ──
		const r1 = ledger.deadLetterNow({
			ctx,
			msgId: "100",
			executionId: "E-1",
			stage: "convergence_park_failed",
			reason: "store down",
			contentExcerpt: "改一下",
		});
		expect(r1.deadLettered).toBe(false);
		expect((poller as any).pendingDeadLetters.size).toBe(1);
		// the latch keeps the pass unhealthy → notePassSuccess can never fire
		expect(
			computeFounderPassHealthy(1, 1, (poller as any).pendingDeadLetters.size),
		).toBe(false);
		// nothing durable landed in round 1 (Codex R5 precondition)
		expect(store.getFounderReplyRetry("T-1", "100")).toBeUndefined();

		// ── round 2: the FLY-639 self-heal repaired the store; the gate is
		// already answered (never re-enters getPendingQuestions) — the ONLY
		// recovery surface is this latch re-drive. The retry row does NOT exist
		// (round 1's bookkeeping upsert also threw): the production DL
		// transaction must CREATE it, mark it, and land audit + alert intent.
		state.broken = false;
		(poller as any).retryPendingDeadLetters();
		expect((poller as any).pendingDeadLetters.size).toBe(0);
		const row = store.getFounderReplyRetry("T-1", "100");
		expect(row?.dead_lettered_ms).toBeTruthy();
		const audit = store
			.getEventsByExecution("E-1")
			.find((e) => e.event_type === "founder_reply_dead_letter");
		expect(audit).toBeDefined();
		const alertIntent = store.getFounderAction(
			"emit-alert-founder-reply-dl-T-1-100",
		);
		expect(alertIntent?.status).toBe("pending");
		expect(alertIntent?.kind).toBe("emit_alert");
	});

	it("re-drive treats 'already dead-lettered by another path' as done → latch cleared, no duplicate audit/alert", async () => {
		const { store, state } = await brokenThenHealedRealStore();
		const poller = makePoller(store);
		const ledger = (poller as any).founderReplyRetryLedger();
		ledger.deadLetterNow({
			ctx,
			msgId: "100",
			executionId: "E-1",
			stage: "s",
			reason: "r",
			contentExcerpt: "",
		});
		expect((poller as any).pendingDeadLetters.size).toBe(1);
		state.broken = false;
		// another path (bounded lap) dead-letters it first
		store.markFounderReplyDeadLettered({
			threadId: "T-1",
			msgId: "100",
			nowMs: 111,
			audit: {
				event_id: "other-path-dl",
				execution_id: "E-1",
				issue_id: "FLY-1",
				project_name: "proj",
				event_type: "founder_reply_dead_letter",
				source: "test",
			},
			alertIntent: {
				actionKey: "other-path-alert",
				kind: "emit_alert",
				executionId: "E-1",
				issueId: "FLY-1",
				projectName: "proj",
				payload: {},
			},
		});
		(poller as any).retryPendingDeadLetters();
		expect((poller as any).pendingDeadLetters.size).toBe(0);
		// no duplicate alert intent from the re-drive
		expect(
			store.getFounderAction("emit-alert-founder-reply-dl-T-1-100"),
		).toBeUndefined();
	});

	it("already dead-lettered row (mark returns false but row shows DL) → disposed, NOT latched", () => {
		const store = {
			recordFounderReplyFailure: vi.fn(() => ({
				attempts: 2,
				first_seen_ms: 0,
			})),
			markFounderReplyDeadLettered: vi.fn(() => false),
			getFounderReplyRetry: vi.fn(() => ({
				dead_lettered_at: "2026-07-10 00:00:00",
			})),
			getSession: vi.fn(() => undefined),
		};
		const poller = makePoller(store);
		const ledger = (poller as any).founderReplyRetryLedger();
		const r = ledger.deadLetterNow({
			ctx,
			msgId: "100",
			executionId: "E-1",
			stage: "s",
			reason: "r",
			contentExcerpt: "",
		});
		expect(r.deadLettered).toBe(true);
		expect((poller as any).pendingDeadLetters.size).toBe(0);
	});
});
