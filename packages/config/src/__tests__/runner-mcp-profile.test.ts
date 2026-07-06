import { describe, expect, it } from "vitest";
import {
	DEFAULT_RUNNER_DISABLED_PLUGINS,
	resolveRunnerMcpProfile,
} from "../runner-mcp-profile.js";

describe("resolveRunnerMcpProfile (FLY-751)", () => {
	// FLY-812 (founder review 2026-07-03): default slim narrowed to serena ONLY.
	// discord + playwright are kept fleet-wide (runner / geoforge3d testing need
	// them); chrome defaults ON; context7 stays excluded (library-doc lookup).
	it("default: disables serena only, keeps discord/playwright/chrome (no context7)", () => {
		const profile = resolveRunnerMcpProfile({ env: {} });
		expect(profile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: false,
		});
		expect(profile?.disabledPlugins).not.toContain(
			"discord@claude-plugins-official",
		);
		expect(profile?.disabledPlugins).not.toContain(
			"playwright@claude-plugins-official",
		);
		expect(profile?.disabledPlugins).not.toContain(
			"context7@claude-plugins-official",
		);
	});

	it("QA session: same serena-only slim, chrome kept", () => {
		const profile = resolveRunnerMcpProfile({ sessionRole: "qa", env: {} });
		expect(profile).toEqual({
			disabledPlugins: ["serena@claude-plugins-official"],
			disableChrome: false,
		});
	});

	it("non-qa sessionRole values (e.g. main) get the plugin slim, chrome ON", () => {
		const profile = resolveRunnerMcpProfile({ sessionRole: "main", env: {} });
		expect(profile?.disabledPlugins).toEqual(DEFAULT_RUNNER_DISABLED_PLUGINS);
		expect(profile?.disableChrome).toBe(false);
	});

	it("full-mcp label opts the runner out entirely (case-insensitive)", () => {
		expect(
			resolveRunnerMcpProfile({ issueLabels: ["full-mcp"], env: {} }),
		).toBeNull();
		expect(
			resolveRunnerMcpProfile({ issueLabels: ["bug", "Full-MCP"], env: {} }),
		).toBeNull();
	});

	it("FLYWHEEL_RUNNER_SLIM_MCP=0 is a global kill-switch", () => {
		expect(
			resolveRunnerMcpProfile({ env: { FLYWHEEL_RUNNER_SLIM_MCP: "0" } }),
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

	it("empty env list + QA degenerates to null (nothing to slim)", () => {
		const profile = resolveRunnerMcpProfile({
			sessionRole: "qa",
			env: { FLYWHEEL_RUNNER_DISABLED_PLUGINS: "" },
		});
		expect(profile).toBeNull();
	});

	it("QA removes playwright from a custom env list too", () => {
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
		});
	});

	it("FLY-812: full-mcp takes precedence over no-chrome (both present → null)", () => {
		expect(
			resolveRunnerMcpProfile({
				issueLabels: ["no-chrome", "full-mcp"],
				env: {},
			}),
		).toBeNull();
	});

	// Codex R1 #2: the explicit opt-out must survive the degenerate guard — an
	// empty plugin override leaves disabledPlugins empty, but disableChrome:true
	// means there IS something to do, so it must NOT collapse to null.
	it("FLY-812: no-chrome + empty plugin override → {[], disableChrome:true} (not null)", () => {
		const profile = resolveRunnerMcpProfile({
			issueLabels: ["no-chrome"],
			env: { FLYWHEEL_RUNNER_DISABLED_PLUGINS: "" },
		});
		expect(profile).toEqual({ disabledPlugins: [], disableChrome: true });
	});
});
