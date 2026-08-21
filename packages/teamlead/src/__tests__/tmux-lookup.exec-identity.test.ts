import { describe, expect, it, vi } from "vitest";
import {
	discoverTmuxTargetByExecutionId,
	isTmuxWindowAlive,
	killTmuxWindow,
	probeTmuxWindowLiveness,
	sendKeysToWindow,
} from "../bridge/tmux-lookup.js";

describe("FLY-1374 tmux execution identity discovery", () => {
	it("discovers identity when tmux sanitizes control-character separators", async () => {
		const runTmux = vi.fn(async (args: string[]) => {
			const format = args.at(-1) ?? "";
			const separator = format.includes("|") ? "|" : "_";
			return {
				stdout: ["runner-flywheel", "@42", "exec-1"].join(separator),
			};
		});

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", runTmux),
		).resolves.toEqual({
			kind: "found",
			tmuxWindow: "runner-flywheel:@42",
		});
	});

	it("returns the canonical base-session target for one marked window", async () => {
		const runTmux = vi.fn(async () => ({
			stdout: [
				"cmux-FLY-1374|@42|exec-1",
				"runner-flywheel|@42|exec-1",
				"runner-flywheel|@43|exec-other",
			].join("\n"),
		}));

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", runTmux),
		).resolves.toEqual({
			kind: "found",
			tmuxWindow: "runner-flywheel:@42",
		});
		expect(runTmux).toHaveBeenCalledWith([
			"list-windows",
			"-a",
			"-F",
			"#{session_name}|#{window_id}|#{@flywheel_exec_id}",
		]);
	});

	it("fails closed when one execution id marks multiple window ids", async () => {
		const runTmux = vi.fn(async () => ({
			stdout: ["runner-flywheel|@42|exec-1", "runner-flywheel|@99|exec-1"].join(
				"\n",
			),
		}));

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", runTmux),
		).resolves.toEqual({ kind: "ambiguous" });
	});

	it("distinguishes missing identity from an indeterminate tmux read", async () => {
		await expect(
			discoverTmuxTargetByExecutionId("exec-1", async () => ({
				stdout: "runner-flywheel|@42|exec-other\n",
			})),
		).resolves.toEqual({ kind: "missing" });

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", async () => {
				throw new Error("tmux timed out");
			}),
		).resolves.toEqual({ kind: "indeterminate" });
	});

	it("treats :pending as routing metadata with zero tmux mutation authority", async () => {
		await expect(probeTmuxWindowLiveness("runner:pending")).resolves.toBe(
			"indeterminate",
		);
		await expect(isTmuxWindowAlive("runner:pending")).resolves.toBe(false);
		await expect(killTmuxWindow("runner:pending")).resolves.toEqual({
			killed: false,
			error: "tmux window identity is still pending",
		});
		await expect(
			sendKeysToWindow("runner:pending", "continue"),
		).resolves.toEqual({
			sent: false,
			error: "tmux window identity is still pending",
		});
	});
});
