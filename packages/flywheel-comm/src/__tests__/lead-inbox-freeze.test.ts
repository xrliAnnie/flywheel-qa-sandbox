import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { bizClassOf, FREEZE_DISPOSITION } from "../lead-inbox-freeze.js";
import { LeadInboxQueue } from "../lead-inbox-queue.js";

/**
 * FLY-1586 F — stock freeze by `seq` watermark.
 *
 * The backlog holds 40 undelivered `founder_msg` rows that were already acted
 * on, including `answer="ship"` for FLY-1569 whose PR merged two minutes later.
 * Restoring delivery without this replays a founder instruction that has
 * already been executed.
 */

const NOW = "2026-07-31T22:00:00.000Z";

describe("FLY-1586 F — stock freeze", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1586-freeze-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function open(): LeadInboxQueue {
		const q = new LeadInboxQueue(dbPath);
		q.acquireOrRenewOwner({
			ownerEpoch: "epoch-1",
			now: NOW,
			leaseTtlMs: 60_000,
		});
		return q;
	}

	const msg = (id: string, source = "lead_event:1") => ({
		id,
		toLead: "lead-a",
		source,
		type: source === "founder_reply" ? "founder_reply" : "session_completed",
		msgClass: "model" as const,
		priority: 2,
		content: "hello",
	});

	const claimIds = (q: LeadInboxQueue): string[] =>
		q
			.claimModelBatch({
				toLead: "lead-a",
				ownerEpoch: "epoch-1",
				batchId: "batch-1",
				now: NOW,
				claimTtlMs: 60_000,
				limit: 100,
				respectRetryAt: true,
			})
			.map((r) => r.id);

	it("⭐ frozen stock is never delivered, but new messages flow", () => {
		const q = open();
		try {
			q.enqueue(msg("founder_msg:lead-a:ship", "founder_reply"));
			q.enqueue(msg("lead_event:lead-a:old-1"));

			const { watermark, frozen } = q.freezeStockBelowWatermark({ now: NOW });
			expect(frozen).toBe(2);
			expect(watermark).toBeGreaterThan(0);

			// Arrives after the watermark — genuinely new, higher seq.
			q.enqueue(msg("lead_event:lead-a:new-1"));

			const claimed = claimIds(q);
			// The founder's already-executed ship is NOT replayed.
			expect(claimed).not.toContain("founder_msg:lead-a:ship");
			expect(claimed).not.toContain("lead_event:lead-a:old-1");
			// ⭐ Control group. "Nothing was delivered" is ALSO true when the whole
			// path is dead — which is the pre-fix state. Only the PAIR of
			// assertions distinguishes "freeze works" from "still wedged".
			expect(claimed).toEqual(["lead_event:lead-a:new-1"]);
		} finally {
			q.close();
		}
	});

	it("never claims a frozen row was delivered", () => {
		const q = open();
		try {
			q.enqueue(msg("founder_msg:lead-a:ship", "founder_reply"));
			q.freezeStockBelowWatermark({ now: NOW });

			const row = q.getById("founder_msg:lead-a:ship");
			// Parked, and honest about it: consumed (removed from the delivery
			// queue) but explicitly NOT delivered.
			expect(row?.consumed_at).toBe(NOW);
			expect(row?.disposition).toBe(FREEZE_DISPOSITION);
			expect(row?.delivered_at ?? null).toBeNull();
		} finally {
			q.close();
		}
	});

	it("is idempotent — a second freeze touches nothing", () => {
		const q = open();
		try {
			q.enqueue(msg("lead_event:lead-a:old-1"));
			expect(q.freezeStockBelowWatermark({ now: NOW }).frozen).toBe(1);
			// Re-running on the next boot must be a no-op.
			expect(
				q.freezeStockBelowWatermark({ now: "2026-08-01T00:00:00.000Z" }).frozen,
			).toBe(0);
			expect(q.getById("lead_event:lead-a:old-1")?.consumed_at).toBe(NOW);
		} finally {
			q.close();
		}
	});

	it("⭐ traffic that arrives BETWEEN boots survives the next freeze", () => {
		// Code review R1 BLOCKER-1. The freeze now runs on every cutover, so this
		// is the case that decides whether it is a one-time cleanup or a permanent
		// message shredder: recomputing MAX(seq) on the second boot would park
		// everything that legitimately arrived in between.
		//
		// The previous idempotence test inserted nothing between the two calls,
		// which is exactly why it could not see this.
		const first = open();
		try {
			first.enqueue(msg("lead_event:lead-a:stock"));
			expect(first.freezeStockBelowWatermark({ now: NOW }).frozen).toBe(1);
		} finally {
			first.close();
		}

		// ... Bridge keeps running, a real message arrives ...
		const between = open();
		try {
			between.enqueue(msg("lead_event:lead-a:arrived-between"));
		} finally {
			between.close();
		}

		// ... Bridge restarts, cutover runs the freeze again ...
		const second = open();
		try {
			expect(
				second.freezeStockBelowWatermark({ now: "2026-08-01T00:00:00.000Z" })
					.frozen,
			).toBe(0);
			expect(
				second.getById("lead_event:lead-a:arrived-between")?.consumed_at ??
					null,
			).toBeNull();
			expect(claimIds(second)).toEqual(["lead_event:lead-a:arrived-between"]);
		} finally {
			second.close();
		}
	});

	it("reuses the FIRST watermark, never a recomputed one", () => {
		const first = open();
		let stored: number;
		try {
			first.enqueue(msg("lead_event:lead-a:stock"));
			stored = first.freezeStockBelowWatermark({ now: NOW }).watermark;
		} finally {
			first.close();
		}
		const second = open();
		try {
			second.enqueue(msg("lead_event:lead-a:later"));
			// A recomputed watermark would be higher — and would have swallowed
			// the row above.
			expect(
				second.freezeStockBelowWatermark({ now: "2026-08-01T00:00:00.000Z" })
					.watermark,
			).toBe(stored);
		} finally {
			second.close();
		}
	});

	it("⭐ the fence SURVIVES receipt activation re-arming the timer", () => {
		// Code review R2 BLOCKER. My first fence just nulled `next_unprocessed_at`.
		// Activation re-stamps it with `COALESCE(next_unprocessed_at, ?)`, so the
		// fence lasted exactly until the next activation — and the patrol then
		// minted a post-watermark child starting with the old founder instruction.
		//
		// My earlier test stopped at "observed NULL" and never ran activation,
		// which is precisely why it could not see this. A cleared column is not a
		// fence; it is a value someone else will fill in.
		const q = open();
		try {
			q.enqueue(msg("founder_msg:lead-a:delivered", "founder_reply"));
		} finally {
			q.close();
		}
		const setup = new Database(dbPath);
		try {
			setup
				.prepare(
					`UPDATE lead_inbox
					   SET delivered_at = ?, consumed_at = ?, disposition = 'delivered',
					       next_unprocessed_at = ?
					 WHERE id = ?`,
				)
				.run(NOW, NOW, NOW, "founder_msg:lead-a:delivered");
		} finally {
			setup.close();
		}

		const q2 = open();
		try {
			q2.freezeStockBelowWatermark({ now: NOW });
			// Enrolled as an explicit id — that is the durable fact, not the NULL.
			expect(q2.listFencedRoots().map((f) => f.inbox_id)).toContain(
				"founder_msg:lead-a:delivered",
			);
		} finally {
			q2.close();
		}

		// ⭐ Now actually run activation — the step my earlier test skipped.
		const db = new CommDB(dbPath);
		try {
			db.bootstrapUnprocessedReceipts({
				now: "2026-08-01T01:00:00.000Z",
				windowMs: 60_000,
			});
		} finally {
			db.close();
		}

		const q3 = open();
		try {
			const row = q3.getById("founder_msg:lead-a:delivered");
			// Still fenced: activation did NOT re-arm the timer.
			expect(row?.next_unprocessed_at ?? null).toBeNull();
			// And still honest about what it is: not processed, not disposed.
			expect(row?.processed_at ?? null).toBeNull();
			expect(row?.disposed_at ?? null).toBeNull();
		} finally {
			q3.close();
		}
	});

	it("⭐ cancels a pending outbox that would re-deliver the old founder answer", () => {
		// Code review R2 BLOCKER, third path. Excluding fenced roots from the
		// selectors stops NEW alerts, but an outbox row created BEFORE the freeze
		// is already sitting there — and its notification embeds `contentSummary`
		// and asks the Lead to complete the routing side effect. That is the old
		// founder answer arriving a second time, out of a queue we already decided
		// to hold back.
		const q = open();
		try {
			q.enqueue(msg("founder_msg:lead-a:delivered", "founder_reply"));
		} finally {
			q.close();
		}
		const setup = new Database(dbPath);
		try {
			setup
				.prepare(
					`UPDATE lead_inbox
					   SET delivered_at = ?, consumed_at = ?, disposition = 'delivered',
					       next_unprocessed_at = ?
					 WHERE id = ?`,
				)
				.run(NOW, NOW, NOW, "founder_msg:lead-a:delivered");
			setup
				.prepare(
					`INSERT INTO receipt_alert_outbox (id, kind, payload, created_at)
					 VALUES (?, 'receipt_unprocessed', ?, ?)`,
				)
				.run(
					"unprocessed:founder_msg:lead-a:delivered",
					JSON.stringify({ rootId: "founder_msg:lead-a:delivered" }),
					NOW,
				);
		} finally {
			setup.close();
		}

		const q2 = open();
		try {
			q2.freezeStockBelowWatermark({ now: NOW });
		} finally {
			q2.close();
		}

		const check = new Database(dbPath, { readonly: true });
		try {
			const row = check
				.prepare(
					"SELECT canceled_at, cancel_reason FROM receipt_alert_outbox WHERE id = ?",
				)
				.get("unprocessed:founder_msg:lead-a:delivered") as {
				canceled_at: string | null;
				cancel_reason: string | null;
			};
			expect(row.canceled_at).toBe(NOW);
			expect(row.cancel_reason).toBe("fly1586_stock_frozen");
		} finally {
			check.close();
		}
	});

	it("leaves the protocol lane alone so ACK settlement stays live", () => {
		const q = open();
		try {
			q.enqueue({
				...msg("ack:lead-a:r1", "ack_receipt:r1"),
				type: "ack_receipt",
				msgClass: "protocol",
			});

			expect(q.freezeStockBelowWatermark({ now: NOW }).frozen).toBe(0);

			// An ACK records something that already happened; settling it late is
			// safe, whereas discarding it leaves escalation state permanently wrong.
			const row = q.claimProtocol({
				toLead: "lead-a",
				ownerEpoch: "epoch-1",
				now: NOW,
				claimTtlMs: 60_000,
				respectRetryAt: true,
			});
			expect(row?.id).toBe("ack:lead-a:r1");
		} finally {
			q.close();
		}
	});

	it("stops frozen rows from inflating the pending count", () => {
		const q = open();
		try {
			q.enqueue(msg("lead_event:lead-a:old-1"));
			expect(q.countPending("lead-a")).toBe(1);
			q.freezeStockBelowWatermark({ now: NOW });
			// Falls out for free: countPending already filters consumed_at IS NULL.
			// The same is true of the stall check inside recordTickSuccess, so a
			// frozen row cannot latch stall_episode_at forever and silence the
			// watchdog that actually detected this incident.
			expect(q.countPending("lead-a")).toBe(0);
		} finally {
			q.close();
		}
	});

	it("exports the frozen backlog as the hand-off list, classified", () => {
		const q = open();
		try {
			q.enqueue(msg("founder_msg:lead-a:ship", "founder_reply"));
			q.enqueue(msg("lead_event:lead-a:old-1"));
			q.freezeStockBelowWatermark({ now: NOW });

			const frozen = q.listFrozenStock();
			expect(frozen).toHaveLength(2);
			expect(frozen.find((f) => f.biz_class === "founder_msg")?.id).toBe(
				"founder_msg:lead-a:ship",
			);
			expect(frozen.find((f) => f.biz_class === "lead_event")?.id).toBe(
				"lead_event:lead-a:old-1",
			);
		} finally {
			q.close();
		}
	});
});

describe("bizClassOf — the trap that makes a freeze filter fail OPEN", () => {
	it("identifies founder_msg by source, not by msg_class", () => {
		// `msg_class` only ever holds 'protocol' | 'model' (schema CHECK), so
		// `WHERE msg_class = 'founder_msg'` matches zero rows — forever, silently.
		// In a freeze filter that is not a no-op, it is fail-OPEN.
		expect(
			bizClassOf({
				id: "founder_msg:lead-a:m1",
				source: "founder_reply",
				type: "founder_reply",
			}),
		).toBe("founder_msg");
	});

	it("prefers `source` over the id prefix", () => {
		// `enqueueHubRoot` writes `source` itself; the id is minted by the caller.
		expect(
			bizClassOf({
				id: "whatever-the-caller-chose",
				source: "founder_reply",
				type: "founder_reply",
			}),
		).toBe("founder_msg");
	});

	it("classifies the other production shapes and falls back honestly", () => {
		expect(
			bizClassOf({
				id: "question:lead-a:q1",
				source: "question:7",
				type: "gate_question",
			}),
		).toBe("question");
		expect(
			bizClassOf({
				id: "chat:lead-a:m",
				source: "discord_chat",
				type: "external_delivery",
			}),
		).toBe("chat");
		expect(bizClassOf({ id: "x", source: "y", type: "z" })).toBe("other");
	});
});
