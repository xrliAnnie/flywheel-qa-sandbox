/**
 * FLY-720: unit coverage for the pane_dead-aware runner PROCESS liveness probe
 * and the crash-forensics scrollback capture. Uses the `TmuxRunner` seam so no
 * real tmux server is needed (a real-tmux spike lives in the real-tmux suite).
 */
import { describe, expect, it, vi } from "vitest";
import {
	captureRunnerScrollback,
	probeRunnerProcessLiveness,
	type TmuxRunner,
} from "../bridge/tmux-lookup.js";

describe("probeRunnerProcessLiveness (FLY-720)", () => {
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
