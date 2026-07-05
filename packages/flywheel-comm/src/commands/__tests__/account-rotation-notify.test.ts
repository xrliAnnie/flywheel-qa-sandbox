/**
 * FLY-696 M1/④ — account-rotation-notify: make a Codex per-runner account
 * rotation (flywheel-codex-with-fallback) visible in Alerts. Emits a DEDICATED
 * `account_rotation` event to the Bridge /events (NOT `artifact_emitted` —
 * Codex R1#4); the Bridge routes it to the unified Alerts channel.
 */
import { describe, expect, it, vi } from "vitest";
import { accountRotationNotify } from "../account-rotation-notify.js";

function okFetch() {
	return vi.fn(
		async () => ({ ok: true, status: 200, statusText: "OK" }) as never,
	);
}

describe("accountRotationNotify", () => {
	it("POSTs an account_rotation event to /events with the rotation payload", async () => {
		const fetchImpl = okFetch();
		const r = await accountRotationNotify({
			provider: "codex",
			from: "school",
			to: "personal",
			reason: "usage_limit",
			resetAt: "2026-07-06T14:00:00Z",
			bridgeUrl: "http://localhost:9876/",
			fetchImpl: fetchImpl as never,
			uuid: () => "evt-uuid",
		});
		expect(r.posted).toBe(true);
		expect(r.exitCode).toBe(0);
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("http://localhost:9876/events");
		const body = JSON.parse((init as { body: string }).body);
		expect(body.event_type).toBe("account_rotation");
		expect(body.source).toBe("flywheel-comm");
		expect(body.payload).toMatchObject({
			provider: "codex",
			from: "school",
			to: "personal",
			reason: "usage_limit",
			resetAt: "2026-07-06T14:00:00Z",
		});
	});

	it("throws when the bridge URL is missing (fail-closed)", async () => {
		const saved = process.env.FLYWHEEL_BRIDGE_URL;
		delete process.env.FLYWHEEL_BRIDGE_URL;
		try {
			await expect(
				accountRotationNotify({
					provider: "codex",
					to: "personal",
					reason: "usage_limit",
					fetchImpl: okFetch() as never,
				}),
			).rejects.toThrow(/bridge url/i);
		} finally {
			if (saved !== undefined) process.env.FLYWHEEL_BRIDGE_URL = saved;
		}
	});

	it("adds a Bearer token when an ingest token is provided", async () => {
		const fetchImpl = okFetch();
		await accountRotationNotify({
			provider: "codex",
			to: "personal",
			reason: "usage_limit",
			bridgeUrl: "http://localhost:9876",
			ingestToken: "secret-tok",
			fetchImpl: fetchImpl as never,
		});
		const [, init] = fetchImpl.mock.calls[0]!;
		expect(
			(init as { headers: Record<string, string> }).headers.Authorization,
		).toBe("Bearer secret-tok");
	});

	it("hard-bounds the POST with an abort signal (a hung Bridge never wedges the caller)", async () => {
		// Codex code R1 HIGH-1: the caller is the codex rotation retry loop.
		const fetchImpl = okFetch();
		await accountRotationNotify({
			provider: "codex",
			to: "personal",
			reason: "usage_limit",
			bridgeUrl: "http://localhost:9876",
			fetchImpl: fetchImpl as never,
		});
		const [, init] = fetchImpl.mock.calls[0]!;
		expect((init as { signal?: AbortSignal }).signal).toBeInstanceOf(
			AbortSignal,
		);
	});

	it("a timed-out POST is fail-loud (exitCode 2), never a hang or a throw", async () => {
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
			// Simulate the abort firing (as a real timeout would).
			const err = new Error("The operation was aborted due to timeout");
			err.name = "TimeoutError";
			void (init as { signal?: AbortSignal }).signal;
			throw err;
		});
		const r = await accountRotationNotify({
			provider: "codex",
			to: "personal",
			reason: "usage_limit",
			bridgeUrl: "http://localhost:9876",
			timeoutMs: 10,
			fetchImpl: fetchImpl as never,
		});
		expect(r.posted).toBe(false);
		expect(r.exitCode).toBe(2);
	});

	it("non-2xx → posted false, exitCode 2 (fail-loud, not a throw)", async () => {
		const fetchImpl = vi.fn(
			async () =>
				({ ok: false, status: 503, statusText: "Unavailable" }) as never,
		);
		const r = await accountRotationNotify({
			provider: "codex",
			to: "personal",
			reason: "usage_limit",
			bridgeUrl: "http://localhost:9876",
			fetchImpl: fetchImpl as never,
		});
		expect(r.posted).toBe(false);
		expect(r.exitCode).toBe(2);
	});
});
