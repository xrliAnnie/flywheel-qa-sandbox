import type { LeadOperationContext, LeadOperationHandler } from "../broker.js";
import type { LeadTargetLockClient } from "../target-lock-client.js";

const denied = () => new Error("target_lock_reconcile_denied");

/** Resident-only recovery control. It deliberately bypasses target fencing. */
export function createTargetLockReconcileHandlers(
	client: LeadTargetLockClient,
): ReadonlyMap<string, LeadOperationHandler> {
	if (!client.reconcile) throw denied();
	const reconcile = client.reconcile.bind(client);
	const current = async (
		raw: Record<string, unknown>,
		context: LeadOperationContext,
	) => {
		if (
			client.actor !== "resident" ||
			context.signal.aborted ||
			typeof raw.targetKey !== "string" ||
			!raw.targetKey.startsWith(`${context.projectName}:`)
		)
			throw denied();
		await context.assertCurrent();
	};
	const execute: LeadOperationHandler["execute"] = async (raw, context) => {
		await current(raw, context);
		const result = await reconcile({
			operationId: "target_lock.reconcile",
			requestId: context.requestId,
			targetKey: raw.targetKey as string,
			lockedRequestId: raw.lockedRequestId as string,
			mode: raw.mode as "receipt" | "force_clear",
			...(raw.riskAcknowledgement === "可能被旧请求覆盖"
				? { riskAcknowledgement: raw.riskAcknowledgement }
				: {}),
			signal: context.signal,
		});
		await context.assertCurrent();
		return {
			status: "succeeded",
			providerRef: `target-lock:${raw.lockedRequestId as string}`,
			data: {
				status: result,
				targetKey: raw.targetKey,
				lockedRequestId: raw.lockedRequestId,
			},
		};
	};
	return new Map([
		[
			"target_lock.reconcile",
			{
				authorize: current,
				execute,
				reconcile: async (_receipt, raw, context) => execute(raw, context),
			},
		],
	]);
}
