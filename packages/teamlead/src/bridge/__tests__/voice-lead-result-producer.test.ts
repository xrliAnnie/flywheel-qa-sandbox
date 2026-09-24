import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import type { VoiceHandoffRequest } from "flywheel-voice-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexLeadOutboundHandler } from "../../lead-backends/codex/CodexLeadOutboundHandler.js";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { VoiceHandoffStore } from "../voice-handoff-store.js";
import {
	resolveVoiceReplyDeliveryContext,
	VoiceLeadResultProducer,
} from "../voice-lead-result-producer.js";

const HANDOFF_ID = "018f47d2-7b64-7b42-a3df-123456789abc";
const DELIVERY_ID = `chat:lead-1:voice-handoff:${HANDOFF_ID}`;
const NOW = "2026-09-24T09:00:00.000Z";
const FOUNDER_ID = "22222222222222222";
let root: string;
let commPath: string;
let handoffDb: Database.Database;
let handoffs: VoiceHandoffStore;

function request(): VoiceHandoffRequest {
	return {
		handoffId: HANDOFF_ID,
		idempotencyKey: "transcript-1:lead-1:query",
		requestDigest: "a".repeat(64),
		intentKind: "query",
		payload: {
			targetLeadId: "lead-1",
			text: "请查一下状态",
			quotes: ["查一下状态"],
		},
		sessionId: "session-1",
		generation: 4,
		transcriptId: "transcript-1",
		utteranceId: "utterance-1",
		originalText: "请查一下状态",
		authorityBinding: {
			projectName: "flywheel",
			founderUserId: FOUNDER_ID,
			targetLeadId: "lead-1",
			sessionId: "session-1",
			generation: 4,
			transcriptId: "transcript-1",
			transcriptDigest: "b".repeat(64),
		},
		transcriptDurabilityReceipt: {
			version: 1,
			durable: true,
			sessionId: "session-1",
			transcriptId: "transcript-1",
			contentDigest: "b".repeat(64),
			persistedAt: NOW,
		},
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-result-"));
	commPath = join(root, "comm.db");
	handoffDb = new Database(":memory:");
	handoffs = new VoiceHandoffStore(handoffDb);
	handoffs.migrate();
	const value = request();
	handoffs.authorize({
		request: value,
		projectName: "flywheel",
		founderUserId: FOUNDER_ID,
		targetLeadId: "lead-1",
		messageId: `voice-handoff:${HANDOFF_ID}`,
		providerOperationId: DELIVERY_ID,
		now: NOW,
	});
	const dispatching = handoffs.beginDispatch(HANDOFF_ID, NOW)!;
	handoffs.finishDispatch({
		handoffId: HANDOFF_ID,
		attemptToken: dispatching.attemptToken!,
		state: "committed",
		now: NOW,
	});
	const comm = new CommDB(commPath);
	comm.ingestDiscordChat({
		leadId: "lead-1",
		chatId: "11111111111111111",
		originChannelId: "11111111111111111",
		messageId: `voice-handoff:${HANDOFF_ID}`,
		authorId: FOUNDER_ID,
		authorName: "Founder voice",
		founderId: FOUNDER_ID,
		ts: NOW,
		msgKind: "guild",
		attachments: [],
		text: value.originalText,
		origin: "voice",
		voiceSessionId: value.sessionId,
		voiceHandoff: {
			version: 1,
			handoffId: value.handoffId,
			intentKind: value.intentKind,
			requestDigest: value.requestDigest,
			targetLeadId: value.payload.targetLeadId,
			transcriptId: value.transcriptId,
			utteranceId: value.utteranceId,
			sessionGeneration: value.generation,
		},
	});
	comm.close();
});

afterEach(() => {
	handoffDb.close();
	rmSync(root, { recursive: true, force: true });
});

describe("VoiceLeadResultProducer", () => {
	it("commits and replays one carrier-neutral response/result across wall-clock advancement", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		try {
			const producer = new VoiceLeadResultProducer({
				commDbPathForProject: (project) => {
					expect(project).toBe("flywheel");
					return commPath;
				},
				store: handoffs,
			});
			const input = {
				projectName: "flywheel",
				sourceLeadId: "lead-1",
				sourceDeliveryId: DELIVERY_ID,
				operationId: "entry-1:out",
				text: "状态正常，已经确认。",
			};

			const first = producer.produce(input);
			vi.advanceTimersByTime(1_000);
			const replay = producer.produce(input);
			expect(replay).toEqual(first);
			expect(first).toMatchObject({
				handoffId: HANDOFF_ID,
				requestDigest: "a".repeat(64),
				sourceLeadId: "lead-1",
				resultKind: "lead_reply",
				text: input.text,
				seq: 1,
			});

			const comm = CommDB.openReadonly(commPath);
			try {
				expect(comm.getMessageById(first.sourceDeliveryId)).toMatchObject({
					from_agent: "lead-1",
					to_agent: FOUNDER_ID,
					parent_id: DELIVERY_ID,
					content: input.text,
				});
			} finally {
				comm.close();
			}
			expect(handoffs.listResults(HANDOFF_ID, 0, 100).events).toEqual([first]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects a spoofed binding before creating a result", () => {
		const producer = new VoiceLeadResultProducer({
			commDbPathForProject: () => commPath,
			store: handoffs,
		});
		expect(() =>
			producer.produce({
				projectName: "flywheel",
				sourceLeadId: "lead-2",
				sourceDeliveryId: DELIVERY_ID,
				operationId: "entry-1:out",
				text: "伪造回复",
			}),
		).toThrow("voice_lead_result_binding_mismatch");
		expect(handoffs.listResults(HANDOFF_ID, 0, 100).events).toEqual([]);
	});

	it("commits through authenticated outbound before a failing Discord mirror", async () => {
		const producer = new VoiceLeadResultProducer({
			commDbPathForProject: () => commPath,
			store: handoffs,
		});
		const outbound = new SqliteOutboundDedupStore(join(root, "outbound.db"));
		const send = vi.fn(async () => {
			throw new Error("discord unavailable");
		});
		try {
			const handler = new CodexLeadOutboundHandler({
				store: outbound,
				expectedApiToken: "bridge-token",
				authorizeLeadChannel: () => true,
				produceVoiceLeadResult: (input) => producer.produce(input),
				send,
			});
			const result = await handler.handle({
				providedToken: "bridge-token",
				deliveryContext: DELIVERY_ID,
				body: {
					projectName: "flywheel",
					leadId: "lead-1",
					channelId: "11111111111111111",
					text: "状态正常，已经确认。",
					idempotencyKey: "entry-1:out",
					nonce: "nonce-1",
				},
			});

			expect(result).toMatchObject({ status: "ambiguous" });
			expect(send).toHaveBeenCalledOnce();
			expect(handoffs.listResults(HANDOFF_ID, 0, 100).events).toEqual([
				expect.objectContaining({
					handoffId: HANDOFF_ID,
					text: "状态正常，已经确认。",
				}),
			]);
		} finally {
			outbound.close();
		}
	});
});

describe("resolveVoiceReplyDeliveryContext", () => {
	it("normalizes the one exact voice member and leaves an ordinary entry unchanged", () => {
		expect(
			resolveVoiceReplyDeliveryContext("lead-1", [`${DELIVERY_ID}#r2`]),
		).toBe(DELIVERY_ID);
		expect(
			resolveVoiceReplyDeliveryContext("lead-1", [
				"chat:lead-1:12345678901234567#r0",
			]),
		).toBeUndefined();
	});

	it.each([
		[[`${DELIVERY_ID}#r0`, "chat:lead-1:12345678901234567#r0"], "multi_member"],
		[
			[
				`${DELIVERY_ID}#r0`,
				`chat:lead-1:voice-handoff:028f47d2-7b64-7b42-a3df-123456789abc#r0`,
			],
			"multiple_voice_members",
		],
	])("fails closed for %s", (members, reason) => {
		expect(() => resolveVoiceReplyDeliveryContext("lead-1", members)).toThrow(
			`voice_reply_context_${reason}`,
		);
	});
});
