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
		const runnerAutocontinue = FLAGS.find(
			(f) => f.name === "runner_autocontinue",
		);
		if (!runnerAutocontinue) throw new Error("missing");
		expect(effectLabel(runnerAutocontinue)).toBe("需重启");
		const qaAuto = FLAGS.find((f) => f.name === "qa_auto");
		if (!qaAuto) throw new Error("missing");
		expect(effectLabel(qaAuto)).toBe("新 run 生效");
		expect(
			effectLabel({ ...autoQa, readTimings: ["call_time", "dotenv_live"] }),
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
				(candidate) => candidate.name === "auto_qa_killswitch",
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
		expect(html).toContain("DAG 控制");
		expect(html).toContain("v1 dispatch");
		expect(html).toContain("ship reader");
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

	it("exposes state-aware fail-stop DAG presets through the same local copy surface", () => {
		expect(html).toContain("开 DAG v2 · 第一阶段");
		expect(html).toContain("data-dag-copy");
		expect(html).toContain(" &amp;&amp; ");
		expect(html).toContain("&amp;&amp; flywheel-comm feature-flags report");
		expect(html).toContain("命令末尾自动重发本报告");
		expect(html).not.toContain("完成后打开新链接");
		expect(html).not.toContain("第二阶段需打开新报告确认 claims reader");
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
