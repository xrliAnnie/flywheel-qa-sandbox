import { getLeadCapability } from "./catalog.js";
import type { OperationReceipt, OperationReceiptState } from "./receipts.js";

export interface VoiceCapabilityActionLedgerEntry {
	requestId: string;
	operationId: string;
	targetKey: string | null;
	state: OperationReceiptState;
	outcome: "succeeded" | "not_executed" | "unknown";
	errorCode: string | null;
}

/** Reads are excluded; dispatched writes remain unknown until terminal proof. */
export function voiceCapabilityActionLedger(
	receipts: readonly OperationReceipt[],
): readonly VoiceCapabilityActionLedgerEntry[] {
	return Object.freeze(
		receipts
			.filter(
				(receipt) =>
					getLeadCapability(receipt.operationId)?.classification === "write",
			)
			.map((receipt) =>
				Object.freeze({
					requestId: receipt.requestId,
					operationId: receipt.operationId,
					targetKey: receipt.targetKey,
					state: receipt.state,
					outcome:
						receipt.state === "succeeded"
							? ("succeeded" as const)
							: receipt.state === "rejected" || receipt.state === "prepared"
								? ("not_executed" as const)
								: ("unknown" as const),
					errorCode: receipt.errorCode,
				}),
			),
	);
}
