import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { canonicalJsonString } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WorktreeExecFn, WorktreeManager } from "../WorktreeManager.js";
import type {
	PendingTakeoverRescue,
	TakeoverRescueEventPayload,
	TakeoverRescuePermit,
	TakeoverRescueRecorder,
} from "../worktree-takeover-rescue.js";
import type {
	TakeoverStep,
	TakeoverTransactionInput,
	TakeoverTransactionResult,
} from "../worktree-takeover-transaction.js";

/**
 * FLY-2901: real-git takeover rescue transaction (plan §10). Every scenario
 * runs against a real bare origin + main repo + shared linked worktree; "zero
 * loss" is proven by restoring the pushed rescue refs into a scratch worktree
 * and comparing index / worktree / untracked bytes with the pre-rescue state.
 */

const roots: string[] = [];
const ALLOWED: TakeoverRescuePermit = {
	allowed: true,
	reason: "no_live_writer",
	predecessors: [
		{
			executionId: "pred-exec-11112222",
			sessionStatus: "failed",
			liveness: "dead",
			pathSource: "both",
		},
	],
};
const LIVE_WRITER: TakeoverRescuePermit = {
	allowed: false,
	reason: "live_writer",
	predecessors: [
		{
			executionId: "pred-exec-11112222",
			sessionStatus: "running",
			liveness: "not_probed",
			pathSource: "session",
		},
	],
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function gitRaw(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(dir);
	return dir;
}

/** Re-entrant per-repo lock (the production repo-mutation lock is re-entrant). */
function reentrantLock() {
	const held = new AsyncLocalStorage<Set<string>>();
	const tails = new Map<string, Promise<void>>();
	const order: string[] = [];
	const withRepoLock = async <T>(
		repo: string,
		fn: () => Promise<T>,
	): Promise<T> => {
		const current = held.getStore();
		if (current?.has(repo)) return fn();
		const previous = tails.get(repo) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		tails.set(
			repo,
			previous.then(() => gate),
		);
		await previous;
		try {
			return await held.run(new Set([...(current ?? []), repo]), fn);
		} finally {
			release();
		}
	};
	/** Run `fn` as an unrelated caller (outside any held-lock context). */
	const outsideLock = <T>(fn: () => T): T => held.exit(fn);
	return { withRepoLock, order, outsideLock };
}

function memoryRecorder() {
	const events: Array<{
		uid: string;
		kind: "rescued" | "cleaned";
		payload: unknown;
	}> = [];
	let failRescue = false;
	let failCleaned = false;
	const recorder: TakeoverRescueRecorder = {
		async loadPendingTakeoverRescue({ canonicalPath }) {
			const out: PendingTakeoverRescue[] = [];
			events.forEach((event, seq) => {
				if (event.kind !== "rescued") return;
				const payload = event.payload as TakeoverRescueEventPayload;
				if (payload.canonicalPath !== canonicalPath) return;
				if (events.some((other) => other.uid === `cleaned:${event.uid}`))
					return;
				out.push({ eventUid: event.uid, seq: seq + 1, payload });
			});
			return out;
		},
		async recordRescue({ eventUid, payload }) {
			if (failRescue) throw new Error("injected_event_failure");
			const existing = events.find((event) => event.uid === eventUid);
			if (existing) {
				if (
					canonicalJsonString(existing.payload) !== canonicalJsonString(payload)
				)
					throw new Error("workflow_event_uid_conflict");
				return;
			}
			events.push({ uid: eventUid, kind: "rescued", payload });
		},
		async recordCleaned({ rescueEventUid, payload }) {
			if (failCleaned) throw new Error("injected_cleaned_failure");
			const uid = `cleaned:${rescueEventUid}`;
			if (!events.some((event) => event.uid === uid)) {
				events.push({ uid, kind: "cleaned", payload });
			}
		},
	};
	return {
		recorder,
		events,
		failRescue: (value: boolean) => {
			failRescue = value;
		},
		failCleaned: (value: boolean) => {
			failCleaned = value;
		},
	};
}

type Repo = ReturnType<typeof seed>;

function seed() {
	const origin = tempDir("fly2901-origin-");
	const parent = tempDir("fly2901-main-");
	const root = join(parent, "flywheel");
	mkdirSync(root);
	const baseDir = tempDir("fly2901-worktrees-");
	const stateDir = tempDir("fly2901-state-");
	git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
	git(root, "init", "--quiet", "--initial-branch=main");
	git(root, "config", "user.name", "Flywheel Test");
	git(root, "config", "user.email", "test@flywheel.local");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	writeFileSync(join(root, "rename-me.txt"), "rename\n");
	writeFileSync(join(root, "delete-me.txt"), "delete\n");
	writeFileSync(join(root, "mode.sh"), "#!/bin/sh\necho hi\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "base");
	git(root, "remote", "add", "origin", origin);
	git(root, "push", "--quiet", "-u", "origin", "main");
	const lock = reentrantLock();
	const makeManager = (
		extra?: ConstructorParameters<typeof WorktreeManager>[0],
	) =>
		new WorktreeManager({
			baseDir,
			pushGuardStateDir: join(stateDir, "push-guard-state"),
			pushGuardSourcePath: join(
				process.cwd(),
				"assets",
				"push-guard",
				"pre-push",
			),
			takeoverRescueStateDir: join(stateDir, "takeover-rescue"),
			withRepoLock: lock.withRepoLock,
			...extra,
		});
	return {
		origin,
		root,
		baseDir,
		stateDir,
		base: git(root, "rev-parse", "HEAD"),
		manager: makeManager(),
		makeManager,
		lock,
	};
}

async function sharedWorktree(repo: Repo, startPoint = repo.base) {
	const wt = await repo.manager.create({
		mainRepoPath: repo.root,
		projectName: "flywheel",
		issueId: "FLY-2901",
		startPoint,
	});
	git(wt.worktreePath, "config", "user.name", "Predecessor");
	git(wt.worktreePath, "config", "user.email", "pred@flywheel.local");
	return wt;
}

function commitIn(dir: string, file: string, content: string, message: string) {
	writeFileSync(join(dir, file), content);
	git(dir, "add", file);
	git(dir, "commit", "--quiet", "--no-verify", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

function input(
	repo: Repo,
	recorder: TakeoverRescueRecorder | undefined,
	overrides: Partial<TakeoverTransactionInput> = {},
): TakeoverTransactionInput {
	return {
		mainRepoPath: repo.root,
		projectName: "flywheel",
		issueId: "FLY-2901",
		issueKey: "FLY-2901",
		runId: "run-2901",
		successorExec: "succ-exec-33334444",
		startPoint: repo.base,
		permit: ALLOWED,
		rescueDisabled: false,
		recorder,
		stabilityWaitMs: 0,
		...overrides,
	};
}

/** index / worktree / untracked bytes + HEAD history of one worktree. */
function captureState(dir: string) {
	const untracked = gitRaw(
		dir,
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	)
		.split("\0")
		.filter(Boolean)
		.sort()
		.map((rel) => {
			const abs = join(dir, rel);
			const stat = lstatSync(abs);
			return stat.isSymbolicLink()
				? { rel, link: readlinkSync(abs) }
				: {
						rel,
						mode: stat.mode & 0o111,
						bytes: readFileSync(abs).toString("base64"),
					};
		});
	return {
		staged: gitRaw(dir, "diff", "--cached", "--binary"),
		unstaged: gitRaw(dir, "diff", "--binary"),
		untracked,
	};
}

/** Restore the two snapshot layers onto `head` in a scratch worktree. */
function restoreFromRescue(
	repo: Repo,
	head: string,
	staged: string,
	worktree: string,
): string {
	const scratch = join(tempDir("fly2901-restore-"), "wt");
	git(repo.root, "worktree", "add", "--quiet", "--detach", scratch, head);
	if (staged !== head) {
		const patch = gitRaw(repo.root, "diff", "--binary", head, staged);
		execFileSync("git", ["-C", scratch, "apply", "--index"], { input: patch });
	}
	if (worktree !== staged) {
		const patch = gitRaw(repo.root, "diff", "--binary", staged, worktree);
		execFileSync("git", ["-C", scratch, "apply"], { input: patch });
	}
	return scratch;
}

function remoteTip(repo: Repo, branch: string): string | undefined {
	const out = git(
		repo.origin,
		"for-each-ref",
		"--format=%(objectname)",
		`refs/heads/${branch}`,
	);
	return out || undefined;
}

function expectRescued(
	result: TakeoverTransactionResult,
): Extract<TakeoverTransactionResult, { kind: "rescued" }> {
	if (result.kind !== "rescued") {
		throw new Error(`expected rescued, got ${JSON.stringify(result)}`);
	}
	return result;
}

function expectRefused(
	result: TakeoverTransactionResult,
	reason: string,
): Extract<TakeoverTransactionResult, { kind: "refused" }> {
	if (result.kind !== "refused" || result.reason !== reason) {
		throw new Error(
			`expected refused ${reason}, got ${JSON.stringify(result)}`,
		);
	}
	return result;
}

function treeBytes(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string) => {
		for (const name of readdirSync(current)) {
			const abs = join(current, name);
			const rel = relative(dir, abs);
			if (rel === ".git" || rel.startsWith(".git/")) continue;
			const stat = lstatSync(abs);
			if (stat.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
			else if (stat.isDirectory()) walk(abs);
			else out[rel] = readFileSync(abs).toString("base64");
		}
	};
	walk(dir);
	return out;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			chmodSync(root, 0o700);
		} catch {}
		rmSync(root, { recursive: true, force: true });
	}
});

describe(
	"WorktreeManager.runTakeoverTransaction — rescue classes",
	{ timeout: 180_000 },
	() => {
		it("dirty: preserves staged+unstaged/untracked/delete/rename/mode/symlink/binary with zero loss, then cleans in place", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const dir = wt.worktreePath;
			const H = commitIn(dir, "work.txt", "committed\n", "predecessor work");
			// staged + unstaged on the same file
			writeFileSync(join(dir, "tracked.txt"), "staged\n");
			git(dir, "add", "tracked.txt");
			writeFileSync(join(dir, "tracked.txt"), "staged\nunstaged\n");
			git(dir, "rm", "--quiet", "delete-me.txt");
			git(dir, "mv", "rename-me.txt", "renamed.txt");
			chmodSync(join(dir, "mode.sh"), 0o755);
			writeFileSync(join(dir, "untracked.txt"), "untracked\n");
			mkdirSync(join(dir, "deep", "er"), { recursive: true });
			writeFileSync(
				join(dir, "deep", "er", "file.bin"),
				Buffer.from([0, 1, 2, 255, 0]),
			);
			symlinkSync("tracked.txt", join(dir, "link"));
			const before = captureState(dir);
			const rec = memoryRecorder();

			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(
					input(repo, rec.recorder, { startPoint: H }),
				),
			);

			const manifest = result.evidence.manifest;
			expect(manifest.class).toBe("dirty");
			expect(manifest.target).toBe(H);
			expect(git(dir, "rev-parse", "HEAD")).toBe(H);
			expect(git(dir, "status", "--porcelain")).toBe("");
			expect(result.worktree.generation).toBe(wt.generation);
			expect(manifest.rescues.map((r) => r.kind)).toEqual(["dirty"]);
			const rescue = manifest.rescues[0]!;
			expect(remoteTip(repo, rescue.remoteBranch)).toBe(rescue.tip);
			expect(git(repo.root, "rev-parse", rescue.localRef)).toBe(rescue.tip);
			expect(rescue.remoteBranch).toMatch(
				/^flywheel-rescue\/FLY-2901\/pred-exe-succ-exe-\d{8}T\d{6}Z-dirty$/,
			);
			expect(manifest.snapshot?.worktreeCommit).toBe(rescue.tip);
			// event strictly before cleaned receipt
			expect(rec.events.map((event) => event.kind)).toEqual([
				"rescued",
				"cleaned",
			]);
			expect(result.evidence.pointer).toBe(
				`event:${result.evidence.eventUid} refs:${rescue.remoteBranch}@${rescue.tip}`,
			);
			// zero loss: restore both layers from the REMOTE rescue commit objects
			const scratch = restoreFromRescue(
				repo,
				H,
				manifest.snapshot!.stagedCommit,
				manifest.snapshot!.worktreeCommit,
			);
			expect(captureState(scratch)).toEqual(before);
			// mirror evidence is invisible to git
			expect(existsSync(result.evidence.mirrorJsonPath)).toBe(true);
			expect(existsSync(result.evidence.mirrorMdPath)).toBe(true);
		});

		it("head_behind (clean): fast-forwards to S with a manifest + event but no rescue refs", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const S = commitIn(repo.root, "ahead.txt", "ahead\n", "ahead on main");
			const rec = memoryRecorder();
			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(
					input(repo, rec.recorder, { startPoint: S }),
				),
			);
			expect(result.evidence.manifest.class).toBe("head_behind");
			expect(result.evidence.manifest.target).toBe(S);
			expect(result.evidence.manifest.rescues).toEqual([]);
			expect(git(wt.worktreePath, "rev-parse", "HEAD")).toBe(S);
			expect(result.evidence.pointer).toBe(`event:${result.evidence.eventUid}`);
			expect(existsSync(result.evidence.manifestPath)).toBe(true);
			expect(result.worktree.generation).toBe(wt.generation);
		});

		it("head_published_diverged (FLY-2463): clean tree at the published head keeps H and rescues the stale S", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const staleS = commitIn(repo.root, "old-base.txt", "old\n", "stale base");
			const H = commitIn(
				wt.worktreePath,
				"rebased.txt",
				"rebased\n",
				"rebased work",
			);
			git(
				repo.root,
				"push",
				"--quiet",
				"origin",
				`${H}:refs/heads/${wt.branch}`,
			);
			const rec = memoryRecorder();
			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(
					input(repo, rec.recorder, { startPoint: staleS }),
				),
			);
			expect(result.evidence.manifest.class).toBe("head_published_diverged");
			expect(result.evidence.manifest.target).toBe(H);
			expect(
				result.evidence.manifest.rescues.map((r) => [r.kind, r.tip]),
			).toEqual([["base", staleS]]);
			expect(git(wt.worktreePath, "rev-parse", "HEAD")).toBe(H);
		});

		it("head_diverged: unpublished H is pushed to a -head rescue and the tree returns to S", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const S = commitIn(repo.root, "side.txt", "side\n", "engine base");
			const H = commitIn(
				wt.worktreePath,
				"local.txt",
				"local\n",
				"unpublished",
			);
			const rec = memoryRecorder();
			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(
					input(repo, rec.recorder, { startPoint: S }),
				),
			);
			expect(result.evidence.manifest.class).toBe("head_diverged");
			expect(result.evidence.manifest.target).toBe(S);
			const head = result.evidence.manifest.rescues.find(
				(r) => r.kind === "head",
			);
			expect(head?.tip).toBe(H);
			expect(remoteTip(repo, head!.remoteBranch)).toBe(H);
			expect(git(wt.worktreePath, "rev-parse", "HEAD")).toBe(S);
		});
	},
);

describe(
	"WorktreeManager.runTakeoverTransaction — stops keep bytes",
	{ timeout: 180_000 },
	() => {
		it("refuses a live writer and lists the dirty paths without touching the tree", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			writeFileSync(join(wt.worktreePath, "tracked.txt"), "live edit\n");
			const before = treeBytes(wt.worktreePath);
			const refused = expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, { permit: LIVE_WRITER }),
				),
				"permit_denied:live_writer",
			);
			expect(refused.dirtyPaths).toEqual(["tracked.txt"]);
			expect(treeBytes(wt.worktreePath)).toEqual(before);
		});

		it("kill switch: registered dirty tree gets the legacy refusal", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			writeFileSync(join(wt.worktreePath, "new.txt"), "x\n");
			const refused = expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, { rescueDisabled: true }),
				),
				"kill_switch",
			);
			expect(refused.legacy).toBe(true);
			expect(refused.clean).toBe(false);
			expect(existsSync(join(wt.worktreePath, "new.txt"))).toBe(true);
		});

		it("still reuses a clean tree at S byte-identically (no rescue flow, no events)", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const rec = memoryRecorder();
			const result = await repo.manager.runTakeoverTransaction(
				input(repo, rec.recorder),
			);
			expect(result.kind).toBe("reused");
			expect(rec.events).toEqual([]);
			if (result.kind === "reused")
				expect(result.worktree.generation).toBe(wt.generation);
		});
	},
);

function nestedRepo(dir: string, name: string) {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "--quiet", "--initial-branch=main");
	git(dir, "config", "user.name", "Nested");
	git(dir, "config", "user.email", "nested@flywheel.local");
	writeFileSync(join(dir, `${name}.txt`), `${name} committed\n`);
	git(dir, "add", ".");
	git(dir, "commit", "--quiet", "-m", `${name} first`);
	writeFileSync(join(dir, `${name}.txt`), `${name} committed\n${name} dirty\n`);
	writeFileSync(join(dir, "untracked-in-nested.txt"), "keep me\n");
}

function nestedIdentity(dir: string) {
	return {
		head: git(dir, "rev-parse", "HEAD"),
		status: gitRaw(
			dir,
			"status",
			"--porcelain=v2",
			"-z",
			"--untracked-files=all",
		),
		bytes: treeBytes(dir),
	};
}

describe(
	"WorktreeManager.runTakeoverTransaction — nested repositories (FLY-2122)",
	{ timeout: 180_000 },
	() => {
		it("(a) permit denied: an untracked nested repo keeps the tree dirty, the path is listed and nothing moves", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const nested = join(wt.worktreePath, "paired", "other");
			nestedRepo(nested, "other");
			const before = nestedIdentity(nested);
			const refused = expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, { permit: LIVE_WRITER }),
				),
				"permit_denied:live_writer",
			);
			expect(refused.dirtyPaths).toContain("paired/other/");
			expect(nestedIdentity(nested)).toEqual(before);
		});

		it("(b) permit allowed: a plain nested repo and a nested linked worktree move out losslessly", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const plain = join(wt.worktreePath, "paired", "plain");
			nestedRepo(plain, "plain");
			const hostRepo = join(tempDir("fly2901-nested-host-"), "host");
			nestedRepo(hostRepo, "host");
			git(hostRepo, "stash", "--quiet", "--include-untracked");
			const linked = join(wt.worktreePath, "paired", "linked");
			git(hostRepo, "worktree", "add", "--quiet", "-b", "feature", linked);
			git(linked, "config", "user.name", "Nested");
			git(linked, "config", "user.email", "nested@flywheel.local");
			commitIn(linked, "feature.txt", "unpushed\n", "unpushed nested commit");
			writeFileSync(join(linked, "feature.txt"), "unpushed\ndirty\n");
			const plainBefore = nestedIdentity(plain);
			const linkedBefore = nestedIdentity(linked);
			const rec = memoryRecorder();

			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(input(repo, rec.recorder)),
			);

			const moves = result.evidence.manifest.nestedMoves;
			expect(result.evidence.manifest.class).toBe("nested_repo");
			expect(moves.map((m) => [m.relPath, m.mode])).toEqual([
				["paired/linked", "worktree_move"],
				["paired/plain", "rename"],
			]);
			expect(existsSync(plain)).toBe(false);
			expect(existsSync(linked)).toBe(false);
			const movedPlain = moves.find((m) => m.relPath === "paired/plain")!;
			const movedLinked = moves.find((m) => m.relPath === "paired/linked")!;
			expect(movedPlain.destination).toBe(
				join(
					repo.stateDir,
					"takeover-rescue",
					"run-2901",
					"succ-exec-33334444",
					result.evidence.manifest.stamp,
					"nested",
					"paired",
					"plain",
				),
			);
			expect(nestedIdentity(movedPlain.destination)).toEqual(plainBefore);
			expect(nestedIdentity(movedLinked.destination)).toEqual(linkedBefore);
			expect(gitRaw(hostRepo, "worktree", "list", "--porcelain")).toContain(
				`worktree ${movedLinked.destination}\n`,
			);
			expect(git(wt.worktreePath, "status", "--porcelain")).toBe("");
			expect(result.evidence.manifest.rescues).toEqual([]);
		});

		it("a nested repo whose relative path is manifest.json lands under nested/, never clobbering the manifest", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			nestedRepo(join(wt.worktreePath, "manifest.json"), "tricky");
			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
			);
			const move = result.evidence.manifest.nestedMoves[0]!;
			expect(move.destination.endsWith(join("nested", "manifest.json"))).toBe(
				true,
			);
			expect(readFileSync(result.evidence.manifestPath, "utf8")).toContain(
				'"schema":"fly-2901.takeover-rescue.v1"',
			);
		});

		it("a nested target under .flywheel/review-targets/ is excluded, never dirty, and stays in place", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const target = join(
				wt.worktreePath,
				".flywheel",
				"review-targets",
				"other",
			);
			nestedRepo(target, "review");
			const before = nestedIdentity(target);
			const rec = memoryRecorder();
			const result = await repo.manager.runTakeoverTransaction(
				input(repo, rec.recorder),
			);
			expect(result.kind).toBe("reused");
			expect(nestedIdentity(target)).toEqual(before);
			expect(rec.events).toEqual([]);
		});

		it("upgrade: an old exclude missing the review-targets line is repaired first (third-party lines kept), so the target is not moved", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const excludePath = join(repo.root, ".git", "info", "exclude");
			writeFileSync(
				excludePath,
				"# third-party\n*.local-only\n.flywheel/runs/\n",
			);
			const target = join(
				wt.worktreePath,
				".flywheel",
				"review-targets",
				"other",
			);
			nestedRepo(target, "review");
			const result = await repo.manager.runTakeoverTransaction(
				input(repo, memoryRecorder().recorder),
			);
			expect(result.kind).toBe("reused");
			expect(existsSync(target)).toBe(true);
			const lines = readFileSync(excludePath, "utf8").split("\n");
			expect(lines).toEqual(
				expect.arrayContaining([
					"# third-party",
					"*.local-only",
					".flywheel/runs/",
					".flywheel/review-targets/",
				]),
			);
			expect(lines.filter((line) => line === ".flywheel/runs/")).toHaveLength(
				1,
			);
		});

		it("an untracked directory outside the two excluded dirs is still dirty (exclude not widened)", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			mkdirSync(join(wt.worktreePath, ".flywheel", "scratch"), {
				recursive: true,
			});
			writeFileSync(
				join(wt.worktreePath, ".flywheel", "scratch", "notes.txt"),
				"n\n",
			);
			const refused = expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, { permit: LIVE_WRITER }),
				),
				"permit_denied:live_writer",
			);
			expect(refused.dirtyPaths).toEqual([".flywheel/scratch/notes.txt"]);
		});
	},
);

describe(
	"WorktreeManager.runTakeoverTransaction — entry matrix",
	{ timeout: 180_000 },
	() => {
		it("worktree_missing: rebuilds at L with the carried generation after pushing L to -head", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const L = commitIn(
				wt.worktreePath,
				"unpushed.txt",
				"unpushed\n",
				"unpushed work",
			);
			rmSync(wt.worktreePath, { recursive: true, force: true });
			const rec = memoryRecorder();
			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(input(repo, rec.recorder)),
			);
			const manifest = result.evidence.manifest;
			expect(manifest.class).toBe("worktree_missing");
			expect(manifest.target).toBe(L);
			expect(manifest.generationBefore).toBe(wt.generation);
			expect(manifest.generationCarried).toBe(true);
			expect(result.worktree.generation).toBe(wt.generation);
			expect(git(wt.worktreePath, "rev-parse", "HEAD")).toBe(L);
			const head = manifest.rescues.find((r) => r.kind === "head")!;
			expect(remoteTip(repo, head.remoteBranch)).toBe(L);
		});

		it("worktree_missing with L == R diverged from the stale S keeps L and rescues S (directory-loss FLY-2463)", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const staleS = commitIn(repo.root, "stale.txt", "stale\n", "stale base");
			const L = commitIn(
				wt.worktreePath,
				"rebased.txt",
				"rebased\n",
				"published",
			);
			git(
				repo.root,
				"push",
				"--quiet",
				"origin",
				`${L}:refs/heads/${wt.branch}`,
			);
			rmSync(wt.worktreePath, { recursive: true, force: true });
			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, { startPoint: staleS }),
				),
			);
			expect(result.evidence.manifest.target).toBe(L);
			expect(
				result.evidence.manifest.rescues.map((r) => [r.kind, r.tip]),
			).toEqual([["base", staleS]]);
			expect(result.worktree.generation).toBe(wt.generation);
		});

		it("unregistered_present: an orphan directory is refused (never rm -rf), even with the kill switch on", async () => {
			const repo = seed();
			const expected = repo.manager.expectedWorktree(
				repo.root,
				"flywheel",
				"FLY-2901",
			);
			mkdirSync(expected.path, { recursive: true });
			writeFileSync(join(expected.path, "orphan.txt"), "precious\n");
			for (const rescueDisabled of [false, true]) {
				const refused = expectRefused(
					await repo.manager.runTakeoverTransaction(
						input(repo, memoryRecorder().recorder, { rescueDisabled }),
					),
					"unregistered_present",
				);
				expect(refused.dirtyPaths).toEqual([expected.path]);
				expect(readFileSync(join(expected.path, "orphan.txt"), "utf8")).toBe(
					"precious\n",
				);
			}
		});

		it("unregistered + absent with unique local branch commits: kill switch refuses and keeps the branch", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const L = commitIn(wt.worktreePath, "unique.txt", "unique\n", "unique");
			git(repo.root, "worktree", "remove", "--force", wt.worktreePath);
			const refused = expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, { rescueDisabled: true }),
				),
				"unregistered_branch_unique_commits",
			);
			expect(refused.detail).toContain("kill_switch");
			expect(git(repo.root, "rev-parse", `refs/heads/${wt.branch}`)).toBe(L);
		});

		it("unregistered + absent with unique local branch commits: rescues L before today's fresh create", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const L = commitIn(wt.worktreePath, "unique.txt", "unique\n", "unique");
			git(repo.root, "worktree", "remove", "--force", wt.worktreePath);
			const result = expectRescued(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
			);
			expect(result.evidence.manifest.class).toBe("unregistered_branch");
			expect(result.evidence.manifest.generationBefore).toBeNull();
			const head = result.evidence.manifest.rescues[0]!;
			expect([head.kind, head.tip]).toEqual(["head", L]);
			expect(remoteTip(repo, head.remoteBranch)).toBe(L);
			expect(git(wt.worktreePath, "rev-parse", "HEAD")).toBe(repo.base);
			expect(result.worktree.generation).not.toBe(wt.generation);
		});

		it("unregistered + absent without a unique branch keeps today's create path", async () => {
			const repo = seed();
			const rec = memoryRecorder();
			const result = await repo.manager.runTakeoverTransaction(
				input(repo, rec.recorder),
			);
			expect(result.kind).toBe("created");
			expect(rec.events).toEqual([]);
		});

		it("registration_indeterminate: a failing worktree list refuses before any prune/create", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			writeFileSync(join(wt.worktreePath, "dirty.txt"), "d\n");
			const failing = new WorktreeManager(
				{
					baseDir: repo.baseDir,
					withRepoLock: repo.lock.withRepoLock,
					takeoverRescueStateDir: join(repo.stateDir, "takeover-rescue"),
				},
				async (cmd, args, cwd, options) => {
					if (args.includes("worktree") && args.includes("list")) {
						throw new Error("injected list failure");
					}
					return {
						stdout: execFileSync(cmd, args, {
							cwd,
							env: options?.env,
							encoding: "utf8",
						}),
					};
				},
			);
			expectRefused(
				await failing.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
				"registration_indeterminate",
			);
			expect(existsSync(join(wt.worktreePath, "dirty.txt"))).toBe(true);
		});

		it("worktree_head_unreadable: a corrupted gitfile refuses without touching the directory", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			writeFileSync(
				join(wt.worktreePath, ".git"),
				"gitdir: /nonexistent/fly2901\n",
			);
			writeFileSync(join(wt.worktreePath, "keep.txt"), "k\n");
			const before = treeBytes(wt.worktreePath);
			expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
				"worktree_head_unreadable",
			);
			expect(treeBytes(wt.worktreePath)).toEqual(before);
		});
	},
);

function crashAt(step: TakeoverStep) {
	return (current: TakeoverStep) => {
		if (current === step) throw new Error(`crash_at_${step}`);
	};
}

/** Dirty tree with staged + unstaged + untracked content on top of H == S. */
async function dirtyShared(repo: Repo) {
	const wt = await sharedWorktree(repo);
	const dir = wt.worktreePath;
	writeFileSync(join(dir, "tracked.txt"), "staged\n");
	git(dir, "add", "tracked.txt");
	writeFileSync(join(dir, "tracked.txt"), "staged\nunstaged\n");
	writeFileSync(join(dir, "untracked.txt"), "untracked\n");
	return { wt, dir, before: captureState(dir) };
}

describe(
	"WorktreeManager.runTakeoverTransaction — stop reasons leave bytes untouched",
	{ timeout: 180_000 },
	() => {
		it("remote_not_ancestor: the remote branch carries work the target lacks", async () => {
			const repo = seed();
			const { wt, dir } = await dirtyShared(repo);
			const scratch = join(tempDir("fly2901-remote-"), "clone");
			execFileSync("git", ["clone", "--quiet", repo.origin, scratch]);
			git(scratch, "config", "user.name", "Other");
			git(scratch, "config", "user.email", "other@flywheel.local");
			commitIn(scratch, "remote-only.txt", "remote\n", "remote only");
			git(scratch, "push", "--quiet", "origin", `HEAD:refs/heads/${wt.branch}`);
			const before = treeBytes(dir);
			expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
				"remote_not_ancestor",
			);
			expect(treeBytes(dir)).toEqual(before);
		});

		it("rescue_push_failed: origin rejects the rescue branch", async () => {
			const repo = seed();
			const { dir } = await dirtyShared(repo);
			const hook = join(repo.origin, "hooks", "pre-receive");
			writeFileSync(hook, "#!/bin/sh\necho rejected >&2\nexit 1\n");
			chmodSync(hook, 0o755);
			const before = treeBytes(dir);
			expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
				"rescue_push_failed",
			);
			expect(treeBytes(dir)).toEqual(before);
		});

		it("rescue_event_unrecorded: event write failure stops before any destructive step, rescue kept", async () => {
			const repo = seed();
			const { dir, before } = await dirtyShared(repo);
			const rec = memoryRecorder();
			rec.failRescue(true);
			const refused = expectRefused(
				await repo.manager.runTakeoverTransaction(input(repo, rec.recorder)),
				"rescue_event_unrecorded",
			);
			expect(captureState(dir)).toEqual(before);
			expect(refused.completedRescues).toHaveLength(1);
			expect(remoteTip(repo, refused.completedRescues[0]!.remoteBranch)).toBe(
				refused.completedRescues[0]!.tip,
			);
		});

		it("git_operation_in_progress / unmerged index: a conflicted merge is never snapshotted or cleaned", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const dir = wt.worktreePath;
			git(repo.root, "checkout", "--quiet", "-b", "other");
			commitIn(repo.root, "tracked.txt", "theirs\n", "theirs");
			git(repo.root, "checkout", "--quiet", "main");
			commitIn(dir, "tracked.txt", "ours\n", "ours");
			try {
				git(dir, "merge", "--quiet", "--no-edit", "other");
			} catch {
				// conflict expected
			}
			const before = treeBytes(dir);
			const S = git(dir, "rev-parse", "HEAD");
			expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, { startPoint: S }),
				),
				"git_operation_in_progress",
			);
			rmSync(
				git(
					dir,
					"rev-parse",
					"--path-format=absolute",
					"--git-path",
					"MERGE_HEAD",
				),
			);
			expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, { startPoint: S }),
				),
				"quarantine_overflow:unrepresentable_index",
			);
			expect(treeBytes(dir)).toEqual(before);
		});

		it("quarantine_overflow: over-limit state is refused", async () => {
			const repo = seed();
			const { dir, before } = await dirtyShared(repo);
			expectRefused(
				await repo.manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder, {
						limits: { maxFiles: 1, maxBytes: 1024 * 1024 },
					}),
				),
				"quarantine_overflow:file_limit",
			);
			expect(captureState(dir)).toEqual(before);
		});

		it("worktree_unstable: a same-size same-mtime rewrite during the wait is caught by content", async () => {
			const repo = seed();
			const { dir } = await dirtyShared(repo);
			const file = join(dir, "untracked.txt");
			const result = await repo.manager.runTakeoverTransaction(
				input(repo, memoryRecorder().recorder, {
					onStep: (step) => {
						if (step !== "fingerprinted") return;
						const stat = lstatSync(file);
						writeFileSync(file, "UNTRACKED\n");
						utimesSync(file, stat.atime, stat.mtime);
					},
				}),
			);
			expectRefused(result, "worktree_unstable");
			expect(readFileSync(file, "utf8")).toBe("UNTRACKED\n");
		});
	},
);

describe(
	"WorktreeManager.runTakeoverTransaction — crash re-entry",
	{ timeout: 180_000 },
	() => {
		for (const step of [
			"event_recorded",
			"clean_done",
			"mirror_written",
		] as const) {
			it(`converges after a crash at ${step}`, async () => {
				const repo = seed();
				const { dir, before } = await dirtyShared(repo);
				const rec = memoryRecorder();
				await expect(
					repo.manager.runTakeoverTransaction(
						input(repo, rec.recorder, { onStep: crashAt(step) }),
					),
				).rejects.toThrow(`crash_at_${step}`);
				const rerun = expectRescued(
					await repo
						.makeManager()
						.runTakeoverTransaction(input(repo, rec.recorder)),
				);
				expect(rerun.evidence.resumed).toBe(true);
				expect(git(dir, "status", "--porcelain")).toBe("");
				expect(rec.events.map((event) => event.kind)).toEqual([
					"rescued",
					"cleaned",
				]);
				const snap = rerun.evidence.manifest.snapshot!;
				const scratch = restoreFromRescue(
					repo,
					repo.base,
					snap.stagedCommit,
					snap.worktreeCommit,
				);
				expect(captureState(scratch)).toEqual(before);
			});
		}

		it("a crash before the event leaves no pending rescue; the rerun preserves afresh", async () => {
			const repo = seed();
			const { before } = await dirtyShared(repo);
			const rec = memoryRecorder();
			await expect(
				repo.manager.runTakeoverTransaction(
					input(repo, rec.recorder, { onStep: crashAt("manifest_written") }),
				),
			).rejects.toThrow("crash_at_manifest_written");
			expect(rec.events).toEqual([]);
			const rerun = expectRescued(
				await repo.makeManager().runTakeoverTransaction(
					input(repo, rec.recorder, {
						now: () => new Date(Date.now() + 2_000),
					}),
				),
			);
			expect(rerun.evidence.resumed).toBe(false);
			const snap = rerun.evidence.manifest.snapshot!;
			const scratch = restoreFromRescue(
				repo,
				repo.base,
				snap.stagedCommit,
				snap.worktreeCommit,
			);
			expect(captureState(scratch)).toEqual(before);
		});

		it("a crash between reset and clean stops with rescue_resume_mismatch and loses nothing", async () => {
			const repo = seed();
			const { before } = await dirtyShared(repo);
			const rec = memoryRecorder();
			await expect(
				repo.manager.runTakeoverTransaction(
					input(repo, rec.recorder, { onStep: crashAt("reset_done") }),
				),
			).rejects.toThrow("crash_at_reset_done");
			expectRefused(
				await repo
					.makeManager()
					.runTakeoverTransaction(input(repo, rec.recorder)),
				"rescue_resume_mismatch",
			);
			const payload = rec.events[0]!.payload as TakeoverRescueEventPayload;
			const manifest = JSON.parse(readFileSync(payload.manifestPath, "utf8"));
			const scratch = restoreFromRescue(
				repo,
				repo.base,
				manifest.snapshot.stagedCommit,
				manifest.snapshot.worktreeCommit,
			);
			expect(captureState(scratch)).toEqual(before);
		});

		it("cleaned-receipt failure: the next attempt only adds the mirror + receipt", async () => {
			const repo = seed();
			const { dir } = await dirtyShared(repo);
			const rec = memoryRecorder();
			rec.failCleaned(true);
			const refused = expectRefused(
				await repo.manager.runTakeoverTransaction(input(repo, rec.recorder)),
				"rescue_event_unrecorded",
			);
			expect(refused.detail).toMatch(/^cleaned:/);
			expect(git(dir, "status", "--porcelain")).toBe("");
			rec.failCleaned(false);
			const rerun = expectRescued(
				await repo
					.makeManager()
					.runTakeoverTransaction(input(repo, rec.recorder)),
			);
			expect(rerun.evidence.resumed).toBe(true);
			expect(rec.events.map((event) => event.kind)).toEqual([
				"rescued",
				"cleaned",
			]);
		});

		for (const tamper of [false, true]) {
			it(`manifest integrity: ${tamper ? "a one-byte change is refused before destruction" : "the untouched file re-enters"}`, async () => {
				const repo = seed();
				const { dir } = await dirtyShared(repo);
				const rec = memoryRecorder();
				await expect(
					repo.manager.runTakeoverTransaction(
						input(repo, rec.recorder, { onStep: crashAt("event_recorded") }),
					),
				).rejects.toThrow();
				const payload = rec.events[0]!.payload as TakeoverRescueEventPayload;
				if (tamper) {
					const bytes = readFileSync(payload.manifestPath);
					const index = bytes.indexOf(Buffer.from('"class":"dirty"')) + 9;
					bytes[index] = "D".charCodeAt(0);
					writeFileSync(payload.manifestPath, bytes);
				}
				const before = treeBytes(dir);
				const result = await repo
					.makeManager()
					.runTakeoverTransaction(input(repo, rec.recorder));
				if (tamper) {
					const refused = expectRefused(result, "rescue_resume_mismatch");
					expect(refused.detail).toBe("manifest_digest_mismatch");
					expect(treeBytes(dir)).toEqual(before);
				} else {
					expect(expectRescued(result).evidence.resumed).toBe(true);
				}
			});
		}

		it("worktree_missing crash after prune: the rerun recreates with the carried generation", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const L = commitIn(wt.worktreePath, "unpushed.txt", "u\n", "unpushed");
			rmSync(wt.worktreePath, { recursive: true, force: true });
			const rec = memoryRecorder();
			await expect(
				repo.manager.runTakeoverTransaction(
					input(repo, rec.recorder, { onStep: crashAt("pruned") }),
				),
			).rejects.toThrow("crash_at_pruned");
			const rerun = expectRescued(
				await repo
					.makeManager()
					.runTakeoverTransaction(input(repo, rec.recorder)),
			);
			expect(rerun.evidence.resumed).toBe(true);
			expect(rerun.worktree.generation).toBe(wt.generation);
			expect(git(wt.worktreePath, "rev-parse", "HEAD")).toBe(L);
		});

		for (const fault of ["post_add_exclude", "hooks", "generation"] as const) {
			it(`worktree_missing: a create() failure at ${fault} still leaves L on a verified rescue ref`, async () => {
				const repo = seed();
				const wt = await sharedWorktree(repo);
				const L = commitIn(wt.worktreePath, "unpushed.txt", "u\n", "unpushed");
				rmSync(wt.worktreePath, { recursive: true, force: true });
				const rec = memoryRecorder();
				const faulty = repo.makeManager({
					baseDir: repo.baseDir,
					createFaultHook: (step) => {
						if (step === fault) throw new Error(`fault_${fault}`);
					},
				});
				await expect(
					faulty.runTakeoverTransaction(input(repo, rec.recorder)),
				).rejects.toThrow(`fault_${fault}`);
				const payload = rec.events[0]!.payload as TakeoverRescueEventPayload;
				const head = payload.rescues.find((r) => r.kind === "head")!;
				expect(head.tip).toBe(L);
				expect(remoteTip(repo, head.remoteBranch)).toBe(L);
			});
		}
	},
);

describe(
	"WorktreeManager.runTakeoverTransaction — repo lock",
	{ timeout: 180_000 },
	() => {
		it("a same-repo remove queued during the transaction runs only after it finishes", async () => {
			const repo = seed();
			const { dir } = await dirtyShared(repo);
			const order: string[] = [];
			let removal: Promise<unknown> | undefined;
			const result = await repo.manager.runTakeoverTransaction(
				input(repo, memoryRecorder().recorder, {
					onStep: (step) => {
						if (step !== "event_recorded") return;
						removal = repo.lock.outsideLock(() =>
							repo.manager
								.removeIfExists(repo.root, "flywheel", "FLY-2901")
								.then(() => order.push("removed")),
						);
					},
				}),
			);
			order.push("transaction_done");
			expectRescued(result);
			await removal;
			expect(order).toEqual(["transaction_done", "removed"]);
			expect(existsSync(dir)).toBe(false);
		});

		it("without an injected repo lock, a rescue is refused (never destructive unlocked)", async () => {
			const repo = seed();
			const { dir, before } = await dirtyShared(repo);
			const unlocked = new WorktreeManager({
				baseDir: repo.baseDir,
				takeoverRescueStateDir: join(repo.stateDir, "takeover-rescue"),
			});
			expectRefused(
				await unlocked.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
				"repo_lock_unavailable",
			);
			expect(captureState(dir)).toEqual(before);
		});

		it("without the Bridge-local recorder every shared takeover refuses — dirty, clean reuse, and fresh create alike", async () => {
			const repo = seed();
			const { dir, before } = await dirtyShared(repo);
			expectRefused(
				await repo.manager.runTakeoverTransaction(input(repo, undefined)),
				"rescue_event_capability_missing",
			);
			expect(captureState(dir)).toEqual(before);
			git(dir, "reset", "--quiet", "--hard");
			git(dir, "clean", "-fdq");
			expectRefused(
				await repo.manager.runTakeoverTransaction(input(repo, undefined)),
				"rescue_event_capability_missing",
			);
			const fresh = seed();
			expectRefused(
				await fresh.manager.runTakeoverTransaction(input(fresh, undefined)),
				"rescue_event_capability_missing",
			);
			const expected = fresh.manager.expectedWorktree(
				fresh.root,
				"flywheel",
				"FLY-2901",
			);
			expect(existsSync(expected.path)).toBe(false);
		});
	},
);

/** Real git, except commands matched by `inject` (throw) or `before` (side effect first). */
function execWith(opts: {
	inject?: (args: string[]) => boolean;
	before?: (args: string[]) => void;
}): WorktreeExecFn {
	return async (cmd, args, cwd, options) => {
		if (opts.inject?.(args)) throw new Error("injected git failure");
		opts.before?.(args);
		return {
			stdout: execFileSync(cmd, args, {
				cwd,
				env: options?.env ?? process.env,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		};
	};
}

const OVERSIZED_GIT_OUTPUT_BYTES = 1024 * 1024 + 1;

/**
 * Keep every Git behavior real, but make the takeover index-membership probe
 * cross Node's default one-MiB child-output ceiling.
 */
function useOversizedCachedIndexProbe(): void {
	const realGit = process.env.PATH?.split(delimiter)
		.map((entry) => join(entry, "git"))
		.find((entry) => existsSync(entry));
	if (!realGit) throw new Error("git_not_found_on_path");
	const fakeBin = tempDir("fly2941-large-git-");
	const fakeGit = join(fakeBin, "git");
	writeFileSync(
		fakeGit,
		[
			"#!/bin/sh",
			'case " $* " in',
			'  *" ls-files -z --cached -v "*)',
			`    ${JSON.stringify(realGit)} "$@" || exit $?`,
			`    exec ${JSON.stringify(process.execPath)} -e 'process.stdout.write("H " + "x".repeat(${OVERSIZED_GIT_OUTPUT_BYTES}) + "\\0")'`,
			"    ;;",
			`  *) exec ${JSON.stringify(realGit)} "$@" ;;`,
			"esac",
		].join("\n"),
	);
	chmodSync(fakeGit, 0o700);
	vi.stubEnv("PATH", `${fakeBin}${delimiter}${process.env.PATH ?? ""}`);
}

function probesLocalBranch(branch: string) {
	return (args: string[]) =>
		(args.includes("rev-parse") || args.includes("for-each-ref")) &&
		args.some((arg) => arg.startsWith(`refs/heads/${branch}`));
}

describe(
	"WorktreeManager.runTakeoverTransaction — Codex R1 fixes",
	{ timeout: 180_000 },
	() => {
		it("an indeterminate local-branch probe refuses before today's create path can drop unique commits (unregistered + absent)", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const L = commitIn(wt.worktreePath, "unique.txt", "unique\n", "unique");
			git(repo.root, "worktree", "remove", "--force", wt.worktreePath);
			const manager = new WorktreeManager(
				{
					baseDir: repo.baseDir,
					withRepoLock: repo.lock.withRepoLock,
					takeoverRescueStateDir: join(repo.stateDir, "takeover-rescue"),
				},
				execWith({ inject: probesLocalBranch(wt.branch) }),
			);
			const refused = expectRefused(
				await manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
				"registration_indeterminate",
			);
			expect(refused.detail).toMatch(/^local_branch_probe/);
			expect(git(repo.root, "rev-parse", `refs/heads/${wt.branch}`)).toBe(L);
			expect(existsSync(wt.worktreePath)).toBe(false);
		});

		it("an indeterminate local-branch probe refuses a worktree_missing rebuild (no prune, branch kept)", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			const L = commitIn(wt.worktreePath, "unique.txt", "unique\n", "unique");
			rmSync(wt.worktreePath, { recursive: true, force: true });
			const manager = new WorktreeManager(
				{
					baseDir: repo.baseDir,
					withRepoLock: repo.lock.withRepoLock,
					takeoverRescueStateDir: join(repo.stateDir, "takeover-rescue"),
				},
				execWith({ inject: probesLocalBranch(wt.branch) }),
			);
			expectRefused(
				await manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
				"registration_indeterminate",
			);
			expect(git(repo.root, "rev-parse", `refs/heads/${wt.branch}`)).toBe(L);
			expect(gitRaw(repo.root, "worktree", "list", "--porcelain")).toContain(
				`worktree ${wt.worktreePath}\n`,
			);
		});

		it("capability absent on re-entry after prune: refuses instead of a fresh-generation create", async () => {
			const repo = seed();
			const wt = await sharedWorktree(repo);
			commitIn(wt.worktreePath, "unpushed.txt", "u\n", "unpushed");
			rmSync(wt.worktreePath, { recursive: true, force: true });
			const rec = memoryRecorder();
			await expect(
				repo.manager.runTakeoverTransaction(
					input(repo, rec.recorder, { onStep: crashAt("pruned") }),
				),
			).rejects.toThrow("crash_at_pruned");
			expectRefused(
				await repo.makeManager().runTakeoverTransaction(input(repo, undefined)),
				"rescue_event_capability_missing",
			);
			expect(existsSync(wt.worktreePath)).toBe(false);
		});

		it("capability absent after clean but before the receipt: refuses instead of ordinary reuse", async () => {
			const repo = seed();
			const { dir } = await dirtyShared(repo);
			const rec = memoryRecorder();
			rec.failCleaned(true);
			expectRefused(
				await repo.manager.runTakeoverTransaction(input(repo, rec.recorder)),
				"rescue_event_unrecorded",
			);
			expect(git(dir, "status", "--porcelain")).toBe("");
			expectRefused(
				await repo
					.makeManager()
					.runTakeoverTransaction(input(repo, undefined, { runId: undefined })),
				"rescue_event_capability_missing",
			);
		});

		it("rescue pushes are create-only: a racing ancestor-valued remote ref is never fast-forwarded", async () => {
			const repo = seed();
			await dirtyShared(repo);
			let raced: string | undefined;
			const manager = new WorktreeManager(
				{
					baseDir: repo.baseDir,
					withRepoLock: repo.lock.withRepoLock,
					takeoverRescueStateDir: join(repo.stateDir, "takeover-rescue"),
				},
				execWith({
					before: (args) => {
						if (!args.includes("push") || raced) return;
						const spec = args.find((arg) =>
							arg.includes(":refs/heads/flywheel-rescue/"),
						);
						raced = spec?.slice(spec.indexOf(":") + 1);
						if (raced) git(repo.origin, "update-ref", raced, repo.base);
					},
				}),
			);
			expectRefused(
				await manager.runTakeoverTransaction(
					input(repo, memoryRecorder().recorder),
				),
				"rescue_push_failed",
			);
			expect(raced).toBeDefined();
			expect(git(repo.origin, "rev-parse", raced!)).toBe(repo.base);
		});
	},
);

describe("snapshot baseline during remote probe", { timeout: 180_000 }, () => {
	function mutateDuringProbe(repo: Repo, mutate: () => void) {
		let mutated = false;
		return new WorktreeManager(
			{
				baseDir: repo.baseDir,
				withRepoLock: repo.lock.withRepoLock,
				takeoverRescueStateDir: join(repo.stateDir, "takeover-rescue"),
			},
			execWith({
				before: (args) => {
					if (
						mutated ||
						!args.includes("ls-remote") ||
						!args.includes("--heads")
					)
						return;
					mutated = true;
					mutate();
				},
			}),
		);
	}

	it.each(["tracked", "untracked", "head"] as const)(
		"refuses a new %s change between classification and the first fingerprint without losing work",
		async (change) => {
			const repo = seed();
			const { worktreePath: dir } = await sharedWorktree(repo);
			writeFileSync(join(dir, "early.txt"), "early dirty bytes\n");
			const rec = memoryRecorder();
			let afterMutation: ReturnType<typeof captureState> | undefined;
			let afterHead: string | undefined;
			const manager = mutateDuringProbe(repo, () => {
				if (change === "head") {
					commitIn(dir, "tracked.txt", "late committed bytes\n", "late commit");
				} else {
					writeFileSync(
						join(
							dir,
							change === "tracked" ? "tracked.txt" : "late-untracked.txt",
						),
						"late unpublished bytes\n",
					);
				}
				afterMutation = captureState(dir);
				afterHead = git(dir, "rev-parse", "HEAD");
			});
			const result = await manager.runTakeoverTransaction(
				input(repo, rec.recorder),
			);
			expect(afterMutation).toBeDefined();
			expect(result.kind).toBe("refused");
			expectRefused(result, "worktree_unstable");
			expect(captureState(dir)).toEqual(afterMutation);
			expect(git(dir, "rev-parse", "HEAD")).toBe(afterHead);
			expect(rec.events).toEqual([]);
			for (const root of [repo.root, repo.origin]) {
				expect(
					git(
						root,
						"for-each-ref",
						"--format=%(refname)",
						"refs/heads/flywheel-rescue/",
						"refs/flywheel/rescue/",
					),
				).toBe("");
			}
		},
	);

	it("preserves a rewrite of an already dirty path sampled by all three fingerprints", async () => {
		const repo = seed();
		const { worktreePath: dir } = await sharedWorktree(repo);
		writeFileSync(join(dir, "early.txt"), "early dirty bytes\n");
		let afterMutation: ReturnType<typeof captureState> | undefined;
		const manager = mutateDuringProbe(repo, () => {
			writeFileSync(join(dir, "early.txt"), "latest dirty bytes\n");
			afterMutation = captureState(dir);
		});
		const result = expectRescued(
			await manager.runTakeoverTransaction(
				input(repo, memoryRecorder().recorder),
			),
		);
		expect(afterMutation).toBeDefined();
		const snapshot = result.evidence.manifest.snapshot!;
		const scratch = restoreFromRescue(
			repo,
			repo.base,
			snapshot.stagedCommit,
			snapshot.worktreeCommit,
		);
		expect(captureState(scratch)).toEqual(afterMutation);
	});
});

// v5.2: ignored bytes are not in snapshots or fingerprints, so prove their
// preservation against real Git before either preservation or destruction.
describe("v5.2 ignored content guard", { timeout: 180_000 }, () => {
	beforeEach(() => {
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
		vi.stubEnv("XDG_CONFIG_HOME", tempDir("fly2901-xdg-"));
	});
	afterEach(() => vi.unstubAllEnvs());

	function put(dir: string, rel: string, bytes = "unpublished unique bytes\n") {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), bytes);
	}

	async function fixture(rules = "drafts/\n", ignoreName = ".gitignore") {
		const repo = seed();
		const H = commitIn(repo.root, ignoreName, rules, "ignore rules in H");
		const wt = await sharedWorktree(repo, H);
		return { repo, dir: wt.worktreePath, H, rec: memoryRecorder() };
	}
	type Fixture = Awaited<ReturnType<typeof fixture>>;

	async function refused(
		f: Fixture,
		target: string,
		rule: string,
		conflictPath: string,
		manager = f.repo.manager,
	) {
		const before = treeBytes(f.dir);
		const steps: TakeoverStep[] = [];
		const result = expectRefused(
			await manager.runTakeoverTransaction(
				input(f.repo, f.rec.recorder, {
					startPoint: target,
					onStep: (step) => {
						steps.push(step);
					},
				}),
			),
			"ignored_content_at_risk",
		);
		expect(result.detail).toContain(`(${rule})`);
		expect(result.detail).toContain(conflictPath);
		expect(treeBytes(f.dir)).toEqual(before);
		expect(git(f.dir, "rev-parse", "HEAD")).toBe(f.H);
		expect(f.rec.events).toEqual([]);
		expect(steps).toEqual([]);
		expect(result.completedRescues).toEqual([]);
		for (const root of [f.repo.root, f.repo.origin]) {
			expect(
				git(
					root,
					"for-each-ref",
					"--format=%(refname)",
					"refs/heads/flywheel-rescue/",
					"refs/flywheel/rescue/",
				),
			).toBe("");
		}
		expect(existsSync(join(f.repo.stateDir, "takeover-rescue"))).toBe(false);
		return result;
	}

	function dirty(f: Fixture) {
		put(f.dir, "tracked.txt", "dirty ordinary file\n");
	}
	function ahead(f: Fixture) {
		return commitIn(
			f.repo.root,
			"tracked.txt",
			"ahead\n",
			"ordinary target change",
		);
	}

	it("rescues a dirty worktree when the cached-index probe exceeds one MiB", async () => {
		const f = await fixture("# base\n");
		dirty(f);
		useOversizedCachedIndexProbe();

		const result = expectRescued(
			await f.repo.manager.runTakeoverTransaction(
				input(f.repo, f.rec.recorder, { startPoint: f.H }),
			),
		);

		expect(result.evidence.manifest.class).toBe("dirty");
		expect(git(f.dir, "status", "--porcelain")).toBe("");
	});

	it("still refuses a hidden index flag when the cached-index probe exceeds one MiB", async () => {
		const f = await fixture("# base\n");
		git(f.dir, "update-index", "--skip-worktree", ".gitignore");
		put(f.dir, ".gitignore", "drafts/\n");
		put(f.dir, "drafts/unpublished.md");
		dirty(f);
		useOversizedCachedIndexProbe();

		const result = await refused(f, f.H, "f", ".gitignore");
		expect(result.detail).not.toContain("maxBuffer");
	});

	it("refuses head_behind removing ignore rules before any preservation", async () => {
		const f = await fixture();
		put(f.dir, "drafts/unpublished.md");
		const S = commitIn(f.repo.root, ".gitignore", "", "remove ignore rule");
		await refused(f, S, "d", ".gitignore");
	});

	it.each(["drafts/unpublished.md", 'drafts/unpublished\nquoted".md'])(
		"refuses target tracking an ignored file with NUL-safe path %j",
		async (file) => {
			const f = await fixture();
			put(f.dir, file);
			put(f.repo.root, file, "target bytes\n");
			git(f.repo.root, "add", "-f", "--", file);
			git(f.repo.root, "commit", "-qm", "track ignored path");
			await refused(
				f,
				git(f.repo.root, "rev-parse", "HEAD"),
				"b",
				JSON.stringify(file).slice(1, -1),
			);
		},
	);

	it("rechecks after rescue-event crash before reset when ignored bytes appear", async () => {
		const f = await fixture();
		put(f.repo.root, "drafts/unpublished.md", "target bytes\n");
		git(f.repo.root, "add", "-f", "drafts/unpublished.md");
		git(f.repo.root, "commit", "-qm", "track ignored path");
		const S = git(f.repo.root, "rev-parse", "HEAD");
		await expect(
			f.repo.manager.runTakeoverTransaction(
				input(f.repo, f.rec.recorder, {
					startPoint: S,
					onStep: crashAt("event_recorded"),
				}),
			),
		).rejects.toThrow();
		put(f.dir, "drafts/unpublished.md");
		const before = treeBytes(f.dir);
		const steps: TakeoverStep[] = [];
		const result = expectRefused(
			await f.repo.manager.runTakeoverTransaction(
				input(f.repo, f.rec.recorder, {
					startPoint: S,
					onStep: (step) => {
						steps.push(step);
					},
				}),
			),
			"ignored_content_at_risk",
		);
		expect(result.detail).toContain("(b)");
		expect(treeBytes(f.dir)).toEqual(before);
		expect(git(f.dir, "rev-parse", "HEAD")).toBe(f.H);
		expect(steps).toEqual([]);
		expect(f.rec.events.map((e) => e.kind)).toEqual(["rescued"]);
	});

	it.each([false, true])(
		"refuses working ignore-rule changes with head_behind=%s",
		async (behind) => {
			const f = await fixture("# base\n");
			put(f.dir, ".gitignore", "drafts/\n");
			put(f.dir, "drafts/unpublished.md");
			await refused(f, behind ? ahead(f) : f.H, "d", ".gitignore");
		},
	);

	it.each(["paired", ".flywheel/runs", ".flywheel/review-targets"])(
		"refuses target negation for %s without safe-root exemption",
		async (dir) => {
			const f = await fixture(`/${dir}/\n`);
			put(f.dir, `${dir}/unpublished.md`);
			const S = commitIn(
				f.repo.root,
				".gitignore",
				`/${dir}/\n!/${dir}/\n`,
				"negate ignore rule",
			);
			await refused(f, S, "d", ".gitignore");
		},
	);

	it("refuses case-alias target collision on a case-insensitive filesystem", async (ctx) => {
		const f = await fixture();
		put(f.dir, "case-probe");
		const insensitive = existsSync(join(f.dir, "CASE-PROBE"));
		rmSync(join(f.dir, "case-probe"));
		if (!insensitive) return ctx.skip();
		git(f.repo.root, "config", "core.ignorecase", "true");
		put(f.dir, "drafts/x.md");
		put(f.repo.root, "Drafts/x.md", "target bytes\n");
		git(f.repo.root, "add", "-f", "Drafts/x.md");
		git(f.repo.root, "commit", "-qm", "case alias target");
		await refused(f, git(f.repo.root, "rev-parse", "HEAD"), "b", "Drafts/x.md");
	});

	it.each([false, true])(
		"preserves ignored node_modules and runs bytes with head_behind=%s",
		async (behind) => {
			const f = await fixture("node_modules/\n");
			put(f.dir, "node_modules/local-package/index.js");
			put(f.dir, ".flywheel/runs/private/output.txt");
			const ignored = gitRaw(
				f.dir,
				"ls-files",
				"--others",
				"--ignored",
				"--exclude-standard",
				"-z",
			)
				.split("\0")
				.filter(Boolean);
			expect(ignored).toEqual(
				expect.arrayContaining([
					"node_modules/local-package/index.js",
					".flywheel/runs/private/output.txt",
				]),
			);
			const before = ignored.map((file) => readFileSync(join(f.dir, file)));
			const S = behind ? ahead(f) : f.H;
			if (!behind) dirty(f);
			const result = expectRescued(
				await f.repo.manager.runTakeoverTransaction(
					input(f.repo, f.rec.recorder, { startPoint: S }),
				),
			);
			expect(result.evidence.manifest.target).toBe(S);
			expect(git(f.dir, "status", "--porcelain")).toBe("");
			expect(ignored.map((file) => readFileSync(join(f.dir, file)))).toEqual(
				before,
			);
		},
	);

	it("refuses a tracked file replaced by an ignored directory", async () => {
		const f = await fixture();
		f.H = commitIn(f.dir, "drafts", "tracked file\n", "track file");
		rmSync(join(f.dir, "drafts"));
		put(f.dir, "drafts/unpublished.md");
		await refused(f, f.H, "a", "drafts");
	});

	it("refuses a non-index file occupying a true ancestor of a target path", async () => {
		const f = await fixture("drafts\n");
		put(f.dir, "drafts");
		put(f.repo.root, "drafts/target.txt", "target\n");
		git(f.repo.root, "add", "-f", "drafts/target.txt");
		git(f.repo.root, "commit", "-qm", "target directory");
		await refused(f, git(f.repo.root, "rev-parse", "HEAD"), "c", "drafts");
	});

	it("refuses uppercase .GITIGNORE changes on a case-insensitive filesystem", async (ctx) => {
		const f = await fixture("drafts/\n", ".GITIGNORE");
		if (!existsSync(join(f.dir, ".gitignore"))) return ctx.skip();
		put(f.dir, "drafts/unpublished.md");
		const S = commitIn(
			f.repo.root,
			".GITIGNORE",
			"",
			"remove uppercase ignore rule",
		);
		await refused(f, S, "d", ".GITIGNORE");
	});

	it.each(["--assume-unchanged", "--skip-worktree"])(
		"refuses %s index flags hiding changed rules",
		async (flag) => {
			const f = await fixture("# base\n");
			git(f.dir, "update-index", flag, ".gitignore");
			put(f.dir, ".gitignore", "drafts/\n");
			put(f.dir, "drafts/unpublished.md");
			dirty(f);
			await refused(f, f.H, "f", ".gitignore");
		},
	);

	it("refuses a tracked in-tree configured global excludes file changed by target", async () => {
		const f = await fixture("# base\n");
		f.H = commitIn(f.repo.root, "project.ignore", "drafts/\n", "global rules");
		git(f.dir, "reset", "--hard", f.H);
		git(
			f.repo.root,
			"config",
			"core.excludesFile",
			join(f.dir, "project.ignore"),
		);
		put(f.dir, "drafts/unpublished.md");
		const S = commitIn(
			f.repo.root,
			"project.ignore",
			"",
			"remove global rules",
		);
		await refused(f, S, "e", "project.ignore");
	});

	it.each(["absolute", "relative", "xdg", "missing", "newline"])(
		"refuses %s in-tree global excludes paths",
		async (variant) => {
			const f = await fixture();
			dirty(f);
			const rel =
				variant === "newline" ? "global\nignore" : "global/git/ignore";
			if (variant !== "missing") put(f.dir, rel, "drafts/\n");
			if (variant === "xdg")
				vi.stubEnv("XDG_CONFIG_HOME", join(f.dir, "global"));
			else
				git(
					f.repo.root,
					"config",
					"core.excludesFile",
					variant === "relative" ? rel : join(f.dir, rel),
				);
			put(f.dir, "drafts/unpublished.md");
			await refused(f, f.H, "e", JSON.stringify(rel).slice(1, -1));
		},
	);

	it.each([false, true])(
		"refuses tracked in-tree symlink to outside global rules, outside chain=%s",
		async (outsideChain) => {
			const f = await fixture("# base\n");
			const outside = tempDir("fly2901-outside-ignore-");
			put(outside, "ignore", "drafts/\n");
			symlinkSync(join(outside, "ignore"), join(f.repo.root, "global-ignore"));
			git(f.repo.root, "add", "global-ignore");
			git(f.repo.root, "commit", "-qm", "global symlink");
			f.H = git(f.repo.root, "rev-parse", "HEAD");
			git(f.dir, "reset", "--hard", f.H);
			let configured = join(f.dir, "global-ignore");
			if (outsideChain) {
				symlinkSync(configured, join(outside, "entry"));
				configured = join(outside, "entry");
			}
			git(f.repo.root, "config", "core.excludesFile", configured);
			put(f.dir, "drafts/unpublished.md");
			rmSync(join(f.repo.root, "global-ignore"));
			const S = commitIn(
				f.repo.root,
				"global-ignore",
				"",
				"replace symlink with empty rules",
			);
			await refused(f, S, "e", "global-ignore");
		},
	);

	it("refuses intermediate symlink crossing the worktree before .. leaves it", async () => {
		const f = await fixture();
		const outside = tempDir("fly2901-outside-ignore-");
		symlinkSync(f.dir, join(outside, "entry"));
		git(
			f.repo.root,
			"config",
			"core.excludesFile",
			`${outside}/entry/../nonexistent-ignore`,
		);
		dirty(f);
		await refused(f, f.H, "e", f.dir);
	});

	it("refuses symlink loops and non-directory resolution failures", async () => {
		for (const loop of [true, false]) {
			const f = await fixture();
			const outside = tempDir("fly2901-outside-ignore-");
			if (loop) symlinkSync("entry", join(outside, "entry"));
			else put(outside, "entry");
			git(
				f.repo.root,
				"config",
				"core.excludesFile",
				join(outside, loop ? "entry" : "entry/ignore"),
			);
			dirty(f);
			await refused(f, f.H, "e", "entry");
		}
	});

	it.each(["missing", "prefix-sibling", "outside-symlinks"])(
		"allows external global excludes %s without a false containment match",
		async (variant) => {
			const f = await fixture();
			const outside = `${f.dir}-sibling`;
			mkdirSync(outside);
			let configured = join(outside, "ignore");
			if (variant !== "missing") put(outside, "ignore", "drafts/\n");
			if (variant === "outside-symlinks") {
				symlinkSync("ignore", join(outside, "entry"));
				configured = join(outside, "entry");
			}
			git(f.repo.root, "config", "core.excludesFile", configured);
			put(f.dir, "drafts/unpublished.md");
			dirty(f);
			expectRescued(
				await f.repo.manager.runTakeoverTransaction(
					input(f.repo, f.rec.recorder, { startPoint: f.H }),
				),
			);
			expect(readFileSync(join(f.dir, "drafts/unpublished.md"), "utf8")).toBe(
				"unpublished unique bytes\n",
			);
		},
	);

	it("bounds rule diagnostics to 20 paths plus an overflow count", async () => {
		const f = await fixture();
		for (let i = 0; i < 23; i++) {
			put(f.dir, `drafts/${i}.md`);
			put(f.repo.root, `drafts/${i}.md`, "target\n");
		}
		git(f.repo.root, "add", "-f", "drafts");
		git(f.repo.root, "commit", "-qm", "many collisions");
		const result = await refused(
			f,
			git(f.repo.root, "rev-parse", "HEAD"),
			"b",
			"drafts/0.md",
		);
		expect(result.detail).toContain("…(+3 more)");
		expect(result.detail?.match(/\(b\)/g)).toHaveLength(20);
	});

	it.each(["diff", "ls-files", "config", "check-ignore"])(
		"fails closed on %s command errors",
		async (command) => {
			const f = await fixture();
			put(f.dir, "drafts/unpublished.md");
			put(f.repo.root, "drafts/unpublished.md", "target\n");
			git(f.repo.root, "add", "-f", "drafts/unpublished.md");
			git(f.repo.root, "commit", "-qm", "target collision");
			const manager = new WorktreeManager(
				{
					baseDir: f.repo.baseDir,
					takeoverRescueStateDir: join(f.repo.stateDir, "takeover-rescue"),
					withRepoLock: f.repo.lock.withRepoLock,
				},
				execWith({ inject: (args) => args.includes(command) }),
			);
			const result = expectRefused(
				await manager.runTakeoverTransaction(
					input(f.repo, f.rec.recorder, {
						startPoint: git(f.repo.root, "rev-parse", "HEAD"),
					}),
				),
				"ignored_content_at_risk",
			);
			expect(result.detail).toContain(command);
			expect(readFileSync(join(f.dir, "drafts/unpublished.md"), "utf8")).toBe(
				"unpublished unique bytes\n",
			);
			expect(f.rec.events).toEqual([]);
		},
	);

	it.each(["diff", "ls-files", "config"])(
		"refuses malformed %s probe output",
		async (command) => {
			const f = await fixture();
			dirty(f);
			const execute = execWith({});
			const manager = new WorktreeManager(
				{
					baseDir: f.repo.baseDir,
					takeoverRescueStateDir: join(f.repo.stateDir, "takeover-rescue"),
					withRepoLock: f.repo.lock.withRepoLock,
				},
				async (cmd, args, cwd, options) =>
					args.includes(command)
						? { stdout: "malformed without NUL terminator" }
						: execute(cmd, args, cwd, options),
			);
			await refused(
				f,
				f.H,
				command === "config" ? "e" : command === "ls-files" ? "f" : "a",
				command,
				manager,
			);
		},
	);

	it("rechecks before the first nested move after event recording", async () => {
		const f = await fixture();
		put(f.repo.root, "drafts/unpublished.md", "target bytes\n");
		git(f.repo.root, "add", "-f", "drafts/unpublished.md");
		git(f.repo.root, "commit", "-qm", "target collision");
		put(f.dir, "nested/keep.txt", "nested bytes\n");
		git(join(f.dir, "nested"), "init", "--quiet");
		const steps: TakeoverStep[] = [];
		const result = expectRefused(
			await f.repo.manager.runTakeoverTransaction(
				input(f.repo, f.rec.recorder, {
					startPoint: git(f.repo.root, "rev-parse", "HEAD"),
					onStep: (step) => {
						steps.push(step);
						if (step === "event_recorded") put(f.dir, "drafts/unpublished.md");
					},
				}),
			),
			"ignored_content_at_risk",
		);
		expect(result.detail).toContain("(b)");
		expect(steps).not.toContain("nested_moved");
		expect(steps).not.toContain("reset_done");
		expect(readFileSync(join(f.dir, "nested/keep.txt"), "utf8")).toBe(
			"nested bytes\n",
		);
		expect(readFileSync(join(f.dir, "drafts/unpublished.md"), "utf8")).toBe(
			"unpublished unique bytes\n",
		);
		expect(git(f.dir, "rev-parse", "HEAD")).toBe(f.H);
		expect(f.rec.events.map((e) => e.kind)).toEqual(["rescued"]);
	});

	it("uses exact cached-index membership even with core.ignorecase true", async () => {
		const f = await fixture();
		git(f.repo.root, "config", "core.ignorecase", "true");
		put(f.repo.root, "Drafts/x.md", "tracked base bytes\n");
		git(f.repo.root, "add", "-f", "Drafts/x.md");
		git(f.repo.root, "commit", "-qm", "uppercase index path");
		f.H = git(f.repo.root, "rev-parse", "HEAD");
		git(f.dir, "reset", "--hard", f.H);
		const blob = git(f.repo.root, "rev-parse", "HEAD:Drafts/x.md");
		git(f.repo.root, "update-index", "--force-remove", "Drafts/x.md");
		git(
			f.repo.root,
			"update-index",
			"--add",
			"--cacheinfo",
			`100644,${blob},drafts/x.md`,
		);
		git(f.repo.root, "commit", "-qm", "lowercase target path");
		put(f.dir, "drafts/x.md");
		expect(gitRaw(f.dir, "ls-files", "--cached", "-z").split("\0")).toContain(
			"Drafts/x.md",
		);
		expect(() =>
			git(
				f.dir,
				"ls-files",
				"--cached",
				"--error-unmatch",
				"--",
				"drafts/x.md",
			),
		).toThrow();
		await refused(f, git(f.repo.root, "rev-parse", "HEAD"), "b", "drafts/x.md");
	});

	it.each(["/../ignore", "/"])(
		"refuses non-directory global excludes prefix followed by %s",
		async (suffix) => {
			const f = await fixture();
			const outside = tempDir("fly2901-outside-ignore-");
			put(outside, "regular-file");
			git(
				f.repo.root,
				"config",
				"core.excludesFile",
				`${outside}/regular-file${suffix}`,
			);
			dirty(f);
			await refused(f, f.H, "e", "regular-file");
		},
	);
});
