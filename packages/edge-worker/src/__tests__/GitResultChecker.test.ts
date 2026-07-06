import { describe, expect, it } from "vitest";
import type { ExecFileFn } from "../GitResultChecker.js";
import { GitResultChecker } from "../GitResultChecker.js";

// ─── Helpers ─────────────────────────────────────

function makeMockExec(responses: Record<string, string> = {}): {
	fn: ExecFileFn;
	calls: Array<{ args: string[] }>;
} {
	const calls: Array<{ args: string[] }> = [];
	const fn: ExecFileFn = async (_cmd: string, args: string[], _cwd: string) => {
		calls.push({ args });

		// Match on git subcommand + key args
		const argsStr = args.join(" ");

		if (argsStr.includes("status --porcelain")) {
			return { stdout: responses.status ?? "" };
		}
		if (argsStr.includes("rev-parse HEAD")) {
			return { stdout: responses["rev-parse"] ?? "abc123\n" };
		}
		if (argsStr.includes("rev-list --count")) {
			return { stdout: responses["rev-list"] ?? "0\n" };
		}
		if (argsStr.includes("log --format=%s")) {
			return { stdout: responses.log ?? "" };
		}
		if (argsStr.includes("diff --shortstat")) {
			return { stdout: responses.diff ?? "" };
		}

		return { stdout: "" };
	};

	return { fn, calls };
}

// ─── Tests ───────────────────────────────────────

describe("GitResultChecker", () => {
	// ─── assertCleanTree ────────────────────────────

	describe("assertCleanTree", () => {
		it("passes on clean tree", async () => {
			const { fn } = makeMockExec({ status: "" });
			const checker = new GitResultChecker(fn);

			await expect(
				checker.assertCleanTree("/project"),
			).resolves.toBeUndefined();
		});

		it("throws on staged files", async () => {
			const { fn } = makeMockExec({ status: "M  src/index.ts" });
			const checker = new GitResultChecker(fn);

			await expect(checker.assertCleanTree("/project")).rejects.toThrow(
				"Git working tree is not clean",
			);
		});

		it("throws on untracked files", async () => {
			const { fn } = makeMockExec({ status: "?? newfile.ts" });
			const checker = new GitResultChecker(fn);

			await expect(checker.assertCleanTree("/project")).rejects.toThrow(
				"Git working tree is not clean",
			);
		});
	});

	// ─── captureBaseline ────────────────────────────

	describe("captureBaseline", () => {
		it("returns current HEAD SHA", async () => {
			const { fn } = makeMockExec({ "rev-parse": "abc123def456\n" });
			const checker = new GitResultChecker(fn);

			const sha = await checker.captureBaseline("/project");

			expect(sha).toBe("abc123def456");
		});

		it("trims whitespace from SHA", async () => {
			const { fn } = makeMockExec({ "rev-parse": "  sha123  \n" });
			const checker = new GitResultChecker(fn);

			const sha = await checker.captureBaseline("/project");

			expect(sha).toBe("sha123");
		});
	});

	// ─── check ──────────────────────────────────────

	describe("check", () => {
		it("detects new commits", async () => {
			const { fn } = makeMockExec({
				"rev-list": "3\n",
				log: "feat: add auth\nfix: typo\ntest: add tests\n",
				diff: " 5 files changed, 100 insertions(+), 20 deletions(-)\n",
			});
			const checker = new GitResultChecker(fn);

			const result = await checker.check("/project", "abc123");

			expect(result.hasNewCommits).toBe(true);
			expect(result.commitCount).toBe(3);
			expect(result.commitMessages).toEqual([
				"feat: add auth",
				"fix: typo",
				"test: add tests",
			]);
			expect(result.filesChanged).toBe(5);
		});

		it("returns no changes when baseSha === HEAD", async () => {
			const { fn } = makeMockExec({
				"rev-list": "0\n",
				log: "",
				diff: "",
			});
			const checker = new GitResultChecker(fn);

			const result = await checker.check("/project", "abc123");

			expect(result.hasNewCommits).toBe(false);
			expect(result.commitCount).toBe(0);
			expect(result.commitMessages).toEqual([]);
			expect(result.filesChanged).toBe(0);
		});

		it("handles single commit", async () => {
			const { fn } = makeMockExec({
				"rev-list": "1\n",
				log: "fix: resolve issue\n",
				diff: " 1 file changed, 5 insertions(+)\n",
			});
			const checker = new GitResultChecker(fn);

			const result = await checker.check("/project", "abc123");

			expect(result.hasNewCommits).toBe(true);
			expect(result.commitCount).toBe(1);
			expect(result.commitMessages).toEqual(["fix: resolve issue"]);
			expect(result.filesChanged).toBe(1);
		});

		it("handles diff with only deletions", async () => {
			const { fn } = makeMockExec({
				"rev-list": "1\n",
				log: "refactor: remove dead code\n",
				diff: " 3 files changed, 50 deletions(-)\n",
			});
			const checker = new GitResultChecker(fn);

			const result = await checker.check("/project", "abc123");

			expect(result.filesChanged).toBe(3);
		});

		it("returns 0 filesChanged when diff is empty", async () => {
			const { fn } = makeMockExec({
				"rev-list": "1\n",
				log: "chore: empty commit\n",
				diff: "",
			});
			const checker = new GitResultChecker(fn);

			const result = await checker.check("/project", "abc123");

			expect(result.filesChanged).toBe(0);
		});

		it("gracefully handles errors in rev-list", async () => {
			const fn: ExecFileFn = async (_cmd, args, _cwd) => {
				if (args.join(" ").includes("rev-list")) {
					throw new Error("bad revision");
				}
				return { stdout: "" };
			};
			const checker = new GitResultChecker(fn);

			const result = await checker.check("/project", "bad-sha");

			expect(result.hasNewCommits).toBe(false);
			expect(result.commitCount).toBe(0);
		});
	});
});
