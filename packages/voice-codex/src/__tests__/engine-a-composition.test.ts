import {
	FakeV1Session,
	MemoryTranscriptSink,
	type VoiceHandoffResultEvent,
} from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import {
	createEngineAHeadphoneSession,
	type EngineAAdapter,
	resolveEngineAVoice,
} from "../engine-a-composition.js";

function agendaBridge() {
	let stored: unknown;
	return {
		getAgendaSnapshot: vi.fn(async () => ({
			snapshotId: "s",
			asOf: "2026-09-24T00:00:00.000Z",
			items: [
				{
					itemKey: "blocked:I1:t",
					class: "blocked",
					projectName: "raya",
					leadId: "raya",
					leadName: "raya",
					issueIdentifier: "FLY-2796",
					issueTitle: "耳机",
					threadUrl: "https://discord.com/channels/1/2",
					since: "2026-09-24T00:00:00.000Z",
					urgent: null,
					pointers: { messageIds: [] },
					sourceKey: "titles:raya",
				},
			],
			sourceStatus: {},
			complete: true,
			olderUnspokenCount: 0,
		})),
		getAgendaState: vi.fn(async () => stored),
		putAgendaState: vi.fn(
			async (_binding: unknown, input: { state: unknown }) => {
				stored = input.state;
				return { ok: true as const };
			},
		),
		requestAgendaBrief: vi.fn(async () => ({ requestId: "agenda-open-1" })),
		bindAgendaTurn: vi.fn(async () => undefined),
	};
}

function tail() {
	return {
		onBargeIn: () => () => undefined,
		audibleTail: () => ({
			estimated: true as const,
			remainingMs: 0,
			drained: true,
			observedAt: 0,
			sessionId: "session-1",
			generation: 7,
		}),
	};
}

describe("resolveEngineAVoice (FLY-2863 §5.1)", () => {
	it("speaks in the session Lead's registry voice and splits the modes", () => {
		expect(
			resolveEngineAVoice({ realtimeVoice: "marin", mode: "rg" }, {}),
		).toEqual({ voice: "marin", mode: "headphone" });
		expect(
			resolveEngineAVoice(
				{ realtimeVoice: "verse", mode: "meeting" },
				{
					FLYWHEEL_VOICE_OPENAI_LIVE_VOICE: "verse",
				},
			),
		).toEqual({ voice: "verse", mode: "meeting" });
	});

	it("refuses an env voice that disagrees with the registry", () => {
		expect(() =>
			resolveEngineAVoice(
				{ realtimeVoice: "alloy", mode: "meeting" },
				{
					FLYWHEEL_VOICE_OPENAI_LIVE_VOICE: "marin",
				},
			),
		).toThrow(/engine_a_voice_conflict/);
	});
});

describe("Engine A production composition", () => {
	it("routes an agenda turn's answer to the agenda, never to the frontend readback", async () => {
		const engine = new FakeV1Session({
			sessionId: "session-1",
			generation: 7,
		}) as EngineAAdapter;
		engine.whenFounderTurnSettled = vi.fn(async () => undefined);
		engine.applyLeadResult = vi.fn();
		const listeners: Array<(event: { handoffId: string }) => void> = [];
		const bridge = {
			...agendaBridge(),
			handoffToLead: vi.fn(),
			listVoiceHandoffResults: vi.fn(
				async (_binding: unknown, handoffId: string, after: number) => {
					if (handoffId === "agenda-open-1" && after === 0)
						return {
							events: [
								{
									resultEventId: "r1",
									seq: 1,
									handoffId,
									requestDigest: "d",
									sourceLeadId: "raya",
									sourceDeliveryId: "x",
									resultKind: "agenda_say",
									text: "一件受阻，要你授权。",
									agenda: { kind: "say", itemKey: "blocked:I1:t" },
									createdAt: "2026-09-24T00:00:01.000Z",
								},
							],
							highWatermark: 1,
							nextCursor: 1,
						};
					if (handoffId === "reply-1" && after === 0)
						return {
							events: [
								{
									resultEventId: "r2",
									seq: 1,
									handoffId,
									requestDigest: "d2",
									sourceLeadId: "raya",
									sourceDeliveryId: "y",
									resultKind: "lead_reply",
									text: "好，我放行了。",
									createdAt: "2026-09-24T00:00:02.000Z",
								},
							],
							highWatermark: 1,
							nextCursor: 1,
						};
					return { events: [], highWatermark: after, nextCursor: after };
				},
			),
			subscribeReplies: vi.fn((_binding, listener) => {
				listeners.push(listener);
				return () => undefined;
			}),
		};
		let callbacks!: Parameters<
			Parameters<typeof createEngineAHeadphoneSession>[0]["createEngine"]
		>[0];
		const session = createEngineAHeadphoneSession({
			binding: { sessionId: "session-1", generation: 7, leaseToken: "lease-1" },
			founderUserId: "founder-1",
			bridge: bridge as never,
			room: tail(),
			mode: "headphone",
			transcriptSink: new MemoryTranscriptSink(),
			baseInstructions: "Engine A",
			createEngine(value) {
				callbacks = value;
				return engine;
			},
			captionSink: { caption: vi.fn() },
			record: vi.fn(),
		});
		await session.start();
		for (const listener of listeners) listener({ handoffId: "agenda-open-1" });
		await vi.waitFor(() =>
			expect(engine.speakCalls.map((call) => call.text)).toEqual([
				"一件受阻，要你授权。",
			]),
		);
		expect(callbacks.agendaTurns.bindTurn("utt-1")).toEqual({
			owner: "agenda",
			itemKey: "blocked:I1:t",
		});
		callbacks.registerHandoff({
			sessionId: "session-1",
			generation: 7,
			handoffId: "reply-1",
			requestDigest: "d2",
			targetLeadId: "raya",
			agendaUtteranceId: "utt-1",
		});
		await vi.waitFor(() =>
			expect(engine.speakCalls.map((call) => call.text)).toContain(
				"好，我放行了。",
			),
		);
		for (const listener of listeners) listener({ handoffId: "reply-1" });
		await new Promise((resolve) => setImmediate(resolve));
		expect(engine.applyLeadResult).not.toHaveBeenCalled();
		await session.close();
	});

	it("starts the durable reply subscription and projects the shared utterance stream", async () => {
		const engine = new FakeV1Session({
			sessionId: "session-1",
			generation: 7,
		}) as EngineAAdapter;
		engine.whenFounderTurnSettled = vi.fn(async () => undefined);
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
			...agendaBridge(),
			handoffToLead: vi.fn(),
			listVoiceHandoffResults: vi.fn(async () => ({
				events: [result],
				highWatermark: 1,
				nextCursor: 1,
			})),
			subscribeReplies: vi.fn((_binding, listener) => {
				replyListener ??= listener;
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
			bridge: bridge as never,
			room: tail(),
			mode: "headphone",
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
		// One durable reply stream for frontend readbacks, one for the agenda.
		expect(bridge.subscribeReplies).toHaveBeenCalledTimes(2);
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
		expect(unsubscribe).toHaveBeenCalledTimes(2);
	});
});
