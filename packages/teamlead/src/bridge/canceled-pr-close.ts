/**
 * FLY-1185 §2.12 (R8#7 + R9#5) — canceled/parked issue open-PR disposal.
 *
 * Auto-close is allowed ONLY under a fully MECHANICAL binding — no body
 * text, no heuristics (plan §2.12 + Codex R1#12 full checklist):
 *   - the session holds a complete worktree binding (path/branch/generation)
 *     and the binding generation matches a FRESH admin-marker read
 *   - the session persisted `pr_number` + `pr_head_sha`
 *   - the LOCAL branch tip (fresh rev-parse) === persisted pr_head_sha
 *   - fresh GitHub object agrees on EVERY axis: state=open, exactly ONE PR
 *     with that number, non-fork head repo, base = repo default branch,
 *     headRefName === binding.branch, headRefOid === persisted pr_head_sha
 *   - the persisted Linear observation still reads `canceled`
 *   - the PR object is RE-READ immediately before the mutation
 * → `gh pr close <number> -R <owner/repo>` (NEVER `--delete-branch` —
 * branch deletion only ever goes through the stability/CAS paths).
 *
 * ANY mismatch → `blocked_open_pr` operator item, never a guess. GitHub
 * close has no lease-CAS — the residual close-vs-reopen race after the last
 * fresh check is the plan's explicitly accepted (reversible) risk.
 */

import { execFile } from "node:child_process";
import type { StateStore } from "../StateStore.js";
import { isUuidKey } from "./lifecycle-root-key.js";

interface GhPrView {
	number: number;
	state: string;
	isCrossRepository: boolean;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
}

export type GhExecFn = (
	args: string[],
	cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultGhExec: GhExecFn = (args, cwd) =>
	new Promise((resolve) => {
		execFile("gh", args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
			resolve({
				code: err ? ((err as { code?: number }).code ?? 1) : 0,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			});
		});
	});

const defaultGitExec: GhExecFn = (args, cwd) =>
	new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 15_000 }, (err, stdout, stderr) => {
			resolve({
				code: err ? ((err as { code?: number }).code ?? 1) : 0,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			});
		});
	});

export interface CanceledPrCloseDeps {
	store: Pick<
		StateStore,
		| "getSessionsForIssueAliases"
		| "getSession"
		| "getWorktreeBinding"
		| "getLinearStateObservation"
		| "insertEvent"
	>;
	resolveProjectRoot: (projectName: string) => string | undefined;
	/** Fresh admin-marker read for the binding path (WorktreeManager seam).
	 * Absent → generation re-verification unavailable → blocked (fail-closed). */
	readGeneration?: (
		mainRepoPath: string,
		worktreePath: string,
	) => Promise<string | undefined>;
	/** Repo default branch (base drift check). Default "main". */
	defaultBranch?: string;
	gh?: GhExecFn;
	git?: GhExecFn;
}

async function fetchPrView(
	gh: GhExecFn,
	prNumber: number,
	repo: string | undefined,
	cwd: string,
): Promise<GhPrView | undefined> {
	const args = [
		"pr",
		"view",
		String(prNumber),
		...(repo ? ["-R", repo] : []),
		"--json",
		"number,state,isCrossRepository,baseRefName,headRefName,headRefOid",
	];
	const view = await gh(args, cwd);
	if (view.code !== 0) return undefined;
	try {
		return JSON.parse(view.stdout) as GhPrView;
	} catch {
		return undefined;
	}
}

function mechanicallyBound(
	pr: GhPrView,
	expect: {
		prNumber: number;
		prHeadSha: string;
		bindingBranch: string;
		defaultBranch: string;
	},
): boolean {
	return (
		pr.number === expect.prNumber &&
		pr.state === "OPEN" &&
		pr.isCrossRepository === false &&
		pr.baseRefName === expect.defaultBranch &&
		pr.headRefName === expect.bindingBranch &&
		pr.headRefOid === expect.prHeadSha
	);
}

/**
 * Dispose open PRs of a canceled issue's sessions. Returns operator items
 * for every PR it refused to touch. founder_parked → zero PR mutation
 * (parked issues keep their PRs; only report).
 */
export function makeCanceledPrDisposal(deps: CanceledPrCloseDeps) {
	return async (args: {
		disposition: "shipped" | "canceled" | "founder_parked";
		aliasKeys: string[];
		/** R3#13: each `gh pr close` consumes one budget slot. */
		budget?: { tryConsume: () => boolean; shouldStop?: () => boolean };
	}): Promise<{ blockedItems?: string[] }> => {
		if (args.disposition !== "canceled") return {};
		const gh = deps.gh ?? defaultGhExec;
		const git = deps.git ?? defaultGitExec;
		const blockedItems: string[] = [];
		const rootUuid = args.aliasKeys.find((k) => isUuidKey(k));

		const rows = deps.store.getSessionsForIssueAliases(args.aliasKeys);
		for (const row of rows) {
			const session = deps.store.getSession(row.execution_id);
			const prNumber = session?.pr_number;
			const prHeadSha = session?.pr_head_sha;
			if (!prNumber) continue; // no PR recorded — nothing to dispose
			const label = `blocked_open_pr:${prNumber}`;

			const projectRoot = deps.resolveProjectRoot(row.project_name);
			const binding = deps.store.getWorktreeBinding(row.execution_id);
			if (!projectRoot || !binding || !prHeadSha) {
				blockedItems.push(label);
				continue;
			}

			// Codex R1#12(a): persisted Linear disposition must STILL read
			// canceled at mutation time (the durable observation seam).
			const obs = rootUuid
				? deps.store.getLinearStateObservation(row.project_name, rootUuid)
				: undefined;
			if (!obs || obs.lastStateType !== "canceled") {
				blockedItems.push(label);
				continue;
			}

			// Codex R1#12(b): FRESH generation-marker read must match the
			// persisted binding generation (same §2.1 contract as deletions).
			if (!deps.readGeneration) {
				blockedItems.push(label);
				continue;
			}
			const freshGen = await deps
				.readGeneration(projectRoot, binding.path)
				.catch(() => undefined);
			if (!freshGen || freshGen !== binding.generation) {
				blockedItems.push(label);
				continue;
			}

			// Codex R1#12(c): the LOCAL branch tip must equal the persisted
			// pr_head_sha (headRefOid === fresh tip === expected SHA).
			const tip = await git(
				["rev-parse", "--verify", "-q", `refs/heads/${binding.branch}`],
				projectRoot,
			);
			if (tip.code !== 0 || tip.stdout.trim() !== prHeadSha) {
				blockedItems.push(label);
				continue;
			}

			// Resolve owner/repo for the FIXED `-R` form (plan §2.12).
			const repoView = await gh(
				["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
				projectRoot,
			);
			const repo = repoView.code === 0 ? repoView.stdout.trim() : undefined;
			if (!repo) {
				blockedItems.push(label);
				continue;
			}

			const defaultBranch = deps.defaultBranch ?? "main";
			const expect = {
				prNumber,
				prHeadSha,
				bindingBranch: binding.branch,
				defaultBranch,
			};

			const pr = await fetchPrView(gh, prNumber, repo, projectRoot);
			if (!pr) {
				blockedItems.push(label);
				continue;
			}
			if (!mechanicallyBound(pr, expect)) {
				if (pr.state !== "OPEN") continue; // already closed/merged — no item
				blockedItems.push(label);
				continue;
			}

			// Codex R1#12(d): RE-READ the PR object immediately before the
			// mutation — any drift in the window refuses the close.
			const fresh = await fetchPrView(gh, prNumber, repo, projectRoot);
			if (!fresh || !mechanicallyBound(fresh, expect)) {
				if (fresh && fresh.state !== "OPEN") continue;
				blockedItems.push(label);
				continue;
			}

			// Codex R2#12: FINAL pre-mutation re-verification of the OTHER
			// authorities too — the persisted Linear disposition, the admin
			// generation marker and the local tip are all re-read right before
			// the fixed close command (the earlier reads happened before several
			// slow awaits). Any drift or read failure → blocked_open_pr.
			const finalObs = rootUuid
				? deps.store.getLinearStateObservation(row.project_name, rootUuid)
				: undefined;
			const finalGen = await deps
				.readGeneration(projectRoot, binding.path)
				.catch(() => undefined);
			const finalTip = await git(
				["rev-parse", "--verify", "-q", `refs/heads/${binding.branch}`],
				projectRoot,
			);
			if (
				!finalObs ||
				finalObs.lastStateType !== "canceled" ||
				!finalGen ||
				finalGen !== binding.generation ||
				finalTip.code !== 0 ||
				finalTip.stdout.trim() !== prHeadSha
			) {
				blockedItems.push(label);
				continue;
			}

			// R3#13: one mutator slot per PR close (call-level cap).
			if (
				args.budget &&
				(args.budget.shouldStop?.() || !args.budget.tryConsume())
			) {
				blockedItems.push(`budget_exhausted:${label}`);
				continue;
			}
			// Fixed command — `--delete-branch` is FORBIDDEN here by contract.
			const close = await gh(
				["pr", "close", String(prNumber), "-R", repo],
				projectRoot,
			);
			deps.store.insertEvent({
				event_id: `canceled-pr-close-${row.execution_id}-${prNumber}`,
				execution_id: row.execution_id,
				issue_id: row.issue_id,
				project_name: row.project_name,
				event_type:
					close.code === 0 ? "canceled_pr_closed" : "canceled_pr_close_failed",
				source: "bridge.canceled-pr-close",
				payload: {
					prNumber,
					repo,
					headRefOid: prHeadSha,
					error: close.code === 0 ? undefined : close.stderr.slice(0, 300),
				},
			});
			if (close.code !== 0) blockedItems.push(label);
		}
		return blockedItems.length > 0 ? { blockedItems } : {};
	};
}
