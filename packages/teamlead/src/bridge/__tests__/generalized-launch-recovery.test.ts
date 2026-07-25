import { describe, expect, it, vi } from "vitest";
import {
	type GeneralizedLaunchTargetLookup,
	probeGeneralizedLaunchLiveness,
	waitForGeneralizedLaunchDelivery,
} from "../generalized-launch-recovery.js";

describe("generalized launch recovery liveness", () => {
	it("treats an actual live runner pane as positive delivery evidence", async () => {
		const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:@42", sessionName: "flywheel" },
		}));
		const probe = vi.fn(async () => "alive" as const);

		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup,
				probe,
			}),
		).resolves.toBe("alive");
	});

	it.each(["dead_pin", "absent"] as const)(
		"classifies %s as positive death evidence",
		async (paneState) => {
			const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => ({
				kind: "found",
				target: { tmuxWindow: "flywheel:@42", sessionName: "flywheel" },
			}));
			const probe = vi.fn(async () => paneState);

			await expect(
				probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
					lookup,
					probe,
				}),
			).resolves.toBe("dead");
		},
	);

	it.each([
		["missing CommDB row", { kind: "gone" }],
		["CommDB read error", { kind: "error", error: "locked" }],
	] as const)("holds when liveness is unknown: %s", async (_label, result) => {
		const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => result);
		const probe = vi.fn(async () => "absent" as const);

		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup,
				probe,
			}),
		).resolves.toBe("unknown");
		expect(probe).not.toHaveBeenCalled();
	});

	it("does not mistake a pending pre-registration for a dead runner while a host process still references it", async () => {
		const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:pending", sessionName: "flywheel" },
		}));
		const probe = vi.fn(async () => "absent" as const);

		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup,
				probe,
				hasHostProcess: async () => true,
			}),
		).resolves.toBe("unknown");
		expect(probe).not.toHaveBeenCalled();
	});

	it("treats a pending window with zero host processes as death evidence (2026-07-24 incident)", async () => {
		const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:pending", sessionName: "flywheel" },
		}));
		const probe = vi.fn(async () => "absent" as const);

		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup,
				probe,
				hasHostProcess: async () => false,
			}),
		).resolves.toBe("dead");
		expect(probe).not.toHaveBeenCalled();
	});

	it("holds on an indeterminate tmux probe", async () => {
		const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:@42", sessionName: "flywheel" },
		}));
		const probe = vi.fn(async () => "indeterminate" as const);

		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup,
				probe,
			}),
		).resolves.toBe("unknown");
	});
});

describe("generalized launch delivery wait", () => {
	it("returns only a committed and delivered current generation", async () => {
		const owner = {
			owner_generation: 2,
			committed_generation: 2,
			delivery_state: "delivered" as const,
		};
		const getWorkflowLaunchOwner = vi.fn(() => owner);

		await expect(
			waitForGeneralizedLaunchDelivery({ getWorkflowLaunchOwner }, "exec-1", {
				timeoutMs: 0,
			}),
		).resolves.toBe(owner);
	});

	it("does not accept a committed generation while delivery is repairing", async () => {
		const getWorkflowLaunchOwner = vi.fn(() => ({
			owner_generation: 2,
			committed_generation: 2,
			delivery_state: "repairing" as const,
		}));

		await expect(
			waitForGeneralizedLaunchDelivery({ getWorkflowLaunchOwner }, "exec-1", {
				timeoutMs: 0,
			}),
		).resolves.toBeUndefined();
	});
});
