/**
 * FLY-1185 §2.8 — worktree quarantine + restore-smoke, REAL git fixtures.
 * Plan §4 pins: mixed fixture real restore; ignored `.env`; nested ignored
 * binary; over-budget fail; symlink round-trip; regenerable allowlist skip
 * recorded in manifest.skipped; submodule change → fail retained.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	isRegenerablePath,
	QUARANTINE_MAX_BYTES,
	quarantineWorktree,
} from "../worktree-quarantine.js";

let root: string; // temp root for this suite
let mainRepo: string; // "main" repo
let wt: string; // sibling worktree

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function setupFixture(): void {
	root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), "fly1185-quar-"));
	mainRepo = path.join(root, "repo");
	fs.mkdirSync(mainRepo);
	git(mainRepo, "init", "-q", "-b", "main");
	git(mainRepo, "config", "user.email", "t@t");
	git(mainRepo, "config", "user.name", "t");
	fs.writeFileSync(path.join(mainRepo, "a.txt"), "base-a\n");
	fs.writeFileSync(
		path.join(mainRepo, ".gitignore"),
		".env\nsecrets/\nnode_modules/\n",
	);
	git(mainRepo, "add", "-A");
	git(mainRepo, "commit", "-q", "-m", "base");
	wt = path.join(root, "repo-FLY-1");
	git(mainRepo, "worktree", "add", "-q", wt, "-b", "repo-FLY-1");
}

beforeAll(() => {
	setupFixture();
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("isRegenerablePath", () => {
	it("matches directory components only, never file names", () => {
		expect(isRegenerablePath("node_modules/x/y.js")).toBe(true);
		expect(isRegenerablePath("pkg/dist/bundle.js")).toBe(true);
		expect(isRegenerablePath("src/dist.ts")).toBe(false);
		expect(isRegenerablePath("target")).toBe(false); // bare file named target
		expect(isRegenerablePath("a/__pycache__/m.pyc")).toBe(true);
	});
});

describe("quarantineWorktree (real git)", () => {
	it("mixed dirty fixture archives + restore-smoke passes (staged/unstaged/untracked/ignored/symlink)", async () => {
		// staged change
		fs.writeFileSync(path.join(wt, "a.txt"), "staged-change\n");
		git(wt, "add", "a.txt");
		// unstaged tracked change on top of the staged one
		fs.writeFileSync(path.join(wt, "a.txt"), "staged-change\nunstaged-tail\n");
		// untracked file
		fs.writeFileSync(path.join(wt, "notes.md"), "untracked\n");
		// ignored .env (the classic secret) + nested ignored binary
		fs.writeFileSync(path.join(wt, ".env"), "SECRET=1\n");
		fs.mkdirSync(path.join(wt, "secrets"), { recursive: true });
		fs.writeFileSync(
			path.join(wt, "secrets", "blob.bin"),
			Buffer.from([0, 1, 2, 250, 251, 252]),
		);
		// regenerable ignored dir — must be SKIPPED but recorded
		fs.mkdirSync(path.join(wt, "node_modules", "pkg"), { recursive: true });
		fs.writeFileSync(path.join(wt, "node_modules", "pkg", "i.js"), "x");
		// symlink (untracked)
		fs.symlinkSync("a.txt", path.join(wt, "link-to-a"));

		const res = await quarantineWorktree({
			mainRepoPath: mainRepo,
			worktreePath: wt,
			project: "proj",
			key: "FLY-1",
			quarantineRoot: path.join(root, "archives"),
		});
		expect(res.ok, JSON.stringify(res)).toBe(true);
		if (!res.ok) return;

		const m = res.manifest;
		// ignored .env + nested binary archived
		const paths = m.files.map((f) => f.path);
		expect(paths).toContain(".env");
		expect(paths).toContain("secrets/blob.bin");
		expect(paths).toContain("notes.md");
		// symlink stored as symlink with target
		const link = m.files.find((f) => f.path === "link-to-a");
		expect(link?.type).toBe("symlink");
		expect(link?.linkTarget).toBe("a.txt");
		// regenerable allowlist skip is explicit + audited
		expect(m.skipped).toContain("node_modules/pkg/i.js");
		expect(paths).not.toContain("node_modules/pkg/i.js");
		// diffs captured
		expect(m.stagedDiffSha256).toHaveLength(64);
		expect(m.trackedDiffSha256).toHaveLength(64);
		// archive artifacts on disk
		expect(fs.existsSync(path.join(res.archiveDir, "manifest.json"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(res.archiveDir, "staged.diff"))).toBe(true);
		expect(
			fs.existsSync(
				path.join(res.archiveDir, "payload", "secrets", "blob.bin"),
			),
		).toBe(true);
	});

	it("over-budget total → whole archive fails, worktree untouched", async () => {
		const res = await quarantineWorktree({
			mainRepoPath: mainRepo,
			worktreePath: wt,
			project: "proj",
			key: "FLY-1",
			quarantineRoot: path.join(root, "archives2"),
			maxBytes: 4, // tiny budget
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("over_budget");
		// worktree files still present
		expect(fs.existsSync(path.join(wt, ".env"))).toBe(true);
	});

	it("QUARANTINE_MAX_BYTES is the hardcoded 2GiB constant (no env flag)", () => {
		expect(QUARANTINE_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
	});

	it("submodule state change → fail retained", async () => {
		// separate fixture with a submodule
		const subSrc = path.join(root, "subsrc");
		fs.mkdirSync(subSrc);
		git(subSrc, "init", "-q", "-b", "main");
		git(subSrc, "config", "user.email", "t@t");
		git(subSrc, "config", "user.name", "t");
		fs.writeFileSync(path.join(subSrc, "s.txt"), "one\n");
		git(subSrc, "add", "-A");
		git(subSrc, "commit", "-q", "-m", "s1");

		const host = path.join(root, "host");
		fs.mkdirSync(host);
		git(host, "init", "-q", "-b", "main");
		git(host, "config", "user.email", "t@t");
		git(host, "config", "user.name", "t");
		fs.writeFileSync(path.join(host, "h.txt"), "h\n");
		git(host, "add", "-A");
		git(host, "commit", "-q", "-m", "h1");
		execFileSync(
			"git",
			["-c", "protocol.file.allow=always", "submodule", "add", subSrc, "sub"],
			{ cwd: host, encoding: "utf8" },
		);
		git(host, "commit", "-q", "-m", "add-sub");

		// advance the submodule → gitlink change in the host porcelain
		fs.writeFileSync(path.join(host, "sub", "s.txt"), "two\n");
		git(path.join(host, "sub"), "add", "-A");
		git(path.join(host, "sub"), "commit", "-q", "-m", "s2");

		const res = await quarantineWorktree({
			mainRepoPath: host,
			worktreePath: host,
			project: "proj",
			key: "HOST",
			quarantineRoot: path.join(root, "archives3"),
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("submodule_change");
	});
});
