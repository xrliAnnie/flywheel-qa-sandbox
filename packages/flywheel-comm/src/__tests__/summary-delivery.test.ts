import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SummaryDeliveryInput } from "../commands/summary.js";
import { createGitHubSummaryDelivery } from "../summary-delivery.js";

const content = `---
project: flywheel
lead: eng-lead
period: 2026-08-21/2026-08-28
---
## Facts
FLY-2030 entered implementation.
## Judgment
The inflow contract is the critical path.
`;

function input(
	overrides: Partial<SummaryDeliveryInput> = {},
): SummaryDeliveryInput {
	return {
		repo: "xrliAnnie/raya",
		project: "flywheel",
		author: "eng-lead",
		period: "2026-08-21/2026-08-28",
		granularity: "per-lead",
		assignmentDigest: "a".repeat(64),
		content,
		...overrides,
	};
}

describe("GitHub summary delivery adapter", () => {
	it("inspects the stable idempotency branch across every PR state", async () => {
		const run = vi.fn((_command: string, args: string[]) => {
			const branch = args[args.indexOf("--head") + 1]!;
			return JSON.stringify([
				{
					number: 7,
					state: "OPEN",
					mergedAt: null,
					headRefName: branch,
					url: "https://github.com/xrliAnnie/raya/pull/7",
				},
			]);
		});
		const delivery = createGitHubSummaryDelivery({ run });

		await expect(delivery.inspect(input())).resolves.toMatchObject({
			state: "open",
			prNumber: 7,
		});
		expect(run).toHaveBeenCalledOnce();
		expect(run.mock.calls[0]![1]).toEqual(
			expect.arrayContaining(["--state", "all", "--head"]),
		);
	});

	it("creates one 100644 artifact and uses a non-force create-only push", async () => {
		const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
		const run = vi.fn((command: string, args: string[], cwd?: string) => {
			calls.push({ command, args, cwd });
			if (command === "gh" && args[0] === "repo" && args[1] === "view") {
				return "main\n";
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "list") {
				return "[]";
			}
			if (command === "gh" && args[0] === "repo" && args[1] === "clone") {
				const repoDir = args[3]!;
				mkdirSync(join(repoDir, "summaries", "flywheel"), { recursive: true });
				writeFileSync(
					join(
						repoDir,
						"summaries",
						"flywheel",
						"2026-08-28--other-lead--01.md",
					),
					"prior",
				);
				return "";
			}
			if (command === "git" && args.includes("commit")) {
				const target = join(
					cwd!,
					"summaries",
					"flywheel",
					"2026-08-28--eng-lead--01.md",
				);
				expect(statSync(target).mode & 0o777).toBe(0o644);
				return "";
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "create") {
				return "https://github.com/xrliAnnie/raya/pull/9\n";
			}
			return "";
		});
		const delivery = createGitHubSummaryDelivery({ run });

		await expect(delivery.create(input())).resolves.toEqual({
			prNumber: 9,
			url: "https://github.com/xrliAnnie/raya/pull/9",
			path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
		});
		const push = calls.find(
			(call) => call.command === "git" && call.args[0] === "push",
		);
		expect(push?.args).not.toContain("--force");
		expect(push?.args[2]).toMatch(
			/^HEAD:refs\/heads\/summary\/flywheel\/eng-lead\//,
		);
	});

	it("allocates after same-author unread PR paths that are absent from main", async () => {
		const period = "2026-08-28T06:00:00Z/2026-08-28T12:00:00Z";
		const run = vi.fn((command: string, args: string[]) => {
			if (command === "gh" && args[0] === "repo" && args[1] === "view") {
				return "main\n";
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "list") {
				return JSON.stringify([
					{
						number: 8,
						state: "OPEN",
						mergedAt: null,
						headRefName: "summary/flywheel/eng-lead/prior",
						url: "https://github.com/xrliAnnie/raya/pull/8",
						files: [
							{
								path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
							},
						],
					},
				]);
			}
			if (command === "gh" && args[0] === "repo" && args[1] === "clone") {
				mkdirSync(args[3]!, { recursive: true });
				return "";
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "create") {
				return "https://github.com/xrliAnnie/raya/pull/9\n";
			}
			return "";
		});
		const delivery = createGitHubSummaryDelivery({ run });

		await expect(
			delivery.create(
				input({
					period,
					content: content.replace("2026-08-21/2026-08-28", period),
				}),
			),
		).resolves.toMatchObject({
			path: "summaries/flywheel/2026-08-28--eng-lead--02.md",
		});
	});

	it("fails closed if an open summary branch contains a symlink", async () => {
		const run = vi.fn((command: string, args: string[]) => {
			if (command === "gh" && args[0] === "repo" && args[1] === "clone") {
				const repoDir = args[3]!;
				mkdirSync(join(repoDir, "summaries", "flywheel"), { recursive: true });
				symlinkSync(
					"/tmp/outside",
					join(repoDir, "summaries", "flywheel", "unsafe-link"),
				);
			}
			return "";
		});
		const delivery = createGitHubSummaryDelivery({ run });

		await expect(
			delivery.update(
				input({
					existing: {
						state: "open",
						prNumber: 7,
						url: "https://github.com/xrliAnnie/raya/pull/7",
						branch: "summary/flywheel/eng-lead/stable",
					},
				}),
			),
		).rejects.toThrow(/symlink/);
	});
});
