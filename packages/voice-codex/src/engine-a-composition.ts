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
	type BridgeVoiceClient,
	HeadphoneSession,
	type HeadphoneSessionBinding,
} from "flywheel-voice-headphone";
import {
	type CaptionSink,
	LiveCaptionProjection,
} from "./live-caption-projection.js";
import type { LiveLeadResultBinding } from "./live-lead-adapter.js";
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
	submitHandoff(request: VoiceHandoffRequest): Promise<VoiceHandoffReceipt>;
}

type EngineABridge = Pick<
	BridgeVoiceClient,
	| "listHeadphoneItems"
	| "claimHeadphoneItem"
	| "ackHeadphoneClaim"
	| "getHeadphoneSourceHealth"
	| "handoffToLead"
	| "listVoiceHandoffResults"
	| "subscribeReplies"
>;

export interface EngineAHeadphoneSessionOptions {
	binding: HeadphoneSessionBinding;
	founderUserId: string;
	bridge: EngineABridge;
	room: Pick<RoomIO, "audibleTail">;
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
	let closing = false;
	const pendingBindings: LiveLeadResultBinding[] = [];
	const engine = options.createEngine({
		registerHandoff(binding) {
			if (replies) replies.register(binding);
			else pendingBindings.push(binding);
		},
		submitHandoff: (request) =>
			options.bridge.handoffToLead(options.binding, request),
	});
	const bridge = options.bridge;
	const headphone = new HeadphoneSession({
		engine,
		room: options.room,
		// The inbox pulls no new item while the founder is talking or waiting
		// for her answer; the readback resumes only after her turn settles.
		bridge: {
			listHeadphoneItems: (binding) => bridge.listHeadphoneItems(binding),
			claimHeadphoneItem: async (binding, item) => {
				await engine.whenFounderTurnSettled();
				if (closing) return undefined;
				return bridge.claimHeadphoneItem(binding, item);
			},
			ackHeadphoneClaim: (binding, claim, receipts) =>
				bridge.ackHeadphoneClaim(binding, claim, receipts),
			getHeadphoneSourceHealth: (binding) =>
				bridge.getHeadphoneSourceHealth(binding),
			handoffToLead: (binding, request) =>
				bridge.handoffToLead(binding, request),
			listVoiceHandoffResults: (binding, handoffId, after, limit) =>
				bridge.listVoiceHandoffResults(binding, handoffId, after, limit),
			subscribeReplies: (binding, listener) =>
				bridge.subscribeReplies(binding, listener),
		},
		binding: options.binding,
		founderUserId: options.founderUserId,
		transcriptSink: options.transcriptSink,
		baseInstructions: options.baseInstructions,
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
				await headphone.start();
			} catch (error) {
				await replies?.close();
				throw error;
			}
		},
		async close() {
			closing = true;
			// Close the engine first: it releases any inbox pull, readback or
			// Lead-reply drain waiting on the founder's turn, which both the
			// reply close and the headphone close would otherwise await.
			await engine.close();
			await replies?.close();
			await headphone.close();
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
