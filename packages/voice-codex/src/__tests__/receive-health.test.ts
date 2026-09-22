import { describe, expect, it, vi } from "vitest";
import {
	classifyReceiveFailure,
	ReceiveHealthTracker,
	VOICE_CODEX_RECEIVE_POLICY,
	voiceReceiveRuntimeEvidence,
} from "../receive-health.js";

describe("ReceiveHealthTracker", () => {
	it("pins the audited Discord DAVE policy", () => {
		expect(VOICE_CODEX_RECEIVE_POLICY).toEqual({
			daveEncryption: true,
			decryptionFailureTolerance: 36,
			debug: true,
		});
	});
	it("projects only fixed runtime and build fields into session evidence", () => {
		expect(
			voiceReceiveRuntimeEvidence({
				observedAt: "2026-09-18T20:00:00.000Z",
				buildSha: "a".repeat(40),
				runtime: {
					voiceVersion: "0.19.2",
					daveyVersion: "0.1.12",
					nodeVersion: "v22.0.0",
					arch: "arm64",
					daveEncryption: true,
					decryptionFailureTolerance: 36,
					debug: true,
				},
			}),
		).toEqual({
			ts: "2026-09-18T20:00:00.000Z",
			kind: "voice_receive_runtime",
			buildSha: "a".repeat(40),
			voiceVersion: "0.19.2",
			daveyVersion: "0.1.12",
			nodeVersion: "v22.0.0",
			arch: "arm64",
			daveEncryption: true,
			decryptionFailureTolerance: 36,
			debug: true,
		});
	});
	it("moves from an observed packet failure to receiving only after ten PCM frames", () => {
		const changed = vi.fn();
		const tracker = new ReceiveHealthTracker({
			now: () => new Date("2026-09-17T20:00:00.000Z"),
			onChange: changed,
		});

		expect(tracker.current()).toMatchObject({
			sequence: 1,
			state: "unknown",
			reason: "awaiting_audio",
		});
		tracker.fail("packet", new Error("Failed to decrypt: DecryptionFailed(x)"));
		expect(tracker.current()).toMatchObject({
			sequence: 2,
			state: "degraded",
			reason: "dave_decrypt",
			failures: 1,
		});
		tracker.retryAttempt();
		for (let frame = 0; frame < 9; frame += 1) tracker.pcmFrame();
		expect(tracker.current().state).toBe("degraded");
		tracker.pcmFrame();
		expect(tracker.current()).toEqual({
			version: 1,
			sequence: 4,
			state: "receiving",
			reason: "audio_observed",
			failures: 1,
			retries: 1,
			lastPcmAt: "2026-09-17T20:00:00.000Z",
		});
		expect(changed).toHaveBeenCalledTimes(3);
	});

	it("classifies decoder failures separately and marks retry exhaustion", () => {
		const tracker = new ReceiveHealthTracker();
		tracker.fail("decoder", new Error("bad opus"));
		expect(tracker.current().reason).toBe("opus_decode");
		tracker.exhausted();
		expect(tracker.current()).toMatchObject({
			state: "degraded",
			reason: "retry_exhausted",
		});
	});

	it("counts a speaking capture with no PCM as a receive failure", () => {
		const tracker = new ReceiveHealthTracker();
		tracker.noPcm();
		expect(tracker.current()).toMatchObject({
			state: "degraded",
			reason: "receive_no_pcm",
			failures: 1,
		});
	});
});

describe("classifyReceiveFailure", () => {
	it.each([
		["Failed to decrypt: DecryptionFailed(x)", "dave_decrypt"],
		["DecryptionFailed(UnencryptedWhenPassthroughDisabled)", "dave_decrypt"],
		["AEAD authentication failed", "receive_packet"],
		["Failed to parse packet", "receive_packet"],
		["RangeError: bad RTP", "receive_packet"],
		["arbitrary receive stream error", "receive_packet"],
	])("maps %s to %s without exposing raw text", (message, expected) => {
		expect(classifyReceiveFailure(new Error(message))).toBe(expected);
	});
});
