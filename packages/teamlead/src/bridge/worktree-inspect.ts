/**
 * FLY-1282: read-only unpushed-work inspection for zombie declarations.
 *
 * When the heartbeat reconcile declares a session's tmux window dead (the
 * FLY-1260 rescue scenario), the Lead alert must carry what would be lost:
 * untracked/modified file paths and unpushed commits in the runner's
 * worktree. This module ONLY reads — rescue actions (commit/push) belong to
 * the Lead (feedback: Lead drives runner lifecycle), never automated here.
 *
 * Robustness contract (Codex design review R1 #6):
 *   - `git status --porcelain=v1 -z --untracked-files=all` parsed on NUL
 *     boundaries (rename records consume their second old-path field; paths
 *     with spaces/newlines survive; nested new directories arrive per-file);
 *   - upstream existence decided by the EXIT CODE of
 *     `git rev-parse --abbrev-ref --symbolic-full-name @{u}` — never by
 *     locale-dependent stderr text;
 *   - unpushed count semantics are explicit: `vs_upstream`
 *     (`rev-list --count @{u}..HEAD`) vs `not_on_any_remote`
 *     (`rev-list --count HEAD --not --remotes`);
 *   - every subquery fails independently: successful fields are retained and
 *     failures land in bounded `warnings` — the caller's alert must fire even
 *     when git is broken (INV-4: inspection failure never eats the alert);
 *   - never throws; per-call 5s timeout, whole-function 10s budget.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecFileResult {
	stdout: string;
	stderr: string;
}

/** Injectable seam (mirrors the TmuxRunner pattern in tmux-lookup.ts). */
export type ExecFileFn = (
	cmd: string,
	args: string[],
	opts: { cwd: string; timeout: number },
) => Promise<ExecFileResult>;

const defaultExecFile: ExecFileFn = (cmd, args, opts) =>
	execFileAsync(cmd, args, opts) as Promise<ExecFileResult>;

export interface WorktreeInspection {
	/** True when at least one subquery succeeded. */
	ok: boolean;
	worktreePath?: string;
	branch?: string;
	/** Untracked file paths, capped at PATH_CAP (see untrackedTotal). */
	untracked?: string[];
	/** Modified/staged/renamed/deleted paths, capped (see modifiedTotal). */
	modified?: string[];
	untrackedTotal?: number;
	modifiedTotal?: number;
	unpushedCommits?: number;
	/** Which question `unpushedCommits` answers (Codex R1 #6). */
	unpushedSemantics?: "vs_upstream" | "not_on_any_remote";
	/** Per-subquery failure notes, each capped at 200 chars, max 5. */
	warnings?: string[];
	/** Set when ok=false (nothing succeeded / path missing). */
	error?: string;
}

const PATH_CAP = 10;
const PER_CALL_TIMEOUT_MS = 5_000;
const TOTAL_BUDGET_MS = 10_000;
const WARNING_CAP = 5;
const TEXT_CAP = 200;

function clip(s: string): string {
	return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) : s;
}

/**
 * Parse `git status --porcelain=v1 -z` output. Records are NUL-separated;
 * a rename/copy record (`R`/`C` in either status column) is followed by ONE
 * extra NUL-separated field holding the ORIGINAL path, which must be consumed
 * with the record (not emitted as its own entry).
 */
export function parsePorcelainZ(stdout: string): {
	untracked: string[];
	modified: string[];
} {
	const untracked: string[] = [];
	const modified: string[] = [];
	const fields = stdout.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue; // trailing NUL / empty
		const xy = field.slice(0, 2);
		const path = field.slice(3);
		if (xy === "??") {
			untracked.push(path);
			continue;
		}
		modified.push(path);
		// Rename/copy: swallow the following old-path field.
		if (xy.includes("R") || xy.includes("C")) i++;
	}
	return { untracked, modified };
}

export async function inspectWorktreeForUnpushedWork(
	worktreePath: string | undefined,
	execFileFn: ExecFileFn = defaultExecFile,
): Promise<WorktreeInspection> {
	if (!worktreePath || !existsSync(worktreePath)) {
		return { ok: false, worktreePath, error: "worktree path unknown or missing" };
	}

	const startedAt = Date.now();
	const warnings: string[] = [];
	const warn = (label: string, err: unknown) => {
		if (warnings.length < WARNING_CAP) {
			warnings.push(clip(`${label}: ${(err as Error)?.message ?? String(err)}`));
		}
	};
	const overBudget = () => Date.now() - startedAt > TOTAL_BUDGET_MS;
	const git = (args: string[]) =>
		execFileFn("git", args, { cwd: worktreePath, timeout: PER_CALL_TIMEOUT_MS });

	const out: WorktreeInspection = { ok: false, worktreePath };

	// 1) status --porcelain=v1 -z (untracked expanded per-file)
	try {
		const { stdout } = await git([
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
		]);
		const { untracked, modified } = parsePorcelainZ(stdout);
		out.untracked = untracked.slice(0, PATH_CAP);
		out.modified = modified.slice(0, PATH_CAP);
		out.untrackedTotal = untracked.length;
		out.modifiedTotal = modified.length;
		out.ok = true;
	} catch (err) {
		warn("status", err);
	}

	// 2) current branch
	if (!overBudget()) {
		try {
			const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
			out.branch = stdout.trim();
			out.ok = true;
		} catch (err) {
			warn("branch", err);
		}
	} else {
		warn("budget", new Error("total budget exceeded before branch query"));
	}

	// 3) unpushed commits — upstream existence by EXIT CODE only.
	if (!overBudget()) {
		let hasUpstream: boolean | null = null;
		try {
			await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
			hasUpstream = true;
		} catch {
			// Non-zero exit: no upstream configured (or probe failed) — fall
			// through to the not-on-any-remote count, which is meaningful in
			// both cases and never fabricates a vs-upstream number.
			hasUpstream = false;
		}
		try {
			if (hasUpstream) {
				const { stdout } = await git(["rev-list", "--count", "@{u}..HEAD"]);
				out.unpushedCommits = Number.parseInt(stdout.trim(), 10);
				out.unpushedSemantics = "vs_upstream";
			} else {
				const { stdout } = await git([
					"rev-list",
					"--count",
					"HEAD",
					"--not",
					"--remotes",
				]);
				out.unpushedCommits = Number.parseInt(stdout.trim(), 10);
				out.unpushedSemantics = "not_on_any_remote";
			}
			if (!Number.isFinite(out.unpushedCommits)) {
				out.unpushedCommits = undefined;
				out.unpushedSemantics = undefined;
				warn("unpushed", new Error("unparseable rev-list count"));
			} else {
				out.ok = true;
			}
		} catch (err) {
			warn("unpushed", err);
		}
	} else {
		warn("budget", new Error("total budget exceeded before unpushed query"));
	}

	if (warnings.length > 0) out.warnings = warnings;
	if (!out.ok) {
		out.error = clip(warnings[0] ?? "all subqueries failed");
	}
	return out;
}
