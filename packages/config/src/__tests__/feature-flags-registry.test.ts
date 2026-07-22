import { describe, expect, it } from "vitest";
import * as FeatureFlags from "../feature-flags/index.js";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";

// FLY-709: the registry's hard invariants — these are the safety rails that keep
// a governance gate from ever being web-toggleable and keep `direct` toggles
// restricted to flags the running Bridge will actually observe live.

describe("feature-flag registry invariants", () => {
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

	it("FLY-1257 registers the resident Codex gate-wait rollback switch as default-on", () => {
		const flag = FEATURE_FLAGS.find((f) => f.name === "codex_gate_wait");
		expect(flag).toMatchObject({
			category: "kill_switch",
			envVar: "FLYWHEEL_CODEX_GATE_WAIT",
			polarity: "default_on",
			default: true,
		});
		expect(flag?.readSites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: "packages/claude-runner/src/codex-daemon-client.ts",
					symbol: "runGoalToTerminal",
					timing: "call_time",
				}),
			]),
		);
	});

	it("FLY-1309 registers Lead identity safety controls with governance-safe toggleability", () => {
		const scan = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_DUAL_ACTIVE_SCAN",
		);
		expect(scan).toMatchObject({
			name: "lead_dual_active_scan",
			category: "kill_switch",
			polarity: "default_on",
			default: true,
			toggleable: "readonly",
		});
		expect(scan?.readSites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: "packages/teamlead/src/bridge/plugin.ts",
					timing: "object_construction",
				}),
				expect.objectContaining({
					file: "packages/teamlead/src/bridge/fleet-data.ts",
					timing: "call_time",
				}),
			]),
		);

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

	it("FLY-1373 registers legacy delivery watchdogs as a boot-captured opt-in", () => {
		const flag = FEATURE_FLAGS.find(
			(f) => f.name === "legacy_delivery_watchdogs",
		);
		expect(flag).toMatchObject({
			category: "kill_switch",
			envVar: "FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS",
			polarity: "opt_in",
			default: false,
			toggleable: "readonly",
		});
		expect(flag?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/teamlead/src/bridge/legacy-delivery-watchdog-policy.ts",
				symbol: "legacyDeliveryWatchdogsEnabled",
				timing: "bridge_boot",
			}),
		]);
	});

	it("FLY-1393 records both W-4 read timings instead of advertising a fake live toggle", () => {
		const flag = FEATURE_FLAGS.find((f) => f.name === "watchdog_blocked");
		expect(flag).toMatchObject({
			envVar: "FLYWHEEL_WATCHDOG_BLOCKED",
			default: true,
			toggleable: "readonly",
		});
		expect(flag?.readSites.map((site) => site.timing)).toEqual([
			"bridge_boot",
			"call_time",
		]);
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

	it("FLY-1392 registers the receipt foundation as a default-on kill switch", () => {
		const flag = FEATURE_FLAGS.find(
			(candidate) => candidate.name === "receipt_foundation",
		);
		expect(flag).toMatchObject({
			category: "kill_switch",
			envVar: "FLYWHEEL_RECEIPT_FOUNDATION",
			polarity: "default_on",
			default: true,
			toggleable: "readonly",
		});
		expect(flag?.readSites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: "packages/config/src/feature-flags/receipt-foundation.ts",
					symbol: "receiptFoundationEnabled",
					timing: "call_time",
				}),
			]),
		);
		expect(flag?.description).toContain("事故紧急临时回退");
		expect(flag?.description).toContain("只暂停 deadline、重发与升级");
		expect(flag?.description).not.toContain("两级收据");
		expect(flag?.note).toContain("启动时立即告警");
		expect(flag?.note).toContain("不得作为常态运行方式");

		const dryRun = FEATURE_FLAGS.find(
			(candidate) => candidate.name === "receipt_activation_dry_run",
		);
		expect(dryRun).toMatchObject({
			category: "feature",
			envVar: "FLYWHEEL_RECEIPT_ACTIVATION_DRY_RUN",
			polarity: "opt_in",
			default: false,
			toggleable: "readonly",
		});
		expect(dryRun?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/teamlead/src/bridge/plugin.ts",
				symbol: "LeadReceiptPatrol.activationDryRun",
				timing: "call_time",
			}),
		]);
		expect(
			FEATURE_FLAGS.some(
				(candidate) => candidate.envVar === "FLYWHEEL_REPLY_TO_CARD",
			),
		).toBe(false);
		expect(
			FEATURE_FLAGS.some(
				(candidate) => candidate.envVar === "FLYWHEEL_FOUNDER_APPROVAL_ACK",
			),
		).toBe(false);
	});

	it("FLY-1392 resolves receipt foundation as default-on with an exact =0 rollback", () => {
		const enabled = (
			FeatureFlags as unknown as {
				receiptFoundationEnabled?: (
					env: Record<string, string | undefined>,
				) => boolean;
			}
		).receiptFoundationEnabled;
		expect(enabled).toBeTypeOf("function");
		expect(enabled?.({})).toBe(true);
		expect(enabled?.({ FLYWHEEL_RECEIPT_FOUNDATION: "1" })).toBe(true);
		expect(enabled?.({ FLYWHEEL_RECEIPT_FOUNDATION: "0" })).toBe(false);
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

		const founderReviewExclusion = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_FOUNDER_REVIEW_GATE_EXCLUDE",
		);
		expect(founderReviewExclusion).toMatchObject({
			name: "founder_review_gate_exclude",
			category: "kill_switch",
			polarity: "default_on",
			default: true,
			toggleable: "direct",
		});
		expect(founderReviewExclusion?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/teamlead/src/bridge/gate-poller.ts",
				symbol: "founderReplyDeliverPass",
				timing: "call_time",
			}),
		]);

		const retestHeadDeltaGuard = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_RETEST_HEAD_DELTA_GUARD",
		);
		expect(retestHeadDeltaGuard).toMatchObject({
			name: "retest_head_delta_guard",
			category: "kill_switch",
			polarity: "default_on",
			default: true,
			toggleable: "direct",
		});
		expect(retestHeadDeltaGuard?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/teamlead/src/bridge/phase-orchestrator.ts",
				symbol: "shouldSuppressQaRetest",
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

	it("FLY-1066 residue harvest is a registered default-on Bridge kill-switch", () => {
		const flag = FEATURE_FLAGS.find((f) => f.name === "commdb_residue_harvest");
		expect(flag).toMatchObject({
			category: "kill_switch",
			scope: "bridge_global",
			envVar: "FLYWHEEL_COMMDB_RESIDUE_HARVEST",
			polarity: "default_on",
			default: true,
		});
	});

	it("FLY-1385 registers the dead-exec sweep as a live default-on kill switch", () => {
		const flag = FEATURE_FLAGS.find(
			(candidate) => candidate.envVar === "FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP",
		);
		expect(flag).toMatchObject({
			name: "engine_dead_exec_sweep",
			category: "kill_switch",
			scope: "bridge_global",
			polarity: "default_on",
			default: true,
			toggleable: "direct",
		});
		expect(flag?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/teamlead/src/bridge/workflow-engine-dispatcher.ts",
				symbol: "reconcile",
				timing: "call_time",
			}),
		]);
		expect(flag?.directToggleProof).toMatch(/live-sweep-flag/i);
	});

	it("FLY-1066 terminal CommDB sync is a registered default-on Bridge kill-switch", () => {
		const flag = FEATURE_FLAGS.find((f) => f.name === "terminal_commdb_sync");
		expect(flag).toMatchObject({
			category: "kill_switch",
			scope: "bridge_global",
			envVar: "FLYWHEEL_TERMINAL_COMMDB_SYNC",
			polarity: "default_on",
			default: true,
		});
	});

	it("quota daemon cutover is a temporary readonly boot flag tied to FLY-1284", () => {
		const cutover = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_QUOTA_DAEMON_CUTOVER",
		);
		expect(cutover).toMatchObject({
			name: "quota_daemon_cutover",
			category: "feature",
			polarity: "opt_in",
			default: false,
			toggleable: "readonly",
		});
		expect(cutover?.readSites).toEqual([
			expect.objectContaining({ timing: "object_construction" }),
		]);
		expect(cutover?.note).toContain("FLY-1284");
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

	it("FLY-1272 registers the two default-on cmux rollback switches with exact read sites", () => {
		const linked = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_CMUX_LINKED_VIEW",
		);
		const invariant = FEATURE_FLAGS.find(
			(f) => f.envVar === "FLYWHEEL_CMUX_VIEW_INVARIANT",
		);
		expect(linked).toMatchObject({
			name: "cmux_linked_view",
			polarity: "default_on",
			default: true,
			toggleable: "conversational",
		});
		expect(linked?.readSites).toHaveLength(3);
		expect(linked?.readSites.map((s) => s.file)).toEqual([
			"scripts/flywheel-cmux-sync.sh",
			"scripts/flywheel-cmux-autostart.sh",
			"packages/teamlead/src/bridge/tmux-lookup.ts",
		]);
		expect(invariant).toMatchObject({
			name: "cmux_view_invariant",
			polarity: "default_on",
			default: true,
			toggleable: "conversational",
		});
		expect(invariant?.readSites).toHaveLength(2);
		expect(invariant?.readSites.map((s) => s.file)).toEqual([
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
				["packages/teamlead/src/bridge/workflow-shadow-writer.ts", "call_time"],
				["packages/teamlead/src/bridge/plugin.ts", "call_time"],
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
			expect(flag?.readSites.map((site) => [site.file, site.timing])).toEqual(
				readSites,
			);
		}
	});

	it("FLY-1385 registers vendor-at-dispatch as a hot default-on escape switch", () => {
		const flag = FEATURE_FLAGS.find(
			(candidate) => candidate.name === "workflow_vendor_at_dispatch",
		);
		expect(flag).toMatchObject({
			category: "kill_switch",
			envVar: "FLYWHEEL_VENDOR_AT_DISPATCH",
			polarity: "default_on",
			default: true,
			toggleable: "direct",
		});
		expect(flag?.readSites).toEqual([
			expect.objectContaining({
				file: "packages/teamlead/src/workflow-dispatch-resolution.ts",
				symbol: "resolveNodeDispatchAtLaunch",
				timing: "call_time",
			}),
		]);
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
