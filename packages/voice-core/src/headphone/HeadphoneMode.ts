import type { AudibleTailEstimate, RoomIO } from "../room-io.js";
import type { SpeakReceipt, VoiceV1Session } from "../types.js";
import type { InboxReader } from "./InboxReader.js";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 300_000;
export const HEARTBEAT_DEFAULT_NOTE = "工程默认，待她用过再定";

export interface HeadphoneModeOptions {
	engine: VoiceV1Session;
	inbox: InboxReader;
	room: Pick<RoomIO, "audibleTail">;
	heartbeatIntervalMs?: number;
	sourceHealthy?(): boolean;
	record(event: Record<string, unknown>): void;
	textStatus?(message: string): void;
	now?: () => number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

export class HeadphoneMode {
	private readonly heartbeatIntervalMs: number;
	private readonly now: () => number;
	private work: Promise<unknown> = Promise.resolve();
	private busy = false;
	private closing = false;
	private lastActivity: number;
	private heartbeatTimer?: ReturnType<typeof setTimeout>;
	private unsubscribeUtterance?: () => void;

	constructor(private readonly options: HeadphoneModeOptions) {
		this.heartbeatIntervalMs =
			options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		if (
			!Number.isSafeInteger(this.heartbeatIntervalMs) ||
			this.heartbeatIntervalMs < 1 ||
			this.heartbeatIntervalMs > 2_147_483_647
		)
			throw new Error(
				"headphone.heartbeatIntervalMs must be a positive safe integer no greater than 2147483647",
			);
		this.now = options.now ?? Date.now;
		this.lastActivity = this.now();
	}

	async start(initialSessionContext: string): Promise<void> {
		if (this.closing) throw new Error("headphone_mode_closing");
		await this.options.engine.open(initialSessionContext);
		this.unsubscribeUtterance = this.options.engine.onUtterance((utterance) => {
			if (utterance.final) this.noteActivity();
		});
		await this.readInbox("entry");
		this.armHeartbeat();
	}

	notifyInboxChanged(): Promise<void> {
		return this.readInbox("new_message");
	}

	/** Public deterministic clock seam; the real timer calls the same method. */
	checkHeartbeat(): Promise<void> {
		return this.enqueue(async () => {
			if (
				this.closing ||
				this.now() - this.lastActivity < this.heartbeatIntervalMs
			)
				return;
			const tail: AudibleTailEstimate = this.options.room.audibleTail();
			if (!tail.drained) return;
			const healthy = this.options.sourceHealthy?.() ?? true;
			const text = healthy
				? "我还在，有新消息会告诉你。"
				: "我还在，但消息更新暂时连不上。";
			let receipt: SpeakReceipt;
			try {
				receipt = await this.options.engine.speak(text, "heartbeat", {
					pendingKey: `heartbeat:${Math.floor(this.now() / this.heartbeatIntervalMs)}`,
					verification: "none",
				});
			} catch (error) {
				this.voiceUnavailable(error);
				return;
			}
			if (receipt.outcome === "completed") {
				this.noteActivity();
				this.options.record({
					kind: "headphone_heartbeat_submitted",
					transport: receipt.transport,
					sourceHealthy: healthy,
				});
			} else {
				this.voiceUnavailable(receipt.reason);
			}
		}).finally(() => {
			if (!this.closing) this.armHeartbeat();
		});
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.clearHeartbeat();
		this.unsubscribeUtterance?.();
		this.unsubscribeUtterance = undefined;
		this.options.inbox.stop();
		await this.work.catch(() => undefined);
		await this.options.engine.close();
	}

	private readInbox(reason: "entry" | "new_message"): Promise<void> {
		return this.enqueue(async () => {
			const acked = await this.options.inbox.poll();
			if (acked > 0) this.noteActivity();
			this.options.record({ kind: "headphone_inbox_polled", reason, acked });
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.work.then(async () => {
			if (this.closing) return undefined as T;
			this.busy = true;
			try {
				return await task();
			} finally {
				this.busy = false;
			}
		});
		this.work = result.catch(() => undefined);
		return result;
	}

	private armHeartbeat(): void {
		this.clearHeartbeat();
		if (this.closing || this.busy) return;
		const delay = Math.max(
			1,
			this.heartbeatIntervalMs - (this.now() - this.lastActivity),
		);
		this.heartbeatTimer = (this.options.setTimeoutFn ?? setTimeout)(
			() => void this.checkHeartbeat(),
			delay,
		);
		this.heartbeatTimer.unref?.();
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer)
			(this.options.clearTimeoutFn ?? clearTimeout)(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private noteActivity(): void {
		this.lastActivity = this.now();
	}

	private voiceUnavailable(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.options.record({ kind: "headphone_voice_unavailable", message });
		this.options.textStatus?.("语音不可用，请看文字状态。");
	}
}
