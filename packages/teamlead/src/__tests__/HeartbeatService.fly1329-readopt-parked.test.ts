/** FLY-1329/2919: parked readoption consumes process evidence, with no death exemption. */
import type { BodyObservation } from "flywheel-claude-runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/tmux-lookup.js", () => {
	const isTmuxWindowAlive = vi.fn(async () => true);
	const probeRunnerProcessLiveness = vi.fn(async () =>
		(await isTmuxWindowAlive("flywheel:@0")) ? "alive" : "absent",
	);
	return {
		getTmuxTargetFromCommDb: vi.fn(() => ({
			tmuxWindow: "flywheel:@0",
			sessionName: "flywheel",
		})),
		isTmuxWindowAlive,
		lookupTmuxTarget: vi.fn(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:@0", sessionName: "flywheel" },
		})),
		probeRunnerProcessLiveness,
		probeRunnerProcessLivenessDetailed: vi.fn(
			async (...args: Parameters<typeof probeRunnerProcessLiveness>) => ({
				liveness: await probeRunnerProcessLiveness(...args),
			}),
		),
	};
});

vi.mock("../bridge/complete-marker-reconciler.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../bridge/complete-marker-reconciler.js")
	>()),
	tryReconcileComplete: vi.fn(async () => ({ kind: "absent" })),
	applyQuarantineFallback: vi.fn(),
}));

import {
	isTmuxWindowAlive,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
} from "../bridge/tmux-lookup.js";
import {
	HeartbeatService,
	RegistryHeartbeatNotifier,
} from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

const mockedAlive = vi.mocked(isTmuxWindowAlive);
const mockedLookup = vi.mocked(lookupTmuxTarget);
const mockedProbe = vi.mocked(probeRunnerProcessLiveness);
const FOUND_TARGET = {
	kind: "found" as const,
	target: { tmuxWindow: "flywheel:@0", sessionName: "flywheel" },
};

const bodyObserve = vi.fn(
	async (executionId: string): Promise<BodyObservation> => ({
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
		verdict: "alive",
		observedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 10000).toISOString(),
		reason: "process_alive",
	}),
);
const bodyConverge = vi.fn(async () => ({
	kind: "deferred" as const,
	reason: "fixture_cas_refused",
}));
function bodyVerdict(verdict: BodyObservation["verdict"]) {
	bodyObserve.mockImplementation(async (executionId) => ({
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
	}));
}

/** The 532c634b shape: a parked implement at awaiting_review. */
function parkedImplement(over: Partial<Session> = {}): Session {
	return {
		execution_id: "parked-impl",
		issue_id: "FLY-1319",
		project_name: "flywheel",
		status: "awaiting_review",
		issue_identifier: "FLY-1319",
		heartbeat_at: "2026-07-16 04:00:00",
		last_activity_at: "2026-07-16 04:00:00",
		...over,
	};
}

type MockStore = Record<string, ReturnType<typeof vi.fn>>;
type MockNotifier = Record<string, ReturnType<typeof vi.fn>>;

function makeStore(candidate: Session): MockStore {
	return {
		getOrphanSessions: vi.fn().mockReturnValue([]),
		getStaleCompletedSessions: vi.fn().mockReturnValue([]),
		getAwaitingReviewTimedOut: vi.fn().mockReturnValue([]),
		getActiveSessions: vi.fn().mockReturnValue([]),
		getReadoptCandidateSessions: vi.fn().mockReturnValue([candidate]),
		getWorkflowExecutionProcessBody: vi.fn().mockReturnValue(undefined),
		getSession: vi.fn((id: string) =>
			id === candidate.execution_id ? candidate : undefined,
		),
		updateHeartbeat: vi.fn(),
		markGateTimeoutNotified: vi.fn(),
		forceStatus: vi.fn(),
		hasQuietWakeNotified: vi.fn().mockReturnValue(false),
		recordQuietWakeNotified: vi.fn(),
		clearQuietWakeNotified: vi.fn(),
		pruneQuietWakeNotifiedNotIn: vi.fn(),
	};
}

function makeNotifier(): MockNotifier {
	return {
		onSessionOrphaned: vi.fn().mockResolvedValue(undefined),
		onSessionStale: vi.fn().mockResolvedValue(undefined),
		onSessionMonitoringLost: vi.fn().mockResolvedValue(undefined),
		onSessionMonitoringReestablished: vi.fn().mockResolvedValue(undefined),
		clearReconnectStamp: vi.fn(),
	};
}

function makeService(
	store: MockStore,
	notifier: MockNotifier,
): HeartbeatService {
	const service = new HeartbeatService(
		store as never,
		notifier as never,
		15,
		60_000,
		60,
		undefined,
		24,
		6 * 3_600_000,
		{ bridgeBaseUrl: "http://127.0.0.1:9876", ingestToken: "tok" },
	);
	service.setExecutionBodyLifecycle({
		observe: bodyObserve,
		converge: bodyConverge,
	});
	return service;
}

beforeEach(() => {
	bodyObserve.mockReset();
	bodyConverge.mockClear();
	bodyVerdict("alive");
	mockedAlive.mockReset().mockResolvedValue(true);
	// Restore the default "found + derives from isTmuxWindowAlive" tri-state so a
	// per-test override (lookup error / probe throw) never leaks to the next test.
	mockedLookup.mockReset().mockReturnValue(FOUND_TARGET);
	mockedProbe
		.mockReset()
		.mockImplementation(async () =>
			(await isTmuxWindowAlive("flywheel:@0")) ? "alive" : "absent",
		);
});

describe("FLY-1329 A3 — parked readopt", () => {
	let store: MockStore;
	let notifier: MockNotifier;
	let service: HeartbeatService;

	afterEach(() => {
		service?.stop();
	});

	it("RE-ADOPTS a parked awaiting_review implement whose process is alive (FLY-1319 shape)", async () => {
		store = makeStore(parkedImplement());
		notifier = makeNotifier();
		service = makeService(store, notifier);
		mockedAlive.mockResolvedValue(true);

		await service.seedReconnecting();

		// The proof the parked candidate was NOT dropped on entry: monitoring
		// was restored (heartbeat refreshed + re-established advisory).
		expect(store.updateHeartbeat).toHaveBeenCalledWith("parked-impl");
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
		// A re-adopt is never a status change.
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("re-adopts a parked design_done too", async () => {
		store = makeStore(parkedImplement({ status: "design_done" }));
		notifier = makeNotifier();
		service = makeService(store, notifier);
		mockedAlive.mockResolvedValue(true);

		await service.seedReconnecting();

		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
	});

	it("re-adopts the neutral pre-Gate ship_parked carrier too", async () => {
		store = makeStore(parkedImplement({ status: "ship_parked" }));
		notifier = makeNotifier();
		service = makeService(store, notifier);

		await service.seedReconnecting();

		expect(store.updateHeartbeat).toHaveBeenCalledWith("parked-impl");
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(1);
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("requires independent process evidence even for a durable standby row", async () => {
		store = makeStore(parkedImplement({ status: "ship_parked" }));
		store.getWorkflowExecutionProcessBody.mockReturnValue({ state: "standby" });
		bodyVerdict("unknown");
		notifier = makeNotifier();
		service = makeService(store, notifier);

		await service.seedReconnecting();

		expect(mockedProbe).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(bodyObserve).toHaveBeenCalled();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Number),
			{ unverified: true },
		);
	});

	it("a parked implement with no window but a live process is re-adopted", async () => {
		store = makeStore(parkedImplement());
		notifier = makeNotifier();
		service = makeService(store, notifier);
		mockedAlive.mockResolvedValue(false); // window gone

		await service.seedReconnecting();

		expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledOnce();
		expect(bodyConverge).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).toHaveBeenCalled();
	});

	// Codex R2 MEDIUM: the boolean isSessionTmuxAlive folded `indeterminate`
	// (probe/CommDB failure) into "alive". A probe failure must ONLY alert
	// (unverified), never refresh the heartbeat or announce re-establishment —
	// otherwise a dead parked session is life-supported forever.
	it("unknown process evidence → unverified alert, NOT a re-adopt", async () => {
		bodyVerdict("unknown");
		store = makeStore(parkedImplement());
		notifier = makeNotifier();
		service = makeService(store, notifier);

		await service.seedReconnecting();

		// Alert-only, and explicitly UNVERIFIED (the 3-arg details form).
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "parked-impl" }),
			expect.any(Number),
			{ unverified: true },
		);
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
	});

	it("process observation failure → unverified alert, never re-adopt", async () => {
		bodyObserve.mockRejectedValue(new Error("process sample failed"));
		store = makeStore(parkedImplement());
		notifier = makeNotifier();
		service = makeService(store, notifier);

		await service.seedReconnecting();

		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "parked-impl" }),
			expect.any(Number),
			{ unverified: true },
		);
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
	});

	it("a proven-dead parked process is sent to common death convergence on the first pass", async () => {
		bodyVerdict("dead");
		store = makeStore(parkedImplement());
		notifier = makeNotifier();
		service = makeService(store, notifier);

		await service.seedReconnecting();

		expect(bodyConverge).toHaveBeenCalledExactlyOnceWith("parked-impl");
		expect(mockedProbe).not.toHaveBeenCalled();
		expect(mockedLookup).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
	});
});

/**
 * Codex R3 MEDIUM: verifying the mock notifier's ARGUMENTS is not enough — it
 * locks the call shape but not the PAYLOAD. The real notifier renders the death
 * verdict into a Discord alert body; that copy must be honest. These drive the
 * production RegistryHeartbeatNotifier and assert the final notification_context.
 */
describe("FLY-1329 A3 — the monitor-lost alert copy is honest (real notifier)", () => {
	// Minimal deps: onSessionMonitoringLost only reads the session + minutes +
	// details, then hands a payload to deliverHook (spied to capture the copy).
	async function contextFor(details?: {
		unverified?: boolean;
		parkedLiveness?: "dead" | "dead_pin" | "gone";
	}): Promise<string> {
		const notifier = new RegistryHeartbeatNotifier(
			{} as never,
			[] as never,
			{} as never,
		);
		let captured = "";
		vi.spyOn(
			notifier as unknown as { deliverHook: (...a: unknown[]) => unknown },
			"deliverHook",
		).mockImplementation((_s: unknown, payload: unknown) => {
			captured = (payload as { notification_context: string })
				.notification_context;
			return Promise.resolve();
		});
		await notifier.onSessionMonitoringLost(
			parkedImplement() as never,
			5,
			details,
		);
		return captured;
	}

	it("dead_pin renders provable-death copy, NEVER 'still alive'", async () => {
		const ctx = await contextFor({ parkedLiveness: "dead_pin" });
		expect(ctx).not.toContain("still alive");
		expect(ctx.toLowerCase()).toContain("provably");
	});

	it("dead/gone renders 'could NOT be confirmed alive OR dead', NEVER 'still alive'", async () => {
		for (const v of ["dead", "gone"] as const) {
			const ctx = await contextFor({ parkedLiveness: v });
			expect(ctx).not.toContain("still alive");
			expect(ctx).toContain("could NOT be confirmed alive OR dead");
		}
	});

	it("unverified (indeterminate) keeps the could-not-verify copy", async () => {
		const ctx = await contextFor({ unverified: true });
		expect(ctx).not.toContain("still alive");
		expect(ctx).toContain("could NOT be verified");
	});

	it("the legacy two-argument call keeps the 'still alive' copy byte-for-byte", async () => {
		const ctx = await contextFor(undefined);
		expect(ctx).toContain("still alive and working");
	});
});
