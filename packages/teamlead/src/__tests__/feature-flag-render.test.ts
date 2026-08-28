import { resolveAllFlags } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	effectLabel,
	renderFeatureFlagsHtml,
	renderFlagCard,
} from "../bridge/feature-flag-render.js";
import { renderFlagReport } from "../bridge/feature-flag-report-html.js";

const FLAGS = resolveAllFlags({ env: {} });
const PROJECT_FLAG = {
	...FLAGS.find((flag) => flag.name === "doc_flow")!,
	storeManaged: false,
	projectStoreManaged: true,
	clockReadiness: "ready" as const,
	scopedStore: {
		rows: [
			{ scope: "*", raw: "0", value: false },
			{ scope: "flywheel", raw: "1", value: true },
		],
	},
	effectiveByProject: [
		{
			projectName: "flywheel",
			value: true,
			isDefault: false,
			via: "project_row" as const,
		},
		{
			projectName: "geoforge3d",
			value: false,
			isDefault: true,
			via: "star_row" as const,
			runtimeConfigValue: true,
			runtimeDivergence: "config_pending_cutover" as const,
		},
	],
};

describe("feature-flag renderer (Apple cards, read-only)", () => {
	it("renders every flag as cards, grouped by category", () => {
		const html = renderFeatureFlagsHtml(FLAGS);
		expect(html).toContain("FLYWHEEL_FOUNDER_REVIEW_ORPHAN_MONITOR");
		expect(html).not.toContain("FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE");
		expect(html).toContain("doc_flow.enabled");
		// card structure with left-border category classes (html-report-style)
		expect(html).toContain('class="ffc');
		expect(html).toContain("ff-grid");
	});

	it("read-only mode has NO toggle controls anywhere", () => {
		const html = renderFeatureFlagsHtml(FLAGS, "none");
		expect(html).not.toMatch(/<input/i);
		expect(html).not.toMatch(/<button/i);
		expect(html).not.toMatch(/type="checkbox"/i);
	});

	it("console mode gives direct flags a toggle button (never governance/project)", () => {
		const html = renderFeatureFlagsHtml(FLAGS, "console");
		expect(html).toContain('data-ff-name="founder_review_orphan_monitor"');
		expect(html).toContain("data-ff-apply");
		// governance gate + project flag never get a control
		expect(html).not.toContain('data-ff-name="founder_consent_decision_mode"');
		expect(html).not.toContain('data-ff-name="doc_flow"');
	});

	it("phone mode gives direct flags a checkbox (for the copy-paste command)", () => {
		const html = renderFeatureFlagsHtml(FLAGS, "phone");
		expect(html).toContain('data-ff-name="founder_review_orphan_monitor"');
		expect(html).toContain("data-ff-toggle");
		expect(html).toContain('type="checkbox"');
	});

	it("renders project/store provenance, transition divergence, and row-presence controls", () => {
		const html = renderFlagCard(PROJECT_FLAG, "phone");
		expect(html).toContain("项目行");
		expect(html).toContain("* 行");
		expect(html).toContain("runtime 仍按 config");
		expect(html).toContain("C 单切换");
		expect(html).toContain("data-ffp-scope");
		expect(html).toContain("data-ffp-value");
		expect(html).toContain('data-ffp-name="doc_flow"');
		expect(html).toContain(
			'data-ffp-state="{&quot;*&quot;:{&quot;p&quot;:1,&quot;v&quot;:&quot;off&quot;},&quot;flywheel&quot;:{&quot;p&quot;:1,&quot;v&quot;:&quot;on&quot;},&quot;geoforge3d&quot;:{&quot;p&quot;:0}}"',
		);
		expect(html).toContain(
			'<option value="off" selected>OFF（显式行）</option>',
		);
		expect(html).toContain('<option value="clear">清除（回落继承）</option>');
	});

	it("keeps an absent star row in an explicit inherit baseline", () => {
		const html = renderFlagCard(
			{
				...PROJECT_FLAG,
				scopedStore: {
					rows: [{ scope: "flywheel", raw: "0", value: false }],
				},
			},
			"phone",
		);
		expect(html).toContain(
			'<option value="inherit" selected>继承（未设行）</option>',
		);
		expect(html).not.toContain('value="clear"');
	});

	it("suppresses controls for a store-managed flag on console and phone", () => {
		const managed = FLAGS.find(
			(flag) => flag.name === "workflow_turn_divergence_alerts",
		);
		if (!managed) throw new Error("missing workflow_turn_divergence_alerts");
		for (const mode of ["console", "phone"] as const) {
			const html = renderFlagCard({ ...managed, storeManaged: true }, mode);
			expect(html).not.toContain("data-ff-apply");
			expect(html).not.toContain("data-ff-toggle");
		}
	});

	it("warns when a ready store-managed flag still has an ignored .env line", () => {
		const managed = FLAGS.find((flag) => flag.name === "skill_framework_mode");
		if (!managed) throw new Error("missing skill_framework_mode");
		const html = renderFlagCard(
			{
				...managed,
				storeManaged: true,
				clockReadiness: "ready",
				fileConfigured: true,
				fileEffective: undefined,
				divergence: undefined,
			},
			"console",
		);
		expect(html).toContain("SQLite flag store");
		expect(html).toContain("stage/apply");
		expect(html).not.toContain("CLI 与 Bridge 见值不同");
	});

	it("does not tell operators to delete an authoritative .env line in degraded mode", () => {
		const clockReadiness = "no_clock:degraded" as const;
		const managed = FLAGS.find((flag) => flag.name === "skill_framework_mode");
		if (!managed) throw new Error("missing skill_framework_mode");
		const html = renderFlagCard(
			{
				...managed,
				storeManaged: true,
				clockReadiness,
				fileConfigured: true,
			},
			"console",
		);
		expect(html).not.toContain("legacy .env 行已忽略");
	});

	it("effect label maps timing → 生效路径", () => {
		const direct = FLAGS.find(
			(f) => f.name === "founder_review_orphan_monitor",
		);
		if (!direct) throw new Error("missing");
		expect(effectLabel(direct)).toBe("热生效");
		expect(
			effectLabel({ ...direct, readTimings: ["object_construction"] }),
		).toBe("需重启");
		const docFlow = FLAGS.find((f) => f.name === "doc_flow");
		if (!docFlow) throw new Error("missing");
		expect(effectLabel(docFlow)).toBe("新 run 生效");
		expect(
			effectLabel({ ...direct, readTimings: ["call_time", "dotenv_live"] }),
		).toBe("热生效");
	});

	it.each([
		["staged_restart", ".env 已改,待重启生效"],
		["split_brain", "CLI 与 Bridge 见值不同"],
		["bridge_stale", ".env 已改,Bridge 未拾取"],
		["source_unavailable", ".env 不可读,无法确认或操作"],
	] as const)(
		"renders %s explicitly with both observations and no directional control",
		(divergence, message) => {
			const flag = FLAGS.find(
				(candidate) => candidate.name === "founder_review_orphan_monitor",
			);
			if (!flag) throw new Error("missing flag");
			const html = renderFlagCard(
				{
					...flag,
					bridgeEffective: true,
					fileEffective:
						divergence === "source_unavailable" ? undefined : false,
					displayEffective: undefined,
					divergence,
				},
				"phone",
			);
			expect(html).toContain(message);
			expect(html).toContain("Bridge: ON");
			if (divergence !== "source_unavailable") {
				expect(html).toContain(".env: OFF");
			}
			expect(html).not.toContain("data-ff-toggle");
		},
	);

	it("escapes untrusted-looking content", () => {
		const html = renderFlagCard({
			name: "x",
			category: "feature",
			description: "<script>alert(1)</script>",
			toggleable: "readonly",
			valueKind: "bool",
			scope: "bridge_global",
			source: "env",
			envVar: "FLYWHEEL_X",
			readTimings: ["call_time"],
			default: true,
			effective: true,
			isDefault: true,
		});
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("renders a bridge-global malformed value as a visible error, not blank", () => {
		const html = renderFlagCard({
			name: "issue_gate_supersede_mode",
			category: "governance_gate",
			description: "issue gate supersede mode",
			toggleable: "readonly",
			valueKind: "enum",
			scope: "bridge_global",
			source: "env",
			envVar: "FLYWHEEL_ISSUE_GATE_SUPERSEDE",
			readTimings: ["call_time"],
			default: "enforce",
			error: "invalid FLYWHEEL_ISSUE_GATE_SUPERSEDE: bogus",
		});
		expect(html).toContain("ff-err");
		expect(html).toContain("bogus");
		expect(html).not.toContain("ff-val");
	});
});

describe("renderFlagReport (phone, read-only)", () => {
	const html = renderFlagReport(FLAGS, { generatedAt: "2026-07-01 12:00" });

	it("is a complete Apple-light document with a <head>", () => {
		expect(html).toMatch(/<head>/i);
		expect(html).toMatch(/<\/head>/i);
		expect(html).toMatch(/<!doctype html>/i);
		expect(html).toContain("#f5f5f7"); // Apple-light background
	});

	it("read-only has no script / no network callback (CSP-safe)", () => {
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/fetch\(/);
	});

	it("includes all flags", () => {
		expect(html).toContain("FLYWHEEL_FOUNDER_REVIEW_ORPHAN_MONITOR");
		expect(html).toContain("doc_flow.enabled");
		expect(html).not.toContain("DAG 控制");
	});
});

describe("renderFlagReport interactive=true (phone copy-paste)", () => {
	const html = renderFlagReport(FLAGS, { interactive: true });

	it("uses a nonce'd script and builds the apply command locally", () => {
		expect(html).toContain('<script nonce="__CSP_NONCE__">');
		expect(html).toContain("data-ff-toggle");
		expect(html).toContain("FleetCmd.flagCommand");
		expect(html).toContain('reason:"phone-report"');
	});

	it("makes NO network callback (CSP default-src none blocks it anyway)", () => {
		expect(html).not.toMatch(/fetch\(/);
		expect(html).not.toContain("/api/fleet/flag/stage");
		expect(html).not.toContain("/api/fleet/flag/apply");
	});

	it("has a copy surface (textarea + copy button)", () => {
		expect(html).toContain('id="ffCopyText"');
		expect(html).toContain('id="ffCopyBtn"');
	});

	it("does not expose presets for retired workflow rollout flags", () => {
		expect(html).not.toContain("开 DAG v2 · 第一阶段");
		expect(html).not.toContain("data-dag-copy");
		expect(html).not.toContain("workflow_claims_read");
	});

	it("only lists direct-toggleable flags as controls", () => {
		expect(html).toContain('data-ff-name="founder_review_orphan_monitor"');
		expect(html).not.toContain('data-ff-name="founder_consent_decision_mode"');
		expect(html).not.toContain('data-ff-name="doc_flow"');
	});
});

// FLY-709 P4: the interactive hosted page also carries Lead / runner / cron
// config rows that feed the SAME copy textarea (still zero network callback).
describe("renderFlagReport interactive with a full snapshot (P4)", () => {
	const SNAP = {
		leads: [
			{
				leadId: "sub-lead",
				key: "sub-sub-lead",
				projectName: "sub",
				displayName: "sub-lead",
				currentBackend: "claude-code",
				backendSource: "default",
				currentModelId: "claude-sonnet-5",
				currentModelLabel: "Sonnet 5",
				backendOptions: [
					{ backend: "claude-code", switchable: false },
					{ backend: "codex-app-server", switchable: false },
				],
				tierOptions: [
					{ id: "claude-fable-5", label: "Fable 5" },
					{ id: null, label: "Opus 4.8" },
				],
				allowedModelTargets: [],
				currentEffort: null,
				currentEffortLabel: "默认",
				effortOptions: [
					{ id: null, label: "默认" },
					{ id: "high", label: "high" },
				],
				allowedEffortTargets: [],
			},
		],
		featureFlags: FLAGS,
		projectRunnerDefaults: [
			{ projectName: "sub", model: null, effort: null, backend: null },
		],
		cronModels: [
			{
				projectName: "flywheel",
				collectionId: "c1",
				label: "AI-视频",
				leadId: "sub-lead",
				model: "haiku",
			},
		],
		runnerCapabilities: {
			backends: ["claude-tmux", "codex-tmux", "antigravity-tmux", "kimi-tmux"],
			models: ["claude-fable-5", "claude-sonnet-5"],
			efforts: ["low", "high"],
		},
		fleetScriptPath: "/repo/scripts/flywheel-fleet.sh",
		commCliPath: "/repo/packages/flywheel-comm/dist/index.js",
	} as never;

	const html = renderFlagReport(SNAP, { interactive: true });

	it("carries the runtime paths as body data attributes", () => {
		expect(html).toContain(
			'data-fleet-script="/repo/scripts/flywheel-fleet.sh"',
		);
		expect(html).toContain(
			'data-comm-cli="/repo/packages/flywheel-comm/dist/index.js"',
		);
	});

	it("renders Lead / runner / cron config rows with the FleetCmd builder", () => {
		expect(html).toContain('data-lead-row="sub-sub-lead"');
		expect(html).toContain('data-runner-row="sub"');
		expect(html).toContain('data-cron-row="0"');
		expect(html).toContain('data-cron-id="c1"');
		expect(html).toContain("var FleetCmd");
		// The runner backend dropdown carries the FULL executor set (Antigravity /
		// Kimi live at the runner layer — the honest place for the 4-option set).
		expect(html).toContain("antigravity-tmux");
		expect(html).toContain("kimi-tmux");
		// The Lead section's roadmap note (FLY-264 honesty).
		expect(html).toContain("FLY-264");
	});

	it("still makes no network callback", () => {
		expect(html).not.toMatch(/fetch\(/);
	});

	it("read-only mode renders NONE of the config rows (byte-compat shape)", () => {
		const ro = renderFlagReport(SNAP, {});
		expect(ro).not.toContain("data-lead-row");
		expect(ro).not.toContain("data-runner-row");
		expect(ro).not.toContain("data-cron-row");
		expect(ro).not.toMatch(/<script/i);
	});
});
