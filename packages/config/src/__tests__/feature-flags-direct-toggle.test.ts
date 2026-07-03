import { afterEach, describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import { resolveFlag } from "../feature-flags/resolve.js";

// FLY-709 F1: every `direct`-toggleable flag must be genuinely live — a change to
// process.env must be observed by the NEXT resolve without reconstructing
// anything. This is the resolver-layer proof of the `call_time` read timing that
// `directToggleProof` promises. (The owning-code proof — resolveAutoQaPolicy,
// GatePoller, HeartbeatService reading process.env each call — lives with the P2
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
			// All current direct flags are default_on kill-switches/features.
			delete process.env[key];
			expect(resolveFlag(spec, {}).effective).toBe(true);
			// Live mutate — no spec/object reconstruction.
			process.env[key] = "0";
			expect(resolveFlag(spec, {}).effective).toBe(false);
			process.env[key] = "1";
			expect(resolveFlag(spec, {}).effective).toBe(true);
		});
	}
});
