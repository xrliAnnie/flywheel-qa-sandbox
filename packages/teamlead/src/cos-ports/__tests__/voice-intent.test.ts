import { describe, expect, it, vi } from "vitest";
import { createVoiceIntentPort } from "../voice-intent.js";

const MEETING_ID = "20000000-0000-4000-8000-000000000001";

function response(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("CoS voice intent port", () => {
	it("reports bridge_unreachable when the request cannot reach Bridge (G46)", async () => {
		const port = createVoiceIntentPort({
			bridgeUrl: "http://127.0.0.1:9876",
			tokenEnv: "VOICE_INGEST_TOKEN",
			env: { VOICE_INGEST_TOKEN: "token-a" },
			fetchImpl: vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		});
		await expect(
			port.voiceIntent({ meetingId: MEETING_ID, action: "start" }),
		).resolves.toEqual({ status: "unavailable", reason: "bridge_unreachable" });
	});

	it("starts with only the canonical meeting id", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			response(201, { status: "accepted", sessionId: "session-a" }),
		);
		const port = createVoiceIntentPort({
			bridgeUrl: "http://127.0.0.1:9876/",
			tokenEnv: "VOICE_INGEST_TOKEN",
			env: { VOICE_INGEST_TOKEN: "token-a" },
			fetchImpl,
		});
		await expect(
			port.voiceIntent({ meetingId: MEETING_ID, action: "start" }),
		).resolves.toEqual({ status: "accepted" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/voice/sessions",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ meetingId: MEETING_ID }),
			}),
		);
	});

	it("resolves the session by meeting before stop", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(200, { sessionId: "session-a" }))
			.mockResolvedValueOnce(response(200, { state: "ending" }));
		const port = createVoiceIntentPort({
			bridgeUrl: "http://127.0.0.1:9876",
			tokenEnv: "VOICE_INGEST_TOKEN",
			env: { VOICE_INGEST_TOKEN: "token-a" },
			fetchImpl,
		});
		await expect(
			port.voiceIntent({ meetingId: MEETING_ID, action: "stop" }),
		).resolves.toEqual({ status: "accepted" });
		expect(
			fetchImpl.mock.calls.map(([url, init]) => [url, init?.method]),
		).toEqual([
			[
				`http://127.0.0.1:9876/api/voice/sessions/by-meeting/${MEETING_ID}`,
				"GET",
			],
			["http://127.0.0.1:9876/api/voice/sessions/session-a/stop", "POST"],
		]);
	});

	it("maps missing configuration, transport errors, and non-2xx to unavailable", async () => {
		await expect(
			createVoiceIntentPort({
				bridgeUrl: "http://127.0.0.1:9876",
				tokenEnv: "VOICE_INGEST_TOKEN",
				env: {},
			}).voiceIntent({ meetingId: MEETING_ID, action: "start" }),
		).resolves.toEqual({ status: "unavailable", reason: "token_unset" });
		await expect(
			createVoiceIntentPort({
				bridgeUrl: "http://127.0.0.1:9876",
				tokenEnv: "VOICE_INGEST_TOKEN",
				env: { VOICE_INGEST_TOKEN: "token-a" },
				fetchImpl: vi.fn(async () =>
					response(403, { error: "voice_mode_not_enabled" }),
				),
			}).voiceIntent({ meetingId: MEETING_ID, action: "start" }),
		).resolves.toEqual({
			status: "unavailable",
			reason: "voice_mode_not_enabled",
		});
	});
});
