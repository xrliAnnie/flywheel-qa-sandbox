import { isVoiceMirrorText, type VoiceUtterance } from "flywheel-voice-core";
import { describe, expect, it, vi } from "vitest";
import {
	buildCodexDelegateHandoff,
	CodexTranscriptPublisher,
} from "../codex/CodexVoiceHandoff.js";

const founderUtterance: VoiceUtterance = {
	sessionId: "session-a",
	sessionGeneration: 1,
	utteranceId: "utterance-a",
	transcriptId: "transcript-a",
	ts: "2026-09-24T21:43:32.260Z",
	sequence: 13,
	source: "room_audio",
	role: "user",
	text: "你帮我去看一下2799现在是什么状态。",
	final: true,
	attribution: { kind: "known", speakerUserId: "founder" },
};

describe("Codex voice handoff and visible transcript", () => {
	it("turns a backend execution intent into one founder-bound Lead delegation", () => {
		const built = buildCodexDelegateHandoff({
			sessionId: "session-a",
			leadId: "raya",
			utterance: founderUtterance,
			intent: {
				generation: 1,
				kind: "commandExecution",
				method: "item/started",
				itemId: "exec-a",
				params: { privateBackendDetail: "must-not-be-forwarded" },
			},
		});

		expect(built).toEqual({
			intentKind: "delegate_request",
			payload: {
				backendIntentKind: "commandExecution",
				backendMethod: "item/started",
				backendItemId: "exec-a",
			},
			transcriptId: "transcript-a",
			originalText: founderUtterance.text,
			idempotencyKey: expect.stringMatching(/^codex-delegate:[a-f0-9]{32}$/u),
			authorityBinding: {
				version: 1,
				source: "codex_voice_execution_intent",
				sessionId: "session-a",
				leadId: "raya",
				transcriptId: "transcript-a",
				speakerUserId: "founder",
			},
		});
		expect(JSON.stringify(built)).not.toContain("privateBackendDetail");
	});

	it("publishes user and assistant finals to the Discord thread in order without granting authority", async () => {
		const mirror = vi
			.fn()
			.mockResolvedValueOnce({ messageId: "discord-user" })
			.mockResolvedValueOnce({ messageId: "discord-assistant" });
		const evidence = vi.fn();
		const publisher = new CodexTranscriptPublisher({
			sessionId: "session-a",
			founderUserId: "founder",
			displayName: "Raya",
			mirror,
			evidence,
		});
		const assistantUtterance: VoiceUtterance = {
			...founderUtterance,
			utteranceId: "utterance-b",
			transcriptId: "transcript-b",
			sequence: 14,
			role: "assistant",
			source: "engine_audio",
			text: "好的，我交给本体查，回复会继续念给你。",
			attribution: { kind: "unknown", reason: "engine_output" },
		};
		const unattributedUser: VoiceUtterance = {
			...founderUtterance,
			attribution: { kind: "unknown", reason: "provider_item_unattributed" },
		};

		await Promise.all([
			publisher.publish(unattributedUser),
			publisher.publish(assistantUtterance),
		]);

		expect(mirror.mock.calls.map(([input]) => input.text)).toEqual([
			"🎙️ **语音输入**：你帮我去看一下2799现在是什么状态。",
			"🤖 **Raya 语音分身**：好的，我交给本体查，回复会继续念给你。",
		]);
		expect(mirror.mock.calls.map(([input]) => input.nonce)).toEqual([
			expect.stringMatching(/^[0-9a-z]{1,25}$/u),
			expect.stringMatching(/^[0-9a-z]{1,25}$/u),
		]);
		expect(new Set(mirror.mock.calls.map(([input]) => input.nonce)).size).toBe(
			2,
		);
		expect(evidence).toHaveBeenCalledTimes(2);
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "codex_transcript_published",
				role: "assistant",
				transcriptId: "transcript-b",
				messageId: "discord-assistant",
			}),
		);
	});

	it("marks every mirrored line so the Bridge poller never reads it back as a Lead reply", async () => {
		// FLY-2799 qa6: the founder's own lines were read back to her because the
		// poller did not recognise the 🎙️ mirror prefix.
		const mirror = vi.fn(async () => ({ messageId: "discord-message" }));
		const publisher = new CodexTranscriptPublisher({
			sessionId: "session-a",
			founderUserId: "founder",
			displayName: "Raya",
			mirror,
			evidence: vi.fn(),
		});
		await publisher.publish(founderUtterance);
		await publisher.publish({
			...founderUtterance,
			transcriptId: "transcript-unknown",
			attribution: { kind: "unknown", reason: "input_gap" },
		});
		await publisher.publish({
			...founderUtterance,
			transcriptId: "transcript-assistant",
			role: "assistant",
			source: "engine_audio",
			text: "我确认一下。",
			attribution: { kind: "unknown", reason: "engine_output" },
		});

		const texts = mirror.mock.calls.map(([input]) => input.text);
		expect(texts).toHaveLength(3);
		expect(texts[0]).toBe(
			"🎙️ **你（语音）**：你帮我去看一下2799现在是什么状态。",
		);
		expect(texts.every((text) => isVoiceMirrorText(text))).toBe(true);
	});

	it("registers each mirrored line's Discord id so the Bridge excludes it by source", async () => {
		const mirror = vi
			.fn()
			.mockResolvedValueOnce({ messageId: "100000000000000061" })
			.mockResolvedValueOnce({ messageId: "100000000000000062" });
		const recordMirror = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("voice_transcript_not_found"));
		const evidence = vi.fn();
		const publisher = new CodexTranscriptPublisher({
			sessionId: "session-a",
			founderUserId: "founder",
			displayName: "Raya",
			mirror,
			recordMirror,
			evidence,
		});
		await publisher.publish(founderUtterance);
		await publisher.publish({
			...founderUtterance,
			transcriptId: "transcript-not-durable",
		});

		expect(recordMirror.mock.calls).toEqual([
			[{ transcriptId: "transcript-a", messageId: "100000000000000061" }],
			[
				{
					transcriptId: "transcript-not-durable",
					messageId: "100000000000000062",
				},
			],
		]);
		// A failed registration is recorded, not thrown: the line is already
		// visible, and its mirror prefix still keeps the poller off it.
		expect(evidence).toHaveBeenCalledWith({
			kind: "codex_transcript_mirror_unregistered",
			transcriptId: "transcript-not-durable",
			messageId: "100000000000000062",
			reason: "voice_transcript_not_found",
		});
	});
});
