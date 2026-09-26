/** FLY-2919: completion markers arriving across asynchronous death checks win. */

import {
	existsSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

vi.mock("../bridge/complete-marker-reconciler.js", () => ({
	defaultMarkerDir: () => process.env.FLYWHEEL_COMPLETE_MARKER_DIR!,
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
	onZombieDeclared?: (session: Session, reason: string) => void,
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
		undefined,
		onZombieDeclared,
	);
}

let markerDir: string;
let store: MockStore;
let notifier: MockNotifier;
let service: HeartbeatService;

beforeEach(() => {
	markerDir = mkdtempSync(join(tmpdir(), "fly2919-b1-"));
	vi.stubEnv("FLYWHEEL_COMPLETE_MARKER_DIR", markerDir);
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
	rmSync(markerDir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function marker() {
	writeFileSync(join(markerDir, "exec-z1.json"), "{}");
}
function prime() {
	store.getOrphanSessions.mockReturnValue([sess()]);
	mockedProbe.mockResolvedValue("absent");
}
describe("FLY-2919 completion before death", () => {
	it("reconciles a real completion arriving during zombie forensics before any failed transition", async () => {
		prime();
		mockedInspect.mockImplementation(async () => {
			marker();
			return { ok: false } as never;
		});
		mockedTry.mockImplementation(async () => {
			if (!existsSync(join(markerDir, "exec-z1.json")))
				return { kind: "absent" };
			unlinkSync(join(markerDir, "exec-z1.json"));
			store.getSession.mockReturnValue(sess({ status: "completed" }));
			return { kind: "reconciled", status: "completed" };
		});
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(notifier.prepareSessionZombieDetected).not.toHaveBeenCalled();
		expect(store.getSession("exec-z1").status).toBe("completed");
	});
	it.each(["transient_failed", "held_for_lead"] as const)(
		"holds %s completion through zombie and orphan paths",
		async (kind) => {
			prime();
			mockedInspect.mockImplementation(async () => {
				marker();
				mockedTry.mockResolvedValue(
					kind === "transient_failed"
						? { kind, error: "retry" }
						: { kind, invariant: "fixture", alertState: "accepted" },
				);
				return { ok: false } as never;
			});
			await service.reconcileMonitorLoss();
			await service.reconcileMonitorLoss();
			await service.reapOrphans();
			expect(store.forceStatus).not.toHaveBeenCalled();
			expect(notifier.onSessionOrphaned).not.toHaveBeenCalled();
		},
	);
	it("checks again after the final async server proof", async () => {
		prime();
		mockedServer
			.mockResolvedValueOnce("up")
			.mockResolvedValueOnce("up")
			.mockImplementationOnce(async () => {
				marker();
				return "up";
			});
		// Even a stale absent replay answer cannot override the on-disk pending marker.
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("reconciles a pending marker on the direct orphan entry without a prior monitor pass", async () => {
		prime();
		marker();
		mockedTry.mockResolvedValue({ kind: "reconciled", status: "completed" });
		await service.reapOrphans();
		expect(mockedTry).toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("blocks orphan death when marker directory access is unknown", async () => {
		prime();
		const notDirectory = join(markerDir, "not-a-directory");
		writeFileSync(notDirectory, "x");
		vi.stubEnv("FLYWHEEL_COMPLETE_MARKER_DIR", notDirectory);
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("vetoes a marker arriving after reconciliation at the synchronous mutation boundary", async () => {
		prime();
		notifier.prepareSessionZombieDetected.mockImplementation(() => {
			marker();
			return undefined;
		});
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("keeps failed quarantine moves pending instead of authorizing death", async () => {
		prime();
		marker();
		mockedTry.mockResolvedValue({
			kind: "quarantined",
			reason: "invalid",
			quarantinePath: "/unused",
		});
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
	it("holds death on replay rejection and rereads lifecycle after an absent replay", async () => {
		prime();
		mockedTry.mockRejectedValueOnce(new Error("replay unavailable"));
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
		service.stop();
		service = makeService(store, notifier);
		mockedTry.mockImplementation(async () => {
			store.getSession.mockReturnValue(sess({ lifecycle_revision: 2 }));
			return { kind: "absent" };
		});
		await service.reapOrphans();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});
});
