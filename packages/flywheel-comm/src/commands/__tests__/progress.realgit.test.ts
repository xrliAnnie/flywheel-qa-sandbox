import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProgressDeps, runProgress } from "../progress.js";

/**
 * FLY-795 (code-review R2 HIGH): the mocked progress.test.ts stubbed `deps.git`
 * as always-success and therefore MISSED that `git commit --only -- <path>`
 * REJECTS an untracked path — so a fresh runner's FIRST progress.md never
 * committed and the feature stayed inert. This suite runs the LIVE git seam
 * against a real temp repo to prove the first (new) ledger AND a subsequent
 * update both commit, and that the commit stays path-limited (does not sweep
 * other staged code).
 */
describe("runProgress — real git (first-write + path-limited)", () => {
	let repo: string;

	function realDeps(): ProgressDeps {
		return {
			env: {},
			cwd: () => repo,
			readSession: () => ({
				status: "running",
				session_role: "implement",
				issue_identifier: "FLY-795",
				session_stage: "implement",
			}),
			latestActiveExecId: () => "e1",
			existsSync,
			readFileSync: (p) => readFileSync(p, "utf8"),
			writeTempAndRename: (absPath, content) => {
				mkdirSync(dirname(absPath), { recursive: true });
				const tmp = `${absPath}.tmp`;
				writeFileSync(tmp, content, "utf8");
				renameSync(tmp, absPath);
			},
			restoreFile: (absPath, content) => {
				if (content === null) rmSync(absPath, { force: true });
				else writeFileSync(absPath, content, "utf8");
			},
			git: (a) => {
				const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" });
				return {
					stdout: r.stdout ?? "",
					stderr: r.stderr ?? "",
					status: r.status ?? 1,
				};
			},
		};
	}

	const file = "engineering/doc/FLY-795-x/progress.md";
	const args = {
		execId: "e1",
		file,
		phase: "implement",
		cursor: "1/3",
		next: "first step",
	};

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "fly795-realgit-"));
		const git = (a: string[]) => execFileSync("git", a, { cwd: repo });
		git(["init", "-q"]);
		git(["config", "user.email", "t@t.dev"]);
		git(["config", "user.name", "t"]);
		mkdirSync(join(repo, "engineering", "doc", "FLY-795-x"), {
			recursive: true,
		});
		writeFileSync(join(repo, "seed.txt"), "seed\n");
		git(["add", "seed.txt"]);
		git(["commit", "-q", "-m", "seed"]);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("commits the FIRST (untracked) progress.md ledger", () => {
		const r = runProgress(args, realDeps());
		expect(r.ok, r.reason).toBe(true);
		// the file is now committed (tracked) on the branch
		const tracked = spawnSync("git", ["ls-files", "--error-unmatch", file], {
			cwd: repo,
		});
		expect(tracked.status).toBe(0);
		expect(readFileSync(join(repo, file), "utf8")).toContain(
			"phase: implement",
		);
		// nothing left dirty from the ledger write
		const status = spawnSync("git", ["status", "--porcelain", file], {
			cwd: repo,
			encoding: "utf8",
		});
		expect(status.stdout.trim()).toBe("");
	});

	it("updates an existing ledger on a second call", () => {
		expect(runProgress(args, realDeps()).ok).toBe(true);
		const r2 = runProgress(
			{ ...args, cursor: "2/3", next: "second step" },
			realDeps(),
		);
		expect(r2.ok, r2.reason).toBe(true);
		expect(readFileSync(join(repo, file), "utf8")).toContain(
			"phaseCursor: 2/3",
		);
		// exactly two progress commits exist
		const log = spawnSync("git", ["log", "--oneline", "--", file], {
			cwd: repo,
			encoding: "utf8",
		});
		expect(log.stdout.trim().split("\n").length).toBe(2);
	});

	it("is path-limited: does NOT sweep other staged code into the progress commit", () => {
		// stage an unrelated code change BEFORE writing progress
		writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
		execFileSync("git", ["add", "app.ts"], { cwd: repo });
		const r = runProgress(args, realDeps());
		expect(r.ok, r.reason).toBe(true);
		// the progress commit must contain ONLY progress.md
		const show = spawnSync(
			"git",
			["show", "--name-only", "--format=", "HEAD"],
			{ cwd: repo, encoding: "utf8" },
		);
		const files = show.stdout.trim().split("\n").filter(Boolean);
		expect(files).toEqual([file]);
		// app.ts is still staged (preserved, not swept, not lost)
		const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
			cwd: repo,
			encoding: "utf8",
		});
		expect(staged.stdout).toContain("app.ts");
	});
});
