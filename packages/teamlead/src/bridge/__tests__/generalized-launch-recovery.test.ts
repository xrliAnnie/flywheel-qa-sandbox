import { describe, expect, it, vi } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: mockExecFile };
});

import {
	type GeneralizedLaunchTargetLookup,
	hasHostProcessByExecutionId,
	probeGeneralizedLaunchLiveness,
	waitForGeneralizedLaunchDelivery,
} from "../generalized-launch-recovery.js";

it("bounds the production host-process probe and fails closed on timeout/error", async () => {
	let callArgs: unknown[] = [];
	mockExecFile.mockImplementationOnce((...args: unknown[]) => {
		callArgs = args;
		const callback = args.at(-1) as (error: Error & { code?: number }) => void;
		callback(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
	});

	await expect(hasHostProcessByExecutionId("exec-timeout")).resolves.toBe(true);
	expect(callArgs.slice(0, 3)).toEqual([
		"pgrep",
		["-f", "exec-timeout"],
		{ timeout: 5_000 },
	]);
});

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

	it("FLY-1572 anchor: proves a terminal launch dead when registration, marker, and host process are all absent", async () => {
		await expect(
			probeGeneralizedLaunchLiveness(
				"11e95f4a-9458-4d34-9d0c-c0f0957d103d",
				"flywheel",
				{
					lookup: () => ({ kind: "gone" }),
					probe: async () => "indeterminate",
					discover: async () => ({ kind: "missing" }),
					hasHostProcess: async () => false,
					allowMissingTargetHostAbsence: true,
				},
			),
		).resolves.toBe("dead");
	});

	it("holds missing registration when either a marker or host process still exists", async () => {
		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup: () => ({ kind: "gone" }),
				probe: async () => "indeterminate",
				discover: async () => ({
					kind: "found",
					tmuxWindow: "flywheel:@42",
				}),
				hasHostProcess: async () => false,
				allowMissingTargetHostAbsence: true,
			}),
		).resolves.toBe("unknown");
		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup: () => ({ kind: "gone" }),
				probe: async () => "indeterminate",
				discover: async () => ({ kind: "missing" }),
				hasHostProcess: async () => true,
				allowMissingTargetHostAbsence: true,
			}),
		).resolves.toBe("unknown");
	});

	it("does not mistake a pending pre-registration for a dead runner while a host process still references it", async () => {
		const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:pending", sessionName: "flywheel" },
		}));
		const discover = vi.fn(async () => ({ kind: "missing" as const }));
		const probe = vi.fn(async () => "absent" as const);

		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup,
				discover,
				probe,
				hasHostProcess: async () => true,
			}),
		).resolves.toBe("unknown");
		expect(discover).toHaveBeenCalledWith("exec-1");
		expect(probe).not.toHaveBeenCalled();
	});

	it("FLY-2313: discovers a materialized runner before using host absence for a pending identity", async () => {
		const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:pending", sessionName: "flywheel" },
		}));
		const discover = vi.fn(async () => ({
			kind: "found" as const,
			tmuxWindow: "flywheel:@42",
		}));
		const probe = vi.fn(async () => "alive" as const);
		const hasHostProcess = vi.fn(async () => false);

		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup,
				discover,
				probe,
				hasHostProcess,
			}),
		).resolves.toBe("alive");
		expect(discover).toHaveBeenCalledWith("exec-1");
		expect(probe).toHaveBeenCalledWith("flywheel:@42");
		expect(hasHostProcess).not.toHaveBeenCalled();
	});

	it("treats a pending window with zero host processes as death evidence (2026-07-24 incident)", async () => {
		const lookup = vi.fn<() => GeneralizedLaunchTargetLookup>(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:pending", sessionName: "flywheel" },
		}));
		const discover = vi.fn(async () => ({ kind: "missing" as const }));
		const probe = vi.fn(async () => "absent" as const);

		await expect(
			probeGeneralizedLaunchLiveness("exec-1", "flywheel", {
				lookup,
				discover,
				probe,
				hasHostProcess: async () => false,
			}),
		).resolves.toBe("dead");
		expect(discover).toHaveBeenCalledWith("exec-1");
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
