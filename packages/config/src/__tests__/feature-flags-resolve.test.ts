import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import { resolveAllFlags, resolveFlag } from "../feature-flags/resolve.js";
import type { FlywheelConfig } from "../types.js";

function spec(name: string) {
	const s = FEATURE_FLAGS.find((f) => f.name === name);
	if (!s) throw new Error(`no spec ${name}`);
	return s;
}

describe("resolveFlag — env (bridge_global) byte-compat", () => {
	const envVar = "FLYWHEEL_LOOP_PROFILER";
	const loopProfiler = () => spec("loop_profiler");

	it("resolves a default-on flag from env", () => {
		expect(resolveFlag(loopProfiler(), { env: {} }).effective).toBe(true);
		expect(
			resolveFlag(loopProfiler(), { env: { [envVar]: "0" } }).effective,
		).toBe(false);
		expect(
			resolveFlag(loopProfiler(), { env: { [envVar]: "1" } }).effective,
		).toBe(true);
	});

	it("reports dual-source agreement and source unavailability", () => {
		const agreement = resolveFlag(loopProfiler(), {
			env: { [envVar]: "0" },
			envFile: { status: "readable", content: `${envVar}=0\n` },
		});
		expect(agreement.displayEffective).toBe(false);
		expect(agreement.divergence).toBeUndefined();

		const unavailable = resolveFlag(loopProfiler(), {
			env: {},
			envFile: { status: "unavailable" },
		});
		expect(unavailable.bridgeEffective).toBe(true);
		expect(unavailable.displayEffective).toBeUndefined();
		expect(unavailable.divergence).toBe("source_unavailable");
	});
});

describe("resolveFlag — project scope", () => {
	const cfgA: FlywheelConfig = {
		doc_flow: { enabled: true, default_department: "engineering" },
	} as unknown as FlywheelConfig;
	const cfgB: FlywheelConfig = {} as unknown as FlywheelConfig;

	it("per-project effectiveByProject, each project independent", () => {
		const s = spec("doc_flow");
		const view = resolveFlag(s, {
			projectConfigs: new Map([
				["projA", { config: cfgA }],
				["projB", { config: cfgB }],
			]),
		});
		expect(view.effective).toBeUndefined();
		const byProj = view.effectiveByProject ?? [];
		expect(byProj.find((p) => p.projectName === "projA")?.value).toBe(true);
		expect(byProj.find((p) => p.projectName === "projB")?.value).toBe(false); // default OFF
	});

	it("malformed config load error is surfaced as data, not silently defaulted", () => {
		const s = spec("doc_flow");
		const view = resolveFlag(s, {
			projectConfigs: new Map([["projX", { error: "invalid yaml" }]]),
		});
		const row = view.effectiveByProject?.[0];
		expect(row?.error).toMatch(/invalid yaml/);
		expect(row?.value).toBeUndefined();
	});

	it("absent config (ENOENT → {}) shows the default, NOT an error", () => {
		const s = spec("doc_flow");
		const view = resolveFlag(s, {
			projectConfigs: new Map([["missing", {}]]),
		});
		const row = view.effectiveByProject?.[0];
		expect(row?.error).toBeUndefined();
		expect(row?.value).toBe(false); // doc_flow.enabled default OFF
		expect(row?.isDefault).toBe(true);
	});

	it("resolves wildcard config families without fabricating their defaults", () => {
		const checkpoints = resolveFlag(spec("checkpoint_enabled"), {
			projectConfigs: new Map([
				[
					"proj",
					{
						config: {
							checkpoints: {
								brainstorm: { enabled: true },
								question: { enabled: true },
							},
						} as FlywheelConfig,
					},
				],
			]),
		});
		expect(checkpoints.effectiveByProject).toEqual([
			{ projectName: "proj", value: true, isDefault: false },
		]);

		const collections = resolveFlag(spec("xiaohongshu_auto_create"), {
			projectConfigs: new Map([
				[
					"proj",
					{
						config: {
							xiaohongshu_learning: {
								collections: [{ auto_create: false }],
							},
						} as unknown as FlywheelConfig,
					},
				],
			]),
		});
		expect(collections.effectiveByProject).toEqual([
			{ projectName: "proj", value: false, isDefault: false },
		]);
	});

	it("surfaces mixed wildcard config values as an error", () => {
		const view = resolveFlag(spec("checkpoint_enabled"), {
			projectConfigs: new Map([
				[
					"proj",
					{
						config: {
							checkpoints: {
								brainstorm: { enabled: true },
								question: { enabled: false },
							},
						} as FlywheelConfig,
					},
				],
			]),
		});
		expect(view.effectiveByProject).toEqual([
			{
				projectName: "proj",
				error: "mixed values for checkpoints.*.enabled",
			},
		]);
	});

	it("no projectConfigs → empty effectiveByProject (not a crash)", () => {
		const view = resolveFlag(spec("doc_flow"), {});
		expect(view.effectiveByProject).toEqual([]);
	});

	it("dormant flag (ponytail) reports no effective value at all", () => {
		const view = resolveFlag(spec("ponytail"), {
			projectConfigs: new Map([
				[
					"projA",
					{
						config: {
							ponytail: { enabled: true },
						} as unknown as FlywheelConfig,
					},
				],
			]),
		});
		expect(view.dormant).toBe(true);
		expect(view.effective).toBeUndefined();
		expect(view.effectiveByProject).toBeUndefined();
	});
});

describe("resolveAllFlags", () => {
	it("resolves every registered flag", () => {
		const all = resolveAllFlags({ env: {} });
		expect(all.length).toBe(FEATURE_FLAGS.length);
	});

	it("carries readTimings badges for every flag", () => {
		for (const v of resolveAllFlags({ env: {} })) {
			expect(v.readTimings.length).toBeGreaterThan(0);
		}
	});
});
