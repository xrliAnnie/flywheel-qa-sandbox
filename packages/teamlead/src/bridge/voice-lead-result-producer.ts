import { createHash } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import { parseChatDeliveryEnvelope } from "flywheel-comm/discord-chat-ingest";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import type { VoiceHandoffResultEvent } from "flywheel-voice-core";

export { resolveVoiceReplyDeliveryContext } from "../lead-backends/codex/voice-reply-delivery-context.js";

import type { VoiceHandoffStore } from "./voice-handoff-store.js";

export interface VoiceLeadResultProducerOptions {
	commDbPathForProject(projectName: string): string;
	store: Pick<VoiceHandoffStore, "get" | "appendResult">;
	onCommitted?(event: VoiceHandoffResultEvent): void;
}

export interface ProduceVoiceLeadResultInput {
	projectName: string;
	sourceLeadId: string;
	sourceDeliveryId: string;
	operationId: string;
	text: string;
}

/** Converts one authenticated Lead outbound operation into the canonical,
 * replayable voice result. Matching is exclusively by the voice envelope. */
export class VoiceLeadResultProducer {
	constructor(private readonly options: VoiceLeadResultProducerOptions) {}

	produce(input: ProduceVoiceLeadResultInput): VoiceHandoffResultEvent {
		if (
			!input.projectName ||
			!input.sourceLeadId ||
			!input.sourceDeliveryId ||
			!input.operationId ||
			!input.text
		)
			throw new Error("voice_lead_result_input_invalid");
		const commDbPath = this.options.commDbPathForProject(input.projectName);
		const sourceDb = CommDB.openReadonly(commDbPath);
		let source: ReturnType<CommDB["getMessageById"]>;
		try {
			source = sourceDb.getMessageById(input.sourceDeliveryId);
		} finally {
			sourceDb.close();
		}
		if (!source) throw new Error("voice_lead_result_source_missing");
		let envelope: ReturnType<typeof parseChatDeliveryEnvelope>;
		try {
			envelope = parseChatDeliveryEnvelope(source.content);
		} catch {
			throw new Error("voice_lead_result_source_invalid");
		}
		const metadata = envelope.voiceHandoff;
		const record = metadata
			? this.options.store.get(metadata.handoffId)
			: undefined;
		if (
			envelope.origin !== "voice" ||
			!metadata ||
			!record ||
			record.state !== "committed" ||
			record.projectName !== input.projectName ||
			record.providerOperationId !== input.sourceDeliveryId ||
			envelope.deliveryId !== record.providerOperationId ||
			envelope.voiceSessionId !== record.sessionId ||
			metadata.handoffId !== record.handoffId ||
			metadata.requestDigest !== record.requestDigest ||
			metadata.targetLeadId !== record.targetLeadId ||
			metadata.sessionGeneration !== record.generation ||
			input.sourceLeadId !== record.targetLeadId
		)
			throw new Error("voice_lead_result_binding_mismatch");

		const operationDigest = createHash("sha256")
			.update(input.operationId)
			.digest("hex");
		const sourceDeliveryId = `voice-result-response:${record.handoffId}:${operationDigest}`;
		const resultEventId = `voice-result:${record.handoffId}:${operationDigest}`;
		const queue = new MailboxQueue(commDbPath);
		try {
			queue.enqueue({
				id: sourceDeliveryId,
				deliveryId: sourceDeliveryId,
				fromAgent: record.targetLeadId,
				toAgent: record.founderUserId,
				recipientKind: "bridge",
				sourceKind: "voice",
				sourceRef: resultEventId,
				type: "response",
				msgClass: "protocol",
				content: input.text,
				refId: record.providerOperationId,
				createdAt: source.created_at,
				carrier: "external",
				senderRef: encodeSenderRef(),
			});
		} finally {
			queue.close();
		}

		const responseDb = CommDB.openReadonly(commDbPath);
		let response: ReturnType<CommDB["getMessageById"]>;
		try {
			response = responseDb.getMessageById(sourceDeliveryId);
		} finally {
			responseDb.close();
		}
		if (
			!response ||
			response.from_agent !== record.targetLeadId ||
			response.to_agent !== record.founderUserId ||
			response.parent_id !== record.providerOperationId ||
			response.content !== input.text
		)
			throw new Error("voice_lead_result_response_invalid");
		const event = this.options.store.appendResult({
			handoffId: record.handoffId,
			resultEventId,
			requestDigest: record.requestDigest,
			sourceLeadId: record.targetLeadId,
			sourceDeliveryId,
			resultKind: "lead_reply",
			text: input.text,
			createdAt: response.created_at,
		});
		this.options.onCommitted?.(event);
		return event;
	}
}
