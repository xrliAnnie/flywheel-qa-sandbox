import { describe, expect, it } from "vitest";
import { type DecisionMode, resolveDecisionMode } from "../decision-mode.js";

// FLY-709 F3: resolveDecisionMode is extracted from
// packages/teamlead/src/bridge/founder-consent/config.ts into flywheel-config so
// the feature-flag registry resolver can compute the DECISION_MODE governance
// gate's effective value WITHOUT flywheel-config depending on flywheel-teamlead.
// These tests pin the CURRENT behavior byte-for-byte (reverse-compat sentinel).

describe("resolveDecisionMode (extracted to flywheel-config)", () => {
	it("defaults to off when nothing is set", () => {
		expect(resolveDecisionMode({})).toBe<DecisionMode>("off");
	});

	it("canonical DECISION_MODE wins for each valid value", () => {
		expect(
			resolveDecisionMode({ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "off" }),
		).toBe("off");
		expect(
			resolveDecisionMode({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "audit_only",
			}),
		).toBe("audit_only");
		expect(
			resolveDecisionMode({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
			}),
		).toBe("enforce");
	});

	it("trims surrounding whitespace on the canonical value", () => {
		expect(
			resolveDecisionMode({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "  enforce  ",
			}),
		).toBe("enforce");
	});

	it("THROWS on an invalid canonical value (must not fall back)", () => {
		expect(() =>
			resolveDecisionMode({ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "on" }),
		).toThrow(/must be off\|audit_only\|enforce/);
	});

	it("legacy FLYWHEEL_FOUNDER_CONSENT_ENABLED=true → enforce ONLY when canonical absent", () => {
		expect(
			resolveDecisionMode({ FLYWHEEL_FOUNDER_CONSENT_ENABLED: "true" }),
		).toBe("enforce");
		expect(resolveDecisionMode({ FLYWHEEL_FOUNDER_CONSENT_ENABLED: "1" })).toBe(
			"enforce",
		);
		expect(
			resolveDecisionMode({ FLYWHEEL_FOUNDER_CONSENT_ENABLED: "false" }),
		).toBe("off");
	});

	it("canonical takes precedence over legacy alias (and warns)", () => {
		const warnings: string[] = [];
		const mode = resolveDecisionMode(
			{
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "audit_only",
				FLYWHEEL_FOUNDER_CONSENT_ENABLED: "true",
			},
			(m) => warnings.push(m),
		);
		expect(mode).toBe("audit_only");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/legacy alias ignored/);
	});
});
