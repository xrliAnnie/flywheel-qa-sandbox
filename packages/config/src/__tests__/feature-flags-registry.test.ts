import { describe, expect, it } from "vitest";
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

	it("F1 safety gate: direct toggles require ALL read sites call_time + directToggleProof", () => {
		for (const f of FEATURE_FLAGS) {
			if (f.toggleable !== "direct") continue;
			expect(
				f.readSites.every((s) => s.timing === "call_time"),
				`${f.name} is direct but has a non-call_time read site`,
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

	it("registers workflow template dispatch as a default-off governance gate", () => {
		const flag = FEATURE_FLAGS.find(
			(candidate) => candidate.name === "workflow_template_dispatch",
		);
		expect(flag).toMatchObject({
			category: "governance_gate",
			source: "env",
			scope: "bridge_global",
			envVar: "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH",
			polarity: "opt_in",
			default: false,
			toggleable: "readonly",
		});
	});
});
