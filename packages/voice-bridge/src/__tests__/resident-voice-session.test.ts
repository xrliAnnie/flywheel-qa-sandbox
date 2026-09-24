import { describe, expect, it, vi } from "vitest";
import { ResidentVoiceSessionClient } from "../resident-voice-session.js";

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("ResidentVoiceSessionClient", () => {
	it("bounds blackholed claim and renew requests with the configured timeout", async () => {
		const blackhole = (_url: unknown, init?: RequestInit) => {
			if (!init?.signal)
				return Promise.reject(
					new Error("missing resident request abort signal"),
				);
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true },
				);
			});
		};
		const options = {
			bridgeUrl: "http://127.0.0.1:9876",
			apiToken: "master-token",
			projectName: "flywheel",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			outputBotUserId: "100000000000000003",
			earsBotUserId: "100000000000000004",
			ownerBootId: "boot-1",
			requestTimeoutMs: 10,
			selfFilterProof: () => ({
				outputBotDropped: true,
				earsBotDropped: true,
				unknownDropped: true,
				allowedHumanPassed: true,
			}),
		};

		const claimClient = new ResidentVoiceSessionClient({
			...options,
			fetchImpl: vi.fn(blackhole) as typeof fetch,
		});
		await expect(
			claimClient.claim({
				requestId: "claim-timeout",
				mode: "rg",
				leadId: "lead-a",
			}),
		).rejects.toThrow("resident_voice_claim_timeout:10ms");

		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					status: "inserted",
					sessionId: "session-renew",
					state: "claimed",
					carrierKind: "resident",
					ownerBootId: "boot-1",
					sessionGeneration: 1,
					leaseToken: "lease-renew",
					leaseTtlMs: 15_000,
					leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(),
				}),
			)
			.mockImplementationOnce(blackhole);
		const renewClient = new ResidentVoiceSessionClient({
			...options,
			fetchImpl: fetchImpl as typeof fetch,
		});
		const lease = await renewClient.claim({
			requestId: "renew-timeout",
			mode: "rg",
			leadId: "lead-a",
		});
		await expect(lease.renew()).rejects.toThrow(
			"resident_voice_renew_timeout:10ms",
		);
		expect(() => lease.assertActive()).toThrow("resident_voice_lease_lost");
	});

	it("claims one trusted generation, refreshes its proof on renew, and ends it with the same owner", async () => {
		let now = Date.parse("2026-09-23T20:00:00.000Z");
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				response(
					{
						status: "inserted",
						sessionId: "session-1",
						state: "claimed",
						carrierKind: "resident",
						ownerBootId: "boot-1",
						sessionGeneration: 1,
						leaseToken: "lease-1",
						leaseTtlMs: 15_000,
						leaseExpiresAt: "2026-09-23T20:00:15.000Z",
					},
					201,
				),
			)
			.mockResolvedValueOnce(
				response({
					state: "claimed",
					leaseTtlMs: 15_000,
					leaseExpiresAt: "2026-09-23T20:00:20.000Z",
				}),
			)
			.mockResolvedValueOnce(response({ state: "ended" }));
		const client = new ResidentVoiceSessionClient({
			bridgeUrl: "http://127.0.0.1:9876",
			apiToken: "master-token",
			projectName: "flywheel",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			outputBotUserId: "100000000000000003",
			earsBotUserId: "100000000000000004",
			ownerBootId: "boot-1",
			proofTtlMs: 60_000,
			selfFilterProof: () => ({
				outputBotDropped: true,
				earsBotDropped: true,
				unknownDropped: true,
				allowedHumanPassed: true,
			}),
			fetchImpl: fetchImpl as typeof fetch,
			now: () => now,
		});

		const lease = await client.claim({
			requestId: "request-1",
			mode: "meeting",
			leadId: "lead-a",
		});
		expect(lease).toMatchObject({
			mode: "meeting",
			sessionId: "session-1",
			sessionGeneration: 1,
			leaseToken: "lease-1",
		});
		const claimInit = fetchImpl.mock.calls[0]![1] as RequestInit;
		expect(JSON.parse(String(claimInit.body))).toMatchObject({
			requestId: "request-1",
			projectName: "flywheel",
			leadId: "lead-a",
			ownerBootId: "boot-1",
			sessionGeneration: 1,
			bindingProof: {
				outputBotUserId: "100000000000000003",
				earsBotUserId: "100000000000000004",
				outputBotDropped: true,
				allowedHumanPassed: true,
			},
		});

		now += 5_000;
		await lease.renew();
		const renewInit = fetchImpl.mock.calls[1]![1] as RequestInit;
		expect(JSON.parse(String(renewInit.body))).toMatchObject({
			ownerBootId: "boot-1",
			sessionGeneration: 1,
			bindingProof: { observedAt: "2026-09-23T20:00:05.000Z" },
		});
		expect(() => lease.assertActive()).not.toThrow();
		await lease.close("ended");
		const closeInit = fetchImpl.mock.calls[2]![1] as RequestInit;
		expect(JSON.parse(String(closeInit.body))).toMatchObject({
			state: "ended",
			ownerBootId: "boot-1",
			sessionGeneration: 1,
		});
		expect(() => lease.assertActive()).toThrow("resident_voice_lease_lost");
	});

	it("reuses an in-flight request and permanently fences a failed renew", async () => {
		let resolveClaim!: (value: Response) => void;
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<Response>((resolve) => {
						resolveClaim = resolve;
					}),
			)
			.mockResolvedValueOnce(response({ error: "voice_lease_conflict" }, 409));
		const client = new ResidentVoiceSessionClient({
			bridgeUrl: "http://127.0.0.1:9876",
			apiToken: "master-token",
			projectName: "flywheel",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
			outputBotUserId: "100000000000000003",
			earsBotUserId: "100000000000000004",
			ownerBootId: "boot-1",
			selfFilterProof: () => ({
				outputBotDropped: true,
				earsBotDropped: true,
				unknownDropped: true,
				allowedHumanPassed: true,
			}),
			fetchImpl: fetchImpl as typeof fetch,
		});
		const input = { requestId: "same", mode: "rg" as const, leadId: "lead-a" };
		const first = client.claim(input);
		const replay = client.claim(input);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		resolveClaim(
			response({
				status: "inserted",
				sessionId: "session-1",
				state: "claimed",
				carrierKind: "resident",
				ownerBootId: "boot-1",
				sessionGeneration: 1,
				leaseToken: "lease-1",
				leaseTtlMs: 15_000,
				leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(),
			}),
		);
		const [a, b] = await Promise.all([first, replay]);
		expect(a).toBe(b);
		await expect(a.renew()).rejects.toThrow("resident_voice_renew_failed:409");
		expect(() => a.assertActive()).toThrow("resident_voice_lease_lost");
	});
});
