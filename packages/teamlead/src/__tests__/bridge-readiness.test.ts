/**
 * FLY-109 — Bridge pane readiness hardening.
 *
 * Verifies waitForPaneMarker():
 *   - Returns {seen: true} as soon as marker appears in pane capture
 *   - Returns {seen: false} after timeout (downgrades to lease-only readiness)
 *   - Does NOT throw on timeout — correctness is owned by ack/retry in inbox-mcp
 *
 * This hardening only runs at Bridge startup / late-register (createLeadRuntime).
 * It does NOT cover the Lead restart/resume main scenario — per §3.0 of the plan,
 * that path is the sole responsibility of the ack/retry mechanism.
 */
import { describe, expect, it, vi } from "vitest";
import { waitForPaneMarker } from "../bridge/pane-readiness.js";

describe("waitForPaneMarker", () => {
	it("returns seen=true as soon as marker appears", async () => {
		const capture = vi
			.fn()
			.mockReturnValueOnce("Starting Claude Code...")
			.mockReturnValueOnce("Loading...")
			.mockReturnValueOnce(
				"Starting Claude Code...\nListening for channel messages from: flywheel-inbox\n> ",
			);

		const result = await waitForPaneMarker(
			"@42",
			"Listening for channel messages from:",
			5000,
			{ captureFn: capture, pollIntervalMs: 50 },
		);

		expect(result.seen).toBe(true);
		expect(result.elapsedMs).toBeGreaterThan(0);
		expect(capture).toHaveBeenCalledWith("@42");
	});

	it("returns seen=false after timeout without throwing", async () => {
		const capture = vi.fn().mockReturnValue("Starting Claude Code...");

		const result = await waitForPaneMarker(
			"@42",
			"Listening for channel messages from:",
			300, // short timeout for test speed
			{ captureFn: capture, pollIntervalMs: 50 },
		);

		expect(result.seen).toBe(false);
		expect(result.elapsedMs).toBeGreaterThanOrEqual(300);
		expect(capture.mock.calls.length).toBeGreaterThan(1);
	});

	it("returns seen=true on first poll if marker already present", async () => {
		const capture = vi
			.fn()
			.mockReturnValue(
				"REPL ready\nListening for channel messages from: flywheel-inbox\n",
			);

		const result = await waitForPaneMarker(
			"@42",
			"Listening for channel messages from:",
			5000,
			{ captureFn: capture, pollIntervalMs: 50 },
		);

		expect(result.seen).toBe(true);
		expect(capture).toHaveBeenCalledTimes(1);
	});

	it("treats capture errors as 'not yet seen' (non-throwing)", async () => {
		let callCount = 0;
		const capture = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				throw new Error("tmux: no such window");
			}
			if (callCount === 2) {
				return "Starting...";
			}
			return "Listening for channel messages from: flywheel-inbox";
		});

		const result = await waitForPaneMarker(
			"@42",
			"Listening for channel messages from:",
			5000,
			{ captureFn: capture, pollIntervalMs: 50 },
		);

		expect(result.seen).toBe(true);
	});

	it("polls at the configured interval", async () => {
		const capture = vi.fn().mockReturnValue("not-ready");
		const pollIntervalMs = 100;
		const timeoutMs = 350;

		await waitForPaneMarker("@42", "marker-never-seen", timeoutMs, {
			captureFn: capture,
			pollIntervalMs,
		});

		// Expect ~3-4 calls (350ms / 100ms + initial)
		expect(capture.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(capture.mock.calls.length).toBeLessThanOrEqual(6);
	});
});
