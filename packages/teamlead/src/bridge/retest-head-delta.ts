import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isShipDocsPath } from "./ship-relevant-diff.js";

const execFileP = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_DOCS_ONLY_FILES = 50;

export type RetestHeadDeltaResult =
	| { kind: "suppress"; reason: "no_head_delta" }
	| {
			kind: "suppress";
			reason: "docs_only_delta";
			paths: string[];
	  }
	| {
			kind: "retest";
			reason: "product_delta";
			paths: string[];
	  }
	| { kind: "retest"; reason: "unknown" };

export type RetestGit = (cwd: string, args: string[]) => Promise<string>;

const defaultGit: RetestGit = async (cwd, args) => {
	const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
		timeout: 10_000,
	});
	return stdout;
};

/**
 * FLY-1314: classify ONLY the commits after the predecessor QA verdict. Any
 * ancestry/git/metadata uncertainty fails open to a real retest. This is
 * deliberately separate from the PR base→head ship classifier: older code in
 * the PR must not contaminate a verdictHead..currentHead docs-only delta.
 */
export async function classifyRetestHeadDelta(args: {
	worktreePath: string;
	verdictHead: string;
	currentHead: string;
	git?: RetestGit;
}): Promise<RetestHeadDeltaResult> {
	const verdictHead = args.verdictHead.trim().toLowerCase();
	const currentHead = args.currentHead.trim().toLowerCase();
	if (
		!args.worktreePath ||
		!FULL_SHA.test(verdictHead) ||
		!FULL_SHA.test(currentHead)
	) {
		return { kind: "retest", reason: "unknown" };
	}
	if (verdictHead === currentHead) {
		return { kind: "suppress", reason: "no_head_delta" };
	}
	const git = args.git ?? defaultGit;
	try {
		await git(args.worktreePath, [
			"merge-base",
			"--is-ancestor",
			verdictHead,
			currentHead,
		]);
		const stdout = await git(args.worktreePath, [
			"diff",
			"--name-only",
			`${verdictHead}..${currentHead}`,
		]);
		const paths = stdout
			.split(/\r?\n/)
			.map((path) => path.trim())
			.filter(Boolean);
		if (
			paths.length <= MAX_DOCS_ONLY_FILES &&
			paths.every((path) => isShipDocsPath(path))
		) {
			return { kind: "suppress", reason: "docs_only_delta", paths };
		}
		return { kind: "retest", reason: "product_delta", paths };
	} catch {
		return { kind: "retest", reason: "unknown" };
	}
}
