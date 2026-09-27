/**
 * FLY-2885 — engine B's WebRTC leg hands Discord ready-made 48 kHz Opus
 * packets. makeCreateResource must declare them StreamType.Opus so
 * @discordjs/voice plays them as-is instead of probing or transcoding.
 */
import { describe, expect, it } from "vitest";
import { makeCreateResource } from "../bots/discordWiring.js";

describe("makeCreateResource — opus-stream sources (FLY-2885)", () => {
	it("opus-stream sources are declared StreamType.Opus so WebRTC Opus packets play without a transcode", () => {
		const calls: unknown[][] = [];
		const createResource = makeCreateResource({
			StreamType: { Raw: "raw-sentinel", Opus: "opus-sentinel" },
			createAudioResource: (...args: unknown[]) => {
				calls.push(args);
				return { resource: true };
			},
		});
		const stream = { fake: "object-mode opus packets" };
		createResource({ kind: "opus-stream", stream } as never);
		expect(calls).toHaveLength(1);
		expect(calls[0]![0]).toBe(stream);
		expect(calls[0]![1]).toEqual({ inputType: "opus-sentinel" });
	});
});
