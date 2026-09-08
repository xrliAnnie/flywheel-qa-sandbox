// FLY-2383: the receipt and census predicates the 529 lifecycle relies on.
//
// These are the only pieces of that lifecycle that are not exported by the raya
// harness, so they are reimplemented here against the same on-disk receipts.

/**
 * Pre-join. The voice bot must be in the target room and everyone present must
 * be on the allowlist — but the emitter has NOT joined yet, so requiring it here
 * would wait forever.
 */
export function voiceReadyCensus(census, options) {
	const allowed = new Set(options.allowedMemberIds);
	return (
		census?.botVoiceChannels?.[options.voiceBotId] === options.channelId &&
		Array.isArray(census.channelMemberIds) &&
		census.channelMemberIds.every((id) => allowed.has(id))
	);
}

/** Post-join. Now both identities must be present, and nobody else. */
export function bothPresentCensus(census, options) {
	const expected = new Set([options.voiceBotId, options.emitterBotId]);
	if (census?.botVoiceChannels?.[options.voiceBotId] !== options.channelId) {
		return false;
	}
	if (census?.botVoiceChannels?.[options.emitterBotId] !== options.channelId) {
		return false;
	}
	const members = census.channelMemberIds ?? [];
	return (
		members.length === expected.size && members.every((id) => expected.has(id))
	);
}

export function validDiscordReadyReceipt(receipt, bootStartedAtMs) {
	if (!receipt || typeof receipt !== "object") return false;
	const lastAnnouncedAt = Date.parse(receipt.lastAnnouncedAt);
	return Number.isFinite(lastAnnouncedAt) && lastAnnouncedAt >= bootStartedAtMs;
}

/**
 * A Live receipt only counts if it belongs to THIS boot: a stale receipt left
 * behind by a previous session would otherwise start the clock on a process that
 * never came up.
 */
export function validLiveReceipt(receipt, bootStartedAtMs) {
	if (!receipt || typeof receipt !== "object") return false;
	const lastLiveAt = Date.parse(receipt.lastLiveAt);
	return (
		typeof receipt.threadId === "string" &&
		receipt.threadId.length > 0 &&
		Number.isSafeInteger(receipt.processGeneration) &&
		receipt.processGeneration > 0 &&
		Number.isFinite(lastLiveAt) &&
		lastLiveAt >= bootStartedAtMs
	);
}
