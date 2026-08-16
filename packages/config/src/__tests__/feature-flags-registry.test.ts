import { describe, expect, it } from "vitest";
import * as FeatureFlags from "../feature-flags/index.js";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import { RETIRED_FLAGS } from "../feature-flags/truth.js";

// FLY-709: the registry's hard invariants — these are the safety rails that keep
// a governance gate from ever being web-toggleable and keep `direct` toggles
// restricted to flags the running Bridge will actually observe live.

describe("feature-flag registry invariants", () => {
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

	it("FLY-1309 keeps the Lead lease bypass governance-safe", () => {
		const bypass = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_LEAD_LEASE_BYPASS",
		);
		expect(bypass).toMatchObject({
			name: "lead_lease_bypass",
			category: "governance_gate",
			polarity: "opt_in",
			default: false,
			toggleable: "readonly",
		});
		expect(bypass?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/flywheel-comm/src/lead-lease.ts",
				symbol: "authorizeLeadWrite",
				timing: "cli_invocation",
			}),
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

	it("FLY-1404 registers the topology-neutral design HTML governance gate", () => {
		const flag = FEATURE_FLAGS.find((f) => f.name === "design_html_gate");
		expect(flag).toMatchObject({
			category: "governance_gate",
			envVar: "FLYWHEEL_DESIGN_HTML_GATE",
			polarity: "default_on",
			default: true,
			toggleable: "readonly",
		});
		expect(flag?.readSites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: "packages/flywheel-comm/src/commands/complete.ts",
					timing: "cli_invocation",
				}),
				expect.objectContaining({
					file: "packages/teamlead/src/bridge/event-route.ts",
					timing: "call_time",
				}),
				expect.objectContaining({
					file: "packages/teamlead/src/DirectEventSink.ts",
					timing: "call_time",
				}),
				expect.objectContaining({
					file: "packages/teamlead/src/bridge/complete-marker-reconciler.ts",
					timing: "call_time",
				}),
			]),
		);
	});

	it("FLY-1424 registers ship-ready notification and reminder controls", () => {
		const notify = FEATURE_FLAGS.find(
			(flag) => flag.envVar === "FLYWHEEL_SHIP_READY_NOTIFY",
		);
		expect(notify).toMatchObject({
			name: "ship_ready_notify",
			category: "feature",
			polarity: "default_on",
			valueKind: "bool",
			default: true,
			toggleable: "direct",
		});
		expect(notify?.directToggleProof).toContain("workflow-ship-ready.test");

		const remind = FEATURE_FLAGS.find(
			(flag) => flag.envVar === "FLYWHEEL_SHIP_READY_REMIND_MS",
		);
		expect(remind).toMatchObject({
			name: "ship_ready_remind_ms",
			category: "feature",
			polarity: "default_on",
			valueKind: "value",
			default: "1800000",
			toggleable: "readonly",
		});
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

		const shipCiGuard = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_SHIP_CI_GUARD",
		);
		expect(shipCiGuard).toMatchObject({
			name: "ship_ci_guard",
			category: "kill_switch",
			polarity: "default_on",
			default: true,
			toggleable: "readonly",
		});
		expect(shipCiGuard?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/flywheel-comm/src/ship-ci-guard.ts",
				symbol: "probeShipCiGreen",
				timing: "cli_invocation",
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
			"reconcile",
			"reconcileWorkflowReworks",
			"reconcileWorkflowReworkStalls",
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

	it("FLY-1252 registers account identity verification as a default-off external-runtime feature", () => {
		const identity = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_ACCOUNT_IDENTITY_CHECK",
		);
		expect(identity).toMatchObject({
			name: "claude_account_identity_check",
			category: "feature",
			polarity: "opt_in",
			default: false,
			toggleable: "conversational",
		});
		expect(identity?.readSites.map((site) => site.timing)).toEqual([
			"call_time",
			"cli_invocation",
		]);
		expect(identity?.note).toContain("identity-set + identity-audit");
	});

	it("FLY-1353 registers the voice presence QA seam with its real external-daemon read site", () => {
		const flag = FEATURE_FLAGS.find(
			(candidate) => candidate.envVar === "FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE",
		);
		expect(flag).toMatchObject({
			name: "voice_qa_presence_override",
			category: "feature",
			source: "env",
			scope: "bridge_global",
			polarity: "opt_in",
			valueKind: "bool",
			default: false,
			toggleable: "readonly",
		});
		expect(flag?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/voice-bridge/src/assistant/wiring.ts",
				symbol: "wireAssistantMode",
				pattern: "env-param",
				timing: "object_construction",
			}),
		]);
	});

	it("FLY-1272 keeps the linked-view rollout switch with exact read sites", () => {
		const linked = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_CMUX_LINKED_VIEW",
		);
		expect(linked).toMatchObject({
			name: "cmux_linked_view",
			polarity: "default_on",
			default: true,
			toggleable: "conversational",
			description:
				"FLY-1272/1364: 默认 exact-one-window link topology；关闭后仍保持独立视图的生命周期保护",
		});
		expect(linked?.readSites).toHaveLength(2);
		expect(linked?.readSites.map((s) => s.file)).toEqual([
			"scripts/flywheel-cmux-sync.sh",
			"scripts/flywheel-cmux-autostart.sh",
		]);
	});

	it("FLY-1344 enrolls the four DAG controls with exact hot read-site timings", () => {
		const expected = {
			workflow_template_dispatch: [
				["packages/teamlead/src/workflow-template-dispatch.ts", "call_time"],
			],
			workflow_generalized_templates: [
				["packages/teamlead/src/workflow-template.ts", "call_time"],
			],
			workflow_claims_write: [
				["packages/teamlead/src/workflow-claims.ts", "call_time"],
			],
			workflow_claims_read: [
				["packages/teamlead/src/workflow-claims.ts", "call_time"],
				["packages/flywheel-comm/src/ship-eligibility.ts", "call_time"],
				["packages/flywheel-comm/src/ship-eligibility.ts", "dotenv_live"],
				[
					"packages/flywheel-comm/src/commands/verify-approval.ts",
					"dotenv_live",
				],
			],
		} as const;
		for (const [name, readSites] of Object.entries(expected)) {
			const flag = FEATURE_FLAGS.find((candidate) => candidate.name === name);
			expect(flag).toMatchObject({
				source: "env",
				scope: "bridge_global",
				polarity: "opt_in",
				default: false,
				toggleable: "direct",
			});
			expect(flag?.category).toBe("feature");
			if (name === "workflow_generalized_templates") {
				expect(flag?.description).toMatch(
					/bundled v2 seed installation\/publication stays always-on and dormant/i,
				);
			}
			expect(flag?.readSites.map((site) => [site.file, site.timing])).toEqual(
				readSites,
			);
		}
	});

	it("FLY-1344 leaves true authorization surfaces governance-readonly", () => {
		for (const name of [
			"founder_consent_decision_mode",
			"founder_attribution_gate",
			"comm_bypass_bridge",
			"lead_lease_bypass",
			"founder_ux_gate",
		]) {
			expect(FEATURE_FLAGS.find((flag) => flag.name === name)).toMatchObject({
				category: "governance_gate",
				toggleable: "readonly",
			});
		}
	});
});
