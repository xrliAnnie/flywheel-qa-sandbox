/** FLY-1282 notifier payload and delivery-lifecycle goldens. */
import { describe, expect, it, vi } from "vitest";
import { RegistryHeartbeatNotifier } from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

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
