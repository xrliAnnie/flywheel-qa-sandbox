import { describe, expect, it, vi } from "vitest";
import {
	configHash,
	failModeForAction,
	parseFounderConsentConfig,
	resolveDecisionMode,
	thresholdForAction,
} from "../config.js";

const base = (
	over: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv => ({ ...over }) as NodeJS.ProcessEnv;

describe("resolveDecisionMode solidified policy", () => {
	it("ignores both retired env controls and emits no compatibility warning", () => {
		const warn = vi.fn();
		for (const env of [
			base(),
			base({ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce" }),
			base({ FLYWHEEL_FOUNDER_CONSENT_ENABLED: "true" }),
			base({ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "bogus" }),
		]) {
			expect(resolveDecisionMode(env, warn)).toBe("audit_only");
		}
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("parseFounderConsentConfig validation tolerance (§8.1)", () => {
	it("accepts DISCORD_OWNER_USER_ID as the canonical founder identity", () => {
		const c = parseFounderConsentConfig(
			base({ DISCORD_OWNER_USER_ID: "canonical-founder" }),
			() => {},
		);
		expect(c.founderUserId).toBe("canonical-founder");
	});

	it("accepts matching canonical and legacy founder identities", () => {
		const c = parseFounderConsentConfig(
			base({
				DISCORD_OWNER_USER_ID: "same-founder",
				FLYWHEEL_FOUNDER_USER_ID: "same-founder",
			}),
			() => {},
		);
		expect(c.founderUserId).toBe("same-founder");
	});

	it("fails closed with actionable retired-env-free guidance when founder identities differ", () => {
		expect(() =>
			parseFounderConsentConfig(
				base({
					DISCORD_OWNER_USER_ID: "canonical-founder",
					FLYWHEEL_FOUNDER_USER_ID: "different-founder",
				}),
				() => {},
			),
		).toThrowError(
			new Error(
				"Founder identity mismatch: DISCORD_OWNER_USER_ID does not match the configured founder identity; remove the founder override or set it to the same Discord user ID",
			),
		);
	});

	it("audit_only always requires the canonical founder identity", () => {
		expect(() => parseFounderConsentConfig(base(), () => {})).toThrowError(
			new Error("DISCORD_OWNER_USER_ID is required for founder consent"),
		);
	});

	it("audit_only with founder id parses defaults", () => {
		const c = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_USER_ID: "12345",
			}),
			() => {},
		);
		expect(c.decisionMode).toBe("audit_only");
		expect(c.threshold).toBe(0.85);
		expect(c.windowHours).toBe(24);
		expect(c.maxMsgs).toBe(50);
		expect(c.cacheTtlSecs).toBe(60);
		expect(c.failMode).toBe("closed");
		expect(c.llmModel).toMatch(/haiku/);
		expect(c.auditDbPath).toMatch(/audit\.db$/);
	});

	it("per-action threshold JSON parses + applies", () => {
		const c = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_USER_ID: "1",
				FLYWHEEL_FOUNDER_CONSENT_THRESHOLD_PER_ACTION:
					'{"terminate":0.95,"defer":0.6}',
			}),
			() => {},
		);
		expect(thresholdForAction(c, "terminate")).toBe(0.95);
		expect(thresholdForAction(c, "defer")).toBe(0.6);
		expect(thresholdForAction(c, "approve")).toBe(0.85); // global fallback
	});

	it("bad per-action JSON throws clear error", () => {
		expect(() =>
			parseFounderConsentConfig(
				base({
					FLYWHEEL_FOUNDER_USER_ID: "1",
					FLYWHEEL_FOUNDER_CONSENT_THRESHOLD_PER_ACTION: "{not json",
				}),
				() => {},
			),
		).toThrow(/must be valid JSON/);
	});

	it("per-action fail mode applies", () => {
		const c = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_USER_ID: "1",
				FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE: "closed",
				FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION: '{"defer":"open"}',
			}),
			() => {},
		);
		expect(failModeForAction(c, "defer")).toBe("open");
		expect(failModeForAction(c, "approve")).toBe("closed");
	});

	it("pins workflow rework to threshold 0.85 and fail-closed", () => {
		const c = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_USER_ID: "1",
				FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_THRESHOLD: "0.9",
			}),
			() => {},
		);
		expect(thresholdForAction(c, "workflow_rework")).toBe(0.9);
		expect(failModeForAction(c, "workflow_rework")).toBe("closed");
	});

	it("fails start when workflow rework consent is configured fail-open", () => {
		expect(() =>
			parseFounderConsentConfig(
				base({
					FLYWHEEL_FOUNDER_USER_ID: "1",
					FLYWHEEL_FOUNDER_CONSENT_WORKFLOW_REWORK_FAIL_MODE: "open",
				}),
				() => {},
			),
		).toThrow(/WORKFLOW_REWORK_FAIL_MODE must be closed/);
		expect(() =>
			parseFounderConsentConfig(
				base({
					FLYWHEEL_FOUNDER_USER_ID: "1",
					FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION:
						'{"workflow_rework":"open"}',
				}),
				() => {},
			),
		).toThrow(/workflow_rework.*closed/);
	});
});

describe("configHash", () => {
	it("is stable for identical config and changes with threshold", () => {
		const a = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_USER_ID: "1",
			}),
			() => {},
		);
		const b = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_USER_ID: "1",
			}),
			() => {},
		);
		expect(configHash(a)).toBe(configHash(b));
		const c = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_USER_ID: "1",
				FLYWHEEL_FOUNDER_CONSENT_THRESHOLD: "0.6",
			}),
			() => {},
		);
		expect(configHash(c)).not.toBe(configHash(a));
	});
});
