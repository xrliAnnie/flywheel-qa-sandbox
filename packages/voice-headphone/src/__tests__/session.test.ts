import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeV1Session,
	JsonlTranscriptSink,
	type VoiceUtterance,
} from "flywheel-voice-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeVoiceClient } from "../bridge-client.js";
import { HeadphoneSession } from "../session.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function utterance(role: "user" | "assistant", text: string): VoiceUtterance {
	return {
		ts: "2026-09-23T20:00:00.000Z",
		timestamp: "2026-09-23T20:00:00.000Z",
		sessionId: "session-1",
		generation: 3,
		sequence: role === "user" ? 1 : 2,
		transcriptId: `${role}-transcript`,
		utteranceId: `${role}-utterance`,
		backendId: "fake-v1",
		source: "engine",
		face: "converse",
		role,
		text,
		final: true,
		attribution:
			role === "user"
				? { kind: "known", speakerUserId: "founder-1" }
				: { kind: "unknown", reason: "assistant" },
	};
}

function bridge(overrides: Partial<BridgeVoiceClient> = {}) {
	return {
		listHeadphoneItems: vi.fn(async () => []),
		claimHeadphoneItem: vi.fn(async () => undefined),
		ackHeadphoneClaim: vi.fn(async () => undefined),
		getHeadphoneSourceHealth: vi.fn(async () => ({
			healthy: true,
			sourceGap: false,
			sources: [],
		})),
		handoffToLead: vi.fn(),
		listVoiceHandoffResults: vi.fn(),
		...overrides,
	} as unknown as BridgeVoiceClient;
}

function room() {
	return {
		audibleTail: () => ({
			estimated: true as const,
			remainingMs: 0,
			drained: true,
			observedAt: 0,
			sessionId: "session-1",
			generation: 3,
		}),
	};
}

function transcriptSink() {
	const root = mkdtempSync(join(tmpdir(), "fly2796-headphone-session-"));
	roots.push(root);
	return new JsonlTranscriptSink(join(root, "transcript.jsonl"));
}

describe("HeadphoneSession", () => {
	it("composes the Bridge inbox with one complete V1 engine", async () => {
		const engine = new FakeV1Session({ sessionId: "session-1", generation: 3 });
		const client = bridge({
			listHeadphoneItems: vi.fn(async () => [
				{
					id: "item-1",
					revision: 1,
					createdAt: "2026-09-23T20:00:00.000Z",
					needsDecision: true,
					text: "请决定是否继续。",
				},
			]),
			claimHeadphoneItem: vi.fn(async (_binding, item) => ({
				item,
				claimToken: "claim-1",
			})),
			ackHeadphoneClaim: vi.fn(async () => undefined),
		});
		const session = new HeadphoneSession({
			engine,
			room: room(),
			bridge: client,
			binding: {
				sessionId: "session-1",
				generation: 3,
				leaseToken: "lease-1",
			},
			founderUserId: "founder-1",
			transcriptSink: transcriptSink(),
			baseInstructions: "你是测试引擎。",
			record: vi.fn(),
		});

		await session.start();

		expect(engine.initialSessionContext).toContain("退出语音的规则");
		expect(engine.speakCalls.map((call) => call.text)).toEqual([
			"我正在整理现在的情况和等你决定的事。",
			"请决定是否继续。",
		]);
		expect(client.ackHeadphoneClaim).toHaveBeenCalledOnce();
		await session.close();
	});

	it("closes only after the durable founder exit request and assistant sentence", async () => {
		const engine = new FakeV1Session({ sessionId: "session-1", generation: 3 });
		const onSpokenExit = vi.fn();
		const session = new HeadphoneSession({
			engine,
			room: room(),
			bridge: bridge(),
			binding: {
				sessionId: "session-1",
				generation: 3,
				leaseToken: "lease-1",
			},
			founderUserId: "founder-1",
			transcriptSink: transcriptSink(),
			baseInstructions: "context",
			record: vi.fn(),
			onSpokenExit,
		});
		await session.start();

		engine.emitUtterance(utterance("assistant", "好，退出语音模式。"));
		await Promise.resolve();
		expect(onSpokenExit).not.toHaveBeenCalled();
		engine.emitUtterance(utterance("user", "先到这里，结束语音"));
		engine.emitUtterance(utterance("assistant", "好，退出语音模式。"));
		await vi.waitFor(() => expect(onSpokenExit).toHaveBeenCalledOnce());
		expect(engine.closed).toBe(true);
	});

	it("rejects an engine that only implements text-to-speech", () => {
		expect(
			() =>
				new HeadphoneSession({
					engine: new FakeV1Session({
						sessionId: "session-1",
						generation: 3,
						capabilities: { onUtterance: false },
					}),
					room: room(),
					bridge: bridge(),
					binding: {
						sessionId: "session-1",
						generation: 3,
						leaseToken: "lease-1",
					},
					founderUserId: "founder-1",
					transcriptSink: transcriptSink(),
					baseInstructions: "context",
					record: vi.fn(),
				}),
		).toThrow("headphone_v1_capabilities_incomplete");
	});
});
