import { describe, expect, it, vi } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: mockExecFile };
});

import {
	hasHostProcessByExecutionId,
	probeGeneralizedLaunchLiveness,
	probeHostProcessByExecutionId,
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

it("reports host sensor failure as unknown while preserving the conservative boolean wrapper", async () => {
	mockExecFile
		.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (
				error: Error & { code?: string },
			) => void;
			callback(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
		})
		.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (
				error: Error & { code?: string },
			) => void;
			callback(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
		});

	await expect(probeHostProcessByExecutionId("exec-timeout")).resolves.toEqual({
		verdict: "unknown",
		source: "pgrep",
		reason: "pgrep_failed:ETIMEDOUT",
	});
	await expect(hasHostProcessByExecutionId("exec-timeout")).resolves.toBe(true);
});

it("requires both argv and process-environment absence", async () => {
	mockExecFile
		.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (
				error: Error & { code?: number },
			) => void;
			callback(Object.assign(new Error("no match"), { code: 1 }));
		})
		.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (error: null, stdout: string) => void;
			callback(null, "12 /usr/bin/node unrelated=1\n");
		});

	await expect(probeHostProcessByExecutionId("exec-gone")).resolves.toEqual({
		verdict: "absent",
		source: "process-environment",
	});
});

it("finds an env-only Codex process after pgrep misses its argv", async () => {
	mockExecFile
		.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (
				error: Error & { code?: number },
			) => void;
			callback(Object.assign(new Error("no argv match"), { code: 1 }));
		})
		.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (error: null, stdout: string) => void;
			callback(
				null,
				"144 /opt/codex app-server CODEX_HOME=/tmp/codex FLYWHEEL_EXEC_ID=exec-env-only\n",
			);
		});

	await expect(probeHostProcessByExecutionId("exec-env-only")).resolves.toEqual(
		{
			verdict: "live",
			source: "process-environment",
		},
	);
});

it("keeps a failed environment snapshot unknown after pgrep misses", async () => {
	mockExecFile
		.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (
				error: Error & { code?: number },
			) => void;
			callback(Object.assign(new Error("no argv match"), { code: 1 }));
		})
		.mockImplementationOnce((...args: unknown[]) => {
			const callback = args.at(-1) as (
				error: Error & { code?: string },
				stdout: string,
			) => void;
			callback(
				Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
				"",
			);
		});

	await expect(probeHostProcessByExecutionId("exec-unknown")).resolves.toEqual({
		verdict: "unknown",
		source: "process-environment",
		reason: "process_snapshot_failed:ETIMEDOUT",
	});
});

describe("generalized launch recovery liveness", () => {
	it.each(["missing", "pending", "absent", "dead_pin"])(
		"does not authorize legacy %s presentation evidence",
		async (state) => {
			expect(
				await probeGeneralizedLaunchLiveness("exec", "flywheel", {
					lookup: () =>
						state === "missing"
							? { kind: "gone" }
							: {
									kind: "found",
									target: {
										tmuxWindow:
											state === "pending" ? "flywheel:pending" : "flywheel:@42",
										sessionName: "flywheel",
									},
								},
					probe: async () => state,
					discover: async () => ({ kind: "missing" }),
					hasHostProcess: async () => false,
					allowMissingTargetHostAbsence: true,
				} as never),
			).toBe("unknown");
		},
	);
	it("fails closed when the common reader is unavailable or throws", async () => {
		expect(await probeGeneralizedLaunchLiveness("exec", "flywheel")).toBe(
			"unknown",
		);
		expect(
			await probeGeneralizedLaunchLiveness("exec", "flywheel", {
				readBodyLiveness: () => {
					throw new Error("unavailable");
				},
			}),
		).toBe("unknown");
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

describe("FLY-2919 common body launch probe", () => {
	it.each(["alive", "dead", "unknown"] as const)(
		"preserves body %s and never consults a window",
		async (body) => {
			const lookup = vi.fn(() => ({
				kind: "found",
				target: { tmuxWindow: "visible:@42", sessionName: "visible" },
			}));
			expect(
				await probeGeneralizedLaunchLiveness("exec", "flywheel", {
					readBodyLiveness: () => body,
					lookup,
					probe: async () => "dead_pin",
				} as never),
			).toBe(body);
			expect(lookup).not.toHaveBeenCalled();
		},
	);
});
