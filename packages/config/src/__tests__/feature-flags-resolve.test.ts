import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	resolveAllFlags,
	resolveFlag,
	resolveScopedEffective,
} from "../feature-flags/resolve.js";
import { getFlagStoreCodec } from "../feature-flags/store-policy.js";

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
	it("leaves project rows to the scoped store enrichment path", () => {
		const view = resolveFlag(spec("doc_flow"), {});
		expect(view.effective).toBeUndefined();
		expect(view.effectiveByProject).toEqual([]);
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
				codec,
			}),
		).toEqual({
			projectName: "flywheel",
			value: true,
			isDefault: false,
			via: "star_row",
		});
	});

	it("falls back to the registry default when no scoped row exists", () => {
		expect(
			resolveScopedEffective({
				spec: flag,
				projectName: "defaulted",
				rows: [],
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
