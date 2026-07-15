import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import { resolveAllFlags, resolveFlag } from "../feature-flags/resolve.js";
import type { FlywheelConfig } from "../types.js";

function spec(name: string) {
	const s = FEATURE_FLAGS.find((f) => f.name === name);
	if (!s) throw new Error(`no spec ${name}`);
	return s;
}

describe("resolveFlag — env (bridge_global) byte-compat", () => {
	it("default_on kill-switch: on unless env === '0' (matches !== '0')", () => {
		const s = spec("auto_qa_killswitch"); // FLYWHEEL_AUTO_QA
		expect(resolveFlag(s, { env: {} }).effective).toBe(true);
		expect(resolveFlag(s, { env: { FLYWHEEL_AUTO_QA: "0" } }).effective).toBe(
			false,
		);
		expect(resolveFlag(s, { env: { FLYWHEEL_AUTO_QA: "1" } }).effective).toBe(
			true,
		);
		expect(
			resolveFlag(s, { env: { FLYWHEEL_AUTO_QA: "anything" } }).effective,
		).toBe(true);
	});

	it("opt_in: off unless env === '1'", () => {
		const s = spec("lead_chrome_enabled"); // FLYWHEEL_LEAD_CHROME_ENABLED
		expect(resolveFlag(s, { env: {} }).effective).toBe(false);
		expect(
			resolveFlag(s, { env: { FLYWHEEL_LEAD_CHROME_ENABLED: "1" } }).effective,
		).toBe(true);
		expect(
			resolveFlag(s, { env: { FLYWHEEL_LEAD_CHROME_ENABLED: "true" } })
				.effective,
		).toBe(false);
		expect(
			resolveFlag(s, { env: { FLYWHEEL_LEAD_CHROME_ENABLED: "0" } }).effective,
		).toBe(false);
	});

	it("isDefault reflects whether effective == default", () => {
		const s = spec("auto_qa_killswitch");
		expect(resolveFlag(s, { env: {} }).isDefault).toBe(true);
		expect(resolveFlag(s, { env: { FLYWHEEL_AUTO_QA: "0" } }).isDefault).toBe(
			false,
		);
	});

	it("value type surfaces the raw string (or default)", () => {
		const s = spec("reports_ttl_days");
		expect(resolveFlag(s, { env: {} }).effective).toBe("7");
		expect(
			resolveFlag(s, { env: { FLYWHEEL_REPORTS_TTL_DAYS: "30" } }).effective,
		).toBe("30");
	});

	it("DECISION_MODE enum reuses the real parser (off/audit_only/enforce + legacy alias)", () => {
		const s = spec("founder_consent_decision_mode");
		expect(resolveFlag(s, { env: {} }).effective).toBe("off");
		expect(
			resolveFlag(s, {
				env: { FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce" },
			}).effective,
		).toBe("enforce");
		expect(
			resolveFlag(s, { env: { FLYWHEEL_FOUNDER_CONSENT_ENABLED: "true" } })
				.effective,
		).toBe("enforce");
	});

	it("DECISION_MODE: malformed env → explicit error, NOT a fake valid effective", () => {
		const s = spec("founder_consent_decision_mode");
		const view = resolveFlag(s, {
			env: { FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "bogus" },
		});
		// must not present "bogus" as a valid mode
		expect(view.effective).toBeUndefined();
		expect(view.error).toMatch(/invalid/);
		expect(view.error).toContain("bogus");
	});
});

describe("resolveFlag — project scope", () => {
	const cfgA: FlywheelConfig = {
		qa: { auto: true },
	} as unknown as FlywheelConfig;
	const cfgB: FlywheelConfig = {} as unknown as FlywheelConfig;

	it("per-project effectiveByProject, each project independent", () => {
		const s = spec("qa_auto");
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
		const s = spec("qa_auto");
		const view = resolveFlag(s, {
			projectConfigs: new Map([["projX", { error: "invalid yaml" }]]),
		});
		const row = view.effectiveByProject?.[0];
		expect(row?.error).toMatch(/invalid yaml/);
		expect(row?.value).toBeUndefined();
	});

	it("absent config (ENOENT → {}) shows the default, NOT an error", () => {
		const s = spec("qa_auto");
		const view = resolveFlag(s, {
			projectConfigs: new Map([["missing", {}]]),
		});
		const row = view.effectiveByProject?.[0];
		expect(row?.error).toBeUndefined();
		expect(row?.value).toBe(false); // qa.auto default OFF
		expect(row?.isDefault).toBe(true);
	});

	it("no projectConfigs → empty effectiveByProject (not a crash)", () => {
		const view = resolveFlag(spec("qa_auto"), {});
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
