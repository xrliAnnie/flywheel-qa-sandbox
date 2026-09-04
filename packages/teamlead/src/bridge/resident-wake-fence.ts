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
		return { ok: false, error: "resident_hold_expired" };
	}

	const result = await deliver();
	if (!result.ok) return result;
	if (
		residentHold &&
		!store.wakeResidentHold(executionId, residentHold.revision)
	) {
		return { ok: false, error: "resident_hold_expired" };
	}
	return { ok: true };
}
