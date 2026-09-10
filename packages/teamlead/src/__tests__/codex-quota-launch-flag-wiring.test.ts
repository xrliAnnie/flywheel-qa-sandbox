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
			expect(store.isCodexQuotaLaunchPaused("dead-exec")).toBe(rawTo === "1");
			expect(store.codexQuota.isExecutionPaused("dead-exec")).toBe(true);
			expect(store.codexQuota.getRoot("root")).toEqual(root);
			expect(store.codexQuota.getIncident("codex:root:1")).toEqual(incident);
		}
	} finally {
		store.close();
	}
});
