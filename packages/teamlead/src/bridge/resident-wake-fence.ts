export type ResidentWakeResult = { ok: true } | { ok: false; error: string };

export interface ResidentWakeFenceStore {
	getResidentHold(
		executionId: string,
	): { state: string; revision: number } | undefined;
	wakeResidentHold(executionId: string, revision: number): boolean;
}

/**
 * Commit the resident ownership transition only after transport delivery.
 *
 * FLY-2921 C5 (FLY-2821) invariant: `woken` is NOT "undeliverable". An awake
 * actor is reachable, so the wake goes straight into its durable mailbox and
 * the transport result is the fence result — no hold CAS. Only `expired` /
 * `closed` mean the body has retired and the coordinator must replace it.
 * K04 must keep both halves if it rewrites this fence.
 */
export async function deliverResidentWake(
	store: ResidentWakeFenceStore,
	executionId: string,
	deliver: () => Promise<ResidentWakeResult>,
): Promise<ResidentWakeResult> {
	const residentHold = store.getResidentHold(executionId);
	if (
		residentHold &&
		(residentHold.state === "expired" || residentHold.state === "closed")
	) {
		return { ok: false, error: "resident_hold_expired" };
	}
	if (residentHold && residentHold.state !== "resident") {
		return deliver();
	}

	const result = await deliver();
	if (!result.ok) return result;
	if (
		residentHold &&
		!store.wakeResidentHold(executionId, residentHold.revision)
	) {
		return { ok: false, error: "resident_hold_wake_conflict" };
	}
	return { ok: true };
}
