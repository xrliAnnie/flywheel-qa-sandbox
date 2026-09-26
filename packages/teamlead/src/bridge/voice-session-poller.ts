import { isVoiceMirrorText, scrubTranscript } from "flywheel-voice-core";
import { getEncoding } from "js-tiktoken";
import type { StateStore } from "../StateStore.js";
import { DISCORD_API } from "./discord-utils.js";

export interface VoiceBackgroundSnapshot {
	sessions: Array<{
		executionId: string;
		issue: string;
		status: string;
		sessionRole?: string;
		lastError?: string;
		observedAt: string;
	}>;
	attention: Array<{
		kind: string;
		id: string;
		issue: string | null;
		observedAt: string;
	}>;
}

interface VoiceBackgroundEvent {
	key: string;
	text: string;
	deliveryClass: "tell" | "context";
	observedAt: string;
}

const voiceBackgroundEncoding = getEncoding("o200k_base");

function boundedBackgroundText(text: string): string {
	return [...scrubTranscript(text)].slice(0, 600).join("");
}

function voiceBackgroundEvents(
	snapshot: VoiceBackgroundSnapshot,
): VoiceBackgroundEvent[] {
	const events: VoiceBackgroundEvent[] = [];
	for (const session of snapshot.sessions) {
		const tell = session.status === "failed" || session.status === "blocked";
		const context =
			session.status === "running" ||
			session.status === "completed" ||
			session.sessionRole === "qa";
		if (!tell && !context) continue;
		const role =
			session.sessionRole && session.sessionRole !== "main"
				? ` ${session.sessionRole}`
				: "";
		const detail = tell && session.lastError ? `：${session.lastError}` : "";
		events.push({
			key: `session:${session.executionId}:${session.status}`,
			text: boundedBackgroundText(
				`${session.issue}${role} ${session.status}${detail}`,
			),
			deliveryClass: tell ? "tell" : "context",
			observedAt: session.observedAt,
		});
	}
	for (const attention of snapshot.attention) {
		events.push({
			key: `attention:${attention.kind}:${attention.id}`,
			text: boundedBackgroundText(
				`${attention.issue ?? "未绑定单号"} 等 founder 处理 ${attention.kind} ${attention.id}`,
			),
			deliveryClass: "tell",
			observedAt: attention.observedAt,
		});
	}
	return events;
}

export function voiceBackgroundBriefKeys(
	snapshot: VoiceBackgroundSnapshot,
): string[] {
	return voiceBackgroundEvents(snapshot).map(({ key }) => key);
}

export function recordVoiceBackgroundSnapshot(input: {
	store: StateStore;
	sessionId: string;
	leaseToken: string;
	backgroundEnabled: boolean;
	engineB: boolean;
	snapshot: VoiceBackgroundSnapshot;
	now: string;
	countTokens?: (text: string) => number;
}): { recorded: number; replayed: number; skipped: number } {
	const events = voiceBackgroundEvents(input.snapshot);
	if (!input.backgroundEnabled || !input.engineB) {
		return { recorded: 0, replayed: 0, skipped: events.length };
	}
	const result = { recorded: 0, replayed: 0, skipped: 0 };
	input.store.reconcileVoiceBackgroundTells({
		sessionId: input.sessionId,
		leaseToken: input.leaseToken,
		currentKeys: events
			.filter(({ deliveryClass }) => deliveryClass === "tell")
			.map(({ key }) => key),
		now: input.now,
	});
	const countTokens =
		input.countTokens ??
		((text: string) => voiceBackgroundEncoding.encode(text).length);
	for (const event of events) {
		const outcome = input.store.recordVoiceBackgroundEvent({
			sessionId: input.sessionId,
			leaseToken: input.leaseToken,
			...event,
			tokenCount: countTokens(event.text),
			now: input.now,
		});
		if (outcome === "recorded") result.recorded++;
		else if (outcome === "replayed") result.replayed++;
		else result.skipped++;
	}
	return result;
}

export interface VoiceDiscordMessage {
	id: string;
	author: { id: string };
	content: string;
	timestamp: string;
}

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
			isVoiceMirrorText(text)
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
