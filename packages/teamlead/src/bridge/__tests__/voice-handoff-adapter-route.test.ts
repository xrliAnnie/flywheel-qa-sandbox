import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import express from "express";
import type {
	ConversationEventMap,
	OpenAiLiveConversationSession,
	OpenAiLiveTranscriptDelta,
	RoomBargeInEvent,
	RoomIO,
	RoomUtteranceEvent,
	SpeakReceipt,
	VoiceHandoffReceipt,
	VoiceHandoffRequest,
	VoiceUtterance,
} from "flywheel-voice-core";
import { voiceHandoffRequestDigest } from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveLeadAdapter } from "../../../../voice-codex/src/live-lead-adapter.js";
import { createVoiceHandoffRouter } from "../voice-handoff-routes.js";
import { VoiceHandoffStore } from "../voice-handoff-store.js";
import { VoiceReplyNotifier } from "../voice-reply-notifier.js";
import { voiceSessionAuthMiddleware } from "../voice-session-auth.js";

const MASTER = "master-token";
const LEASE = "lease-token";
const SESSION_ID = "voice-session";
let server: Server | undefined;
let db: Database.Database | undefined;

afterEach(
	() =>
		new Promise<void>((resolve) => {
			const finish = () => {
				db?.close();
				db = undefined;
				resolve();
			};
			if (!server) return finish();
			server.close(() => {
				server = undefined;
				finish();
			});
		}),
);

class FakeLive implements OpenAiLiveConversationSession {
	readonly sessionId = "provider-session";
	readonly effectiveCapabilities = {
		verbatim: false,
		attribution: false,
		turnCancelOrSuppress: true,
	};
	providerGeneration = 1;
	private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
	private readonly transcriptHandlers = new Set<
		(delta: OpenAiLiveTranscriptDelta) => void
	>();

	sendAudio(): void {}
	sendText(): void {}
	injectContext(): void {}
	endUserTurn(): void {}
	injectToolResult(): void {}
	interrupt(): void {}
	async replaceAfterBargeIn(): Promise<number> {
		return ++this.providerGeneration;
	}
	async suspend(reason: "announcer-takeover" | "delegation-sealed") {
		return {
			generation: this.providerGeneration,
			reason,
			finalization: "provider_connection_closed" as const,
		};
	}
	async resume(): Promise<number> {
		return ++this.providerGeneration;
	}
	async close(): Promise<void> {}
	on<E extends keyof ConversationEventMap>(
		event: E,
		handler: (...args: ConversationEventMap[E]) => void,
	): () => void {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler as (...args: any[]) => void);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler as (...args: any[]) => void);
	}
	onLiveTranscript(
		listener: (delta: OpenAiLiveTranscriptDelta) => void,
	): () => void {
		this.transcriptHandlers.add(listener);
		return () => this.transcriptHandlers.delete(listener);
	}
	emit(event: string, ...args: any[]): void {
		for (const handler of this.handlers.get(event) ?? []) handler(...args);
	}
	emitTranscript(delta: OpenAiLiveTranscriptDelta): void {
		for (const handler of this.transcriptHandlers) handler(delta);
	}
}

function roomHarness() {
	const utteranceListeners = new Set<(event: RoomUtteranceEvent) => void>();
	const room = {
		identity: {
			moduleExport: "adapter-route-contract",
			roomIOVersion: 1 as const,
			implementationDigest: "test-digest",
			buildSha: null,
			instanceId: "test-instance",
			sessionId: SESSION_ID,
			roomKey: "test-room",
			generation: 9,
			inputRouteInstanceId: "test-instance",
			outputRouteInstanceId: "test-instance",
		},
		onFrame: () => () => undefined,
		onUtterance: (listener: (event: RoomUtteranceEvent) => void) => {
			utteranceListeners.add(listener);
			return () => utteranceListeners.delete(listener);
		},
		onBargeIn: (_listener: (event: RoomBargeInEvent) => void) => () =>
			undefined,
		startSpeech: (input: any) => ({ outcome: "accepted" as const, ...input }),
		writeSpeech: async (frame: any) => ({
			outcome: "submitted" as const,
			speechId: frame.speechId,
			generation: frame.generation,
			sequence: frame.sequence,
		}),
		endSpeech: async (speechId: string, generation: number) => ({
			outcome: "submitted" as const,
			speechId,
			generation,
		}),
		localPlaybackCancel: () => undefined,
		audibleTail: () => ({
			estimated: true as const,
			remainingMs: 0,
			drained: true,
			observedAt: 0,
			sessionId: SESSION_ID,
			generation: 9,
		}),
	};
	return {
		room: room as unknown as RoomIO,
		emit(event: RoomUtteranceEvent) {
			for (const listener of utteranceListeners) listener(event);
		},
	};
}

async function startRoute() {
	db = new Database(":memory:");
	const store = new VoiceHandoffStore(db);
	store.migrate();
	const dispatch = vi.fn(async () => "committed" as const);
	const app = express();
	app.use(express.json());
	app.use(
		"/api/voice/handoffs",
		voiceSessionAuthMiddleware(MASTER),
		createVoiceHandoffRouter({
			store,
			replyNotifier: new VoiceReplyNotifier(),
			founderUserId: "founder-1",
			now: () => new Date("2026-09-24T00:00:01.000Z"),
			getSession: (sessionId) =>
				sessionId === SESSION_ID
					? {
							sessionId,
							projectName: "flywheel",
							sessionGeneration: 9,
							leaseToken: LEASE,
							leaseExpiresAt: "2026-09-24T00:01:00.000Z",
							state: "live",
						}
					: undefined,
			isTargetLead: (project, lead) =>
				project === "flywheel" && lead === "flywheel-eng-lead",
			verifyTranscript: async () => true,
			dispatch,
			verifyResultSource: async () => true,
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/handoffs/`;
	const post = async (request: VoiceHandoffRequest) => {
		const response = await fetch(base, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${MASTER}`,
				"X-Voice-Lease": LEASE,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
		});
		return { status: response.status, body: await response.json() };
	};
	return { store, dispatch, post };
}

describe("LiveLeadAdapter to voice handoff route contract", () => {
	it("commits the producer request and rejects the legacy digest key", async () => {
		const route = await startRoute();
		const live = new FakeLive();
		const room = roomHarness();
		const produced: VoiceHandoffRequest[] = [];
		const speech = {
			speak: vi.fn(
				async (
					_text: string,
					_kind: string,
					opts: { pendingKey: string },
				): Promise<SpeakReceipt> => ({
					pendingKey: opts.pendingKey,
					requestDigest: "speech-digest",
					outcome: "completed",
					transport: "submitted",
					contentProof: "deterministic_tts",
				}),
			),
			cancel: vi.fn(),
		};
		const transcriptSink = {
			append: vi.fn(),
			appendDurable: vi.fn(async (entry: VoiceUtterance) => ({
				version: 1 as const,
				durable: true as const,
				sessionId: entry.sessionId,
				transcriptId: entry.transcriptId,
				contentDigest: createHash("sha256").update(entry.text).digest("hex"),
				persistedAt: "2026-09-24T00:00:00.000Z",
			})),
			readReceipt: vi.fn(
				async (
					sessionId: string,
					transcriptId: string,
					contentDigest: string,
				) => ({
					version: 1 as const,
					durable: true as const,
					sessionId,
					transcriptId,
					contentDigest,
					persistedAt: "2026-09-24T00:00:00.000Z",
				}),
			),
		};
		const adapter = new LiveLeadAdapter({
			sessionId: SESSION_ID,
			generation: 9,
			projectName: "flywheel",
			founderUserId: "founder-1",
			targetLeadId: "flywheel-eng-lead",
			room: room.room,
			createConversation: vi.fn(async () => live),
			transcriptSink,
			speech,
			classifyIntent: () => "query",
			submitHandoff: async (request) => {
				produced.push(request);
				const response = await route.post(request);
				if (response.status !== 200)
					throw new Error(JSON.stringify(response.body));
				return response.body as VoiceHandoffReceipt;
			},
			registerHandoff: vi.fn(),
			now: () => 1_000,
			nextId: () => "018f47d2-7b64-7b42-a3df-123456789abc",
			record: vi.fn(),
		});

		await adapter.open("context");
		room.emit({
			sessionId: SESSION_ID,
			generation: 9,
			utteranceId: "utterance-1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_100,
			phase: "start",
		});
		live.emitTranscript({
			type: "transcript-delta",
			direction: "input",
			generation: 1,
			eventId: "delta-1",
			startMs: 100,
			endMs: 200,
			delta: "帮我查一下状态",
		});
		room.emit({
			sessionId: SESSION_ID,
			generation: 9,
			utteranceId: "utterance-1",
			attribution: { kind: "known", speakerUserId: "founder-1" },
			observedAt: 1_250,
			phase: "end",
		});
		live.emit("delegation-created", {
			delegationId: "provider-1",
			generation: 1,
			offsetMs: 200,
			target: "client",
		});

		await vi.waitFor(() => expect(route.dispatch).toHaveBeenCalledOnce());
		const request = produced[0]!;
		expect(route.store.get(request.handoffId)).toMatchObject({
			state: "committed",
			idempotencyKey: `${request.transcriptId}:${request.payload.targetLeadId}:${request.intentKind}`,
		});

		const { requestDigest: _digest, ...legacyInput } = request;
		const legacy = {
			...legacyInput,
			idempotencyKey: createHash("sha256")
				.update(JSON.stringify(legacyInput))
				.digest("hex"),
		};
		await expect(
			route.post({
				...legacy,
				requestDigest: voiceHandoffRequestDigest(legacy),
			}),
		).resolves.toEqual({
			status: 400,
			body: { error: "voice_handoff_binding_invalid" },
		});
		await adapter.close();
	});
});
