import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { LegacyLeadEventReconciler } from "../legacy-lead-event-reconciler.js";
import { LegacyRowPoisonError } from "../legacy-row-errors.js";
import { RuntimeRegistry } from "../runtime-registry.js";

/**
 * FLY-1586 — acceptance #2, the positive control.
 *
 * "毒行仍在的前提下通过" — deleting the bad row and restarting would hide the
 * defect, not fix it. These tests keep a poison fixture in the journal and prove
 * the reconciler carries on regardless: the loop completes, LATER rows are still
 * processed, and `admit()` (which runs the reconciler) no longer aborts.
 *
 * Two poison shapes, and they are deliberately handled DIFFERENTLY:
 *
 *  1. Lone surrogate in renderable content — the real seq 56649 shape. A repairs
 *     it, the row enqueues normally, NO quarantine. Discarding it would lose a
 *     genuine notification.
 *  2. Unparseable payload — B quarantines it. There is nothing to deliver.
 */

const now = "2026-07-19T20:00:00.000Z";

describe("FLY-1586 — poison row isolation keeps the cutover moving", () => {
	let dir: string;
	let store: StateStore;
	let queue: LeadInboxQueue;
	let registry: RuntimeRegistry;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1586-isolation-"));
		store = await StateStore.create(":memory:");
		queue = new LeadInboxQueue(join(dir, "comm.db"));
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-1",
			now,
			leaseTtlMs: 60_000,
		});
		registry = new RuntimeRegistry();
		registry.register(
			{ agentId: "lead-1", chatChannel: "chat", match: {} },
			{
				type: "test",
				deliver: vi.fn(),
				// Mirrors production: the renderer interpolates event fields into the
				// text that becomes lead_inbox.content.
				renderEnvelope: (env) =>
					`Summary: ${(env.event as { summary?: string }).summary ?? env.event.event_type}`,
				sendBootstrap: vi.fn(),
				health: vi.fn(),
				shutdown: vi.fn(),
			},
		);
	});

	afterEach(() => {
		queue.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * ⚠️ The escape stays ESCAPED in the stored JSON text. `JSON.parse` is what
	 * turns `\ud83c` into a real lone high surrogate — exactly how production
	 * minted seq 56649. A fixture holding a literal surrogate would test a
	 * different (easier) thing.
	 */
	const POISON_PAYLOAD = `{"event_type":"session_completed","execution_id":"exec-1","issue_id":"issue-1","project_name":"flywheel","summary":"won \\ud83c"}`;

	const CLEAN_PAYLOAD = JSON.stringify({
		event_type: "session_completed",
		execution_id: "exec-2",
		issue_id: "issue-2",
		project_name: "flywheel",
		summary: "all good",
	});

	function append(
		eventId: string,
		payload: string,
		eventType = "session_completed",
	): number {
		return store.appendLeadEvent(
			"lead-1",
			eventId,
			eventType,
			payload,
			"exec-1",
		);
	}

	function reconciler(
		onRowQuarantine?: (row: { seq: number }, err: Error) => void,
	) {
		return new LegacyLeadEventReconciler({
			store,
			registry,
			ownerEpoch: "epoch-1",
			queueForLead: () => queue,
			probeLegacyDelivery: async () => ({ status: "none" as const }),
			now: () => new Date(now),
			...(onRowQuarantine ? { onRowQuarantine } : {}),
		});
	}

	it("the real seq 56649 shape is REPAIRED and delivered, not discarded", async () => {
		append("event-poison", POISON_PAYLOAD);
		append("event-after", CLEAN_PAYLOAD);

		const quarantined: number[] = [];
		await reconciler((row) => quarantined.push(row.seq)).run();

		// Repaired, not quarantined — it is a real notification.
		expect(quarantined).toEqual([]);

		const poisonRow = queue.getById("lead_event:lead-1:event-poison");
		expect(poisonRow).toBeDefined();
		expect(poisonRow?.content).toBe("Summary: won �");
		// The stored value is well-formed: this is what makes the read-back
		// comparator agree, which is what stopped the rollback.
		expect(poisonRow?.content).not.toContain("\uD83C");

		// ⭐ The positive control: the row AFTER the poison one still landed.
		// Before the fix, the throw aborted the whole cutover here.
		expect(queue.getById("lead_event:lead-1:event-after")?.content).toBe(
			"Summary: all good",
		);
	});

	it("an unparseable payload is quarantined and the loop carries on", async () => {
		append("event-bad-json", "this is not json");
		append("event-after", CLEAN_PAYLOAD);

		const quarantined: Array<{ seq: number; err: Error }> = [];
		await reconciler((row, err) =>
			quarantined.push({ seq: row.seq, err }),
		).run();

		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]?.err).toBeInstanceOf(LegacyRowPoisonError);
		expect((quarantined[0]?.err as LegacyRowPoisonError).reason).toBe(
			"invalid_payload_json",
		);

		// Nothing was enqueued for the bad row — there is nothing deliverable in it.
		expect(queue.getById("lead_event:lead-1:event-bad-json")).toBeUndefined();

		// ⭐ Positive control again.
		expect(queue.getById("lead_event:lead-1:event-after")).toBeDefined();
	});

	it("without a durable quarantine sink it RETHROWS instead of silently skipping", async () => {
		append("event-bad-json", "this is not json");

		// Fail-closed on purpose: with no sink we cannot prove the row was
		// recorded, and skipping it would lose a notification with no trace.
		// A wedge is loud and recoverable; silent loss is neither.
		await expect(reconciler().run()).rejects.toBeInstanceOf(
			LegacyRowPoisonError,
		);
	});

	it("⭐ a valid-JSON / wrong-SHAPE row falls back instead of wedging the cutover", async () => {
		// Code review R1 HIGH-5. The renderer dereferences typed fields, so a
		// payload that parses but has the wrong shape throws an untyped TypeError.
		// The classifier rightly refuses to quarantine untyped errors — it cannot
		// tell them from a transient fault — so before this the row re-threw on
		// EVERY boot and wedged the whole cutover. The original 61-hour failure,
		// reached through a different door.
		const badShape = append(
			"event-bad-shape",
			JSON.stringify({
				event_type: "session_completed",
				execution_id: "exec-1",
				// summary is an object where the renderer expects a string
				summary: { not: "a string" },
			}),
		);
		append("event-after", CLEAN_PAYLOAD);

		const shapeSensitive = new RuntimeRegistry();
		shapeSensitive.register(
			{ agentId: "lead-1", chatChannel: "chat", match: {} },
			{
				type: "test",
				deliver: vi.fn(),
				renderEnvelope: (env) =>
					// Mirrors production: mailbox-lead-runtime calls .slice()/.toUpperCase()
					// on fields it assumes are strings.
					`Summary: ${(env.event as { summary: string }).summary.slice(0, 10)}`,
				sendBootstrap: vi.fn(),
				health: vi.fn(),
				shutdown: vi.fn(),
			},
		);

		await new LegacyLeadEventReconciler({
			store,
			registry: shapeSensitive,
			ownerEpoch: "epoch-1",
			queueForLead: () => queue,
			probeLegacyDelivery: async () => ({ status: "none" as const }),
			now: () => new Date(now),
			onRowQuarantine: () => {
				throw new Error("must not quarantine a presentation-shape problem");
			},
		}).run();

		// Delivered as raw JSON — a REAL notification must not vanish because its
		// renderer could not format it.
		const row = queue.getById("lead_event:lead-1:event-bad-shape");
		expect(row).toBeDefined();
		expect(row?.content).toContain("session_completed");

		// The downgrade is a durable, queryable fact.
		const fallbacks = store.listLegacyRenderFallbacks();
		expect(fallbacks).toHaveLength(1);
		expect(fallbacks[0]?.seq).toBe(badShape);
		expect(fallbacks[0]?.error_name).toBe("TypeError");

		// ⭐ The judgment that matters: the row AFTER it still landed. That is the
		// difference between "handled" and "wedged".
		expect(queue.getById("lead_event:lead-1:event-after")).toBeDefined();
	});

	it("a transient failure is NEVER quarantined — it must retry", async () => {
		append("event-1", CLEAN_PAYLOAD);

		const quarantined: number[] = [];
		const boom = Object.assign(new Error("database is locked"), {
			code: "SQLITE_BUSY",
		});
		const flaky = new LegacyLeadEventReconciler({
			store,
			registry,
			ownerEpoch: "epoch-1",
			queueForLead: () => {
				throw boom;
			},
			probeLegacyDelivery: async () => ({ status: "none" as const }),
			now: () => new Date(now),
			onRowQuarantine: (row) => quarantined.push(row.seq),
		});

		await expect(flaky.run()).rejects.toBe(boom);
		// This is the assertion that matters: a bare try/catch would have
		// swallowed SQLITE_BUSY and thrown the notification away forever.
		expect(quarantined).toEqual([]);
	});

	it("⭐ a renderer that hits SQLITE_BUSY RETRIES — it is not 'handled' as a fallback", async () => {
		// Code review R2 HIGH-2. My first fix caught everything the renderer threw,
		// so a transient SQLITE_BUSY would have been "handled" by delivering raw
		// JSON — permanently downgrading a message that merely needed a retry.
		// That is the exact failure mode this whole change exists to prevent, and
		// I reintroduced it while fixing something else.
		append("event-1", CLEAN_PAYLOAD);

		const busy = Object.assign(new Error("database is locked"), {
			code: "SQLITE_BUSY",
		});
		const flakyRenderer = new RuntimeRegistry();
		flakyRenderer.register(
			{ agentId: "lead-1", chatChannel: "chat", match: {} },
			{
				type: "test",
				deliver: vi.fn(),
				renderEnvelope: () => {
					throw busy;
				},
				sendBootstrap: vi.fn(),
				health: vi.fn(),
				shutdown: vi.fn(),
			},
		);

		await expect(
			new LegacyLeadEventReconciler({
				store,
				registry: flakyRenderer,
				ownerEpoch: "epoch-1",
				queueForLead: () => queue,
				probeLegacyDelivery: async () => ({ status: "none" as const }),
				now: () => new Date(now),
				onRowQuarantine: () => {
					throw new Error("must not quarantine a transient failure");
				},
			}).run(),
		).rejects.toBe(busy);

		// No downgrade recorded, no row enqueued — the next tick retries.
		expect(store.listLegacyRenderFallbacks()).toEqual([]);
		expect(queue.getById("lead_event:lead-1:event-1")).toBeUndefined();
	});

	it("⭐ a deterministic terminal CONFLICT is quarantined, not retried forever", async () => {
		// Code review R2 HIGH-3. `reconcileEnqueueConsumed` answered `false` both
		// for a lost owner lease and for a genuinely different existing row, and
		// the reconciler turned either into "owner fence lost". The classifier
		// rightly rethrows that — so a DETERMINISTIC conflict aborted admission on
		// every retry, forever.
		//
		// ⚠️ Reaching this path requires a RACE, and saying so matters: the
		// reconciler checks `getById` first and skips any row that already exists,
		// so a conflict only arises when the row appears between that check and the
		// INSERT. In production that is two processes; here it is constructed
		// deterministically by making `getById` report "absent" for one id while
		// the row really is present.
		const conflicted = append("event-conflict", CLEAN_PAYLOAD);
		append("event-after", CLEAN_PAYLOAD);

		queue.reconcileEnqueueConsumed(
			{
				id: "lead_event:lead-1:event-conflict",
				toLead: "lead-1",
				source: `lead_event:${conflicted}`,
				type: "session_completed",
				msgClass: "model",
				priority: 2,
				content: "a DIFFERENT message under the same id",
			},
			{ ownerEpoch: "epoch-1", disposition: "migrated", delivered: true, now },
		);

		// The race: the pre-check sees nothing, the INSERT finds the row.
		const racing = new Proxy(queue, {
			get(target, prop, receiver) {
				if (prop === "getById") {
					return (id: string) =>
						id === "lead_event:lead-1:event-conflict"
							? undefined
							: target.getById(id);
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		const quarantined: Array<{ seq: number; err: Error }> = [];
		await new LegacyLeadEventReconciler({
			store,
			registry,
			ownerEpoch: "epoch-1",
			queueForLead: () => racing,
			probeLegacyDelivery: async () => ({
				status: "delivered" as const,
				alias: "legacy-alias",
			}),
			now: () => new Date(now),
			onRowQuarantine: (row, err) => quarantined.push({ seq: row.seq, err }),
		}).run();

		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]?.seq).toBe(conflicted);
		expect((quarantined[0]?.err as LegacyRowPoisonError).reason).toBe(
			"terminal_conflict",
		);

		// ⭐ The judgment: the row AFTER the conflict still landed. That is the
		// difference between "classified" and "wedged".
		expect(queue.getById("lead_event:lead-1:event-after")).toBeDefined();
	});

	it("⭐ a stock-derived receipt escalation carrying the old ship answer is suppressed", async () => {
		// Code review R3 BLOCKER — the fifth founder-replay path, and the one with
		// the sting: the retired detector appended this escalation before its
		// best-effort dispatch, and contentSummary truncation on this very path
		// is what minted seq 56649. Same pipe, not adjacent telemetry.
		const rootId = "founder_msg:lead-1:ship-msg";
		queue.enqueue({
			id: rootId,
			toLead: "lead-1",
			source: "founder_reply",
			type: "founder_reply",
			msgClass: "model",
			priority: 0,
			content: 'answer="ship" issue=FLY-1569',
		});
		// Delivered but unprocessed — exactly what the freeze fences. Claim first:
		// `markConsumed` is a no-op on an unclaimed row (verified by inspecting the
		// row, not assumed), so skipping the claim would silently build the WRONG
		// fixture and the test would pass for the wrong reason.
		queue.claimModelBatch({
			toLead: "lead-1",
			ownerEpoch: "epoch-1",
			batchId: "batch-ship",
			now,
			claimTtlMs: 60_000,
			limit: 10,
			respectRetryAt: true,
		});
		queue.markConsumed([rootId], {
			ownerEpoch: "epoch-1",
			disposition: "delivered",
			now,
		});
		queue.freezeStockBelowWatermark({ now });
		expect(queue.isFencedRoot(rootId)).toBe(true);

		// The journal mirror that was never delivered, carrying the old answer.
		const escalationSeq = append(
			"event-receipt-escalation",
			JSON.stringify({
				event_type: "detection_escalation",
				execution_id: "exec-1",
				escalation_kind: "receipt_unprocessed",
				episode_fingerprint: rootId,
				escalation_reason: 'unprocessed receipt: answer="ship" issue=FLY-1569',
				escalation_next_step: "complete the routing side effect",
			}),
			"detection_escalation",
		);
		append("event-after", CLEAN_PAYLOAD);

		await reconciler(() => {}).run();

		// ⭐ No post-watermark row, so nothing to claim: the founder's already
		// executed ship cannot reach the Lead a second time through this mirror.
		expect(
			queue.getById("lead_event:lead-1:event-receipt-escalation"),
		).toBeUndefined();
		// The decision is auditable, not invisible — and `delivered_at` stays NULL
		// because the row was NOT delivered.
		const suppressed = store.listLegacyStockSuppressed();
		expect(suppressed).toHaveLength(1);
		expect(suppressed[0]?.seq).toBe(escalationSeq);
		expect(suppressed[0]?.fenced_root).toBe(rootId);
		expect(
			store.getLeadEventBySeq(escalationSeq)?.delivered_at ?? null,
		).toBeNull();

		// ⭐ Control: an unrelated row after it still lands — this is narrow
		// suppression, not a blanket audit-only that would create fresh silence.
		expect(queue.getById("lead_event:lead-1:event-after")).toBeDefined();
	});

	it("stays stable across a second run with the poison row still present", async () => {
		// Every Bridge restart replays this. The poison row is NOT deleted, so the
		// second pass must agree with what the first one stored rather than
		// re-throwing — otherwise the fleet re-wedges on every boot, which is
		// precisely why "just restart it" never worked.
		append("event-poison", POISON_PAYLOAD);
		append("event-after", CLEAN_PAYLOAD);

		await reconciler(() => {}).run();
		await expect(reconciler(() => {}).run()).resolves.toBeUndefined();

		expect(queue.getById("lead_event:lead-1:event-poison")?.content).toBe(
			"Summary: won �",
		);
		expect(queue.getById("lead_event:lead-1:event-after")).toBeDefined();
	});
});
