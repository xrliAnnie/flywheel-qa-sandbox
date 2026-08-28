import { describe, expect, it } from "vitest";
import { FLAG_EXEMPTIONS } from "../feature-flags/exemptions.js";
import * as FeatureFlags from "../feature-flags/index.js";
import type { FeatureFlagSpec } from "../feature-flags/registry.js";
import {
	FEATURE_FLAGS,
	validateKeepFieldContract,
} from "../feature-flags/registry.js";
import { RETIRED_CONFIG_PATHS, RETIRED_FLAGS } from "../feature-flags/truth.js";
import { auditFly1981LegacyLedger } from "./fly1981-legacy-snapshot.js";

// FLY-709: the registry's hard invariants — these are the safety rails that keep
// a governance gate from ever being web-toggleable and keep `direct` toggles
// restricted to flags the running Bridge will actually observe live.

describe("feature-flag registry invariants", () => {
	it("exports the FLY-1981 authoring guard through the public feature-flags surface", () => {
		expect(
			auditFly1981LegacyLedger({
				baseline: FeatureFlags.LEGACY_UNMANAGED_BASELINE,
				flags: FEATURE_FLAGS,
				storeManagedFlags: FeatureFlags.STORE_MANAGED_FLAGS,
				retiredFlags: RETIRED_FLAGS,
				retiredConfigPaths: RETIRED_CONFIG_PATHS,
				exemptions: FLAG_EXEMPTIONS,
			}),
		).toEqual([]);
		expect(FeatureFlags.validateFlagAuthoringPolicy).toBeTypeOf("function");
	});

	it.each([
		["auto_qa_killswitch", "FLYWHEEL_AUTO_QA"],
		["reports_ttl_days", "FLYWHEEL_REPORTS_TTL_DAYS"],
		["workflow_resume", "FLYWHEEL_WORKFLOW_RESUME"],
		["instruction_path_check", "FLYWHEEL_INSTRUCTION_PATH_CHECK"],
		["design_html_gate", "FLYWHEEL_DESIGN_HTML_GATE"],
		["ship_ci_guard", "FLYWHEEL_SHIP_CI_GUARD"],
		["qa_done_gate_killswitch", "FLYWHEEL_QA_DONE_GATE"],
		["codex_hard_gate_killswitch", "FLYWHEEL_CODEX_HARD_GATE"],
		["founder_attribution_gate", "FLYWHEEL_FOUNDER_ATTRIBUTION_GATE"],
		["founder_consent_decision_mode", "FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE"],
	] as const)(
		"FLY-1981 retires %s after solidifying its behavior",
		(name, envVar) => {
			expect(FEATURE_FLAGS.some((flag) => flag.name === name)).toBe(false);
			expect(RETIRED_FLAGS).toContainEqual({ envVar, retiredBy: "FLY-1981" });
		},
	);

	it("FLY-1981 removes the consent and duplicate mention rows in Batch 4", () => {
		expect(
			FEATURE_FLAGS.some((flag) => flag.name === "lead_core_mention_gated"),
		).toBe(false);
		expect(FEATURE_FLAGS.some((flag) => flag.name === "qa_auto")).toBe(false);
		expect(
			FEATURE_FLAGS.some(
				(flag) => flag.name === "founder_milestone_report_enabled",
			),
		).toBe(false);
	});

	it("FLY-1781 registers one default-on weekly-scan kill switch", () => {
		const flag = FEATURE_FLAGS.find(
			(entry) => entry.name === "flag_retirement_scan",
		);
		expect(flag).toMatchObject({
			category: "kill_switch",
			envVar: "FLYWHEEL_FLAG_RETIREMENT_SCAN",
			polarity: "default_on",
			valueKind: "bool",
			default: true,
			toggleable: "direct",
		});
		expect(flag?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/teamlead/src/bridge/plugin.ts",
				resolverSymbol: "storeFlagRetirementScanEnabled",
				timing: "call_time",
			}),
		]);
	});

	it("FLY-1807 retires the approved default-on e-stop wave", () => {
		const retired = [
			"FLYWHEEL_LIVENESS_ALERTS",
			"FLYWHEEL_PRUNE_PARK_GUARD",
			"FLYWHEEL_READOPT_PARKED",
			"FLYWHEEL_TMUX_KEEPALIVE",
			"FLYWHEEL_CMUX_WAL_QUARANTINE",
			"FLYWHEEL_CMUX_ROSTER",
			"FLYWHEEL_CMUX_VIEW_INVARIANT",
			"FLYWHEEL_CMUX_STRICT_VIEW",
			"FLYWHEEL_CODEX_GATE_WAIT",
			"FLYWHEEL_DUAL_ACTIVE_SCAN",
			"FLYWHEEL_QUOTA_DEGRADED_SWITCH",
			"FLYWHEEL_QUOTA_WAKE",
			"FLYWHEEL_REVIEW_SEVERITY_POLICY",
			"FLYWHEEL_PROGRESS_RESUME",
			"FLYWHEEL_CMUX_CLOSE_REQUEST",
			"FLYWHEEL_FOUNDER_REVIEW_GATE_EXCLUDE",
			"FLYWHEEL_FOUNDER_AUTO_APPROVE",
			"FLYWHEEL_STALE_SHIP_REWAKE",
			"FLYWHEEL_AUTO_LINEAR_DONE",
			"FLYWHEEL_FOUNDER_REPLY_UNREACHABLE",
			"FLYWHEEL_ASK_HYGIENE",
			"FLYWHEEL_FOUNDER_MILESTONE_NOTIFY",
			"FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP",
			"FLYWHEEL_ENGINE_UNLAUNCHED_TRIPWIRE",
			"FLYWHEEL_REMOTE_REPORTS",
			"FLYWHEEL_FLEET_CONSOLE",
			"FLYWHEEL_COMMDB_RESIDUE_HARVEST",
			"FLYWHEEL_TERMINAL_COMMDB_SYNC",
			"FLYWHEEL_CRON_STALE_GUARD",
			"FLYWHEEL_SHIP_GATE_REBIND",
			"FLYWHEEL_SHIP_GATE_RETIRE",
			"FLYWHEEL_SHIP_GATE_CARD",
			"FLYWHEEL_TIER2_PREFIX_NORM",
			"FLYWHEEL_VIEWER_SESSION_REAPER",
			"FLYWHEEL_CHROME_REAPER",
			"FLYWHEEL_FLEET_SENSOR_TMUX",
			"FLYWHEEL_LAND_NODE",
			"FLYWHEEL_VENDOR_AT_DISPATCH",
			"FLYWHEEL_COMMDB_PROTECTION",
			"FLYWHEEL_CONTINUITY_PREFLIGHT",
			"FLYWHEEL_PUSH_GUARD",
			"FLYWHEEL_DOA_BACKOFF",
		] as const;

		expect(retired).toHaveLength(42);
		for (const envVar of retired) {
			expect(FEATURE_FLAGS.some((flag) => flag.envVar === envVar)).toBe(false);
			expect(RETIRED_FLAGS).toContainEqual({ envVar, retiredBy: "FLY-1807" });
		}
	});

	it("names are unique", () => {
		const names = FEATURE_FLAGS.map((f) => f.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("env flags declare an envVar; project flags declare a configKey", () => {
		for (const f of FEATURE_FLAGS) {
			if (f.source === "env") expect(f.envVar, f.name).toBeTruthy();
			if (f.source === "project_config")
				expect(f.configKey, f.name).toBeTruthy();
		}
	});

	it("env flags are bridge_global; project_config flags are project-scoped", () => {
		for (const f of FEATURE_FLAGS) {
			if (f.source === "env") expect(f.scope, f.name).toBe("bridge_global");
			if (f.source === "project_config")
				expect(f.scope, f.name).toBe("project");
		}
	});

	it("every flag has at least one read site with a timing", () => {
		for (const f of FEATURE_FLAGS) {
			expect(f.readSites.length, f.name).toBeGreaterThan(0);
			for (const s of f.readSites) {
				expect(s.timing, f.name).toBeTruthy();
				expect(s.file, f.name).toBeTruthy();
				expect(s.symbol, f.name).toBeTruthy();
			}
		}
	});

	it("governance gates are ALWAYS readonly (never web-toggleable)", () => {
		for (const f of FEATURE_FLAGS) {
			if (f.category === "governance_gate") {
				expect(f.toggleable, f.name).toBe("readonly");
			}
		}
	});

	it("dormant flags are readonly", () => {
		for (const f of FEATURE_FLAGS) {
			if (f.dormant) expect(f.toggleable, f.name).toBe("readonly");
		}
	});

	it("F1 safety gate: direct toggles require ALL read sites hot + directToggleProof", () => {
		for (const f of FEATURE_FLAGS) {
			if (f.toggleable !== "direct") continue;
			expect(
				f.readSites.every((s) =>
					(["call_time", "dotenv_live"] as const).includes(
						s.timing as "call_time" | "dotenv_live",
					),
				),
				`${f.name} is direct but has a cold read site`,
			).toBe(true);
			expect(
				f.directToggleProof,
				`${f.name} direct without proof`,
			).toBeTruthy();
			// direct toggles are Bridge-global env flags (in-proc process.env mutate)
			expect(f.scope, f.name).toBe("bridge_global");
			expect(f.category, f.name).not.toBe("governance_gate");
		}
	});

	it("enum flags declare enumValues; the default is one of them", () => {
		for (const f of FEATURE_FLAGS) {
			if (f.valueKind === "enum") {
				expect(f.enumValues, f.name).toBeTruthy();
				expect(f.enumValues, f.name).toContain(f.default);
			}
		}
	});

	it("ponytail is dormant with an Annie-exception note and default off", () => {
		const p = FEATURE_FLAGS.find((f) => f.name === "ponytail");
		expect(p).toBeDefined();
		expect(p?.dormant).toBe(true);
		expect(p?.default).toBe(false);
		expect(p?.note ?? "").toMatch(/Annie/i);
	});

	it("FLY-1609 exposes the D arm through the live skill-framework enum", () => {
		const flag = FEATURE_FLAGS.find((f) => f.name === "skill_framework_mode");
		expect(flag?.enumValues).toEqual([
			"superpowers",
			"matt",
			"bare",
			"bare-ponytail",
			"split",
		]);
	});

	it("FLY-1456 no longer registers the retired legacy delivery watchdog flag", () => {
		const flag = FEATURE_FLAGS.find(
			(f) => f.name === "legacy_delivery_watchdogs",
		);
		expect(flag).toBeUndefined();
	});

	it("FLY-1560 keeps founder-reply consistency detection under an honest name", () => {
		for (const name of ["misroute_patrol", "zombie_gate_resolve"]) {
			expect(
				FEATURE_FLAGS.find((flag) => flag.name === name),
				name,
			).toBeUndefined();
		}
		expect(RETIRED_FLAGS).toContainEqual({
			envVar: "FLYWHEEL_FOUNDER_REPLY_WATCHDOG",
			retiredBy: "FLY-1560",
		});
	});

	it("FLY-1560 retires the removed Lead W-4 control", () => {
		expect(
			FEATURE_FLAGS.find((flag) => flag.name === "watchdog_blocked"),
		).toBeUndefined();
		expect(RETIRED_FLAGS).toContainEqual({
			envVar: "FLYWHEEL_WATCHDOG_BLOCKED",
			retiredBy: "FLY-1560",
		});
	});

	it("FLY-1560 retires idle polling", () => {
		expect(
			FEATURE_FLAGS.find((flag) => flag.name === "watchdog_liveness"),
		).toBeUndefined();
		expect(RETIRED_FLAGS).toEqual(
			expect.arrayContaining([
				{ envVar: "FLYWHEEL_WATCHDOG_LIVENESS", retiredBy: "FLY-1560" },
				{ envVar: "FLYWHEEL_IDLE_POLL_MS", retiredBy: "FLY-1560" },
				{ envVar: "FLYWHEEL_QUIET_PERSIST_DEDUP", retiredBy: "FLY-1560" },
				{ envVar: "FLYWHEEL_QUIET_CLASSIFIER", retiredBy: "FLY-1560" },
			]),
		);
	});

	it("FLY-1645 retires receipt rollout switches without active readers", () => {
		const retired = [
			"FLYWHEEL_RECEIPT_FOUNDATION",
			"FLYWHEEL_MAILBOX_DISCORD",
			"FLYWHEEL_CHAT_RECEIPTS",
		];
		for (const envVar of retired) {
			expect(FEATURE_FLAGS.some((flag) => flag.envVar === envVar)).toBe(false);
			expect(RETIRED_FLAGS).toContainEqual({ envVar, retiredBy: "FLY-1645" });
		}
		expect(FeatureFlags).not.toHaveProperty("receiptFoundationEnabled");
	});

	it("FLY-1314 registers gate-hygiene rollback controls", () => {
		const issueGateSupersede = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_ISSUE_GATE_SUPERSEDE",
		);
		expect(issueGateSupersede).toMatchObject({
			name: "issue_gate_supersede_mode",
			category: "kill_switch",
			polarity: "default_on",
			valueKind: "enum",
			enumValues: ["enforce", "observe", "0"],
			default: "enforce",
			toggleable: "readonly",
		});
		expect(issueGateSupersede?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/teamlead/src/bridge/issue-gate-supersede.ts",
				symbol: "sweepIssueGatesForProject",
				timing: "call_time",
			}),
		]);
	});

	it("FLY-1423 keeps workflow re-entry as a default-on kill switch", () => {
		const flag = FEATURE_FLAGS.find(
			(candidate) => candidate.envVar === "FLYWHEEL_WORKFLOW_REWORK_REENTRY",
		);
		expect(flag).toMatchObject({
			name: "workflow_rework_reentry",
			category: "kill_switch",
			scope: "bridge_global",
			polarity: "default_on",
			default: true,
			toggleable: "direct",
		});
		expect(flag?.readSites.map((site) => site.symbol)).toEqual([
			"workflowReworkCoordinatorHolder.current",
			"workflowEngineDispatcher",
		]);
		expect(flag?.directToggleProof).toMatch(/workflow-engine-dispatcher/i);
		expect(
			FEATURE_FLAGS.find(
				(candidate) => candidate.envVar === "FLYWHEEL_KICKBACK_EVICT",
			),
		).toBeUndefined();
	});

	it("FLY-1456 removes the temporary quota daemon cutover flag", () => {
		const cutover = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_QUOTA_DAEMON_CUTOVER",
		);
		expect(cutover).toBeUndefined();
	});

	it("FLY-2102 retires eight startup flags and accounts for the staged voice QA seam", () => {
		const retired = [
			"FLYWHEEL_FLAG_STORE",
			"FLYWHEEL_GHOST_GUARD_WAIT_MS",
			"FLYWHEEL_PUBLISH_BROKER",
			"FLYWHEEL_CONVERGE_CMUX_SYMLINK",
			"FLYWHEEL_CMUX_VIEW_HELPER",
			"FLYWHEEL_CMUX_NODE_PRESENCE",
			"FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS",
			"FLYWHEEL_LEAD_LEASE_BYPASS",
		] as const;
		const removedNames = [
			"flag_store",
			"ghost_guard_wait_ms",
			"publish_broker",
			"converge_cmux_symlink",
			"cmux_view_helper",
			"cmux_node_presence",
			"issue_display_sweep_ticks",
			"voice_qa_presence_override",
			"lead_lease_bypass",
		] as const;
		for (const name of removedNames) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.name === name),
				name,
			).toBe(false);
		}
		for (const envVar of retired) {
			expect(RETIRED_FLAGS).toContainEqual({ envVar, retiredBy: "FLY-2102" });
		}
		expect(FLAG_EXEMPTIONS).toContainEqual({
			name: "FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
			kind: "env",
			persistentEnvAllowed: false,
			reason: expect.stringMatching(/loopback staged Bridge/i),
			owner: "flywheel-eng-lead",
			issue: "FLY-2102",
		});
	});

	it("FLY-1808 retires the five linked DAG controls together", () => {
		for (const [name, envVar] of [
			["workflow_template_dispatch", "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH"],
			[
				"workflow_generalized_templates",
				"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
			],
			["workflow_claims_write", "FLYWHEEL_WORKFLOW_CLAIMS_WRITE"],
			["workflow_claims_read", "FLYWHEEL_WORKFLOW_CLAIMS_READ"],
			["workflow_gate_carrier", "FLYWHEEL_WORKFLOW_GATE_CARRIER"],
		] as const) {
			expect(FEATURE_FLAGS.find((candidate) => candidate.name === name)).toBe(
				undefined,
			);
			expect(RETIRED_FLAGS).toContainEqual({ envVar, retiredBy: "FLY-1808" });
		}
	});
});

// FLY-1779 (FLY-1412 §9.2 B1) — `longTermKeep` / `keepReason` are SCAN-WRITTEN
// state, not a birth-time declaration. Annie killed the "every new flag must
// declare its retirement condition" gate outright ("flag 不需要必须带退役条件呀"),
// so nothing here may force a new flag to carry these fields. What IS nailed
// down is §5.6: the two fields must not contradict `retiring`.
//
// The rules are asserted through the exported `validateKeepFieldContract`
// helper, on purpose. Scanning the real table alone would be VACUOUSLY GREEN —
// no production flag carries either field yet (by design; B3 writes them) — so
// a table-only assertion would prove nothing about the rule itself.
describe("FLY-1779 keep-field contract (§5.6)", () => {
	const base: FeatureFlagSpec = {
		name: "probe_flag",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "FLYWHEEL_PROBE",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "test fixture",
		readSites: [
			{
				file: "packages/teamlead/src/probe.ts",
				symbol: "probe",
				pattern: "process.env",
				timing: "call_time",
			},
		],
		toggleable: "readonly",
	};

	it("accepts a flag that declares neither field (never scanned = legal)", () => {
		expect(validateKeepFieldContract(base)).toEqual([]);
	});

	it("accepts longTermKeep with a reason, and without one", () => {
		expect(
			validateKeepFieldContract({
				...base,
				longTermKeep: true,
				keepReason: "Annie 扫描时答留:merge 安全门,永久保留",
			}),
		).toEqual([]);
		// The issue's own field comment says the reason 可为空 — a missing reason
		// must NOT be an error, or this becomes the forced-declaration gate again.
		expect(validateKeepFieldContract({ ...base, longTermKeep: true })).toEqual(
			[],
		);
	});

	it("rejects a flag that is both long-term-kept and retiring (§5.6 rule 1)", () => {
		const violations = validateKeepFieldContract({
			...base,
			longTermKeep: true,
			retiring: "FLY-1393",
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/longTermKeep/);
		expect(violations[0]).toMatch(/retiring/);
	});

	it("rejects a keepReason with no longTermKeep behind it", () => {
		expect(
			validateKeepFieldContract({ ...base, keepReason: "因为重要" }),
		).toHaveLength(1);
		expect(
			validateKeepFieldContract({
				...base,
				longTermKeep: false,
				keepReason: "因为重要",
			}),
		).toHaveLength(1);
	});

	it("rejects a blank keepReason (write a reason or write nothing)", () => {
		expect(
			validateKeepFieldContract({
				...base,
				longTermKeep: true,
				keepReason: "   ",
			}),
		).toHaveLength(1);
	});

	it("rejects a retiring value that is not a FLY-/GEO- issue id (§5.6 rule 3)", () => {
		for (const bad of ["", "FLY", "1393", "fly-1393", "FLY-", "see FLY-1393"]) {
			expect(
				validateKeepFieldContract({ ...base, retiring: bad }),
				bad,
			).toHaveLength(1);
		}
		for (const good of ["FLY-1393", "GEO-206"]) {
			expect(
				validateKeepFieldContract({ ...base, retiring: good }),
				good,
			).toEqual([]);
		}
	});

	it("reports every violation at once rather than stopping at the first", () => {
		const violations = validateKeepFieldContract({
			...base,
			longTermKeep: true,
			keepReason: "",
			retiring: "nope",
		});
		// Identity, not just arity: three duplicates of one message would also
		// have length 3, and so would "one rule missed, another double-reported".
		expect(violations).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/retiring must be a bare issue id/),
				expect.stringMatching(/contradicts retiring/),
				expect.stringMatching(/keepReason is present but blank/),
			]),
		);
		expect(new Set(violations).size).toBe(3);
	});

	it("a blank retiring is one diagnosis (format), not also a contradiction", () => {
		// §5.6 rule 1 is about a NON-EMPTY retiring. "" is malformed and nothing
		// more — reporting it twice would misdescribe what the author got wrong.
		const violations = validateKeepFieldContract({
			...base,
			retiring: "",
			longTermKeep: true,
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/retiring must be a bare issue id/);
	});

	it("the real registry satisfies the contract", () => {
		for (const flag of FEATURE_FLAGS) {
			expect(validateKeepFieldContract(flag), flag.name).toEqual([]);
		}
	});

	it("no CI gate demands longTermKeep at creation time (Annie killed that)", () => {
		// A plain, never-scanned flag is the shape of every production row today.
		// If some future change makes the contract require the field, this flips
		// red. Deliberately NOT asserted here: that no real flag carries the field
		// — that would forbid the very write B3 exists to perform.
		expect(validateKeepFieldContract(base)).toEqual([]);
		// `base` declares neither field and still type-checks as a FeatureFlagSpec,
		// which is the compile-time half of the same guarantee.
		expect(Object.hasOwn(base, "longTermKeep")).toBe(false);
		expect(Object.hasOwn(base, "keepReason")).toBe(false);
	});
});
