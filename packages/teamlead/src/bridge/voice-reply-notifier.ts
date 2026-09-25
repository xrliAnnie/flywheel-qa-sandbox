import type { VoiceHandoffResultEvent } from "flywheel-voice-core";
import type { VoiceHandoffStore } from "./voice-handoff-store.js";

export interface VoiceReplyWake {
	sessionId: string;
	generation: number;
	handoffId: string;
}

type VoiceReplySubscriber = (wake: VoiceReplyWake) => void;

export class VoiceReplyNotifier {
	private readonly subscribers = new Map<string, Set<VoiceReplySubscriber>>();

	subscribe(
		sessionId: string,
		generation: number,
		subscriber: VoiceReplySubscriber,
	): () => void {
		const key = this.subscriptionKey(sessionId, generation);
		const subscribers =
			this.subscribers.get(key) ?? new Set<VoiceReplySubscriber>();
		subscribers.add(subscriber);
		this.subscribers.set(key, subscribers);
		return () => {
			subscribers.delete(subscriber);
			if (subscribers.size === 0) this.subscribers.delete(key);
		};
	}

	notify(wake: VoiceReplyWake): void {
		const key = this.subscriptionKey(wake.sessionId, wake.generation);
		const subscribers = this.subscribers.get(key);
		if (!subscribers) return;
		for (const subscriber of subscribers) {
			try {
				subscriber(wake);
			} catch {
				subscribers.delete(subscriber);
			}
		}
		if (subscribers.size === 0) this.subscribers.delete(key);
	}

	private subscriptionKey(sessionId: string, generation: number): string {
		return `${sessionId}:${generation}`;
	}
}

export function notifyCommittedVoiceReply(
	notifier: VoiceReplyNotifier,
	store: Pick<VoiceHandoffStore, "get">,
	event: VoiceHandoffResultEvent,
): boolean {
	const handoff = store.get(event.handoffId);
	if (!handoff) return false;
	notifier.notify({
		sessionId: handoff.sessionId,
		generation: handoff.generation,
		handoffId: handoff.handoffId,
	});
	return true;
}
