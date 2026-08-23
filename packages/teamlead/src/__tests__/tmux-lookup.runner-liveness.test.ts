/**
 * FLY-720: unit coverage for the pane_dead-aware runner PROCESS liveness probe
 * and the crash-forensics scrollback capture. Uses the `TmuxRunner` seam so no
 * real tmux server is needed (a real-tmux spike lives in the real-tmux suite).
 */
import { describe, expect, it, vi } from "vitest";
import {
	captureRunnerScrollback,
	probeRunnerProcessLiveness,
	probeRunnerProcessLivenessDetailed,
	probeTmuxServerStartTime,
	type TmuxRunner,
} from "../bridge/tmux-lookup.js";

describe("probeTmuxServerStartTime (FLY-1628)", () => {
	it("reads the selected socket's native tmux start_time", async () => {
		const runner = vi.fn<TmuxRunner>(async () => ({ stdout: "1722700000\n" }));
		expect(
			await probeTmuxServerStartTime("/tmp/tmux-501/default", runner),
		).toEqual({ kind: "found", startTime: "1722700000" });
		expect(runner).toHaveBeenCalledWith([
			"-S",
			"/tmp/tmux-501/default",
			"display-message",
			"-p",
			"#{start_time}",
		]);
	});

	it("fails closed on command errors or malformed native output", async () => {
		expect(
			await probeTmuxServerStartTime("/tmp/tmux-501/default", async () => {
				throw new Error("timeout");
			}),
		).toEqual({ kind: "indeterminate" });
		expect(
			await probeTmuxServerStartTime("/tmp/tmux-501/default", async () => ({
				stdout: "not-a-time",
			})),
		).toEqual({ kind: "indeterminate" });
	});
});

describe("probeRunnerProcessLiveness (FLY-720)", () => {
	it("preserves liveness while exposing timeout evidence at the tmux boundary", async () => {
		const timeout = Object.assign(new Error("Command timed out after 5000ms"), {
			code: "ETIMEDOUT",
			killed: true,
			signal: "SIGTERM",
		});
		const runner: TmuxRunner = async () => {
			throw timeout;
		};
		const result = await probeRunnerProcessLivenessDetailed("R:@1", runner);
		expect(result).toMatchObject({
			liveness: "indeterminate",
			failure: {
				stage: "tmux-throw",
				errorType: "Error",
				message: "Command timed out after 5000ms",
				timedOut: true,
			},
		});
		expect(result.failure?.durationMs).toBeGreaterThanOrEqual(0);
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe(
			"indeterminate",
		);
	});

	it("keeps proved absence distinct from probe failure", async () => {
		const runner: TmuxRunner = async () => {
			throw new Error("can't find window: R:@1");
		};
		expect(await probeRunnerProcessLivenessDetailed("R:@1", runner)).toEqual({
			liveness: "absent",
		});
	});

	it("reports empty output as probe_unclear evidence without changing the verdict", async () => {
		const runner: TmuxRunner = async () => ({ stdout: " \n" });
		const result = await probeRunnerProcessLivenessDetailed("R:@1", runner);
		expect(result).toMatchObject({
			liveness: "indeterminate",
			failure: {
				stage: "empty-output",
				errorType: "EmptyOutput",
				timedOut: false,
			},
		});
		expect(result.failure?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("returns ordinary live-pane evidence without a failure payload", async () => {
		const runner: TmuxRunner = async () => ({ stdout: "0\n" });
		expect(await probeRunnerProcessLivenessDetailed("R:@1", runner)).toEqual({
			liveness: "alive",
		});
	});

	it("returns dead_pin when the window exists and every pane is a corpse", async () => {
		const runner: TmuxRunner = async () => ({ stdout: "1\n" });
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe("dead_pin");
	});

	it("returns dead_pin for a multi-pane window where all panes are dead", async () => {
		const runner: TmuxRunner = async () => ({ stdout: "1\n1\n1\n" });
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe("dead_pin");
	});

	it("returns alive when any pane is still live", async () => {
		const runner: TmuxRunner = async () => ({ stdout: "1\n0\n" });
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe("alive");
	});

	it("returns alive for a single live pane", async () => {
		const runner: TmuxRunner = async () => ({ stdout: "0\n" });
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe("alive");
	});

	it("returns absent when tmux proves the window is gone", async () => {
		const runner: TmuxRunner = async () => {
			throw new Error("can't find window: R:@1");
		};
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe("absent");
	});

	it("returns absent when there is no tmux server", async () => {
		const runner: TmuxRunner = async () => {
			throw new Error("no server running on /tmp/tmux-501/default");
		};
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe("absent");
	});

	it("returns indeterminate on a transient/timeout error (GEO-374 fail-closed)", async () => {
		const runner: TmuxRunner = async () => {
			throw new Error("Command failed: timeout");
		};
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe(
			"indeterminate",
		);
	});

	it("returns indeterminate on empty/unparseable output", async () => {
		const runner: TmuxRunner = async () => ({ stdout: "   \n" });
		expect(await probeRunnerProcessLiveness("R:@1", runner)).toBe(
			"indeterminate",
		);
	});

	it("queries #{pane_dead} for the given window", async () => {
		const runner = vi.fn<TmuxRunner>(async () => ({ stdout: "1\n" }));
		await probeRunnerProcessLiveness("RUN:@42", runner);
		expect(runner).toHaveBeenCalledWith([
			"list-panes",
			"-t",
			"RUN:@42",
			"-F",
			"#{pane_dead}",
		]);
	});
});

describe("captureRunnerScrollback (FLY-720)", () => {
	it("returns the captured scrollback text on success", async () => {
		const runner: TmuxRunner = async () => ({
			stdout: "line1\nCRASH TRACE\nline3\n",
		});
		const r = await captureRunnerScrollback("R:@1", runner);
		expect(r).toEqual({ ok: true, text: "line1\nCRASH TRACE\nline3\n" });
	});

	it("captures full history from the window pane", async () => {
		const runner = vi.fn<TmuxRunner>(async () => ({ stdout: "x" }));
		await captureRunnerScrollback("RUN:@7", runner);
		expect(runner).toHaveBeenCalledWith([
			"capture-pane",
			"-t",
			"RUN:@7",
			"-p",
			"-S",
			"-",
		]);
	});

	it("returns an error result (never throws) when capture fails", async () => {
		const runner: TmuxRunner = async () => {
			throw new Error("can't find window");
		};
		const r = await captureRunnerScrollback("R:@1", runner);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("can't find window");
	});
});
