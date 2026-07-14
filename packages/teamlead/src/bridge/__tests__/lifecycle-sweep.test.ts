/**
 * FLY-1185 §2.9 — sweep v2 integration tests (REAL git + in-memory store).
 * Pins (plan §4): clean+merged keeps Layer B strength; NEW families require
 * binding ownership (unowned → manual-only); 3d stability gate; dirty →
 * quarantine before force; local branch pass NEVER deletes (bundle+manifest,
 * R4#3); remote merged+stable → lease CAS delete; qa-slot reserved + config
 * protected retained; dry-run mutates nothing.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorktreeManager } from "flywheel-edge-worker";
import { beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	isQaEphemeralKey,
	isReservedNamespaceKey,
	isSameIssueFamily,
	STABILITY_WINDOW_MS,
	sweepProjectLifecycle,
} from "../lifecycle-sweep.js";
import { createRepoMutationLock } from "../repo-mutation-lock.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const FUTURE = () => Date.now() + STABILITY_WINDOW_MS + 60_000;

interface Fixture {
	root: string;
	repo: string;
	bare: string;
	store: StateStore;
	wm: WorktreeManager;
	lock: ReturnType<typeof createRepoMutationLock>;
}

async function makeFixture(): Promise<Fixture> {
	const root = fs.mkdtempSync(
		path.join(fs.realpathSync(tmpdir()), "fly1185-sweep-"),
	);
	const bare = path.join(root, "origin.git");
	fs.mkdirSync(bare);
	git(bare, "init", "-q", "--bare", "-b", "main");
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "f.txt"), "1\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	git(repo, "remote", "add", "origin", bare);
	git(repo, "push", "-q", "origin", "main");
	const store = await StateStore.create(":memory:");
	const lock = createRepoMutationLock();
	const wm = new WorktreeManager({ withRepoLock: lock.withRepoLock });
	return { root, repo, bare, store, wm, lock };
}

function sweepDeps(f: Fixture, extra: Record<string, unknown> = {}) {
	return {
		store: f.store,
		worktreeManager: f.wm,
		project: { projectName: "proj", projectRoot: f.repo },
		withRepoLock: f.lock.withRepoLock,
		quarantineRoot: path.join(f.root, "quarantine"),
		bundleDir: path.join(f.root, "bundles"),
		autoclean: true,
		nowMs: FUTURE, // stability window elapsed for observed candidates
		ghPrSetsFn: async () => ({
			merged: new Map<string, Set<string>>(),
			open: new Set<string>(),
			openTruncated: false,
		}),
		...extra,
	};
}

describe("helpers", () => {
	it("family / reserved / qa key classification", () => {
		expect(isSameIssueFamily("FLY-1160", "FLY-1160")).toBe(true);
		expect(isSameIssueFamily("FLY-1160", "FLY-1160-phase-b")).toBe(true);
		expect(isSameIssueFamily("FLY-116", "FLY-1160")).toBe(false);
		expect(isReservedNamespaceKey("qa-slot-1")).toBe(true);
		expect(isReservedNamespaceKey("FLY-1-qa")).toBe(false);
		expect(isQaEphemeralKey("FLY-1-qa")).toBe(true);
		expect(isQaEphemeralKey("qa-slot-1")).toBe(false);
	});
});

describe("sweepProjectLifecycle (real git)", () => {
	let f: Fixture;
	beforeEach(async () => {
		f = await makeFixture();
	});

	// Codex R3#11 (plan §73): the ownership contract applies to clean+merged
	// too — BINDING-OWNED clean+merged deletes (Layer B strength for the
	// post-deployment population); an UNOWNED one is manual-only.
	it(
		"clean+merged OWNED worktree removed with branch (Layer B strength for bound objects)",
		{ timeout: 60_000 },
		async () => {
			const wt = await f.wm.create({
				mainRepoPath: f.repo,
				projectName: "proj",
				issueId: "FLY-10",
				startPoint: "main",
			});
			f.store.upsertSession({
				execution_id: "e10",
				issue_id: "FLY-10",
				project_name: "proj",
				status: "completed",
			});
			f.store.bindWorktreeOnce("e10", {
				path: wt.worktreePath,
				branch: wt.branch,
				generation: wt.generation,
			});
			// tip === main tip → ancestor-of-main → merged evidence
			const res = await sweepProjectLifecycle(sweepDeps(f) as never);
			const entry = res.entries.find((e) => e.ref === wt.worktreePath);
			expect(entry?.action).toBe("deleted");
			expect(entry?.family).toBe("clean_merged");
			expect(fs.existsSync(wt.worktreePath)).toBe(false);
			// branch gone too
			expect(() =>
				git(f.repo, "rev-parse", "--verify", "-q", wt.branch),
			).toThrow();
		},
	);

	it(
		"clean+merged UNOWNED worktree is manual-only: periodic skips, dry-run lists it WITH its sha",
		{ timeout: 60_000 },
		async () => {
			const wt = await f.wm.create({
				mainRepoPath: f.repo,
				projectName: "proj",
				issueId: "FLY-13",
				startPoint: "main",
			});
			// no session / no binding → unowned
			const res = await sweepProjectLifecycle(sweepDeps(f) as never);
			const entry = res.entries.find((e) => e.ref === wt.worktreePath);
			expect(entry?.action).toBe("skipped");
			expect(entry?.reason).toBe("unowned_clean_merged");
			expect(fs.existsSync(wt.worktreePath)).toBe(true);
			// dry-run still lists it with the exact sha for the manual apply
			const dry = await sweepProjectLifecycle(
				sweepDeps(f, { dryRun: true }) as never,
			);
			const dryEntry = dry.entries.find((e) => e.ref === wt.worktreePath);
			expect(dryEntry?.action).toBe("would_delete");
			expect(dryEntry?.expectedSha).toBeTruthy();
			expect(dryEntry?.ownership).toBe("unowned");
		},
	);

	it(
		"dirty UNOWNED worktree is manual-only (no shape fallback — R6#1)",
		{ timeout: 60_000 },
		async () => {
			const wt = await f.wm.create({
				mainRepoPath: f.repo,
				projectName: "proj",
				issueId: "FLY-11",
				startPoint: "main",
			});
			fs.writeFileSync(path.join(wt.worktreePath, "dirty.txt"), "x\n");
			// no binding registered
			const res = await sweepProjectLifecycle(sweepDeps(f) as never);
			const entry = res.entries.find((e) => e.ref === wt.worktreePath);
			expect(entry?.action).toBe("skipped");
			expect(entry?.reason).toMatch(/^unowned_/);
			expect(fs.existsSync(wt.worktreePath)).toBe(true);
		},
	);

	it(
		"dirty OWNED worktree: stability first pass blocks; stable pass quarantines then force-removes",
		{ timeout: 60_000 },
		async () => {
			const wt = await f.wm.create({
				mainRepoPath: f.repo,
				projectName: "proj",
				issueId: "FLY-12",
				startPoint: "main",
			});
			fs.writeFileSync(path.join(wt.worktreePath, ".env"), "SECRET=1\n");
			fs.writeFileSync(path.join(wt.worktreePath, ".gitignore"), ".env\n");
			f.store.upsertSession({
				execution_id: "e12",
				issue_id: "FLY-12",
				project_name: "proj",
				status: "completed",
			});
			f.store.bindWorktreeOnce("e12", {
				path: wt.worktreePath,
				branch: wt.branch,
				generation: wt.generation,
			});

			// Pass 1 at REAL now: mtimes are fresh → recent_activity blocks.
			const early = await sweepProjectLifecycle(
				sweepDeps(f, { nowMs: () => Date.now() }) as never,
			);
			const earlyEntry = early.entries.find((e) => e.ref === wt.worktreePath);
			expect(earlyEntry?.action).toBe("skipped");
			expect(earlyEntry?.reason).toBe("recent_activity");
			expect(fs.existsSync(wt.worktreePath)).toBe(true);

			// Age the worktree: backdate every file mtime (worktree + git admin dir)
			// past the 3-day window so the activity probe stops blocking.
			const old = new Date(Date.now() - STABILITY_WINDOW_MS - 3_600_000);
			const backdate = (p: string) => {
				try {
					fs.utimesSync(p, old, old);
				} catch {
					/* ignore */
				}
			};
			const walk = (dir: string) => {
				backdate(dir);
				for (const name of fs.readdirSync(dir)) {
					const p = path.join(dir, name);
					const st = fs.lstatSync(p);
					if (st.isDirectory()) walk(p);
					else backdate(p);
				}
			};
			walk(wt.worktreePath);
			const adminDir = path.join(
				f.repo,
				".git",
				"worktrees",
				path.basename(wt.worktreePath),
			);
			if (fs.existsSync(adminDir)) walk(adminDir);

			// Pass 2 at REAL now: activity aged out → the observation is SEEDED but
			// the 3-day stability window is still open → retained.
			const seed = await sweepProjectLifecycle(
				sweepDeps(f, { nowMs: () => Date.now() }) as never,
			);
			const seedEntry = seed.entries.find((e) => e.ref === wt.worktreePath);
			expect(seedEntry?.reason).toBe("stability_window_open");
			expect(fs.existsSync(wt.worktreePath)).toBe(true);

			// Pass 3 "3 days later" (same fingerprint) → quarantine + force remove.
			const res = await sweepProjectLifecycle(sweepDeps(f) as never);
			const entry = res.entries.find((e) => e.ref === wt.worktreePath);
			expect(entry?.action, JSON.stringify(entry)).toBe("quarantined_deleted");
			expect(entry?.quarantinePath && fs.existsSync(entry.quarantinePath)).toBe(
				true,
			);
			// the ignored .env made it into the archive
			expect(
				fs.existsSync(
					path.join(entry?.quarantinePath ?? "", "payload", ".env"),
				),
			).toBe(true);
			expect(fs.existsSync(wt.worktreePath)).toBe(false);
		},
	);

	it(
		"qa-slot reserved namespace + config-protected branches retained",
		{ timeout: 60_000 },
		async () => {
			const wtQa = await f.wm.create({
				mainRepoPath: f.repo,
				projectName: "proj",
				issueId: "qa-slot-1",
				startPoint: "main",
			});
			const wtProt = await f.wm.create({
				mainRepoPath: f.repo,
				projectName: "proj",
				issueId: "KEEP-1",
				startPoint: "main",
			});
			const policies = new Map([
				[
					"proj",
					{ enabled: true as const, protectedBranches: ["repo-KEEP-*"] },
				],
			]);
			const res = await sweepProjectLifecycle(
				sweepDeps(f, { policies }) as never,
			);
			expect(res.entries.find((e) => e.ref === wtQa.worktreePath)?.reason).toBe(
				"reserved_namespace",
			);
			expect(
				res.entries.find((e) => e.ref === wtProt.worktreePath)?.reason,
			).toBe("protected_branch_config");
			expect(fs.existsSync(wtQa.worktreePath)).toBe(true);
			expect(fs.existsSync(wtProt.worktreePath)).toBe(true);
		},
	);

	it(
		"disabled policy (malformed config) → ZERO deleter calls",
		{ timeout: 60_000 },
		async () => {
			const wt = await f.wm.create({
				mainRepoPath: f.repo,
				projectName: "proj",
				issueId: "FLY-13",
				startPoint: "main",
			});
			const policies = new Map([
				[
					"proj",
					{ enabled: false as const, reason: "config_yaml_unparseable" },
				],
			]);
			const res = await sweepProjectLifecycle(
				sweepDeps(f, { policies }) as never,
			);
			expect(res.policyDisabled).toBe("config_yaml_unparseable");
			expect(res.entries).toEqual([]);
			expect(fs.existsSync(wt.worktreePath)).toBe(true);
		},
	);

	it(
		"dry-run produces the manifest and mutates NOTHING (even a deletable candidate)",
		{ timeout: 60_000 },
		async () => {
			const wt = await f.wm.create({
				mainRepoPath: f.repo,
				projectName: "proj",
				issueId: "FLY-14",
				startPoint: "main",
			});
			const res = await sweepProjectLifecycle(
				sweepDeps(f, { dryRun: true, autoclean: false }) as never,
			);
			const entry = res.entries.find((e) => e.ref === wt.worktreePath);
			expect(entry?.action).toBe("would_delete");
			expect(fs.existsSync(wt.worktreePath)).toBe(true);
		},
	);

	it(
		"branch pass (R6#4): a merged branch whose binding worktree is no longer registered is UNOWNED → manual-only (periodic never deletes local or remote)",
		{ timeout: 60_000 },
		async () => {
			// local orphan branch (no worktree), merged (== main tip)
			git(f.repo, "branch", "repo-FLY-20", "main");
			// remote merged branch
			git(f.repo, "push", "-q", "origin", "main:refs/heads/repo-FLY-21");
			const tip = git(f.repo, "rev-parse", "main").trim();
			// A HISTORICAL binding exists, but its worktree is gone (the session
			// finished and the worktree was removed; only the branch lingers).
			// R6#4: ownership requires the binding's worktree to still be
			// REGISTERED at binding.path AND checked out on binding.branch AND
			// generation-matched — a bare generation stub is NOT enough. With no
			// registered worktree, both refs are unowned → manual-only.
			for (const [exec, issue] of [
				["e-own-20", "FLY-20"],
				["e-own-21", "FLY-21"],
			] as const) {
				f.store.upsertSession({
					execution_id: exec,
					issue_id: issue,
					project_name: "proj",
					status: "completed",
				});
			}
			f.store.bindWorktreeOnce(
				"e-own-20",
				{ path: "/wt/20", branch: "repo-FLY-20", generation: "g20" },
				{ issueId: "FLY-20", projectName: "proj" },
			);
			f.store.bindWorktreeOnce(
				"e-own-21",
				{ path: "/wt/21", branch: "repo-FLY-21", generation: "g21" },
				{ issueId: "FLY-21", projectName: "proj" },
			);
			f.wm.readWorktreeGeneration = (async (path: string) =>
				path === "/wt/20"
					? "g20"
					: path === "/wt/21"
						? "g21"
						: undefined) as typeof f.wm.readWorktreeGeneration;

			// pass 1 seeds observations
			await sweepProjectLifecycle(
				sweepDeps(f, { nowMs: () => Date.now() }) as never,
			);
			// pass 2 "3d later" acts
			const res = await sweepProjectLifecycle(sweepDeps(f) as never);

			const local = res.entries.find(
				(e) => e.kind === "local_branch" && e.ref === "repo-FLY-20",
			);
			// unowned → manual-only skip; the local ref SURVIVES.
			expect(local?.action).toBe("skipped");
			expect(local?.reason).toBe("unowned_branch_clean_merged");
			expect(git(f.repo, "rev-parse", "refs/heads/repo-FLY-20").trim()).toBe(
				tip,
			);

			const remote = res.entries.find(
				(e) => e.kind === "remote_branch" && e.ref === "repo-FLY-21",
			);
			expect(remote?.action, JSON.stringify(remote)).toBe("skipped");
			expect(remote?.reason).toBe("unowned_branch_clean_merged");
			// remote ref SURVIVES the periodic pass (deletion only via apply).
			expect(
				git(f.repo, "ls-remote", "--heads", "origin", "repo-FLY-21").trim(),
			).not.toBe("");
		},
	);

	it(
		"R4#5: an UNOWNED remote merged branch is MANUAL-ONLY — the periodic pass never deletes it; dry-run lists it with its sha",
		{ timeout: 60_000 },
		async () => {
			git(f.repo, "push", "-q", "origin", "main:refs/heads/repo-FLY-24");
			const tip = git(f.repo, "rev-parse", "main").trim();
			// NO binding for repo-FLY-24 → unowned.
			await sweepProjectLifecycle(
				sweepDeps(f, { nowMs: () => Date.now() }) as never,
			);
			const res = await sweepProjectLifecycle(sweepDeps(f) as never);
			const remote = res.entries.find(
				(e) => e.kind === "remote_branch" && e.ref === "repo-FLY-24",
			);
			expect(remote?.action).toBe("skipped");
			expect(remote?.reason).toBe("unowned_branch_clean_merged");
			// remote ref SURVIVES the periodic pass
			expect(
				git(f.repo, "ls-remote", "--heads", "origin", "repo-FLY-24").trim(),
			).not.toBe("");

			// dry-run lists it WITH the exact sha + the manual-only reason.
			const dry = await sweepProjectLifecycle(
				sweepDeps(f, { dryRun: true }) as never,
			);
			const listed = dry.entries.find(
				(e) => e.kind === "remote_branch" && e.ref === "repo-FLY-24",
			);
			expect(listed?.action).toBe("would_delete");
			expect(listed?.reason).toBe("unowned_requires_include_unowned");
			expect(listed?.expectedSha).toBe(tip);
			expect(listed?.ownership).toBe("unowned");
		},
	);

	it(
		"remote branch with an OPEN PR is never touched",
		{ timeout: 60_000 },
		async () => {
			git(f.repo, "push", "-q", "origin", "main:refs/heads/repo-FLY-22");
			await sweepProjectLifecycle(
				sweepDeps(f, { nowMs: () => Date.now() }) as never,
			);
			const res = await sweepProjectLifecycle(
				sweepDeps(f, {
					ghPrSetsFn: async () => ({
						merged: new Map(),
						open: new Set(["repo-FLY-22"]),
						openTruncated: false,
					}),
				}) as never,
			);
			const remote = res.entries.find(
				(e) => e.kind === "remote_branch" && e.ref === "repo-FLY-22",
			);
			expect(remote?.action).toBe("skipped");
			expect(remote?.reason).toBe("open_pr");
			expect(
				git(f.repo, "ls-remote", "--heads", "origin", "repo-FLY-22").trim(),
			).not.toBe("");
		},
	);

	it(
		"gh unavailable → fail-closed for PR-dependent candidates",
		{ timeout: 60_000 },
		async () => {
			git(f.repo, "push", "-q", "origin", "main:refs/heads/repo-FLY-23");
			await sweepProjectLifecycle(
				sweepDeps(f, { nowMs: () => Date.now() }) as never,
			);
			const res = await sweepProjectLifecycle(
				sweepDeps(f, { ghPrSetsFn: async () => undefined }) as never,
			);
			expect(res.ghUnavailable).toBe(true);
			const remote = res.entries.find(
				(e) => e.kind === "remote_branch" && e.ref === "repo-FLY-23",
			);
			expect(remote?.action).toBe("skipped");
			expect(remote?.reason).toBe("openpr_unknown");
		},
	);
});
