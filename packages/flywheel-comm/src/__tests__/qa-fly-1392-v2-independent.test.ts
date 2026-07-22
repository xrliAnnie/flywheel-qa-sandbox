// Independent QA (FLY-1392 v2 category-agnostic RE-TEST, head 500389f1).
// These assertions are written against the shipped v2 implementation and add
// NON-VACUITY contrasts + load-bearing-wall mutations the implementer's own
// capability/schema tests don't pair up — the heart of Annie's ruling:
// every message is chased by default; the ONLY escape is the narrow
// `internal_mirror` exemption; no message category can opt out.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import {
	DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
	LeadInboxQueue,
} from "../lead-inbox-queue.js";

const T0 = "2026-07-21T12:00:00.000Z";
const T1 = "2026-07-21T12:01:00.000Z";
const P2_WINDOW = DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS[2];

describe("FLY-1392 v2 independent QA — default coverage vs the one narrow exemption", () => {
	let dir: string;
	let dbPath: string;
	let db: CommDB;
	let queue: LeadInboxQueue;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-fly1392-v2-"));
		dbPath = join(dir, "comm.db");
		db = new CommDB(dbPath);
		queue = new LeadInboxQueue(dbPath);
		expect(
			queue.acquireOrRenewOwner({
				ownerEpoch: "epoch-v2",
				now: T0,
				leaseTtlMs: 24 * 60 * 60_000,
			}),
		).toBe(true);
	});

	afterEach(() => {
		queue.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function deliverAll(): void {
		const claimed = queue.claimModelBatch({
			toLead: "lead-a",
			ownerEpoch: "epoch-v2",
			batchId: "batch",
			now: T0,
			claimTtlMs: 60_000,
		});
		queue.markConsumed(
			claimed.map(({ id }) => id),
			{
				ownerEpoch: "epoch-v2",
				disposition: "delivered",
				now: T0,
				receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
			},
		);
		db.reconcileReceiptActivation({
			enabled: true,
			now: T0,
			receiptWindowsMs: DEFAULT_RECEIPT_PRIORITY_WINDOWS_MS,
			highWaterMark: "1485740000000000000",
		});
	}

	function advance(): string[] {
		const due = new Date(Date.parse(T0) + P2_WINDOW + 1).toISOString();
		return db
			.advanceDueUnprocessedReceipts({
				now: due,
				windowMs: P2_WINDOW,
				resendCap: 2,
			})
			.map((o) => o.rootId);
	}

	// The non-vacuity contrast Annie's ruling needs, in ONE run: an
	// unheard-of new category is chased by default, while the SAME new
	// category with the narrow internal_mirror exemption is not. If the chase
	// were vacuous (everything or nothing chased), one of these two would fail.
	it("a brand-new category is chased by default; only internal_mirror escapes", () => {
		queue.enqueue({
			id: "new-default",
			toLead: "lead-a",
			source: "future:a",
			type: "category_that_did_not_exist_v42",
			msgClass: "model",
			content: "brand new type, no exemption",
			createdAt: T0,
		});
		queue.enqueue({
			id: "new-exempt",
			toLead: "lead-a",
			source: "future:b",
			type: "category_that_did_not_exist_v42",
			msgClass: "model",
			content: "same brand new type, internal_mirror exemption",
			createdAt: T0,
			receiptExemptReason: "internal_mirror",
			receiptExemptionAudit: {
				eventId: "exemption:set:new-exempt",
				actor: "lead-a",
				at: T0,
				changeSource: "internal-mirror-producer",
			},
		});
		deliverAll();

		const chased = advance();
		expect(chased).toContain("new-default"); // default → chased
		expect(chased).not.toContain("new-exempt"); // internal_mirror → not chased
	});

	// Load-bearing wall §7.5: no message CATEGORY can be exempted. The API type
	// only allows internal_mirror; the DB CHECK must independently reject any
	// other reason even if the API were bypassed.
	it("the DB rejects a category-based exemption (only internal_mirror is legal)", () => {
		const raw = new Database(dbPath);
		try {
			expect(() =>
				raw
					.prepare(
						`INSERT INTO lead_inbox
						 (id, to_lead, source, type, msg_class, priority, content, receipt_exempt_reason)
						 VALUES ('cat-exempt','lead-a','x','progress','model',3,'p','telemetry')`,
					)
					.run(),
			).toThrow(); // CHECK(receipt_exempt_reason IS NULL OR = 'internal_mirror')
			// internal_mirror is accepted.
			expect(() =>
				raw
					.prepare(
						`INSERT INTO lead_inbox
						 (id, to_lead, source, type, msg_class, priority, content, receipt_exempt_reason)
						 VALUES ('mirror-ok','lead-a','x','progress','model',3,'p','internal_mirror')`,
					)
					.run(),
			).not.toThrow();
		} finally {
			raw.close();
		}
	});

	// Load-bearing wall §7.4: at-most-one terminal + paired-null. A row can never
	// be both processed and disposed, and neither terminal may be half-written.
	it("the DB rejects both-terminal and half-written terminal states", () => {
		queue.enqueue({
			id: "term",
			toLead: "lead-a",
			source: "x",
			type: "runner_question",
			msgClass: "model",
			priority: 1,
			content: "p",
			createdAt: T0,
		});
		const raw = new Database(dbPath);
		try {
			// both terminal → rejected
			expect(() =>
				raw
					.prepare(
						`UPDATE lead_inbox SET processed_at=?, processed_evidence='{}',
						   disposed_at=?, disposed_evidence='{}' WHERE id='term'`,
					)
					.run(T1, T1),
			).toThrow();
			// half-written processed (at without evidence) → rejected
			expect(() =>
				raw
					.prepare(`UPDATE lead_inbox SET processed_at=? WHERE id='term'`)
					.run(T1),
			).toThrow();
			// half-written disposed → rejected
			expect(() =>
				raw
					.prepare(`UPDATE lead_inbox SET disposed_at=? WHERE id='term'`)
					.run(T1),
			).toThrow();
		} finally {
			raw.close();
		}
	});
});
