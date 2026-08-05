import { describe, expect, it, vi } from "vitest";
import { cleanupExactWorkflowTmuxWindow } from "../bridge/tmux-lookup.js";

const FINGERPRINT = "a".repeat(64);
const IDENTITY = {
	socketPath: "/tmp/flywheel.sock",
	serverStartTime: "123",
	windowId: "@7",
	executionId: "exec-1",
	launchGeneration: 2,
	launchFingerprint: FINGERPRINT,
};

describe("cleanupExactWorkflowTmuxWindow", () => {
	it("kills and verifies absence only after the full identity matches", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7\texec-1\t2\t${FINGERPRINT}\n`,
			})
			.mockResolvedValueOnce({ stdout: "" })
			.mockRejectedValueOnce(new Error("can't find window: @7"));
		expect(await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux)).toBe(
			"cleaned",
		);
		expect(runTmux.mock.calls[2]?.[0]).toEqual([
			"-S",
			"/tmp/flywheel.sock",
			"kill-window",
			"-t",
			"@7",
		]);
	});

	it("does not kill a window whose published fingerprint differs", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockResolvedValueOnce({
				stdout: `@7\texec-1\t2\t${"b".repeat(64)}\n`,
			});
		expect(await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux)).toBe(
			"present",
		);
		expect(runTmux).toHaveBeenCalledTimes(2);
	});

	it("treats a superseded server generation as proof the old window is absent", async () => {
		const runTmux = vi.fn().mockResolvedValueOnce({ stdout: "124\n" });
		expect(await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux)).toBe(
			"absent",
		);
		expect(runTmux).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the exact probe is indeterminate", async () => {
		const runTmux = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "123\n" })
			.mockRejectedValueOnce(new Error("tmux probe timeout"));
		expect(await cleanupExactWorkflowTmuxWindow(IDENTITY, runTmux)).toBe(
			"unknown",
		);
	});
});
