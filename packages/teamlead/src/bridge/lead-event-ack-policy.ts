import type { HookPayload } from "./hook-payload.js";
import { legacyDeliveryWatchdogsEnabled } from "./legacy-delivery-watchdog-policy.js";

export type LeadEventAckPolicy =
	| "question_response"
	| "explicit_receipt"
	| "founder_surface_confirmed";

export function deliveryAckEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return legacyDeliveryWatchdogsEnabled(env);
}

/** Reverse feature flag for the superseded scanner/redelivery cohort. */
export function legacyLeadWatchdogEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return legacyDeliveryWatchdogsEnabled(env);
}

export function ackPolicyForLeadEvent(
	eventType: string,
	payload: HookPayload,
	env: NodeJS.ProcessEnv = process.env,
): LeadEventAckPolicy | null {
	// FLY-1373 cutover: legacy=1 revives the scanner for already-persisted ACK
	// rows only. New events always use the durable inbox receipt and never mint a
	// second acknowledgement protocol.
	void eventType;
	void payload;
	void env;
	return null;
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
