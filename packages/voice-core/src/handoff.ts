import { createHash } from "node:crypto";
import type { TranscriptDurabilityReceipt } from "./types.js";

export const VOICE_HANDOFF_INTENT_KINDS = [
	"query",
	"judgment",
	"action",
] as const;

export type VoiceHandoffIntentKind =
	(typeof VOICE_HANDOFF_INTENT_KINDS)[number];

export function voiceHandoffIdempotencyKey(input: {
	transcriptId: string;
	targetLeadId: string;
	intentKind: VoiceHandoffIntentKind;
}): string {
	return `${input.transcriptId}:${input.targetLeadId}:${input.intentKind}`;
}

export interface VoiceHandoffAuthorityBinding {
	projectName: string;
	founderUserId: string;
	targetLeadId: string;
	sessionId: string;
	generation: number;
	transcriptId: string;
	transcriptDigest: string;
}

export interface VoiceHandoffRequest {
	handoffId: string;
	idempotencyKey: string;
	requestDigest: string;
	intentKind: VoiceHandoffIntentKind;
	payload: {
		targetLeadId: string;
		text: string;
		quotes: readonly string[];
	};
	sessionId: string;
	generation: number;
	transcriptId: string;
	utteranceId: string;
	originalText: string;
	authorityBinding: VoiceHandoffAuthorityBinding;
	transcriptDurabilityReceipt: TranscriptDurabilityReceipt;
	delegationBinding?: string;
}

export type VoiceHandoffState =
	| "authorized"
	| "dispatching"
	| "committed"
	| "rejected"
	| "ambiguous"
	| "needs_human";

export interface VoiceHandoffReceipt {
	handoffId: string;
	requestDigest: string;
	state: VoiceHandoffState;
	providerOperationId: string | null;
}

export type VoiceHandoffResultKind =
	| "lead_reply"
	| "progress"
	| "completed"
	| "failed";

export interface VoiceHandoffResultEvent {
	resultEventId: string;
	seq: number;
	handoffId: string;
	requestDigest: string;
	sourceLeadId: string;
	sourceDeliveryId: string;
	resultKind: VoiceHandoffResultKind;
	text: string;
	createdAt: string;
}

export function voiceHandoffRequestDigest(
	request: Omit<VoiceHandoffRequest, "requestDigest">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				handoffId: request.handoffId,
				idempotencyKey: request.idempotencyKey,
				intentKind: request.intentKind,
				payload: request.payload,
				sessionId: request.sessionId,
				generation: request.generation,
				transcriptId: request.transcriptId,
				utteranceId: request.utteranceId,
				originalText: request.originalText,
				authorityBinding: request.authorityBinding,
				transcriptDurabilityReceipt: request.transcriptDurabilityReceipt,
				delegationBinding: request.delegationBinding ?? null,
			}),
		)
		.digest("hex");
}
