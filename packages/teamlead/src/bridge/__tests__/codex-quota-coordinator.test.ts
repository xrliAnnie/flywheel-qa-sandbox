import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODEX_QUOTA_MAX_PAUSE_MS,
	CodexQuotaCoordinator,
} from "../../codex-quota/coordinator.js";
import { StateStore } from "../../StateStore.js";

const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

describe("Codex quota coordinator", () => {
	it("reopens a settled incident for its standalone admission waiter and ages the wait once", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const started = Date.now();
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
		store.codexQuota.recordSignal({
			executionId: "exec",
			bindingId: "binding",
			now: new Date(started).toISOString(),
		});
		store.codexQuota.recordInstalling({
			incidentId: "codex:root:1",
			profile: "school",
			accountKey: "school-key",
			priorAuthDigest: "old",
			installedAuthDigest: "a".repeat(64),
			recoveryMaterialPath: "/fixture/auth",
		});
		store.codexQuota.commitGeneration({
			incidentId: "codex:root:1",
			expectedGeneration: 1,
			profile: "school",
			accountKey: "school-key",
			authDigest: "a".repeat(64),
			probeResult: "ok",
		});
		store.codexQuota.updateTarget("codex:root:1", "runner", "run", {
			state: "recovered",
		});
		store.codexQuota.setIncidentState("codex:root:1", "settled");
		const quota = store.codexQuota;
		const waits = vi.spyOn(quota, "listAdmissionWaits").mockReturnValue([
			{
				start_key: "queued",
				root_key: "root",
				generation: 1,
				state: "waiting",
				created_at: new Date(started).toISOString(),
			},
		]);
		vi.spyOn(quota, "isPaused").mockReturnValue(false);
		const recover = vi.fn();
		const options = {
			store: quota,
			now: () => started + CODEX_QUOTA_MAX_PAUSE_MS + 1,
			readiness: async () => true,
			observe: vi.fn(),
			rotate: vi.fn(),
			recover,
		};
		await new CodexQuotaCoordinator(options).tick();
		expect(recover).toHaveBeenCalledOnce();
		expect(store.codexQuota.getIncident("codex:root:1")?.state).toBe(
			"recovering",
		);
		await new CodexQuotaCoordinator(options).tick();
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "founder_alert"),
		).toHaveLength(1);
		store.codexQuota.setIncidentState("codex:root:1", "settled");
		waits.mockReturnValue([
			{ root_key: "different-root", generation: 1, state: "waiting" },
			{ root_key: "root", generation: 2, state: "waiting" },
		]);
		await new CodexQuotaCoordinator(options).tick();
		expect(recover).toHaveBeenCalledTimes(2);
	});

	it("persists a bounded retry when external observation fails without exposing exception text", async () => {
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
		store.codexQuota.recordSignal({
			executionId: "exec",
			bindingId: "binding",
		});
		await expect(
			new CodexQuotaCoordinator({
				store: store.codexQuota,
				readiness: async () => true,
				observe: async () => {
					throw new Error("private-token");
				},
				rotate: vi.fn(),
				recover: vi.fn(),
			}).tick(),
		).resolves.toBeUndefined();
		expect(store.codexQuota.getIncident("codex:root:1")).toMatchObject({
			state: "retry_wait",
			failure_code: "coordinator_operation_failed",
		});
		expect(JSON.stringify(store.codexQuota.listOutbox())).not.toContain(
			"private-token",
		);
	});

	it("reconciles a persisted install before any new credential refresh after reconstruction", async () => {
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
		store.codexQuota.recordSignal({
			executionId: "exec",
			bindingId: "binding",
		});
		store.codexQuota.recordInstalling({
			incidentId: "codex:root:1",
			profile: "school",
			accountKey: "school-key",
			priorAuthDigest: "prior",
			installedAuthDigest: "a".repeat(64),
			recoveryMaterialPath: "/fixture/auth",
		});
		const observe = vi.fn();
		const rotate = vi.fn();
		const recover = vi.fn();
		const reconcileInstallation = vi.fn(async () => "installed" as const);
		const options = {
			store: store.codexQuota,
			readiness: async () => true,
			observe,
			rotate,
			recover,
			reconcileInstallation,
		};
		await new CodexQuotaCoordinator(options).tick();
		expect(reconcileInstallation).toHaveBeenCalledOnce();
		expect(observe).not.toHaveBeenCalled();
		expect(rotate).not.toHaveBeenCalled();
		expect(store.codexQuota.getRoot("root")?.generation).toBe(2);
		expect(recover).toHaveBeenCalledOnce();
		await new CodexQuotaCoordinator(options).tick();
		expect(store.codexQuota.getRoot("root")?.generation).toBe(2);
		store.codexQuota.updateTarget("codex:root:1", "runner", "run", {
			state: "recovered",
		});
		store.codexQuota.setIncidentState("codex:root:1", "settled");
		store.codexQuota.registerBinding({
			bindingId: "late",
			executionId: "late-exec",
			runId: "late-run",
			purpose: "runner",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		store.codexQuota.recordSignal({
			bindingId: "late",
			executionId: "late-exec",
		});
		await new CodexQuotaCoordinator(options).tick();
		expect(recover).toHaveBeenCalledTimes(3);
		expect(store.codexQuota.getIncident("codex:root:1")?.state).toBe(
			"recovering",
		);
		expect(rotate).not.toHaveBeenCalled();
	});
	it("keeps an uncertain install journal intact and does no work while auto switch is disabled", async () => {
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
		store.codexQuota.recordSignal({
			executionId: "exec",
			bindingId: "binding",
		});
		store.codexQuota.recordInstalling({
			incidentId: "codex:root:1",
			profile: "school",
			accountKey: "school-key",
			priorAuthDigest: "prior",
			installedAuthDigest: "a".repeat(64),
			recoveryMaterialPath: "/fixture/auth",
		});
		const observe = vi.fn();
		const rotate = vi.fn();
		const recover = vi.fn();
		const reconcileInstallation = vi.fn(async () => "uncertain" as const);
		let enabled = false;
		const options = {
			store: store.codexQuota,
			autoEnabled: () => enabled,
			readiness: async () => true,
			observe,
			rotate,
			recover,
			reconcileInstallation,
		};
		await new CodexQuotaCoordinator(options).tick();
		expect(reconcileInstallation).not.toHaveBeenCalled();
		enabled = true;
		await new CodexQuotaCoordinator(options).tick();
		expect(reconcileInstallation).toHaveBeenCalledOnce();
		expect(observe).not.toHaveBeenCalled();
		expect(store.codexQuota.getIncident("codex:root:1")?.state).toBe(
			"installing",
		);
	});

	it("emits one pool alert immediately and shares that latch with later pause aging", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		let now = Date.parse("2026-09-09T00:00:00Z");
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
		store.codexQuota.recordSignal({
			executionId: "exec",
			bindingId: "binding",
			now: new Date(now).toISOString(),
		});
		let businessAvailable = false;
		const observe = vi.fn(async () =>
			["school", "personal", "business"].map((profile) => ({
				profile,
				accountKey: `${profile}-key`,
				observedAt: now,
				identityVerified: true,
				authHealth: "valid" as const,
				scopeKnown: true,
				windows: [
					{
						usedPercent: profile === "business" && businessAvailable ? 0 : 100,
						resetsAt: now + 3600_000,
					},
				],
			})),
		);
		const rotate = vi.fn();
		const recover = vi.fn();
		const options = {
			store: store.codexQuota,
			now: () => now,
			readiness: async () => true,
			observe,
			rotate,
			recover,
		};
		await new CodexQuotaCoordinator(options).tick();
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "founder_alert"),
		).toHaveLength(1);
		now += CODEX_QUOTA_MAX_PAUSE_MS + 1;
		await new CodexQuotaCoordinator(options).tick();
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "founder_alert"),
		).toHaveLength(1);
		expect(rotate).not.toHaveBeenCalled();
		expect(recover).not.toHaveBeenCalled();
		businessAvailable = true;
		now += 3600_001;
		await new CodexQuotaCoordinator(options).tick();
		expect(rotate).toHaveBeenCalledOnce();
		expect(rotate.mock.calls[0]?.[1].profile).toBe("business");
	});

	it("keeps failed probes paused with no recovery and no immediate repeated exec", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		let now = Date.parse("2026-09-09T00:00:00Z");
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
		store.codexQuota.recordSignal({
			executionId: "exec",
			bindingId: "binding",
			now: new Date(now).toISOString(),
		});
		const observe = vi.fn(async () => {
			now += 50;
			return [
				{
					profile: "school",
					accountKey: "school-key",
					observedAt: now,
					identityVerified: true,
					authHealth: "valid" as const,
					scopeKnown: true,
					windows: [
						{ usedPercent: 30, resetsAt: Date.parse("2026-09-09T01:00:00Z") },
					],
				},
			];
		});
		const rotate = vi.fn(async () => ({ ok: false }));
		const recover = vi.fn();
		const options = {
			store: store.codexQuota,
			now: () => now,
			readiness: async () => true,
			observe,
			rotate,
			recover,
		};
		await new CodexQuotaCoordinator(options).tick();
		await new CodexQuotaCoordinator(options).tick();
		now += 60_001;
		await new CodexQuotaCoordinator(options).tick();
		expect(rotate).toHaveBeenCalledTimes(1);
		expect(recover).not.toHaveBeenCalled();
		expect(store.codexQuota.getRoot("root")?.generation).toBe(1);
		expect(store.codexQuota.getIncident("codex:root:1")?.state).toBe(
			"probe_failed",
		);
	});

	it("selects the earliest available reset once, commits only after install and then recovers all incident targets", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		let now = Date.parse("2026-09-09T00:00:00Z");
		store.codexQuota.initializeRoot({
			rootKey: "root",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
		});
		for (let i = 0; i < 6; i++) {
			store.codexQuota.registerBinding({
				bindingId: `binding-${i}`,
				executionId: `exec-${i}`,
				runId: `run-${i}`,
				purpose: "runner",
				accountKey: "business-key",
				profile: "business",
				generation: 1,
				credentialRootKey: "root",
			});
			store.codexQuota.recordSignal({
				executionId: `exec-${i}`,
				bindingId: `binding-${i}`,
				now: new Date(now).toISOString(),
			});
		}
		const observe = vi.fn(async () =>
			["school", "personal"].map((profile, i) => ({
				profile,
				accountKey: `${profile}-key`,
				observedAt: now,
				identityVerified: true,
				authHealth: "valid" as const,
				scopeKnown: true,
				windows: [{ usedPercent: 30, resetsAt: now + (i + 1) * 60_000 }],
			})),
		);
		const rotate = vi.fn(async () => {
			store.codexQuota.recordInstalling({
				incidentId: "codex:root:1",
				profile: "school",
				accountKey: "school-key",
				priorAuthDigest: "prior",
				installedAuthDigest: "a".repeat(64),
				recoveryMaterialPath: "/fixture/retained-auth",
			});
			return { ok: true, authDigest: "a".repeat(64) };
		});
		const recover = vi.fn(async () => {
			expect(store.codexQuota.getRoot("root")?.profile).toBe("school");
			expect(store.codexQuota.listTargets("codex:root:1")).toHaveLength(6);
		});
		await new CodexQuotaCoordinator({
			store: store.codexQuota,
			now: () => now,
			readiness: async () => true,
			observe,
			rotate,
			recover,
		}).tick();
		expect(rotate).toHaveBeenCalledTimes(1);
		expect(rotate.mock.calls[0]?.[1].profile).toBe("school");
		expect(recover).toHaveBeenCalledTimes(1);
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "founder_alert"),
		).toHaveLength(0);
		now += CODEX_QUOTA_MAX_PAUSE_MS + 1;
		await new CodexQuotaCoordinator({
			store: store.codexQuota,
			now: () => now,
			readiness: async () => true,
			observe,
			rotate,
			recover,
		}).tick();
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "founder_alert"),
		).toHaveLength(1);
	});

	it("ages a readiness pause into one durable founder alert shared with pool exhaustion", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const start = Date.parse("2026-09-09T00:00:00Z");
		let now = start;
		store.codexQuota.initializeRoot({
			rootKey: "root",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "binding-1",
			executionId: "exec-1",
			runId: "run-1",
			purpose: "runner",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		store.codexQuota.recordSignal({
			executionId: "exec-1",
			bindingId: "binding-1",
			now: new Date(now).toISOString(),
		});
		const observe = vi.fn();
		const rotate = vi.fn();
		const recover = vi.fn();
		const options = {
			store: store.codexQuota,
			now: () => now,
			readiness: async () => false,
			observe,
			rotate,
			recover,
		};
		await new CodexQuotaCoordinator(options).tick();
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "founder_alert"),
		).toHaveLength(0);
		now += CODEX_QUOTA_MAX_PAUSE_MS + 1;
		await new CodexQuotaCoordinator(options).tick();
		await new CodexQuotaCoordinator(options).tick();
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "founder_alert"),
		).toHaveLength(1);
		expect(rotate).not.toHaveBeenCalled();
		expect(recover).not.toHaveBeenCalled();
		expect(observe).not.toHaveBeenCalled();
	});
	it("retains an installing journal when rotate returns false after rename and reconciles without another probe", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		let now = Date.parse("2026-09-09T00:00:00Z");
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
		store.codexQuota.recordSignal({
			executionId: "exec",
			bindingId: "binding",
			now: new Date(now).toISOString(),
		});
		const observe = vi.fn(async () => [
			{
				profile: "school",
				accountKey: "school-key",
				observedAt: now,
				identityVerified: true,
				authHealth: "valid" as const,
				scopeKnown: true,
				windows: [{ usedPercent: 30, resetsAt: now + 3600000 }],
			},
		]);
		const rotate = vi.fn(async () => {
			store.codexQuota.recordInstalling({
				incidentId: "codex:root:1",
				profile: "school",
				accountKey: "school-key",
				priorAuthDigest: "old",
				installedAuthDigest: "a".repeat(64),
				recoveryMaterialPath: "/fixture/refreshed",
				now: new Date(now).toISOString(),
			});
			return { ok: false };
		});
		const recover = vi.fn();
		const reconcileInstallation = vi.fn(async () => "installed" as const);
		const options = {
			store: store.codexQuota,
			now: () => now,
			readiness: async () => true,
			observe,
			rotate,
			recover,
			reconcileInstallation,
		};
		await new CodexQuotaCoordinator(options).tick();
		expect(store.codexQuota.getIncident("codex:root:1")?.state).toBe(
			"installing",
		);
		expect(recover).not.toHaveBeenCalled();
		now += 60001;
		await new CodexQuotaCoordinator(options).tick();
		expect(reconcileInstallation).toHaveBeenCalledOnce();
		expect(observe).toHaveBeenCalledOnce();
		expect(rotate).toHaveBeenCalledOnce();
		expect(store.codexQuota.getRoot("root")?.generation).toBe(2);
		expect(recover).toHaveBeenCalledOnce();
	});
});
