/**
 * FLY-1282 M0: OFF-path goldens frozen on pre-zombie-reconcile HEAD.
 *
 * These tests capture the EXACT current behavior of the readopt consumption
 * path and the RegistryHeartbeatNotifier delivery lifecycle BEFORE the
 * FLY-1282 refactor lands, under every kill-switch combination that must stay
 * byte-compatible afterwards (INV-5 / INV-7):
 *   - FLYWHEEL_ZOMBIE_RECONCILE=0
 *   - FLYWHEEL_LIVENESS_PANE_DEAD=0
 *   - both simultaneously
 *   - FLYWHEEL_HEARTBEAT_READOPT=0 (legacy, with zombie switches at defaults)
 *
 * On HEAD the new switches are simply ignored — which is the point: after the
 * implementation lands, running with the switch OFF must reproduce exactly
 * what this file froze. Do NOT "fix" these assertions to match new behavior;
 * they are the rollback contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/tmux-lookup.js", () => {
	const isTmuxWindowAlive = vi.fn(async () => true);
	const probeRunnerProcessLiveness = vi.fn(async () => "alive");
	const probeTmuxServer = vi.fn(async () => "up");
	return {
		getTmuxTargetFromCommDb: vi.fn(() => ({
			tmuxWindow: "flywheel:@9",
			sessionName: "flywheel",
		})),
		isTmuxWindowAlive,
		lookupTmuxTarget: vi.fn(() => ({
			kind: "found",
			target: { tmuxWindow: "flywheel:@9", sessionName: "flywheel" },
		})),
		probeRunnerProcessLiveness,
		probeTmuxServer,
	};
});

vi.mock("../bridge/complete-marker-reconciler.js", () => ({
	tryReconcileComplete: vi.fn(async () => ({ kind: "absent" })),
	applyQuarantineFallback: vi.fn(),
}));

import { tryReconcileComplete } from "../bridge/complete-marker-reconciler.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	probeTmuxServer,
} from "../bridge/tmux-lookup.js";
import {
	HeartbeatService,
	RegistryHeartbeatNotifier,
} from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

const mockedTry = vi.mocked(tryReconcileComplete);
const mockedProbe = vi.mocked(probeRunnerProcessLiveness);
const mockedLookup = vi.mocked(lookupTmuxTarget);
const mockedServer = vi.mocked(probeTmuxServer);

function sess(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-g1",
		issue_id: "FLY-1282",
		issue_identifier: "FLY-1282",
		project_name: "flywheel",
		status: "running",
		heartbeat_at: "2026-07-15 09:00:00",
		last_activity_at: "2026-07-15 09:00:00",
		...overrides,
	} as Session;
}

type MockFn = ReturnType<typeof vi.fn>;
type MockStore = Record<string, MockFn>;
type MockNotifier = Record<string, MockFn>;

function makeStore(): MockStore {
	return {
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
		getSession: vi.fn((id: string) => (id === "exec-g1" ? sess() : undefined)),
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

const SWITCH_COMBOS: Array<{ name: string; env: Record<string, string> }> = [
	{ name: "ZOMBIE_RECONCILE=0", env: { FLYWHEEL_ZOMBIE_RECONCILE: "0" } },
	{ name: "LIVENESS_PANE_DEAD=0", env: { FLYWHEEL_LIVENESS_PANE_DEAD: "0" } },
	{
		name: "both zombie switches off",
		env: { FLYWHEEL_ZOMBIE_RECONCILE: "0", FLYWHEEL_LIVENESS_PANE_DEAD: "0" },
	},
];

beforeEach(() => {
	mockedTry.mockReset().mockResolvedValue({ kind: "absent" });
	mockedProbe.mockReset().mockResolvedValue("alive");
	mockedServer.mockReset().mockResolvedValue("up");
	mockedLookup.mockReset().mockReturnValue({
		kind: "found",
		target: { tmuxWindow: "flywheel:@9", sessionName: "flywheel" },
	});
});

afterEach(() => {
	delete process.env.FLYWHEEL_ZOMBIE_RECONCILE;
	delete process.env.FLYWHEEL_LIVENESS_PANE_DEAD;
	delete process.env.FLYWHEEL_HEARTBEAT_READOPT;
});

for (const combo of SWITCH_COMBOS) {
	describe(`OFF-path golden — readopt consumption under ${combo.name}`, () => {
		let store: MockStore;
		let notifier: MockNotifier;
		let service: HeartbeatService;

		beforeEach(() => {
			for (const [k, v] of Object.entries(combo.env)) process.env[k] = v;
			store = makeStore();
			notifier = makeNotifier();
			service = makeService(store, notifier);
		});
		afterEach(() => service.stop());

		it("alive → re-adopt: heartbeat refreshed + ONE reestablished with exact 3-arg shape", async () => {
			store.getOrphanSessions.mockReturnValue([sess()]);
			await service.reconcileMonitorLoss();
			expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-g1");
			expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(
				1,
			);
			// Golden: EXACT legacy details object — no livenessProbe / concurrentCount keys.
			const call = notifier.onSessionMonitoringReestablished.mock.calls[0];
			expect(call[0]).toEqual(sess());
			expect(typeof call[1]).toBe("number");
			expect(call[2]).toEqual({ stampReconnectTitle: true });
			expect(Object.keys(call[2]).sort()).toEqual(["stampReconnectTitle"]);
			expect(call.length).toBe(3);
		});

		it("CommDB error → treated alive: celebrate + refresh (the pre-FLY-1282 conflation, frozen)", async () => {
			mockedLookup.mockReturnValue({ kind: "error", error: "SQLITE_BUSY" });
			store.getOrphanSessions.mockReturnValue([sess()]);
			await service.reconcileMonitorLoss();
			expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-g1");
			expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(
				1,
			);
			expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		});

		it("pane probe indeterminate → treated alive: celebrate + refresh (frozen conflation)", async () => {
			mockedProbe.mockResolvedValue("indeterminate");
			store.getOrphanSessions.mockReturnValue([sess()]);
			await service.reconcileMonitorLoss();
			// PANE_DEAD=0 path never calls probeRunnerProcessLiveness (window-existence
			// boolean instead, which our mock derives as alive) — both variants land
			// on celebrate+refresh, which is exactly the frozen conflation.
			expect(store.updateHeartbeat).toHaveBeenCalledWith("exec-g1");
			expect(notifier.onSessionMonitoringReestablished).toHaveBeenCalledTimes(
				1,
			);
			expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
		});

		it("absent → silent clear: NO status transition, NO event, ages into generic orphan reap", async () => {
			mockedProbe.mockResolvedValue("absent");
			const { isTmuxWindowAlive } = await import("../bridge/tmux-lookup.js");
			vi.mocked(isTmuxWindowAlive).mockResolvedValue(false);
			store.getOrphanSessions.mockReturnValue([sess()]);
			await service.reconcileMonitorLoss();
			expect(service.isReconnecting("exec-g1")).toBe(false);
			expect(store.forceStatus).not.toHaveBeenCalled();
			expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
			expect(notifier.onSessionMonitoringLost).not.toHaveBeenCalled();
			// Golden: death detection point does NOTHING — the zombie gap being fixed.
			await service.reapOrphans();
			expect(store.forceStatus).toHaveBeenCalledWith(
				"exec-g1",
				"failed",
				expect.any(String),
				expect.stringContaining("Orphaned"),
			);
			vi.mocked(isTmuxWindowAlive).mockResolvedValue(true);
		});

		it("counterfactuals: zero probeTmuxServer calls, zero new event types", async () => {
			store.getOrphanSessions.mockReturnValue([sess()]);
			await service.reconcileMonitorLoss();
			await service.check();
			expect(mockedServer).not.toHaveBeenCalled();
			const emitted = [
				...notifier.onSessionMonitoringReestablished.mock.calls,
				...notifier.onSessionMonitoringLost.mock.calls,
			];
			expect(emitted.length).toBeGreaterThan(0); // sanity: path exercised
			expect(Object.keys(notifier).includes("onSessionZombieDetected")).toBe(
				false,
			);
		});

		it("check() has no single-flight guard: two concurrent check() calls both run to completion", async () => {
			// Golden overlap semantics: a slow in-flight check() does not cause the
			// next tick's check() to be skipped. We prove both invocations executed
			// the reconcile phase by counting getOrphanSessions reads.
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
			const p2 = service.check();
			release();
			await Promise.all([p1, p2]);
			// Both passes ran reconcile (>= 2 orphan-set reads across the two checks).
			expect(store.getOrphanSessions.mock.calls.length).toBeGreaterThanOrEqual(
				2,
			);
		});
	});
}

describe("OFF-path golden — READOPT=0 legacy with zombie switches at defaults", () => {
	let store: MockStore;
	let notifier: MockNotifier;
	let service: HeartbeatService;

	beforeEach(() => {
		process.env.FLYWHEEL_HEARTBEAT_READOPT = "0";
		store = makeStore();
		notifier = makeNotifier();
		service = makeService(store, notifier);
	});
	afterEach(() => {
		service.stop();
		delete process.env.FLYWHEEL_HEARTBEAT_READOPT;
	});

	it("legacy advisory path byte-frozen: monitoring_lost once, 2-arg call, no refresh", async () => {
		store.getOrphanSessions.mockReturnValue([sess()]);
		await service.reconcileMonitorLoss();
		await service.reconcileMonitorLoss();
		expect(notifier.onSessionMonitoringLost).toHaveBeenCalledTimes(1);
		const call = notifier.onSessionMonitoringLost.mock.calls[0];
		expect(call.length).toBe(2); // arity sentinel: NO details third arg on legacy
		expect(store.updateHeartbeat).not.toHaveBeenCalled();
		expect(notifier.onSessionMonitoringReestablished).not.toHaveBeenCalled();
	});

	it("legacy chain is NOT serialized: overlapping check() calls both execute reconcile", async () => {
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
		const p2 = service.check();
		release();
		await Promise.all([p1, p2]);
		expect(store.getOrphanSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("seedReconnecting stays a no-op string[] under kill-switch", async () => {
		store.getActiveSessions.mockReturnValue([sess()]);
		store.getReadoptCandidateSessions.mockReturnValue([sess()]);
		const seeded = await service.seedReconnecting();
		expect(seeded).toEqual([]);
		expect(Array.isArray(seeded)).toBe(true);
	});
});

describe("OFF-path golden — seedReconnecting FLY-1264 contract (readopt ON, zombie switches off)", () => {
	it("returns string[] of newly title-activated execs; settleReconnectTitles consumes them", async () => {
		process.env.FLYWHEEL_ZOMBIE_RECONCILE = "0";
		const store = makeStore();
		const notifier = makeNotifier();
		const service = makeService(store, notifier);
		store.getActiveSessions.mockReturnValue([sess()]);
		store.getReadoptCandidateSessions.mockReturnValue([sess()]);
		const seeded = await service.seedReconnecting();
		expect(seeded).toEqual(["exec-g1"]);
		expect(service.isReconnectTitleActive("exec-g1")).toBe(true);
		// The FLY-1264 consumption chain: restoreReconnectTitles(bootIds) feeds
		// settleReconnectTitles(ids) — returned sessions drive canonical refresh.
		const settled = service.settleReconnectTitles(seeded);
		expect(settled.map((s) => s.execution_id)).toEqual(["exec-g1"]);
		expect(service.isReconnectTitleActive("exec-g1")).toBe(false);
		service.stop();
		delete process.env.FLYWHEEL_ZOMBIE_RECONCILE;
	});
});

// ── RegistryHeartbeatNotifier payload goldens ────────────────────────────────

function makeRegistryFixture(opts?: { deliverImpl?: MockFn }): {
	notifier: RegistryHeartbeatNotifier;
	store: MockStore;
	deliver: MockFn;
	appendPayloads: string[];
} {
	const deliver = opts?.deliverImpl ?? vi.fn(async () => ({ delivered: true }));
	const appendPayloads: string[] = [];
	const store: MockStore = {
		getSessionLabels: vi.fn().mockReturnValue([]),
		appendLeadEvent: vi.fn(
			(_agent: string, _eventId: string, _type: string, payload: string) => {
				appendPayloads.push(payload);
				return 41;
			},
		),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
	};
	const registry = {
		resolveWithLead: vi.fn(() => ({
			runtime: { deliver },
			lead: { agentId: "flywheel-eng-lead", chatChannel: "chan-1" },
		})),
		getForLead: vi.fn(() => ({ deliver })),
	};
	const notifier = new RegistryHeartbeatNotifier(
		registry as never,
		[] as never,
		store as never,
		undefined,
		false,
	);
	return { notifier, store, deliver, appendPayloads };
}

describe("OFF-path golden — RegistryHeartbeatNotifier payload + delivery lifecycle", () => {
	it("monitoring_lost payload JSON frozen (incl. the pre-FLY-1282 'alive and working' claim)", async () => {
		const { notifier, appendPayloads } = makeRegistryFixture();
		await notifier.onSessionMonitoringLost(sess(), 25);
		expect(appendPayloads).toHaveLength(1);
		const payload = JSON.parse(appendPayloads[0]);
		expect(payload.event_type).toBe("session_monitoring_lost");
		expect(payload.notification_context).toBe(
			"Runner FLY-1282 lost Bridge monitoring (no heartbeat for 25m, likely after a Flywheel restart) but its tmux session is still alive and working. Please keep an eye on it and drive it directly via tmux if needed.",
		);
		expect("liveness_probe" in payload).toBe(false);
		expect("unpushed_work" in payload).toBe(false);
		expect("concurrent_reestablished" in payload).toBe(false);
	});

	it("reestablished payload JSON frozen (incl. the false 'restart' narrative + no-action promise)", async () => {
		const { notifier, appendPayloads } = makeRegistryFixture();
		await notifier.onSessionMonitoringReestablished(sess(), 21, {
			stampReconnectTitle: false,
		});
		const payload = JSON.parse(appendPayloads[0]);
		expect(payload.event_type).toBe("session_monitoring_reestablished");
		expect(payload.notification_context).toBe(
			"Runner FLY-1282 was re-adopted after a Flywheel restart — monitoring re-established via tmux (heartbeat had been stale 21m). It is alive and being watched again; no action needed.",
		);
		expect("liveness_probe" in payload).toBe(false);
		expect("concurrent_reestablished" in payload).toBe(false);
	});

	it("unparseable zombie evidence prepares a payload with NO liveness_probe at all (code R1 #4 — never fabricate probe facts)", () => {
		// Local construction: prepare resolves the lead from the PROJECTS list
		// (not the registry mock), so it needs a routable project.
		const deliver = vi.fn(async () => ({ delivered: true }));
		const store: MockStore = {
			getSessionLabels: vi.fn().mockReturnValue([]),
			appendLeadEvent: vi.fn().mockReturnValue(41),
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
		};
		const registry = {
			resolveWithLead: vi.fn(),
			getForLead: vi.fn(() => ({ deliver })),
		};
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: "/tmp/fw",
				leads: [
					{
						agentId: "flywheel-eng-lead",
						chatChannel: "chan-1",
						match: { labels: [] },
					},
				],
			},
		];
		const notifier = new RegistryHeartbeatNotifier(
			registry as never,
			projects as never,
			store as never,
			undefined,
			false,
		);
		const prepared = notifier.prepareSessionZombieDetected(
			sess({ status: "failed" }),
			{
				kind: "unparseable",
				rawLastError: "zombie: junk from an older vintage",
			},
			{ ok: false, worktreePath: "/tmp/wt", error: "git unavailable" },
		);
		expect(prepared).not.toBeNull();
		const payload = JSON.parse(prepared?.payloadJson ?? "{}");
		expect(payload.event_type).toBe("session_zombie_detected");
		expect("liveness_probe" in payload).toBe(false);
	});

	it("deliver returning delivered:false on advisory → marked delivered anyway (best-effort golden)", async () => {
		const deliver = vi.fn(async () => ({ delivered: false, error: "boom" }));
		const { notifier, store } = makeRegistryFixture({ deliverImpl: deliver });
		await notifier.onSessionMonitoringReestablished(sess(), 5, {});
		expect(store.markLeadEventDelivered).toHaveBeenCalledWith(41);
		expect(store.recordDeliveryFailure).not.toHaveBeenCalled();
	});

	it("deliver returning delivered:false on guardrail → recordDeliveryFailure (retry row)", async () => {
		const deliver = vi.fn(async () => ({ delivered: false, error: "down" }));
		const { notifier, store } = makeRegistryFixture({ deliverImpl: deliver });
		await notifier.onSessionMonitoringLost(sess(), 30);
		expect(store.recordDeliveryFailure).toHaveBeenCalledWith(41, "down");
		expect(store.markLeadEventDelivered).not.toHaveBeenCalled();
	});

	it("deliver THROW propagates to caller; appended row left untouched (no record, no mark) — R3 #5 golden", async () => {
		const deliver = vi.fn(async () => {
			throw new Error("transport exploded");
		});
		const { notifier, store, appendPayloads } = makeRegistryFixture({
			deliverImpl: deliver,
		});
		// Guardrail event type (monitoring_lost is in GUARDRAIL_EVENT_TYPES).
		await expect(notifier.onSessionMonitoringLost(sess(), 30)).rejects.toThrow(
			"transport exploded",
		);
		expect(appendPayloads).toHaveLength(1); // row WAS appended before the throw
		expect(store.recordDeliveryFailure).not.toHaveBeenCalled();
		expect(store.markLeadEventDelivered).not.toHaveBeenCalled();
		// Advisory type throws identically (same no-catch semantics).
		const adv = makeRegistryFixture({ deliverImpl: deliver });
		await expect(
			adv.notifier.onSessionMonitoringReestablished(sess(), 5, {}),
		).rejects.toThrow("transport exploded");
		expect(adv.store.recordDeliveryFailure).not.toHaveBeenCalled();
		expect(adv.store.markLeadEventDelivered).not.toHaveBeenCalled();
	});
});
