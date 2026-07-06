/**
 * FLY-795 (Codex design review R2 #2): the shared, deterministic resolver for a
 * `progress.md` path.
 *
 * PURE by construction: all git/fs lookups (reading the persisted `plan_path`
 * from StateStore, discovering an existing issue-prefixed doc folder on the
 * branch) are done by the CALLERS, which pass their results in. This guarantees the
 * WRITE side (the `flywheel-comm progress` command), the READ side (teamlead
 * resume detection), and the INJECT side (Blueprint `FLYWHEEL_PROGRESS_PATH`)
 * all compute the SAME path — progress.md never drifts from the doc-flow docs.
 *
 * Precedence (highest first):
 *   ① persisted `planPath` → its dirname + `/progress.md`
 *   ② a discovered doc dir (`${issue}-*` on the branch) → dir + `/progress.md`
 *   ③ deterministic default → `${docBaseDir}/${issue}-${slug|progress}/progress.md`
 *      (docTier `none`, i.e. no slug/folder, lands on `${issue}-progress`).
 */

export interface ProgressPathInput {
	/** doc-flow base dir for the department, e.g. "engineering/doc" (caller resolves). */
	docBaseDir: string;
	/** issue identifier, e.g. "FLY-795". */
	issueIdentifier: string;
	/** kebab slug for the deterministic default; absent = docTier-none fallback. */
	slug?: string;
	/** persisted StateStore `session.plan_path` (caller reads); highest precedence. */
	planPath?: string;
	/** an existing `${issue}-*` doc dir the caller discovered on the branch. */
	discoveredDocDir?: string;
}

const PROGRESS_FILE = "progress.md";

/** Compute the deterministic, relative `progress.md` path. */
export function resolveProgressPath(input: ProgressPathInput): string {
	const dir = resolveDocDir(input);
	return joinRel(dir, PROGRESS_FILE);
}

function resolveDocDir(input: ProgressPathInput): string {
	// ① persisted plan_path dirname
	if (input.planPath) {
		const d = dirnameRel(input.planPath);
		if (d) return d;
	}
	// ② discovered doc dir
	if (input.discoveredDocDir) {
		return stripTrailingSlash(input.discoveredDocDir);
	}
	// ③ deterministic default
	const folder = input.slug
		? `${input.issueIdentifier}-${input.slug}`
		: `${input.issueIdentifier}-progress`;
	return joinRel(stripTrailingSlash(input.docBaseDir), folder);
}

function dirnameRel(p: string): string {
	const norm = stripTrailingSlash(p);
	const idx = norm.lastIndexOf("/");
	return idx > 0 ? norm.slice(0, idx) : "";
}

function joinRel(a: string, b: string): string {
	return `${stripTrailingSlash(a)}/${b}`;
}

function stripTrailingSlash(p: string): string {
	return p.replace(/\/+$/, "");
}
