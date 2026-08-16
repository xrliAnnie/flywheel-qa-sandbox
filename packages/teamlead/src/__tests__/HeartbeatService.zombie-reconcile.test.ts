/**
 * FLY-1282 M2/M3/M4: zombie-ON tri-state consumption + declaration + backfill.
 *
 * These are the NEW-behavior tests (the OFF-path contract lives in
 * HeartbeatService.zombie-offpath-golden.test.ts; the FLY-623 legacy
 * consumption stays frozen in HeartbeatService.monitor-loss.test.ts under
 * ZOMBIE_RECONCILE=0).
 */
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
		probeTmuxServer,
	};
});

vi.mock("../bridge/complete-marker-reconciler.js", () => ({
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
): HeartbeatService {
	return new HeartbeatService(
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
	);
}

let store: MockStore;
let notifier: MockNotifier;
let service: HeartbeatService;

beforeEach(() => {
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
	mockedInspect.mockClear();
	store = makeStore();
	notifier = makeNotifier();
	service = makeService(store, notifier);
});

afterEach(() => {
	service.stop();
});

describe("M2 tri-state dispatch", () => {
	it("settled ship-attempt marker is fully consumed before the tri-state liveness chain", async () => {
		mockedTry.mockResolvedValue({
			kind: "settled_ship_attempt_failed",
			settle: "marked",
		});
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(mockedProbe).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
	});

	it("alive → re-adopt with probe evidence (heartbeat refresh + one aggregated notice)", async () => {
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-z1");
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
		const details = notifier.onSessionMonitoringReestablished.mock.calls[0][2];
		expect(details.livenessProbe).toMatchObject({
			target: "runner-flywheel:@829",
		});
		expect(typeof details.livenessProbe.probedAt).toBe("string");
		// below-cohort: no concurrent count key at all
		expect("concurrentCount" in details).toBe(false);
	});

	it("pane-probe indeterminate → honest monitor-lost advisory: no celebration, no heartbeat refresh, suppression holds", async () => {
		mockedProbe.mockResolvedValue("indeterminate");
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		await service.check();
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledWith(
			s,
			expect.any(Number),
			{ unverified: true },
		);
		// suppression: no orphan force-fail
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("CommDB error → same honest indeterminate treatment (never celebrated)", async () => {
		mockedLookup.mockReturnValue({ kind: "error", error: "SQLITE_BUSY" });
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
	});

	it("absent x1 → zombieHeld suppression: even past orphan threshold, NOT generic-reaped", async () => {
		mockedProbe.mockResolvedValue("absent");
		const s = sess({ heartbeat_at: "2026-07-15 06:00:00" }); // hours stale
		store.getOrphanSessions.mockReturnValue([s]);
		await service.check(); // one full pass: absent#1
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.onSessionOrphaned).not.toHaveBeenCalled();
		expect(notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
	});

	it("absent → alive → absent resets the streak (no declaration on the 3rd probe)", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		mockedProbe.mockResolvedValueOnce("absent");
		await service.reconcileMonitorLoss(); // streak 1
		mockedProbe.mockResolvedValueOnce("alive");
		await service.reconcileMonitorLoss(); // clears streak
		mockedProbe.mockResolvedValueOnce("absent");
		await service.reconcileMonitorLoss(); // streak 1 again — no declare
		expect(notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("indeterminate → dead_pin: monitor-lost suppression released to the crash-reaper owner", async () => {
		const s = sess();
		store.getOrphanSessions.mockReturnValue([s]);
		mockedProbe.mockResolvedValueOnce("indeterminate");
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
		mockedProbe.mockResolvedValue("dead_pin");
		await service.reconcileMonitorLoss();
		// suppression marker cleared → generic orphan path can act again
		await service.reapOrphans();
		expect(store.forceStatus).toHaveBeenCalledTimes(1);
	});

	it("exit-then-reenter the candidate union restarts the streak at 1", async () => {
		const s = sess();
		mockedProbe.mockResolvedValue("absent");
		store.getOrphanSessions.mockReturnValue([s]);
		await service.reconcileMonitorLoss(); // streak 1
		store.getOrphanSessions.mockReturnValue([]); // left the union
		await service.reconcileMonitorLoss(); // prune
		store.getOrphanSessions.mockReturnValue([s]); // re-entered
		await service.reconcileMonitorLoss(); // streak restarts at 1 → no declare
		expect(notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
	});
});

describe("M3 declaration", () => {
	function primeTwoAbsentPasses(s: Session = sess()) {
		mockedProbe.mockResolvedValue("absent");
		store.getOrphanSessions.mockReturnValue([s]);
	}

	it("absent x2 (server up) → full order: forensics, re-proof, prepare, transition, persist", async () => {
		primeTwoAbsentPasses();
		await service.reconcileMonitorLoss(); // streak 1
		await service.reconcileMonitorLoss(); // streak 2 → declare
		expect(mockedInspect).toHaveBeenCalledWith("/tmp/wt");
		expect(notifier.prepareSessionZombieDetected).toHaveBeenCalledTimes(1);
		const evidence = notifier.prepareSessionZombieDetected.mock.calls[0][1];
		expect(evidence.kind).toBe("verified");
		expect(evidence.liveness.target).toBe("runner-flywheel:@829");
		expect(evidence.streak).toBe(2);
		expect(notifier.persistPreparedZombieDetected).toHaveBeenCalledTimes(1);
		// no transitionOpts in this fixture → legacy forceStatus seam
		expect(store.forceStatus).toHaveBeenCalledWith(
			"exec-z1",
			"failed",
			expect.any(String),
			expect.stringMatching(/^zombie: tmux window runner-flywheel:@829 dead/),
		);
	});

	it("server sequence down,down,up,up → declares only after the SECOND server-up absent", async () => {
		primeTwoAbsentPasses();
		mockedServer.mockResolvedValueOnce("down");
		await service.reconcileMonitorLoss(); // absent + down → reset
		mockedServer.mockResolvedValueOnce("down");
		await service.reconcileMonitorLoss(); // absent + down → reset
		mockedServer.mockResolvedValue("up");
		await service.reconcileMonitorLoss(); // absent + up → streak 1
		expect(notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
		await service.reconcileMonitorLoss(); // absent + up → streak 2 → declare
		expect(notifier.prepareSessionZombieDetected).toHaveBeenCalledTimes(1);
	});

	it("server sequence unknown,up,up → same: only the two server-up absents count", async () => {
		primeTwoAbsentPasses();
		mockedServer.mockResolvedValueOnce("unknown");
		await service.reconcileMonitorLoss();
		mockedServer.mockResolvedValue("up");
		await service.reconcileMonitorLoss();
		expect(notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
		await service.reconcileMonitorLoss();
		expect(notifier.prepareSessionZombieDetected).toHaveBeenCalledTimes(1);
	});

	it("re-proof re-runs the FULL probe incl. fresh CommDB lookup: remapped-to-live window aborts (zero transition, zero alert)", async () => {
		primeTwoAbsentPasses();
		await service.reconcileMonitorLoss(); // streak 1
		// During the declaration's forensics the CommDB mapping moves to a NEW
		// live window (rescue). The re-proof's fresh lookup must see it.
		mockedInspect.mockImplementationOnce(async () => {
			mockedLookup.mockReturnValue({
				kind: "found",
				target: {
					tmuxWindow: "runner-flywheel:@900",
					sessionName: "runner-flywheel",
				},
			});
			mockedProbe.mockResolvedValue("alive");
			return { ok: true, worktreePath: "/tmp/wt" };
		});
		await service.reconcileMonitorLoss(); // streak 2 → declare → re-proof aborts
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.persistPreparedZombieDetected).not.toHaveBeenCalled();
	});

	it("re-proof aborts when the session terminalized during forensics", async () => {
		primeTwoAbsentPasses();
		await service.reconcileMonitorLoss();
		mockedInspect.mockImplementationOnce(async () => {
			store.getSession.mockReturnValue(sess({ status: "completed" }));
			return { ok: true, worktreePath: "/tmp/wt" };
		});
		await service.reconcileMonitorLoss();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.persistPreparedZombieDetected).not.toHaveBeenCalled();
	});

	it("re-proof aborts when the server flips down during forensics", async () => {
		primeTwoAbsentPasses();
		await service.reconcileMonitorLoss();
		mockedInspect.mockImplementationOnce(async () => {
			mockedServer.mockResolvedValue("down");
			return { ok: true, worktreePath: "/tmp/wt" };
		});
		await service.reconcileMonitorLoss();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("FSM-rejected transition → loud abort: no event, no force override", async () => {
		const persistTransition = vi.fn();
		const rejectingOpts = {
			store: { ...store, persistTransition } as never,
			fsm: { transition: vi.fn(() => ({ ok: false, error: "illegal" })) },
		};
		const svc = new HeartbeatService(
			store as never,
			notifier as never,
			15,
			60_000,
			60,
			rejectingOpts as never,
			24,
			6 * 3_600_000,
			{ bridgeBaseUrl: "http://127.0.0.1:9876", ingestToken: "tok" },
		);
		mockedProbe.mockResolvedValue("absent");
		store.getOrphanSessions.mockReturnValue([sess()]);
		await svc.reconcileMonitorLoss();
		await svc.reconcileMonitorLoss();
		expect(persistTransition).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.persistPreparedZombieDetected).not.toHaveBeenCalled();
		svc.stop();
	});

	it("declaration fires exactly once (post-transition the session leaves running candidates)", async () => {
		primeTwoAbsentPasses();
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss(); // declares; fixture keeps returning the row
		store.getSession.mockReturnValue(sess({ status: "failed" }));
		store.getOrphanSessions.mockReturnValue([]);
		await service.reconcileMonitorLoss();
		expect(notifier.persistPreparedZombieDetected).toHaveBeenCalledTimes(1);
	});

	it("worktree inspection failure degrades but never eats the alert", async () => {
		mockedInspect.mockResolvedValue({
			ok: false,
			error: "git exploded",
		});
		primeTwoAbsentPasses();
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss();
		expect(notifier.prepareSessionZombieDetected).toHaveBeenCalledTimes(1);
		const inspection = notifier.prepareSessionZombieDetected.mock.calls[0][2];
		expect(inspection.ok).toBe(false);
		expect(notifier.persistPreparedZombieDetected).toHaveBeenCalledTimes(1);
	});

	it("lead unresolvable (prepare → null) → transition still happens + deterministic session_events audit", async () => {
		notifier.prepareSessionZombieDetected.mockReturnValue(null);
		primeTwoAbsentPasses();
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss();
		expect(store.forceStatus).toHaveBeenCalledTimes(1); // state truth first
		expect(store.insertEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				event_id: "zombie-alert-unroutable-exec-z1",
				event_type: "session_zombie_detected",
				source: "bridge.zombie-reconcile",
				// Code R1 #7: the audit records the FRESH zombie last_error — the
				// pre-transition snapshot's (stale) value must never be frozen in
				// by the deterministic event id.
				payload: expect.objectContaining({
					last_error: expect.stringMatching(
						/^zombie: tmux window .* dead \(pane probe absent x\d+, server up, at /,
					),
				}),
			}),
		);
		expect(notifier.persistPreparedZombieDetected).not.toHaveBeenCalled();
	});
});

describe("M2 quarantine wiring", () => {
	it("passes the tri-state verdict to applyQuarantineFallback (mutation guard — deleting the param must fail HERE, code R3)", async () => {
		mockedTry.mockResolvedValue({
			kind: "quarantined",
			routeStatus: "blocked",
			quarantinePath: "/q/exec-z1.json",
		});
		mockedProbe.mockResolvedValue("indeterminate");
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		const { applyQuarantineFallback } = await import(
			"../bridge/complete-marker-reconciler.js"
		);
		expect(vi.mocked(applyQuarantineFallback)).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-z1",
				tmuxAlive: true, // legacy meaning: not-provably-dead
				livenessVerdict: "indeterminate",
			}),
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
		let firstCall = true;
		mockedTry.mockImplementation(async () => {
			if (firstCall) {
				firstCall = false;
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
		store.getZombieAlertBacklog.mockReturnValueOnce([failedZombie]);
		const p1 = service.check(); // hangs in reconcile
		await new Promise((r) => setTimeout(r, 0));
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
