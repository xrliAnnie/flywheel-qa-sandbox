import { describe, expect, it, vi } from "vitest";
import {
	BridgeVoiceClient,
	BridgeVoiceHttpError,
	BridgeVoiceRequestError,
	VoiceLease,
} from "../bridge-client.js";

const LOOPBACK_URL = "http://127.0.0.1:9876";

function response(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function client(
	fetchImpl: typeof fetch,
	input: {
		idleHttpTimeoutMs?: number;
		httpTimeoutMs?: number;
		monoNow?: () => number;
	} = {},
): BridgeVoiceClient {
	return new BridgeVoiceClient({
		baseUrl: LOOPBACK_URL,
		token: "master-secret-token",
		httpTimeoutMs: input.httpTimeoutMs ?? 2_000,
		idleHttpTimeoutMs: input.idleHttpTimeoutMs ?? 2_000,
		fetchImpl,
		monoNow: input.monoNow,
	});
}

describe("BridgeVoiceClient desired response decoding", () => {
	it("accepts the exact desired envelope with null or a session id", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response('{"session":null}'))
			.mockResolvedValueOnce(
				response('{"session":{"sessionId":"session-a","state":"desired"}}'),
			);
		const bridge = client(fetchImpl);

		expect(await bridge.desired()).toBeNull();
		expect(await bridge.desired()).toEqual({
			sessionId: "session-a",
			state: "desired",
		});
	});

	it.each([
		["malformed JSON", "not-json"],
		["truncated JSON", '{"session":'],
		["an array", "[]"],
		["a missing session field", "{}"],
		["an extra top-level field", '{"session":null,"extra":true}'],
		["a scalar session", '{"session":"session-a"}'],
		["a missing session id", '{"session":{}}'],
		["an empty session id", '{"session":{"sessionId":""}}'],
	])(
		"rejects %s instead of treating it as idle success",
		async (_label, body) => {
			const bridge = client(
				vi.fn<typeof fetch>().mockResolvedValue(response(body)),
			);

			await expect(bridge.desired()).rejects.toMatchObject({
				diagnostic: {
					operation: "desired",
					method: "GET",
					routeTemplate: "/api/voice/sessions/desired",
					phase: "body",
					status: 200,
					reasonClass: "bridge_protocol_invalid",
				},
			});
		},
	);

	it("classifies a stalled response body as a body timeout", async () => {
		const body = new ReadableStream<Uint8Array>({ start() {} });
		const bridge = client(
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response(body, { status: 200 })),
			{ idleHttpTimeoutMs: 20 },
		);

		await expect(bridge.desired()).rejects.toMatchObject({
			diagnostic: {
				operation: "desired",
				phase: "body",
				status: 200,
				timeoutMs: 20,
				reasonClass: "bridge_timeout_body",
				causeCode: "request_timeout",
			},
		});
	});
});

describe("BridgeVoiceClient safe request diagnostics", () => {
	it("loads leased context and persists normalized utterances through master routes", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response('{"snapshotDigest":"digest"}'))
			.mockResolvedValueOnce(
				response('{"status":"inserted","receipt":{"transcriptId":"t-1"}}', 201),
			);
		const bridge = client(fetchImpl);
		const lease = new VoiceLease(() => 100);
		lease.install(100, 15_000, 2_000);
		expect(await bridge.context("session-a", "lease-a", lease)).toMatchObject({
			snapshotDigest: "digest",
		});
		expect(
			await bridge.recordUtterance("session-a", "lease-a", lease, {
				transcriptId: "t-1",
				utteranceId: "u-1",
				sessionGeneration: 1,
				sequence: 1,
				source: "room_audio",
				role: "user",
				text: "原话",
				final: true,
				attribution: { kind: "unknown", reason: "not_bound" },
				captureDigest: "a".repeat(64),
			}),
		).toMatchObject({ receipt: { transcriptId: "t-1" } });
		expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
			`${LOOPBACK_URL}/api/voice/sessions/session-a/context`,
			`${LOOPBACK_URL}/api/voice/sessions/session-a/utterances`,
		]);
		const utteranceRequest = fetchImpl.mock.calls[1]?.[1];
		expect(utteranceRequest?.headers).toMatchObject({
			Authorization: "Bearer master-secret-token",
			"X-Voice-Lease": "lease-a",
		});
		expect(JSON.parse(String(utteranceRequest?.body))).not.toHaveProperty(
			"sessionId",
		);
	});

	it("reports a closed diagnostic envelope without raw request or error data", async () => {
		let mono = 100;
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			mono = 145;
			throw new Error(
				"Bearer master-secret-token /api/voice/sessions/private-session/claim private transcript",
			);
		});
		const bridge = client(fetchImpl, { monoNow: () => mono });

		const error = await bridge
			.claim("private-session", "private-boot")
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BridgeVoiceRequestError);
		expect(error).toMatchObject({
			diagnostic: {
				operation: "claim",
				method: "POST",
				routeTemplate: "/api/voice/sessions/:sessionId/claim",
				requestId: expect.any(String),
				elapsedMs: 45,
				phase: "headers",
				timeoutMs: 2_000,
				reasonClass: "unknown_failure",
				causeCode: "unknown_error",
			},
		});
		expect(
			(error as Error & { diagnostic: unknown }).diagnostic,
		).not.toHaveProperty("status");
		const visible = `${(error as Error).message} ${JSON.stringify(
			(error as Error & { diagnostic: unknown }).diagnostic,
		)}`;
		for (const secret of [
			"master-secret-token",
			"private-session",
			"private-boot",
			"private transcript",
			"/api/voice/sessions/private-session/claim",
		]) {
			expect(visible).not.toContain(secret);
		}
	});

	it("does not copy an HTTP error body into the diagnostic or message", async () => {
		const bridge = client(
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					response(
						'{"error":"Bearer body-secret","reason":"private transcript"}',
						503,
					),
				),
		);

		const error = await bridge.desired().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BridgeVoiceHttpError);
		expect(error).toMatchObject({
			status: 503,
			diagnostic: {
				operation: "desired",
				phase: "body",
				status: 503,
				reasonClass: "bridge_http_error",
				causeCode: "http_5xx",
			},
		});
		expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toMatch(
			/body-secret|private transcript/u,
		);
	});

	it.each([
		["desired", "GET", "/api/voice/sessions/desired"],
		["claim", "POST", "/api/voice/sessions/:sessionId/claim"],
		["renew", "POST", "/api/voice/sessions/:sessionId/renew"],
		["state", "POST", "/api/voice/sessions/:sessionId/state"],
		["outbound", "GET", "/api/voice/sessions/:sessionId/outbound"],
		["receipt", "POST", "/api/voice/sessions/:sessionId/outbound/:seq/receipt"],
	] as const)(
		"labels %s failures with the normalized route",
		async (operation, method, routeTemplate) => {
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockRejectedValue(new TypeError("secret network detail"));
			const bridge = client(fetchImpl);
			const lease = new VoiceLease(() => 100);
			lease.install(100, 15_000, 2_000);
			const call = {
				desired: () => bridge.desired(),
				claim: () => bridge.claim("private-session", "private-boot"),
				renew: () => bridge.renewRecovered("private-session", "private-lease"),
				state: () =>
					bridge.setState("private-session", "private-lease", lease, "failed"),
				outbound: () =>
					bridge.outbound("private-session", "private-lease", lease),
				receipt: () =>
					bridge.receipt(
						"private-session",
						7,
						"private-lease",
						lease,
						"private-attempt",
						"failed",
					),
			}[operation];

			await expect(call()).rejects.toMatchObject({
				diagnostic: { operation, method, routeTemplate },
			});
		},
	);

	it("uses the idle timeout only for desired and keeps the lease timeout", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			const signal = init?.signal;
			if (!(signal instanceof AbortSignal)) throw new Error("missing signal");
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new DOMException("timed out", "AbortError");
		});
		const bridge = client(fetchImpl, {
			idleHttpTimeoutMs: 20,
			httpTimeoutMs: 60,
		});

		await expect(bridge.desired()).rejects.toMatchObject({
			diagnostic: { timeoutMs: 20 },
		});
		await expect(bridge.claim("session-a", "boot-a")).rejects.toMatchObject({
			diagnostic: { timeoutMs: 60 },
		});
	});

	it.each([
		"https://bridge.example.com",
		"ftp://127.0.0.1:9876",
		"http://user:pass@127.0.0.1:9876",
		"http://127.0.0.1:9876?token=secret",
		"http://127.0.0.1:9876/#private",
	])(
		"rejects unsafe base URL %s before a request can use the token",
		(baseUrl) => {
			const fetchImpl = vi.fn<typeof fetch>();

			expect(
				() =>
					new BridgeVoiceClient({
						baseUrl,
						token: "master-secret-token",
						httpTimeoutMs: 2_000,
						idleHttpTimeoutMs: 2_000,
						fetchImpl,
					}),
			).toThrow("voice_bridge_url_invalid");
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
});
