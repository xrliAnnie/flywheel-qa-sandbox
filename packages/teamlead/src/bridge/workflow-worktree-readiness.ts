import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { gitWorktreeClean } from "./worktree-cleanup.js";

const execFileP = promisify(execFile);

export interface WorkflowWorktreeReadinessDeps {
	exists?: (path: string) => boolean;
	clean?: typeof gitWorktreeClean;
	execGit?: (args: string[]) => Promise<{ stdout: string }>;
}

export type WorkflowWorktreeReadiness =
	| { ok: true }
	| { ok: false; reason: string };

/** One baseline policy for rework and ship-carrier handoff. A clean report or
 * metadata commit on top of the delivered base is legitimate; divergence and
 * rewrites still fail closed. */
export async function assertWorkflowWorktreeReady(
	worktree: string,
	expectedHeadSha: string,
	deps: WorkflowWorktreeReadinessDeps = {},
): Promise<WorkflowWorktreeReadiness> {
	if (!(deps.exists ?? existsSync)(worktree)) {
		return { ok: false, reason: `worktree_missing:${worktree}` };
	}
	const clean = await (deps.clean ?? gitWorktreeClean)(worktree);
	if (clean !== true) {
		return {
			ok: false,
			reason: clean === false ? "worktree_dirty" : "worktree_unverifiable",
		};
	}
	const execGit =
		deps.execGit ??
		(async (args: string[]) => {
			const result = await execFileP("git", args);
			return { stdout: result.stdout };
		});
	const expected = expectedHeadSha.trim().toLowerCase();
	let actual: string;
	try {
		actual = (await execGit(["-C", worktree, "rev-parse", "HEAD"])).stdout
			.trim()
			.toLowerCase();
	} catch (error) {
		return {
			ok: false,
			reason: `head_probe_failed:${(error as Error).message}`,
		};
	}
	if (actual === expected) return { ok: true };
	try {
		await execGit([
			"-C",
			worktree,
			"merge-base",
			"--is-ancestor",
			expected,
			actual,
		]);
		return { ok: true };
	} catch (error) {
		const code = (error as { code?: number | string }).code;
		if (code === 1 || code === "1") {
			return {
				ok: false,
				reason: `head_not_fast_forward:${actual}:${expectedHeadSha}`,
			};
		}
		return {
			ok: false,
			reason: `head_probe_failed:${(error as Error).message}`,
		};
	}
}
