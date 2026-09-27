import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	probeExecutionAbsenceBeyondTarget,
	probeRunExecutionLiveness,
} from "../run-quiescence.js";

describe("FLY-2919 trusted pre-adapter no-body exception", () => {
	const zero = {
		liveness: "unknown",
		ledger: "missing",
		socketLive: false,
		spawnLock: "absent",
	} as const;
	function fixture() {
		const state: any = {
			enabled: true,
			activations: [{ activation_id: "original" }],
			owner: undefined,
			generation: 1,
			session: {
				adapter_type: "codex-tmux",
				project_name: "flywheel",
				status: "failed",
				lifecycle_revision: 4,
			},
			receipt: {
				failureKind: "worktree_takeover_failed",
				sourceEventId: "trusted-failure",
				recordedAt: "2026-09-26T00:00:00Z",
			},
			claim: { state: "closed", project: "flywheel" },
		};
		const store = {
			getPreAdapterQuiescenceSnapshot:
				StateStore.prototype.getPreAdapterQuiescenceSnapshot,
			getSession: () => state.session,
			listWorkflowActivationsForActor: () => state.activations,
			getPreAdapterFailureReceipt: () => state.receipt,
			getLaunchClaim: () => state.claim,
			getWorkflowExecutionProcessBody: () => ({ generation: state.generation }),
			executionProcessOwners: { get: () => state.owner },
		};
		const deps = {
			store: store as never,
			isEnabled: () => state.enabled,
			readBodyLiveness: () => "unknown" as const,
			probeCodexDaemonEvidence: vi.fn(
				async () =>
					zero as import("flywheel-claude-runner").CodexDaemonEvidence,
			),
			probeHostProcess: vi.fn(
				async () =>
					({
						verdict: "absent",
						source: "process-environment",
					}) as import("../generalized-launch-recovery.js").HostProcessByExecutionIdProbe,
			),
		};
		return {
			state,
			deps,
			probe: () =>
				probeRunExecutionLiveness(state.session, "exec", "flywheel", deps),
		};
	}
	it.each(["failed", "blocked"])(
		"permits never-launched %s only with a trusted receipt and two zero samples",
		async (status) => {
			const f = fixture();
			f.state.session.status = status;
			expect(await f.probe()).toBe("dead");
			expect(f.deps.probeCodexDaemonEvidence).toHaveBeenCalledTimes(2);
			expect(f.deps.probeHostProcess).toHaveBeenCalledWith("exec");
		},
	);
	it.each([
		"running",
		"wrong_adapter",
		"wrong_project",
		"no_receipt",
		"wrong_kind",
		"no_source",
		"invalid_date",
		"open_claim",
		"cancelled_claim",
		"no_claim",
		"owner_registered",
		"disabled",
	])("refuses missing authority: %s", async (mode) => {
		const f = fixture();
		if (mode === "running") f.state.session.status = "running";
		if (mode === "wrong_adapter") f.state.session.adapter_type = "claude-tmux";
		if (mode === "wrong_project") f.state.session.project_name = "foreign";
		if (mode === "no_receipt") f.state.receipt = undefined;
		if (mode === "wrong_kind") f.state.receipt.failureKind = "goal_blocked";
		if (mode === "no_source") f.state.receipt.sourceEventId = "";
		if (mode === "invalid_date") f.state.receipt.recordedAt = "invalid";
		if (mode === "open_claim") f.state.claim.state = "active";
		if (mode === "cancelled_claim") f.state.claim.state = "cancelled";
		if (mode === "no_claim") f.state.claim = undefined;
		if (mode === "owner_registered") f.state.owner = { owner_token: "owner" };
		if (mode === "disabled") f.state.enabled = false;
		expect(await f.probe()).toBe("unknown");
		expect(f.deps.probeCodexDaemonEvidence).not.toHaveBeenCalled();
	});
	it.each([
		{ ...zero, liveness: "alive" },
		{ ...zero, liveness: "absent" },
		{ ...zero, ledger: "no_group" },
		{ ...zero, ledger: "valid_group" },
		{ ...zero, ledger: "unreadable" },
		{ ...zero, socketLive: true },
		{ ...zero, spawnLock: "live" },
		{ ...zero, spawnLock: "stale" },
		{ ...zero, spawnLock: "unreadable" },
	] as const)(
		"rejects nonzero or indeterminate daemon evidence %j",
		async (evidence) => {
			const f = fixture();
			f.deps.probeCodexDaemonEvidence.mockResolvedValue(evidence);
			expect(await f.probe()).toBe("unknown");
			expect(f.deps.probeHostProcess).not.toHaveBeenCalled();
		},
	);
	it.each(["live", "unknown"] as const)(
		"host %s refuses the no-body exception",
		async (verdict) => {
			const f = fixture();
			f.deps.probeHostProcess.mockResolvedValue(
				verdict === "live"
					? { verdict, source: "process-environment" }
					: { verdict, source: "process-environment", reason: "unreadable" },
			);
			expect(await f.probe()).toBe("unknown");
		},
	);
	it.each([
		"flag",
		"revision",
		"generation",
		"claim",
		"receipt",
		"owner",
		"second_sample",
		"activation",
	])("rechecks %s after asynchronous evidence", async (mode) => {
		const f = fixture();
		f.deps.probeHostProcess.mockImplementation(async () => {
			if (mode === "activation")
				f.state.activations.push({ activation_id: "new" });
			if (mode === "flag") f.state.enabled = false;
			if (mode === "revision") f.state.session.lifecycle_revision++;
			if (mode === "generation") f.state.generation++;
			if (mode === "claim") f.state.claim.state = "active";
			if (mode === "receipt") f.state.receipt.sourceEventId = "changed";
			if (mode === "owner") f.state.owner = { owner_token: "new" };
			return { verdict: "absent", source: "process-environment" };
		});
		if (mode === "second_sample")
			f.deps.probeCodexDaemonEvidence
				.mockResolvedValueOnce(zero)
				.mockResolvedValueOnce({ ...zero, socketLive: true });
		expect(await f.probe()).toBe("unknown");
	});
	it.each(["probeCodexDaemonEvidence", "probeHostProcess"] as const)(
		"fails closed when %s throws",
		async (key) => {
			const f = fixture();
			f.deps[key].mockRejectedValue(new Error("unavailable"));
			expect(await f.probe()).toBe("unknown");
		},
	);
});

// The same physical evidence must survive every window presentation state.
describe("FLY-2919 common body quiescence", () => {
	it.each(["claude-tmux", "codex-tmux"])(
		"uses only the body reader for %s",
		async (adapter_type) => {
			for (const body of ["alive", "dead", "unknown"] as const) {
				for (const window of ["alive", "dead"] as const) {
					const probeGeneric = vi.fn(async () => window);
					const readBodyLiveness = vi.fn(() => body);
					expect(
						await probeRunExecutionLiveness(
							{ adapter_type },
							"exec",
							"flywheel",
							{
								readBodyLiveness,
								probeGeneric,
								probeCodexDaemon: async () => "absent",
							} as never,
						),
						`${adapter_type} body=${body} window=${window}`,
					).toBe(body);
					expect(readBodyLiveness).toHaveBeenCalledWith("exec", "flywheel");
					expect(probeGeneric).not.toHaveBeenCalled();
				}
			}
		},
	);
	it.each(["alive", "dead", "unknown"] as const)(
		"execution absence facade preserves body %s regardless of the registered window",
		async (body) => {
			const discover = vi.fn(async () => ({
				kind: "found",
				tmuxWindow: "visible:@42",
			}));
			expect(
				await probeExecutionAbsenceBeyondTarget(
					{ adapter_type: "codex-tmux" },
					"exec",
					"flywheel",
					{
						readBodyLiveness: () => body,
						discover,
						probeCodexDaemon: async () => "absent",
						hasHostProcess: async () => false,
					} as never,
				),
			).toBe(body);
			expect(discover).not.toHaveBeenCalled();
		},
	);
	it("refuses ordinary death when only legacy daemon/window/host absence is available", async () => {
		expect(
			await probeRunExecutionLiveness(
				{ adapter_type: "codex-tmux" },
				"exec",
				"flywheel",
				{
					probeCodexDaemon: async () => "absent",
					probeGeneric: async () => "dead",
				} as never,
			),
		).toBe("unknown");
	});
});
