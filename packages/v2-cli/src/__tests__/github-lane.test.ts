import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli.js";
import { type GitHubLanePort, probeGitHubLane } from "../github-lane.js";

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
