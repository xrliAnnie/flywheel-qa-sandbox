import type { HookPayload } from "./hook-payload.js";

export type LeadEventAckPolicy =
	| "question_response"
	| "explicit_receipt"
	| "founder_surface_confirmed";

const DEFAULT_ACK_TYPES = new Set([
	"gate_question",
	"runner_question",
	"runner_park_notice",
	"gate_timed_out",
	"session_failed",
]);

export function deliveryAckEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.FLYWHEEL_DELIVERY_ACK !== "0";
}

function configuredAckTypes(env: NodeJS.ProcessEnv): Set<string> {
	const raw = env.FLYWHEEL_DELIVERY_ACK_TYPES?.trim();
	if (!raw) return DEFAULT_ACK_TYPES;
	return new Set(
		raw
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

export function ackPolicyForLeadEvent(
	eventType: string,
	payload: HookPayload,
	env: NodeJS.ProcessEnv = process.env,
): LeadEventAckPolicy | null {
	if (!deliveryAckEnabled(env) || !configuredAckTypes(env).has(eventType)) {
		return null;
	}
	if (eventType === "runner_question") return "question_response";
	if (eventType === "gate_question") {
		return payload.checkpoint === "approve_to_ship" ||
			payload.checkpoint === "brainstorm"
			? "founder_surface_confirmed"
			: "question_response";
	}
	return "explicit_receipt";
}

export interface LeadEventRoutingSnapshot {
	projectName?: string;
	commDbPath?: string;
	questionId?: string;
	issueId?: string;
	threadId?: string;
	ownerLeadId: string;
}

export function routingSnapshotForLeadEvent(
	leadId: string,
	payload: HookPayload,
): LeadEventRoutingSnapshot {
	return {
		projectName: payload.project_name,
		commDbPath: payload.comm_db_path,
		questionId: payload.question_id,
		issueId: payload.issue_id,
		threadId: payload.chat_thread_id,
		ownerLeadId: leadId,
	};
}
