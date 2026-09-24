const HANDOFF_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RETRY_SUFFIX = /#r[0-9]+$/u;

export function isVoiceReplyDeliveryContext(
	leadId: string,
	deliveryContext: string,
): boolean {
	const prefix = `chat:${leadId}:voice-handoff:`;
	return (
		deliveryContext.startsWith(prefix) &&
		HANDOFF_ID.test(deliveryContext.slice(prefix.length))
	);
}

/** Resolve a local journal membership to the one carrier-neutral voice delivery.
 * Ordinary non-voice entries remain undefined and retain their current behavior. */
export function resolveVoiceReplyDeliveryContext(
	leadId: string,
	memberIds: readonly string[],
): string | undefined {
	const normalized = memberIds.map((memberId) =>
		memberId.replace(RETRY_SUFFIX, ""),
	);
	const voice = normalized.filter((memberId) =>
		isVoiceReplyDeliveryContext(leadId, memberId),
	);
	if (voice.length === 0) return undefined;
	if (voice.length > 1)
		throw new Error("voice_reply_context_multiple_voice_members");
	if (normalized.length !== 1)
		throw new Error("voice_reply_context_multi_member");
	return voice[0];
}
