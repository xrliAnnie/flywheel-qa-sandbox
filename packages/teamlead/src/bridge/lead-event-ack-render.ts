import type { LeadEventEnvelope } from "./lead-runtime.js";

export function appendLeadEventAckInstructions(
	content: string,
	envelope: LeadEventEnvelope,
): string {
	if (!envelope.ack) return content;
	const project = envelope.event.project_name ?? "unknown";
	const policyNote =
		envelope.ack.policy === "question_response"
			? "A durable reply to the question ACKs automatically; otherwise acknowledge after processing."
			: envelope.ack.policy === "founder_surface_confirmed"
				? "A confirmed founder surface ACKs automatically; otherwise acknowledge after processing."
				: "Acknowledge explicitly after processing this event.";
	return [
		content,
		"",
		`[ACK required · event_seq=${envelope.ack.eventSeq}] ${policyNote}`,
		`CLI step 1: flywheel-comm ack-event ${envelope.ack.eventSeq} --project ${project} --token-stdin`,
		`CLI step 2 (stdin, not shell history): ${envelope.ack.token}`,
		`Claude tool: flywheel_inbox_ack_event {event_seq:${envelope.ack.eventSeq}, project:${JSON.stringify(project)}, token:${JSON.stringify(envelope.ack.token)}}`,
	].join("\n");
}
