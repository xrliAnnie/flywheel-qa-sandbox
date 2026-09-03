import {
	RECEIPT_CONSUMPTION_DEADLINE_FAMILIES,
	SEVERE_MULTIPLIER,
	STAGE_DEADLINES_MS,
} from "./policy.js";
import type {
	DeliveryContractClassification,
	DeliveryStage,
	WorkflowDeliveryAttemptRow,
} from "./types.js";

export function classifyDeliveryAttempt(
	attempt: WorkflowDeliveryAttemptRow,
	now: string,
): DeliveryContractClassification {
	const stage: DeliveryStage = attempt.settlement_reason
		? "settled"
		: attempt.consumed_at
			? "consumed"
			: attempt.received_at
				? "received"
				: attempt.sent_at
					? "sent"
					: attempt.granted_at
						? "granted"
						: "minted";
	const stageEnteredAt =
		stage === "settled"
			? (attempt.consumed_at ?? attempt.received_at ?? attempt.minted_at)
			: stage === "consumed"
				? attempt.consumed_at!
				: stage === "received"
					? attempt.received_at!
					: stage === "sent"
						? attempt.sent_at!
						: stage === "granted"
							? attempt.granted_at!
							: attempt.minted_at;
	const terminal = attempt.superseded_by_attempt_id
		? ("superseded" as const)
		: null;
	const deadline =
		stage === "received" &&
		!RECEIPT_CONSUMPTION_DEADLINE_FAMILIES.has(attempt.family)
			? undefined
			: STAGE_DEADLINES_MS[stage as keyof typeof STAGE_DEADLINES_MS];
	const age = Date.parse(now) - Date.parse(stageEnteredAt);
	return {
		stage,
		stageEnteredAt,
		terminal,
		overdue: terminal === null && deadline !== undefined && age >= deadline,
		severe:
			terminal === null &&
			deadline !== undefined &&
			age >= deadline * SEVERE_MULTIPLIER,
	};
}
