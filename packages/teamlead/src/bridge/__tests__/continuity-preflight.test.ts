import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ContinuityGh,
	type ContinuityGit,
	lookupOpenPullRequests,
	materializeRemoteBranch,
} from "../continuity-preflight.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

describe("FLY-1718 branch continuity materializer", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	it("fetches a remote-only branch object and returns a locally verified commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1718-continuity-"));
		roots.push(root);
		const origin = join(root, "origin.git");
		const seed = join(root, "seed");
		const target = join(root, "target");
		git(root, "init", "--bare", origin);
		git(root, "clone", origin, seed);
		git(seed, "config", "user.email", "flywheel@example.test");
		git(seed, "config", "user.name", "Flywheel Test");
		git(seed, "checkout", "-b", "main");
		execFileSync("sh", ["-c", "printf base > base.txt"], { cwd: seed });
		git(seed, "add", "base.txt");
		git(seed, "commit", "-m", "base");
		git(seed, "push", "-u", "origin", "main");
		git(root, "clone", "--branch", "main", origin, target);

		git(seed, "checkout", "-b", "flywheel-FLY-1718");
		execFileSync("sh", ["-c", "printf preserved > preserved.txt"], {
			cwd: seed,
		});
		git(seed, "add", "preserved.txt");
		git(seed, "commit", "-m", "preserved round one");
		const remoteTip = git(seed, "rev-parse", "HEAD");
		git(seed, "push", "-u", "origin", "flywheel-FLY-1718");

		expect(() =>
			git(target, "cat-file", "-e", `${remoteTip}^{commit}`),
		).toThrow();
		const result = await materializeRemoteBranch({
			repoPath: target,
			branch: "flywheel-FLY-1718",
		});

		expect(result).toEqual({ kind: "exists", sha: remoteTip });
		expect(
			git(
				target,
				"rev-parse",
				"refs/remotes/origin/flywheel-FLY-1718^{commit}",
			),
		).toBe(remoteTip);
		expect(git(target, "cat-file", "-e", `${remoteTip}^{commit}`)).toBe("");
		const continuedWorktree = join(root, "continued-worktree");
		git(
			target,
			"worktree",
			"add",
			"-b",
			"continued-copy",
			continuedWorktree,
			remoteTip,
		);
		expect(git(continuedWorktree, "rev-parse", "HEAD")).toBe(remoteTip);
		expect(git(continuedWorktree, "show", "HEAD:preserved.txt")).toBe(
			"preserved",
		);
	}, 15_000);

	it("returns missing only for ls-remote exit 2", async () => {
		const error = Object.assign(new Error("no matching ref"), { status: 2 });
		const runGit = vi.fn<ContinuityGit>().mockRejectedValue(error);
		await expect(
			materializeRemoteBranch(
				{ repoPath: "/repo", branch: "branch" },
				{ runGit },
			),
		).resolves.toEqual({ kind: "missing" });
		expect(runGit).toHaveBeenCalledTimes(1);
	});

	it("re-probes once when the remote ref moves during fetch", async () => {
		const a = "a".repeat(40);
		const b = "b".repeat(40);
		const outputs = [
			`${a}\trefs/heads/branch\n`,
			"",
			`${b}\n`,
			"",
			`${b}\trefs/heads/branch\n`,
			"",
			`${b}\n`,
			"",
		];
		const runGit = vi.fn<ContinuityGit>(async () => ({
			stdout: outputs.shift() ?? "",
		}));

		await expect(
			materializeRemoteBranch(
				{ repoPath: "/repo", branch: "branch" },
				{ runGit },
			),
		).resolves.toEqual({ kind: "exists", sha: b });
		expect(runGit).toHaveBeenCalledTimes(8);
	});

	it("fails closed when the ref keeps moving", async () => {
		const a = "a".repeat(40);
		const b = "b".repeat(40);
		const c = "c".repeat(40);
		const d = "d".repeat(40);
		const outputs = [
			`${a}\trefs/heads/branch\n`,
			"",
			`${b}\n`,
			"",
			`${c}\trefs/heads/branch\n`,
			"",
			`${d}\n`,
			"",
		];
		const runGit = vi.fn<ContinuityGit>(async () => ({
			stdout: outputs.shift() ?? "",
		}));

		const result = await materializeRemoteBranch(
			{ repoPath: "/repo", branch: "branch" },
			{ runGit },
		);
		expect(result.kind).toBe("indeterminate");
		if (result.kind === "indeterminate") {
			expect(result.error).toContain("moved during materialization");
		}
	});

	it("holds the shared repo mutation lock across probe, fetch, and verification", async () => {
		const sha = "a".repeat(40);
		let lockHeld = false;
		const runGit = vi.fn<ContinuityGit>(async () => {
			expect(lockHeld).toBe(true);
			const call = runGit.mock.calls.length;
			return {
				stdout:
					call === 1
						? `${sha}\trefs/heads/branch\n`
						: call === 3
							? `${sha}\n`
							: "",
			};
		});
		const withRepoLock = vi.fn(
			async (_repo: string, fn: () => Promise<unknown>) => {
				lockHeld = true;
				try {
					return await fn();
				} finally {
					lockHeld = false;
				}
			},
		);

		await expect(
			materializeRemoteBranch(
				{ repoPath: "/repo", branch: "branch" },
				{ runGit, withRepoLock },
			),
		).resolves.toEqual({ kind: "exists", sha });
		expect(withRepoLock).toHaveBeenCalledOnce();
	});

	it("classifies every non-missing git failure as indeterminate", async () => {
		const error = Object.assign(new Error("remote offline"), { status: 128 });
		const result = await materializeRemoteBranch(
			{ repoPath: "/repo", branch: "branch" },
			{ runGit: vi.fn<ContinuityGit>().mockRejectedValue(error) },
		);
		expect(result.kind).toBe("indeterminate");
		if (result.kind === "indeterminate") {
			expect(result.error).toContain("remote offline");
		}
	});

	it("enriches from open PRs with one bounded gh request and newest-first ordering", async () => {
		const runGit = vi.fn<ContinuityGit>(async (args) => ({
			stdout:
				args[0] === "remote"
					? "git@github.com:xrliAnnie/flywheel.git\n"
					: "origin/main\n",
		}));
		const runGh = vi.fn<ContinuityGh>(async () => ({
			stdout: JSON.stringify([
				{
					number: 812,
					html_url: "https://github.test/pull/812",
					updated_at: "2026-08-11T00:00:00Z",
				},
				{
					number: 813,
					html_url: "https://github.test/pull/813",
					updated_at: "2026-08-12T00:00:00Z",
				},
			]),
		}));

		await expect(
			lookupOpenPullRequests(
				{ repoPath: "/repo", branch: "flywheel-FLY-1718" },
				{ runGit, runGh },
			),
		).resolves.toEqual([
			{
				number: 813,
				url: "https://github.test/pull/813",
				updatedAt: "2026-08-12T00:00:00Z",
			},
			{
				number: 812,
				url: "https://github.test/pull/812",
				updatedAt: "2026-08-11T00:00:00Z",
			},
		]);
		expect(runGh).toHaveBeenCalledOnce();
		expect(runGh.mock.calls[0]?.[0]).toEqual([
			"api",
			"--method",
			"GET",
			"repos/xrliAnnie/flywheel/pulls",
			"-f",
			"head=xrliAnnie:flywheel-FLY-1718",
			"-f",
			"base=main",
			"-f",
			"state=open",
		]);
	});

	it("treats PR lookup failure as non-blocking enrichment loss", async () => {
		await expect(
			lookupOpenPullRequests(
				{ repoPath: "/repo", branch: "branch" },
				{
					runGit: vi.fn<ContinuityGit>(async () => ({
						stdout: "https://github.com/o/r.git\n",
					})),
					runGh: vi
						.fn<ContinuityGh>()
						.mockRejectedValue(new Error("gh unavailable")),
				},
			),
		).resolves.toEqual([]);
	});
});
