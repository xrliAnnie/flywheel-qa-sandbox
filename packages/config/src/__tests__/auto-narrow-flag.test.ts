import { describe, expect, it } from "vitest";
import {
	FEATURE_FLAGS,
	getFlagStoreCodec,
	validateFlagAuthoringPolicy,
} from "../feature-flags/index.js";

describe("FLY-2453 auto narrow feature flag", () => {
	it("registers the founder-message-controlled three-mode project flag", () => {
		const spec = FEATURE_FLAGS.find(
			(candidate) => candidate.name === "auto_merge_narrow_gate",
		);
		expect(spec).toMatchObject({
			category: "feature",
			source: "code_default",
			scope: "project",
			polarity: "default_on",
			valueKind: "enum",
			enumValues: ["off", "dry_run", "auto"],
			default: "dry_run",
			toggleable: "conversational",
			controlAuthority: "founder_message",
		});
		expect(spec?.envVar).toBeUndefined();
		expect(spec?.configKey).toBeUndefined();
		expect(validateFlagAuthoringPolicy()).toEqual([]);
	});

	it("uses a strict codec and degrades missing storage to dry_run", () => {
		const codec = getFlagStoreCodec("auto_merge_narrow_gate");
		expect(codec?.parse({ hasOverride: false, raw: null })).toBe("dry_run");
		for (const mode of ["off", "dry_run", "auto"]) {
			expect(codec?.parse({ hasOverride: true, raw: mode })).toBe(mode);
			expect(codec?.canonicalEffective(mode)).toBe(mode);
		}
		expect(() => codec?.parse({ hasOverride: true, raw: "enabled" })).toThrow(
			/auto narrow mode/i,
		);
	});
});
