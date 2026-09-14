import { afterEach, describe, expect, it, vi } from "vitest";
import { printBridgePressure } from "../bridge-pressure-snapshot.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("bounded Bridge pressure diagnostics", () => {
	it("prints one sanitized health summary", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					event_loop: { p99_ms: 45, max_ms: 200, episodes: 3 },
					outbound_pressure: {
						events: { response_closed_before_finish_total: 7 },
					},
					secret: "never-print-this",
				}),
			),
		);
		vi.stubGlobal("fetch", fetch);
		const log = vi.fn();
		await printBridgePressure("http://localhost:1234/", "qa-result", log);
		expect(fetch.mock.calls[0]?.[0]).toBe("http://localhost:1234/health");
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0]?.[0]).toMatch(
			/^\[qa-result\] bridge pressure: event_loop p99=45 max=200 episodes=3 closed_before_finish\(events\)=7 load1=/,
		);
		expect(log.mock.calls[0]?.[0]).not.toContain("never-print-this");
	});

	it.each(["headers", "body"])(
		"bounds a stalled %s to two seconds",
		async (phase) => {
			vi.useFakeTimers();
			vi.stubGlobal(
				"fetch",
				vi.fn(() =>
					phase === "headers"
						? new Promise(() => {})
						: Promise.resolve({ ok: true, json: () => new Promise(() => {}) }),
				),
			);
			const log = vi.fn();
			const pending = printBridgePressure(
				"http://localhost:1234",
				"stage",
				log,
			);
			await vi.advanceTimersByTimeAsync(2000);
			await pending;
			expect(log).toHaveBeenCalledTimes(1);
			expect(log.mock.calls[0]?.[0]).toContain("health unavailable");
		},
	);

	it("never throws even when the network and logger both fail", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		await expect(
			printBridgePressure("http://localhost:1234", "stage", () => {
				throw new Error("logger failed");
			}),
		).resolves.toBeUndefined();
	});
});
