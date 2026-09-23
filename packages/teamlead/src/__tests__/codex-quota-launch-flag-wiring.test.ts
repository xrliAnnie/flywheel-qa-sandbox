import { expect, it } from "vitest";
import { initializeFlagStore } from "../bridge/flag-store-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { StateStore } from "../StateStore.js";

it("Bridge launch fences observe live quota flag writes without clearing persisted pauses", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const flagStore = initializeFlagStore(store, {});
		store.codexQuota.initializeRoot({
			rootKey: "root",
			profile: "business",
			accountKey: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "binding",
			executionId: "dead-exec",
			runId: "dead-run",
			purpose: "runner",
			profile: "business",
			accountKey: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		store.codexQuota.recordSignal({
			bindingId: "binding",
			executionId: "dead-exec",
		});
		const root = store.codexQuota.getRoot("root");
		const incident = store.codexQuota.getIncident("codex:root:1");
		const config: BridgeConfig = {
			host: "127.0.0.1",
			port: 0,
			ingestToken: "fixture-token",
			dbPath: ":memory:",
			notificationChannel: "fixture",
			defaultLeadAgentId: "fixture-lead",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
		};
		createBridgeApp(
			store,
			[],
			config,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ flagStore },
		);
		expect(store.isCodexQuotaLaunchPaused("fresh-exec", "root")).toBe(true);
		for (const rawTo of ["0", "1"] as const) {
			expect(
				store.applyFlagValueChange({
					name: "codex_quota_auto_switch",
					rawTo,
					expectedRevision: store.getFlagValueRow("codex_quota_auto_switch")!
						.revision,
					actor: "bridge-local-operator",
					reason: "test live launch policy",
				}),
			).toMatchObject({ ok: true });
			expect(store.isCodexQuotaLaunchPaused("fresh-exec", "root")).toBe(
				rawTo === "1",
			);
			// Manual mode releases root admission, but never authorizes automatic
			// retry of the already terminal quota casualty.
			expect(store.isCodexQuotaLaunchPaused("dead-exec")).toBe(true);
			expect(store.codexQuota.isExecutionPaused("dead-exec")).toBe(true);
			expect(store.codexQuota.getRoot("root")).toEqual(root);
			expect(store.codexQuota.getIncident("codex:root:1")).toEqual(incident);
		}
	} finally {
		store.close();
	}
});

it("releases a proven rolled-back install while retaining a genuinely uncertain install guard", async () => {
	const store = await StateStore.create(":memory:");
	try {
		let enabled = false;
		store.codexQuotaLaunchEnabled = () => enabled;
		store.codexQuotaAvailability = () => ({
			mode: enabled ? "automatic" : "manual",
			reasons: enabled ? [] : ["flag_disabled"],
			revision: 1,
			checkedAt: new Date().toISOString(),
		});
		store.codexQuota.initializeRoot({
			rootKey: "root",
			profile: "business",
			accountKey: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "binding",
			executionId: "dead-exec",
			runId: "dead-run",
			purpose: "runner",
			profile: "business",
			accountKey: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		store.codexQuota.recordSignal({
			bindingId: "binding",
			executionId: "dead-exec",
			source: "runner_terminal",
			sourceEventId: "rolled-back-install",
		});
		store.codexQuota.recordInstalling({
			incidentId: "codex:root:1",
			profile: "school",
			accountKey: "school",
			priorAuthDigest: "prior",
			installedAuthDigest: "a".repeat(64),
			recoveryMaterialPath: "/fixture/auth",
		});

		expect(store.isCodexQuotaLaunchPaused("fresh-exec", "root")).toBe(true);
		store.codexQuota.setIncidentState(
			"codex:root:1",
			"retry_wait",
			"installation_rolled_back",
		);
		expect(store.codexQuota.hasRootSafetyGuard("root")).toBe(false);
		// A later coordinator observation may replace failure_code, but it must
		// not erase the independently durable rollback verdict.
		store.codexQuota.setIncidentState(
			"codex:root:1",
			"pool_exhausted",
			"pool_exhausted",
		);
		expect(store.codexQuota.hasRootSafetyGuard("root")).toBe(false);
		store.codexQuota.handoffIncidentManual("codex:root:1", ["flag_disabled"]);
		expect(store.codexQuota.isIncidentManual("codex:root:1")).toBe(true);
		expect(store.isCodexQuotaLaunchPaused("fresh-exec", "root")).toBe(false);
		expect(store.isCodexQuotaLaunchPaused("dead-exec", "root")).toBe(true);
		expect(
			store.codexQuota
				.listOutbox()
				.filter((row) => row.kind === "automation_disabled"),
		).toHaveLength(1);

		enabled = true;
		expect(store.isCodexQuotaLaunchPaused("fresh-exec", "root")).toBe(false);
	} finally {
		store.close();
	}
});

it("applies a current capacity guard only while the fleet flag is on", async () => {
	const store = await StateStore.create(":memory:");
	try {
		let enabled = true;
		store.codexQuotaLaunchEnabled = () => enabled;
		const observedAt = Date.now();
		store.codexQuota.initializeRoot({
			rootKey: "root",
			profile: "business",
			accountKey: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "binding",
			executionId: "dead-exec",
			runId: "dead-run",
			purpose: "runner",
			profile: "business",
			accountKey: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		store.codexQuota.recordSignal({
			bindingId: "binding",
			executionId: "dead-exec",
		});
		store.codexQuota.recordPoolExhausted({
			incidentId: "codex:root:1",
			pool: ["business", "personal", "school"].map((profile) => ({
				profile,
				accountKey: profile,
			})),
			observedAt,
			nextAttemptAt: observedAt + 60_000,
			observations: ["school", "personal", "business"].map((profile) => ({
				profile,
				accountKey: profile,
				observedAt,
				identityVerified: true,
				authHealth: "valid" as const,
				scopeKnown: true,
				windows: [{ usedPercent: 100, resetsAt: observedAt + 3_600_000 }],
			})),
		});

		expect(store.isCodexQuotaLaunchPaused("fresh-exec", "root")).toBe(true);
		enabled = false;
		expect(store.isCodexQuotaLaunchPaused("fresh-exec", "root")).toBe(false);
		// The quota casualty itself remains held in both modes.
		expect(store.isCodexQuotaLaunchPaused("dead-exec", "root")).toBe(true);
	} finally {
		store.close();
	}
});
