import { describe, expect, it } from "vitest";
import type { FeatureFlagSpec } from "../feature-flags/registry.js";
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

	// FLY-1356 (Bar-Raiser R1#8): a generic enum flag must never present a raw
	// value outside its enumValues as a valid effective state — the owning code
	// fails closed on garbage, so the console must show an explicit error, not
	// the garbage string dressed up as the current mode.
	it("R1#8: enum flag with raw outside enumValues → explicit error, not fake effective", () => {
		const s = spec("issue_gate_supersede_mode");
		expect(resolveFlag(s, { env: {} }).effective).toBe("enforce");
		expect(
			resolveFlag(s, { env: { FLYWHEEL_ISSUE_GATE_SUPERSEDE: "observe" } })
				.effective,
		).toBe("observe");
		const bad = resolveFlag(s, {
			env: { FLYWHEEL_ISSUE_GATE_SUPERSEDE: "garbage" },
		});
		expect(bad.effective).toBeUndefined();
		expect(bad.error).toMatch(/invalid/);
		expect(bad.error).toContain("garbage");
	});

	it("R1#8: enum flag with empty-string raw displays the default (unset-equivalent)", () => {
		const s = spec("issue_gate_supersede_mode");
		const view = resolveFlag(s, {
			env: { FLYWHEEL_ISSUE_GATE_SUPERSEDE: "" },
		});
		expect(view.effective).toBe("enforce");
		expect(view.error).toBeUndefined();
	});

	// FLY-1329 A2 (Codex R2 LOW): the activity window is runtime-sanitized. The
	// resolver must report the SANITIZED value, not the raw env string, so the
	// dashboard never shows a value the runtime does not actually use.
	it("liveness_activity_window_ms: effective is the SANITIZED value, not the raw env", () => {
		const s = spec("liveness_activity_window_ms");
		// unset → default
		expect(resolveFlag(s, { env: {} }).effective).toBe("600000");
		expect(resolveFlag(s, { env: {} }).isDefault).toBe(true);
		// junk / zero / negative → runtime uses the default, so does the display
		expect(
			resolveFlag(s, {
				env: { FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS: "junk" },
			}).effective,
		).toBe("600000");
		expect(
			resolveFlag(s, {
				env: { FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS: "0" },
			}).effective,
		).toBe("600000");
		expect(
			resolveFlag(s, {
				env: { FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS: "-5" },
			}).effective,
		).toBe("600000");
		// a valid positive value is reported as-is and is NOT the default
		const valid = resolveFlag(s, {
			env: { FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS: "120000" },
		});
		expect(valid.effective).toBe("120000");
		expect(valid.isDefault).toBe(false);
	});

	it.each([
		[
			"legacy alias",
			{ FLYWHEEL_FOUNDER_CONSENT_ENABLED: "true" },
			"FLYWHEEL_FOUNDER_CONSENT_ENABLED=true\n",
		],
		[
			"canonical whitespace",
			{ FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: "enforce" },
			"FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE=  enforce  \n",
		],
	] as const)(
		"DECISION_MODE dual-source reuses the real parser for %s",
		(_label, env, content) => {
			const view = resolveFlag(spec("founder_consent_decision_mode"), {
				env,
				envFile: { status: "readable", content },
			});
			expect(view.bridgeEffective).toBe("enforce");
			expect(view.fileEffective).toBe("enforce");
			expect(view.displayEffective).toBe("enforce");
			expect(view.divergence).toBeUndefined();
		},
	);

	it("dual-source: readable agreement exposes one display value and preserves effective as the Bridge alias", () => {
		const view = resolveFlag(spec("auto_qa_killswitch"), {
			env: { FLYWHEEL_AUTO_QA: "0" },
			envFile: { status: "readable", content: "FLYWHEEL_AUTO_QA=0\n" },
		});
		expect(view.bridgeEffective).toBe(false);
		expect(view.fileEffective).toBe(false);
		expect(view.displayEffective).toBe(false);
		expect(view.effective).toBe(false);
		expect(view.divergence).toBeUndefined();
	});

	it("dual-source: a readable file with the key absent resolves the deterministic default", () => {
		const view = resolveFlag(spec("auto_qa_killswitch"), {
			env: {},
			envFile: { status: "readable", content: "OTHER=1\n" },
		});
		expect(view.bridgeEffective).toBe(true);
		expect(view.fileEffective).toBe(true);
		expect(view.displayEffective).toBe(true);
		expect(view.divergence).toBeUndefined();
	});

	it("dual-source: unavailable is degraded instead of being mistaken for key absence", () => {
		const view = resolveFlag(spec("auto_qa_killswitch"), {
			env: {},
			envFile: { status: "unavailable" },
		});
		expect(view.bridgeEffective).toBe(true);
		expect(view.fileEffective).toBeUndefined();
		expect(view.displayEffective).toBeUndefined();
		expect(view.divergence).toBe("source_unavailable");
	});

	it.each([
		["all call_time", spec("auto_qa_killswitch"), "bridge_stale"],
		["boot-captured", spec("worktree_autoclean"), "staged_restart"],
		[
			"mixed dotenv-live",
			{
				...spec("auto_qa_killswitch"),
				readSites: [
					...spec("auto_qa_killswitch").readSites,
					{
						file: "packages/flywheel-comm/src/ship-eligibility.ts",
						symbol: "test live reader",
						timing: "dotenv_live",
						readKind: "dynamic",
					},
				],
			} as FeatureFlagSpec,
			"split_brain",
		],
	] as const)(
		"dual-source divergence class: %s",
		(_label, flagSpec, expected) => {
			const envVar = flagSpec.envVar as string;
			const view = resolveFlag(flagSpec, {
				env: { [envVar]: "0" },
				envFile: { status: "readable", content: `${envVar}=1\n` },
			});
			expect(view.bridgeEffective).not.toBe(view.fileEffective);
			expect(view.displayEffective).toBeUndefined();
			expect(view.divergence).toBe(expected);
		},
	);
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
