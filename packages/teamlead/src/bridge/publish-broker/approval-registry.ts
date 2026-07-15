/**
 * FLY-1062 broker PR · in-memory founder-approval registry (plan §3 ①b/②).
 *
 * Filled ONLY from the trusted founder-event path in the Bridge parent process
 * (the broker's reaction observation / a parent-authenticated ingress) — never
 * from any runner-writable DB or file. Ephemeral by design (①c): a restart
 * clears it, and the founder simply approves again.
 *
 * Single consumption with consume-AFTER-success ordering (②): `find` returns
 * only an unconsumed exact-tuple match; the broker marks it consumed only once
 * the (idempotent) publish succeeded. A replayed observation of an ALREADY
 * consumed approval (same tuple + same approverRef) is a structural no-op, so
 * a lingering founder ✅ can never authorize a second publish.
 */

import type { PublishApproval, PublishTuple } from "./types.js";
import { tupleKey } from "./types.js";

export class ApprovalRegistry {
	private readonly byTuple = new Map<string, PublishApproval>();
	/** `${tupleKey}\n${approverRef}` for every consumed approval — replay guard. */
	private readonly consumedRefs = new Set<string>();

	/**
	 * Register a founder approval. Idempotent:
	 *  - same tuple already registered and unconsumed → no-op (keeps the first);
	 *  - same tuple + same approverRef already CONSUMED → no-op (replay guard);
	 *  - otherwise → a fresh unconsumed approval (a founder may genuinely
	 *    re-approve after a failed round via a NEW approval message).
	 * Returns true when a new approval was recorded.
	 */
	register(
		tuple: PublishTuple,
		approverRef: string,
		now: () => Date = () => new Date(),
	): boolean {
		const key = tupleKey(tuple);
		if (this.consumedRefs.has(`${key}\n${approverRef}`)) return false;
		const existing = this.byTuple.get(key);
		if (existing && !existing.consumed) return false;
		this.byTuple.set(key, {
			...tuple,
			approverRef,
			approvedAt: now().toISOString(),
			consumed: false,
		});
		return true;
	}

	/** The unconsumed approval exactly matching the tuple, or null. */
	find(tuple: PublishTuple): PublishApproval | null {
		const a = this.byTuple.get(tupleKey(tuple));
		return a && !a.consumed ? a : null;
	}

	/** Mark the tuple's approval consumed (call ONLY after a successful
	 * execution). Returns false if there was nothing unconsumed to consume. */
	consume(tuple: PublishTuple, now: () => Date = () => new Date()): boolean {
		const key = tupleKey(tuple);
		const a = this.byTuple.get(key);
		if (!a || a.consumed) return false;
		a.consumed = true;
		a.consumedAt = now().toISOString();
		this.consumedRefs.add(`${key}\n${a.approverRef}`);
		return true;
	}
}
