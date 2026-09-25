import type {
	DurableTranscriptSink,
	RoomIO,
	SpeakReceipt,
	VoiceHandoffReceipt,
	VoiceHandoffRequest,
	VoiceHandoffResultEvent,
	VoiceV1Session,
} from "flywheel-voice-core";
import {
	HeadphoneSession,
	type HeadphoneSessionBinding,
	type HeadphoneSessionBridge,
	type HeadphoneVoiceMode,
} from "flywheel-voice-headphone";
import {
	type CaptionSink,
	LiveCaptionProjection,
} from "./live-caption-projection.js";
import type {
	AgendaTurnRouter,
	LiveLeadResultBinding,
} from "./live-lead-adapter.js";
import { LiveReplyEvents } from "./live-reply-events.js";

export interface EngineAAdapter extends VoiceV1Session {
	applyLeadResult(
		event: VoiceHandoffResultEvent,
		binding: LiveLeadResultBinding,
	): Promise<SpeakReceipt>;
	/** Resolves when the founder is not mid-turn (see LiveLeadAdapter). */
	whenFounderTurnSettled(): Promise<void>;
}

export interface EngineACompositionCallbacks {
	registerHandoff(binding: LiveLeadResultBinding): void;
	submitHandoff(
		request: VoiceHandoffRequest,
		opts?: { signal?: AbortSignal },
	): Promise<VoiceHandoffReceipt>;
	/** FLY-2863 R-T1: the agenda owns turns that start on a live item. */
	agendaTurns: AgendaTurnRouter;
}

export interface EngineAHeadphoneSessionOptions {
	binding: HeadphoneSessionBinding;
	founderUserId: string;
	bridge: HeadphoneSessionBridge;
	room: Pick<RoomIO, "audibleTail" | "onBargeIn">;
	/** Bridge mode `rg` is headphone; a meeting briefs only its own Lead. */
	mode: HeadphoneVoiceMode;
	checkinIntervalMs?: number;
	transcriptSink: DurableTranscriptSink;
	baseInstructions: string;
	createEngine(callbacks: EngineACompositionCallbacks): EngineAAdapter;
	captionSink: CaptionSink;
	record(event: Record<string, unknown>): void;
	textStatus?(message: string): void;
	onSpokenExit?(): Promise<void> | void;
}

export interface EngineAHeadphoneSession {
	start(): Promise<void>;
	close(): Promise<void>;
	speak(
		text: string,
		pendingKey: string,
	): Promise<"confirmed" | "unconfirmed" | "failed">;
}

/** Production Engine A seam. Lead reply payloads are always reread from the
 * durable results endpoint; the subscription is only a wakeup and there is no
 * polling fallback on disconnect. */
export function createEngineAHeadphoneSession(
	options: EngineAHeadphoneSessionOptions,
): EngineAHeadphoneSession {
	let replies: LiveReplyEvents | undefined;
	let headphone: HeadphoneSession | undefined;
	const pendingBindings: LiveLeadResultBinding[] = [];
	const agendaTurns: AgendaTurnRouter = {
		bindTurn: (utteranceId) =>
			headphone
				? headphone.agenda.bindTurn(utteranceId)
				: { owner: "front", itemKey: null },
		whenTurnBound: (utteranceId) =>
			headphone
				? headphone.agenda.whenTurnBound(utteranceId)
				: Promise.resolve(),
	};
	const engine = options.createEngine({
		registerHandoff(binding) {
			// An agenda turn's answer belongs to the agenda, never to the
			// frontend readback (one speaker per turn).
			if (binding.agendaUtteranceId) {
				void headphone?.agenda
					.adoptReply({
						utteranceId: binding.agendaUtteranceId,
						handoffId: binding.handoffId,
					})
					.catch((error: unknown) =>
						options.record({
							kind: "agenda_reply_adopt_failed",
							handoffId: binding.handoffId,
							message: error instanceof Error ? error.message : String(error),
						}),
					);
				return;
			}
			if (replies) replies.register(binding);
			else pendingBindings.push(binding);
		},
		submitHandoff: (request, submitOptions) =>
			options.bridge.handoffToLead(options.binding, request, submitOptions),
		agendaTurns,
	});
	const session = new HeadphoneSession({
		engine,
		room: options.room,
		bridge: options.bridge,
		binding: options.binding,
		founderUserId: options.founderUserId,
		transcriptSink: options.transcriptSink,
		baseInstructions: options.baseInstructions,
		mode: options.mode,
		...(options.checkinIntervalMs === undefined
			? {}
			: { checkinIntervalMs: options.checkinIntervalMs }),
		createUtteranceProjection: (session) =>
			new LiveCaptionProjection({
				session,
				sink: options.captionSink,
				record: options.record,
			}),
		record: options.record,
		...(options.textStatus ? { textStatus: options.textStatus } : {}),
		...(options.onSpokenExit ? { onSpokenExit: options.onSpokenExit } : {}),
	});
	headphone = session;
	replies = new LiveReplyEvents({
		sessionId: options.binding.sessionId,
		generation: options.binding.generation,
		subscribe: (listener) =>
			options.bridge.subscribeReplies(options.binding, listener),
		listResults: (handoffId, after, limit) =>
			options.bridge.listVoiceHandoffResults(
				options.binding,
				handoffId,
				after,
				limit,
			),
		applyResult: (event, binding) => engine.applyLeadResult(event, binding),
		record: options.record,
	});
	for (const binding of pendingBindings.splice(0)) replies.register(binding);

	return {
		async start() {
			replies?.start();
			try {
				await session.start();
			} catch (error) {
				await replies?.close();
				throw error;
			}
		},
		async close() {
			// Close the engine first: it releases any readback or Lead-reply
			// drain waiting on the founder's turn, which both the reply close and
			// the headphone close would otherwise await.
			await engine.close();
			await replies?.close();
			await session.close();
		},
		async speak(text, pendingKey) {
			const receipt = await engine.speak(text, "brief", {
				pendingKey,
				verification: "required",
			});
			return receipt.outcome === "completed" ? "confirmed" : "failed";
		},
	};
}

/**
 * FLY-2863 §5.1: one voice per speaker, from the registry projection (the
 * session Lead's `realtimeVoice`: Raya in headphone mode, the meeting Lead in
 * a meeting). The legacy env override is not a source; a disagreeing value is
 * a startup error, never a silent switch.
 */
export function resolveEngineAVoice(
	projection: { realtimeVoice: string; mode: "rg" | "meeting" },
	env: Readonly<Record<string, string | undefined>>,
): { voice: string; mode: HeadphoneVoiceMode } {
	const voice = projection.realtimeVoice?.trim();
	if (!voice) throw new Error("engine_a_voice_missing");
	const override = env.FLYWHEEL_VOICE_OPENAI_LIVE_VOICE?.trim();
	if (override && override !== voice)
		throw new Error(
			`engine_a_voice_conflict: FLYWHEEL_VOICE_OPENAI_LIVE_VOICE=${override} but the Lead's realtimeVoice is ${voice}`,
		);
	return {
		voice,
		mode: projection.mode === "meeting" ? "meeting" : "headphone",
	};
}
