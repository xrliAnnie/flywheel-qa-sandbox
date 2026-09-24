import type {
	DurableTranscriptSink,
	RoomIO,
	VoiceHandoffReceipt,
	VoiceHandoffRequest,
	VoiceUtterance,
	VoiceV1Session,
} from "flywheel-voice-core";
import {
	composeStartInstructions,
	HeadphoneMode,
	InboxReader,
	SpokenExitGuard,
} from "flywheel-voice-core";
import type {
	BridgeVoiceClient,
	HeadphoneSessionBinding,
	VoiceHandoffResultsPage,
} from "./bridge-client.js";

export const DEFAULT_HEADPHONE_POLL_INTERVAL_MS = 1_000;

export interface HeadphoneSessionOptions {
	engine: VoiceV1Session;
	room: Pick<RoomIO, "audibleTail">;
	bridge: Pick<
		BridgeVoiceClient,
		| "listHeadphoneItems"
		| "claimHeadphoneItem"
		| "ackHeadphoneClaim"
		| "getHeadphoneSourceHealth"
		| "handoffToLead"
		| "listVoiceHandoffResults"
	>;
	binding: HeadphoneSessionBinding;
	founderUserId: string;
	transcriptSink: DurableTranscriptSink;
	baseInstructions: string;
	heartbeatIntervalMs?: number;
	pollIntervalMs?: number;
	record(event: Record<string, unknown>): void;
	textStatus?(message: string): void;
	onSpokenExit?(): Promise<void> | void;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

function supportsRequiredV1(session: VoiceV1Session): boolean {
	const pcm = (formats: VoiceV1Session["capabilities"]["audioIn"]) =>
		formats.some(
			(format) =>
				format.encoding === "pcm16" &&
				Number.isSafeInteger(format.sampleRateHz) &&
				Number.isSafeInteger(format.channels),
		);
	return (
		session.capabilities.onUtterance &&
		session.capabilities.verbatim &&
		session.capabilities.attribution &&
		pcm(session.capabilities.audioIn) &&
		pcm(session.capabilities.audioOut)
	);
}

/** Engine-independent headphone composition. Engine adapters supply only the
 * V1 session; Bridge inbox and durable-exit rules stay identical for A/B. */
export class HeadphoneSession {
	private readonly mode: HeadphoneMode;
	private readonly exit: SpokenExitGuard;
	private sourceHealthy = false;
	private started = false;
	private closing = false;
	private pollTimer?: ReturnType<typeof setTimeout>;
	private unsubscribeUtterance?: () => void;
	private transcriptWork: Promise<void> = Promise.resolve();

	constructor(private readonly options: HeadphoneSessionOptions) {
		if (
			options.engine.sessionId !== options.binding.sessionId ||
			options.engine.generation !== options.binding.generation
		)
			throw new Error("headphone_v1_session_binding_mismatch");
		if (!supportsRequiredV1(options.engine))
			throw new Error("headphone_v1_capabilities_incomplete");
		const inbox = new InboxReader({
			list: async () => {
				try {
					return await options.bridge.listHeadphoneItems(options.binding);
				} catch (error) {
					this.sourceHealthy = false;
					options.record({
						kind: "headphone_inbox_list_failed",
						message: error instanceof Error ? error.message : String(error),
					});
					return [];
				}
			},
			claim: (item) => options.bridge.claimHeadphoneItem(options.binding, item),
			ack: (claim, receipts) =>
				options.bridge.ackHeadphoneClaim(options.binding, claim, receipts),
			speak: (text, kind, speakOptions) =>
				options.engine.speak(text, kind, speakOptions),
			record: options.record,
			now: Date.now,
		});
		this.mode = new HeadphoneMode({
			engine: options.engine,
			inbox,
			room: options.room,
			...(options.heartbeatIntervalMs === undefined
				? {}
				: { heartbeatIntervalMs: options.heartbeatIntervalMs }),
			sourceHealthy: () => this.sourceHealthy,
			record: options.record,
			...(options.textStatus ? { textStatus: options.textStatus } : {}),
		});
		this.exit = new SpokenExitGuard(
			options.binding.sessionId,
			options.binding.generation,
			options.founderUserId,
		);
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("headphone_session_already_started");
		this.started = true;
		await this.refreshSourceHealth();
		this.unsubscribeUtterance = this.options.engine.onUtterance((utterance) =>
			this.observeUtterance(utterance),
		);
		try {
			await this.mode.start(
				composeStartInstructions(this.options.baseInstructions, true),
			);
			this.armPoll();
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async notifyInboxChanged(): Promise<void> {
		if (this.closing) return;
		await this.refreshSourceHealth();
		await this.mode.notifyInboxChanged();
	}

	handoffToLead(request: VoiceHandoffRequest): Promise<VoiceHandoffReceipt> {
		return this.options.bridge.handoffToLead(this.options.binding, request);
	}

	listHandoffResults(
		handoffId: string,
		after = 0,
		limit = 100,
	): Promise<VoiceHandoffResultsPage> {
		return this.options.bridge.listVoiceHandoffResults(
			this.options.binding,
			handoffId,
			after,
			limit,
		);
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		if (this.pollTimer)
			(this.options.clearTimeoutFn ?? clearTimeout)(this.pollTimer);
		this.pollTimer = undefined;
		this.unsubscribeUtterance?.();
		this.unsubscribeUtterance = undefined;
		await this.mode.close();
	}

	private observeUtterance(utterance: VoiceUtterance): void {
		if (!utterance.final || this.closing) return;
		this.transcriptWork = this.transcriptWork
			.then(async () => {
				if (utterance.role === "user") {
					try {
						const receipt =
							await this.options.transcriptSink.appendDurable(utterance);
						this.exit.observeFounderRequest(utterance, receipt);
					} catch (error) {
						this.options.record({
							kind: "headphone_transcript_durability_failed",
							message: error instanceof Error ? error.message : String(error),
						});
					}
					return;
				}
				if (!this.exit.observeAssistant(utterance)) return;
				await this.close();
				await this.options.onSpokenExit?.();
			})
			.catch((error) =>
				this.options.record({
					kind: "headphone_utterance_handler_failed",
					message: error instanceof Error ? error.message : String(error),
				}),
			);
	}

	private async refreshSourceHealth(): Promise<void> {
		try {
			this.sourceHealthy = (
				await this.options.bridge.getHeadphoneSourceHealth(this.options.binding)
			).healthy;
		} catch (error) {
			this.sourceHealthy = false;
			this.options.record({
				kind: "headphone_source_health_failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private armPoll(): void {
		if (this.closing) return;
		this.pollTimer = (this.options.setTimeoutFn ?? setTimeout)(() => {
			void this.notifyInboxChanged()
				.catch((error) =>
					this.options.record({
						kind: "headphone_poll_failed",
						message: error instanceof Error ? error.message : String(error),
					}),
				)
				.finally(() => this.armPoll());
		}, this.options.pollIntervalMs ?? DEFAULT_HEADPHONE_POLL_INTERVAL_MS);
		this.pollTimer.unref?.();
	}
}
