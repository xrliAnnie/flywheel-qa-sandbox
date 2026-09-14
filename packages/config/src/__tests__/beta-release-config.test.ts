import { describe, expect, it } from "vitest";
import { parseBetaReleaseConfig } from "../beta-release-config.js";

describe("beta release authoring", () => {
	it("keeps an absent block unconfigured and defaults only a present block to 24h", () => {
		expect(parseBetaReleaseConfig(undefined)).toBeUndefined();
		expect(parseBetaReleaseConfig({})).toEqual({
			interval_hours: 24,
			source_commit: "default_branch_head",
		});
		expect(parseBetaReleaseConfig({ interval_hours: 6 })).toEqual({
			interval_hours: 6,
			source_commit: "default_branch_head",
		});
	});
});

it("rejects malformed configuration without including supplied values in errors", () => {
	for (const value of [
		null,
		[],
		"secret",
		2,
		true,
		{ interval_hours: null },
		{ interval_hours: "6" },
		{ interval_hours: 0 },
		{ interval_hours: -1 },
		{ interval_hours: 1.5 },
		{ interval_hours: 169 },
		{ interval_hours: NaN },
		{ interval_hours: Infinity },
		{ enabled: true },
		{ token_env: "secret-value" },
		{ workflow_file: "../../secret.yml" },
		{ workflow_file: "-secret.yml" },
		{ workflow_file: "https://secret/x.yml" },
		{ workflow_file: "a..yml" },
		{ workflow_file: null },
		{ token_env: null },
		{ token_env: "a" },
	]) {
		expect(() => parseBetaReleaseConfig(value)).toThrow(/beta_release/);
		try {
			parseBetaReleaseConfig(value);
		} catch (error) {
			expect(String(error)).not.toContain("secret");
		}
	}
	expect(
		parseBetaReleaseConfig({
			interval_hours: 168,
			workflow_file: "beta-release.yaml",
			token_env: "PROJECT_ACTIONS_TOKEN",
		}),
	).toEqual({
		source_commit: "default_branch_head",
		interval_hours: 168,
		workflow_file: "beta-release.yaml",
		token_env: "PROJECT_ACTIONS_TOKEN",
	});
});

it("uses the same parser for project YAML loading, including defaults and rejection", async () => {
	const { ConfigLoader } = await import("../ConfigLoader.js");
	const base = `project: test
linear: {team_id: T}
runners: {default: claude, available: {claude: {type: claude}}}
teams: [{name: dev}]
decision_layer: {autonomy_level: observer, escalation_channel: dev}
`;
	for (const [yaml, value] of [
		["", undefined],
		["beta_release: {}", {}],
		["beta_release: {interval_hours: 6}", { interval_hours: 6 }],
		[
			"beta_release: {source_commit: local_deployed_sha}",
			{ source_commit: "local_deployed_sha" },
		],
	] as const) {
		const config = await new ConfigLoader(async () => base + yaml).load(
			"/project",
		);
		expect(config.beta_release).toEqual(parseBetaReleaseConfig(value));
	}
	await expect(
		new ConfigLoader(
			async () => `${base}beta_release: {interval_hours: 0}`,
		).load("/project"),
	).rejects.toThrow("beta_release.interval_hours");
	await expect(
		new ConfigLoader(async () => `${base}beta_release: null`).load("/project"),
	).rejects.toThrow("beta_release");
});

it("accepts only the two source policies without echoing invalid inputs", () => {
	for (const source_commit of ["default_branch_head", "local_deployed_sha"]) {
		expect(parseBetaReleaseConfig({ source_commit })).toEqual({
			interval_hours: 24,
			source_commit,
		});
	}
	for (const source_commit of [
		1,
		"main",
		null,
		"",
		"private-secret",
		undefined,
	]) {
		expect(() => parseBetaReleaseConfig({ source_commit })).toThrow(
			"beta_release.source_commit must be default_branch_head or local_deployed_sha",
		);
	}
});
