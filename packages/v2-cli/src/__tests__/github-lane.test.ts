import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseCliArgs } from "../cli.js";
import {
	GhCliLanePort,
	type GitHubLanePort,
	probeGitHubLane,
} from "../github-lane.js";

function port(overrides: Partial<GitHubLanePort> = {}): GitHubLanePort {
	return {
		actor: async () => "runner-bot",
		permission: async () => "write",
		branchProtection: async () => ({
			requiredApprovingReviewCount: 1,
			requiredChecks: ["lint"],
			bypassUsers: [],
			bypassTeamCount: 0,
			bypassAppCount: 0,
		}),
		activeRules: async () => ({
			requiredChecks: ["build"],
			applicableRulesetIds: [41],
			bypassActorCount: 0,
		}),
		...overrides,
	};
}

describe("GitHub lane probe", () => {
	it("parses as an evidence-only command without host IPC authority", () => {
		expect(
			parseCliArgs([
				"probe-github-lane",
				"--repo",
				"owner/repo",
				"--branch",
				"main",
				"--output",
				"/tmp/github-lane.json",
			]),
		).toMatchObject({
			verb: "probe-github-lane",
		});
	});

	it("keeps DAG mutations on the open-existing database contract", () => {
		expect(
			parseCliArgs([
				"admit",
				"--db",
				"/tmp/v2.db",
				"--marker",
				"/tmp/migration.json",
				"--authority",
				"/tmp/authority.json",
				"--armed",
				"/tmp/armed.json",
				"--window",
				"window-1",
				"--epoch",
				"1",
				"--host-epoch",
				"host-1",
				"--lock-root",
				"/tmp/locks",
				"--request-file",
				"/tmp/admission.json",
			]),
		).toMatchObject({ verb: "admit" });
		expect(() => parseCliArgs(["admit", "--db", "/tmp/v2.db"])).toThrow(
			/--marker is required/,
		);
	});

	it("passes only a non-admin, non-bypass actor with required checks", async () => {
		await expect(
			probeGitHubLane(port(), {
				repo: "owner/repo",
				branch: "main",
				observedAt: "2026-07-28T00:00:00.000Z",
			}),
		).resolves.toMatchObject({
			status: "pass",
			actor: "runner-bot",
			permission: "write",
			requiredChecks: ["build", "lint"],
		});
	});

	it.each([
		["admin", port({ permission: async () => "admin" }), "admin"],
		[
			"empty checks",
			port({
				branchProtection: async () => ({
					requiredApprovingReviewCount: 1,
					requiredChecks: [],
					bypassUsers: [],
					bypassTeamCount: 0,
					bypassAppCount: 0,
				}),
				activeRules: async () => ({
					requiredChecks: [],
					applicableRulesetIds: [],
					bypassActorCount: 0,
				}),
			}),
			"required checks",
		],
		[
			"classic actor bypass",
			port({
				branchProtection: async () => ({
					requiredApprovingReviewCount: 1,
					requiredChecks: ["lint"],
					bypassUsers: ["runner-bot"],
					bypassTeamCount: 0,
					bypassAppCount: 0,
				}),
			}),
			"bypass",
		],
		[
			"ruleset bypass",
			port({
				activeRules: async () => ({
					requiredChecks: ["build"],
					applicableRulesetIds: [41],
					bypassActorCount: 1,
				}),
			}),
			"bypass",
		],
	])("fails closed for %s", async (_label, github, reason) => {
		const result = await probeGitHubLane(github, {
			repo: "owner/repo",
			branch: "main",
			observedAt: "2026-07-28T00:00:00.000Z",
		});
		expect(result.status).toBe("fail");
		expect(result.failures.join(" ")).toMatch(new RegExp(reason, "i"));
	});

	it("turns unknown API evidence into a fail-closed report", async () => {
		const result = await probeGitHubLane(
			port({
				activeRules: async () => {
					throw new Error("403");
				},
			}),
			{
				repo: "owner/repo",
				branch: "main",
				observedAt: "2026-07-28T00:00:00.000Z",
			},
		);
		expect(result).toMatchObject({ status: "fail" });
		expect(result.failures.join(" ")).toMatch(/unavailable|403/);
	});
});

interface GhSpy {
	ghBin: string;
	calls(): {
		path: string;
		ghConfigDir: string;
		ghToken: string;
		githubToken: string;
	}[];
}

function fakeGh(): GhSpy {
	const dir = mkdtempSync(join(tmpdir(), "gh-lane-spy-"));
	const logPath = join(dir, "calls.log");
	const ghBin = join(dir, "gh");
	writeFileSync(
		ghBin,
		`#!/bin/sh
printf '%s|%s|%s|%s\\n' "$2" "\${GH_CONFIG_DIR-unset}" "\${GH_TOKEN-unset}" "\${GITHUB_TOKEN-unset}" >> "${logPath}"
case "$2" in
user) printf '%s' '{"login":"runner-bot"}' ;;
*/permission) printf '%s' '{"permission":"write"}' ;;
*/protection) printf '%s' '{"required_pull_request_reviews":{"required_approving_review_count":1},"required_status_checks":{"contexts":["ci"],"checks":[]}}' ;;
*/rules/branches/*) printf '%s' '[{"type":"required_status_checks","ruleset_id":41,"parameters":{"required_status_checks":[{"context":"build"}]}}]' ;;
*/rulesets/*) printf '%s' '{"bypass_actors":[]}' ;;
*) printf '%s' '{}' ;;
esac
`,
		{ mode: 0o755 },
	);
	return {
		ghBin,
		calls: () =>
			readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => {
					const [path = "", ghConfigDir = "", ghToken = "", githubToken = ""] =
						line.split("|");
					return { path, ghConfigDir, ghToken, githubToken };
				}),
	};
}

const inheritedGhConfigDir = () => process.env.GH_CONFIG_DIR ?? "unset";
const inheritedGhToken = () => process.env.GH_TOKEN ?? "unset";
const inheritedGithubToken = () => process.env.GITHUB_TOKEN ?? "unset";

function inheritedCall(path: string) {
	return {
		path,
		ghConfigDir: inheritedGhConfigDir(),
		ghToken: inheritedGhToken(),
		githubToken: inheritedGithubToken(),
	};
}

describe("policy reader identity", () => {
	it("accepts --policy-gh-config-dir as a probe-only flag", () => {
		const parsed = parseCliArgs([
			"probe-github-lane",
			"--repo",
			"owner/repo",
			"--branch",
			"main",
			"--output",
			"/tmp/github-lane.json",
			"--policy-gh-config-dir",
			"/tmp/gh-policy",
		]);
		expect(parsed.values.get("--policy-gh-config-dir")).toBe("/tmp/gh-policy");
	});

	it("rejects a relative --policy-gh-config-dir before probing", async () => {
		await expect(
			main([
				"probe-github-lane",
				"--repo",
				"owner/repo",
				"--branch",
				"main",
				"--output",
				"/tmp/github-lane.json",
				"--policy-gh-config-dir",
				"relative/dir",
			]),
		).rejects.toThrow(/--policy-gh-config-dir must be absolute/);
	});

	it("rejects a non-absolute or blank policy reader config dir", () => {
		expect(() => new GhCliLanePort("gh", "relative/dir")).toThrow(/absolute/);
		expect(() => new GhCliLanePort("gh", "   ")).toThrow(/absolute/);
	});

	it("uses the policy reader identity only for branch protection", async () => {
		const spy = fakeGh();
		const policyDir = "/tmp/gh-policy-reader";
		const port = new GhCliLanePort(spy.ghBin, policyDir);
		await port.actor();
		await port.permission("owner/repo", "runner-bot");
		await port.branchProtection("owner/repo", "main");
		await port.activeRules("owner/repo", "main");
		expect(spy.calls()).toEqual([
			inheritedCall("user"),
			inheritedCall("repos/owner/repo/collaborators/runner-bot/permission"),
			{
				path: "repos/owner/repo/branches/main/protection",
				ghConfigDir: policyDir,
				ghToken: "unset",
				githubToken: "unset",
			},
			inheritedCall("repos/owner/repo/rules/branches/main"),
			inheritedCall("repos/owner/repo/rulesets/41?includes_parents=true"),
		]);
	});

	it("strips ambient token env vars from the policy read only", async () => {
		const spy = fakeGh();
		const policyDir = "/tmp/gh-policy-reader";
		const saved = {
			GH_TOKEN: process.env.GH_TOKEN,
			GITHUB_TOKEN: process.env.GITHUB_TOKEN,
		};
		process.env.GH_TOKEN = "probe-token";
		process.env.GITHUB_TOKEN = "probe-token-alias";
		try {
			const port = new GhCliLanePort(spy.ghBin, policyDir);
			await port.actor();
			await port.branchProtection("owner/repo", "main");
		} finally {
			for (const key of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
		expect(spy.calls()).toEqual([
			{
				path: "user",
				ghConfigDir: inheritedGhConfigDir(),
				ghToken: "probe-token",
				githubToken: "probe-token-alias",
			},
			{
				path: "repos/owner/repo/branches/main/protection",
				ghConfigDir: policyDir,
				ghToken: "unset",
				githubToken: "unset",
			},
		]);
	});

	it("keeps the default identity everywhere when no policy reader is set", async () => {
		const spy = fakeGh();
		const port = new GhCliLanePort(spy.ghBin);
		await port.branchProtection("owner/repo", "main");
		expect(spy.calls()).toEqual([
			inheritedCall("repos/owner/repo/branches/main/protection"),
		]);
	});

	it("wires --policy-gh-config-dir through the CLI to the protection call only", async () => {
		const spy = fakeGh();
		const output = join(
			mkdtempSync(join(tmpdir(), "gh-lane-out-")),
			"lane.json",
		);
		const policyDir = "/tmp/gh-policy-reader-cli";
		const code = await main([
			"probe-github-lane",
			"--repo",
			"owner/repo",
			"--branch",
			"main",
			"--output",
			output,
			"--gh-bin",
			spy.ghBin,
			"--policy-gh-config-dir",
			policyDir,
		]);
		expect(code).toBe(0);
		expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
			status: "pass",
			actor: "runner-bot",
			permission: "write",
			requiredChecks: ["build", "ci"],
		});
		const protectionCalls = spy
			.calls()
			.filter((call) => call.path.endsWith("/protection"));
		expect(protectionCalls).toEqual([
			{
				path: "repos/owner/repo/branches/main/protection",
				ghConfigDir: policyDir,
				ghToken: "unset",
				githubToken: "unset",
			},
		]);
		for (const call of spy.calls()) {
			if (!call.path.endsWith("/protection")) {
				expect(call.ghConfigDir).not.toBe(policyDir);
			}
		}
	});
});
