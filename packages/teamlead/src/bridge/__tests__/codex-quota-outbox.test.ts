import { afterEach, expect, it, vi } from "vitest";
import { CodexQuotaCoordinator } from "../../codex-quota/coordinator.js";
import { createCodexQuotaOutboxDelivery } from "../../codex-quota/outbox.js";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import { StateStore } from "../../StateStore.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
it("delivers one plain informational N11 for every durable quota event", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	for (const sourceEventId of ["event-1", "event-2"])
		store.codexQuota.recordSignal({
			executionId: "unbound-exec",
			source: "runner_terminal",
			sourceEventId,
			availability: {
				mode: "manual",
				reasons: ["readiness_receipt_missing"],
				revision: 1,
				checkedAt: "2026-09-11T18:45:00.000Z",
			},
		});
	const messages: AlertPayload[] = [];
	await createCodexQuotaOutboxDelivery({
		store,
		send: async (payload) => {
			messages.push(payload);
			store.recordAlertDeliveryReceipt(
				payload.eventId,
				"queued_durable",
				"2026-09-11T18:45:01.000Z",
			);
		},
	})();
	expect(messages).toHaveLength(2);
	for (const message of messages) {
		expect(message).toMatchObject({
			eventType: "codex_quota_automation_disabled",
			title: "Codex 自动切号关着",
			body: "⚙️ 自动切号关着：readiness-receipt 不存在。需要手工切号。",
			severity: "info",
			deliveryStyle: "plain",
		});
		expect(message).not.toHaveProperty("mentionUserId");
	}
	expect(
		store.codexQuota
			.listOutbox()
			.filter((row) => row.kind === "automation_disabled"),
	).toMatchObject([
		{ delivery_state: "delivered" },
		{ delivery_state: "delivered" },
	]);
});
it("renders one bounded legacy-batch N11 and explains why first flag enable stays manual", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuota.enqueueOutbox({
		incidentId: null,
		kind: "automation_disabled",
		eventId: "legacy-batch:N11:summary",
		destination: "lead",
		payload: {
			scope: "legacy_batch",
			totalCount: 1001,
			manualCount: 998,
			guardedCount: 2,
			skippedCount: 1,
			failedCount: 1,
		},
	});
	const messages: AlertPayload[] = [];
	await createCodexQuotaOutboxDelivery({
		store,
		send: async (payload) => {
			messages.push(payload);
			store.recordAlertDeliveryReceipt(
				payload.eventId,
				"queued_durable",
				"2026-09-17T20:00:00.000Z",
			);
		},
	})();
	expect(messages).toHaveLength(1);
	expect(messages[0]?.body).toContain("1001 条历史记录");
	expect(messages[0]?.body).toContain("998 条已交手工");
	expect(messages[0]?.body).toContain("2 条仍有当前容量或安装保护");
	expect(messages[0]?.body).toContain("当前 generation 不会因首次开旗自动接管");
	expect(messages[0]).toMatchObject({
		eventType: "codex_quota_automation_disabled",
		severity: "info",
		deliveryStyle: "plain",
	});
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
it("degrades stale installation evidence to explicit n/a cells", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.codexQuota.initializeRoot({
		rootKey: "root",
		accountKey: "business-key",
		profile: "business",
		generation: 1,
	});
	store.codexQuota.registerBinding({
		bindingId: "binding",
		executionId: "exec",
		runId: "run",
		purpose: "runner",
		accountKey: "business-key",
		profile: "business",
		generation: 1,
		credentialRootKey: "root",
	});
	store.codexQuota.recordSignal({ executionId: "exec", bindingId: "binding" });
	store.codexQuota.recordInstalling({
		incidentId: "codex:root:1",
		profile: "personal",
		accountKey: "personal-key",
		priorAuthDigest: "prior",
		installedAuthDigest: "digest",
		recoveryMaterialPath: "/fixture/auth",
		notification: {
			version: 1,
			from: {
				profile: "business",
				accountKey: "business-key",
				email: "business@example.test",
				windows: [{ usedPercent: 100, resetsAt: null }],
			},
			to: {
				profile: "school",
				accountKey: "stale-school-key",
				email: "stale@example.test",
				windows: [{ usedPercent: 4, resetsAt: null }],
			},
		},
	});
	store.codexQuota.commitGeneration({
		incidentId: "codex:root:1",
		expectedGeneration: 1,
		profile: "personal",
		accountKey: "personal-key",
		authDigest: "digest",
		probeResult: "ok",
	});
	const messages: AlertPayload[] = [];
	await createCodexQuotaOutboxDelivery({
		store,
		founderUserId: "123456789012345678",
		send: async (payload) => {
			messages.push(payload);
			store.recordAlertDeliveryReceipt(
				payload.eventId,
				"queued_durable",
				"2026-09-18T00:00:00.000Z",
			);
		},
	})();
	const notification = messages.find(
		(message) => message.eventType === "quota_switch_confirmation",
	);
	expect(notification?.body).toContain(
		"Codex 已切号：**business → personal**（quota:weekly）",
	);
	expect(notification?.body.match(/邮箱暂时未读到/g)).toHaveLength(2);
	expect(
		notification?.body.match(/weekly {2}n\/a {4}n\/a {4}n\/a/g),
	).toHaveLength(2);
	expect(notification?.body).not.toContain("stale@example.test");
	expect(notification?.body).not.toContain("4%");
});

for (const exhausted of [false, true]) {
	it(`delivers a founder notification with quota and run details when ${exhausted ? "the pool is exhausted" : "switching succeeds"}`, async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const now = Date.parse("2026-09-18T00:00:00.000Z");
		const resetsAt = Date.parse("2026-09-21T22:31:00.000Z");
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
			observe: async () => [
				{
					profile: "business",
					accountKey: "business-key",
					observedAt: now,
					identityVerified: true,
					authHealth: "valid" as const,
					scopeKnown: true,
					windows: [{ usedPercent: 100, resetsAt }],
				},
				{
					profile: "school",
					accountKey: "school-key",
					observedAt: now,
					identityVerified: true,
					authHealth: "valid" as const,
					scopeKnown: true,
					windows: [
						{
							usedPercent: exhausted ? 100 : 70,
							resetsAt: Date.parse("2026-09-20T20:00:00.000Z"),
						},
					],
				},
				{
					profile: "personal",
					accountKey: "personal-key",
					observedAt: now,
					identityVerified: true,
					authHealth: "valid" as const,
					scopeKnown: true,
					windows: [
						{
							usedPercent: exhausted ? 100 : 38,
							resetsAt: Date.parse("2026-09-19T17:17:00.000Z"),
						},
					],
				},
			],
			rotate: async (_incident, candidate) => {
				quota.recordInstalling({
					incidentId: "codex:root:1",
					profile: candidate.profile,
					accountKey: candidate.accountKey,
					priorAuthDigest: "old",
					installedAuthDigest: "a".repeat(64),
					recoveryMaterialPath: "/fixture/auth",
					notification: {
						version: 1,
						from: {
							profile: "business",
							accountKey: "business-key",
							email: "business@example.test",
							windows: [{ usedPercent: 100, resetsAt }],
						},
						to: {
							profile: "personal",
							accountKey: "personal-key",
							email: "personal@example.test",
							windows: [
								{
									usedPercent: 38,
									resetsAt: Date.parse("2026-09-19T17:17:00.000Z"),
								},
							],
						},
					},
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
		if (exhausted) {
			expect(notifications[0]!.body).toContain("usageLimited");
			expect(notifications[0]!.body).toContain("from=business");
			expect(notifications[0]!.body).toContain(
				`reset=${new Date(resetsAt).toISOString()}`,
			);
			expect(notifications[0]!.body).toContain("to=none");
			expect(notifications[0]!.body).toContain("affected_runs=1");
			expect(notifications[0]!.body).toContain("restarted_runs=0");
			return;
		}
		expect(notifications[0]).toMatchObject({
			title: "Codex quota recovery update",
			severity: "info",
			deliveryStyle: "plain",
			metadata: {
				codexQuota: {
					vendor: "codex",
					incidentId: "codex:root:1",
					generation: 1,
				},
			},
		});
		expect(notifications[0]).not.toHaveProperty("mentionUserId");
		expect(notifications[0]!.body).toBe(
			[
				"Codex 已切号：**business → personal**（quota:weekly）",
				"",
				"原账号 **business**",
				"business@example.test",
				"```text",
				"window  used   left   reset (PT)",
				"weekly  100%   0%     09-21 Mon 15:31",
				"```",
				"",
				"新账号 **personal**",
				"personal@example.test",
				"```text",
				"window  used   left   reset (PT)",
				"weekly  38%    62%    09-19 Sat 10:17",
				"```",
			].join("\n"),
		);
	});
}
