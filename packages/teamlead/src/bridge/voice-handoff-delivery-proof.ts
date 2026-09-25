import type { ChatDeliveryEnvelopeV1 } from "flywheel-comm/discord-chat-ingest";
import type { VoiceHandoffRecord } from "./voice-handoff-store.js";

/** The agenda facts an envelope must carry for its record (FLY-2863): a brief
 * proves purpose and item; a bound founder turn proves item, turn, item state
 * and the answer key; an unbound handoff carries none. */
function agendaMatches(
	envelope: ChatDeliveryEnvelopeV1,
	record: VoiceHandoffRecord,
): boolean {
	const carried = envelope.voiceHandoff?.agenda;
	const expected = record.agenda;
	if (!expected) return carried === undefined;
	if (expected.kind === "brief")
		return (
			carried?.kind === "brief" &&
			carried.purpose === expected.purpose &&
			carried.itemKey === expected.itemKey
		);
	return (
		carried?.kind === "turn" &&
		carried.itemKey === expected.itemKey &&
		carried.turnId === expected.turnId &&
		carried.itemState === expected.itemState &&
		carried.answerKey === expected.answerKey
	);
}

/** Proof that a mailbox row is exactly this handoff's delivery. The mailbox is
 * first-writer-wins and its delivery id does not bind these fields, so every
 * one is compared before a reconciliation may call the handoff committed. */
export function voiceHandoffDeliveryMatches(
	envelope: ChatDeliveryEnvelopeV1,
	record: VoiceHandoffRecord,
): boolean {
	const handoff = envelope.voiceHandoff;
	const common =
		envelope.deliveryId === record.providerOperationId &&
		envelope.leadId === record.targetLeadId &&
		envelope.messageId === record.messageId &&
		envelope.origin === "voice" &&
		envelope.voiceSessionId === record.sessionId &&
		handoff?.handoffId === record.handoffId &&
		handoff.requestDigest === record.requestDigest &&
		handoff.targetLeadId === record.targetLeadId &&
		handoff.sessionGeneration === record.generation &&
		agendaMatches(envelope, record);
	if (!common) return false;
	if (record.requestKind === "agenda_brief")
		return (
			record.agenda?.kind === "brief" &&
			envelope.authorId === record.agenda.authorId &&
			envelope.text === record.agenda.text
		);
	return (
		envelope.authorId === record.founderUserId &&
		envelope.text === record.request.originalText &&
		handoff?.intentKind === record.request.intentKind &&
		handoff.transcriptId === record.request.transcriptId &&
		handoff.utteranceId === record.request.utteranceId
	);
}
