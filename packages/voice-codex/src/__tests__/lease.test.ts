import { describe, expect, it, vi } from "vitest";
import { BridgeVoiceClient, VoiceLease } from "../bridge-client.js";

describe("VoiceLease", () => {
	it("uses the request-send monotonic instant and fences every later side effect", () => {
		let mono = 100;
		const lease = new VoiceLease(() => mono);
		lease.install(100, 15_000, 2_000);
		expect(lease.deadline).toBe(13_100);
		mono = 13_099;
		expect(() => lease.assert()).not.toThrow();
		mono = 13_100;
		expect(() => lease.assert()).toThrow(/voice_lease_fenced/);
	});
});

describe("BridgeVoiceClient", () => {
	it("claims desired work and derives its hard deadline from leaseTtlMs", async () => {
		let mono = 200;
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ session: { sessionId: "session-a" } }), {
					status: 200,
				}),
			)
			.mockImplementationOnce(async () => {
				mono = 900;
				return new Response(
					JSON.stringify({
						state: "claimed",
						leaseToken: "lease-a",
						leaseTtlMs: 15_000,
						leaseExpiresAt: "2026-09-09T00:00:15.000Z",
						projection: { leadId: "raya" },
					}),
					{ status: 200 },
				);
			});
		const client = new BridgeVoiceClient({
			baseUrl: "http://bridge.test",
			token: "master",
			httpTimeoutMs: 2_000,
			fetchImpl,
			monoNow: () => mono,
		});
		expect(await client.desired()).toEqual({ sessionId: "session-a" });
		const claim = await client.claim("session-a", "boot-a");
		expect(claim.lease.deadline).toBe(13_200);
		expect(claim.projection).toEqual({ leadId: "raya" });
		expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({ Authorization: "Bearer master" }),
		});
	});

	it("renews a recovered lease before installing local authority", async () => {
		let mono = 500;
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			mono = 900;
			return new Response(
				JSON.stringify({
					state: "live",
					leaseTtlMs: 15_000,
					leaseExpiresAt: "2026-09-09T00:00:15.000Z",
				}),
				{ status: 200 },
			);
		});
		const client = new BridgeVoiceClient({
			baseUrl: "http://bridge.test",
			token: "master",
			httpTimeoutMs: 2_000,
			fetchImpl,
			monoNow: () => mono,
		});
		const recovered = await client.renewRecovered("session-a", "stale-token");
		expect(recovered.state).toBe("live");
		expect(recovered.lease.deadline).toBe(13_500);
		expect(() => recovered.lease.assert()).not.toThrow();
	});
});

describe("VoiceLease irreversible fencing", () => {
	it.each(["explicit", "expired", "expired-before-watchdog"])(
		"does not reinstall authority after %s fencing",
		(kind) => {
			let now = 0;
			const lease = new VoiceLease(() => now);
			lease.install(0, 15_000, 2_000);
			if (kind === "explicit") lease.fence();
			else {
				now = 13_000;
				if (kind === "expired")
					expect(() => lease.assert()).toThrow("voice_lease_fenced");
			}
			expect(() => lease.install(now, 15_000, 2_000)).toThrow(
				"voice_lease_fenced",
			);
			expect(() => lease.assert()).toThrow("voice_lease_fenced");
		},
	);
});
