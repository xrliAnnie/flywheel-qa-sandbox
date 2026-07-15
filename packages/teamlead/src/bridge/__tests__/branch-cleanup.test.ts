/**
 * FLY-1185 §2.4 — branch CAS deletion primitives, REAL git.
 * Plan §4 pins: checked-out branch → occupancy skip (real git); CAS
 * mismatch refuses; remote advanced → lease/probe refuses; protected /
 * base / shape gates.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	bundleBranch,
	casDeleteLocalBranch,
	casDeleteRemoteBranch,
	isBaseBranch,
	isManagedBranchShape,
	isProtectedBranch,
	isQaEphemeralBranch,
} from "../branch-cleanup.js";

let root: string;
let repo: string;
let bare: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeAll(() => {
	root = fs.mkdtempSync(
		path.join(fs.realpathSync(tmpdir()), "fly1185-branch-"),
	);
	bare = path.join(root, "origin.git");
	fs.mkdirSync(bare);
	git(bare, "init", "-q", "--bare", "-b", "main");

	repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "f.txt"), "1\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	git(repo, "remote", "add", "origin", bare);
	git(repo, "push", "-q", "origin", "main");
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("gates", () => {
	it("protected patterns: exact + prefix*", () => {
		expect(isProtectedBranch("keep-me", ["keep-me"])).toBe(true);
		expect(isProtectedBranch("release/1.2", ["release/*"])).toBe(true);
		expect(isProtectedBranch("releaseX", ["release/*"])).toBe(false);
		expect(isProtectedBranch("other", [])).toBe(false);
	});
	it("base branches never deletable", () => {
		expect(isBaseBranch("main")).toBe(true);
		expect(isBaseBranch("master")).toBe(true);
		expect(isBaseBranch("develop", "develop")).toBe(true);
		expect(isBaseBranch("feature-x")).toBe(false);
	});
	it("managed shape + QA family", () => {
		expect(isManagedBranchShape("flywheel", "flywheel-FLY-1")).toBe(true);
		expect(isManagedBranchShape("flywheel", "random")).toBe(false);
		expect(isQaEphemeralBranch("flywheel", "flywheel-FLY-1-qa")).toBe(true);
		expect(isQaEphemeralBranch("flywheel", "flywheel-qa-slot-1")).toBe(false);
		expect(isQaEphemeralBranch("flywheel", "unrelated-qa")).toBe(false);
	});
});

describe("casDeleteLocalBranch (real git)", () => {
	it("refuses a CHECKED-OUT branch via explicit occupancy (update-ref would have deleted it)", async () => {
		git(repo, "branch", "occupied-b", "main");
		const wt = path.join(root, "wt-occupied");
		git(repo, "worktree", "add", "-q", wt, "occupied-b");
		const sha = git(repo, "rev-parse", "refs/heads/occupied-b").trim();
		const res = await casDeleteLocalBranch({
			mainRepoPath: repo,
			branch: "occupied-b",
			expectedSha: sha,
		});
		expect(res.deleted).toBe(false);
		if (!res.deleted) expect(res.reason).toBe("branch_occupied");
		// branch survives
		expect(git(repo, "rev-parse", "refs/heads/occupied-b").trim()).toBe(sha);
		git(repo, "worktree", "remove", wt);
	});

	it("refuses on CAS mismatch (ref moved since the decision)", async () => {
		git(repo, "branch", "moving-b", "main");
		const oldSha = git(repo, "rev-parse", "refs/heads/moving-b").trim();
		// advance the branch
		fs.writeFileSync(path.join(repo, "g.txt"), "2\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "advance");
		git(repo, "branch", "-f", "moving-b", "HEAD");
		const res = await casDeleteLocalBranch({
			mainRepoPath: repo,
			branch: "moving-b",
			expectedSha: oldSha,
		});
		expect(res.deleted).toBe(false);
		if (!res.deleted) expect(res.reason).toBe("cas_mismatch");
	});

	it("deletes when unoccupied and sha matches; missing branch reported as such", async () => {
		git(repo, "branch", "gone-b", "main");
		const sha = git(repo, "rev-parse", "refs/heads/gone-b").trim();
		const res = await casDeleteLocalBranch({
			mainRepoPath: repo,
			branch: "gone-b",
			expectedSha: sha,
		});
		expect(res.deleted).toBe(true);
		const again = await casDeleteLocalBranch({
			mainRepoPath: repo,
			branch: "gone-b",
			expectedSha: sha,
		});
		expect(again.deleted).toBe(false);
		if (!again.deleted) expect(again.reason).toBe("branch_missing");
	});
});

describe("casDeleteRemoteBranch (real git, local bare origin)", () => {
	it("refuses when the remote ref advanced past the expected sha", async () => {
		git(repo, "branch", "rem-b", "main");
		git(repo, "push", "-q", "origin", "rem-b");
		const oldSha = git(repo, "rev-parse", "refs/heads/rem-b").trim();
		// advance remote out-of-band
		fs.writeFileSync(path.join(repo, "h.txt"), "3\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "advance2");
		git(repo, "push", "-q", "origin", "HEAD:refs/heads/rem-b");
		const res = await casDeleteRemoteBranch({
			mainRepoPath: repo,
			branch: "rem-b",
			expectedSha: oldSha,
		});
		expect(res.deleted).toBe(false);
		if (!res.deleted) expect(res.reason).toBe("remote_moved");
	});

	it("deletes under lease when the remote sha matches", async () => {
		const sha = git(repo, "ls-remote", "--heads", "origin", "rem-b")
			.split("\t")[0]
			.trim();
		const res = await casDeleteRemoteBranch({
			mainRepoPath: repo,
			branch: "rem-b",
			expectedSha: sha,
		});
		expect(res.deleted).toBe(true);
		const gone = await casDeleteRemoteBranch({
			mainRepoPath: repo,
			branch: "rem-b",
			expectedSha: sha,
		});
		expect(gone.deleted).toBe(false);
		if (!gone.deleted) expect(gone.reason).toBe("remote_missing");
	});
});

describe("bundleBranch", () => {
	it("creates + verifies a bundle carrying the expected tip", async () => {
		git(repo, "branch", "bundle-b", "main");
		const sha = git(repo, "rev-parse", "refs/heads/bundle-b").trim();
		const res = await bundleBranch({
			mainRepoPath: repo,
			branch: "bundle-b",
			expectedSha: sha,
			outDir: path.join(root, "bundles"),
		});
		expect(res.ok, res.error).toBe(true);
		expect(res.bundlePath && fs.existsSync(res.bundlePath)).toBe(true);
	});

	it("fails when the expected sha is not the bundled tip", async () => {
		const wrong = "0".repeat(40);
		const res = await bundleBranch({
			mainRepoPath: repo,
			branch: "bundle-b",
			expectedSha: wrong,
			outDir: path.join(root, "bundles"),
		});
		expect(res.ok).toBe(false);
		expect(res.error).toContain("bundle_head_mismatch");
	});
});
