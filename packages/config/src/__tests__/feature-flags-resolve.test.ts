import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	resolveAllFlags,
	resolveFlag,
	resolveScopedEffective,
} from "../feature-flags/resolve.js";
import { getFlagStoreCodec } from "../feature-flags/store-policy.js";
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

describe("resolveScopedEffective — project store precedence", () => {
	const flag = spec("doc_flow");
	const codec = getFlagStoreCodec(flag.name);
	if (!codec) throw new Error("doc_flow must have a store codec");

	it("prefers the project row over the star row", () => {
		expect(
			resolveScopedEffective({
				spec: flag,
				projectName: "flywheel",
				rows: [
					{ scope: "*", raw: "0" },
					{ scope: "flywheel", raw: "1" },
				],
				configRow: {
					projectName: "flywheel",
					value: false,
					isDefault: true,
				},
				codec,
			}),
		).toEqual({
			projectName: "flywheel",
			value: true,
			isDefault: false,
			via: "project_row",
		});
	});

	it("uses the star row when the project row is absent", () => {
		expect(
			resolveScopedEffective({
				spec: flag,
				projectName: "flywheel",
				rows: [{ scope: "*", raw: "1" }],
				configRow: {
					projectName: "flywheel",
					value: false,
					isDefault: true,
				},
				codec,
			}),
		).toEqual({
			projectName: "flywheel",
			value: true,
			isDefault: false,
			via: "star_row",
		});
	});

	it("falls back byte-compatibly to config and then the registry default", () => {
		expect(
			resolveScopedEffective({
				spec: flag,
				projectName: "configured",
				rows: [],
				configRow: {
					projectName: "configured",
					value: true,
					isDefault: false,
				},
				codec,
			}),
		).toEqual({
			projectName: "configured",
			value: true,
			isDefault: false,
			via: "config",
		});
		expect(
			resolveScopedEffective({
				spec: flag,
				projectName: "defaulted",
				rows: [],
				configRow: {
					projectName: "defaulted",
					value: false,
					isDefault: true,
				},
				codec,
			}),
		).toEqual({
			projectName: "defaulted",
			value: false,
			isDefault: true,
			via: "default",
		});
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
