import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge/tmux-lookup.js", () => ({
	lookupTmuxTarget: vi.fn(() => ({
		kind: "found",
		target: { tmuxWindow: "test:@1", sessionName: "test" },
	})),
	probeRunnerProcessLivenessDetailed: vi.fn(async () => ({
		liveness: "alive",
	})),
	probeTmuxServer: vi.fn(async () => "up"),
}));
vi.mock("../bridge/complete-marker-reconciler.js", () => ({
	tryReconcileComplete: vi.fn(async () => ({ kind: "absent" })),
	applyQuarantineFallback: vi.fn(),
}));

import { commDbPathForProject } from "../bridge/commdb-path.js";
import { buildSessionKey } from "../bridge/hook-payload.js";
import type { NotificationEvidenceV2 } from "../bridge/lead-notification-evidence.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import { probeRunnerProcessLivenessDetailed } from "../bridge/tmux-lookup.js";
import {
	HeartbeatService,
	RegistryHeartbeatNotifier,
} from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";
import { StateStore } from "../StateStore.js";

const lead = {
	agentId: "test-lead",
	chatChannel: "test-chat",
	forumChannel: "test-forum",
	match: { labels: [] },
};
const stores: StateStore[] = [];
const services: HeartbeatService[] = [];
const roots: string[] = [];

async function fixture(status: Session["status"] = "running", enabled = true) {
	const root = mkdtempSync(join(tmpdir(), "fly2912-monitor-gates-"));
	roots.push(root);
	vi.stubEnv("FLYWHEEL_COMM_ROOT", root);
	const commDbPath = commDbPathForProject("test");
	new CommDB(commDbPath, true, false).close();
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const session: Session = {
		execution_id: "exec-current",
		issue_id: "issue-current",
		issue_identifier: "FLY-2912",
		project_name: "test",
		status,
		heartbeat_at: "2026-09-26 00:00:00",
	};
	store.upsertSession(session);
	store.applyScopedFlagValueChange({
		name: "lead_token_savings",
		scope: "test",
		op: "set",
		rawTo: enabled ? "1" : "0",
		expectedChangeSeq: store.getFlagValueChangeSeq(
			"lead_token_savings",
			"test",
		),
		actor: "fixture",
		reason: "test",
	});
	const deliver = vi.fn(async () => ({ delivered: true }));
	const registry = new RuntimeRegistry();
	registry.register(lead, {
		type: "commdb",
		deliver,
		sendBootstrap: vi.fn(async () => {}),
		health: vi.fn(async () => ({
			status: "healthy",
			lastDeliveryAt: null,
			lastDeliveredSeq: 0,
		})),
		shutdown: vi.fn(async () => {}),
	});
	const notifier = new RegistryHeartbeatNotifier(
		registry,
		[
			{
				projectName: "test",
				projectRoot: "/tmp/quiet-recovery",
				leads: [lead],
			},
		],
		store,
	);
	const service = new HeartbeatService(
		store,
		notifier,
		15,
		60_000,
		60,
		undefined,
		24,
		6 * 3_600_000,
		{ bridgeBaseUrl: "http://127.0.0.1:9", ingestToken: "fixture" },
	);
	services.push(service);
	vi.spyOn(store, "getReadoptCandidateSessions").mockImplementation(() => [
		store.getSession(session.execution_id)!,
	]);
	return { store, session, notifier, service, deliver, commDbPath };
}

function proof(store: StateStore): NotificationEvidenceV2 | undefined {
	return store
		.getEventsByExecution("exec-current")
		.find((row) => row.event_type === "lead_notification_proof")?.payload as
		| NotificationEvidenceV2
		| undefined;
}

beforeEach(() =>
	vi
		.mocked(probeRunnerProcessLivenessDetailed)
		.mockReset()
		.mockResolvedValue({ liveness: "alive" }),
);
afterEach(() => {
	for (const service of services.splice(0)) service.stop();
	for (const store of stores.splice(0)) store.close();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("FLY-2912 actual monitoring recovery producer", () => {
	it.each(["running", "ship_parked"] as const)(
		"records %s recovery with the actual single probe and makes zero adapter calls",
		async (status) => {
			const { store, service, deliver } = await fixture(status);
			await service.seedReconnecting();
			expect(
				probeRunnerProcessLivenessDetailed,
			).toHaveBeenCalledExactlyOnceWith("test:@1");
			expect(service.isReconnecting("exec-current")).toBe(true);
			expect(deliver).not.toHaveBeenCalled();
			const row = store.getLeadEventBySeq(1)!;
			expect(row).toMatchObject({
				event_type: "session_monitoring_reestablished",
				delivery_disposition: "audit_only",
				notification_policy_version: "notification-v2",
			});
			const evidence = proof(store);
			expect(evidence).toMatchObject({
				version: 2,
				kind: "monitoring",
				binding: {
					executionId: "exec-current",
					leadId: "test-lead",
					projectName: "test",
				},
				proof: {
					sourceRef: `session-event:${row.event_id}:proof`,
					action: { state: "none" },
				},
				alertState: "none",
			});
			if (evidence?.kind !== "monitoring")
				throw new Error("missing monitoring proof");
			expect(evidence.episodeRef).toContain("exec-current");
			expect(evidence.probeRef).toContain("test:@1");
			expect(JSON.parse(row.payload).liveness_probe.result).toBe("alive");
		},
	);
	it("pairs covered monitoring_lost events without acknowledging or resolving them", async () => {
		const { store, session, service, deliver } = await fixture();
		const lost = store.appendLeadEvent(
			lead.agentId,
			"lost-event",
			"session_monitoring_lost",
			JSON.stringify({
				event_type: "session_monitoring_lost",
				execution_id: session.execution_id,
				issue_id: session.issue_id,
				project_name: "test",
				status: "running",
			}),
			buildSessionKey(session),
			"model",
		);
		await service.seedReconnecting();
		expect(deliver).not.toHaveBeenCalled();
		expect(proof(store)).toMatchObject({
			kind: "monitoring",
			recoveredLostEventIds: ["lost-event"],
		});
		expect(store.getLeadEventBySeq(lost)).toMatchObject({
			delivery_disposition: "model",
			delivered_at: undefined,
		});
	});
	it.each(["zombie", "open-alert", "session-error"])(
		"keeps correlated %s action model-visible",
		async (kind) => {
			const { store, session, service, deliver } = await fixture();
			if (kind === "zombie")
				store.appendLeadEvent(
					lead.agentId,
					"zombie-event",
					"session_zombie_detected",
					JSON.stringify({
						event_type: "session_zombie_detected",
						execution_id: session.execution_id,
						issue_id: session.issue_id,
						project_name: "test",
						status: "failed",
					}),
					buildSessionKey(session),
					"model",
				);
			if (kind === "open-alert")
				store.openAlertThread({
					correlationKey: "correlated-failure",
					eventId: "failure-event",
					threadId: "failure-thread",
					channelId: "test-chat",
					leadId: lead.agentId,
					projectName: "test",
					eventType: "runner_login_expired",
					sessionKey: buildSessionKey(session),
				});
			if (kind === "session-error")
				store.upsertSession({ ...session, last_error: "needs Lead repair" });
			await service.seedReconnecting();
			expect(deliver).toHaveBeenCalledTimes(1);
		},
	);
	it("OFF restores ordinary delivery on the same actual recovery path", async () => {
		const { store, service, deliver } = await fixture("ship_parked", false);
		await service.seedReconnecting();
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(store.getLeadEventBySeq(1)?.delivery_disposition).toBe("model");
	});
	it.each(["lead_token_savings", "lead_monitoring_reestablished_audit"])(
		"hot toggles %s on the same service without rewriting earlier audit",
		async (name) => {
			const { store, session, service, deliver } = await fixture();
			for (const [index, enabled] of [true, false, true].entries()) {
				store.applyScopedFlagValueChange({
					name,
					scope: "test",
					op: "set",
					rawTo: enabled ? "1" : "0",
					expectedChangeSeq: store.getFlagValueChangeSeq(name, "test"),
					actor: "fixture",
					reason: "hot rollback",
				});
				service.clearReconnecting(session.execution_id);
				await service.seedReconnecting();
				expect(store.getLeadEventBySeq(index + 1)?.delivery_disposition).toBe(
					enabled ? "audit_only" : "model",
				);
			}
			expect(deliver).toHaveBeenCalledTimes(1);
			expect(store.getLeadEventBySeq(1)?.delivery_disposition).toBe(
				"audit_only",
			);
		},
	);
	it.each(["same-exec", "different-exec", "founder", "answered"] as const)(
		"legal park checks authoritative %s gate state",
		async (kind) => {
			const { session, service, deliver, commDbPath } =
				await fixture("ship_parked");
			const comm = new CommDB(commDbPath, false, false);
			const questionId = comm.insertQuestion(
				kind === "different-exec" ? "other-exec" : session.execution_id,
				lead.agentId,
				"Gate requires action",
				{ checkpoint: kind === "founder" ? "approve_to_ship" : "question" },
			);
			if (kind === "answered")
				comm.insertResponse(questionId, lead.agentId, "resolved");
			comm.close();
			await service.seedReconnecting();
			expect(deliver).toHaveBeenCalledTimes(kind === "same-exec" ? 1 : 0);
		},
	);
	it("a missing park gate database restores model delivery without re-probing liveness", async () => {
		const { service, deliver, commDbPath } = await fixture("ship_parked");
		unlinkSync(commDbPath);
		await service.seedReconnecting();
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(probeRunnerProcessLivenessDetailed).toHaveBeenCalledTimes(1);
	});
	it.each(["indeterminate", "absent"] as const)(
		"%s parked probe never emits recovery",
		async (liveness) => {
			const { store, service } = await fixture("ship_parked");
			vi.mocked(probeRunnerProcessLivenessDetailed).mockResolvedValueOnce({
				liveness,
			});
			await service.seedReconnecting();
			expect(store.getLeadEventBySeq(1)?.event_type).toBe(
				"session_monitoring_lost",
			);
			expect(proof(store)).toBeUndefined();
			expect(service.isReconnecting("exec-current")).toBe(false);
		},
	);
	it("an unresolved zombie remains actionable across subsequent recovery episodes", async () => {
		const { store, session, service, deliver } = await fixture();
		store.appendLeadEvent(
			lead.agentId,
			"zombie-event",
			"session_zombie_detected",
			JSON.stringify({
				execution_id: session.execution_id,
				issue_id: session.issue_id,
				project_name: "test",
				status: "failed",
			}),
			buildSessionKey(session),
			"model",
		);
		await service.seedReconnecting();
		service.clearReconnecting(session.execution_id);
		await service.seedReconnecting();
		expect(deliver).toHaveBeenCalledTimes(2);
	});
	it("monitoring_lost carrying a question remains actionable on recovery", async () => {
		const { store, session, service, deliver } = await fixture();
		store.appendLeadEvent(
			lead.agentId,
			"lost-question",
			"session_monitoring_lost",
			JSON.stringify({
				execution_id: session.execution_id,
				issue_id: session.issue_id,
				project_name: "test",
				status: "running",
				question_id: "needs-answer",
			}),
			buildSessionKey(session),
			"model",
		);
		await service.seedReconnecting();
		expect(deliver).toHaveBeenCalledTimes(1);
	});
	it("correlation read failure restores model delivery", async () => {
		const { store, service, deliver } = await fixture();
		vi.spyOn(store, "getMonitoringRecoveryContext").mockImplementation(() => {
			throw new Error("correlation read failed");
		});
		await service.seedReconnecting();
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(proof(store)).toMatchObject({
			alertState: "unknown",
			proof: { action: { state: "unknown" } },
		});
	});
	it("missing current-episode proof cannot turn a direct notifier call quiet", async () => {
		const { session, notifier, deliver } = await fixture();
		await notifier.onSessionMonitoringReestablished(session, 15, {
			livenessProbe: { target: "test:@1", probedAt: new Date().toISOString() },
		});
		expect(deliver).toHaveBeenCalledTimes(1);
	});
	it("an episode cleared before notifier persistence loses its quiet authority", async () => {
		const { session, service, notifier, deliver } = await fixture();
		const original = notifier.onSessionMonitoringReestablished.bind(notifier);
		vi.spyOn(notifier, "onSessionMonitoringReestablished").mockImplementation(
			async (...args) => {
				service.clearReconnecting(session.execution_id);
				await original(...args);
			},
		);
		await service.seedReconnecting();
		expect(deliver).toHaveBeenCalledTimes(1);
	});
});
