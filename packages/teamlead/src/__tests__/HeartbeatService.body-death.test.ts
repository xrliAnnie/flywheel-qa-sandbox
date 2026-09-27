import type { BodyObservation } from "flywheel-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/complete-marker-reconciler.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../bridge/complete-marker-reconciler.js")
	>()),
	tryReconcileComplete: vi.fn(async () => ({ kind: "absent" })),
}));
vi.mock("../bridge/worktree-inspect.js", () => ({
	inspectWorktreeForUnpushedWork: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../bridge/tmux-lookup.js", () => ({
	lookupTmuxTarget: vi.fn(() => ({ kind: "gone" })),
	getTmuxTargetFromCommDb: vi.fn(() => null),
	isTmuxWindowAlive: vi.fn(async () => true),
	probeRunnerProcessLiveness: vi.fn(async () => "absent"),
	probeRunnerProcessLivenessDetailed: vi.fn(async () => ({
		liveness: "absent",
	})),
	probeTmuxServer: vi.fn(async () => "up"),
}));

import { tryReconcileComplete } from "../bridge/complete-marker-reconciler.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLivenessDetailed,
} from "../bridge/tmux-lookup.js";
import { inspectWorktreeForUnpushedWork } from "../bridge/worktree-inspect.js";
import { HeartbeatService } from "../HeartbeatService.js";

function fixture(status = "running") {
	const session = {
		execution_id: "exec-body",
		issue_id: "FLY-2919",
		project_name: "fixture",
		adapter_type: "claude-tmux",
		status,
		lifecycle_revision: 0,
		heartbeat_at: "2020-01-01 00:00:00",
	};
	let verdict: BodyObservation["verdict"] = "dead";
	const observe = vi.fn(
		async (): Promise<BodyObservation> => ({
			identity: {
				executionId: session.execution_id,
				activationId: "activation",
				generation: 1,
				lifecycleRevision: session.lifecycle_revision,
				adapter: "claude-tmux",
			},
			ownerToken: "owner",
			spawnEpoch: 1,
			bindingDigest: "a".repeat(64),
			verdict,
			observedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 10000).toISOString(),
			reason: "process_writers_absent",
		}),
	);
	const store = {
		getSession: () => session,
		getOrphanSessions: () => [session],
		getReadoptCandidateSessions: () => [session],
		updateHeartbeat: vi.fn(),
		forceStatus: vi.fn(),
		getWorkflowExecutionProcessBody: () => ({ state: "active" }),
		getStaleCompletedSessions: () => [],
		getAwaitingReviewTimedOut: () => [],
		getActiveSessions: () => [],
		getZombieAlertBacklog: () => [],
		markGateTimeoutNotified: vi.fn(),
	};
	const notifier = {
		onSessionMonitoringLost: vi.fn(),
		onSessionMonitoringReestablished: vi.fn(),
		onSessionOrphaned: vi.fn(),
		onSessionStale: vi.fn(),
		clearReconnectStamp: vi.fn(),
		prepareSessionZombieDetected: vi.fn(() => ({
			eventId: "zombie-exec-body",
		})),
		persistPreparedZombieDetected: vi.fn(async () => true),
	};
	const converge = vi.fn(async () => {
		const observation = await observe();
		if (observation.verdict !== "dead")
			return { kind: "deferred", reason: `body_${observation.verdict}` };
		session.status = "failed";
		return {
			kind: "committed",
			obligation: { observation, disposition: "failed" },
			projection: { projected: true },
		};
	});
	const service = new HeartbeatService(
		store as never,
		notifier as never,
		15,
		300000,
		60,
		undefined,
		24,
		21600000,
		{ bridgeBaseUrl: "http://localhost", ingestToken: "fixture" },
	);
	service.setExecutionBodyLifecycle?.({ observe, converge } as never);
	return {
		service,
		session,
		store,
		notifier,
		observe,
		converge,
		setVerdict: (v: BodyObservation["verdict"]) => {
			verdict = v;
		},
	};
}
describe("FLY-2919 Heartbeat process death convergence", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(inspectWorktreeForUnpushedWork).mockResolvedValue({
			ok: true,
		} as never);
		vi.mocked(tryReconcileComplete).mockResolvedValue({ kind: "absent" });
	});
	it("preserves a live process with no window", async () => {
		const f = fixture();
		f.setVerdict("alive");
		await f.service.reconcileMonitorLoss();
		await f.service.reapOrphans();
		expect(f.session.status).toBe("running");
		expect(f.store.forceStatus).not.toHaveBeenCalled();
		expect(lookupTmuxTarget).not.toHaveBeenCalled();
		expect(probeRunnerProcessLivenessDetailed).not.toHaveBeenCalled();
	});
	it.each([
		"running",
		"ship_parked",
		"awaiting_review",
		"design_done",
		"approved_to_ship",
	])(
		"converges proven-dead %s in its first pass even with a window",
		async (status) => {
			const f = fixture(status);
			await f.service.reconcileMonitorLoss();
			expect(f.converge).toHaveBeenCalledTimes(1);
			expect(f.session.status).toBe("failed");
			expect(f.store.forceStatus).not.toHaveBeenCalled();
			expect(
				f.notifier.prepareSessionZombieDetected.mock.calls[0]?.[1],
			).toMatchObject({ kind: "process", observation: { verdict: "dead" } });
			expect(probeRunnerProcessLivenessDetailed).not.toHaveBeenCalled();
		},
	);
	it("does not turn unknown or missing runtime into age-based failure", async () => {
		const f = fixture();
		f.setVerdict("unknown");
		await f.service.reapOrphans();
		expect(f.session.status).toBe("running");
		expect(f.store.forceStatus).not.toHaveBeenCalled();
		const unwired = new HeartbeatService(
			f.store as never,
			f.notifier as never,
			15,
			300000,
			60,
		);
		await unwired.reapOrphans();
		expect(f.store.forceStatus).not.toHaveBeenCalled();
	});
	it("reconciles pending completion before invoking death convergence", async () => {
		const f = fixture();
		vi.mocked(tryReconcileComplete).mockResolvedValue({
			kind: "transient_failed",
			reason: "pending",
		} as never);
		await f.service.reconcileMonitorLoss();
		await f.service.reapOrphans();
		expect(f.converge).not.toHaveBeenCalled();
		expect(f.session.status).toBe("running");
	});
	it("uses common-path refusal after awaits without a force override or death alert", async () => {
		const f = fixture();
		f.converge.mockResolvedValue({
			kind: "deferred",
			reason: "body_death_authority_changed",
		});
		await f.service.reconcileMonitorLoss();
		expect(f.session.status).toBe("running");
		expect(f.store.forceStatus).not.toHaveBeenCalled();
		expect(f.notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
	});
	it("offers an age-independent entry for sampled bodies", async () => {
		const f = fixture();
		f.session.heartbeat_at = new Date().toISOString();
		await f.service.reconcileExecutionBody(f.session.execution_id);
		expect(f.session.status).toBe("failed");
		expect(f.converge).toHaveBeenCalledTimes(1);
	});
	it.each(["alive", "dead", "unknown"] as const)(
		"phase cleanup also consumes %s process evidence",
		async (verdict) => {
			const f = fixture();
			f.setVerdict(verdict);
			expect(await (f.service as any).probePhaseLiveness(f.session)).toBe(
				verdict === "unknown" ? "defer" : verdict,
			);
		},
	);

	it("replays committed body duties even when no running candidate remains", async () => {
		const f = fixture();
		const replayPending = vi.fn(async () => {});
		f.service.setExecutionBodyLifecycle({
			observe: f.observe,
			converge: f.converge,
			replayPending,
		} as never);
		f.store.getOrphanSessions = () => [];
		f.store.getReadoptCandidateSessions = () => [];
		await f.service.check();
		expect(replayPending).toHaveBeenCalledTimes(1);
	});
	it("does not let worktree diagnostic failure keep a proven-dead body running", async () => {
		const f = fixture();
		vi.mocked(inspectWorktreeForUnpushedWork).mockRejectedValueOnce(
			new Error("git unavailable"),
		);
		await expect(
			f.service.reconcileExecutionBody(f.session.execution_id),
		).resolves.toBe(true);
		expect(f.session.status).toBe("failed");
		expect(f.notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
	});
});
