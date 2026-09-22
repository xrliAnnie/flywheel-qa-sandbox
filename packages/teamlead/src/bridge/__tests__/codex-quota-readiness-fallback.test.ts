import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { CodexQuotaAvailability } from "../../codex-quota/availability.js";
import { CodexQuotaCoordinator } from "../../codex-quota/coordinator.js";
import { createCodexQuotaMaintenance } from "../../codex-quota/maintenance.js";
import { createCodexQuotaOutboxDelivery } from "../../codex-quota/outbox.js";
import {
	type AlertPayload,
	isInformationalKind,
} from "../../LeadAlertNotifier.js";
import { StateStore } from "../../StateStore.js";

type ReplayFixture = {
	timeline: { quotaEventAt: string; oldFleetStallMs: number };
	readiness: { ready: false; reason: "readiness_receipt_missing" };
	identity: {
		rootKey: string;
		accountKey: string;
		profile: string;
		generation: number;
		bindingId: string;
		executionId: string;
		runId: string;
	};
	event: { source: "runner_terminal"; sourceEventId: string };
};

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../../../../../scripts/fixtures/codex-quota/readiness-20260911.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as ReplayFixture;

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

it("replays the 9-11 shape as immediate manual fallback plus visible N11", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const identity = fixture.identity;
	store.codexQuota.initializeRoot({
		rootKey: identity.rootKey,
		accountKey: identity.accountKey,
		profile: identity.profile,
		generation: identity.generation,
	});
	store.codexQuota.registerBinding({
		bindingId: identity.bindingId,
		executionId: identity.executionId,
		runId: identity.runId,
		purpose: "runner",
		accountKey: identity.accountKey,
		profile: identity.profile,
		generation: identity.generation,
		credentialRootKey: identity.rootKey,
	});
	let readinessMissing = false;
	const availability = new CodexQuotaAvailability({
		enabled: () => true,
		runtimeAvailable: () => true,
		check: async () =>
			readinessMissing
				? {
						ready: false,
						failures: [{ reason: fixture.readiness.reason }],
					}
				: { ready: true, failures: [] },
	});
	store.codexQuotaAvailability = () => availability.snapshot();
	await availability.refresh();
	store.codexQuota.recordSignal({
		executionId: identity.executionId,
		bindingId: identity.bindingId,
		source: fixture.event.source,
		sourceEventId: fixture.event.sourceEventId,
		now: fixture.timeline.quotaEventAt,
		availability: availability.snapshot(),
	});
	expect(store.codexQuota.isPaused(identity.rootKey)).toBe(true);

	const observe = vi.fn();
	const rotate = vi.fn();
	const recover = vi.fn();
	const coordinator = new CodexQuotaCoordinator({
		store: store.codexQuota,
		now: () => Date.parse(fixture.timeline.quotaEventAt),
		readiness: async () => false,
		availability: () => availability.refresh(),
		observe,
		rotate,
		recover,
	});
	const messages: AlertPayload[] = [];
	const flushOutbox = createCodexQuotaOutboxDelivery({
		store,
		send: async (payload) => {
			if (payload.eventType === "codex_quota_automation_disabled") {
				expect(isInformationalKind(payload.eventType)).toBe(true);
				expect(payload.deliveryStyle).toBe("plain");
			}
			messages.push(payload);
			store.recordAlertDeliveryReceipt(
				payload.eventId,
				"queued_durable",
				fixture.timeline.quotaEventAt,
			);
		},
	});
	const projectAudit = vi.fn(async () => {});
	const maintenance = createCodexQuotaMaintenance({
		store,
		refreshAvailability: () => availability.refresh(),
		runtime: () => coordinator,
		flushOutbox,
		projectAudit,
	});

	readinessMissing = true;
	await maintenance.tick();

	expect(availability.snapshot()).toMatchObject({
		mode: "manual",
		reasons: ["readiness_receipt_missing"],
	});
	expect(
		store.codexQuota.isIncidentManual(
			`codex:${identity.rootKey}:${identity.generation}`,
		),
	).toBe(true);
	expect(store.codexQuota.isPaused(identity.rootKey)).toBe(false);
	expect(
		store.isCodexQuotaLaunchPaused("healthy-sibling", identity.rootKey),
	).toBe(false);
	const n11 = messages.filter(
		(message) => message.eventType === "codex_quota_automation_disabled",
	);
	expect(n11).toHaveLength(1);
	expect(n11[0]).toMatchObject({
		eventType: "codex_quota_automation_disabled",
		body: "⚙️ 自动切号关着：readiness-receipt 不存在。需要手工切号。",
	});
	expect(observe).not.toHaveBeenCalled();
	expect(rotate).not.toHaveBeenCalled();
	expect(recover).not.toHaveBeenCalled();
	expect(projectAudit).toHaveBeenCalledOnce();
	// The new path resolves in the same maintenance pass, not after the old 8m stall.
	expect(fixture.timeline.oldFleetStallMs).toBe(8 * 60_000);
});
