import type {
	SpeakReceipt,
	VoiceHandoffResultEvent,
} from "flywheel-voice-core";
import type { LiveLeadResultBinding } from "./live-lead-adapter.js";

export interface LiveReplyNotification {
	sessionId: string;
	generation: number;
	handoffId: string;
}

export interface LiveReplyResultsPage {
	events: VoiceHandoffResultEvent[];
	highWatermark: number;
	nextCursor: number;
}

export interface LiveReplyEventsOptions {
	sessionId: string;
	generation: number;
	subscribe(
		listener: (notification: LiveReplyNotification) => void,
	): () => void;
	listResults(
		handoffId: string,
		after: number,
		limit: number,
	): Promise<LiveReplyResultsPage>;
	applyResult(
		event: VoiceHandoffResultEvent,
		binding: LiveLeadResultBinding,
	): Promise<SpeakReceipt>;
	record(event: Record<string, unknown>): void;
	pageSize?: number;
}

interface ReplyState {
	binding: LiveLeadResultBinding;
	cursor: number;
	dirty: boolean;
	running?: Promise<void>;
}

/** Push-driven durable result consumer. Notifications carry no authority: each
 * wake rereads the canonical result page and advances a per-handoff cursor only
 * after the corresponding result has been applied successfully. */
export class LiveReplyEvents {
	private readonly states = new Map<string, ReplyState>();
	private readonly pageSize: number;
	private unsubscribe?: () => void;
	private started = false;
	private closed = false;

	constructor(private readonly options: LiveReplyEventsOptions) {
		this.pageSize = options.pageSize ?? 100;
		if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1)
			throw new Error("live_reply_page_size_invalid");
	}

	start(): void {
		if (this.started || this.closed)
			throw new Error("live_reply_already_started");
		this.started = true;
		this.unsubscribe = this.options.subscribe((notification) =>
			this.notify(notification),
		);
		for (const state of this.states.values()) this.wake(state);
	}

	register(binding: LiveLeadResultBinding): void {
		if (
			binding.sessionId !== this.options.sessionId ||
			binding.generation !== this.options.generation
		)
			throw new Error("live_reply_binding_mismatch");
		const prior = this.states.get(binding.handoffId);
		if (prior) {
			if (
				prior.binding.requestDigest !== binding.requestDigest ||
				prior.binding.targetLeadId !== binding.targetLeadId
			)
				throw new Error("live_reply_binding_conflict");
			return;
		}
		const state: ReplyState = { binding, cursor: 0, dirty: false };
		this.states.set(binding.handoffId, state);
		if (this.started && !this.closed) this.wake(state);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		await Promise.allSettled(
			[...this.states.values()].flatMap((state) =>
				state.running ? [state.running] : [],
			),
		);
	}

	private notify(notification: LiveReplyNotification): void {
		if (
			this.closed ||
			notification.sessionId !== this.options.sessionId ||
			notification.generation !== this.options.generation
		)
			return;
		const state = this.states.get(notification.handoffId);
		if (!state) {
			this.options.record({
				kind: "live_reply_notification_unbound",
				handoffId: notification.handoffId,
			});
			return;
		}
		this.wake(state);
	}

	private wake(state: ReplyState): void {
		state.dirty = true;
		if (state.running) return;
		state.running = this.drain(state)
			.catch((error) => {
				this.options.record({
					kind: "live_reply_drain_failed",
					handoffId: state.binding.handoffId,
					cursor: state.cursor,
					message: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				state.running = undefined;
				if (state.dirty && !this.closed) this.wake(state);
			});
	}

	private async drain(state: ReplyState): Promise<void> {
		while (state.dirty && !this.closed) {
			state.dirty = false;
			await this.drainAvailable(state);
		}
	}

	private async drainAvailable(state: ReplyState): Promise<void> {
		while (!this.closed) {
			const cursorBeforeRead = state.cursor;
			const page = await this.options.listResults(
				state.binding.handoffId,
				cursorBeforeRead,
				this.pageSize,
			);
			this.validatePage(page, state.binding.handoffId, cursorBeforeRead);
			for (const event of page.events) {
				const receipt = await this.options.applyResult(event, state.binding);
				if (receipt.outcome !== "completed") {
					throw new Error(
						`live_reply_speech_${receipt.outcome}:${receipt.reason}`,
					);
				}
				state.cursor = event.seq;
			}
			if (state.cursor >= page.highWatermark) return;
		}
	}

	private validatePage(
		page: LiveReplyResultsPage,
		handoffId: string,
		cursor: number,
	): void {
		if (
			!Array.isArray(page.events) ||
			!Number.isSafeInteger(page.highWatermark) ||
			!Number.isSafeInteger(page.nextCursor) ||
			page.highWatermark < page.nextCursor ||
			page.nextCursor < cursor
		)
			throw new Error("live_reply_page_invalid");
		let prior = cursor;
		for (const event of page.events) {
			if (
				event.handoffId !== handoffId ||
				!Number.isSafeInteger(event.seq) ||
				event.seq <= prior
			)
				throw new Error("live_reply_page_invalid");
			prior = event.seq;
		}
		if (
			(page.events.length === 0 && page.nextCursor !== cursor) ||
			(page.events.length > 0 && page.nextCursor !== prior) ||
			(page.events.length === 0 && page.highWatermark > cursor)
		)
			throw new Error("live_reply_page_invalid");
	}
}
