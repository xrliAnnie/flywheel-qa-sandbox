import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	getModelConfigSnapshot,
	resetModelConfigCacheForTests,
} from "flywheel-config";
import { expect, it } from "vitest";
import { planLeadConfigChange } from "../lead-config-plan.js";

function source() {
	return JSON.stringify([
		{
			projectName: "raya",
			projectRoot: "/tmp/raya",
			unrelated: { keep: 1 },
			leads: [
				{
					agentId: "raya",
					summaryRole: "producer",
					backend: "codex-app-server",
					botTokenEnv: "RAYA_BOT_TOKEN",
					botUserId: "12345678901234567",
					model: "gpt-6-astra",
					effort: "low",
					modelContextWindow: 1000000,
					codexProfile: "full-access",
					approvalPolicy: "never",
				},
			],
		},
	]);
}
function plan(
	patch: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
) {
	return planLeadConfigChange({
		source: source(),
		projectName: "raya",
		leadId: "raya",
		patch,
		modelSnapshot: getModelConfigSnapshot(),
		...overrides,
	});
}
it("changes only requested tuning fields and preserves identity, credentials and other structure", () => {
	const result = plan({ effort: "high" });
	const before = JSON.parse(source());
	const after = JSON.parse(result.candidate);
	expect(after[0].leads[0].effort).toBe("high");
	after[0].leads[0].effort = "low";
	expect(after).toEqual(before);
	expect(result.identity.leadKey).toBe("raya-raya");
	expect(result.preimage).toEqual({ model: "gpt-6-astra", effort: "low" });
	expect(result.postimage).toEqual({ model: "gpt-6-astra", effort: "high" });
	expect(result.resolved).toEqual({ model: "gpt-6-astra", effort: "high" });
	expect(result.preProjectsSha).not.toBe(result.postProjectsSha);
});
it.each([
	{},
	{ effort: null },
	{ model: "" },
	{ modelContextWindow: 100 },
	{ backend: "claude-code" },
	{ effort: "ultra" },
])("rejects invalid or non-tuning patch %j", (patch) => {
	expect(() => plan(patch)).toThrow();
});
it("refuses cross-vendor hot changes and context capacity regression", () => {
	expect(() => plan({ model: "opus" })).toThrow("backend_change_not_hot");
	const snapshot = getModelConfigSnapshot();
	const capped = {
		...snapshot,
		getModelRegistryEntry: (model: string) => {
			const entry = snapshot.getModelRegistryEntry(model);
			return entry && { ...entry, contextWindowTokens: 1000 };
		},
	};
	expect(() =>
		plan({ model: "gpt-5.6-sol" }, { modelSnapshot: capped }),
	).toThrow("context_window_incompatible");
});
it("rejects absent defaults rather than inventing native session settings", () => {
	const raw = JSON.parse(source());
	delete raw[0].leads[0].model;
	expect(() =>
		plan({ effort: "high" }, { source: JSON.stringify(raw) }),
	).toThrow("runtime_defaults_unavailable");
});
it("restores absent fields only with an explicit validated default pair", () => {
	const result = planLeadConfigChange({
		source: source(),
		projectName: "raya",
		leadId: "raya",
		restore: {},
		defaults: { model: "gpt-6-astra", effort: "high" },
		modelSnapshot: getModelConfigSnapshot(),
	});
	expect(JSON.parse(result.candidate)[0].leads[0]).not.toHaveProperty("model");
	expect(result.postimage).toEqual({});
	expect(result.resolved).toEqual({ model: "gpt-6-astra", effort: "high" });
});

it("admits an explicitly test-only file capacity and rejects the built-in unknown capacity", () => {
	const dir = mkdtempSync("/tmp/fly2606-capacity-");
	const previous = process.env.FLYWHEEL_MODELS_CONFIG;
	try {
		const path = `${dir}/models.json`;
		process.env.FLYWHEEL_MODELS_CONFIG = path;
		writeFileSync(path, JSON.stringify({ version: 1, models: [] }));
		resetModelConfigCacheForTests();
		expect(() => plan({ model: "gpt-5.6-sol" })).toThrow(
			"context_window_incompatible",
		);
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				models: [
					{
						id: "gpt-5.6-sol",
						label: "TEST ONLY capacity - not vendor certified",
						provider: "openai",
						runtimeVendor: "codex",
						aliases: [],
						dispatch: true,
						contextWindowTokens: 1_000_000,
					},
				],
			}),
		);
		resetModelConfigCacheForTests();
		const accepted = plan({ model: "gpt-5.6-sol" });
		expect(accepted.resolved.model).toBe("gpt-5.6-sol");
		expect(accepted.resolved.effort).toBe("low");
		expect(JSON.parse(accepted.candidate)[0].leads[0].modelContextWindow).toBe(
			1_000_000,
		);
	} finally {
		if (previous === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
		else process.env.FLYWHEEL_MODELS_CONFIG = previous;
		resetModelConfigCacheForTests();
		rmSync(dir, { recursive: true, force: true });
	}
});
