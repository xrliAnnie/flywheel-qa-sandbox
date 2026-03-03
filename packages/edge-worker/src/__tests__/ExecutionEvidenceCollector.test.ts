import { describe, expect, it, vi } from "vitest";
import { ExecutionEvidenceCollector } from "../ExecutionEvidenceCollector.js";
import type { ExecFileFn, GitCheckResult } from "../GitResultChecker.js";

// ─── Helpers ─────────────────────────────────────

function makeGitResult(
	overrides: Partial<GitCheckResult> = {},
): GitCheckResult {
	return {
		hasNewCommits: true,
		commitCount: 2,
		filesChanged: 3,
		commitMessages: ["feat: add auth", "test: add auth tests"],
		...overrides,
	};
}

function makeMockExec(responses: Record<string, string> = {}): ExecFileFn {
	return vi.fn(async (_cmd: string, args: string[], _cwd: string) => {
		const joined = args.join(" ");

		if (joined.includes("--name-only")) {
			return { stdout: responses["name-only"] ?? "src/auth.ts\nsrc/auth.test.ts\nsrc/index.ts\n" };
		}
		if (joined.includes("--numstat")) {
			return { stdout: responses["numstat"] ?? "80\t5\tsrc/auth.ts\n30\t0\tsrc/auth.test.ts\n10\t0\tsrc/index.ts\n" };
		}
		if (joined.includes("rev-parse")) {
			return { stdout: responses["rev-parse"] ?? "abc123def456\n" };
		}
		if (joined.includes("diff") && !joined.includes("--")) {
			return { stdout: responses["diff"] ?? "diff --git a/src/auth.ts b/src/auth.ts\n+code here\n" };
		}

		return { stdout: "" };
	});
}

function makeFailingExec(failOn: string[]): ExecFileFn {
	return vi.fn(async (_cmd: string, args: string[], _cwd: string) => {
		const joined = args.join(" ");

		for (const pattern of failOn) {
			if (joined.includes(pattern)) {
				throw new Error(`git command failed: ${pattern}`);
			}
		}

		if (joined.includes("--name-only")) {
			return { stdout: "src/auth.ts\n" };
		}
		if (joined.includes("--numstat")) {
			return { stdout: "80\t5\tsrc/auth.ts\n" };
		}
		if (joined.includes("rev-parse")) {
			return { stdout: "abc123\n" };
		}
		if (joined.includes("diff")) {
			return { stdout: "diff output\n" };
		}

		return { stdout: "" };
	});
}

// ─── Tests ───────────────────────────────────────

describe("ExecutionEvidenceCollector", () => {
	it("returns complete evidence from git commands", async () => {
		const exec = makeMockExec();
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			45000,
		);

		expect(evidence.commitCount).toBe(2);
		expect(evidence.filesChangedCount).toBe(3);
		expect(evidence.commitMessages).toEqual([
			"feat: add auth",
			"test: add auth tests",
		]);
		expect(evidence.changedFilePaths).toEqual([
			"src/auth.ts",
			"src/auth.test.ts",
			"src/index.ts",
		]);
		expect(evidence.linesAdded).toBe(120);
		expect(evidence.linesRemoved).toBe(5);
		expect(evidence.diffSummary).toContain("diff --git");
		expect(evidence.headSha).toBe("abc123def456");
		expect(evidence.partial).toBe(false);
		expect(evidence.durationMs).toBe(45000);
	});

	it("commitCount/filesChangedCount come from GitCheckResult (not re-queried)", async () => {
		const exec = makeMockExec();
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult({ commitCount: 5, filesChanged: 10 }),
			1000,
		);

		expect(evidence.commitCount).toBe(5);
		expect(evidence.filesChangedCount).toBe(10);
	});

	it("parses changedFilePaths correctly (newline splitting, empty filter)", async () => {
		const exec = makeMockExec({
			"name-only": "src/a.ts\n\nsrc/b.ts\n",
		});
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			1000,
		);

		expect(evidence.changedFilePaths).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("sums linesAdded/linesRemoved from --numstat", async () => {
		const exec = makeMockExec({
			numstat: "10\t2\tfile1.ts\n20\t3\tfile2.ts\n",
		});
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			1000,
		);

		expect(evidence.linesAdded).toBe(30);
		expect(evidence.linesRemoved).toBe(5);
	});

	it("binary files in --numstat counted as 0", async () => {
		const exec = makeMockExec({
			numstat: "10\t2\tfile1.ts\n-\t-\timage.png\n5\t1\tfile2.ts\n",
		});
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			1000,
		);

		expect(evidence.linesAdded).toBe(15);
		expect(evidence.linesRemoved).toBe(3);
	});

	it("diffSummary truncated to 2000 chars", async () => {
		const longDiff = "x".repeat(5000);
		const exec = makeMockExec({ diff: longDiff });
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			1000,
		);

		expect(evidence.diffSummary.length).toBe(2000);
	});

	it("headSha trimmed", async () => {
		const exec = makeMockExec({ "rev-parse": "  abc123  \n" });
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			1000,
		);

		expect(evidence.headSha).toBe("abc123");
	});

	it("getChangedFiles failure → partial=true, changedFilePaths=[]", async () => {
		const exec = makeFailingExec(["--name-only"]);
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			1000,
		);

		expect(evidence.partial).toBe(true);
		expect(evidence.changedFilePaths).toEqual([]);
		// Other fields still populated
		expect(evidence.linesAdded).toBe(80);
	});

	it("getDiffStats failure → partial=true, lines=0", async () => {
		const exec = makeFailingExec(["--numstat"]);
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			1000,
		);

		expect(evidence.partial).toBe(true);
		expect(evidence.linesAdded).toBe(0);
		expect(evidence.linesRemoved).toBe(0);
	});

	it("getDiffSummary failure → partial=true, diffSummary=''", async () => {
		// "diff" without "--" would match both diff and --numstat, so target just "diff" alone
		const exec = vi.fn(async (_cmd: string, args: string[], _cwd: string) => {
			const joined = args.join(" ");
			if (joined.includes("--name-only")) return { stdout: "file.ts\n" };
			if (joined.includes("--numstat")) return { stdout: "10\t2\tfile.ts\n" };
			if (joined.includes("rev-parse")) return { stdout: "abc123\n" };
			// Plain diff (no --name-only, no --numstat)
			if (joined.includes("diff") && !joined.includes("--name") && !joined.includes("--num")) {
				throw new Error("diff failed");
			}
			return { stdout: "" };
		});
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			1000,
		);

		expect(evidence.partial).toBe(true);
		expect(evidence.diffSummary).toBe("");
	});

	it("all best-effort fields fail → partial=true, required fields intact", async () => {
		const exec = makeFailingExec(["--name-only", "--numstat", "rev-parse", "diff"]);
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult({ commitCount: 3, filesChanged: 5 }),
			2000,
		);

		expect(evidence.partial).toBe(true);
		expect(evidence.commitCount).toBe(3);
		expect(evidence.filesChangedCount).toBe(5);
		expect(evidence.commitMessages).toEqual([
			"feat: add auth",
			"test: add auth tests",
		]);
		expect(evidence.changedFilePaths).toEqual([]);
		expect(evidence.linesAdded).toBe(0);
		expect(evidence.linesRemoved).toBe(0);
		expect(evidence.diffSummary).toBe("");
		expect(evidence.headSha).toBeNull();
	});

	it("durationMs passed through", async () => {
		const exec = makeMockExec();
		const collector = new ExecutionEvidenceCollector(exec);

		const evidence = await collector.collect(
			"/repo",
			"base123",
			makeGitResult(),
			99999,
		);

		expect(evidence.durationMs).toBe(99999);
	});
});
