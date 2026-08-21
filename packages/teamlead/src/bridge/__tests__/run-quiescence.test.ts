import { describe, expect, it, vi } from "vitest";
import { probeRunExecutionLiveness } from "../run-quiescence.js";

describe("FLY-1940 run quiescence production policy", () => {
	it("vetoes dead when a codex daemon is alive after CommDB/tmux teardown", async () => {
		const genericProbe = vi.fn(async () => "dead" as const);
		await expect(
			probeRunExecutionLiveness(
				{ adapter_type: "codex-tmux" },
				"exec-1",
				"flywheel",
				{
					probeCodexDaemon: async () => "alive",
					probeGeneric: genericProbe,
				},
			),
		).resolves.toBe("alive");
		expect(genericProbe).not.toHaveBeenCalled();
	});

	it("keeps an indeterminate codex group fail-closed even when generic host evidence says dead", async () => {
		await expect(
			probeRunExecutionLiveness(
				{ adapter_type: "codex-tmux" },
				"exec-1",
				"flywheel",
				{
					probeCodexDaemon: async () => "unknown",
					probeGeneric: async () => "dead",
				},
			),
		).resolves.toBe("unknown");
	});

	it("allows dead only after codex daemon absence plus tmux/host absence", async () => {
		const probeGeneric = vi.fn(async () => "dead" as const);
		await expect(
			probeRunExecutionLiveness(
				{ adapter_type: "codex-tmux" },
				"exec-1",
				"flywheel",
				{
					probeCodexDaemon: async () => "absent",
					probeGeneric,
				},
			),
		).resolves.toBe("dead");
		expect(probeGeneric).toHaveBeenCalledWith("exec-1", "flywheel", {
			allowMissingTargetHostAbsence: true,
		});
	});

	it("keeps injected two-argument probes assignable for tests and callers", async () => {
		const probeGeneric = vi.fn(async () => "alive" as const);
		await expect(
			probeRunExecutionLiveness(
				{ adapter_type: "claude-code" },
				"exec-2",
				"flywheel",
				{ probeGeneric },
			),
		).resolves.toBe("alive");
	});
});
