import { describe, expect, it, vi } from "vitest";
import { probePatrolProcessLiveness } from "../patrol-process-liveness.js";

describe("FLY-1925 patrol process liveness", () => {
	it("reports a registered live tmux pane as alive", async () => {
		const probe = vi.fn(async () => "alive" as const);

		await expect(
			probePatrolProcessLiveness("exec-live", "flywheel", {
				lookup: () => ({
					kind: "found",
					target: { tmuxWindow: "FLY-1925:@1", sessionName: "FLY-1925" },
				}),
				probe,
			}),
		).resolves.toBe("alive");
		expect(probe).toHaveBeenCalledWith("FLY-1925:@1");
	});

	it("discovers a live execution marker before judging a pending CommDB target", async () => {
		const discover = vi.fn(async () => ({
			kind: "found" as const,
			tmuxWindow: "FLY-1925:@7",
		}));
		const probe = vi.fn(async () => "alive" as const);
		const hasHostProcess = vi.fn(async () => false);

		await expect(
			probePatrolProcessLiveness("exec-pending", "flywheel", {
				lookup: () => ({
					kind: "found",
					target: {
						tmuxWindow: "FLY-1925:pending",
						sessionName: "FLY-1925",
					},
				}),
				discover,
				probe,
				hasHostProcess,
			}),
		).resolves.toBe("alive");
		expect(discover).toHaveBeenCalledWith("exec-pending");
		expect(probe).toHaveBeenCalledWith("FLY-1925:@7");
		expect(hasHostProcess).not.toHaveBeenCalled();
	});

	it.each([
		{ state: "dead_pin" as const, expected: "dead" as const },
		{ state: "absent" as const, expected: "dead" as const },
		{ state: "indeterminate" as const, expected: "unknown" as const },
	])("maps a tmux $state probe to $expected", async ({ state, expected }) => {
		await expect(
			probePatrolProcessLiveness("exec-probed", "flywheel", {
				lookup: () => ({
					kind: "found",
					target: { tmuxWindow: "FLY-1925:@1", sessionName: "FLY-1925" },
				}),
				probe: async () => state,
			}),
		).resolves.toBe(expected);
	});

	it("proves the terminal FLY-1934 holder dead when every live target is absent", async () => {
		await expect(
			probePatrolProcessLiveness("e8180aee", "flywheel", {
				lookup: () => ({ kind: "gone" }),
				discover: async () => ({ kind: "missing" }),
				hasHostProcess: async () => false,
			}),
		).resolves.toBe("dead");
	});

	it("recognizes a host process when the CommDB and tmux marker are absent", async () => {
		await expect(
			probePatrolProcessLiveness("exec-host", "flywheel", {
				lookup: () => ({ kind: "gone" }),
				discover: async () => ({ kind: "missing" }),
				hasHostProcess: async () => true,
			}),
		).resolves.toBe("alive");
	});

	it("keeps an indeterminate host-process probe unknown", async () => {
		await expect(
			probePatrolProcessLiveness("exec-host-unknown", "flywheel", {
				lookup: () => ({ kind: "gone" }),
				discover: async () => ({ kind: "missing" }),
				hasHostProcess: async () => "unknown",
			}),
		).resolves.toBe("unknown");
	});

	it.each([
		{
			name: "CommDB lookup error",
			lookup: () => ({ kind: "error" as const, error: "locked" }),
			discover: async () => ({ kind: "missing" as const }),
		},
		{
			name: "ambiguous tmux markers",
			lookup: () => ({ kind: "gone" as const }),
			discover: async () => ({ kind: "ambiguous" as const }),
		},
	])("keeps a true $name unknown", async ({ lookup, discover }) => {
		await expect(
			probePatrolProcessLiveness("exec-unknown", "flywheel", {
				lookup,
				discover,
				hasHostProcess: async () => false,
			}),
		).resolves.toBe("unknown");
	});
});
