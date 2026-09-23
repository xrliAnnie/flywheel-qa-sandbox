import { describe, expect, it } from "vitest";
import {
	assertStartedMatchesConfig,
	buildInputAudioAppend,
	buildSessionStart,
	type OpenAiLiveSessionConfig,
	parseLiveServerEvent,
} from "../backends/openai-live/liveProtocol.js";
import type { VoiceError } from "../types.js";

const config: OpenAiLiveSessionConfig = {
	model: "gpt-live-1",
	instructions: "Answer simple questions. Delegate work that needs the Lead.",
	voice: "marin",
	delegation: "client",
	audio: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
};

describe("OpenAI Live wire protocol", () => {
	it("builds the public Live session.start shape", () => {
		expect(buildSessionStart(config, "evt-1")).toEqual({
			type: "session.start",
			event_id: "evt-1",
			session: {
				model: "gpt-live-1",
				instructions:
					"Answer simple questions. Delegate work that needs the Lead.",
				audio: {
					format: { type: "audio/pcm", rate: 24_000 },
					output: { voice: "marin" },
				},
				delegation: { type: "client" },
			},
		});
	});

	it("encodes each input chunk without buffering the utterance", () => {
		expect(buildInputAudioAppend(Buffer.from([0, 1, 2, 3]), "evt-2")).toEqual({
			type: "session.input_audio.append",
			event_id: "evt-2",
			audio: "AAECAw==",
		});
	});

	it("accepts only the configured started handshake", () => {
		const started = parseLiveServerEvent(
			JSON.stringify({
				type: "session.started",
				event_id: "srv-1",
				session: {
					id: "live_123",
					model: "gpt-live-1",
					status: "active",
					audio: { format: { type: "audio/pcm", rate: 24_000 } },
					delegation: { type: "client" },
				},
			}),
		);

		expect(() => assertStartedMatchesConfig(started, config)).not.toThrow();
		expect(() =>
			assertStartedMatchesConfig(started, { ...config, model: "other" }),
		).toThrow(/model mismatch/);
	});

	it("decodes the first output audio delta immediately", () => {
		const event = parseLiveServerEvent({
			type: "session.output_audio.delta",
			delta: Buffer.from([4, 5, 6]).toString("base64"),
		});
		expect(event).toEqual({
			type: "output-audio",
			chunk: Buffer.from([4, 5, 6]),
			format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
		});
	});

	it("keeps delegation identity metadata separate from business identity", () => {
		expect(
			parseLiveServerEvent({
				type: "session.delegation.created",
				offset_ms: 840,
				delegation: {
					id: "dlg-provider-1",
					type: "delegation",
					target: "client",
				},
			}),
		).toEqual({
			type: "delegation-created",
			delegationId: "dlg-provider-1",
			target: "client",
			offsetMs: 840,
		});
	});

	it("does not invent an output-done event for unknown server messages", () => {
		expect(parseLiveServerEvent({ type: "session.output_audio.done" })).toEqual(
			{ type: "ignored", serverType: "session.output_audio.done" },
		);
	});

	it.each([
		["invalid JSON", "{"],
		[
			"invalid base64",
			{ type: "session.output_audio.delta", delta: "not base64!" },
		],
		[
			"non-client delegation",
			{
				type: "session.delegation.created",
				delegation: { id: "dlg-1", type: "delegation", target: "hosted" },
			},
		],
		[
			"wrong delegation object type",
			{
				type: "session.delegation.created",
				delegation: { id: "dlg-1", type: "tool", target: "client" },
			},
		],
	])("rejects %s as a protocol error", (_name, raw) => {
		let error: unknown;
		try {
			parseLiveServerEvent(raw);
		} catch (caught) {
			error = caught;
		}
		expect((error as VoiceError).code).toBe("backend-protocol");
	});
});
