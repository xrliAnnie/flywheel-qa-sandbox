import { resolveAllFlags } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	effectLabel,
	renderFeatureFlagsHtml,
	renderFlagCard,
} from "../bridge/feature-flag-render.js";
import { renderFlagReport } from "../bridge/feature-flag-report-html.js";

const FLAGS = resolveAllFlags({ env: {} });

describe("feature-flag renderer (Apple cards, read-only)", () => {
	it("renders every flag as cards, grouped by category", () => {
		const html = renderFeatureFlagsHtml(FLAGS);
		expect(html).toContain("FLYWHEEL_AUTO_QA");
		expect(html).toContain("FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE");
		expect(html).toContain("qa.auto");
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
		expect(html).toContain('data-ff-name="auto_qa_killswitch"');
		expect(html).toContain("data-ff-apply");
		// governance gate + project flag never get a control
		expect(html).not.toContain('data-ff-name="founder_consent_decision_mode"');
		expect(html).not.toContain('data-ff-name="qa_auto"');
	});

	it("phone mode gives direct flags a checkbox (for the copy-paste command)", () => {
		const html = renderFeatureFlagsHtml(FLAGS, "phone");
		expect(html).toContain('data-ff-name="auto_qa_killswitch"');
		expect(html).toContain("data-ff-toggle");
		expect(html).toContain('type="checkbox"');
	});

	it("effect label maps timing → 生效路径", () => {
		const autoQa = FLAGS.find((f) => f.name === "auto_qa_killswitch");
		if (!autoQa) throw new Error("missing");
		expect(effectLabel(autoQa)).toBe("热生效");
		const remote = FLAGS.find((f) => f.name === "remote_reports");
		if (!remote) throw new Error("missing");
		expect(effectLabel(remote)).toBe("命令级");
		const paneIdle = FLAGS.find((f) => f.name === "pane_idle_suppress");
		if (!paneIdle) throw new Error("missing");
		expect(effectLabel(paneIdle)).toBe("需重启");
		const qaAuto = FLAGS.find((f) => f.name === "qa_auto");
		if (!qaAuto) throw new Error("missing");
		expect(effectLabel(qaAuto)).toBe("新 run 生效");
	});

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
			name: "founder_consent_decision_mode",
			category: "governance_gate",
			description: "founder-consent 硬门",
			toggleable: "readonly",
			valueKind: "enum",
			scope: "bridge_global",
			source: "env",
			envVar: "FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE",
			readTimings: ["call_time"],
			default: "off",
			error: "invalid FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE: bogus",
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
		expect(html).toContain("FLYWHEEL_AUTO_QA");
		expect(html).toContain("doc_flow.enabled");
	});
});

describe("renderFlagReport interactive=true (phone copy-paste)", () => {
	const html = renderFlagReport(FLAGS, { interactive: true });

	it("uses a nonce'd script and builds the apply command locally", () => {
		expect(html).toContain('<script nonce="__CSP_NONCE__">');
		expect(html).toContain("data-ff-toggle");
		expect(html).toContain("flywheel-comm feature-flags apply --name ");
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

	it("only lists direct-toggleable flags as controls", () => {
		expect(html).toContain('data-ff-name="auto_qa_killswitch"');
		expect(html).not.toContain('data-ff-name="founder_consent_decision_mode"');
		expect(html).not.toContain('data-ff-name="qa_auto"');
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
