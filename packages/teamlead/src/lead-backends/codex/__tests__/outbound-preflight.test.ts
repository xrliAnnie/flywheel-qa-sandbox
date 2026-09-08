import { describe, expect, it, vi } from "vitest";
import {
	type ProbeResult,
	runOutboundPreflight,
} from "../outbound-preflight.js";

describe("runOutboundPreflight (FLY-2442)", () => {
	it("deduplicates channels, probes them concurrently, and reports authorization", async () => {
		const releases: Array<() => void> = [];
		const probe = vi.fn(
			() =>
				new Promise<ProbeResult>((resolve) => {
					releases.push(() => resolve({ state: "authorized" }));
				}),
		);
		const log = { info: vi.fn(), warn: vi.fn() };
		const pending = runOutboundPreflight({
			probe,
			channelIds: ["chat", "roundtable", "chat"],
			log,
		});
		await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
		expect(probe.mock.calls.map(([channelId]) => channelId)).toEqual([
			"chat",
			"roundtable",
		]);
		releases.forEach((release) => release());

		await expect(pending).resolves.toBe("authorized");
		expect(log.info).toHaveBeenCalledWith(
			"lead-outbound preflight: authorized chat,roundtable",
		);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("throws on 403 without retrying or falling back to direct", async () => {
		const probe = vi.fn(async () => ({
			state: "unauthorized" as const,
			status: 403 as const,
			reason: "lead_channel_unauthorized",
		}));
		const sleep = vi.fn(async () => {});

		await expect(
			runOutboundPreflight({
				probe,
				channelIds: ["roundtable"],
				sleep,
				log: { info: vi.fn(), warn: vi.fn() },
			}),
		).rejects.toThrow(
			/roundtable.*403 lead_channel_unauthorized.*no fallback to direct/i,
		);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("throws on an incompatible Bridge with HTTP status and reason", async () => {
		await expect(
			runOutboundPreflight({
				probe: async () => ({
					state: "incompatible",
					status: 400,
					reason: "text_required",
				}),
				channelIds: ["chat"],
				log: { info: vi.fn(), warn: vi.fn() },
			}),
		).rejects.toThrow(/chat.*HTTP 400 text_required.*no fallback to direct/i);
	});

	it("prioritizes a deterministic failure over unavailable peers in the same round", async () => {
		const probe = vi.fn(
			async (channelId: string): Promise<ProbeResult> =>
				channelId === "chat"
					? { state: "unavailable", status: 503, reason: "restart" }
					: { state: "incompatible", status: 401, reason: "unauthorized" },
		);

		await expect(
			runOutboundPreflight({
				probe,
				channelIds: ["chat", "roundtable"],
				log: { info: vi.fn(), warn: vi.fn() },
			}),
		).rejects.toThrow(/roundtable.*HTTP 401 unauthorized/i);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("retries only unavailable results, then warns and continues in bridge mode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const starts: number[] = [];
		const probe = vi.fn(async (): Promise<ProbeResult> => {
			starts.push(Date.now());
			await new Promise((resolve) => setTimeout(resolve, 5_000));
			return {
				state: "unavailable",
				status: 503,
				reason: "bridge_restart",
			};
		});
		const sleep = vi.fn(
			(ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		);
		const log = { info: vi.fn(), warn: vi.fn() };
		try {
			const pending = runOutboundPreflight({
				probe,
				channelIds: ["chat", "roundtable"],
				attempts: 4,
				delayMs: 10_000,
				sleep,
				log,
			});
			await vi.runAllTimersAsync();

			await expect(pending).resolves.toBe("skipped");
			expect(starts).toEqual([
				0, 0, 15_000, 15_000, 30_000, 30_000, 45_000, 45_000,
			]);
			expect(Date.now()).toBe(50_000);
			expect(probe).toHaveBeenCalledTimes(8);
			expect(sleep).toHaveBeenCalledTimes(3);
			expect(sleep).toHaveBeenCalledWith(10_000);
			expect(log.warn).toHaveBeenCalledWith(
				expect.stringMatching(/unavailable.*bridge mode remains enabled/i),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
