/**
 * FLY-945 Fix B — default seams for the ship-gate head rebind.
 *
 * The AutoQaCoordinator's rebind branch needs two environment probes it must
 * not hard-wire (unit tests inject fakes; plugin.ts wires these defaults):
 *
 *  - `hasGateResponse`: has the approve_to_ship gate question already been
 *    answered? An answered gate is NEVER rebound — the approval is frozen on
 *    the sha the founder saw (recovery goes through the Fix C re-review path).
 *
 *  - `isAncestor`: proof that the reported head is the SAME BRANCH moved
 *    forward (`git merge-base --is-ancestor <old> <new>` inside the session's
 *    worktree), not a head swap. Fail-closed: a missing worktree, a git error
 *    or a non-zero exit all refuse the rebind (the qa_result is then dropped
 *    exactly as before FLY-945).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CommDB } from "flywheel-comm/db";
import { commDbPathForProject } from "./commdb-path.js";

/** True when the gate question already has a response row (read-only). */
export function defaultHasGateResponse(args: {
	projectName: string;
	questionId: string;
}): boolean {
	try {
		const db = CommDB.openReadonly(commDbPathForProject(args.projectName));
		try {
			return db.getResponse(args.questionId) !== undefined;
		} finally {
			db.close();
		}
	} catch {
		// Unreadable CommDB → we cannot prove the gate is unanswered → treat as
		// answered (refuse the rebind; fail-closed).
		return true;
	}
}

/**
 * True iff `oldSha` is an ancestor of `newSha` in the session worktree.
 * Any failure (missing worktree, git error, exit != 0) → false (fail-closed).
 */
export function defaultIsAncestor(args: {
	worktreePath: string;
	oldSha: string;
	newSha: string;
}): boolean {
	if (!args.worktreePath || !existsSync(args.worktreePath)) return false;
	try {
		execFileSync(
			"git",
			["merge-base", "--is-ancestor", args.oldSha, args.newSha],
			{ cwd: args.worktreePath, stdio: "ignore", timeout: 10_000 },
		);
		return true;
	} catch {
		return false;
	}
}
