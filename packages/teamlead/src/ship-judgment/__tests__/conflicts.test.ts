import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFileConflicts, checkGitMerge } from "../conflicts.js";

const HEAD = "a".repeat(40);
const pr = (repo: string, number: number, path: string) => ({
	repo_identity: repo,
	pr_number: number,
	head_sha: HEAD,
	filesComplete: true,
	files: [{ path }],
});

describe("ship judgment mechanical conflicts", () => {
	it("detects both rename paths in the same repository, excludes own PRs and separates repositories", () => {
		const target = pr("main", 1, "new.ts");
		const own = pr("main", 1, "new.ts");
		expect(
			checkFileConflicts([target], [own, pr("other", 2, "new.ts")], true),
		).toMatchObject({ verdict: "pass", overlaps: [] });
		const renamed = {
			...target,
			files: [{ path: "new.ts", previous_path: "old.ts" }],
		};
		expect(
			checkFileConflicts([renamed], [pr("main", 2, "old.ts")], true),
		).toMatchObject({
			verdict: "fail",
			overlaps: [{ repo_identity: "main", pr_number: 2, path: "old.ts" }],
		});
		expect(
			checkFileConflicts(
				[target],
				[
					{
						...pr("main", 3, "else.ts"),
						files: [{ path: "else.ts", previous_path: "new.ts" }],
					},
				],
				true,
			).verdict,
		).toBe("fail");
	});
	it("does not interpret incomplete pagination, missing files or oversized inventories as clean", () => {
		const target = pr("main", 1, "a.ts");
		expect(checkFileConflicts([target], [], false)).toMatchObject({
			verdict: "undetermined",
			openPrCount: null,
		});
		expect(
			checkFileConflicts(
				[target],
				[{ ...target, head_sha: "b".repeat(40) }],
				true,
			).verdict,
		).toBe("undetermined");
		expect(
			checkFileConflicts(
				[target],
				[{ ...pr("main", 2, "b.ts"), filesComplete: false }],
				true,
			).verdict,
		).toBe("undetermined");
		expect(checkFileConflicts([], [], true).verdict).toBe("undetermined");
		expect(
			checkFileConflicts(
				[target],
				Array.from({ length: 201 }, (_, n) => pr("main", n + 2, "b.ts")),
				true,
			).verdict,
		).toBe("undetermined");
		expect(checkFileConflicts([target], [], true)).toMatchObject({
			verdict: "pass",
			openPrCount: 0,
		});
		expect(
			checkFileConflicts([target], [pr("main", 2, "../a.ts")], true).verdict,
		).toBe("undetermined");
	});
	it("runs a real merge-tree in an isolated bare repo and distinguishes conflicts from missing objects", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ship-conflict-"));
		const work = join(dir, "work");
		const bare = join(dir, "probe.git");
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		try {
			git("init", "-q", "-b", "main", work);
			git("-C", work, "config", "user.email", "fixture@example.invalid");
			git("-C", work, "config", "user.name", "Fixture");
			writeFileSync(join(work, "a.txt"), "base\n");
			git("-C", work, "add", ".");
			git("-C", work, "commit", "-qm", "base");
			const base = git("-C", work, "rev-parse", "HEAD");
			git("-C", work, "checkout", "-qb", "feature");
			writeFileSync(join(work, "a.txt"), "feature\n");
			git("-C", work, "commit", "-qam", "feature");
			const feature = git("-C", work, "rev-parse", "HEAD");
			git("-C", work, "checkout", "-q", "main");
			writeFileSync(join(work, "a.txt"), "main\n");
			git("-C", work, "commit", "-qam", "main");
			const main = git("-C", work, "rev-parse", "HEAD");
			git("clone", "--bare", "-q", work, bare);
			expect(
				await checkGitMerge({ gitDir: bare, mainSha: base, headSha: feature }),
			).toMatchObject({ verdict: "pass" });
			expect(
				await checkGitMerge({ gitDir: bare, mainSha: main, headSha: feature }),
			).toMatchObject({ verdict: "fail" });
			expect(
				await checkGitMerge({
					gitDir: bare,
					mainSha: base,
					headSha: feature,
					targetBaseSha: main,
				}),
			).toMatchObject({ verdict: "fail" });
			expect(
				await checkGitMerge({
					gitDir: bare,
					mainSha: "f".repeat(40),
					headSha: feature,
				}),
			).toMatchObject({ verdict: "undetermined" });
			expect(
				await checkGitMerge({ gitDir: work, mainSha: main, headSha: feature }),
			).toMatchObject({ verdict: "undetermined" });
			expect(git("-C", work, "rev-parse", "HEAD")).toBe(main);
			expect(git("-C", work, "status", "--porcelain")).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
