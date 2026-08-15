export type LandLinearArbitrationDecision =
	| { ok: true; degraded?: "linear_unreachable" }
	| { ok: false; reason: "canceled_fresh_linear" };

/**
 * Bound the advisory Linear read used before local land cleanup. A durable
 * completed observation is enough to authorize cleanup when the fresh SaaS
 * read fails; otherwise cleanup remains authorized in degraded mode so the
 * external dependency cannot strand local resources.
 */
export async function arbitrateFreshLinearState(input: {
	persistedStateType?: string;
	readFreshStateType: () => Promise<string | undefined>;
	timeoutMs?: number;
}): Promise<LandLinearArbitrationDecision> {
	const timeoutMs = input.timeoutMs ?? 10_000;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const freshRead = Promise.resolve().then(input.readFreshStateType);
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(
			() => reject(new Error("linear_lookup_timeout")),
			timeoutMs,
		);
	});

	try {
		const stateType = await Promise.race([freshRead, deadline]);
		if (stateType === "canceled") {
			return { ok: false, reason: "canceled_fresh_linear" };
		}
		return { ok: true };
	} catch {
		return { ok: true, degraded: "linear_unreachable" };
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
