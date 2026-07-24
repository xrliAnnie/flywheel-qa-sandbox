import { describe, expect, it, vi } from "vitest";
import { discoverTmuxTargetByExecutionId } from "../bridge/tmux-lookup.js";

describe("FLY-1374 tmux execution identity discovery", () => {
	it("returns the canonical base-session target for one marked window", async () => {
		const runTmux = vi.fn(async () => ({
			stdout: [
				"cmux-FLY-1374\t@42\texec-1",
				"runner-flywheel\t@42\texec-1",
				"runner-flywheel\t@43\texec-other",
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
			"#{session_name}\t#{window_id}\t#{@flywheel_exec_id}",
		]);
	});

	it("fails closed when one execution id marks multiple window ids", async () => {
		const runTmux = vi.fn(async () => ({
			stdout: [
				"runner-flywheel\t@42\texec-1",
				"runner-flywheel\t@99\texec-1",
			].join("\n"),
		}));

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", runTmux),
		).resolves.toEqual({ kind: "ambiguous" });
	});

	it("distinguishes missing identity from an indeterminate tmux read", async () => {
		await expect(
			discoverTmuxTargetByExecutionId("exec-1", async () => ({
				stdout: "runner-flywheel\t@42\texec-other\n",
			})),
		).resolves.toEqual({ kind: "missing" });

		await expect(
			discoverTmuxTargetByExecutionId("exec-1", async () => {
				throw new Error("tmux timed out");
			}),
		).resolves.toEqual({ kind: "indeterminate" });
	});
});
