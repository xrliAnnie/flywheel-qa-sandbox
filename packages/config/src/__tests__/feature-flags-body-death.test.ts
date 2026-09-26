import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	getFlagStoreCodec,
	STORE_MANAGED_FLAGS,
} from "../feature-flags/store-policy.js";

describe("FLY-2919 body death runtime authorization", () => {
	it("is a default-on, bridge-global, dynamically read managed kill switch", () => {
		const spec = FEATURE_FLAGS.find(
			(flag) => flag.name === "execution_body_death_enabled",
		);
		expect(spec).toMatchObject({
			category: "kill_switch",
			scope: "bridge_global",
			default: true,
			polarity: "default_on",
			toggleable: "direct",
		});
		expect(spec?.readSites).toEqual([
			expect.objectContaining({
				timing: "call_time",
				resolverSymbol: "storeExecutionBodyDeathEnabled",
			}),
		]);
		expect(STORE_MANAGED_FLAGS.has("execution_body_death_enabled")).toBe(true);
	});
	it("uses the store codec so an explicit off overrides the default", () => {
		const codec = getFlagStoreCodec("execution_body_death_enabled");
		expect(codec).toBeDefined();
		expect(codec?.parse({ hasOverride: false, raw: null })).toBe(true);
		expect(codec?.parse({ hasOverride: true, raw: "0" })).toBe(false);
		expect(codec?.parse({ hasOverride: true, raw: "1" })).toBe(true);
	});
});
