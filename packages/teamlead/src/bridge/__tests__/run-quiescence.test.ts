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

describe("FLY-2490 pre-adapter quiescence", () => {
	const zero = {
		liveness: "unknown",
		ledger: "missing",
		socketLive: false,
		spawnLock: "absent",
	} as const;
	const facts = {
		failureKind: "worktree_takeover_failed",
		launchClaimState: "closed",
	};
	it.each(["failed", "blocked"])(
		"proves a never-launched %s execution dead after a final evidence check",
		async (status) => {
			const probeGeneric = vi.fn(async () => "dead" as const);
			const probeCodexDaemonEvidence = vi.fn(async () => zero);
			expect(
				await probeRunExecutionLiveness(
					{ adapter_type: "codex-tmux", status },
					"exec",
					"flywheel",
					{ probeGeneric, probeCodexDaemonEvidence, storeFacts: () => facts },
				),
			).toBe("dead");
			expect(probeCodexDaemonEvidence).toHaveBeenCalledTimes(2);
			expect(probeGeneric).toHaveBeenCalledWith("exec", "flywheel", {
				allowMissingTargetHostAbsence: true,
			});
		},
	);
	it.each([
		{ status: "running" },
		{ status: undefined },
		{ evidence: { ...zero, ledger: "no_group" } },
		{ evidence: { ...zero, ledger: "valid_group" } },
		{ evidence: { ...zero, ledger: "unreadable" } },
		{ evidence: { ...zero, socketLive: true } },
		{ evidence: { ...zero, spawnLock: "live" } },
		{ evidence: { ...zero, spawnLock: "stale" } },
		{ evidence: { ...zero, spawnLock: "unreadable" } },
		{ evidence: { ...zero, ledger: "no_group", spawnLock: "stale" } },
		{ facts: { ...facts, failureKind: "goal_blocked" } },
		{ facts: { ...facts, failureKind: undefined } },
		...["starting", "active", "cancelled", undefined].map(
			(launchClaimState) => ({ facts: { ...facts, launchClaimState } }),
		),
		{ noFacts: true },
	] as Array<{
		status?: string;
		evidence?: import("flywheel-claude-runner").CodexDaemonEvidence;
		facts?: { failureKind?: string; launchClaimState?: string };
		noFacts?: boolean;
	}>)("fails closed for %j", async (variant) => {
		const probeGeneric = vi.fn(async () => "dead" as const);
		expect(
			await probeRunExecutionLiveness(
				{
					adapter_type: "codex-tmux",
					status: Object.hasOwn(variant, "status") ? variant.status : "failed",
				},
				"exec",
				"flywheel",
				{
					probeGeneric,
					probeCodexDaemonEvidence: async () => variant.evidence ?? zero,
					storeFacts: variant.noFacts
						? undefined
						: () => variant.facts ?? facts,
				},
			),
		).toBe("unknown");
		expect(probeGeneric).not.toHaveBeenCalled();
	});
	it.each([
		{ ...zero, spawnLock: "live" },
		{ ...zero, ledger: "no_group" },
		{ ...zero, socketLive: true },
	] as const)(
		"withdraws dead when evidence appears during generic probing: %j",
		async (second) => {
			const probeCodexDaemonEvidence = vi
				.fn()
				.mockResolvedValueOnce(zero)
				.mockResolvedValueOnce(second);
			expect(
				await probeRunExecutionLiveness(
					{ adapter_type: "codex-tmux", status: "failed" },
					"exec",
					"flywheel",
					{
						probeCodexDaemonEvidence,
						probeGeneric: async () => "dead",
						storeFacts: () => facts,
					},
				),
			).toBe("unknown");
		},
	);
	it.each(["alive", "unknown"] as const)(
		"preserves generic %s without claiming death",
		async (result) => {
			const probeCodexDaemonEvidence = vi.fn(async () => zero);
			expect(
				await probeRunExecutionLiveness(
					{ adapter_type: "codex-tmux", status: "failed" },
					"exec",
					"flywheel",
					{
						probeCodexDaemonEvidence,
						probeGeneric: async () => result,
						storeFacts: () => facts,
					},
				),
			).toBe(result);
			expect(probeCodexDaemonEvidence).toHaveBeenCalledTimes(1);
		},
	);
	it("keeps legacy unknown injection fail-closed even with a receipt", async () => {
		const probeGeneric = vi.fn(async () => "dead" as const);
		expect(
			await probeRunExecutionLiveness(
				{ adapter_type: "codex-tmux", status: "failed" },
				"exec",
				"flywheel",
				{
					probeCodexDaemon: async () => "unknown",
					probeGeneric,
					storeFacts: () => facts,
				},
			),
		).toBe("unknown");
		expect(probeGeneric).not.toHaveBeenCalled();
	});
});
