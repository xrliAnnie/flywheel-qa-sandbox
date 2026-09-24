import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	JsonlTranscriptSink,
	type VoiceHandoffRequest,
	voiceHandoffRequestDigest,
} from "flywheel-voice-core";
import { afterEach, describe, expect, it } from "vitest";
import { verifyVoiceHandoffTranscript } from "../voice-handoff-transcript.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function fixture(attribution: "known" | "unknown" = "known") {
	const root = mkdtempSync(join(tmpdir(), "fly2796-handoff-transcript-"));
	roots.push(root);
	const sessionId = "session-1";
	const directory = join(root, "sessions", sessionId);
	mkdirSync(directory, { recursive: true });
	const sink = new JsonlTranscriptSink(join(directory, "transcript.jsonl"));
	const entry = {
		ts: "2026-09-23T20:00:00.000Z",
		timestamp: "2026-09-23T20:00:00.000Z",
		sessionId,
		generation: 4,
		sequence: 1,
		transcriptId: "transcript-1",
		utteranceId: "utterance-1",
		backendId: "backend-a",
		source: "engine",
		face: "converse" as const,
		role: "user" as const,
		text: "Please check the deploy.",
		final: true,
		attribution:
			attribution === "known"
				? ({ kind: "known", speakerUserId: "founder-1" } as const)
				: ({ kind: "unknown", reason: "overlap" } as const),
	};
	const receipt = await sink.appendDurable(entry);
	const input = {
		handoffId: "018f47d2-7b64-7b42-a3df-123456789abc",
		idempotencyKey: "transcript-1:lead-1:action",
		intentKind: "action" as const,
		payload: {
			targetLeadId: "lead-1",
			text: entry.text,
			quotes: ["check the deploy"],
		},
		sessionId,
		generation: 4,
		transcriptId: entry.transcriptId,
		utteranceId: entry.utteranceId,
		originalText: entry.text,
		authorityBinding: {
			projectName: "flywheel",
			founderUserId: "founder-1",
			targetLeadId: "lead-1",
			sessionId,
			generation: 4,
			transcriptId: entry.transcriptId,
			transcriptDigest: receipt.contentDigest,
		},
		transcriptDurabilityReceipt: receipt,
	};
	const request: VoiceHandoffRequest = {
		...input,
		requestDigest: voiceHandoffRequestDigest(input),
	};
	return { root, request };
}

describe("voice handoff transcript proof", () => {
	it("re-reads a durable final founder utterance from the managed session path", async () => {
		const { root, request } = await fixture();
		await expect(
			verifyVoiceHandoffTranscript({
				voiceRoot: root,
				founderUserId: "founder-1",
				request,
			}),
		).resolves.toBe(true);
	});

	it("rejects an unknown speaker even with a durable transcript receipt", async () => {
		const { root, request } = await fixture("unknown");
		await expect(
			verifyVoiceHandoffTranscript({
				voiceRoot: root,
				founderUserId: "founder-1",
				request,
			}),
		).resolves.toBe(false);
	});
});
