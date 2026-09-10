import { expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";

const binding = {
	bindingId: "b",
	executionId: "old",
	runId: "run",
	purpose: "runner" as const,
	accountKey: "business-key",
	profile: "business",
	generation: 1,
	credentialRootKey: "root",
};
it("keeps quota casualties fenced after commit until their controlled recovery settles", async () => {
	const store = await StateStore.create(":memory:");
	try {
		store.codexQuota.initializeRoot({
			rootKey: "root",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding(binding);
		store.codexQuota.recordSignal({ executionId: "old", bindingId: "b" });
		store.codexQuota.recordInstalling({
			incidentId: "codex:root:1",
			profile: "school",
			accountKey: "school-key",
			priorAuthDigest: "old",
			installedAuthDigest: "new",
			recoveryMaterialPath: "/fixture/auth",
		});
		store.codexQuota.commitGeneration({
			incidentId: "codex:root:1",
			expectedGeneration: 1,
			profile: "school",
			accountKey: "school-key",
			authDigest: "new",
			probeResult: "ok",
		});
		expect(store.codexQuota.isPaused("root")).toBe(false);
		expect(store.codexQuota.isExecutionPaused("old")).toBe(true);
		store.codexQuota.registerBinding({
			...binding,
			bindingId: "new-binding",
			executionId: "new",
			generation: 2,
			profile: "school",
			accountKey: "school-key",
		});
		expect(store.codexQuota.isExecutionPaused("new")).toBe(false);
		store.codexQuota.updateTarget("codex:root:1", "runner", "run", {
			state: "recovered",
		});
		expect(store.codexQuota.isExecutionPaused("old")).toBe(false);
	} finally {
		store.close();
	}
});
it("reconciles a manual identity change without forging a probe permit or releasing casualties", async () => {
	const store = await StateStore.create(":memory:");
	try {
		store.codexQuota.initializeRoot({
			rootKey: "root",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding(binding);
		store.codexQuota.recordSignal({ executionId: "old", bindingId: "b" });
		store.codexQuota.reconcileExternalRoot({
			rootKey: "root",
			expectedGeneration: 1,
			accountKey: "school-key",
			profile: "school",
			authDigest: "a".repeat(64),
		});
		expect(store.codexQuota.getRoot("root")).toMatchObject({
			generation: 2,
			profile: "school",
		});
		expect(store.codexQuota.getIncident("codex:root:1")).toMatchObject({
			state: "identity_uncertain",
			failure_code: "canonical_identity_changed",
			probe_result: null,
		});
		expect(store.codexQuota.isPaused("root")).toBe(false);
		expect(store.codexQuota.isExecutionPaused("old")).toBe(true);
		expect(() =>
			store.codexQuota.reconcileExternalRoot({
				rootKey: "root",
				expectedGeneration: 1,
				accountKey: "personal-key",
				profile: "personal",
				authDigest: "b".repeat(64),
			}),
		).toThrow("quota_generation_conflict");
	} finally {
		store.close();
	}
});
