import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

/**
 * FLY-2921 C2 "Lead re-delivery resets the original wake, never mints a new
 * wake identity": `resumeTurnWakeHold` must be idempotent per receipt across
 * pushes (a completed push flips the row to `sent` without touching
 * `cancel_reason`), must not evict a live push claim, and must stay a
 * terminal no-op for acked/cancelled rows.
 *
 * FLY-2921 C4.6: `cancelTurnWakeDelivery` treats a source already cancelled
 * by the turn-wake patrol's terminal guard as an idempotent success (same
 * shape as a DEAD mailbox), so a staged cancel never sits in `staged` forever.
 */

const databases: CommDB[] = [];
const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const WAKE_ID = "turn-2921";
const RECIPIENT = "recipient-2921";
const LEASE_MS = 30_000;

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function raw(db: CommDB): Database.Database {
	return (db as unknown as { db: Database.Database }).db;
}

function fixture(): CommDB {
	const db = new CommDB(":memory:");
	databases.push(db);
	db.registerSession(RECIPIENT, "window", "flywheel", "FLY-2921", "lead");
	db.enqueueTurnWake({
		wakeId: WAKE_ID,
		executionId: RECIPIENT,
		issueId: "FLY-2921",
		epoch: 1,
		purpose: "workflow_rework",
		envelope: { fromAgent: "bridge", content: "rework content" },
		backend: "codex",
		createdAtMs: T0 - 60_000,
	});
	return db;
}

/** Two pushes already burned without a receipt: the state that opens the hold. */
function exhaust(db: CommDB): void {
	raw(db)
		.prepare(
			`UPDATE turn_wake_outbox
			    SET state = 'sent', push_count = 2, first_push_at = ?, last_push_at = ?,
			        last_push_result = 'error:wake_failed'
			  WHERE wake_id = ?`,
		)
		.run(T0 - 50_000, T0 - 40_000, WAKE_ID);
}

/** Drive the real patrol primitives: claim the row, then finish one push. */
function patrolPush(db: CommDB, nowMs: number, result: string): void {
	const claim = db.claimTurnWakeById({
		wakeId: WAKE_ID,
		nowMs,
		retryAfterMs: 0,
		leaseMs: LEASE_MS,
	});
	expect(claim).not.toBeNull();
	db.finishTurnWakePush({
		wakeId: WAKE_ID,
		claimToken: claim!.claim_token!,
		pushedAtMs: nowMs,
		result,
	});
}

describe("FLY-2921 resumeTurnWakeHold is idempotent per receipt across pushes", () => {
	it("resets once, then a same-receipt replay after a failed push does not reset again", () => {
		const db = fixture();
		exhaust(db);
		const receiptId = "hold-resume:R1";

		expect(
			db.resumeTurnWakeHold({ sourceId: WAKE_ID, receiptId, nowMs: T0 }),
		).toEqual({ kind: "reset" });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "pending",
			push_count: 0,
			first_push_at: null,
			last_push_at: null,
			last_push_result: null,
			claim_token: null,
			claim_expires_at: null,
			cancel_reason: receiptId,
		});

		patrolPush(db, T0 + 1_000, "error:wake_failed");
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "sent",
			push_count: 1,
			last_push_result: "error:wake_failed",
			cancel_reason: receiptId,
		});

		// Crash-window replay of the same Lead resume: the row is `sent`, not
		// `pending`, and the old code would clear push_count a second time.
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId,
				nowMs: T0 + 2_000,
			}),
		).toEqual({ kind: "idempotent_replay" });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "sent",
			push_count: 1,
			first_push_at: T0 + 1_000,
			last_push_at: T0 + 1_000,
			last_push_result: "error:wake_failed",
			cancel_reason: receiptId,
		});
	});

	it("does not reset again when the push succeeded and the resume is replayed after a crash", () => {
		const db = fixture();
		exhaust(db);
		const receiptId = "hold-resume:R1";
		expect(
			db.resumeTurnWakeHold({ sourceId: WAKE_ID, receiptId, nowMs: T0 }),
		).toEqual({ kind: "reset" });
		patrolPush(db, T0 + 1_000, "ok");
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "sent",
			push_count: 1,
			last_push_result: "ok",
		});

		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId,
				nowMs: T0 + 5_000,
			}),
		).toEqual({ kind: "idempotent_replay" });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "sent",
			push_count: 1,
			first_push_at: T0 + 1_000,
			last_push_result: "ok",
			cancel_reason: receiptId,
		});
	});

	it("returns busy and leaves a live patrol claim untouched; a later resume resets once the claim is gone", () => {
		const db = fixture();
		exhaust(db);
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:R1",
				nowMs: T0,
			}),
		).toEqual({ kind: "reset" });
		const claim = db.claimTurnWakeById({
			wakeId: WAKE_ID,
			nowMs: T0 + 1_000,
			retryAfterMs: 0,
			leaseMs: LEASE_MS,
		});
		expect(claim).not.toBeNull();
		const claimToken = claim!.claim_token!;
		const claimExpiresAt = T0 + 1_000 + LEASE_MS;
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			claim_token: claimToken,
			claim_expires_at: claimExpiresAt,
		});

		// A different Lead resume while the patrol holds the claim: retryable, not executed.
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:R2",
				nowMs: T0 + 2_000,
			}),
		).toEqual({ kind: "busy", claimExpiresAt });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "pending",
			push_count: 0,
			claim_token: claimToken,
			claim_expires_at: claimExpiresAt,
			cancel_reason: "hold-resume:R1",
		});

		// A same-receipt replay while the claim is live is still the idempotent
		// replay, and it must not evict the claim either.
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:R1",
				nowMs: T0 + 2_500,
			}),
		).toEqual({ kind: "idempotent_replay" });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			claim_token: claimToken,
			claim_expires_at: claimExpiresAt,
		});

		// The patrol finishes its push under the claim it still owns.
		db.finishTurnWakePush({
			wakeId: WAKE_ID,
			claimToken,
			pushedAtMs: T0 + 3_000,
			result: "error:wake_failed",
		});
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "sent",
			push_count: 1,
			claim_token: null,
		});

		// Claim released by the push: the deferred resume now resets exactly once.
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:R2",
				nowMs: T0 + 4_000,
			}),
		).toEqual({ kind: "reset" });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "pending",
			push_count: 0,
			cancel_reason: "hold-resume:R2",
			claim_token: null,
			claim_expires_at: null,
		});
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:R2",
				nowMs: T0 + 5_000,
			}),
		).toEqual({ kind: "idempotent_replay" });
	});

	it("treats an expired claim as gone and resets", () => {
		const db = fixture();
		const claim = db.claimTurnWakeById({
			wakeId: WAKE_ID,
			nowMs: T0,
			retryAfterMs: 0,
			leaseMs: LEASE_MS,
		});
		expect(claim).not.toBeNull();
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:R1",
				nowMs: T0 + LEASE_MS - 1,
			}),
		).toEqual({ kind: "busy", claimExpiresAt: T0 + LEASE_MS });
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:R1",
				nowMs: T0 + LEASE_MS,
			}),
		).toEqual({ kind: "reset" });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "pending",
			push_count: 0,
			claim_token: null,
			claim_expires_at: null,
			cancel_reason: "hold-resume:R1",
		});
	});

	it("stays a terminal no-op for acked, cancelled, and missing sources", () => {
		const db = fixture();
		exhaust(db);
		expect(
			db.ackTurnWakes({
				executionId: RECIPIENT,
				epoch: 1,
				ackedAtMs: T0,
			}),
		).toBe(1);
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:acked",
				nowMs: T0 + 1_000,
			}),
		).toEqual({ kind: "noop", reason: "acked" });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "acked",
			push_count: 2,
			cancel_reason: null,
		});

		raw(db)
			.prepare(
				`UPDATE turn_wake_outbox
				    SET state = 'cancelled', cancel_reason = 'terminal_guard:target_terminal'
				  WHERE wake_id = ?`,
			)
			.run(WAKE_ID);
		expect(
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "hold-resume:cancelled",
				nowMs: T0 + 2_000,
			}),
		).toEqual({ kind: "noop", reason: "cancelled" });
		expect(db.getTurnWake(WAKE_ID)).toMatchObject({
			state: "cancelled",
			cancel_reason: "terminal_guard:target_terminal",
		});

		expect(
			db.resumeTurnWakeHold({
				sourceId: "turn-missing",
				receiptId: "hold-resume:missing",
				nowMs: T0 + 3_000,
			}),
		).toEqual({ kind: "noop", reason: "source_missing" });
	});

	it("rejects an invalid clock or blank identifiers", () => {
		const db = fixture();
		expect(() =>
			db.resumeTurnWakeHold({ sourceId: WAKE_ID, receiptId: " ", nowMs: T0 }),
		).toThrow("invalid TURN wake hold recovery");
		expect(() =>
			db.resumeTurnWakeHold({
				sourceId: WAKE_ID,
				receiptId: "r",
				nowMs: Number.NaN,
			}),
		).toThrow("invalid TURN wake hold recovery");
	});
});

describe("FLY-2921 cancelTurnWakeDelivery on a terminal-guard-cancelled source", () => {
	it("is an idempotent success shaped like the mailbox DEAD no-op and leaves the row untouched", () => {
		const db = fixture();
		expect(db.cancelTurnWake(WAKE_ID, "terminal_guard:target_terminal")).toBe(
			true,
		);
		const before = db.getTurnWake(WAKE_ID);
		expect(
			db.cancelTurnWakeDelivery({
				sourceId: WAKE_ID,
				operationId: "op-2921",
				now: "2026-09-26T10:01:00.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false, noop: true });
		expect(db.getTurnWake(WAKE_ID)).toEqual(before);
	});

	it("still rejects a source cancelled for any other foreign reason", () => {
		const db = fixture();
		expect(db.cancelTurnWake(WAKE_ID, "rerouted:attempt-1")).toBe(true);
		expect(
			db.cancelTurnWakeDelivery({
				sourceId: WAKE_ID,
				operationId: "op-2921",
				now: "2026-09-26T10:01:00.000Z",
			}),
		).toEqual({ ok: false, reason: "turn_wake_source_changed" });
	});
});

describe("FLY-2921 claimDueTurnWake scan cursor", () => {
	it("claims only rows strictly after the cursor in created_at, wake_id order", () => {
		const db = new CommDB(":memory:");
		try {
			for (const [wakeId, createdAtMs] of [
				["wake-a", 1_000],
				["wake-b", 1_000],
				["wake-c", 2_000],
			] as const) {
				db.enqueueTurnWake({
					wakeId,
					executionId: `exec-${wakeId}`,
					issueId: "FLY-2921",
					epoch: 1,
					purpose: "workflow_rework",
					envelope: { fromAgent: "bridge", content: wakeId },
					backend: "codex",
					createdAtMs,
				});
			}
			const claim = (after?: { createdAt: number; wakeId: string }) =>
				db.claimDueTurnWake({
					nowMs: 5_000,
					retryAfterMs: 0,
					leaseMs: 30_000,
					...(after ? { after } : {}),
				});
			const first = claim();
			expect(first?.wake_id).toBe("wake-a");
			db.releaseTurnWakeClaim(first!.wake_id, first!.claim_token!);
			const second = claim({ createdAt: 1_000, wakeId: "wake-a" });
			expect(second?.wake_id).toBe("wake-b");
			db.releaseTurnWakeClaim(second!.wake_id, second!.claim_token!);
			const third = claim({ createdAt: 1_000, wakeId: "wake-b" });
			expect(third?.wake_id).toBe("wake-c");
			db.releaseTurnWakeClaim(third!.wake_id, third!.claim_token!);
			expect(claim({ createdAt: 2_000, wakeId: "wake-c" })).toBeNull();
			expect(() => claim({ createdAt: Number.NaN, wakeId: "wake-a" })).toThrow(
				"invalid TURN wake claim window",
			);
		} finally {
			db.close();
		}
	});
});
