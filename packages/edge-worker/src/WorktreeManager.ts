import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "flywheel-core";

const logger = createLogger({ component: "WorktreeManager" });

// ─── Types ───────────────────────────────────────

export type WorktreeExecFn = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

export type BgDeleteFn = (cmd: string, args: string[]) => void;

export interface WorktreeConfig {
	baseDir?: string;
	/** @internal — override background delete for testing */
	bgDeleteFn?: BgDeleteFn;
	/**
	 * FLY-1185 §2.11: injected repo mutation coordinator (teamlead's
	 * repo-mutation-lock — DI so edge-worker never imports teamlead). When
	 * present, every structural mutation (create / remove / removeIfExists /
	 * removeCleanWorktreeByPath / pruneOrphans) runs inside the per-main-repo
	 * critical section; the lock is re-entrant, so a sweep that already holds
	 * it can call these without deadlock. Absent → today's unlocked behavior.
	 */
	withRepoLock?: <T>(mainRepoPath: string, fn: () => Promise<T>) => Promise<T>;
}

export interface WorktreeInfo {
	projectName: string;
	issueId: string;
	worktreePath: string;
	branch: string;
	mainRepoPath: string;
	/**
	 * FLY-1185 §2.1: creation-generation nonce, written by `create()` into the
	 * worktree's git ADMIN area (`flywheel.generation` — creator-written, never
	 * worktree content, porcelain-invisible). The orchestrator binds it via
	 * `StateStore.bindWorktreeOnce`; a same-path/same-branch REBUILD gets a new
	 * nonce, so a stale binding can never authorize deleting the rebuild (the
	 * same-family ABA root cure).
	 */
	generation: string;
}

/** FLY-1185 §2.1: classification result for a candidate worktree. */
export interface WorktreeOwnership {
	ownership: "session_path" | "unowned";
	key: string | null;
	/** Present only for ownership === "session_path". */
	executionId?: string;
}

export interface ExternalWorktree {
	path: string;
	branch: string | null;
	/** FLY-603: HEAD commit sha from porcelain (null for bare). Needed by the
	 *  reconciler for squash-safe merged detection (headRefOid == HEAD). */
	head: string | null;
	isDetached: boolean;
	isBare: boolean;
}

/**
 * FLY-603: Role-aware worktree key — the single source of how a runner
 * worktree is named, shared by Blueprint (create path) and the post-ship /
 * reconciler cleanup so the two can never drift.
 *
 * IMPORTANT: `identifier` is opaque and preserved BYTE-FOR-BYTE (e.g. `FLY-603`
 * stays `FLY-603`, never lowercased). ONLY `sessionRole` is sanitized — this
 * mirrors Blueprint.ts exactly: strip non `[a-zA-Z0-9-]`, lowercase, fallback
 * to `main` when empty. For the `main` role the key is just the identifier;
 * for any other role it is `${identifier}-${sanitizedRole}`.
 */
export function deriveWorktreeKey(
	identifier: string,
	sessionRole?: string,
): string {
	const role =
		(sessionRole ?? "main").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() ||
		"main";
	return role === "main" ? identifier : `${identifier}-${role}`;
}

/**
 * FLY-793: worktree/branch key for a runner, three-stage-aware.
 *
 * A three-stage run is ONE issue with internal Design → Implement → QA
 * phase-sessions that must share ONE branch B. When `shareParentBranch` is set
 * (a Bridge-INTERNAL flag the PhaseOrchestrator sets on the phase dispatch —
 * NEVER accepted from `/api/runs/start` or runner payloads), the key is the
 * parent's `main`-role key (= `identifier`) regardless of `sessionRole`, so all
 * three phases derive the SAME branch B. Absent → current role-aware behavior
 * (`${identifier}-${role}` for non-main roles), byte-compatible.
 *
 * SECURITY: the shared key is computed HERE from the node's own `identifier`
 * (never from an externally-supplied key string), so a mis-scoped/smuggled flag
 * can at worst make a run use its own issue's main key — it can never target a
 * different managed branch.
 */
export function resolveWorktreeKey(
	identifier: string,
	opts?: { sessionRole?: string; shareParentBranch?: boolean },
): string {
	if (opts?.shareParentBranch) return deriveWorktreeKey(identifier, "main");
	return deriveWorktreeKey(identifier, opts?.sessionRole);
}

// ─── Default exec ────────────────────────────────

// Uses execFile (array args, no shell) — safe from injection by design.
const defaultExec: WorktreeExecFn = (cmd, args, cwd) =>
	new Promise((resolve, reject) => {
		execFile(cmd, args, { cwd }, (err, stdout) => {
			if (err) return reject(err);
			resolve({ stdout });
		});
	});

// Uses spawn with array args — no shell injection risk.
function defaultBgDelete(cmd: string, args: string[]): void {
	const proc = spawn(cmd, args, { detached: true, stdio: "ignore" });
	proc.unref();
	proc.on("error", (err) => {
		logger.warn("Background rm failed (non-critical)", {
			cmd,
			args,
			error: err.message,
		});
	});
}

// ─── WorktreeManager ────────────────────────────

export class WorktreeManager {
	private readonly baseDir: string | undefined;
	private readonly exec: WorktreeExecFn;
	private readonly bgDelete: BgDeleteFn;
	private readonly repoLock?: <T>(
		mainRepoPath: string,
		fn: () => Promise<T>,
	) => Promise<T>;

	constructor(config?: WorktreeConfig, execFn?: WorktreeExecFn) {
		this.baseDir = config?.baseDir;
		this.exec = execFn ?? defaultExec;
		this.bgDelete = config?.bgDeleteFn ?? defaultBgDelete;
		this.repoLock = config?.withRepoLock;
	}

	/** FLY-1185 §2.11: run inside the injected repo lock (no-op when absent). */
	private locked<T>(mainRepoPath: string, fn: () => Promise<T>): Promise<T> {
		return this.repoLock ? this.repoLock(mainRepoPath, fn) : fn();
	}

	/** Lowercase slug derived from the repo directory name. */
	private repoSlug(mainRepoPath: string): string {
		return path.basename(mainRepoPath).toLowerCase();
	}

	/**
	 * FLY-95: Branch + directory name for a worktree.
	 * e.g. mainRepoPath=/Users/x/Dev/GeoForge3D, issueId=GEO-42 → "geoforge3d-GEO-42"
	 */
	private worktreeName(mainRepoPath: string, issueId: string): string {
		return `${this.repoSlug(mainRepoPath)}-${issueId}`;
	}

	/**
	 * FLY-95: Compute worktree directory as a sibling of the main repo.
	 * e.g. mainRepoPath=/Users/x/Dev/GeoForge3D → /Users/x/Dev/geoforge3d-GEO-42
	 * Falls back to explicit baseDir/projectName/ if configured (backward compat).
	 */
	private worktreeDir(
		mainRepoPath: string,
		projectName: string,
		issueId: string,
	): string {
		const name = this.worktreeName(mainRepoPath, issueId);
		if (this.baseDir) {
			return path.join(this.baseDir, projectName, name);
		}
		return path.join(path.dirname(mainRepoPath), name);
	}

	/** FLY-95: Project-scoped prefix for pruneOrphans filtering. */
	private worktreePrefix(mainRepoPath: string, projectName: string): string {
		if (this.baseDir) {
			return path.join(this.baseDir, projectName) + path.sep;
		}
		return `${path.dirname(mainRepoPath)}${path.sep}${this.repoSlug(mainRepoPath)}-`;
	}

	async create(opts: {
		mainRepoPath: string;
		projectName: string;
		issueId: string;
		startPoint?: string;
	}): Promise<WorktreeInfo> {
		return this.locked(opts.mainRepoPath, async () => {
			const branch = this.worktreeName(opts.mainRepoPath, opts.issueId);
			const worktreePath = this.worktreeDir(
				opts.mainRepoPath,
				opts.projectName,
				opts.issueId,
			);
			// FLY-115: QA test-injection hook. When opts.startPoint is not supplied
			// by the caller, fall back to the FLYWHEEL_RUNNER_START_POINT env var so
			// test-deploy.sh can pin Runner worktrees to a PR branch on the sandbox
			// fork. Unset in prod → falls through to origin/main (unchanged).
			const startPoint =
				opts.startPoint ??
				process.env.FLYWHEEL_RUNNER_START_POINT ??
				"origin/main";

			// git worktree add
			// FLY-99: -B (reset-or-create) replaces -b (create-only) so a stale
			// local branch left behind by a crashed Runner is reset to startPoint
			// instead of failing with "branch already exists". removeIfExists() still
			// runs `branch -D` up front — -B is the belt, branch -D is the suspenders.
			// -B still fails if the branch is currently checked out in another
			// worktree, but that is a concurrent-scheduling concern, not FLY-99 scope.
			await this.exec(
				"git",
				[
					"-C",
					opts.mainRepoPath,
					"worktree",
					"add",
					worktreePath,
					"-B",
					branch,
					`${startPoint}^{commit}`,
				],
				opts.mainRepoPath,
			);

			// git config push.autoSetupRemote
			await this.exec(
				"git",
				[
					"-C",
					worktreePath,
					"config",
					"--local",
					"push.autoSetupRemote",
					"true",
				],
				worktreePath,
			);

			// FLY-1185 §2.1: creation-generation nonce into the git ADMIN area
			// (resolved via --git-path, never guessed from `.git/worktrees/<id>`).
			// Creator-written, porcelain-invisible; a rebuild gets a fresh nonce.
			// A marker-write failure fails the create (fail-closed: a worktree
			// without a generation could never be classified as session-owned).
			const generation = randomUUID();
			const markerPath = await this.resolveGenerationMarkerPath(worktreePath);
			fs.writeFileSync(markerPath, `${generation}\n`, "utf8");

			return {
				projectName: opts.projectName,
				issueId: opts.issueId,
				worktreePath,
				branch,
				mainRepoPath: opts.mainRepoPath,
				generation,
			};
		});
	}

	/** FLY-1185 §2.1: absolute admin-area path of the generation marker. */
	private async resolveGenerationMarkerPath(
		worktreePath: string,
	): Promise<string> {
		const { stdout } = await this.exec(
			"git",
			[
				"-C",
				worktreePath,
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"flywheel.generation",
			],
			worktreePath,
		);
		return stdout.trim();
	}

	/**
	 * FLY-1185 §2.1: read a worktree's admin-area generation marker.
	 * `undefined` when missing/unreadable (pre-FLY-1185 worktree, or a
	 * non-Flywheel worktree) — callers treat that as "no ownership proof".
	 */
	async readWorktreeGeneration(
		worktreePath: string,
	): Promise<string | undefined> {
		try {
			const markerPath = await this.resolveGenerationMarkerPath(worktreePath);
			const text = fs.readFileSync(markerPath, "utf8").trim();
			return text.length > 0 ? text : undefined;
		} catch {
			return undefined;
		}
	}

	async remove(mainRepoPath: string, worktreePath: string): Promise<void> {
		return this.locked(mainRepoPath, () =>
			this.removeUnlocked(mainRepoPath, worktreePath),
		);
	}

	private async removeUnlocked(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<void> {
		// Phase 1: rename to temp dir (same filesystem — avoids EXDEV)
		const tmpPath = `${worktreePath}.removing-${Date.now()}`;
		try {
			await fs.promises.rename(worktreePath, tmpPath);
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				logger.info("Worktree dir already gone, skipping rename", {
					worktreePath,
				});
				// Skip to prune. Plain `git worktree prune` drops any admin
				// entry whose gitdir target is missing — no time threshold
				// applies (CLI default). `gc.worktreePruneExpire` only governs
				// `git gc`'s auto-prune, not this explicit invocation.
				await this.exec(
					"git",
					["-C", mainRepoPath, "worktree", "prune"],
					mainRepoPath,
				);
				return;
			}
			throw err;
		}

		// Phase 2: git worktree prune — drops the admin entry for the
		// just-renamed gitdir (now missing from its original path).
		await this.exec(
			"git",
			["-C", mainRepoPath, "worktree", "prune"],
			mainRepoPath,
		);

		// Phase 3: background delete (macOS-safe, detached — non-blocking)
		this.bgDelete("/bin/rm", ["-rf", tmpPath]);
	}

	async isRegistered(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<boolean> {
		const worktrees = await this.list(mainRepoPath);
		// FLY-793: canonicalize both sides — git reports symlink-resolved paths.
		const target = canonicalizeWorktreePath(worktreePath);
		return worktrees.some((wt) => canonicalizeWorktreePath(wt.path) === target);
	}

	async list(mainRepoPath: string): Promise<ExternalWorktree[]> {
		const { stdout } = await this.exec(
			"git",
			["-C", mainRepoPath, "worktree", "list", "--porcelain"],
			mainRepoPath,
		);
		return parsePorcelain(stdout);
	}

	/**
	 * Safe rerun cleanup: remove worktree + delete local branch.
	 * Keeps path construction internal to WorktreeManager.
	 * Returns true if something was cleaned up, false if nothing existed.
	 */
	async removeIfExists(
		mainRepoPath: string,
		projectName: string,
		issueId: string,
	): Promise<boolean> {
		return this.locked(mainRepoPath, () =>
			this.removeIfExistsUnlocked(mainRepoPath, projectName, issueId),
		);
	}

	private async removeIfExistsUnlocked(
		mainRepoPath: string,
		projectName: string,
		issueId: string,
	): Promise<boolean> {
		const branch = this.worktreeName(mainRepoPath, issueId);
		const worktreePath = this.worktreeDir(mainRepoPath, projectName, issueId);

		let cleaned = false;

		// Step 1: remove worktree if registered, OR clean up orphan dir on disk.
		if (await this.isRegistered(mainRepoPath, worktreePath)) {
			// remove() uses rename + prune + background rm — race-free because
			// the original path is renamed first, so a follow-up create() can
			// immediately reclaim it. (Unlocked variant — we already hold the
			// repo lock from the public wrapper.)
			await this.removeUnlocked(mainRepoPath, worktreePath);
			cleaned = true;
		} else if (fs.existsSync(worktreePath)) {
			// Orphan directory: exists on disk but not registered as a worktree.
			// This can happen after a crash or interrupted removal.
			//
			// FLY-99: Use *awaited* fs.promises.rm instead of the fire-and-forget
			// bgDelete() used by remove(). The caller here is Blueprint, which
			// immediately follows up with create() — any non-awaited rm would
			// race the next `git worktree add`, causing "path already exists"
			// or a partially-deleted tree to be re-registered.
			await fs.promises.rm(worktreePath, { recursive: true, force: true });
			cleaned = true;
		}

		// Step 1b: FLY-99 — always prune stale admin entries before branch -D.
		//
		// Root cause: `isRegistered()` compares git's canonical worktree path
		// (from `git worktree list --porcelain`, always fully resolved) against
		// the caller-provided `mainRepoPath`-derived path. If the caller passes
		// an unresolved path that traverses a symlink (e.g. `/var/foo` when git
		// records `/private/var/foo` on macOS, or any user-configured symlink
		// chain on Linux), the string comparison fails and `isRegistered`
		// returns false. The orphan-dir branch above then `fs.rm`s the target
		// via the symlink, but the admin entry at `.git/worktrees/<name>/`
		// still records the branch as "checked out at <canonical-path>" — so
		// without this prune, `branch -D` fails with "Cannot delete branch X
		// checked out at Y" and the subsequent `worktree add -B` fails with
		// "already checked out at Y". Step 1b unconditionally drops the now-
		// stale admin entry so the rerun succeeds.
		await this.exec(
			"git",
			["-C", mainRepoPath, "worktree", "prune"],
			mainRepoPath,
		);

		// Step 2: delete local branch if it still exists.
		// `git worktree prune` does NOT delete the branch — only the worktree
		// registration. Without this, a subsequent create() without -B would
		// fail with "branch already exists". With FLY-99's switch to -B this is
		// no longer a hard requirement, but branch -D still serves as repo
		// hygiene (removes stale local refs) and handles the degenerate case
		// where only the branch survived a prior cleanup attempt.
		try {
			await this.exec(
				"git",
				["-C", mainRepoPath, "branch", "-D", branch],
				mainRepoPath,
			);
			return true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("not found")) throw err;
			// Branch missing is fine; report whether anything else was cleaned.
			return cleaned;
		}
	}

	async pruneOrphans(
		mainRepoPath: string,
		projectName: string,
	): Promise<string[]> {
		return this.locked(mainRepoPath, async () => {
			const worktrees = await this.list(mainRepoPath);
			const pruned: string[] = [];

			const projectPrefix = this.worktreePrefix(mainRepoPath, projectName);

			const branchPrefix = `${this.repoSlug(mainRepoPath)}-`;

			for (const wt of worktrees) {
				// Only prune project-scoped branches under this project's directory
				if (!wt.branch?.startsWith(branchPrefix)) continue;
				if (!wt.path.startsWith(projectPrefix)) continue;
				if (fs.existsSync(wt.path)) continue;

				// Dir missing → orphan
				logger.info("Pruning orphan worktree", { path: wt.path });
				await this.removeUnlocked(mainRepoPath, wt.path);
				pruned.push(wt.path);
			}

			return pruned;
		});
	}

	// ─── FLY-603: dirty-safe cleanup + key resolvers ──────────────

	/**
	 * FLY-603: Expected sibling worktree `{ path, branch }` for an issue key —
	 * public wrapper over the private path math so callers (post-ship cleanup)
	 * never reimplement repoSlug/baseDir semantics in teamlead code.
	 */
	expectedWorktree(
		mainRepoPath: string,
		projectName: string,
		issueKey: string,
	): { path: string; branch: string } {
		return {
			path: this.worktreeDir(mainRepoPath, projectName, issueKey),
			branch: this.worktreeName(mainRepoPath, issueKey),
		};
	}

	/**
	 * FLY-603: Parse the worktree key from a registered branch name.
	 * `<repoSlug>-<key>` → `<key>` (e.g. `flywheel-FLY-603-qa` → `FLY-603-qa`).
	 * Returns null for non-matching / null branches.
	 */
	parseWorktreeKeyFromBranch(
		mainRepoPath: string,
		branch: string | null,
	): string | null {
		if (!branch) return null;
		const prefix = `${this.repoSlug(mainRepoPath)}-`;
		return branch.startsWith(prefix) ? branch.slice(prefix.length) : null;
	}

	/**
	 * FLY-603: Path-authoritative worktree key from an exact worktree path.
	 * The dir basename is always `<repoSlug>-<key>` for both sibling and
	 * baseDir layouts; the parent must match the project's expected prefix dir,
	 * otherwise we return null (fail-closed — do not trust an unexpected path).
	 * Uses repoSlug, NOT projectName, so `projectName !== repoSlug` is safe.
	 */
	parseWorktreeKeyFromPath(
		mainRepoPath: string,
		projectName: string,
		worktreePath: string,
	): string | null {
		const prefix = `${this.repoSlug(mainRepoPath)}-`;
		const base = path.basename(worktreePath);
		if (!base.startsWith(prefix)) return null;
		const expectedParent = this.baseDir
			? path.join(this.baseDir, projectName)
			: path.dirname(mainRepoPath);
		if (path.dirname(worktreePath) !== expectedParent) return null;
		return base.slice(prefix.length);
	}

	/**
	 * FLY-603 (Codex code-review R1 HIGH-2): resolve the REGISTERED worktree at
	 * an exact path from `git worktree list` (authoritative branch/detached
	 * state), so Layer A can refuse to delete a worktree whose registered branch
	 * is null/detached or not the one it expects — instead of inventing a branch.
	 * Returns null when no worktree is registered at that exact path.
	 */
	async getRegisteredWorktree(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<ExternalWorktree | null> {
		const worktrees = await this.list(mainRepoPath);
		// FLY-793 (824 R2 E2E): canonicalize both sides so a session-stored
		// unresolved path (e.g. /tmp/...) matches git's symlink-resolved path
		// (/private/tmp/...) instead of silently returning "not registered".
		const target = canonicalizeWorktreePath(worktreePath);
		return (
			worktrees.find((wt) => canonicalizeWorktreePath(wt.path) === target) ??
			null
		);
	}

	/**
	 * FLY-603: Dirty-safe removal by exact path — `git worktree remove` WITHOUT
	 * `--force` (refuses dirty/locked trees, a second safety net behind the
	 * caller's own dirty-guard), then `git branch -D <branch>` if provided.
	 * Never the forceful rename+rm path of `remove()`. Never throws.
	 */
	async removeCleanWorktreeByPath(
		mainRepoPath: string,
		worktreePath: string,
		branch?: string | null,
	): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
		return this.locked(mainRepoPath, () =>
			this.removeCleanWorktreeByPathUnlocked(
				mainRepoPath,
				worktreePath,
				branch,
			),
		);
	}

	private async removeCleanWorktreeByPathUnlocked(
		mainRepoPath: string,
		worktreePath: string,
		branch?: string | null,
	): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
		try {
			await this.exec(
				"git",
				["-C", mainRepoPath, "worktree", "remove", worktreePath],
				mainRepoPath,
			);
		} catch (err) {
			return {
				removed: false,
				branchDeleted: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
		let branchDeleted = false;
		if (branch) {
			try {
				await this.exec(
					"git",
					["-C", mainRepoPath, "branch", "-D", branch],
					mainRepoPath,
				);
				branchDeleted = true;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("not found")) {
					return { removed: true, branchDeleted: false, error: msg };
				}
			}
		}
		return { removed: true, branchDeleted };
	}

	/**
	 * FLY-603: Reconciler removal that uses the EXACT path/branch from `list()`
	 * (never recomputed from a key), delegating to the dirty-safe primitive.
	 */
	async removeRegisteredWorktree(
		mainRepoPath: string,
		wt: ExternalWorktree,
		opts?: { deleteBranch?: boolean },
	): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
		return this.removeCleanWorktreeByPath(
			mainRepoPath,
			wt.path,
			opts?.deleteBranch ? wt.branch : null,
		);
	}

	/**
	 * FLY-1185 §2.1: classify a candidate worktree's ownership against the
	 * TRUSTED binding set (StateStore `worktree_binding_*`, fresh-read by the
	 * caller inside the repo lock). `session_path` requires FOUR-WAY agreement:
	 *   canonical(binding.path) === canonical(wt.path)
	 *   ∧ wt.branch === binding.branch
	 *   ∧ admin-area `flywheel.generation` === binding.generation (byte-equal)
	 *   ∧ binding complete (all three fields non-empty).
	 * ANYTHING else — no binding, generation mismatch (same-family rebuild),
	 * branch drift, marker missing — is `unowned` = manual-only. There is NO
	 * shape fallback (R6#1: shape can be forged; absence of a binding is never
	 * proof of legacy).
	 */
	async classifyWorktreePath(
		mainRepoPath: string,
		projectName: string,
		wt: ExternalWorktree,
		trustedBindings: Array<{
			execution_id: string;
			path: string;
			branch: string;
			generation: string;
		}>,
	): Promise<WorktreeOwnership> {
		const key = this.parseWorktreeKeyFromPath(
			mainRepoPath,
			projectName,
			wt.path,
		);
		const canonicalWt = canonicalizeWorktreePath(wt.path);
		for (const b of trustedBindings) {
			if (!b.path || !b.branch || !b.generation) continue; // incomplete
			if (canonicalizeWorktreePath(b.path) !== canonicalWt) continue;
			if (!wt.branch || wt.branch !== b.branch) continue;
			const marker = await this.readWorktreeGeneration(wt.path);
			if (marker !== b.generation) continue; // same-family ABA root cure
			return { ownership: "session_path", key, executionId: b.execution_id };
		}
		return { ownership: "unowned", key };
	}

	/**
	 * FLY-1185 §2.8: FORCE removal — callable ONLY after a passed
	 * quarantine+restore-smoke (the caller enforces that contract; this
	 * primitive stays dumb). Locked like every other structural mutation.
	 */
	async removeWorktreeForce(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<{ removed: boolean; error?: string }> {
		return this.locked(mainRepoPath, async () => {
			try {
				await this.exec(
					"git",
					["-C", mainRepoPath, "worktree", "remove", "--force", worktreePath],
					mainRepoPath,
				);
				return { removed: true };
			} catch (err) {
				return {
					removed: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		});
	}
}

/**
 * FLY-793 (824 R2 E2E): canonicalize a filesystem path so it can be compared
 * against git's worktree paths, which `git worktree list --porcelain` always
 * reports fully symlink-resolved (e.g. macOS `/tmp` → `/private/tmp`, or any
 * user-configured symlink component on Linux). A plain string `===` against an
 * unresolved caller path silently fails to match — that is the FLY-99 class of
 * bug, and it broke the three-stage worktree-removal-proof gate (cleanup skipped
 * as "not_registered" → the removed-proof check threw → handoff fail-closed).
 *
 * `fs.realpathSync` resolves symlinks but throws when the path (or a component)
 * doesn't exist, so fall back to resolving the deepest existing ancestor and
 * re-appending the missing tail. This keeps `/tmp/x` matching `/private/tmp/x`
 * whether or not `x` is still on disk.
 */
export function canonicalizeWorktreePath(p: string): string {
	const abs = path.resolve(p);
	try {
		return fs.realpathSync(abs);
	} catch {
		// Deepest-existing-ancestor fallback for a not-yet / no-longer existing
		// path: walk up until an ancestor resolves, then re-attach the tail.
		const tail: string[] = [];
		let dir = abs;
		for (
			let parent = path.dirname(dir);
			parent !== dir;
			parent = path.dirname(dir)
		) {
			tail.unshift(path.basename(dir));
			dir = parent;
			try {
				return path.join(fs.realpathSync(dir), ...tail);
			} catch {
				// ancestor still missing — keep walking up
			}
		}
		return abs; // no existing ancestor (root always exists, so unreachable)
	}
}

// ─── Porcelain parser ────────────────────────────

function parsePorcelain(output: string): ExternalWorktree[] {
	const worktrees: ExternalWorktree[] = [];
	const blocks = output.trim().split("\n\n");

	for (const block of blocks) {
		if (!block.trim()) continue;
		const lines = block.trim().split("\n");

		let wtPath = "";
		let branch: string | null = null;
		let head: string | null = null;
		let isDetached = false;
		let isBare = false;

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				wtPath = line.slice("worktree ".length);
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length);
			} else if (line.startsWith("branch refs/heads/")) {
				branch = line.slice("branch refs/heads/".length);
			} else if (line === "detached") {
				isDetached = true;
			} else if (line === "bare") {
				isBare = true;
			}
		}

		if (wtPath) {
			worktrees.push({ path: wtPath, branch, head, isDetached, isBare });
		}
	}

	return worktrees;
}
