import {
	FakeV1Session,
	MemoryTranscriptSink,
	type VoiceHandoffResultEvent,
} from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import {
	createEngineAHeadphoneSession,
	type EngineAAdapter,
} from "../engine-a-composition.js";

describe("Engine A production composition", () => {
	it("starts the durable reply subscription and projects the shared utterance stream", async () => {
		const engine = new FakeV1Session({
			sessionId: "session-1",
			generation: 7,
		}) as EngineAAdapter;
		engine.applyLeadResult = vi.fn(async () => ({
			pendingKey: "result-1",
			requestDigest: "speech-digest",
			outcome: "completed" as const,
			transport: "submitted" as const,
			contentProof: "deterministic_tts" as const,
		}));
		let replyListener:
			| ((event: {
					sessionId: string;
					generation: number;
					handoffId: string;
			  }) => void)
			| undefined;
		const unsubscribe = vi.fn();
		const result: VoiceHandoffResultEvent = {
			resultEventId: "result-1",
			seq: 1,
			handoffId: "handoff-1",
			requestDigest: "request-digest",
			sourceLeadId: "lead-1",
			sourceDeliveryId: "delivery-1",
			resultKind: "lead_reply",
			text: "Lead answer",
			createdAt: "2026-09-24T00:00:01.000Z",
		};
		const bridge = {
			listHeadphoneItems: vi.fn(async () => []),
			claimHeadphoneItem: vi.fn(async () => undefined),
			ackHeadphoneClaim: vi.fn(async () => undefined),
			getHeadphoneSourceHealth: vi.fn(async () => ({
				healthy: true,
				sourceGap: false,
				sources: [],
			})),
			handoffToLead: vi.fn(),
			listVoiceHandoffResults: vi.fn(async () => ({
				events: [result],
				highWatermark: 1,
				nextCursor: 1,
			})),
			subscribeReplies: vi.fn((_binding, listener) => {
				replyListener = listener;
				return unsubscribe;
			}),
		};
		let registerHandoff!: (binding: {
			sessionId: string;
			generation: number;
			handoffId: string;
			requestDigest: string;
			targetLeadId: string;
		}) => void;
		const caption = vi.fn();
		const session = createEngineAHeadphoneSession({
			binding: {
				sessionId: "session-1",
				generation: 7,
				leaseToken: "lease-1",
			},
			founderUserId: "founder-1",
			bridge,
			room: {
				audibleTail: () => ({
					estimated: true as const,
					remainingMs: 0,
					drained: true,
					observedAt: 0,
					sessionId: "session-1",
					generation: 7,
				}),
			},
			transcriptSink: new MemoryTranscriptSink(),
			baseInstructions: "Engine A",
			createEngine(callbacks) {
				registerHandoff = callbacks.registerHandoff;
				return engine;
			},
			captionSink: { caption },
			record: vi.fn(),
		});

		await session.start();
		expect(bridge.subscribeReplies).toHaveBeenCalledOnce();
		registerHandoff({
			sessionId: "session-1",
			generation: 7,
			handoffId: "handoff-1",
			requestDigest: "request-digest",
			targetLeadId: "lead-1",
		});
		replyListener?.({
			sessionId: "session-1",
			generation: 7,
			handoffId: "handoff-1",
		});
		await vi.waitFor(() => expect(engine.applyLeadResult).toHaveBeenCalled());

		engine.emitUtterance({
			ts: "2026-09-24T00:00:02.000Z",
			timestamp: "2026-09-24T00:00:02.000Z",
			sessionId: "session-1",
			generation: 7,
			sequence: 1,
			transcriptId: "frontend-1",
			utteranceId: "frontend-1",
			backendId: "fake-v1",
			source: "frontend",
			face: "converse",
			role: "assistant",
			text: "quick answer",
			final: true,
			attribution: { kind: "unknown", reason: "assistant_output" },
		});
		expect(caption).toHaveBeenCalledWith(
			expect.objectContaining({ label: "🤖 前台", text: "quick answer" }),
		);

		await session.close();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
