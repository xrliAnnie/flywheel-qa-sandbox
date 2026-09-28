/**
 * FLY-2900 §5.3 — commit a parked execution's dirty worktree before a
 * fallback body takes the node, so the successor starts from a clean branch
 * HEAD with every change visible in `git log`.
 *
 * Local only: never pushes, resets, cleans or touches ignored files. The tree
 * is built in a temporary index; the branch moves by one compare-and-swap
 * `git update-ref` inside the caller's fenced StateStore transaction (the
 * linearization point); only then is the real index synced.
 *
 * Runs on the Bridge event loop synchronously on purpose (FLY-2331 census:
 * bridge_sync_marker_timeout): no relaunch can interleave between the branch
 * CAS and the index sync. Every git call runs under the sync-operation marker
 * with its own timeout, and the whole checkpoint shares one budget.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { withSyncOpMarker } from "flywheel-claude-runner";

export const WIP_CHECKPOINT_MAX_FILES = 2000;
export const WIP_CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
/** Upper bound on how long one checkpoint may block the Bridge event loop. */
export const WIP_CHECKPOINT_BUDGET_MS = 20_000;

export type WipCheckpointResult =
	| { kind: "clean"; head: string }
	| { kind: "committed"; commit: string }
	| { kind: "adopted"; commit: string }
	| { kind: "refused"; code: string };

export interface WipCheckpointInput {
	cwd: string;
	executionId: string;
	entrySeq: number;
	issueId: string;
	/**
	 * Fenced StateStore transaction: re-check every fence, run `updateRef`
	 * (the branch CAS) and record the checkpoint — or refuse without running it.
	 */
	record(
		commit: string,
		updateRef: () => void,
	): { ok: true } | { ok: false; reason: string };
	git?: (
		args: string[],
		options?: { env?: Record<string, string>; allowFailure?: boolean },
	) => { stdout: string; status: number };
	/** Total git time budget (default WIP_CHECKPOINT_BUDGET_MS). */
	budgetMs?: number;
}

function gitSubcommand(args: string[]): string {
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === "-c") {
			i += 1;
			continue;
		}
		if (!args[i]!.startsWith("-")) return args[i]!;
	}
	return "git";
}

function defaultGit(cwd: string, budgetMs: number) {
	const deadline = Date.now() + budgetMs;
	return (
		args: string[],
		options: { env?: Record<string, string>; allowFailure?: boolean } = {},
	): { stdout: string; status: number } => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("checkpoint_budget_exceeded");
		try {
			const stdout = withSyncOpMarker(
				`codex-quota-wip-checkpoint:${gitSubcommand(args)}`,
				() =>
					execFileSync("git", ["-C", cwd, ...args], {
						encoding: "utf8",
						timeout: Math.min(GIT_TIMEOUT_MS, remaining),
						maxBuffer: 64 * 1024 * 1024,
						env: { ...process.env, ...options.env },
						stdio: ["ignore", "pipe", "pipe"],
					}),
			);
			return { stdout, status: 0 };
		} catch (error) {
			if (!options.allowFailure) throw error;
			const status = (error as { status?: number }).status ?? 1;
			const stdout = String((error as { stdout?: string }).stdout ?? "");
			return { stdout, status };
		}
	};
}

function trailer(executionId: string, entrySeq: number): string {
	return `Flywheel-Quota-Checkpoint: ${executionId}:${entrySeq}`;
}

/** NUL-safe porcelain v2 entries: kind + paths (+ rename source). */
function parseStatus(raw: string): Array<{
	kind: "1" | "2" | "u" | "?" | "!";
	sub: string;
	paths: string[];
}> {
	const tokens = raw.split("\0");
	const entries: Array<{
		kind: "1" | "2" | "u" | "?" | "!";
		sub: string;
		paths: string[];
	}> = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]!;
		if (!token) continue;
		const kind = token[0] as "1" | "2" | "u" | "?" | "!";
		if (kind === "?" || kind === "!") {
			entries.push({ kind, sub: "", paths: [token.slice(2)] });
			continue;
		}
		const fields = token.split(" ");
		if (kind === "1") {
			entries.push({
				kind,
				sub: fields[2] ?? "",
				paths: [fields.slice(8).join(" ")],
			});
		} else if (kind === "2") {
			const origin = tokens[i + 1] ?? "";
			i += 1;
			entries.push({
				kind,
				sub: fields[2] ?? "",
				paths: [fields.slice(9).join(" "), origin],
			});
		} else if (kind === "u") {
			entries.push({
				kind,
				sub: fields[2] ?? "",
				paths: [fields.slice(10).join(" ")],
			});
		}
	}
	return entries;
}

function lock(gitDir: string): () => void {
	const path = join(gitDir, "flywheel-quota-checkpoint.lock");
	mkdirSync(path);
	return () => {
		try {
			rmdirSync(path);
		} catch {
			/* already gone */
		}
	};
}

export function checkpointWorktree(
	input: WipCheckpointInput,
): WipCheckpointResult {
	if (!isAbsolute(input.cwd))
		return { kind: "refused", code: "cwd_not_absolute" };
	const git =
		input.git ??
		defaultGit(input.cwd, input.budgetMs ?? WIP_CHECKPOINT_BUDGET_MS);
	let gitDir: string;
	let branch: string;
	let head: string;
	try {
		gitDir = git(["rev-parse", "--absolute-git-dir"]).stdout.trim();
		const symbolic = git(["symbolic-ref", "-q", "HEAD"], {
			allowFailure: true,
		});
		if (symbolic.status !== 0)
			return { kind: "refused", code: "detached_head" };
		branch = symbolic.stdout.trim();
		head = git(["rev-parse", "HEAD"]).stdout.trim();
	} catch {
		return { kind: "refused", code: "git_unavailable" };
	}
	let release: () => void;
	try {
		release = lock(gitDir);
	} catch {
		return { kind: "refused", code: "checkpoint_locked" };
	}
	try {
		const status = () =>
			git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]).stdout;
		const syncIndex = (commit: string): WipCheckpointResult => {
			git(["read-tree", commit]);
			git(["update-index", "-q", "--refresh"], { allowFailure: true });
			const current = git(["rev-parse", "HEAD"]).stdout.trim();
			if (current !== commit || status().length > 0)
				return { kind: "refused", code: "index_sync_incomplete" };
			return { kind: "committed", commit };
		};
		/** The worktree as a tree, built only in a temporary index. */
		const worktreeTree = (): string => {
			const scratch = mkdtempSync(join(tmpdir(), "fly2900-index-"));
			try {
				const env = { GIT_INDEX_FILE: join(scratch, "index") };
				git(["read-tree", "HEAD"], { env });
				git(["add", "-A"], { env });
				return git(["write-tree"], { env }).stdout.trim();
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		};
		/**
		 * §5.3 step 1 — refuse before any `add`/`hash-object` so an out-of-contract
		 * tree never writes an object.
		 */
		const precheck = (raw: string): WipCheckpointResult | null => {
			const entries = parseStatus(raw);
			if (entries.some((entry) => entry.kind === "u"))
				return { kind: "refused", code: "unmerged_entries" };
			if (entries.some((entry) => entry.sub.startsWith("S")))
				return { kind: "refused", code: "submodule_change" };
			if (entries.length > WIP_CHECKPOINT_MAX_FILES)
				return { kind: "refused", code: "too_many_files" };
			let bytes = 0;
			for (const entry of entries) {
				if (entry.kind === "!") continue;
				const path = join(input.cwd, entry.paths[0]!);
				try {
					bytes += lstatSync(path).size;
				} catch {
					// Deleted in the worktree: contributes nothing.
				}
				if (bytes > WIP_CHECKPOINT_MAX_BYTES)
					return { kind: "refused", code: "too_many_bytes" };
			}
			return null;
		};
		// Crash recovery: a previous run moved the ref but did not sync. Adopt
		// only while the worktree still is exactly that checkpoint — prechecked,
		// then compared without touching the real index or recording anything.
		const headMessage = git(["log", "-1", "--format=%B", "HEAD"]).stdout;
		if (headMessage.includes(trailer(input.executionId, input.entrySeq))) {
			const refused = precheck(status());
			if (refused) return refused;
			const headTree = git(["rev-parse", "HEAD^{tree}"]).stdout.trim();
			if (worktreeTree() !== headTree)
				return { kind: "refused", code: "checkpoint_adoption_drift" };
			const recorded = input.record(head, () => undefined);
			if (!recorded.ok) return { kind: "refused", code: recorded.reason };
			const synced = syncIndex(head);
			return synced.kind === "committed"
				? { kind: "adopted", commit: head }
				: synced;
		}
		const raw = status();
		if (raw.length === 0) return { kind: "clean", head };
		const refused = precheck(raw);
		if (refused) return refused;
		const tree = worktreeTree();
		const commit = git([
			"-c",
			"user.name=Flywheel",
			"-c",
			"user.email=flywheel@localhost",
			"commit-tree",
			tree,
			"-p",
			head,
			"-m",
			`wip(${input.issueId}): codex quota checkpoint of ${input.executionId}`,
			"-m",
			trailer(input.executionId, input.entrySeq),
		]).stdout.trim();
		const recorded = input.record(commit, () => {
			git(["update-ref", branch, commit, head]);
		});
		if (!recorded.ok) return { kind: "refused", code: recorded.reason };
		return syncIndex(commit);
	} catch (error) {
		return {
			kind: "refused",
			code: `git_failed:${String((error as Error).message ?? "")
				.toLowerCase()
				.replace(/[^a-z0-9_]+/g, "_")
				.slice(0, 40)}`,
		};
	} finally {
		release();
	}
}
