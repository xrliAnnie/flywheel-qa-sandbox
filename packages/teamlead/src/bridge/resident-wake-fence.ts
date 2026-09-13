export type ResidentWakeResult = { ok: true } | { ok: false; error: string };

export interface ResidentWakeFenceStore {
	getResidentHold(
		executionId: string,
	): { state: string; revision: number } | undefined;
	wakeResidentHold(executionId: string, revision: number): boolean;
}

/** Commit the resident ownership transition only after transport delivery. */
export async function deliverResidentWake(
	store: ResidentWakeFenceStore,
	executionId: string,
	deliver: () => Promise<ResidentWakeResult>,
): Promise<ResidentWakeResult> {
	const residentHold = store.getResidentHold(executionId);
	if (residentHold && residentHold.state !== "resident") {
		return {
			ok: false,
			error:
				residentHold.state === "expired" || residentHold.state === "closed"
					? "resident_hold_expired"
					: "resident_hold_already_woken",
		};
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
