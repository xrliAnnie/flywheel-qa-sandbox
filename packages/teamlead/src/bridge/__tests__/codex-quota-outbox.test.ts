import { afterEach, expect, it, vi } from "vitest";
import { CodexQuotaCoordinator } from "../../codex-quota/coordinator.js";
import { createCodexQuotaOutboxDelivery } from "../../codex-quota/outbox.js";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import { StateStore } from "../../StateStore.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
it("only settles from a durable receipt and fences ambiguous restart retries", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuota.enqueueOutbox({
		incidentId: "incident",
		kind: "founder_alert",
		destination: "founder",
		payload: { reason: "pool_exhausted" },
	});
	let now = 1000;
	const send = vi.fn(async () => ({ sent: true }));
	const options = {
		store,
		send,
		now: () => now,
		founderUserId: "123456789012345678",
	};
	await createCodexQuotaOutboxDelivery(options)();
	expect(store.codexQuota.listOutbox()[0]?.delivery_state).toBe("pending");
	await createCodexQuotaOutboxDelivery(options)();
	expect(send).toHaveBeenCalledTimes(1);
	now += 30 * 60_000 + 1;
	await createCodexQuotaOutboxDelivery(options)();
	expect(send).toHaveBeenCalledTimes(2);
	expect(send.mock.calls[1]?.[1]).toEqual({
		replayAfterAmbiguousAttempt: true,
	});
	store.recordAlertDeliveryReceipt(
		"incident:founder_alert",
		"queued_durable",
		new Date(now).toISOString(),
	);
	await createCodexQuotaOutboxDelivery(options)();
	expect(store.codexQuota.listOutbox()[0]?.delivery_state).toBe("delivered");
	expect(send).toHaveBeenCalledTimes(2);
});
it("keeps founder delivery pending without a target and carries typed Codex metadata", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuota.enqueueOutbox({
		incidentId: "incident",
		kind: "founder_alert",
		destination: "founder",
		payload: { reason: "quota_pause_expired" },
	});
	const send = vi.fn();
	await createCodexQuotaOutboxDelivery({ store, send })();
	expect(send).not.toHaveBeenCalled();
	await createCodexQuotaOutboxDelivery({
		store,
		send,
		founderUserId: "123456789012345678",
	})();
	expect(send.mock.calls[0]?.[0]).toMatchObject({
		eventId: "incident:founder_alert",
		eventType: "quota_no_target",
		mentionUserId: "123456789012345678",
		metadata: { codexQuota: { vendor: "codex", incidentId: "incident" } },
	});
});
it("delivers recovery summaries to each owning Lead with a durable queue receipt and stable replay id", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.upsertSession({
		execution_id: "exec",
		issue_id: "FLY-TEST",
		project_name: "fixture",
		status: "failed",
	});
	store.codexQuota.initializeRoot({
		rootKey: "root",
		accountKey: "business-key",
		profile: "business",
		generation: 1,
	});
	store.codexQuota.registerBinding({
		bindingId: "b",
		executionId: "exec",
		runId: "old-run",
		purpose: "runner",
		accountKey: "business-key",
		profile: "business",
		generation: 1,
		credentialRootKey: "root",
	});
	store.codexQuota.recordSignal({ executionId: "exec", bindingId: "b" });
	store.codexQuota.updateTarget("codex:root:1", "runner", "old-run", {
		state: "recovered",
		new_run_id: "new-run",
		new_execution_id: "new-exec",
	});
	store.codexQuota.enqueueOutbox({
		incidentId: "codex:root:1",
		kind: "lead_summary",
		destination: "lead",
		payload: {},
	});
	const queued = vi.fn((envelope) => ({
		queued: true as const,
		deliveryId: envelope.eventId,
		seq: envelope.seq,
	}));
	const options = {
		store,
		send: vi.fn(),
		resolveLead: () => "fixture-lead",
		enqueueLead: queued,
	};
	await createCodexQuotaOutboxDelivery(options)();
	expect(queued).toHaveBeenCalledOnce();
	expect(queued.mock.calls[0]?.[0].leadId).toBe("fixture-lead");
	expect(queued.mock.calls[0]?.[1]).toContain("old-run");
	expect(queued.mock.calls[0]?.[1]).toContain("new-run");
	expect(
		store.codexQuota.listOutbox().find((row) => row.kind === "lead_summary")
			?.delivery_state,
	).toBe("delivered");
	await createCodexQuotaOutboxDelivery(options)();
	expect(queued).toHaveBeenCalledOnce();
});

for (const exhausted of [false, true]) {
	it(`delivers a founder notification with quota and run details when ${exhausted ? "the pool is exhausted" : "switching succeeds"}`, async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const now = Date.now();
		const resetsAt = now + 86400_000;
		const quota = store.codexQuota;
		quota.initializeRoot({
			rootKey: "root",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
		});
		quota.registerBinding({
			bindingId: "b",
			executionId: "exec",
			runId: "run",
			purpose: "runner",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		quota.recordSignal({ executionId: "exec", bindingId: "b" });
		const coordinator = new CodexQuotaCoordinator({
			store: quota,
			now: () => now,
			readiness: async () => true,
			observe: async () =>
				["business", "school", "personal"].map((profile, index) => ({
					profile,
					accountKey: `${profile}-key`,
					observedAt: now,
					identityVerified: true,
					authHealth: "valid" as const,
					scopeKnown: true,
					windows: [
						{
							usedPercent: exhausted || profile === "business" ? 100 : 10,
							resetsAt: resetsAt + index * 1000,
						},
					],
				})),
			rotate: async () => {
				quota.recordInstalling({
					incidentId: "codex:root:1",
					profile: "school",
					accountKey: "school-key",
					priorAuthDigest: "old",
					installedAuthDigest: "a".repeat(64),
					recoveryMaterialPath: "/fixture/auth",
				});
				return { ok: true, authDigest: "a".repeat(64) };
			},
			recover: async () => {
				quota.updateTarget("codex:root:1", "runner", "run", {
					state: "recovered",
					new_run_id: "new-run",
				});
			},
		});
		await coordinator.tick();
		const messages: AlertPayload[] = [];
		const deliver = createCodexQuotaOutboxDelivery({
			store,
			founderUserId: "123456789012345678",
			send: async (payload) => {
				messages.push(payload);
				store.recordAlertDeliveryReceipt(
					payload.eventId!,
					"queued_durable",
					new Date(now).toISOString(),
				);
			},
		});
		await deliver();
		await coordinator.tick();
		await deliver();
		const notifications = messages.filter(
			(message) =>
				message.eventType ===
				(exhausted ? "quota_no_target" : "quota_switch_confirmation"),
		);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toMatchObject({
			eventType: exhausted ? "quota_no_target" : "quota_switch_confirmation",
		});
		expect(notifications[0]!.body).toContain("usageLimited");
		expect(notifications[0]!.body).toContain("from=business");
		expect(notifications[0]!.body).toContain(
			`reset=${new Date(resetsAt).toISOString()}`,
		);
		expect(notifications[0]!.body).toContain(
			`to=${exhausted ? "none" : "school"}`,
		);
		expect(notifications[0]!.body).toContain("affected_runs=1");
		expect(notifications[0]!.body).toContain(
			`restarted_runs=${exhausted ? 0 : 1}`,
		);
	});
}
