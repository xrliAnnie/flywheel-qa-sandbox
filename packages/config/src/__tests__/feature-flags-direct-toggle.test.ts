import { afterEach, describe, expect, it } from "vitest";
import { isDirectToggleMetadata } from "../feature-flags/direct-toggle.js";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import { resolveFlag } from "../feature-flags/resolve.js";

// FLY-709 F1: every `direct`-toggleable flag must be genuinely live — a change to
// process.env must be observed by the NEXT resolve without reconstructing
// anything. This is the resolver-layer proof of the `call_time` read timing that
// `directToggleProof` promises. (The owning-code proofs for each live reader
// live with the P2
// toggle handler in teamlead.)

const DIRECT = FEATURE_FLAGS.filter((f) => f.toggleable === "direct");

describe("direct-toggle flags observe a live process.env mutation", () => {
	const touched = new Set<string>();
	afterEach(() => {
		for (const k of touched) delete process.env[k];
		touched.clear();
	});

	it("has direct-toggle candidates to prove", () => {
		expect(DIRECT.length).toBeGreaterThan(0);
	});

	for (const spec of DIRECT) {
		it(`${spec.name}: process.env mutation is observed on the next resolve`, () => {
			const key = spec.envVar as string;
			touched.add(key);
			delete process.env[key];
			// FLY-1356: enum direct flags (skill_framework_mode) prove liveness
			// by flipping between enum values, not "0"/"1" bool raws.
			if (spec.valueKind === "enum") {
				expect(resolveFlag(spec, {}).effective).toBe(String(spec.default));
				const nonDefault = (spec.enumValues ?? []).find(
					(v) => v !== String(spec.default),
				) as string;
				process.env[key] = nonDefault;
				expect(resolveFlag(spec, {}).effective).toBe(nonDefault);
				process.env[key] = String(spec.default);
				expect(resolveFlag(spec, {}).effective).toBe(String(spec.default));
				return;
			}
			expect(resolveFlag(spec, {}).effective).toBe(spec.default);
			// Live mutate — no spec/object reconstruction.
			process.env[key] = "0";
			expect(resolveFlag(spec, {}).effective).toBe(false);
			process.env[key] = "1";
			expect(resolveFlag(spec, {}).effective).toBe(true);
		});
	}
});

describe("shared direct-toggle metadata predicate", () => {
	const base = {
		source: "env" as const,
		scope: "bridge_global" as const,
		valueKind: "bool" as const,
		toggleable: "direct" as const,
		category: "feature" as const,
		dormant: false,
	};

	it("accepts call_time + dotenv_live and rejects every cold timing", () => {
		expect(
			isDirectToggleMetadata({
				...base,
				readTimings: ["call_time", "dotenv_live"],
			}),
		).toBe(true);
		for (const timing of [
			"bridge_boot",
			"object_construction",
			"cli_invocation",
			"mixed",
		] as const) {
			expect(isDirectToggleMetadata({ ...base, readTimings: [timing] })).toBe(
				false,
			);
		}
	});

	// FLY-1356 R1#2: the predicate is widened to bool ∨ (enum with non-empty
	// enumValues) — an enum kill-switch (skill_framework_mode) must pass the
	// same shared gate that apply core / stage layer / console / CLI all use.
	it("accepts enum with non-empty enumValues; rejects enum without values (FLY-1356 R1#2)", () => {
		expect(
			isDirectToggleMetadata({
				...base,
				valueKind: "enum",
				enumValues: ["superpowers", "matt", "bare", "split"],
				readTimings: ["call_time"],
			}),
		).toBe(true);
		expect(
			isDirectToggleMetadata({
				...base,
				valueKind: "enum",
				enumValues: [],
				readTimings: ["call_time"],
			}),
		).toBe(false);
		expect(
			isDirectToggleMetadata({
				...base,
				valueKind: "enum",
				readTimings: ["call_time"],
			}),
		).toBe(false);
	});

	it("still structurally rejects governance, value-kind, dormant, and non-direct flags", () => {
		expect(
			isDirectToggleMetadata({
				...base,
				category: "governance_gate",
				readTimings: ["call_time"],
			}),
		).toBe(false);
		expect(
			isDirectToggleMetadata({
				...base,
				valueKind: "value",
				readTimings: ["call_time"],
			}),
		).toBe(false);
		expect(
			isDirectToggleMetadata({
				...base,
				dormant: true,
				readTimings: ["call_time"],
			}),
		).toBe(false);
		expect(
			isDirectToggleMetadata({
				...base,
				toggleable: "readonly",
				readTimings: ["call_time"],
			}),
		).toBe(false);
	});
});
