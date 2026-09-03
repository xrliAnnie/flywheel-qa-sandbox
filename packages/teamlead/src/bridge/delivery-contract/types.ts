export const DELIVERY_FAMILIES = [
	"rework",
	"carrier",
	"turn_wake",
	"phase_wake",
	"mailbox",
	"launch",
	"land",
	"gate_holder",
] as const;

export type DeliveryFamily = (typeof DELIVERY_FAMILIES)[number];

export function deliveryRootId(input: {
	projectName: string;
	issueId: string;
	family: DeliveryFamily;
	physicalId: string;
}): string {
	return `${input.projectName}:${input.issueId}:${input.family}:${input.physicalId}`;
}

export const DELIVERY_STAGES = [
	"minted",
	"granted",
	"sent",
	"received",
	"consumed",
	"settled",
] as const;

export type DeliveryStage = (typeof DELIVERY_STAGES)[number];
export type DeliveryTerminal = "superseded" | "cancelled";

export interface WorkflowDeliveryAttemptRow {
	root_id: string;
	generation: number;
	attempt: number;
	attempt_id: string;
	family: DeliveryFamily;
	contract_ref_json: string;
	parent_attempt_id: string | null;
	minted_at: string;
	granted_at: string | null;
	sent_at: string | null;
	received_at: string | null;
	consumed_at: string | null;
	settlement_reason: string | null;
	superseded_by_attempt_id: string | null;
}

export interface DeliveryContractClassification {
	stage: DeliveryStage;
	stageEnteredAt: string;
	terminal: DeliveryTerminal | null;
	overdue: boolean;
	severe: boolean;
}
