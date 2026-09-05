import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { defaultAsyncExecFile } from "flywheel-claude-runner";
import { createLogger } from "flywheel-core";
import { canonicalizeWorktreePath } from "./worktree-paths.js";
import {
	type CwdRow,
	isReapIncomplete,
	listSystemCwds,
	type ReapSummary,
	type ReapTarget,
	reapWorktreeProcesses,
} from "./worktree-process-reaper.js";

export { canonicalizeWorktreePath } from "./worktree-paths.js";

const logger = createLogger({ component: "WorktreeManager" });
const RESUME_GIT_SAFE_CONFIG = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.pager=cat",
	"-c",
	"core.sshCommand=false",
	"-c",
	"core.askpass=false",
	"-c",
	"protocol.ext.allow=never",
] as const;

// ─── Types ───────────────────────────────────────

export type WorktreeExecFn = (
	cmd: string,
	args: string[],
	cwd: string,
	options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

export type BgDeleteFn = (cmd: string, args: string[]) => void;

export interface WorktreeReapRecord {
	path: string;
	summary: ReapSummary;
}

export interface WorktreeConfig {
	baseDir?: string;
	/** @internal — shorten the production child deadline in executable tests. */
	execTimeoutMs?: number;
	/** @internal — override background delete for testing */
	bgDeleteFn?: BgDeleteFn;
	/** @internal — override process reaping for deterministic tests. */
	reaperFn?: typeof reapWorktreeProcesses;
	/** @internal — override the convergence cwd census for deterministic tests. */
	cwdScannerFn?: () => Promise<CwdRow[]>;
	/**
	 * FLY-1185 §2.11: injected repo mutation coordinator (teamlead's
	 * repo-mutation-lock — DI so edge-worker never imports teamlead). When
	 * present, every structural mutation (create / remove / removeIfExists /
	 * removeCleanWorktreeByPath / pruneOrphans) runs inside the per-main-repo
	 * critical section; the lock is re-entrant, so a sweep that already holds
	 * it can call these without deadlock. Absent → today's unlocked behavior.
	 */
	withRepoLock?: <T>(mainRepoPath: string, fn: () => Promise<T>) => Promise<T>;
	/** @internal — isolated state root for push-guard tests. */
	pushGuardStateDir?: string;
	/** @internal — package-layout override for push-guard tests. */
	pushGuardSourcePath?: string;
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

export type ResumeWorktreeRebuildResult =
	| {
			ok: true;
			worktree: WorktreeInfo;
			quarantineRef?: string;
			quarantineTip?: string;
	  }
	| {
			ok: false;
			reason: "external_drift" | "quarantine_overflow";
			detail?: string;
	  };

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
 * FLY-793: worktree/branch key for a runner, DAG workflow-aware.
 *
 * A DAG workflow run is ONE issue with internal Design → Implement → QA
 * phase-sessions that must share ONE branch B. When `shareParentBranch` is set
 * (a Bridge-INTERNAL flag the workflow engine sets on the phase dispatch —
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

export const WORKTREE_EXEC_TIMEOUT_MS = 120_000;

// Uses array args and the shared process-group runner — safe from shell
// injection and bounded even when a descendant inherits stdout/stderr.
function createDefaultExec(timeoutMs: number): WorktreeExecFn {
	return async (cmd, args, cwd, options) => {
		const { stdout } = await defaultAsyncExecFile(cmd, args, {
			cwd,
			timeoutMs,
			...(options?.env && {
				env: options.env,
				envMode: "replace" as const,
			}),
		});
		return { stdout };
	};
}

// Uses spawn with array args — no shell injection risk.
function defaultBgDelete(cmd: string, args: string[]): void {
	const proc = spawn(cmd, args, { detached: true, stdio: "ignore" });
	proc.unref();
	proc.once("error", (err) => {
		logger.warn("Background rm failed (non-critical)", {
			cmd,
			args,
			error: err.message,
		});
	});
	proc.once("exit", (code, signal) => {
		if (code === 0 && signal === null) return;
		logger.warn("Background rm exited unsuccessfully (non-critical)", {
			cmd,
			args,
			code,
			signal,
		});
	});
}

/** Published-package-safe path (`src/` and `dist/` are both package children). */
function defaultPushGuardSourcePath(): string {
	return fileURLToPath(
		new URL("../assets/push-guard/pre-push", import.meta.url),
	);
}

function contentDigest(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

type ResumeStatusEntry =
	| { kind: "ordinary"; xy: string; sub: string; mode: string; path: string }
	| {
			kind: "rename";
			xy: string;
			sub: string;
			mode: string;
			score: string;
			path: string;
			originalPath: string;
	  }
	| { kind: "untracked"; path: string }
	| { kind: "unmerged"; path: string };

function parseResumeStatus(output: string): ResumeStatusEntry[] {
	const fields = output.split("\0");
	const entries: ResumeStatusEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		if (field.startsWith("? ")) {
			entries.push({ kind: "untracked", path: field.slice(2) });
			continue;
		}
		if (field.startsWith("u ")) {
			entries.push({
				kind: "unmerged",
				path: field.slice(field.lastIndexOf(" ") + 1),
			});
			continue;
		}
		const ordinary = field.match(
			/^1 (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/,
		);
		if (ordinary) {
			entries.push({
				kind: "ordinary",
				xy: ordinary[1]!,
				sub: ordinary[2]!,
				mode: ordinary[5]!,
				path: ordinary[8]!,
			});
			continue;
		}
		const renamed = field.match(
			/^2 (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/,
		);
		if (renamed) {
			const originalPath = fields[index + 1];
			if (!originalPath) throw new Error("resume_status_rename_origin_missing");
			index += 1;
			entries.push({
				kind: "rename",
				xy: renamed[1]!,
				sub: renamed[2]!,
				mode: renamed[5]!,
				score: renamed[8]!,
				path: renamed[9]!,
				originalPath,
			});
			continue;
		}
		if (!field.startsWith("! ")) {
			throw new Error("resume_status_record_unknown");
		}
	}
	return entries;
}

// ─── WorktreeManager ────────────────────────────

export class WorktreeManager {
	private readonly baseDir: string | undefined;
	private readonly exec: WorktreeExecFn;
	private readonly bgDelete: BgDeleteFn;
	private readonly reaper: typeof reapWorktreeProcesses;
	private readonly cwdScanner: () => Promise<CwdRow[]>;
	private readonly repoLock?: <T>(
		mainRepoPath: string,
		fn: () => Promise<T>,
	) => Promise<T>;
	private readonly pushGuardStateDir: string;
	private readonly pushGuardSourcePath: string;

	constructor(config?: WorktreeConfig, execFn?: WorktreeExecFn) {
		this.baseDir = config?.baseDir;
		this.exec =
			execFn ??
			createDefaultExec(config?.execTimeoutMs ?? WORKTREE_EXEC_TIMEOUT_MS);
		this.bgDelete = config?.bgDeleteFn ?? defaultBgDelete;
		this.reaper = config?.reaperFn ?? reapWorktreeProcesses;
		this.cwdScanner = config?.cwdScannerFn ?? listSystemCwds;
		this.repoLock = config?.withRepoLock;
		const flywheelRoot =
			process.env.FLYWHEEL_STATE_DIR?.trim() ||
			path.join(os.homedir(), ".flywheel");
		this.pushGuardStateDir = path.resolve(
			config?.pushGuardStateDir ?? path.join(flywheelRoot, "state"),
		);
		this.pushGuardSourcePath = path.resolve(
			config?.pushGuardSourcePath ?? defaultPushGuardSourcePath(),
		);
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

	async quarantineAndRebuild(opts: {
		mainRepoPath: string;
		projectName: string;
		issueId: string;
		runId: string;
		admissionKey: string;
		anchorRef: string;
		anchorCommit: string;
		/** @internal deterministic boundary injection. */
		limits?: { maxFiles: number; maxBytes: number };
	}): Promise<ResumeWorktreeRebuildResult> {
		return this.locked(opts.mainRepoPath, async () => {
			const safeExec: WorktreeExecFn = (cmd, args, cwd, options) =>
				this.exec(cmd, [...RESUME_GIT_SAFE_CONFIG, ...args], cwd, options);
			const anchor = opts.anchorCommit.toLowerCase();
			const limits = opts.limits ?? {
				maxFiles: 2_000,
				maxBytes: 64 * 1024 * 1024,
			};
			if (
				!/^[0-9a-f]{40}$/.test(anchor) ||
				!opts.anchorRef.startsWith("refs/flywheel/checkpoints/") ||
				limits.maxFiles < 1 ||
				limits.maxBytes < 1
			) {
				return {
					ok: false,
					reason: "external_drift",
					detail: "invalid_resume_anchor",
				};
			}
			let verifiedAnchor: string;
			try {
				verifiedAnchor = (
					await safeExec(
						"git",
						[
							"-C",
							opts.mainRepoPath,
							"rev-parse",
							"--verify",
							`${opts.anchorRef}^{commit}`,
						],
						opts.mainRepoPath,
					)
				).stdout
					.trim()
					.toLowerCase();
			} catch {
				return {
					ok: false,
					reason: "external_drift",
					detail: "anchor_unreachable",
				};
			}
			if (verifiedAnchor !== anchor) {
				return {
					ok: false,
					reason: "external_drift",
					detail: "anchor_ref_mismatch",
				};
			}

			const worktreePath = this.worktreeDir(
				opts.mainRepoPath,
				opts.projectName,
				opts.issueId,
			);
			let quarantineRef: string | undefined;
			let quarantineTip: string | undefined;
			if (fs.existsSync(worktreePath)) {
				const suffixHead = (
					await safeExec(
						"git",
						["-C", worktreePath, "rev-parse", "HEAD"],
						worktreePath,
					)
				).stdout
					.trim()
					.toLowerCase();
				try {
					await safeExec(
						"git",
						[
							"-C",
							worktreePath,
							"merge-base",
							"--is-ancestor",
							anchor,
							suffixHead,
						],
						worktreePath,
					);
				} catch {
					return {
						ok: false,
						reason: "external_drift",
						detail: "anchor_not_ancestor",
					};
				}
				const branch = this.worktreeName(opts.mainRepoPath, opts.issueId);
				let remoteHead: string | undefined;
				try {
					const remote = (
						await safeExec(
							"git",
							[
								"-C",
								opts.mainRepoPath,
								"ls-remote",
								"--heads",
								"origin",
								`refs/heads/${branch}`,
							],
							opts.mainRepoPath,
						)
					).stdout.trim();
					remoteHead = remote
						? remote.split(/\s+/)[0]?.toLowerCase()
						: undefined;
				} catch {
					return {
						ok: false,
						reason: "external_drift",
						detail: "remote_probe_indeterminate",
					};
				}
				if (remoteHead && remoteHead !== suffixHead) {
					try {
						await safeExec(
							"git",
							[
								"-C",
								opts.mainRepoPath,
								"cat-file",
								"-e",
								`${remoteHead}^{commit}`,
							],
							opts.mainRepoPath,
						);
					} catch {
						try {
							await safeExec(
								"git",
								[
									"-C",
									opts.mainRepoPath,
									"fetch",
									"--no-tags",
									"origin",
									remoteHead,
								],
								opts.mainRepoPath,
							);
						} catch {
							return {
								ok: false,
								reason: "external_drift",
								detail: "remote_head_unreachable",
							};
						}
					}
					try {
						await safeExec(
							"git",
							[
								"-C",
								worktreePath,
								"merge-base",
								"--is-ancestor",
								remoteHead,
								suffixHead,
							],
							worktreePath,
						);
					} catch {
						return {
							ok: false,
							reason: "external_drift",
							detail: "remote_branch_advanced",
						};
					}
				}

				const status = (
					await safeExec(
						"git",
						[
							"-C",
							worktreePath,
							"status",
							"--porcelain=v2",
							"-z",
							"--untracked-files=all",
						],
						worktreePath,
					)
				).stdout;
				if (suffixHead !== anchor || status.length > 0) {
					const tempDir = fs.mkdtempSync(
						path.join(os.tmpdir(), "flywheel-resume-index-"),
					);
					const tempIndex = path.join(tempDir, "index");
					const gitEnv = {
						...process.env,
						GIT_INDEX_FILE: tempIndex,
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_SYSTEM: "/dev/null",
					};
					try {
						const entries = parseResumeStatus(status);
						if (
							entries.some(
								(entry) =>
									entry.kind === "unmerged" ||
									("sub" in entry &&
										entry.sub.startsWith("S") &&
										(entry.sub[2] !== "." || entry.sub[3] !== ".")),
							)
						) {
							return {
								ok: false,
								reason: "quarantine_overflow",
								detail: "unrepresentable_index",
							};
						}
						const stagedNames = (
							await safeExec(
								"git",
								[
									"-C",
									worktreePath,
									"diff",
									"--cached",
									"--name-only",
									"-z",
									suffixHead,
								],
								worktreePath,
							)
						).stdout
							.split("\0")
							.filter(Boolean);
						const changedPaths = new Set(stagedNames);
						let totalBytes = 0;
						for (const rel of stagedNames) {
							const staged = (
								await safeExec(
									"git",
									["-C", worktreePath, "ls-files", "--stage", "--", rel],
									worktreePath,
								)
							).stdout.match(/^(\d+) ([0-9a-f]{40,64}) 0\t/);
							if (staged && staged[1] !== "160000") {
								totalBytes += Number(
									(
										await safeExec(
											"git",
											["-C", worktreePath, "cat-file", "-s", staged[2]!],
											worktreePath,
										)
									).stdout.trim(),
								);
							}
						}
						const worktreePaths = entries.flatMap((entry) =>
							entry.kind === "rename"
								? [entry.path, entry.originalPath]
								: [entry.path],
						);
						for (const rel of worktreePaths) changedPaths.add(rel);
						if (changedPaths.size > limits.maxFiles) {
							return {
								ok: false,
								reason: "quarantine_overflow",
								detail: "file_limit",
							};
						}
						for (const entry of entries) {
							const needsBytes =
								entry.kind === "untracked" ||
								(entry.kind !== "unmerged" &&
									entry.xy[1] !== "." &&
									entry.xy[1] !== "D");
							if (!needsBytes) continue;
							const target = path.resolve(worktreePath, entry.path);
							if (
								!target.startsWith(`${path.resolve(worktreePath)}${path.sep}`)
							) {
								return {
									ok: false,
									reason: "quarantine_overflow",
									detail: "path_escape",
								};
							}
							const stat = fs.lstatSync(target);
							if (stat.isFile()) totalBytes += stat.size;
							else if (stat.isSymbolicLink())
								totalBytes += Buffer.byteLength(fs.readlinkSync(target));
							else if (
								!stat.isDirectory() ||
								!("mode" in entry) ||
								entry.mode !== "160000"
							) {
								return {
									ok: false,
									reason: "quarantine_overflow",
									detail: "unsupported_file_type",
								};
							}
						}
						if (totalBytes > limits.maxBytes) {
							return {
								ok: false,
								reason: "quarantine_overflow",
								detail: "byte_limit",
							};
						}

						const indexTree = (
							await safeExec(
								"git",
								["-C", worktreePath, "write-tree"],
								worktreePath,
							)
						).stdout.trim();
						const headTree = (
							await safeExec(
								"git",
								["-C", worktreePath, "rev-parse", `${suffixHead}^{tree}`],
								worktreePath,
							)
						).stdout.trim();
						let indexCommit = suffixHead;
						if (indexTree !== headTree) {
							indexCommit = (
								await safeExec(
									"git",
									[
										"-C",
										worktreePath,
										"-c",
										"user.name=Flywheel Resume",
										"-c",
										"user.email=resume@flywheel.local",
										"commit-tree",
										indexTree,
										"-p",
										suffixHead,
										"-m",
										`FLY-1707 staged quarantine ${opts.admissionKey}`,
									],
									worktreePath,
								)
							).stdout.trim();
						}
						await safeExec(
							"git",
							["-C", worktreePath, "read-tree", indexTree],
							worktreePath,
							{ env: gitEnv },
						);

						const removePath = async (rel: string) => {
							await safeExec(
								"git",
								[
									"-C",
									worktreePath,
									"update-index",
									"--force-remove",
									"--",
									rel,
								],
								worktreePath,
								{ env: gitEnv },
							);
						};
						const writePath = async (rel: string, declaredMode?: string) => {
							if (path.isAbsolute(rel) || rel.split("/").includes(".."))
								throw new Error("path_escape");
							const source = path.join(worktreePath, rel);
							const stat = fs.lstatSync(source);
							let mode: string;
							let oid: string;
							if (stat.isDirectory() && declaredMode === "160000") {
								mode = "160000";
								oid = (
									await safeExec(
										"git",
										["-C", source, "rev-parse", "HEAD"],
										source,
									)
								).stdout.trim();
							} else {
								mode = stat.isSymbolicLink()
									? "120000"
									: stat.mode & 0o111
										? "100755"
										: "100644";
								let hashSource = source;
								if (stat.isSymbolicLink()) {
									hashSource = path.join(tempDir, `symlink-${randomUUID()}`);
									fs.writeFileSync(hashSource, fs.readlinkSync(source));
								}
								oid = (
									await safeExec(
										"git",
										[
											"-C",
											worktreePath,
											"hash-object",
											"--no-filters",
											"-w",
											hashSource,
										],
										worktreePath,
									)
								).stdout.trim();
							}
							await safeExec(
								"git",
								[
									"-C",
									worktreePath,
									"update-index",
									"--add",
									"--cacheinfo",
									mode,
									oid,
									rel,
								],
								worktreePath,
								{ env: gitEnv },
							);
						};
						for (const entry of entries) {
							if (entry.kind === "untracked") {
								await writePath(entry.path);
							} else if (entry.kind === "ordinary" && entry.xy[1] !== ".") {
								if (entry.xy[1] === "D") await removePath(entry.path);
								else await writePath(entry.path, entry.mode);
							} else if (entry.kind === "rename" && entry.xy[1] !== ".") {
								if (entry.score.startsWith("R"))
									await removePath(entry.originalPath);
								else if (!entry.score.startsWith("C"))
									throw new Error("rename_score_unknown");
								await writePath(entry.path, entry.mode);
							}
						}
						const worktreeTree = (
							await safeExec(
								"git",
								["-C", worktreePath, "write-tree"],
								worktreePath,
								{ env: gitEnv },
							)
						).stdout.trim();
						quarantineTip = indexCommit;
						if (worktreeTree !== indexTree) {
							quarantineTip = (
								await safeExec(
									"git",
									[
										"-C",
										worktreePath,
										"-c",
										"user.name=Flywheel Resume",
										"-c",
										"user.email=resume@flywheel.local",
										"commit-tree",
										worktreeTree,
										"-p",
										indexCommit,
										"-m",
										`FLY-1707 worktree quarantine ${opts.admissionKey}`,
									],
									worktreePath,
								)
							).stdout.trim();
						}
					} catch (error) {
						return {
							ok: false,
							reason: "quarantine_overflow",
							detail: error instanceof Error ? error.message : String(error),
						};
					} finally {
						fs.rmSync(tempDir, { recursive: true, force: true });
					}
					quarantineTip ??= suffixHead;
					quarantineRef = `refs/flywheel/quarantine/${opts.runId}/${opts.admissionKey}`;
					const existing = await safeExec(
						"git",
						["-C", opts.mainRepoPath, "rev-parse", "--verify", quarantineRef],
						opts.mainRepoPath,
					)
						.then((result) => result.stdout.trim())
						.catch(() => undefined);
					if (existing && existing !== quarantineTip) {
						return {
							ok: false,
							reason: "external_drift",
							detail: "quarantine_ref_conflict",
						};
					}
					if (!existing) {
						try {
							await safeExec(
								"git",
								[
									"-C",
									opts.mainRepoPath,
									"update-ref",
									quarantineRef,
									quarantineTip,
									"0".repeat(40),
								],
								opts.mainRepoPath,
							);
						} catch {
							return {
								ok: false,
								reason: "external_drift",
								detail: "quarantine_ref_race",
							};
						}
					}
				}
			}

			await this.removeIfExistsUnlocked(
				opts.mainRepoPath,
				opts.projectName,
				opts.issueId,
			);
			const worktree = await this.create({
				mainRepoPath: opts.mainRepoPath,
				projectName: opts.projectName,
				issueId: opts.issueId,
				startPoint: anchor,
			});
			return {
				ok: true,
				worktree,
				...(quarantineRef ? { quarantineRef, quarantineTip } : {}),
			};
		});
	}

	/** FLY-1759: derive the kill target from WorktreeManager's path authority. */
	private reapTarget(
		mainRepoPath: string,
		worktreePath: string,
		rootProof?: ReapTarget["rootProof"],
	): ReapTarget {
		const lexicalPath = path.resolve(worktreePath);
		const canonicalPath = canonicalizeWorktreePath(lexicalPath);
		let expectedParentDir = canonicalizeWorktreePath(
			path.dirname(path.resolve(mainRepoPath)),
		);
		if (this.baseDir) {
			const base = canonicalizeWorktreePath(path.resolve(this.baseDir));
			const candidateParent = canonicalizeWorktreePath(
				path.dirname(lexicalPath),
			);
			const relative = path.relative(base, candidateParent);
			// Valid configured layouts are either the legacy direct child or one
			// project directory below baseDir. Anything deeper is made to fail the
			// reaper's direct-child guard while filesystem cleanup keeps fail-open.
			expectedParentDir =
				relative === "" ||
				(!relative.startsWith("..") && !relative.includes(path.sep))
					? candidateParent
					: base;
		}
		return {
			lexicalPath,
			canonicalPath,
			expectedParentDir,
			repoSlugPrefix: `${this.repoSlug(mainRepoPath)}-`,
			rootProof:
				rootProof ?? (fs.existsSync(lexicalPath) ? "live-dir" : "gone"),
		};
	}

	private async reapPath(
		mainRepoPath: string,
		worktreePath: string,
		rootProof?: ReapTarget["rootProof"],
	): Promise<WorktreeReapRecord> {
		const target = this.reapTarget(mainRepoPath, worktreePath, rootProof);
		let summary: ReapSummary;
		try {
			summary = await this.reaper(target);
		} catch (error) {
			summary = {
				matched: 0,
				reaped: [],
				survivors: [],
				verified: false,
				identityMismatchSkipped: 0,
				scanError: `reaper threw: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (isReapIncomplete(summary)) {
			logger.warn("worktree_reap_incomplete", {
				path: target.lexicalPath,
				summary,
			});
		}
		return { path: target.lexicalPath, summary };
	}

	private removingResidues(worktreePath: string): string[] {
		const lexicalPath = path.resolve(worktreePath);
		const parent = path.dirname(lexicalPath);
		const base = path.basename(lexicalPath);
		try {
			return fs
				.readdirSync(parent)
				.filter(
					(name) =>
						name.startsWith(`${base}.removing-`) ||
						name.startsWith(`${base}.removing.`),
				)
				.map((name) => path.join(parent, name));
		} catch {
			return [];
		}
	}

	/**
	 * FLY-1718 P2: install the packaged hook into a stable user-owned location.
	 * A valid install is left byte-stable. Invalid/tampered installs are replaced
	 * by a same-directory atomic rename, then re-validated before use.
	 */
	private ensurePushGuardInstalled(): string {
		const sourceStat = fs.lstatSync(this.pushGuardSourcePath);
		if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
			throw new Error(
				`push-guard source is not a regular file: ${this.pushGuardSourcePath}`,
			);
		}
		const source = fs.readFileSync(this.pushGuardSourcePath);
		const expectedDigest = contentDigest(source);
		const hooksDir = path.join(this.pushGuardStateDir, "push-guard", "hooks");
		const installedPath = path.join(hooksDir, "pre-push");
		const owner =
			typeof process.getuid === "function" ? process.getuid() : null;
		const validInstall = (): boolean => {
			try {
				const stat = fs.lstatSync(installedPath);
				return (
					stat.isFile() &&
					!stat.isSymbolicLink() &&
					(owner === null || stat.uid === owner) &&
					(stat.mode & 0o100) === 0o100 &&
					contentDigest(fs.readFileSync(installedPath)) === expectedDigest
				);
			} catch {
				return false;
			}
		};

		fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
		if (validInstall()) return installedPath;

		try {
			const current = fs.lstatSync(installedPath);
			if (!current.isFile() || current.isSymbolicLink()) {
				fs.rmSync(installedPath, { recursive: true, force: true });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const tempPath = path.join(
			hooksDir,
			`.pre-push.${process.pid}.${randomUUID()}.tmp`,
		);
		try {
			fs.writeFileSync(tempPath, source, { flag: "wx", mode: 0o700 });
			fs.chmodSync(tempPath, 0o700);
			fs.renameSync(tempPath, installedPath);
		} finally {
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// Best-effort cleanup only; never mask the installation failure.
			}
		}
		if (!validInstall()) {
			throw new Error(`push-guard install validation failed: ${installedPath}`);
		}
		return installedPath;
	}

	private async resolveExistingHooksDir(
		worktreePath: string,
	): Promise<string | undefined> {
		try {
			const configured = (
				await this.exec(
					"git",
					["-C", worktreePath, "config", "--path", "--get", "core.hooksPath"],
					worktreePath,
				)
			).stdout.trim();
			if (configured) {
				return path.resolve(worktreePath, configured);
			}
		} catch {
			// No configured hooksPath is normal; resolve Git's default below.
		}
		try {
			const resolved = (
				await this.exec(
					"git",
					[
						"-C",
						worktreePath,
						"rev-parse",
						"--path-format=absolute",
						"--git-path",
						"hooks",
					],
					worktreePath,
				)
			).stdout.trim();
			return resolved ? path.resolve(worktreePath, resolved) : undefined;
		} catch {
			return undefined;
		}
	}

	/** Build a worktree-scoped hooksPath that preserves every existing hook. */
	private composePushGuardHooks(
		worktreePath: string,
		guardPath: string,
		existingHooksDir: string | undefined,
	): string {
		const composeRoot = path.join(
			this.pushGuardStateDir,
			"push-guard",
			"worktrees",
		);
		const key = createHash("sha256")
			.update(path.resolve(worktreePath))
			.digest("hex");
		const finalDir = path.join(composeRoot, key);
		const tempDir = path.join(
			composeRoot,
			`.${key}.${process.pid}.${randomUUID()}.tmp`,
		);
		const hooksDir = path.join(tempDir, "hooks");
		fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });

		let previousHooksDir = existingHooksDir;
		if (
			previousHooksDir &&
			path
				.resolve(previousHooksDir)
				.startsWith(`${path.resolve(composeRoot)}${path.sep}`)
		) {
			try {
				const original = fs
					.readFileSync(
						path.join(path.dirname(previousHooksDir), "previous-hooks-path"),
						"utf8",
					)
					.trim();
				previousHooksDir = original || undefined;
			} catch {
				previousHooksDir = undefined;
			}
		}

		const executableHook = (hookPath: string): boolean => {
			try {
				const stat = fs.statSync(hookPath);
				return stat.isFile() && (stat.mode & 0o111) !== 0;
			} catch {
				return false;
			}
		};
		try {
			if (previousHooksDir && fs.statSync(previousHooksDir).isDirectory()) {
				for (const name of fs.readdirSync(previousHooksDir)) {
					if (name === "pre-push") continue;
					const previousHook = path.join(previousHooksDir, name);
					if (!executableHook(previousHook)) continue;
					fs.writeFileSync(
						path.join(hooksDir, name),
						`#!/bin/sh\nexec ${shellQuote(previousHook)} "$@"\n`,
						{ mode: 0o700 },
					);
				}
			}
		} catch {
			// A disappearing prior hooks directory is equivalent to no prior hooks.
		}

		const previousPrePush = previousHooksDir
			? path.join(previousHooksDir, "pre-push")
			: undefined;
		const chainPrevious =
			previousPrePush &&
			path.resolve(previousPrePush) !== path.resolve(guardPath) &&
			executableHook(previousPrePush)
				? `${shellQuote(previousPrePush)} "$@" < "$input" || exit $?\n`
				: "";
		fs.writeFileSync(
			path.join(hooksDir, "pre-push"),
			`#!/bin/sh\ninput=$(mktemp "\${TMPDIR:-/tmp}/flywheel-pre-push.XXXXXX") || exit 1\ntrap 'rm -f -- "$input"' EXIT HUP INT TERM\ncat > "$input" || exit 1\n${chainPrevious}exec ${shellQuote(guardPath)} "$@" < "$input"\n`,
			{ mode: 0o700 },
		);
		fs.writeFileSync(
			path.join(tempDir, "previous-hooks-path"),
			previousHooksDir ? `${previousHooksDir}\n` : "",
			{ mode: 0o600 },
		);

		fs.mkdirSync(composeRoot, { recursive: true, mode: 0o700 });
		fs.rmSync(finalDir, { recursive: true, force: true });
		fs.renameSync(tempDir, finalDir);
		return path.join(finalDir, "hooks");
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

			try {
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

				const guardPath = this.ensurePushGuardInstalled();
				const existingHooksDir =
					await this.resolveExistingHooksDir(worktreePath);
				const hooksDir = this.composePushGuardHooks(
					worktreePath,
					guardPath,
					existingHooksDir,
				);
				await this.exec(
					"git",
					[
						"-C",
						worktreePath,
						"config",
						"--local",
						"extensions.worktreeConfig",
						"true",
					],
					worktreePath,
				);
				await this.exec(
					"git",
					[
						"-C",
						worktreePath,
						"config",
						"--worktree",
						"core.hooksPath",
						hooksDir,
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
			} catch (error) {
				try {
					await this.removeIfExistsUnlocked(
						opts.mainRepoPath,
						opts.projectName,
						opts.issueId,
					);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`worktree create failed and rollback also failed: ${worktreePath}`,
					);
				}
				throw error;
			}
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

	async remove(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<{ reaps?: WorktreeReapRecord[] }> {
		return this.locked(mainRepoPath, () =>
			this.removeUnlocked(mainRepoPath, worktreePath),
		);
	}

	private async removeUnlocked(
		mainRepoPath: string,
		worktreePath: string,
	): Promise<{ reaps?: WorktreeReapRecord[] }> {
		// FLY-1759 reap-first: preserve the live cwd path until census + exit
		// verification finishes. Deletion remains fail-open on reap uncertainty.
		const reaps: WorktreeReapRecord[] = [];
		for (const residue of this.removingResidues(worktreePath)) {
			if (await this.isRegistered(mainRepoPath, residue)) {
				logger.warn("worktree_reap_residue_still_registered", {
					path: residue,
				});
				continue;
			}
			reaps.push(await this.reapPath(mainRepoPath, residue, "live-dir"));
			await fs.promises.rm(residue, { recursive: true, force: true });
		}
		reaps.push(await this.reapPath(mainRepoPath, worktreePath));
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
				return { reaps };
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
		return { reaps };
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
			// FLY-1759 reap-first: orphan directories bypass removeUnlocked().
			await this.reapPath(mainRepoPath, worktreePath, "live-dir");
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
			const sweepStarted = performance.now();
			const sweepDeadline = sweepStarted + 30_000;
			const familyLimit = 8;
			const worktrees = await this.list(mainRepoPath);
			const pruned: string[] = [];

			const projectPrefix = this.worktreePrefix(mainRepoPath, projectName);

			const branchPrefix = `${this.repoSlug(mainRepoPath)}-`;
			const registered = new Set(
				worktrees.map((wt) => canonicalizeWorktreePath(wt.path)),
			);

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

			// FLY-1759 convergence family 1: a crash between rename and detached
			// rm leaves .removing-* directories outside git's registry forever.
			const projectDir = this.baseDir
				? path.join(this.baseDir, projectName)
				: path.dirname(mainRepoPath);
			let residueCandidates: string[] = [];
			try {
				const residuePattern = /\.removing(?:-|\.)\d+$/;
				residueCandidates = fs
					.readdirSync(projectDir)
					.filter(
						(name) =>
							name.startsWith(branchPrefix) &&
							residuePattern.test(name) &&
							!registered.has(
								canonicalizeWorktreePath(path.join(projectDir, name)),
							),
					)
					.map((name) => path.join(projectDir, name));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					logger.warn("worktree_reap_residue_scan_failed", {
						projectDir,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			for (const residue of residueCandidates.slice(0, familyLimit)) {
				if (performance.now() >= sweepDeadline) break;
				await this.reapPath(mainRepoPath, residue, "live-dir");
				await fs.promises.rm(residue, { recursive: true, force: true });
				pruned.push(residue);
			}
			if (residueCandidates.length > familyLimit) {
				logger.warn("worktree_reap_residue_cap_reached", {
					remaining: residueCandidates.length - familyLimit,
				});
			}

			// FLY-1759 convergence family 2: deleted cwd roots have no filesystem
			// entry. Require BOTH absence from git registry and absence on disk.
			if (performance.now() < sweepDeadline) {
				let cwdRows: CwdRow[] = [];
				try {
					cwdRows = await this.cwdScanner();
				} catch (error) {
					logger.warn("worktree_reap_dead_cwd_scan_failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
				const canonicalProjectDir = canonicalizeWorktreePath(projectDir);
				const goneCandidates = new Set<string>();
				for (const row of cwdRows) {
					if (row.logicalCwd === null) continue;
					const cwd = canonicalizeWorktreePath(row.logicalCwd);
					const relative = path.relative(canonicalProjectDir, cwd);
					if (
						!relative ||
						relative.startsWith("..") ||
						path.isAbsolute(relative)
					) {
						continue;
					}
					const rootName = relative.split(path.sep)[0]!;
					if (!rootName.startsWith(branchPrefix)) continue;
					const candidate = path.join(canonicalProjectDir, rootName);
					if (fs.existsSync(candidate) || registered.has(candidate)) continue;
					goneCandidates.add(candidate);
				}
				const candidates = [...goneCandidates];
				for (const candidate of candidates.slice(0, familyLimit)) {
					if (performance.now() >= sweepDeadline) break;
					await this.reapPath(mainRepoPath, candidate, "gone");
					pruned.push(candidate);
				}
				if (candidates.length > familyLimit) {
					logger.warn("worktree_reap_dead_cwd_cap_reached", {
						remaining: candidates.length - familyLimit,
					});
				}
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
	): Promise<{
		removed: boolean;
		branchDeleted: boolean;
		error?: string;
		reaps?: WorktreeReapRecord[];
	}> {
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
	): Promise<{
		removed: boolean;
		branchDeleted: boolean;
		error?: string;
		reaps?: WorktreeReapRecord[];
	}> {
		// FLY-1759 reap-first: git remove must not erase cwd attribution first.
		const reaps = [await this.reapPath(mainRepoPath, worktreePath)];
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
				reaps,
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
					return {
						removed: true,
						branchDeleted: false,
						error: msg,
						reaps,
					};
				}
			}
		}
		return { removed: true, branchDeleted, reaps };
	}

	/**
	 * FLY-603: Reconciler removal that uses the EXACT path/branch from `list()`
	 * (never recomputed from a key), delegating to the dirty-safe primitive.
	 */
	async removeRegisteredWorktree(
		mainRepoPath: string,
		wt: ExternalWorktree,
		opts?: { deleteBranch?: boolean },
	): Promise<{
		removed: boolean;
		branchDeleted: boolean;
		error?: string;
		reaps?: WorktreeReapRecord[];
	}> {
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
	): Promise<{
		removed: boolean;
		error?: string;
		reaps?: WorktreeReapRecord[];
	}> {
		return this.locked(mainRepoPath, async () => {
			// FLY-1759 reap-first: quarantine authorization does not waive process cleanup.
			const reaps = [await this.reapPath(mainRepoPath, worktreePath)];
			try {
				await this.exec(
					"git",
					["-C", mainRepoPath, "worktree", "remove", "--force", worktreePath],
					mainRepoPath,
				);
				return { removed: true, reaps };
			} catch (err) {
				return {
					removed: false,
					error: err instanceof Error ? err.message : String(err),
					reaps,
				};
			}
		});
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
