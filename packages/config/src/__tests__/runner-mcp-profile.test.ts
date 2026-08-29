import { describe, expect, it } from "vitest";
import {
	DEFAULT_RUNNER_DISABLED_PLUGINS,
	resolveRunnerMcpProfile,
} from "../runner-mcp-profile.js";

const PLAYWRIGHT = "playwright@claude-plugins-official";

describe("resolveRunnerMcpProfile (FLY-751)", () => {
	// FLY-812 (founder review 2026-07-03): default slim narrowed to serena ONLY.
	// discord + playwright are kept fleet-wide (runner / geoforge3d testing need
	// them); chrome defaults ON; context7 stays excluded (library-doc lookup).
	it("default: disables serena only, keeps discord/playwright/chrome (no context7)", () => {
		const profile = resolveRunnerMcpProfile({ env: {} });
		expect(profile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: false,
			enabledPluginsExtra: [],
		});
		expect(profile?.disabledPlugins).not.toContain(
			"discord@claude-plugins-official",
		);
		expect(profile?.disabledPlugins).not.toContain(PLAYWRIGHT);
		expect(profile?.disabledPlugins).not.toContain(
			"context7@claude-plugins-official",
		);
	});

	// FLY-1185 §2.7: QA now carries the POSITIVE playwright opt-in — the
	// channel that overrides the machine-level default-off.
	it("QA session: serena-only slim, chrome kept, playwright positively enabled", () => {
		const profile = resolveRunnerMcpProfile({ sessionRole: "qa", env: {} });
		expect(profile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: false,
			enabledPluginsExtra: [PLAYWRIGHT],
		});
	});

	it("non-qa sessionRole values (e.g. main) get the plugin slim, chrome ON, no extras", () => {
		const profile = resolveRunnerMcpProfile({ sessionRole: "main", env: {} });
		expect(profile?.disabledPlugins).toEqual(DEFAULT_RUNNER_DISABLED_PLUGINS);
		expect(profile?.disableChrome).toBe(false);
		expect(profile?.enabledPluginsExtra).toEqual([]);
	});

	// FLY-1185 §2.7: full-mcp no longer degenerates to null — with the machine
	// default-off in place, "everything available" MUST carry the positive
	// playwright entry or the machine default would silently win.
	it("full-mcp label → no slimming but the playwright opt-in survives (case-insensitive)", () => {
		const expected = {
			disabledPlugins: [],
			disableChrome: false,
			enabledPluginsExtra: [PLAYWRIGHT],
		};
		expect(
			resolveRunnerMcpProfile({ issueLabels: ["full-mcp"], env: {} }),
		).toEqual(expected);
		expect(
			resolveRunnerMcpProfile({ issueLabels: ["bug", "Full-MCP"], env: {} }),
		).toEqual(expected);
	});

	// FLY-1185 §2.7: the per-issue playwright opt-in label.
	it("playwright label → default slim + positive playwright entry", () => {
		const profile = resolveRunnerMcpProfile({
			issueLabels: ["playwright"],
			env: {},
		});
		expect(profile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: false,
			enabledPluginsExtra: [PLAYWRIGHT],
		});
	});

	it("FLYWHEEL_RUNNER_SLIM_MCP=0 is a global kill-switch", () => {
		expect(
			resolveRunnerMcpProfile({ env: { FLYWHEEL_RUNNER_SLIM_MCP: "0" } }),
		).toBeNull();
	});

	// FLY-1185 §2.7 documented limitation: under the kill-switch the label
	// CANNOT opt back in (null profile → no --settings → machine default-off
	// applies unconditionally). Combination test pins this.
	it("SLIM_MCP=0 + playwright label → STILL null (label ineffective under the kill-switch)", () => {
		expect(
			resolveRunnerMcpProfile({
				issueLabels: ["playwright"],
				sessionRole: "qa",
				env: { FLYWHEEL_RUNNER_SLIM_MCP: "0" },
			}),
		).toBeNull();
	});

	it("FLYWHEEL_RUNNER_SLIM_MCP=1 (or any non-0) keeps slimming on", () => {
		expect(
			resolveRunnerMcpProfile({ env: { FLYWHEEL_RUNNER_SLIM_MCP: "1" } }),
		).not.toBeNull();
	});

	it("FLYWHEEL_RUNNER_DISABLED_PLUGINS set is authoritative (split/trim/filter)", () => {
		const profile = resolveRunnerMcpProfile({
			env: {
				FLYWHEEL_RUNNER_DISABLED_PLUGINS:
					" discord@claude-plugins-official , , serena@claude-plugins-official ",
			},
		});
		expect(profile).toEqual({
			disabledPlugins: [
				"discord@claude-plugins-official",
				"serena@claude-plugins-official",
			],
			disableChrome: false,
			enabledPluginsExtra: [],
		});
	});

	// FLY-812: with chrome default-ON, an empty plugin list + non-QA + no
	// `no-chrome` label leaves nothing to slim → degenerate null (byte-compat).
	it("empty env list + non-QA + no opt-out → null (nothing to slim)", () => {
		const profile = resolveRunnerMcpProfile({
			env: { FLYWHEEL_RUNNER_DISABLED_PLUGINS: "" },
		});
		expect(profile).toBeNull();
	});

	// FLY-1185 §2.7: QA has a positive opt-in to deliver, so it must NOT
	// degenerate to null even with nothing to disable (extra 非空不退化 null).
	it("empty env list + QA → profile with ONLY the playwright opt-in (not null)", () => {
		const profile = resolveRunnerMcpProfile({
			sessionRole: "qa",
			env: { FLYWHEEL_RUNNER_DISABLED_PLUGINS: "" },
		});
		expect(profile).toEqual({
			disabledPlugins: [],
			disableChrome: false,
			enabledPluginsExtra: [PLAYWRIGHT],
		});
	});

	it("QA removes playwright from a custom env list too (disjoint from the opt-in)", () => {
		const profile = resolveRunnerMcpProfile({
			sessionRole: "qa",
			env: {
				FLYWHEEL_RUNNER_DISABLED_PLUGINS:
					"playwright@claude-plugins-official,serena@claude-plugins-official",
			},
		});
		expect(profile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: false,
			enabledPluginsExtra: [PLAYWRIGHT],
		});
	});

	// ─── FLY-812: `no-chrome` label = explicit chrome opt-out (default is ON) ───

	it("FLY-812: no-chrome label forces chrome off for a non-QA runner (plugins still slimmed)", () => {
		const profile = resolveRunnerMcpProfile({
			issueLabels: ["no-chrome"],
			env: {},
		});
		expect(profile).toEqual({
			disabledPlugins: DEFAULT_RUNNER_DISABLED_PLUGINS,
			disableChrome: true,
			enabledPluginsExtra: [],
		});
	});

	it("FLY-812: no-chrome label is case-insensitive", () => {
		const profile = resolveRunnerMcpProfile({
			issueLabels: ["bug", "No-Chrome"],
			env: {},
		});
		expect(profile?.disableChrome).toBe(true);
	});

	it("FLY-812: no-chrome label forces chrome off even for a QA session", () => {
		const profile = resolveRunnerMcpProfile({
			sessionRole: "qa",
			issueLabels: ["no-chrome"],
			env: {},
		});
		expect(profile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: true,
			enabledPluginsExtra: [PLAYWRIGHT],
		});
	});

	// FLY-1185 §2.7: full-mcp keeps its no-slim semantics but no longer nulls —
	// no-chrome is subsumed (full-mcp means "everything available").
	it("full-mcp + no-chrome → full-mcp shape wins (no slim, playwright opt-in)", () => {
		expect(
			resolveRunnerMcpProfile({
				issueLabels: ["no-chrome", "full-mcp"],
				env: {},
			}),
		).toEqual({
			disabledPlugins: [],
			disableChrome: false,
			enabledPluginsExtra: [PLAYWRIGHT],
		});
	});

	// Codex R1 #2: the explicit opt-out must survive the degenerate guard — an
	// empty plugin override leaves disabledPlugins empty, but disableChrome:true
	// means there IS something to do, so it must NOT collapse to null.
	it("FLY-812: no-chrome + empty plugin override → {[], disableChrome:true} (not null)", () => {
		const profile = resolveRunnerMcpProfile({
			issueLabels: ["no-chrome"],
			env: { FLYWHEEL_RUNNER_DISABLED_PLUGINS: "" },
		});
		expect(profile).toEqual({
			disabledPlugins: [],
			disableChrome: true,
			enabledPluginsExtra: [],
		});
	});
});
