import { describe, expect, it, vi } from "vitest";
import { type DecisionMode, resolveDecisionMode } from "../decision-mode.js";

// FLY-1981 deliberately retargets the old reverse-compat sentinel: production
// consent is permanently audit_only and retired env values have no authority.
describe("resolveDecisionMode (solidified production policy)", () => {
	it.each([
		{},
		{ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "off" },
		{ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce" },
		{ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "bogus" },
		{ FLYWHEEL_FOUNDER_CONSENT_ENABLED: "true" },
		{
			FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
			FLYWHEEL_FOUNDER_CONSENT_ENABLED: "true",
		},
	])("always resolves audit_only regardless of retired env input", (env) => {
		const warn = vi.fn();
		expect(resolveDecisionMode(env, warn)).toBe<DecisionMode>("audit_only");
		expect(warn).not.toHaveBeenCalled();
	});
});
