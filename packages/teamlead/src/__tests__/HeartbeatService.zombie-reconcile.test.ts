/** FLY-1282/2919: process authority, ordered alerts, replay and readoption aggregation. */
import type { BodyObservation } from "flywheel-claude-runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/tmux-lookup.js", () => {
	const isTmuxWindowAlive = vi.fn(async () => true);
	const probeRunnerProcessLiveness = vi.fn(async () => "alive");
	const probeTmuxServer = vi.fn(async () => "up");
	return {
		getTmuxTargetFromCommDb: vi.fn(() => ({
			tmuxWindow: "runner-flywheel:@829",
			sessionName: "runner-flywheel",
		})),
		isTmuxWindowAlive,
		lookupTmuxTarget: vi.fn(() => ({
			kind: "found",
			target: {
				tmuxWindow: "runner-flywheel:@829",
				sessionName: "runner-flywheel",
			},
		})),
		probeRunnerProcessLiveness,
		probeRunnerProcessLivenessDetailed: vi.fn(
			async (...args: Parameters<typeof probeRunnerProcessLiveness>) => ({
				liveness: await probeRunnerProcessLiveness(...args),
			}),
		),
		probeTmuxServer,
	};
});

vi.mock("../bridge/complete-marker-reconciler.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../bridge/complete-marker-reconciler.js")
	>()),
	tryReconcileComplete: vi.fn(async () => ({ kind: "absent" })),
	applyQuarantineFallback: vi.fn(),
}));

vi.mock("../bridge/worktree-inspect.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../bridge/worktree-inspect.js")>();
	return {
		...original,
		inspectWorktreeForUnpushedWork: vi.fn(async () => ({
			ok: true,
			worktreePath: "/tmp/wt",
			branch: "flywheel-FLY-1260",
			untracked: ["design/a.md", "design/b.md"],
			modified: ["notes.md"],
			untrackedTotal: 2,
			modifiedTotal: 1,
			unpushedCommits: 1,
			unpushedSemantics: "vs_upstream" as const,
		})),
	};
});

import { tryReconcileComplete } from "../bridge/complete-marker-reconciler.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	probeTmuxServer,
} from "../bridge/tmux-lookup.js";
import { inspectWorktreeForUnpushedWork } from "../bridge/worktree-inspect.js";
import { HeartbeatService } from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

const mockedTry = vi.mocked(tryReconcileComplete);
const mockedProbe = vi.mocked(probeRunnerProcessLiveness);
const mockedServer = vi.mocked(probeTmuxServer);
const mockedLookup = vi.mocked(lookupTmuxTarget);
const mockedInspect = vi.mocked(inspectWorktreeForUnpushedWork);

function observation(
	executionId = "exec-z1",
	verdict: BodyObservation["verdict"] = "alive",
): BodyObservation {
	return {
		identity: {
			executionId,
			activationId: "activation",
			generation: 1,
			lifecycleRevision: 0,
			adapter: "claude-tmux",
		},
		ownerToken: "owner",
		spawnEpoch: 1,
		bindingDigest: "a".repeat(64),
		verdict,
		observedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 10000).toISOString(),
		reason: "fixture_process_evidence",
	};
}
const bodyObserve = vi.fn(async (id: string) => observation(id));
const bodyConverge =
	vi.fn<import("../HeartbeatService.js").HeartbeatBodyLifecycle["converge"]>();
function primeDead() {
	store.getOrphanSessions.mockReturnValue([sess()]);
	bodyObserve.mockImplementation(async (id) => observation(id, "dead"));
}
function commitFixture() {
	// Only the orchestration seam is mocked here; real CAS/replay assertions live
	// in execution-body-convergence, StateStore.body-death and completion-before-death.
	bodyConverge.mockImplementation(async (id) => {
		const fresh = {
			...store.getSession(id),
			status: "failed",
			last_error: "body_death:process_writers_absent",
		};
		store.getSession.mockReturnValue(fresh);
		store.getOrphanSessions.mockReturnValue([]);
		return {
			kind: "committed",
			obligation: {
				observation: observation(id, "dead"),
				disposition: "failed",
			},
			projection: { projected: true },
		} as never;
	});
}

function sess(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-z1",
		issue_id: "FLY-1260",
		issue_identifier: "FLY-1260",
		project_name: "flywheel",
		status: "running",
		heartbeat_at: "2026-07-15 09:00:00",
		last_activity_at: "2026-07-15 09:00:00",
		worktree_path: "/tmp/wt",
		...overrides,
	} as Session;
}

type MockFn = ReturnType<typeof vi.fn>;
type MockStore = Record<string, MockFn>;
type MockNotifier = Record<string, MockFn>;

function makeStore(): MockStore {
	const store: MockStore = {
		getOrphanSessions: vi.fn().mockReturnValue([]),
		getStaleCompletedSessions: vi.fn().mockReturnValue([]),
		getAwaitingReviewTimedOut: vi.fn().mockReturnValue([]),
		getActiveSessions: vi.fn().mockReturnValue([]),
		// FLY-1329 (A3): boot re-adopt now reads every parked role. These
		// fixtures seed `running` sessions, where both queries agree — each test
		// feeds this alongside getActiveSessions. The widened query\'s own
		// semantics are pinned on a real StateStore in
		// statestore.fly1329-readopt-candidates.test.ts.
		getReadoptCandidateSessions: vi.fn().mockReturnValue([]),
		getSession: vi.fn((id: string) => (id === "exec-z1" ? sess() : undefined)),
		updateHeartbeat: vi.fn(),
		markGateTimeoutNotified: vi.fn(),
		forceStatus: vi.fn(),
		insertEvent: vi.fn().mockReturnValue(true),
		getZombieAlertBacklog: vi.fn().mockReturnValue([]),
		isCodexQuotaStandby: vi.fn().mockReturnValue(false),
		hasQuietWakeNotified: vi.fn().mockReturnValue(false),
		recordQuietWakeNotified: vi.fn(),
		clearQuietWakeNotified: vi.fn(),
		pruneQuietWakeNotifiedNotIn: vi.fn(),
	};
	return store;
}

function makeNotifier(): MockNotifier {
	return {
		onSessionOrphaned: vi.fn().mockResolvedValue(undefined),
		onSessionStale: vi.fn().mockResolvedValue(undefined),
		onSessionMonitoringLost: vi.fn().mockResolvedValue(undefined),
		onSessionMonitoringReestablished: vi.fn().mockResolvedValue(undefined),
		clearReconnectStamp: vi.fn(),
		prepareSessionZombieDetected: vi.fn().mockReturnValue({
			leadId: "flywheel-eng-lead",
			eventId: "zombie-exec-z1",
			eventType: "session_zombie_detected",
			payloadJson: "{}",
			sessionKey: "flywheel:FLY-1260",
			runtime: undefined,
		}),
		persistPreparedZombieDetected: vi.fn().mockResolvedValue(true),
	};
}

function makeService(
	store: MockStore,
	notifier: MockNotifier,
	livenessTracker?: { started(): number; completed(token: number): void },
	onZombieDeclared?: (session: Session, reason: string) => void,
): HeartbeatService {
	const instance = new HeartbeatService(
		store as never,
		notifier as never,
		15,
		60_000,
		60,
		undefined,
		24,
		6 * 3_600_000,
		{ bridgeBaseUrl: "http://127.0.0.1:9876", ingestToken: "tok" },
		48,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		livenessTracker,
		undefined,
		onZombieDeclared,
	);
	instance.setExecutionBodyLifecycle({
		observe: bodyObserve,
		converge: bodyConverge,
	});
	return instance;
}

let store: MockStore;
let notifier: MockNotifier;
let service: HeartbeatService;

beforeEach(() => {
	bodyObserve.mockReset().mockImplementation(async (id) => observation(id));
	bodyConverge
		.mockReset()
		.mockResolvedValue({ kind: "deferred", reason: "body_unknown" });
	mockedTry.mockReset().mockResolvedValue({ kind: "absent" });
	mockedProbe.mockReset().mockResolvedValue("alive");
	mockedServer.mockReset().mockResolvedValue("up");
	mockedLookup.mockReset().mockReturnValue({
		kind: "found",
		target: {
			tmuxWindow: "runner-flywheel:@829",
			sessionName: "runner-flywheel",
		},
	});
	mockedInspect
		.mockReset()
		.mockResolvedValue({ ok: false, reason: "fixture" } as never);
	store = makeStore();
	notifier = makeNotifier();
	service = makeService(store, notifier);
});

afterEach(() => {
	service.stop();
});

describe("M2 process verdict dispatch", () => {
	it("settled completion wins before observing the body", async () => {
		mockedTry.mockResolvedValue({
			kind: "settled_ship_attempt_failed",
			settle: "marked",
		});
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(bodyObserve).not.toHaveBeenCalled();
		expect(bodyConverge).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
	});
	it("alive readoption reports an execution-process target, never a pane target", async () => {
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-z1");
		const details = notifier.onSessionMonitoringReestablished.mock.calls[0][2];
		expect(details.livenessProbe).toMatchObject({
			method: "execution_process",
			probedAt: expect.any(String),
		});
		expect(details.livenessProbe.target).toBe("exec-z1");
		expect(details.concurrentCount).toBeUndefined();
	});
	it.each(["unknown", "throw"])(
		"%s observation never refreshes or forces death",
		async (mode) => {
			if (mode === "throw")
				bodyObserve.mockRejectedValue(new Error("sample failed"));
			else
				bodyObserve.mockImplementation(async (id) =>
					observation(id, "unknown"),
				);
			store.getOrphanSessions.mockReturnValue([sess()]);
			await service.check();
			expect(notifier.onSessionMonitoringLost).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(Number),
				{ unverified: true },
			);
			expect(store.updateHeartbeat).not.toHaveBeenCalled();
			expect(store.forceStatus).not.toHaveBeenCalled();
			expect(notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
		},
	);
	it("one dead observation immediately invokes common CAS; no two-pane streak", async () => {
		primeDead();
		await service.reconcileMonitorLoss();
		expect(bodyConverge).toHaveBeenCalledExactlyOnceWith("exec-z1");
		expect(mockedProbe).not.toHaveBeenCalled();
		expect(mockedServer).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("FLY-2900 quota standby remains owned by the resume loop", async () => {
		primeDead();
		store.isCodexQuotaStandby.mockReturnValue(true);

		await service.reconcileMonitorLoss();

		expect(bodyObserve).not.toHaveBeenCalled();
		expect(bodyConverge).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("CAS refusal releases the candidate for a later freshly observed attempt", async () => {
		primeDead();
		await service.reconcileMonitorLoss();
		store.getOrphanSessions.mockReturnValue([]);
		await service.reconcileMonitorLoss();
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(bodyConverge).toHaveBeenCalledTimes(2);
		expect(notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
	});
	it("quarantined completion never authorizes the old window fallback", async () => {
		mockedTry.mockResolvedValue({
			kind: "quarantined",
			routeStatus: "blocked",
			quarantinePath: "/q/exec-z1.json",
		});
		bodyObserve.mockImplementation(async (id) => observation(id, "unknown"));
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		const { applyQuarantineFallback } = await import(
			"../bridge/complete-marker-reconciler.js"
		);
		expect(applyQuarantineFallback).not.toHaveBeenCalled();
		expect(bodyConverge).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
});
describe("M3 death declaration and alert ordering", () => {
	it("commits common death before diagnostic inspection, preparation and persistence", async () => {
		primeDead();
		commitFixture();
		await service.reconcileMonitorLoss();
		expect(
			notifier.prepareSessionZombieDetected,
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ status: "failed" }),
			expect.objectContaining({
				kind: "process",
				observation: expect.objectContaining({ verdict: "dead" }),
			}),
			expect.anything(),
		);
		expect(bodyConverge.mock.invocationCallOrder[0]).toBeLessThan(
			mockedInspect.mock.invocationCallOrder[0],
		);
		expect(mockedInspect.mock.invocationCallOrder[0]).toBeLessThan(
			notifier.prepareSessionZombieDetected.mock.invocationCallOrder[0],
		);
		expect(
			notifier.prepareSessionZombieDetected.mock.invocationCallOrder[0],
		).toBeLessThan(
			notifier.persistPreparedZombieDetected.mock.invocationCallOrder[0],
		);
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("captures Codex death only after the durable death result", async () => {
		const snapshot = vi.fn();
		service = makeService(store, notifier, undefined, snapshot);
		store.getSession.mockReturnValue(sess({ adapter_type: "codex-tmux" }));
		primeDead();
		commitFixture();
		await service.reconcileMonitorLoss();
		expect(snapshot).toHaveBeenCalledWith(
			expect.objectContaining({ adapter_type: "codex-tmux", status: "failed" }),
			"body_death:process_writers_absent",
		);
	});
	it.each(["down", "unknown"])(
		"server %s cannot veto independently proven process death",
		async (state) => {
			mockedServer.mockResolvedValue(state as never);
			primeDead();
			commitFixture();
			await service.reconcileMonitorLoss();
			expect(bodyConverge).toHaveBeenCalledOnce();
			expect(notifier.persistPreparedZombieDetected).toHaveBeenCalledOnce();
			expect(mockedServer).not.toHaveBeenCalled();
			expect(mockedLookup).not.toHaveBeenCalled();
		},
	);
	it("a changed identity or recovery decision at common CAS produces no alert", async () => {
		primeDead();
		bodyConverge.mockResolvedValue({
			kind: "deferred",
			reason: "observation_stale",
		});
		await service.reconcileMonitorLoss();
		expect(bodyConverge).toHaveBeenCalledOnce();
		expect(mockedInspect).not.toHaveBeenCalled();
		expect(notifier.persistPreparedZombieDetected).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("terminal preservation does not emit a false failed-body alert", async () => {
		primeDead();
		bodyConverge.mockResolvedValue({
			kind: "committed",
			obligation: { disposition: "completion_preserved" },
			projection: { projected: true },
		} as never);
		await service.reconcileMonitorLoss();
		expect(bodyConverge).toHaveBeenCalledOnce();
		expect(mockedInspect).not.toHaveBeenCalled();
		expect(notifier.persistPreparedZombieDetected).not.toHaveBeenCalled();
	});
	it("removed candidates do not produce a second declaration", async () => {
		primeDead();
		commitFixture();
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss();
		expect(bodyConverge).toHaveBeenCalledOnce();
		expect(notifier.persistPreparedZombieDetected).toHaveBeenCalledOnce();
	});
	it("inspection failure leaves committed death for durable alert replay", async () => {
		primeDead();
		commitFixture();
		mockedInspect.mockRejectedValueOnce(new Error("git unavailable"));
		await service.reconcileMonitorLoss();
		expect(store.getSession("exec-z1").status).toBe("failed");
		expect(notifier.persistPreparedZombieDetected).not.toHaveBeenCalled();
	});
	it("an unresolvable Lead records a deterministic audit after death", async () => {
		primeDead();
		commitFixture();
		notifier.prepareSessionZombieDetected.mockReturnValue(null);
		await service.reconcileMonitorLoss();
		expect(store.getSession("exec-z1").status).toBe("failed");
		expect(store.insertEvent).toHaveBeenCalledWith(
			expect.objectContaining({ event_id: "zombie-alert-unroutable-exec-z1" }),
		);
	});
});

describe("M3 liveness-chain single-flight", () => {
	it("slow liveness pass spanning ticks: next check() skips the trio but still runs other stages; resumes after", async () => {
		const livenessTracker = {
			started: vi.fn(() => 1),
			completed: vi.fn(),
		};
		service = makeService(store, notifier, livenessTracker);
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let firstCall = true;
		mockedTry.mockImplementation(async () => {
			if (firstCall) {
				firstCall = false;
				await gate;
			}
			return { kind: "absent" };
		});
		store.getOrphanSessions.mockReturnValue([sess()]);
		const p1 = service.check();
		await new Promise((r) => setTimeout(r, 0));
		const reconcileReadsBefore = store.getOrphanSessions.mock.calls.length;
		const staleReadsBefore = store.getStaleCompletedSessions.mock.calls.length;
		const p2 = service.check(); // trio skipped, other stages run
		await new Promise((r) => setTimeout(r, 0));
		expect(livenessTracker.started).toHaveBeenCalledTimes(1);
		expect(livenessTracker.completed).not.toHaveBeenCalled();
		expect(store.getOrphanSessions.mock.calls.length).toBe(
			reconcileReadsBefore,
		);
		expect(store.getStaleCompletedSessions.mock.calls.length).toBeGreaterThan(
			staleReadsBefore,
		);
		release();
		await Promise.all([p1, p2]);
		expect(livenessTracker.completed).toHaveBeenCalledWith(1);
		// next tick re-enters normally
		await service.check();
		expect(store.getOrphanSessions.mock.calls.length).toBeGreaterThan(
			reconcileReadsBefore,
		);
	});

	it("post-liveness stage hang does NOT hold the guard: the trio re-enters on the next tick (code R1 #1)", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		// The stale-completed stage (AFTER the trio) hangs on its notifier call.
		store.getStaleCompletedSessions.mockReturnValueOnce([
			sess({ execution_id: "exec-stale", status: "completed" }),
		]);
		notifier.onSessionStale.mockImplementationOnce(async () => {
			await gate;
		});
		const p1 = service.check(); // trio completes fast, hangs in stale stage
		await new Promise((r) => setTimeout(r, 0));
		const reconcileReadsBefore = store.getOrphanSessions.mock.calls.length;
		await service.check(); // guard was released at trio exit → trio re-enters
		expect(store.getOrphanSessions.mock.calls.length).toBeGreaterThan(
			reconcileReadsBefore,
		);
		release();
		await p1;
	});
});

describe("M3 backfill wiring", () => {
	it("runs outside the liveness guard: backlog is consumed even while the chain is hung", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let entered!: () => void;
		const inReconcile = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let firstCall = true;
		mockedTry.mockImplementation(async () => {
			if (firstCall) {
				firstCall = false;
				entered();
				await gate;
			}
			return { kind: "absent" };
		});
		const failedZombie = sess({
			status: "failed",
			last_error:
				"zombie: tmux window runner-flywheel:@829 dead (pane probe absent x2, server up, at 2026-07-15T05:20:00.000Z)",
		});
		store.getOrphanSessions.mockReturnValue([sess()]);
		const p1 = service.check(); // hangs in reconcile
		await inReconcile;
		store.getZombieAlertBacklog.mockReturnValueOnce([failedZombie]);
		await service.check(); // trio skipped — but backfill runs
		expect(notifier.prepareSessionZombieDetected).toHaveBeenCalledWith(
			failedZombie,
			expect.objectContaining({ kind: "verified" }),
			expect.anything(),
		);
		expect(notifier.persistPreparedZombieDetected).toHaveBeenCalled();
		release();
		await p1;
	});

	it("malformed last_error → degraded unparseable evidence (no fabricated probe facts)", async () => {
		const malformed = sess({
			status: "failed",
			last_error: "zombie: something from an older vintage",
		});
		store.getZombieAlertBacklog.mockReturnValueOnce([malformed]);
		await service.check();
		expect(notifier.prepareSessionZombieDetected).toHaveBeenCalledWith(
			malformed,
			{ kind: "unparseable", rawLastError: malformed.last_error },
			expect.anything(),
		);
	});

	it("watermark advances past a poison row (prepare null) so later rows are not starved; unroutable audit written", async () => {
		const poison = sess({
			execution_id: "exec-aaa",
			status: "failed",
			last_error: "zombie: junk",
		});
		const healthy = sess({
			execution_id: "exec-bbb",
			status: "failed",
			last_error:
				"zombie: tmux window runner-flywheel:@830 dead (pane probe absent x2, server up, at 2026-07-15T05:20:00.000Z)",
		});
		notifier.prepareSessionZombieDetected.mockReturnValueOnce(null);
		store.getZombieAlertBacklog.mockImplementation((after: string) => {
			if (after < "exec-aaa") return [poison, healthy];
			if (after < "exec-bbb") return [healthy];
			return [];
		});
		await service.check(); // attempts poison → null → audit, watermark advances
		expect(store.insertEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event_id: "zombie-alert-unroutable-exec-aaa",
			}),
		);
		await service.check(); // next pass processes healthy
		expect(notifier.persistPreparedZombieDetected).toHaveBeenCalledTimes(1);
	});
});

describe("M4 cohort aggregation + flush ownership", () => {
	function threeSessions(): Session[] {
		return ["exec-a", "exec-b", "exec-c"].map((id) =>
			sess({ execution_id: id }),
		);
	}

	it("3 entrants in one pass → every notice carries the same final count + exactly one cohort log", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const rows = threeSessions();
		store.getSession.mockImplementation((id: string) =>
			rows.find((r) => r.execution_id === id),
		);
		store.getOrphanSessions.mockReturnValue(rows);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(3);
		for (const call of notifier.onSessionMonitoringReestablished.mock.calls) {
			expect(call[2].concurrentCount).toBe(3);
		}
		const cohortLogs = warn.mock.calls.filter((c) =>
			String(c[0]).includes("re-adopted in the same pass"),
		);
		expect(cohortLogs).toHaveLength(1);
		warn.mockRestore();
	});

	it("2 entrants → no concurrentCount property at all", async () => {
		const rows = threeSessions().slice(0, 2);
		store.getSession.mockImplementation((id: string) =>
			rows.find((r) => r.execution_id === id),
		);
		store.getOrphanSessions.mockReturnValue(rows);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(2);
		for (const call of notifier.onSessionMonitoringReestablished.mock.calls) {
			expect("concurrentCount" in call[2]).toBe(false);
		}
	});

	it("already-reconnecting members are NOT counted as new entrants", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		await service.reconcileMonitorLoss(); // enters
		notifier.onSessionMonitoringReestablished.mockClear();
		await service.reconcileMonitorLoss(); // stay — no new notice
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
	});

	it("episode cleared between collection and flush → that notice is skipped entirely", async () => {
		// clearReconnecting fires from inside the marker mock of a SECOND
		// candidate, i.e. after exec-a's intent was collected but before flush.
		const a = sess({ execution_id: "exec-a" });
		const b = sess({ execution_id: "exec-b" });
		store.getSession.mockImplementation((id: string) =>
			[a, b].find((r) => r.execution_id === id),
		);
		mockedTry.mockImplementation(async (execId: string) => {
			if (execId === "exec-b") service.clearReconnecting("exec-a");
			return { kind: "absent" };
		});
		store.getOrphanSessions.mockReturnValue([a, b]);
		await service.reconcileMonitorLoss();
		const notified = notifier.onSessionMonitoringReestablished.mock.calls.map(
			(c) => c[0].execution_id,
		);
		expect(notified).toEqual(["exec-b"]);
	});

	it("first flush throwing does not block the remaining notices", async () => {
		const rows = threeSessions();
		store.getSession.mockImplementation((id: string) =>
			rows.find((r) => r.execution_id === id),
		);
		store.getOrphanSessions.mockReturnValue(rows);
		notifier.onSessionMonitoringReestablished.mockRejectedValueOnce(
			new Error("transport down"),
		);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(3);
	});
});

describe("FLY-2505 shared recovery authority", () => {
	it.each(["pending_reservation", "readiness", "expired_readiness"])(
		"does not reinterpret %s as permission to fail",
		async (reason) => {
			store.getCodexRecoveryDeferral = vi.fn(() => ({
				reason,
				untilMs: Date.now() - 300001,
			}));
			store.getOrphanSessions.mockReturnValue([
				sess({ adapter_type: "codex-tmux" }),
			]);
			bodyObserve.mockImplementation(async (id) => ({
				...observation(id, "unknown"),
				reason: "recovery_active",
			}));
			bodyConverge.mockResolvedValue({
				kind: "deferred",
				reason: "body_unknown",
			});
			await service.reconcileMonitorLoss();
			await service.reapOrphans();
			expect(store.getCodexRecoveryDeferral).not.toHaveBeenCalled();
			expect(store.forceStatus).not.toHaveBeenCalled();
			expect(store.updateHeartbeat).not.toHaveBeenCalled();
			expect(mockedInspect).not.toHaveBeenCalled();
		},
	);
});

it("FLY-2505 zombie fallback retains parseable probe evidence alongside the recovery diagnostic", async () => {
	const { formatZombieLastError, parseZombieLastError } = await import(
		"../bridge/zombie-evidence.js"
	);
	const marker = formatZombieLastError(
		"runner:@42",
		2,
		"2026-09-11T00:00:00.000Z",
	);
	expect(
		parseZombieLastError(
			`${marker}; readiness_retry_exhausted: daemon_socket_not_ready/daemon_spawn; lastFailureEventId=event-1`,
		),
	).toEqual(parseZombieLastError(marker));
});
