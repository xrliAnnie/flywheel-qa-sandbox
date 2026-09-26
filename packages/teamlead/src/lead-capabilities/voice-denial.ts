import type { OperationRequest, OperationResult } from "./broker.js";
import { getLeadCapability } from "./catalog.js";
export interface VoiceCapabilityDenials {
	leadName: string;
	/** Parent-owned durable mailbox transport; never a founder gate submission. */
	record(input: {
		requestId: string;
		operationId: string;
	}): Promise<string | undefined>;
}
export async function classifyVoiceCapabilityDenial(
	request: OperationRequest,
	allowed: ReadonlySet<string>,
	reporter: VoiceCapabilityDenials,
	assertCurrent: () => Promise<void>,
): Promise<OperationResult | undefined> {
	const operation = getLeadCapability(request.operationId);
	const base = {
		requestId: request.requestId,
		status: "rejected" as const,
		resourceRefs: [],
	};
	if (!operation) return { ...base, errorCode: "invalid" };
	if (operation.classification === "reserved") {
		let receipt: string | undefined;
		try {
			await assertCurrent();
			const observed = await reporter.record({
				requestId: request.requestId,
				operationId: request.operationId,
			});
			if (observed && /^lead-event:[1-9][0-9]*$/.test(observed))
				receipt = observed;
		} catch {
			/* No recording claim without the durable mailbox receipt. */
		}
		return {
			...base,
			errorCode: "founder_only_denied",
			data: {
				spokenText: receipt
					? `这个只能你本人做，我已经记给 ${reporter.leadName}`
					: "这个只能你本人做",
				...(receipt ? { leadReceiptId: receipt } : {}),
			},
		};
	}
	if (!allowed.has(request.operationId))
		return {
			...base,
			errorCode: "unavailable",
			data: { spokenText: "这场没开这个能力" },
		};
	return undefined;
}
