export type HoldAuthoritativeStore = "state" | "comm";
export type HoldScope = "run" | "delivery" | "run-derived";

const DELIVERY_UNDELIVERABLE_DECISIONS = Object.freeze([
	"reroute_to",
	"cancel",
] as const);
const PHASE_WAKE_UNDELIVERABLE_DECISIONS = Object.freeze([
	"reroute_to",
] as const);

export function deliveryUndeliverableRequiredDecisions(
	family: string,
): readonly ("reroute_to" | "cancel")[] {
	return family === "phase_wake"
		? PHASE_WAKE_UNDELIVERABLE_DECISIONS
		: DELIVERY_UNDELIVERABLE_DECISIONS;
}

export interface HoldShapeProbe {
	eventKind: string;
	reason?: string | null;
	operationId?: string | null;
	deliveryState?: string | null;
}

export interface HoldShapeDescriptor {
	id: string;
	authoritativeStore: HoldAuthoritativeStore;
	scope: HoldScope;
	resumeAction: string;
	requiredDecision?: readonly string[];
	positiveProbe: HoldShapeProbe;
	detect(probe: HoldShapeProbe): boolean;
}

function shape(input: {
	id: string;
	authoritativeStore?: HoldAuthoritativeStore;
	scope?: HoldScope;
	eventKind: string;
	reasonPrefix?: string;
	operation?: "required" | "absent";
	deliveryState?: string;
	resumeAction: string;
	requiredDecision?: readonly string[];
}): HoldShapeDescriptor {
	const positiveProbe: HoldShapeProbe = {
		eventKind: input.eventKind,
		...(input.reasonPrefix ? { reason: input.reasonPrefix } : {}),
		...(input.operation === "required" ? { operationId: "operation-1" } : {}),
		...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
	};
	return Object.freeze({
		id: input.id,
		authoritativeStore: input.authoritativeStore ?? "state",
		scope: input.scope ?? "run",
		resumeAction: input.resumeAction,
		...(input.requiredDecision
			? { requiredDecision: Object.freeze([...input.requiredDecision]) }
			: {}),
		positiveProbe,
		detect(probe: HoldShapeProbe): boolean {
			if (probe.eventKind !== input.eventKind) return false;
			if (
				input.reasonPrefix !== undefined &&
				!probe.reason?.startsWith(input.reasonPrefix)
			) {
				return false;
			}
			if (input.operation === "required" && !probe.operationId) return false;
			if (input.operation === "absent" && probe.operationId) return false;
			if (
				input.deliveryState !== undefined &&
				probe.deliveryState !== input.deliveryState
			) {
				return false;
			}
			return true;
		},
	});
}

export const HOLD_SHAPE_REGISTRY = Object.freeze([
	shape({
		id: "rework_activation_stalled_held",
		eventKind: "rework_activation_stalled_held",
		resumeAction: "resume_receipt_deadlock",
	}),
	shape({
		id: "rework_pane_loss_handoff",
		eventKind: "rework_pane_loss_handoff",
		resumeAction: "retrigger_replacement",
	}),
	shape({
		id: "rework_retry_exhausted",
		eventKind: "rework_retry_exhausted",
		resumeAction: "resume_rework",
	}),
	shape({
		id: "unlaunched_admission_rolled_back",
		eventKind: "unlaunched_admission_rolled_back",
		resumeAction: "resume_unlaunched",
	}),
	shape({
		id: "unlaunched_admission_held",
		eventKind: "unlaunched_admission_held",
		resumeAction: "resume_unlaunched",
	}),
	shape({
		id: "completion_receipt_missing",
		eventKind: "completion_receipt_missing",
		resumeAction: "reconstruct_completion",
	}),
	shape({
		id: "retry_limit_escalated",
		eventKind: "retry_limit_escalated",
		resumeAction: "resume_retry_limit",
		requiredDecision: ["retry", "terminate"],
	}),
	shape({
		id: "environment_failure_escalated",
		eventKind: "environment_failure_escalated",
		resumeAction: "resume_retry_limit",
		requiredDecision: ["retry", "terminate"],
	}),
	shape({
		id: "loop_limit_escalated",
		eventKind: "loop_limit_escalated",
		resumeAction: "resume_loop_limit",
	}),
	shape({
		id: "rework_suppressed_idle_spin",
		eventKind: "rework_suppressed_idle_spin",
		resumeAction: "resume_idle_spin",
		requiredDecision: ["accept_current_pass", "force_rework"],
	}),
	shape({
		id: "workflow_gate_origin_preflight_terminal",
		eventKind: "workflow_gate_origin_preflight_terminal",
		resumeAction: "resume_gate_origin_preflight",
	}),
	shape({
		id: "land_held_with_operation",
		eventKind: "land_held",
		operation: "required",
		resumeAction: "resume_land_operation",
	}),
	shape({
		id: "land_held_without_operation",
		eventKind: "land_held",
		operation: "absent",
		resumeAction: "resume_land_without_operation",
		requiredDecision: ["retry", "terminate"],
	}),
	shape({
		id: "run_held_by_operator",
		eventKind: "run_held_by_operator",
		resumeAction: "resume_run_held_by_operator",
	}),
	shape({
		id: "carrier_run_inactive",
		scope: "run-derived",
		eventKind: "carrier_delivery_held",
		reasonPrefix: "run_inactive:",
		resumeAction: "revive_carrier",
	}),
	shape({
		id: "carrier_needs_lead",
		scope: "delivery",
		eventKind: "carrier_delivery_exhausted",
		deliveryState: "needs_lead",
		resumeAction: "redrive_carrier",
	}),
	shape({
		id: "mailbox_inflight_slots_exhausted",
		authoritativeStore: "comm",
		eventKind: "mailbox_inflight_slots_exhausted",
		resumeAction: "reconcile_mailbox_leases",
	}),
	shape({
		id: "three_stage_turn_stuck",
		authoritativeStore: "comm",
		eventKind: "three_stage_turn_stuck",
		resumeAction: "resume_turn_handoff",
	}),
	shape({
		id: "delivery_undeliverable_no_recipient",
		scope: "delivery",
		eventKind: "delivery_reroute_operator_required",
		resumeAction: "resume_undeliverable",
		requiredDecision: DELIVERY_UNDELIVERABLE_DECISIONS,
	}),
] satisfies readonly HoldShapeDescriptor[]);

const HOLD_SHAPES_BY_ID = new Map(
	HOLD_SHAPE_REGISTRY.map((entry) => [entry.id, entry]),
);

export function getHoldShape(id: string): HoldShapeDescriptor | undefined {
	return HOLD_SHAPES_BY_ID.get(id);
}

export function detectHoldShape(
	probe: HoldShapeProbe,
): HoldShapeDescriptor | undefined {
	return HOLD_SHAPE_REGISTRY.find((entry) => entry.detect(probe));
}
