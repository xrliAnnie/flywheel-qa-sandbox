import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { InboxWriteValidationError } from "../inbox-write-normalize.js";
import { LeadInboxQueue } from "../lead-inbox-queue.js";

/**
 * FLY-1586 A — regression at the real `enqueue()` boundary.
 *
 * The production failure: `lead_events` seq 56649 carried a lone high surrogate
 * (a 🏆 cut in half by `.slice(0, 500)`). SQLite stored U+FFFD instead, the
 * insert-then-verify read-back no longer matched the caller's value, `enqueue()`
 * threw "lead inbox id ... was reused with different content", the transaction
 * rolled back, `ensureCutover()` failed, `admit()` failed, and — because `admit`
 * runs before both claim paths inside the same `try` — nothing was ever
 * delivered. 14 Leads / 7 projects, 61 hours.
 */

const TROPHY = "\u{1F3C6}";
const LONE_HIGH = "\uD83C";
const REPLACEMENT = "�";

describe("FLY-1586 A — enqueue boundary normalization", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1586-normalize-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const base = {
		toLead: "lead-a",
		source: "lead_event:56649",
		type: "session_completed",
		msgClass: "model" as const,
		priority: 2,
	};

	it("accepts the seq 56649 shape instead of throwing (the whole point)", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			// Before the fix this threw:
			//   "lead inbox id ... was reused with different content"
			const row = queue.enqueue({
				...base,
				id: "lead_event:lead-a:evt-56649",
				content: `Summary: ${LONE_HIGH}`,
			});
			expect(row.content).toBe(`Summary: ${REPLACEMENT}`);
		} finally {
			queue.close();
		}
	});

	it("stores what it claims to store — read-back equals the written value", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			queue.enqueue({
				...base,
				id: "lead_event:lead-a:readback",
				content: `head${LONE_HIGH}tail`,
			});
		} finally {
			queue.close();
		}
		// Read with a completely separate connection: this is what SQLite really
		// persisted, not what our own object cached.
		const raw = new Database(dbPath, { readonly: true });
		try {
			const row = raw
				.prepare("SELECT content FROM lead_inbox WHERE id = ?")
				.get("lead_event:lead-a:readback") as { content: string };
			expect(row.content).toBe(`head${REPLACEMENT}tail`);
		} finally {
			raw.close();
		}
	});

	it("stays idempotent on re-enqueue of the same poison row", () => {
		// The reconciler re-runs on every boot. If the second pass compared the
		// stored (repaired) value against the raw poison, it would throw again —
		// and the fleet would stay wedged exactly as before.
		const queue = new LeadInboxQueue(dbPath);
		try {
			const input = {
				...base,
				id: "lead_event:lead-a:idempotent",
				content: `x${LONE_HIGH}y`,
			};
			const first = queue.enqueue(input);
			const second = queue.enqueue(input);
			expect(second.content).toBe(first.content);
			expect(second.seq).toBe(first.seq);
		} finally {
			queue.close();
		}
	});

	it("leaves well-formed content byte-identical (reverse-compat sentinel)", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			const content = `done ${TROPHY} 全部完成`;
			const row = queue.enqueue({
				...base,
				id: "lead_event:lead-a:clean",
				content,
			});
			expect(row.content).toBe(content);
		} finally {
			queue.close();
		}
	});

	it("REJECTS a lone surrogate in an identity/routing key, with a typed error", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			expect(() =>
				queue.enqueue({
					...base,
					id: `lead_event:lead-a:${LONE_HIGH}`,
					content: "fine",
				}),
			).toThrow(InboxWriteValidationError);

			expect(() =>
				queue.enqueue({
					...base,
					id: "lead_event:lead-a:bad-source",
					source: `lead_event:${LONE_HIGH}`,
					content: "fine",
				}),
			).toThrow(InboxWriteValidationError);
		} finally {
			queue.close();
		}
	});

	it("does not persist anything when an identity key is rejected", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			expect(() =>
				queue.enqueue({
					...base,
					id: `lead_event:lead-a:${LONE_HIGH}`,
					content: "fine",
				}),
			).toThrow(InboxWriteValidationError);
			expect(queue.countPending("lead-a")).toBe(0);
		} finally {
			queue.close();
		}
	});

	it("enqueueHubRoot: OUTER comparator must also see the normalized value", () => {
		// This entry point wraps its own read-back comparator around enqueue().
		// Normalizing only inside enqueue() leaves this outer one holding the raw
		// poison — it throws "founder hub root ... was reused with different data"
		// and the fix accomplishes nothing here. This is the founder_reply path.
		const queue = new LeadInboxQueue(dbPath);
		try {
			const row = queue.enqueueHubRoot({
				id: "founder_msg:lead-a:msg-1",
				toLead: "lead-a",
				content: `ship it ${LONE_HIGH}`,
				refMessageId: "msg-1",
				now: "2026-07-31T21:00:00.000Z",
			});
			expect(row.content).toBe(`ship it ${REPLACEMENT}`);
			expect(row.source).toBe("founder_reply");
			expect(row.routing_state).toBe("hub_recorded");
		} finally {
			queue.close();
		}
	});

	it("enqueueHubRoot: rejects a poisoned routing_state rather than repairing it", () => {
		const queue = new LeadInboxQueue(dbPath);
		try {
			expect(() =>
				queue.enqueueHubRoot({
					id: "founder_msg:lead-a:msg-2",
					toLead: "lead-a",
					content: "clean",
					refMessageId: "msg-2",
					now: "2026-07-31T21:00:00.000Z",
					routingState: `hub${LONE_HIGH}`,
				}),
			).toThrow(InboxWriteValidationError);
		} finally {
			queue.close();
		}
	});

	it("reconcileEnqueueConsumed: normalizes on both the INSERT and the compare", () => {
		// The third entry point bypasses enqueue() completely — its own
		// INSERT OR IGNORE plus its own comparator. The legacy reconciler's
		// answered/probe branches go through here, so a miss would leave the
		// original cutover wedge in place on exactly those rows.
		const queue = new LeadInboxQueue(dbPath);
		try {
			const now = "2026-07-31T21:00:00.000Z";
			expect(
				queue.acquireOrRenewOwner({
					ownerEpoch: "epoch-1",
					now,
					leaseTtlMs: 60_000,
				}),
			).toBe(true);

			const input = {
				...base,
				id: "lead_event:lead-a:terminal",
				content: `migrated ${LONE_HIGH}`,
			};
			const terminal = {
				ownerEpoch: "epoch-1",
				disposition: "migrated",
				delivered: true,
				now,
			};

			expect(queue.reconcileEnqueueConsumed(input, terminal).outcome).toBe(
				"inserted",
			);
			// Second pass is what the reconciler actually does on the next boot:
			// it must agree with the stored (normalized) row, not with the raw
			// poison it was handed.
			expect(queue.reconcileEnqueueConsumed(input, terminal).outcome).toBe(
				"idempotent",
			);

			const row = queue.getById("lead_event:lead-a:terminal");
			expect(row?.content).toBe(`migrated ${REPLACEMENT}`);
			expect(row?.consumed_at).toBeTruthy();
		} finally {
			queue.close();
		}
	});
});

describe("FLY-1586 A — code review R1 HIGH-4 closures", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1586-high4-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const NOW = "2026-08-01T00:00:00.000Z";
	const base = {
		toLead: "lead-a",
		source: "lead_event:1",
		type: "session_completed",
		msgClass: "model" as const,
		priority: 2,
	};

	it("HIGH-4c: a lone surrogate in the exemption audit is TYPED, not a generic wedge", () => {
		// Before: these three fields were checked for non-emptiness only and their
		// return values discarded, so raw input was persisted AND compared. A lone
		// surrogate in `actor` reproduced the seq-56649 insert/read-back mismatch —
		// but as an UNTYPED error, which B classifies as `rethrow`. That is the
		// wedge, not a graceful failure.
		const q = new LeadInboxQueue(dbPath);
		try {
			const attempt = () =>
				q.enqueue({
					...base,
					id: "lead_event:lead-a:exempt",
					content: "clean",
					receiptExemptReason: "internal_mirror",
					receiptExemptionAudit: {
						eventId: "evt-1",
						actor: `annie${LONE_HIGH}`,
						changeSource: "test",
						at: NOW,
					},
				});
			// Typed ⇒ B quarantines the row and the cutover CONTINUES.
			expect(attempt).toThrow(InboxWriteValidationError);
			// And explicitly NOT the untyped shape that wedges:
			expect(attempt).not.toThrow(/was reused/);
		} finally {
			q.close();
		}
	});

	it("HIGH-4a: the terminal entry point records the repair it performed", () => {
		const q = new LeadInboxQueue(dbPath);
		try {
			q.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 60_000,
			});
			expect(
				q.reconcileEnqueueConsumed(
					{ ...base, id: "lead_event:lead-a:term", content: `x${LONE_HIGH}y` },
					{
						ownerEpoch: "epoch-1",
						disposition: "migrated",
						delivered: true,
						now: NOW,
					},
				),
			).toMatchObject({ outcome: "inserted" });
			// A substitution nobody can prove happened is the evidence gap that
			// made the original incident unresolvable 61 hours later.
			const audit = q.listSanitationAudit();
			expect(audit).toHaveLength(1);
			expect(audit[0]?.inbox_id).toBe("lead_event:lead-a:term");
		} finally {
			q.close();
		}
	});

	it("HIGH-4b: reusing an id with a DIFFERENT message is rejected, not accepted", () => {
		const q = new LeadInboxQueue(dbPath);
		try {
			q.acquireOrRenewOwner({
				ownerEpoch: "epoch-1",
				now: NOW,
				leaseTtlMs: 60_000,
			});
			const terminal = {
				ownerEpoch: "epoch-1",
				disposition: "migrated",
				delivered: true,
				now: NOW,
			};
			expect(
				q.reconcileEnqueueConsumed(
					{
						...base,
						id: "lead_event:lead-a:reuse",
						content: "same",
						refMessageId: "ref-original",
					},
					terminal,
				),
			).toMatchObject({ outcome: "inserted" });

			// Same id, DIFFERENT ref — the comparator omitted this field, so it
			// answered "yes, same row" and the caller treated a different message
			// as already settled.
			expect(
				q.reconcileEnqueueConsumed(
					{
						...base,
						id: "lead_event:lead-a:reuse",
						content: "same",
						refMessageId: "ref-DIFFERENT",
					},
					terminal,
				),
				// R2 HIGH-3: a deterministic conflict must be DISTINGUISHABLE from a
				// lost owner lease. Collapsed into one boolean, the reconciler
				// reported both as "owner fence lost" and retried the deterministic
				// one forever.
			).toMatchObject({ outcome: "conflict", field: "ref_message_id" });
		} finally {
			q.close();
		}
	});
});
