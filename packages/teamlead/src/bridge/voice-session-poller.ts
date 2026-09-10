import { scrubTranscript } from "flywheel-voice-core";
import type { StateStore } from "../StateStore.js";
import { DISCORD_API } from "./discord-utils.js";

export interface VoiceDiscordMessage {
	id: string;
	author: { id: string };
	content: string;
	timestamp: string;
}

const VOICE_PREFIXES = ["📻", "🗣️", "🤖"];

export function recordVoiceOutboundDiscordPage(input: {
	store: StateStore;
	sessionId: string;
	leaseToken: string;
	channelId: string;
	leadBotUserId: string;
	rootMessageId: string;
	messages: VoiceDiscordMessage[];
	now: string;
}): boolean {
	const valid = input.messages.filter(
		(message) =>
			/^\d+$/.test(message.id) &&
			Number.isFinite(Date.parse(message.timestamp)),
	);
	if (valid.length === 0) return false;
	const cursor = valid.reduce(
		(highest, message) =>
			BigInt(message.id) > BigInt(highest) ? message.id : highest,
		valid[0]!.id,
	);
	const accepted = valid.flatMap((message) => {
		const text = message.content.trim();
		if (
			message.author.id !== input.leadBotUserId ||
			message.id === input.rootMessageId ||
			!text ||
			VOICE_PREFIXES.some((prefix) => text.startsWith(prefix))
		) {
			return [];
		}
		return [
			{
				messageId: message.id,
				authorId: message.author.id,
				text: scrubTranscript(text),
				observedAt: message.timestamp,
			},
		];
	});
	return input.store.recordVoiceOutboundPage({
		sessionId: input.sessionId,
		leaseToken: input.leaseToken,
		channelId: input.channelId,
		cursor,
		messages: accepted,
		now: input.now,
	});
}

export async function pollVoiceSessionOnce(input: {
	store: StateStore;
	sessionId: string;
	leaseToken: string;
	boundChannelIds: string[];
	outboundCursor: Record<string, string>;
	leadBotUserId: string;
	leadBotToken: string;
	rootMessageId: string;
	now?: () => string;
	fetchImpl?: typeof fetch;
}): Promise<void> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const now = input.now ?? (() => new Date().toISOString());
	for (const channelId of input.boundChannelIds) {
		let cursor = input.outboundCursor[channelId];
		if (!cursor) continue;
		for (let page = 0; page < 1_000; page++) {
			const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
			url.searchParams.set("after", cursor);
			url.searchParams.set("limit", "100");
			const response = await fetchImpl(url, {
				headers: { Authorization: `Bot ${input.leadBotToken}` },
			});
			if (!response.ok) throw new Error(`voice_poller_http_${response.status}`);
			const messages = (await response.json()) as VoiceDiscordMessage[];
			if (messages.length === 0) break;
			if (
				!recordVoiceOutboundDiscordPage({
					store: input.store,
					sessionId: input.sessionId,
					leaseToken: input.leaseToken,
					channelId,
					leadBotUserId: input.leadBotUserId,
					rootMessageId: input.rootMessageId,
					messages,
					now: now(),
				})
			) {
				return;
			}
			cursor = input.store.getVoiceSession(input.sessionId)?.outboundCursor[
				channelId
			]!;
			if (messages.length < 100) break;
		}
	}
}
