import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type {
	DurableAcceptReceipt,
	LeadDeliveryBatch,
} from "../lead-delivery-adapter.js";
import { LeadInboxLoop } from "../lead-inbox-loop.js";
import { LegacyLeadEventReconciler } from "../legacy-lead-event-reconciler.js";
import { RuntimeRegistry } from "../runtime-registry.js";

/**
 * FLY-1586 — the whole change, exercised through ONE real `tick()`.
 *
 * ## What this covers, and what it does NOT
 *
 * Covers: the real `LeadInboxLoop.tick()` running the real `admit()` work
 * (freeze → legacy reconciler, in production order), against a real CommDB and a
 * real StateStore, with a real poison row present, and the real claim/deliver
 * path returning a durable adapter receipt.
 *
 * Does NOT cover: Discord, tmux, or a real Lead process. So this is **not** a
 * real-machine E2E and is deliberately not named one — issue acceptance #1/#3/#6
 * still need a real machine. Calling this "E2E passed" would be exactly the
 * false-label failure this whole issue is about.
 *
 * ## Why one test needs all three actors
 *
 * "Nothing was delivered" is ALSO true when the loop is still wedged — that is
 * the pre-fix state. So a single assertion proves nothing. The fixture holds
 * poison + stock + a new message simultaneously, and the claim result must
 * separate them: stock withheld, new message delivered, and the poison neither
 * wedging the cutover nor vanishing.
 */

const NOW = "2026-08-01T12:00:00.000Z";

describe("FLY-1586 — full tick with freeze + poison + new traffic", () => {
	let dir: string;
	let dbPath: string;
	let store: StateStore;
	let queue: LeadInboxQueue;
	let registry: RuntimeRegistry;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1586-fulltick-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		store = await StateStore.create(":memory:");
		queue = new LeadInboxQueue(dbPath);
		queue.acquireOrRenewOwner({
			ownerEpoch: "epoch-a",
			now: NOW,
			leaseTtlMs: 60_000,
		});
		registry = new RuntimeRegistry();
		registry.register(
			{ agentId: "lead-a", chatChannel: "chat", match: {} },
			{
				type: "test",
				deliver: vi.fn(),
				renderEnvelope: (env) =>
					`Summary: ${(env.event as { summary?: string }).summary ?? "-"}`,
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
	 * ⚠️ The escape stays ESCAPED — `JSON.parse` is what mints the real lone
	 * surrogate, exactly as production did for seq 56649.
	 */
	const POISON_PAYLOAD = `{"event_type":"session_completed","execution_id":"exec-1","summary":"won \\ud83c"}`;

	it("⭐ stock is withheld, new traffic is delivered, and the poison row does not wedge", async () => {
		// --- stock: a founder instruction that was already acted on -------------
		queue.enqueue({
			id: "founder_msg:lead-a:ship",
			toLead: "lead-a",
			source: "founder_reply",
			type: "founder_reply",
			msgClass: "model",
			priority: 0,
			content: 'answer="ship" issue=FLY-1569',
		});
		// Verify the fixture is what I think it is BEFORE relying on it — every
		// fixture mistake in this issue came from skipping exactly this step.
		expect(
			queue.getById("founder_msg:lead-a:ship")?.consumed_at ?? null,
		).toBeNull();

		// --- poison: the seq 56649 shape, still in the journal -------------------
		const poisonSeq = store.appendLeadEvent(
			"lead-a",
			"evt-poison",
			"session_completed",
			POISON_PAYLOAD,
			"exec-1",
		);
		expect(store.getLeadEventBySeq(poisonSeq)?.delivered_at ?? null).toBeNull();

		let admitted = false;
		const consumer = new LeadInboxLoop({
			queue,
			leadId: "lead-a",
			ownerEpoch: "epoch-a",
			adapter: {
				deliverBatch: async (batch: LeadDeliveryBatch) =>
					({
						batchId: batch.batchId,
						memberIds: batch.members.map(({ deliveryId }) => deliveryId),
						status: "accepted_new",
					}) as DurableAcceptReceipt,
			},
			hasLiveSession: () => false,
			handleProtocol: async () => ({ disposition: "protocol_applied" }),
			now: () => new Date(NOW),
			batchIdFactory: () => "batch-1",
			// The real admit work, in production order: freeze BEFORE the reconciler
			// so the stock is parked before anything can flush it.
			admit: async () => {
				if (admitted) return;
				admitted = true;
				queue.freezeStockBelowWatermark({ now: NOW });
				await new LegacyLeadEventReconciler({
					store,
					registry,
					ownerEpoch: "epoch-a",
					queueForLead: () => queue,
					probeLegacyDelivery: async () => ({ status: "none" as const }),
					now: () => new Date(NOW),
					onRowQuarantine: () => {
						throw new Error("repairable content must not be quarantined");
					},
				}).run();
			},
		});

		const result = await consumer.tick();

		// The tick completed — before this change the poison row aborted admit(),
		// and neither claim path ever ran.
		expect(result.ok).toBe(true);

		// ⭐ Stock withheld: the founder's already-executed ship is not replayed.
		const shipRow = queue.getById("founder_msg:lead-a:ship");
		expect(shipRow?.disposition).toBe("frozen_fly1586");
		// ...and the record stays truthful: it was NOT delivered.
		expect(shipRow?.delivered_at ?? null).toBeNull();

		// ⭐ New traffic delivered: the poison row was repaired and materialized by
		// the reconciler AFTER the watermark, so it is genuinely new and flows.
		// This is the control group — "nothing delivered" is also true of a wedged
		// loop, so withholding alone proves nothing.
		const repaired = queue.getById("lead_event:lead-a:evt-poison");
		expect(repaired).toBeDefined();
		expect(repaired?.content).toBe("Summary: won �");
		expect(repaired?.consumed_at).toBeTruthy();
		expect(repaired?.disposition).toBe("delivered");
		expect(result.modelConsumed).toBe(1);

		// The repair is auditable rather than silent.
		expect(queue.listSanitationAudit()).toHaveLength(1);
	});

	/**
	 * plan §1b.9 — F must not blind the watchdog that detected this incident.
	 *
	 * Frozen rows keep `consumed_at IS NULL`… except they must not, and that is
	 * the whole point. Three predicates read "unconsumed" as "still owed":
	 * `countPending()`, `recordTickSuccess()`'s overdue EXISTS, and
	 * `claimHealthEpisode()`'s counts. A frozen row carrying a past `deadline_at`
	 * would hold `stall_episode_at` latched FOREVER — the stall detector would go
	 * permanently silent, which is precisely the failure this issue exists to fix.
	 *
	 * The guarantee currently rests on freeze setting `consumed_at`. Nothing tested
	 * it. That is a dangerous shape: "frozen isn't consumed, let's stop setting
	 * consumed_at" is an entirely reasonable-sounding future edit, and it would
	 * silence the watchdog with every test still green.
	 *
	 * NOTE ON EXPOSURE, measured rather than assumed: `deadline_at` is currently
	 * NULL on every row in production (0 of 33k+ in geoforge3d, 0 in flywheel), so
	 * this cannot fire today. The mechanism is real; the bleeding is not. Recorded
	 * that way on purpose — "it can't happen" and "it can't happen yet" are
	 * different claims.
	 */
	it("⭐ a frozen overdue row must not latch the stall detector forever", () => {
		const PAST_DEADLINE = "2026-07-01T00:00:00.000Z";
		queue.enqueue({
			id: "founder_msg:lead-a:overdue",
			toLead: "lead-a",
			source: "founder_reply",
			type: "founder_reply",
			msgClass: "model",
			priority: 0,
			content: "stale instruction with a deadline",
			deadlineAt: PAST_DEADLINE,
		});

		queue.recordTickSuccess("lead-a", NOW);
		expect(queue.getHeartbeat("lead-a")?.stall_episode_at ?? null).toBeNull();

		// Latch an episode the way the real health checker does. `staleBefore` is
		// early enough that last_success_at is fresh, so the latch is driven by the
		// overdue row alone — not by a stale heartbeat.
		const episode = queue.claimHealthEpisode({
			leadId: "lead-a",
			now: NOW,
			staleBefore: "2026-07-31T00:00:00.000Z",
		});
		expect(episode).toBeDefined();
		const latched = queue.getHeartbeat("lead-a")?.stall_episode_at ?? null;
		expect(latched).not.toBeNull();

		// ⭐ CONTROL — while the row is LIVE, a successful tick must NOT clear the
		// episode. Without this the final assertion would pass just as well against
		// code that never latches anything at all.
		queue.recordTickSuccess("lead-a", NOW);
		expect(queue.getHeartbeat("lead-a")?.stall_episode_at ?? null).toBe(
			latched,
		);

		expect(queue.countPending("lead-a")).toBe(1);

		queue.freezeStockBelowWatermark({ now: NOW });

		// ⭐ After the freeze the row is out of the delivery pipeline, so the
		// watchdog's inputs are clean again.
		expect(queue.countPending("lead-a")).toBe(0);
		queue.recordTickSuccess("lead-a", NOW);
		expect(queue.getHeartbeat("lead-a")?.stall_episode_at ?? null).toBeNull();

		// ...and the freeze is still honest about what happened to the row:
		// removed from the queue, but NOT delivered.
		const row = queue.getById("founder_msg:lead-a:overdue");
		expect(row?.disposition).toBe("frozen_fly1586");
		expect(row?.delivered_at ?? null).toBeNull();
		expect(row?.consumed_at).toBeTruthy();
	});
});
