import { createHash } from "node:crypto";
import type {
	AgendaPorts,
	AgendaResult,
	DurableTranscriptSink,
	RoomIO,
	VoiceHandoffReceipt,
	VoiceHandoffRequest,
	VoiceUtterance,
	VoiceV1Session,
} from "flywheel-voice-core";
import {
	AgendaConductor,
	composeStartInstructions,
	SpokenExitGuard,
} from "flywheel-voice-core";
import type {
	BridgeVoiceClient,
	HeadphoneSessionBinding,
	VoiceHandoffResultsPage,
	VoiceReplyListener,
} from "./bridge-client.js";

/** FLY-2863: the voice mode a session runs (Bridge mode `rg` is headphone). */
export type HeadphoneVoiceMode = "headphone" | "meeting";

export interface HeadphoneUtteranceProjection {
	start(): void;
	close(): void;
}

export type HeadphoneSessionBridge = Pick<
	BridgeVoiceClient,
	| "getAgendaSnapshot"
	| "getAgendaState"
	| "putAgendaState"
	| "requestAgendaBrief"
	| "bindAgendaTurn"
	| "handoffToLead"
	| "listVoiceHandoffResults"
	| "subscribeReplies"
>;

export interface HeadphoneSessionOptions {
	engine: VoiceV1Session;
	room: Pick<RoomIO, "audibleTail" | "onBargeIn">;
	bridge: HeadphoneSessionBridge;
	binding: HeadphoneSessionBinding;
	founderUserId: string;
	transcriptSink: DurableTranscriptSink;
	baseInstructions: string;
	/** Default headphone; a meeting briefs only its own Lead's work. */
	mode?: HeadphoneVoiceMode;
	createUtteranceProjection?(
		session: Pick<VoiceV1Session, "onUtterance">,
	): HeadphoneUtteranceProjection;
	/** Quiet time before the Lead checks in (default 600000, founder-set). */
	checkinIntervalMs?: number;
	agendaPollIntervalMs?: number;
	leadReplyTimeoutMs?: number;
	record(event: Record<string, unknown>): void;
	textStatus?(message: string): void;
	onSpokenExit?(): Promise<void> | void;
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
		session.capabilities.turnCancelOrSuppress &&
		pcm(session.capabilities.audioIn) &&
		pcm(session.capabilities.audioOut)
	);
}

/** RoomIO utterance ids are opaque; the Bridge turn id is a safe digest. */
export function agendaTurnId(utteranceId: string): string {
	return `turn:${createHash("sha256").update(utteranceId).digest("hex").slice(0, 32)}`;
}

/** Bridge-backed agenda ports: every call carries the session lease. */
export function bridgeAgendaPorts(
	bridge: HeadphoneSessionBridge,
	binding: HeadphoneSessionBinding,
	record: (event: Record<string, unknown>) => void,
): AgendaPorts {
	return {
		fetchSnapshot: () => bridge.getAgendaSnapshot(binding),
		loadState: () => bridge.getAgendaState(binding),
		saveState: (input) => bridge.putAgendaState(binding, input),
		requestBrief: (input) => bridge.requestAgendaBrief(binding, input),
		bindTurn: ({ utteranceId, itemKey }) =>
			bridge.bindAgendaTurn(binding, {
				utteranceId,
				turnId: agendaTurnId(utteranceId),
				itemKey,
			}),
		async listResults(requestId, after) {
			const results: AgendaResult[] = [];
			let cursor = after;
			for (;;) {
				const page: VoiceHandoffResultsPage =
					await bridge.listVoiceHandoffResults(binding, requestId, cursor, 100);
				for (const event of page.events) {
					const base = {
						requestId,
						resultEventId: event.resultEventId,
						seq: event.seq,
					};
					if (event.resultKind === "agenda_say" && event.agenda?.kind === "say")
						results.push({
							...base,
							kind: "say",
							itemKey: event.agenda.itemKey,
							...(event.agenda.order ? { order: event.agenda.order } : {}),
							text: event.text,
						});
					else if (
						event.resultKind === "agenda_close" &&
						event.agenda?.kind === "close"
					)
						results.push({
							...base,
							kind: "close",
							itemKey: event.agenda.itemKey,
							disposition: event.agenda.disposition,
							...(event.agenda.evidence
								? { evidence: event.agenda.evidence }
								: {}),
							reason: event.agenda.reason,
							...(event.agenda.say !== undefined
								? { say: event.agenda.say }
								: {}),
						});
					else if (event.resultKind === "lead_reply")
						results.push({ ...base, kind: "lead_reply", text: event.text });
					else
						record({
							kind: "agenda_result_kind_ignored",
							requestId,
							resultKind: event.resultKind,
						});
				}
				if (page.nextCursor <= cursor || page.nextCursor >= page.highWatermark)
					return results;
				cursor = page.nextCursor;
			}
		},
	};
}

/**
 * Engine-independent voice mode composition (FLY-2796 + FLY-2863). Engine
 * adapters supply only the V1 session; the agenda, the durable transcript
 * and the spoken-exit rule stay identical for engines A and B. The inbox is
 * never read out: only the Lead's own words about the current agenda are.
 */
export class HeadphoneSession {
	readonly agenda: AgendaConductor;
	private readonly exit: SpokenExitGuard;
	private started = false;
	private closing = false;
	private unsubscribeUtterance?: () => void;
	private unsubscribeReplies?: () => void;
	private readonly utteranceProjection?: HeadphoneUtteranceProjection;
	private transcriptWork: Promise<void> = Promise.resolve();

	constructor(private readonly options: HeadphoneSessionOptions) {
		if (
			options.engine.sessionId !== options.binding.sessionId ||
			options.engine.generation !== options.binding.generation
		)
			throw new Error("headphone_v1_session_binding_mismatch");
		if (!supportsRequiredV1(options.engine))
			throw new Error("headphone_v1_capabilities_incomplete");
		this.utteranceProjection = options.createUtteranceProjection?.(
			options.engine,
		);
		this.agenda = new AgendaConductor({
			mode: options.mode ?? "headphone",
			sessionId: options.binding.sessionId,
			generation: options.binding.generation,
			engine: options.engine,
			room: options.room,
			ports: bridgeAgendaPorts(options.bridge, options.binding, options.record),
			record: options.record,
			...(options.textStatus ? { textStatus: options.textStatus } : {}),
			...(options.checkinIntervalMs === undefined
				? {}
				: { checkinIntervalMs: options.checkinIntervalMs }),
			...(options.agendaPollIntervalMs === undefined
				? {}
				: { pollIntervalMs: options.agendaPollIntervalMs }),
			...(options.leadReplyTimeoutMs === undefined
				? {}
				: { leadReplyTimeoutMs: options.leadReplyTimeoutMs }),
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
		this.unsubscribeUtterance = this.options.engine.onUtterance((utterance) =>
			this.observeUtterance(utterance),
		);
		try {
			this.utteranceProjection?.start();
			await this.options.engine.open(
				composeStartInstructions(this.options.baseInstructions, true),
			);
			// Reply wakes are hints; the conductor rereads durable results.
			this.unsubscribeReplies = this.options.bridge.subscribeReplies(
				this.options.binding,
				(wake) => {
					void this.agenda.notifyResults(wake.handoffId);
				},
			);
			await this.agenda.start();
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	/** A source may have changed (the conductor also polls on its own). */
	async notifyInboxChanged(): Promise<void> {
		if (this.closing) return;
		await this.agenda.notifySourceChanged();
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

	subscribeReplies(listener: VoiceReplyListener): () => void {
		return this.options.bridge.subscribeReplies(this.options.binding, listener);
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.unsubscribeUtterance?.();
		this.unsubscribeUtterance = undefined;
		this.unsubscribeReplies?.();
		this.unsubscribeReplies = undefined;
		try {
			this.utteranceProjection?.close();
		} catch (error) {
			this.options.record({
				kind: "headphone_utterance_projection_close_failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		await this.agenda.close();
		await this.options.engine.close();
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
}
