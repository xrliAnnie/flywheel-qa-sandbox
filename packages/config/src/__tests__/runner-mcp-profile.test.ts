import { describe, expect, it } from "vitest";
import {
	DEFAULT_RUNNER_DISABLED_PLUGINS,
	resolveRunnerMcpProfile,
} from "../runner-mcp-profile.js";

describe("resolveRunnerMcpProfile (FLY-751)", () => {
	// context7 is deliberately NOT in the default list — founder ruling
	// (runners keep library-doc lookup), FLY-751 review 2026-07-01.
	it("default: disables the built-in three plugins and chrome (no context7)", () => {
		const profile = resolveRunnerMcpProfile({ env: {} });
		expect(profile).toEqual({
			disabledPlugins: [
				"discord@claude-plugins-official",
				"playwright@claude-plugins-official",
				"serena@claude-plugins-official",
			],
			disableChrome: true,
		});
		expect(profile?.disabledPlugins).not.toContain(
			"context7@claude-plugins-official",
		);
	});

	it("QA session keeps the browser: playwright removed from list, chrome kept", () => {
		const profile = resolveRunnerMcpProfile({ sessionRole: "qa", env: {} });
		expect(profile).toEqual({
			disabledPlugins: [
				"discord@claude-plugins-official",
				"serena@claude-plugins-official",
			],
			disableChrome: false,
		});
	});

	it("non-qa sessionRole values (e.g. main) get the full default slim", () => {
		const profile = resolveRunnerMcpProfile({ sessionRole: "main", env: {} });
		expect(profile?.disabledPlugins).toEqual(DEFAULT_RUNNER_DISABLED_PLUGINS);
		expect(profile?.disableChrome).toBe(true);
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
			disableChrome: true,
		});
	});

	it("empty env list + non-QA still yields chrome-only slimming", () => {
		const profile = resolveRunnerMcpProfile({
			env: { FLYWHEEL_RUNNER_DISABLED_PLUGINS: "" },
		});
		expect(profile).toEqual({ disabledPlugins: [], disableChrome: true });
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
});
