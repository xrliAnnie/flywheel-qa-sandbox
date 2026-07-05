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

describe("resolveDecisionMode precedence (§8.1.1)", () => {
	it("DECISION_MODE wins over ENABLED and warns", () => {
		const warn = vi.fn();
		const mode = resolveDecisionMode(
			base({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
				FLYWHEEL_FOUNDER_CONSENT_ENABLED: "false",
			}),
			warn,
		);
		expect(mode).toBe("enforce");
		expect(warn).toHaveBeenCalledOnce();
	});

	it("ENABLED=true → enforce when DECISION_MODE absent", () => {
		expect(
			resolveDecisionMode(base({ FLYWHEEL_FOUNDER_CONSENT_ENABLED: "true" })),
		).toBe("enforce");
	});

	it("both absent → off", () => {
		expect(resolveDecisionMode(base())).toBe("off");
	});

	it("ENABLED=false / unset → off", () => {
		expect(
			resolveDecisionMode(base({ FLYWHEEL_FOUNDER_CONSENT_ENABLED: "false" })),
		).toBe("off");
	});

	it("invalid DECISION_MODE throws", () => {
		expect(() =>
			resolveDecisionMode(
				base({ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "bogus" }),
			),
		).toThrow(/off\|audit_only\|enforce/);
	});
});

describe("parseFounderConsentConfig validation tolerance (§8.1)", () => {
	it("off mode does NOT require FOUNDER_USER_ID", () => {
		const c = parseFounderConsentConfig(base(), () => {});
		expect(c.decisionMode).toBe("off");
		expect(c.founderUserId).toBe("");
	});

	it("enforce mode requires FOUNDER_USER_ID", () => {
		expect(() =>
			parseFounderConsentConfig(
				base({ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce" }),
				() => {},
			),
		).toThrow(/FLYWHEEL_FOUNDER_USER_ID is required/);
	});

	it("enforce mode with founder id parses defaults", () => {
		const c = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
				FLYWHEEL_FOUNDER_USER_ID: "12345",
			}),
			() => {},
		);
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
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
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
					FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "audit_only",
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
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
				FLYWHEEL_FOUNDER_USER_ID: "1",
				FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE: "closed",
				FLYWHEEL_FOUNDER_CONSENT_FAIL_MODE_PER_ACTION: '{"defer":"open"}',
			}),
			() => {},
		);
		expect(failModeForAction(c, "defer")).toBe("open");
		expect(failModeForAction(c, "approve")).toBe("closed");
	});
});

describe("configHash", () => {
	it("is stable for identical config and changes with threshold", () => {
		const a = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
				FLYWHEEL_FOUNDER_USER_ID: "1",
			}),
			() => {},
		);
		const b = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
				FLYWHEEL_FOUNDER_USER_ID: "1",
			}),
			() => {},
		);
		expect(configHash(a)).toBe(configHash(b));
		const c = parseFounderConsentConfig(
			base({
				FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce",
				FLYWHEEL_FOUNDER_USER_ID: "1",
				FLYWHEEL_FOUNDER_CONSENT_THRESHOLD: "0.6",
			}),
			() => {},
		);
		expect(configHash(c)).not.toBe(configHash(a));
	});
});
