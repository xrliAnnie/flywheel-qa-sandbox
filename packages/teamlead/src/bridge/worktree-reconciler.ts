/**
 * FLY-603 Layer B — boot reconciler sweep.
 *
 * Drains merged+clean runner worktrees the on-merge hook (Layer A) missed
 * (unhappy paths: early self-exit / non-atomic close / status not relayed).
 *
 * DELETION CONTRACT (the whole point of this feature):
 *   never delete live / unknown / dirty / protected / open-PR worktrees;
 *   only delete a worktree that is provably-dead + clean + merged + non-protected.
 *
 * Everything is path-authoritative (operates on the EXACT `wt.path`/`wt.branch`
 * from `list()`, never a recomputed path) and fail-closed (any probe/lookup
 * uncertainty → retain + audit). Pure logic with injected dependencies so it
 * is unit-testable without a real repo/tmux/gh.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	deriveWorktreeKey,
	type ExternalWorktree,
	type WorktreeManager,
} from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { lookupTmuxTarget, probeTmuxWindowLiveness } from "./tmux-lookup.js";
import {
	gitWorktreeClean,
	worktreeAutocleanEnabled,
} from "./worktree-cleanup.js";

// ── Protected-key building (R4 HIGH-1: path-authoritative, composition-level) ──

/**
 * Build the set of role-aware worktree keys that must NOT be reconciled,
 * from the project's protected sessions. Path-authoritative: when a session
 * has a persisted `worktree_path` we parse the REAL key from it (the
 * `node.id == identifier` invariant is not source-enforced); only when there is
 * no path do we fall back to deriving from issue metadata — and then, if
 * `issue_id !== issue_identifier`, we protect BOTH derived keys (fail-closed).
 */
export function buildProtectedKeys(
	worktreeManager: Pick<WorktreeManager, "parseWorktreeKeyFromPath">,
	mainRepoPath: string,
	projectName: string,
	rows: Session[],
): Set<string> {
	const keys = new Set<string>();
	for (const s of rows) {
		const role = s.session_role ?? "main";
		if (s.worktree_path) {
			const key = worktreeManager.parseWorktreeKeyFromPath(
				mainRepoPath,
				projectName,
				s.worktree_path,
			);
			if (key) {
				keys.add(key);
				continue;
			}
			// path present but unparseable → fall through to id-derived (fail-closed)
		}
		const id = s.issue_id;
		const ident = s.issue_identifier;
		if (ident && id && ident !== id) {
			keys.add(deriveWorktreeKey(id, role));
			keys.add(deriveWorktreeKey(ident, role));
		} else {
			keys.add(deriveWorktreeKey(ident ?? id, role));
		}
	}
	return keys;
}

// ── Live-runner classification (R3/R4 HIGH-2: tri-state + pathless fallback) ──

export type Liveness = "live" | "dead" | "unknown";

export interface LivenessDeps {
	projectName: string;
	mainRepoPath: string;
	/** All sessions for the project (any status) — candidates for this worktree. */
	sessions: Session[];
	worktreeManager: Pick<WorktreeManager, "parseWorktreeKeyFromBranch">;
	/** found|gone|error per execId. */
	lookupTmuxTarget: (
		executionId: string,
		projectName: string,
	) =>
		| { kind: "found"; target: { tmuxWindow: string } }
		| { kind: "gone" }
		| {
				kind: "error";
				error: string;
		  };
	/** alive|dead|indeterminate per tmux window. */
	probeTmuxWindowLiveness: (
		tmuxWindow: string,
	) => Promise<"alive" | "dead" | "indeterminate">;
}

/**
 * Tri-state liveness for a candidate worktree. Maps candidate sessions by EXACT
 * `worktree_path === wt.path` first; for sessions with a NULL `worktree_path`,
 * falls back to matching the worktree key derived from issue metadata
 * (Blueprint can fail to persist worktree_path). Probe errors / ambiguity →
 * `unknown`; only when every candidate is provably dead → `dead`.
 */
export async function classifyWorktreeLiveness(
	wt: ExternalWorktree,
	deps: LivenessDeps,
): Promise<Liveness> {
	const wtKey = deps.worktreeManager.parseWorktreeKeyFromBranch(
		deps.mainRepoPath,
		wt.branch,
	);

	// Codex code-review R1 HIGH-1: candidate set MUST be ADDITIVE — exact
	// `worktree_path` matches AND pathless same-key matches together — deduped by
	// execution_id. Otherwise a stale dead exact-path session would mask a newer
	// live/indeterminate same-key session whose worktree_path never persisted,
	// and we would wrongly classify the live runner as `dead` and delete it.
	const byExec = new Map<string, Session>();
	for (const s of deps.sessions) {
		if (s.worktree_path === wt.path) byExec.set(s.execution_id, s);
	}
	if (wtKey) {
		for (const s of deps.sessions) {
			if (s.worktree_path) continue; // pathless only
			const role = s.session_role ?? "main";
			if (
				deriveWorktreeKey(s.issue_identifier ?? s.issue_id, role) === wtKey ||
				(s.issue_id && deriveWorktreeKey(s.issue_id, role) === wtKey)
			) {
				byExec.set(s.execution_id, s);
			}
		}
	}
	const candidates = [...byExec.values()];

	if (candidates.length === 0) return "dead"; // no session maps here → no runner

	let sawUnknown = false;
	let sawDead = false;
	for (const s of candidates) {
		const look = deps.lookupTmuxTarget(s.execution_id, deps.projectName);
		if (look.kind === "error") {
			sawUnknown = true;
			continue;
		}
		if (look.kind === "gone") {
			sawDead = true;
			continue;
		}
		const probe = await deps.probeTmuxWindowLiveness(look.target.tmuxWindow);
		if (probe === "alive") return "live"; // short-circuit
		if (probe === "indeterminate") sawUnknown = true;
		else sawDead = true;
	}
	if (sawUnknown) return "unknown";
	return sawDead ? "dead" : "unknown";
}

// ── The reconcile sweep ──

export interface ReconcileDeps {
	mainRepoPath: string;
	projectName: string;
	worktreeManager: Pick<
		WorktreeManager,
		| "list"
		| "parseWorktreeKeyFromBranch"
		| "parseWorktreeKeyFromPath"
		| "removeRegisteredWorktree"
	>;
	repoSlug: string;
	/** Project-scoped sibling worktree path prefix dir (boundary check). */
	siblingParent: string;
	protectedKeys: Set<string>;
	probeLiveRunner: (wt: ExternalWorktree) => Promise<Liveness>;
	isWorktreeClean: (worktreePath: string) => Promise<boolean | "unknown">;
	hasOpenPr: (branch: string) => boolean | "unknown";
	isMergedHead: (branch: string, headSha: string) => boolean;
	isAncestorOfMain: (headSha: string) => Promise<boolean>;
	audit: (event: string, detail: Record<string, unknown>) => void;
}

/** True if `child` is strictly under `parent` using path-boundary semantics
 *  (NOT raw startsWith — avoids `flywheel-FLY-60` matching `flywheel-FLY-603`). */
export function isUnder(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function reconcileMergedWorktrees(
	deps: ReconcileDeps,
): Promise<string[]> {
	const removed: string[] = [];
	let all: ExternalWorktree[];
	try {
		all = await deps.worktreeManager.list(deps.mainRepoPath);
	} catch (err) {
		deps.audit("worktree_reconcile_list_failed", {
			error: (err as Error).message,
		});
		return removed;
	}

	const branchPrefix = `${deps.repoSlug}-`;
	for (const wt of all) {
		// (1) only this project's sibling runner worktrees (branchless/detached skip)
		if (!wt.branch || !wt.branch.startsWith(branchPrefix)) continue;
		if (!isUnder(deps.siblingParent, wt.path)) continue;

		// (1b) Codex code-review R2 HIGH: confirm this is a WorktreeManager-managed
		// runner namespace at its CANONICAL path — the path-derived key and the
		// branch-derived key must agree. A same-prefix branch checked out at a
		// non-canonical path (or a wrong-branch path) is NOT ours; never delete it.
		const branchKey = deps.worktreeManager.parseWorktreeKeyFromBranch(
			deps.mainRepoPath,
			wt.branch,
		);
		const pathKey = deps.worktreeManager.parseWorktreeKeyFromPath(
			deps.mainRepoPath,
			deps.projectName,
			wt.path,
		);
		if (!branchKey || !pathKey || branchKey !== pathKey) {
			deps.audit("worktree_reconcile_skip", {
				path: wt.path,
				reason: "not_managed_path",
				branchKey,
				pathKey,
			});
			continue;
		}

		// (2) nested-parent: path is a strict prefix of another registered worktree
		if (all.some((o) => o !== wt && isUnder(wt.path, o.path))) {
			deps.audit("worktree_reconcile_skip", {
				path: wt.path,
				reason: "nested_parent",
			});
			continue;
		}

		// (3) role-aware protected key
		const key = branchKey;
		if (deps.protectedKeys.has(key)) continue;

		// (4) independent tri-state live guard — only `dead` proceeds
		const live = await deps.probeLiveRunner(wt);
		if (live !== "dead") {
			deps.audit("worktree_reconcile_skip", {
				path: wt.path,
				reason: `live_${live}`,
			});
			continue;
		}

		// (5) clean — fail-closed on probe error
		const clean = await deps.isWorktreeClean(wt.path);
		if (clean !== true) {
			deps.audit("worktree_reconcile_skip", {
				path: wt.path,
				reason: clean === "unknown" ? "clean_unknown" : "dirty",
			});
			continue;
		}

		// (6) no open PR — fail-closed on gh uncertainty
		const open = deps.hasOpenPr(wt.branch);
		if (open !== false) {
			deps.audit("worktree_reconcile_skip", {
				path: wt.path,
				reason: open === "unknown" ? "openpr_unknown" : "open_pr",
			});
			continue;
		}

		// (7) merged proof: ancestor-of-main OR merged-PR headRefOid == HEAD
		const head = wt.head ?? "";
		const merged =
			(head && (await deps.isAncestorOfMain(head))) ||
			(head && deps.isMergedHead(wt.branch, head));
		if (!merged) {
			deps.audit("worktree_reconcile_skip", {
				path: wt.path,
				reason: "no_merge_evidence",
			});
			continue;
		}

		// (8) all gates passed → dirty-safe removal by EXACT path
		const res = await deps.worktreeManager.removeRegisteredWorktree(
			deps.mainRepoPath,
			wt as ExternalWorktree,
			{ deleteBranch: true },
		);
		if (res.removed) {
			removed.push(wt.path);
			deps.audit("worktree_reconciled", {
				path: wt.path,
				branch: wt.branch,
				branchDeleted: res.branchDeleted,
			});
		} else {
			deps.audit("worktree_reconcile_remove_failed", {
				path: wt.path,
				error: res.error,
			});
		}
	}
	return removed;
}

// ── Bridge composition: build real deps (gh/git/tmux) + run for a project ──

export function gitExec(
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 20000 }, (err, stdout) => {
			resolve({
				code: err ? ((err as { code?: number }).code ?? 1) : 0,
				stdout: stdout ?? "",
			});
		});
	});
}

/** FLY-1185: the gh PR evidence cache shape (shared with the sweep v2). */
export type GhPrSets = {
	merged: Map<string, Set<string>>;
	open: Set<string>;
	openTruncated: boolean;
};

/** Pull merged/open PR head sets via gh, repo-scoped to projectRoot.
 *  Failure → undefined (fail-closed: caller treats as "unknown"). */
export async function ghPrSets(projectRoot: string): Promise<
	| {
			merged: Map<string, Set<string>>;
			open: Set<string>;
			openTruncated: boolean;
	  }
	| undefined
> {
	const LIMIT = 3000;
	const run = (state: string, fields: string): Promise<string | undefined> =>
		new Promise((resolve) => {
			execFile(
				"gh",
				[
					"pr",
					"list",
					"--state",
					state,
					"--limit",
					String(LIMIT),
					"--json",
					fields,
				],
				{ cwd: projectRoot, timeout: 60000 },
				(err, stdout) => resolve(err ? undefined : stdout),
			);
		});
	const mergedRaw = await run("merged", "headRefName,headRefOid");
	const openRaw = await run("open", "headRefName");
	if (mergedRaw === undefined || openRaw === undefined) return undefined;
	try {
		const mergedArr = JSON.parse(mergedRaw) as Array<{
			headRefName: string;
			headRefOid: string;
		}>;
		const openArr = JSON.parse(openRaw) as Array<{ headRefName: string }>;
		const merged = new Map<string, Set<string>>();
		for (const p of mergedArr) {
			const set = merged.get(p.headRefName) ?? new Set<string>();
			set.add(p.headRefOid);
			merged.set(p.headRefName, set);
		}
		const open = new Set<string>(openArr.map((p) => p.headRefName));
		// Codex code-review R1 MED-3: if the page hit the limit the cache may be
		// incomplete, so a miss is NOT proof of "no open PR".
		return { merged, open, openTruncated: openArr.length >= LIMIT };
	} catch {
		return undefined;
	}
}

/**
 * FLY-603 Layer B composition: build all real deps for one project and run the
 * reconcile. Returns removed paths (empty on any setup failure — fail-closed).
 */
export async function reconcileProjectWorktrees(
	store: StateStore,
	worktreeManager: WorktreeManager,
	project: ProjectEntry,
): Promise<string[]> {
	if (!worktreeAutocleanEnabled()) return [];
	const mainRepoPath = project.projectRoot;
	const projectName = project.projectName;
	const repoSlug = path.basename(mainRepoPath).toLowerCase();
	const siblingParent = path.dirname(mainRepoPath);

	const gh = await ghPrSets(mainRepoPath);
	if (!gh) {
		store.insertEvent({
			event_id: `worktree-reconcile-gh-failed-${projectName}-${Date.now()}`,
			execution_id: `reconcile-${projectName}`,
			issue_id: projectName,
			project_name: projectName,
			event_type: "worktree_reconcile_gh_unavailable",
			source: "bridge.worktree-reconciler",
			payload: {},
		});
		return []; // gh data unavailable → cannot prove merged → reconcile nothing
	}

	// ensure origin/main is current for ancestor checks (best-effort)
	await gitExec(["fetch", "origin", "main", "--quiet"], mainRepoPath);

	const protectedKeys = buildProtectedKeys(
		worktreeManager,
		mainRepoPath,
		projectName,
		store.listWorktreeProtectionSessions(projectName),
	);
	const allSessions = store.getProjectSessions(projectName);

	return reconcileMergedWorktrees({
		mainRepoPath,
		projectName,
		worktreeManager,
		repoSlug,
		siblingParent,
		protectedKeys,
		probeLiveRunner: (wt) =>
			classifyWorktreeLiveness(wt, {
				projectName,
				mainRepoPath,
				sessions: allSessions,
				worktreeManager,
				lookupTmuxTarget,
				probeTmuxWindowLiveness,
			}),
		isWorktreeClean: gitWorktreeClean,
		hasOpenPr: (branch) =>
			gh.open.has(branch) ? true : gh.openTruncated ? "unknown" : false,
		isMergedHead: (branch, head) => gh.merged.get(branch)?.has(head) ?? false,
		isAncestorOfMain: async (head) =>
			(
				await gitExec(
					["merge-base", "--is-ancestor", head, "origin/main"],
					mainRepoPath,
				)
			).code === 0,
		audit: (event, detail) =>
			store.insertEvent({
				event_id: `worktree-reconcile-${event}-${randomUUID()}`,
				execution_id: `reconcile-${projectName}`,
				issue_id: projectName,
				project_name: projectName,
				event_type: event,
				source: "bridge.worktree-reconciler",
				payload: detail,
			}),
	});
}
