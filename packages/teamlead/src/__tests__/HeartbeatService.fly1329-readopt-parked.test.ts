/**
 * FLY-1329 (A3, Codex R1 HIGH-1): widening the boot re-adopt CANDIDATE query is a
 * no-op unless the CONSUMERS also stop discarding non-`running` rows.
 *
 * `seedReconnecting` now pulls `getReadoptCandidateSessions` (running +
 * awaiting_review + design_done + approved_to_ship). But both consumers —
 * `reconcileCandidateReadopt` (legacy) and `reconcileCandidateReadoptV2`
 * (zombie-ON) — opened with `if (status !== "running") { clearReconnecting; return }`.
 * So every parked candidate was dropped on entry and the widened query bought
 * nothing: the FLY-1319 parked implement was STILL never re-adopted.
 *
 * A parked phase (awaiting_review / design_done / approved_to_ship) is a
 * keep-alive runner intentionally waiting for the pipeline, NOT a terminalized
 * session. It must be re-adopted: monitoring restored if its tmux is alive,
 * alert-only if not — and NEVER a status change or close.
 *
 * Mocks mirror monitor-loss.test.ts so the two consumers are exercised
 * deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/tmux-lookup.js", () => {
	const isTmuxWindowAlive = vi.fn(async () => true);
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
		probeRunnerProcessLiveness: vi.fn(async () =>
			(await isTmuxWindowAlive("flywheel:@0")) ? "alive" : "absent",
		),
	};
});

vi.mock("../bridge/complete-marker-reconciler.js", () => ({
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
	);
}

beforeEach(() => {
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

	it("RE-ADOPTS a parked awaiting_review implement whose tmux is alive (FLY-1319 shape)", async () => {
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

	it("a parked implement whose tmux is DEAD → alert-only, never a status change or re-adopt", async () => {
		store = makeStore(parkedImplement());
		notifier = makeNotifier();
		service = makeService(store, notifier);
		mockedAlive.mockResolvedValue(false); // window gone

		await service.seedReconnecting();

		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
		expect(store.forceStatus).not.toHaveBeenCalled();
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
	});

	// Codex R2 MEDIUM: the boolean isSessionTmuxAlive folded `indeterminate`
	// (probe/CommDB failure) into "alive". A probe failure must ONLY alert
	// (unverified), never refresh the heartbeat or announce re-establishment —
	// otherwise a dead parked session is life-supported forever.
	it("indeterminate via a CommDB lookup error → unverified alert, NOT a re-adopt", async () => {
		mockedLookup.mockReturnValue({ kind: "error", error: "db locked" });
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

	it("indeterminate via a probe throw → unverified alert, never enterReconnecting", async () => {
		mockedProbe.mockRejectedValue(new Error("tmux probe blew up"));
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

	it("a dead-pin corpse → alert carries the death verdict (NOT unverified, NOT 'still alive'), never a re-adopt", async () => {
		mockedProbe.mockResolvedValue("dead_pin");
		store = makeStore(parkedImplement());
		notifier = makeNotifier();
		service = makeService(store, notifier);

		await service.seedReconnecting();

		// dead_pin is provable death, not a probe failure: the alert must carry
		// the death verdict (so the notifier renders honest death copy, not the
		// legacy "still alive"), and never the re-established notice / heartbeat.
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "parked-impl" }),
			expect.any(Number),
			{ parkedLiveness: "dead_pin" },
		);
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
