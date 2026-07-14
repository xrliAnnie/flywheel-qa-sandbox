/**
 * FLY-1185 §2.9/§2.4/§2.3 — sweep v2: the repo-level lifecycle backstop
 * (entry E of the unified closeout contract; FLY-603 Layer B folded in and
 * extended). ONE engine serves the periodic sweep AND the read-only
 * dry-run manifest (`--dry-run` of cleanup-sweep-cli).
 *
 * Scope per pass (ALL inside the per-repo mutation lock):
 *   1. WORKTREES — scan roots: sibling parent + `<projectRoot>/worktrees/`
 *      + every registered worktree's internal `worktrees/`; children first
 *      (path-depth descending — nested parents dissolve naturally).
 *      Families:
 *        - clean+merged (today's Layer B, SAME strength — no new gates);
 *        - QA-ephemeral (`…-qa` role keys): binding-owned + dead + no open
 *          PR + 3d stability → quarantine-if-dirty → remove + CAS branch;
 *        - dirty-aged / stable-abandoned: binding-owned + dead + no open PR
 *          + 3d stability (+ merge evidence for dirty-aged) → quarantine →
 *          force remove + CAS branch.
 *      NEW deletion families REQUIRE `session_path` binding ownership
 *      (unowned = manual-only, no shape fallback — R6#1).
 *   2. BRANCH PASS — managed-shape refs with no worktree occupancy:
 *        - REMOTE refs meeting the gates → lease-CAS delete (stable-
 *          abandoned bundles first, audited `unmerged_tip_archived`);
 *        - LOCAL orphan refs → bundle + manifest entry ONLY (R4#3 — the
 *          periodic path NEVER auto-deletes local refs; deletion happens
 *          only through the approved manual apply).
 *
 * Fail-closed everywhere: policy disabled / gh unavailable / probe errors /
 * liveness unknown / quarantine failure → retain + audit. The stability
 * gate is the durable `cleanup_ref_observations` table — 3 days of
 * unchanged fingerprint across sweeps before ANY new family may delete.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExternalWorktree, WorktreeManager } from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	bundleBranch,
	casDeleteLocalBranch,
	casDeleteRemoteBranch,
	isBaseBranch,
	isProtectedBranch,
} from "./branch-cleanup.js";
import type { CleanupPolicyByProject } from "./cleanup-policy.js";
import { type CleanupPolicy, policyFor } from "./cleanup-policy.js";
import type { WithRepoLock } from "./repo-mutation-lock.js";
import { lookupTmuxTarget, probeTmuxWindowLiveness } from "./tmux-lookup.js";
import { worktreeAutocleanEnabled } from "./worktree-cleanup.js";
import { quarantineWorktree } from "./worktree-quarantine.js";
import {
	buildProtectedKeys,
	classifyWorktreeLiveness,
	type GhPrSets,
	ghPrSets,
	gitExec,
	isUnder,
} from "./worktree-reconciler.js";

/** Hardcoded stability window (plan §2.3 — no flag). */
export const STABILITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** QA Room slot reserved namespace — NEVER touched (research §2.2 red line). */
export function isReservedNamespaceKey(key: string | null): boolean {
	return !!key && /^qa-slot(-|$)/.test(key);
}

/** QA scratch role suffix — the sanitized `deriveWorktreeKey(_, "qa")` shape. */
export function isQaEphemeralKey(key: string | null): boolean {
	return !!key && key.endsWith("-qa");
}

/** Family-relaxed key match: branchKey === pathKey OR under the issue family
 *  (`FLY-1160-phase-b` ∈ family `FLY-1160` — research §2.4). */
export function isSameIssueFamily(
	pathKey: string | null,
	branchKey: string | null,
): boolean {
	if (!pathKey || !branchKey) return false;
	return branchKey === pathKey || branchKey.startsWith(`${pathKey}-`);
}

export interface SweepManifestEntry {
	kind: "worktree" | "local_branch" | "remote_branch";
	ref: string;
	family?: "clean_merged" | "qa_ephemeral" | "dirty_aged" | "stable_abandoned";
	action:
		| "deleted"
		| "quarantined_deleted"
		| "bundled_manifest_only"
		| "would_delete"
		| "would_bundle"
		| "skipped";
	reason?: string;
	expectedSha?: string;
	quarantinePath?: string;
	bundlePath?: string;
	ownership?: "session_path" | "unowned";
}

export interface LifecycleSweepResult {
	entries: SweepManifestEntry[];
	policyDisabled?: string;
	ghUnavailable?: boolean;
}

export interface LifecycleSweepDeps {
	store: StateStore;
	worktreeManager: WorktreeManager;
	project: Pick<ProjectEntry, "projectName" | "projectRoot">;
	policies?: CleanupPolicyByProject;
	withRepoLock: WithRepoLock;
	/** Read-only manifest pass — NO mutations, ignores the master switch. */
	dryRun?: boolean;
	/**
	 * FLY-1185 (R10#3): APPROVED-MANIFEST apply mode — the Bridge-internal
	 * execution of `cleanup-sweep-cli --apply`. Only refs LISTED in the
	 * approved manifest are candidates; each must still carry its EXACT
	 * approved sha (any drift → `manifest_drift` skip, never a widened
	 * batch); the 3d stability/activity gates are waived (a human approved
	 * this exact snapshot) but every MECHANICAL safety stays: liveness,
	 * open-PR, occupancy, CAS, quarantine-before-force. `includeUnowned`
	 * relaxes the binding-ownership requirement for exactly these listed
	 * objects (the legacy-inventory path — plan §6 first sweep). LOCAL
	 * branch deletion happens ONLY here (R4#3: the periodic path never
	 * deletes local refs; the approved apply is the one sanctioned door).
	 */
	apply?: {
		/** Keyed `${kind}:${ref}` (Codex R2#7) — e.g. `worktree:/abs/path`,
		 * `local_branch:name`, `remote_branch:name`. */
		expectedByRef: Map<string, string>;
		includeUnowned: boolean;
		/** R5#8 (plan.md:156/158): shared run budget — EVERY git mutator
		 * (worktree remove / local + remote branch delete) draws one slot and
		 * checks the deadline BEFORE acting, so a large manifest cannot delete
		 * unboundedly and then starve the issue closeouts. Absent → unbounded
		 * (byte-compat for callers that don't wire it). */
		budget?: { tryConsume: () => boolean; shouldStop: () => boolean };
	};
	quarantineRoot?: string;
	bundleDir?: string;
	nowMs?: () => number;
	// Test seams
	ghPrSetsFn?: typeof ghPrSets;
	gitExecFn?: typeof gitExec;
	isWorktreeClean?: (wtPath: string) => Promise<boolean | "unknown">;
	quarantineFn?: typeof quarantineWorktree;
	lookupTarget?: typeof lookupTmuxTarget;
	probeLiveness?: typeof probeTmuxWindowLiveness;
	autoclean?: boolean;
}

function defaultBundleDir(): string {
	return path.join(homedir(), ".flywheel", "archives", "branch-bundles");
}

function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** True when the worktree shows活动 within the stability window (fail-closed). */
async function worktreeRecentlyActive(
	wtPath: string,
	nowMs: number,
): Promise<boolean | "unknown"> {
	try {
		// index/HEAD/logs mtime under the ADMIN dir + the working dir itself.
		const gitFile = path.join(wtPath, ".git");
		const candidates = [wtPath, gitFile];
		let adminDir: string | undefined;
		try {
			const content = fs.readFileSync(gitFile, "utf8");
			const m = content.match(/^gitdir:\s*(.+)$/m);
			if (m?.[1]) adminDir = m[1].trim();
		} catch {
			// .git may be a dir (main repo) — not our candidate shape anyway
		}
		if (adminDir) {
			for (const f of ["index", "HEAD", "logs/HEAD"]) {
				candidates.push(path.join(adminDir, f));
			}
		}
		for (const c of candidates) {
			try {
				const st = fs.statSync(c);
				if (nowMs - st.mtimeMs < STABILITY_WINDOW_MS) return true;
			} catch {
				// missing candidate file — ignore
			}
		}
		return false;
	} catch {
		return "unknown";
	}
}

/**
 * The sweep engine. Never throws; every decision is an audit entry.
 */
export async function sweepProjectLifecycle(
	deps: LifecycleSweepDeps,
): Promise<LifecycleSweepResult> {
	const result: LifecycleSweepResult = { entries: [] };
	const dryRun = deps.dryRun ?? false;
	const autoclean = deps.autoclean ?? worktreeAutocleanEnabled();
	const nowMs = deps.nowMs ?? (() => Date.now());
	const { store, worktreeManager, project } = deps;
	const mainRepoPath = project.projectRoot;
	const projectName = project.projectName;
	const repoSlug = path.basename(mainRepoPath).toLowerCase();
	const siblingParent = path.dirname(mainRepoPath);
	const runGit = deps.gitExecFn ?? gitExec;
	const isClean = deps.isWorktreeClean ?? noLockWorktreeClean;
	const quarantine = deps.quarantineFn ?? quarantineWorktreeDefault(deps);
	const policy: CleanupPolicy = policyFor(deps.policies, projectName);

	const audit = (event: string, detail: Record<string, unknown>) => {
		try {
			store.insertEvent({
				event_id: `lifecycle-sweep-${event}-${projectName}-${nowMs()}-${Math.floor(Math.random() * 1e9)}`,
				execution_id: `sweep-${projectName}`,
				issue_id: projectName,
				project_name: projectName,
				event_type: event,
				source: "bridge.lifecycle-sweep",
				payload: detail,
			});
		} catch {
			// audit must never break the sweep
		}
	};

	if (!policy.enabled) {
		result.policyDisabled = policy.reason;
		audit("lifecycle_sweep_policy_disabled", { reason: policy.reason });
		return result;
	}
	// Master escape hatch: mutations require FLYWHEEL_WORKTREE_AUTOCLEAN != 0;
	// the read-only dry-run manifest is exempt (plan §0 hard rule).
	const mayMutate = !dryRun && autoclean;
	if (!dryRun && !autoclean) {
		audit("lifecycle_sweep_disabled_by_autoclean", {});
		return result;
	}

	try {
		await deps.withRepoLock(mainRepoPath, async () => {
			// ── Evidence gathering (fresh, inside the lock) ──
			const hasOrigin =
				(await runGit(["remote", "get-url", "origin"], mainRepoPath)).code ===
				0;
			let gh: GhPrSets | undefined;
			if (hasOrigin) {
				gh = await (deps.ghPrSetsFn ?? ghPrSets)(mainRepoPath);
				if (!gh) {
					result.ghUnavailable = true;
					audit("lifecycle_sweep_gh_unavailable", {});
				}
				// Codex R1#11: dry-run is READ-ONLY — no fetch (it writes
				// FETCH_HEAD / refs / object store). The manifest uses local
				// refs; apply re-verifies freshness with its per-ref CAS anyway.
				if (!dryRun) {
					await runGit(["fetch", "origin", "main", "--quiet"], mainRepoPath);
				}
			}
			const hasOpenPr = (branch: string): boolean | "unknown" => {
				if (!hasOrigin) return false; // no origin → no PRs can exist
				if (!gh) return "unknown"; // gh down → fail-closed
				if (gh.open.has(branch)) return true;
				return gh.openTruncated ? "unknown" : false;
			};
			const isMergedHead = (branch: string, head: string): boolean =>
				gh?.merged.get(branch)?.has(head) ?? false;
			const isAncestorOfMain = async (head: string): Promise<boolean> =>
				hasOrigin &&
				(
					await runGit(
						["merge-base", "--is-ancestor", head, "origin/main"],
						mainRepoPath,
					)
				).code === 0;

			const protectedKeys = buildProtectedKeys(
				worktreeManager,
				mainRepoPath,
				projectName,
				store.listWorktreeProtectionSessions(projectName),
			);
			const allSessions = store.getProjectSessions(projectName);
			const bindings = store.listWorktreeBindings(projectName);

			const all = await worktreeManager.list(mainRepoPath);
			const internalRoots = [
				path.join(mainRepoPath, "worktrees"),
				...all.map((w) => path.join(w.path, "worktrees")),
			];

			const isInScanRoots = (p: string): boolean =>
				isUnder(siblingParent, p) || internalRoots.some((r) => isUnder(r, p));

			// candidates: managed shape, in scope, not the main repo itself
			const candidates = all
				.filter((wt) => wt.path !== mainRepoPath && !wt.isBare)
				.filter((wt) => isInScanRoots(wt.path))
				.filter((wt) => wt.branch?.startsWith(`${repoSlug}-`))
				// children first — nested parents dissolve after their children go
				.sort(
					(a, b) =>
						b.path.split(path.sep).length - a.path.split(path.sep).length,
				);

			const removedPaths = new Set<string>();
			// Codex R2#11: `${kind}:${ref}` observed this pass — anything with a
			// durable observation but NOT seen (object deleted/recreated outside
			// us) gets its stability anchor reset at the end of the pass.
			const seenRefs = new Set<string>(
				candidates.map((wt) => `worktree:${wt.path}`),
			);

			for (const wt of candidates) {
				const entry = await sweepOneWorktree(wt, {
					deps,
					dryRun,
					mayMutate,
					mainRepoPath,
					projectName,
					repoSlug,
					policy,
					protectedKeys,
					allSessions,
					bindings,
					hasOpenPr,
					isMergedHead,
					isAncestorOfMain,
					isClean,
					quarantine,
					audit,
					nowMs,
					all,
					removedPaths,
				});
				if (entry) result.entries.push(entry);
			}

			// ── Branch pass ──
			await sweepBranches({
				seenRefs,
				deps,
				dryRun,
				mayMutate,
				mainRepoPath,
				projectName,
				repoSlug,
				policy,
				protectedKeys,
				hasOrigin,
				gh,
				hasOpenPr,
				isAncestorOfMain,
				runGit,
				audit,
				nowMs,
				result,
			});

			// ── Codex R2#11: end-of-pass observation inventory. An observation
			// whose object was NOT seen this pass (deleted / recreated outside
			// us) is reset — a delete/recreate with the same fingerprint must
			// restart the 3d window from zero, never inherit the old anchor. ──
			if (!dryRun) {
				for (const obs of store.listCleanupRefObservations(projectName)) {
					if (!seenRefs.has(`${obs.kind}:${obs.ref}`)) {
						store.deleteCleanupRefObservation(projectName, obs.kind, obs.ref);
						audit("lifecycle_sweep_observation_reset", {
							kind: obs.kind,
							ref: obs.ref,
							reason: "object_not_seen_this_pass",
						});
					}
				}
			}
		});
	} catch (err) {
		audit("lifecycle_sweep_failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
	return result;
}

function quarantineWorktreeDefault(deps: LifecycleSweepDeps) {
	return (opts: Parameters<typeof quarantineWorktree>[0]) =>
		quarantineWorktree({
			...opts,
			quarantineRoot: deps.quarantineRoot ?? opts.quarantineRoot,
		});
}

interface WorktreeSweepCtx {
	deps: LifecycleSweepDeps;
	dryRun: boolean;
	mayMutate: boolean;
	mainRepoPath: string;
	projectName: string;
	repoSlug: string;
	policy: CleanupPolicy & { enabled: true };
	protectedKeys: Set<string>;
	allSessions: ReturnType<StateStore["getProjectSessions"]>;
	bindings: ReturnType<StateStore["listWorktreeBindings"]>;
	hasOpenPr: (branch: string) => boolean | "unknown";
	isMergedHead: (branch: string, head: string) => boolean;
	isAncestorOfMain: (head: string) => Promise<boolean>;
	isClean: (wtPath: string) => Promise<boolean | "unknown">;
	quarantine: ReturnType<typeof quarantineWorktreeDefault>;
	audit: (event: string, detail: Record<string, unknown>) => void;
	nowMs: () => number;
	all: ExternalWorktree[];
	removedPaths: Set<string>;
}

async function sweepOneWorktree(
	wt: ExternalWorktree,
	ctx: WorktreeSweepCtx,
): Promise<SweepManifestEntry | undefined> {
	const {
		deps,
		dryRun,
		mayMutate,
		mainRepoPath,
		projectName,
		policy,
		protectedKeys,
		bindings,
		audit,
	} = ctx;
	const { store, worktreeManager } = deps;
	const skip = (reason: string): SweepManifestEntry => {
		audit("lifecycle_sweep_worktree_skip", { path: wt.path, reason });
		return { kind: "worktree", ref: wt.path, action: "skipped", reason };
	};
	// Codex R1#10 — CONTINUOUS eligibility: any dynamic gate failure resets the
	// durable stability anchor, so the 3d window restarts from scratch when the
	// object becomes eligible again (a ref protected by an open PR / live
	// runner for days must NOT inherit a stale first_seen_eligible_at).
	const resetGate = (reason: string): SweepManifestEntry => {
		if (!dryRun) {
			store.deleteCleanupRefObservation(projectName, "worktree", wt.path);
		}
		return skip(reason);
	};

	if (!wt.branch) return resetGate("branchless_or_detached");

	// Keys: path-derived + branch-derived, family-relaxed (research §2.4).
	const branchKey = worktreeManager.parseWorktreeKeyFromBranch(
		mainRepoPath,
		wt.branch,
	);
	const pathKey = worktreeManager.parseWorktreeKeyFromPath(
		mainRepoPath,
		projectName,
		wt.path,
	);
	// Internal `worktrees/` roots have non-canonical parents → pathKey null;
	// fall back to basename-derived key for family purposes only.
	const base = path.basename(wt.path);
	const fallbackKey = base.startsWith(`${ctx.repoSlug}-`)
		? base.slice(ctx.repoSlug.length + 1)
		: null;
	const effectivePathKey = pathKey ?? fallbackKey;
	if (!branchKey) return resetGate("not_managed_branch");
	if (!effectivePathKey || !isSameIssueFamily(effectivePathKey, branchKey)) {
		return skip("key_family_mismatch");
	}
	const key = branchKey;

	// Reserved / protected — always retained.
	if (isReservedNamespaceKey(key) || isReservedNamespaceKey(effectivePathKey)) {
		return skip("reserved_namespace");
	}
	if (protectedKeys.has(key) || protectedKeys.has(effectivePathKey)) {
		return resetGate("protected_session_key");
	}
	if (isProtectedBranch(wt.branch, policy.protectedBranches)) {
		return resetGate("protected_branch_config");
	}
	if (isBaseBranch(wt.branch)) return resetGate("base_branch");

	// Nested parent still holding children? (children sorted first — if any
	// remaining registered worktree lives under this one, retain this pass.)
	if (
		ctx.all.some(
			(o) =>
				o !== wt && !ctx.removedPaths.has(o.path) && isUnder(wt.path, o.path),
		)
	) {
		return resetGate("nested_parent");
	}

	// FLY-1185 (R10#3) apply mode: only manifest-listed refs are candidates,
	// and each must sit at its EXACT approved sha (drift → reject this object,
	// never a widened batch).
	const applyMode = deps.apply;
	if (applyMode) {
		// Codex R2#7: approval identity is (kind, ref) — a branch approval can
		// never authorize a worktree (or local↔remote) deletion, even on a
		// name/sha collision.
		const expected = applyMode.expectedByRef.get(`worktree:${wt.path}`);
		if (expected === undefined) return skip("not_in_manifest");
		if (wt.head && expected !== wt.head) return skip("manifest_drift");
	}

	// Liveness tri-state — only provably dead proceeds.
	const live = await classifyWorktreeLiveness(wt, {
		projectName,
		mainRepoPath,
		sessions: ctx.allSessions,
		worktreeManager,
		lookupTmuxTarget: deps.lookupTarget ?? lookupTmuxTarget,
		probeTmuxWindowLiveness: deps.probeLiveness ?? probeTmuxWindowLiveness,
	});
	if (live !== "dead") return resetGate(`live_${live}`);

	// Open PR — fail-closed on unknown.
	const open = ctx.hasOpenPr(wt.branch);
	if (open !== false) {
		return resetGate(open === "unknown" ? "openpr_unknown" : "open_pr");
	}

	const clean = await ctx.isClean(wt.path);
	if (clean === "unknown") return resetGate("clean_unknown");

	const head = wt.head ?? "";
	const merged =
		!!head &&
		((await ctx.isAncestorOfMain(head)) || ctx.isMergedHead(wt.branch, head));

	// Ownership (binding provenance) — REQUIRED for all NEW deletion families.
	const ownership = await worktreeManager.classifyWorktreePath(
		mainRepoPath,
		projectName,
		wt,
		bindings,
	);

	// ── family (a): clean + merged ──
	// Codex R3#11 (plan §73 governs): "无 binding = 一律 unowned/manual-only,
	// 没有形状 fallback" — the ownership contract applies to EVERY periodic
	// deletion family, clean+merged included. Pre-deployment siblings without
	// a binding lose Layer B auto-cleanup and converge via the approved
	// manual apply (dry-run still lists them WITH their exact sha). The ship
	// path (Layer A) is unaffected — it has its own attestation guard.
	if (clean === true && merged) {
		if (ownership.ownership !== "session_path" && !applyMode?.includeUnowned) {
			if (dryRun) {
				return {
					kind: "worktree",
					ref: wt.path,
					family: "clean_merged",
					action: "would_delete",
					reason: "unowned_requires_include_unowned",
					expectedSha: head,
					ownership: ownership.ownership,
				};
			}
			return resetGate("unowned_clean_merged");
		}
		if (dryRun) {
			return {
				kind: "worktree",
				ref: wt.path,
				family: "clean_merged",
				action: "would_delete",
				expectedSha: head,
				ownership: ownership.ownership,
			};
		}
		if (!mayMutate) return skip("mutations_disabled");
		// R5#8: one budget slot per git mutator (worktree remove), deadline-checked.
		if (
			applyMode?.budget &&
			(applyMode.budget.shouldStop() || !applyMode.budget.tryConsume())
		) {
			return skip("budget_exhausted");
		}
		const res = await worktreeManager.removeRegisteredWorktree(
			mainRepoPath,
			wt,
			{ deleteBranch: true },
		);
		if (res.removed) {
			ctx.removedPaths.add(wt.path);
			store.deleteCleanupRefObservation(projectName, "worktree", wt.path);
			audit("lifecycle_sweep_worktree_removed", {
				path: wt.path,
				branch: wt.branch,
				family: "clean_merged",
				headSha: head,
				branchDeleted: res.branchDeleted,
			});
			return {
				kind: "worktree",
				ref: wt.path,
				family: "clean_merged",
				action: "deleted",
				expectedSha: head,
			};
		}
		return skip(`remove_failed:${res.error ?? "?"}`);
	}

	// ── NEW families need binding ownership + the 3d stability gate ──
	const qaFamily = isQaEphemeralKey(key);
	const family: SweepManifestEntry["family"] = qaFamily
		? "qa_ephemeral"
		: clean !== true
			? merged
				? "dirty_aged"
				: "stable_abandoned"
			: "stable_abandoned"; // clean but unmerged

	if (ownership.ownership !== "session_path" && !applyMode?.includeUnowned) {
		// Codex R1#6: the DRY-RUN manifest must still LIST unowned objects WITH
		// their exact sha — they are the core of the legacy inventory, and the
		// approved apply (`includeUnowned` bound INSIDE the hashed manifest) is
		// their only deletion door. Periodic (non-dry-run) passes keep skipping.
		if (dryRun) {
			return {
				kind: "worktree",
				ref: wt.path,
				family,
				action: clean === true ? "would_delete" : "would_bundle",
				reason: "unowned_requires_include_unowned",
				expectedSha: head,
				ownership: ownership.ownership,
			};
		}
		return resetGate(`unowned_${family}`);
	}

	// Activity probe (fail-closed) + durable fingerprint stability. Waived in
	// apply mode — the human-approved manifest pinned the exact snapshot; the
	// drift CAS above is the freshness authority there.
	if (!applyMode) {
		const active = await worktreeRecentlyActive(wt.path, ctx.nowMs());
		if (active !== false) {
			// (probe itself is read-only; the reset is a write → skip in dry-run)
			if (!dryRun) {
				store.deleteCleanupRefObservation(projectName, "worktree", wt.path);
			}
			return skip(
				active === "unknown" ? "activity_probe_failed" : "recent_activity",
			);
		}
		// Codex R1#11: the dry-run manifest pass is READ-ONLY — it must not
		// start/advance the 3d stability clock (observeCleanupRef writes).
		// Apply waives the stability gate anyway, so the manifest doesn't
		// need it; the periodic (non-dry-run) sweep owns the clock.
		if (!dryRun) {
			const porc = await gitPorcelainFull(wt.path);
			if (porc === undefined) return resetGate("fingerprint_probe_failed");
			const fingerprint = `${head}:${sha256Text(porc)}`;
			const obs = store.observeCleanupRef(
				projectName,
				"worktree",
				wt.path,
				fingerprint,
			);
			const firstSeenMs = sqliteToMs(obs.firstSeenEligibleAt);
			if (
				firstSeenMs === undefined ||
				ctx.nowMs() - firstSeenMs < STABILITY_WINDOW_MS
			) {
				return skip("stability_window_open");
			}
		}
	}

	// dirty-aged requires merge evidence OR the QA-ephemeral family.
	if (clean !== true && !merged && !qaFamily) {
		// stable-abandoned dirty: quarantine + remove is allowed only via the
		// manual apply for unowned; for OWNED objects the plan's stable-abandoned
		// path archives first (quarantine) then removes.
	}

	if (dryRun) {
		return {
			kind: "worktree",
			ref: wt.path,
			family,
			action: clean === true ? "would_delete" : "would_bundle",
			expectedSha: head,
			ownership: ownership.ownership,
		};
	}
	if (!mayMutate) return skip("mutations_disabled");
	// R5#8: one budget slot per git mutator (worktree quarantine+remove).
	if (
		applyMode?.budget &&
		(applyMode.budget.shouldStop() || !applyMode.budget.tryConsume())
	) {
		return skip("budget_exhausted");
	}

	// Dirty → recovery-complete quarantine BEFORE any force.
	let quarantinePath: string | undefined;
	if (clean !== true) {
		const q = await ctx.quarantine({
			mainRepoPath,
			worktreePath: wt.path,
			project: projectName,
			key,
		});
		if (!q.ok) {
			store.deleteCleanupRefObservation(projectName, "worktree", wt.path);
			return skip(`quarantine_failed:${q.reason}`);
		}
		quarantinePath = q.archiveDir;
	}

	// R6#6: the quarantine above was a slow await — re-check the deadline (and
	// consume a call-level slot) BEFORE the physical remove mutation.
	if (
		applyMode?.budget &&
		(applyMode.budget.shouldStop() || !applyMode.budget.tryConsume())
	) {
		return skip("budget_exhausted");
	}
	// Remove: clean → dirty-safe; quarantined-dirty → force (proof exists).
	const removed =
		clean === true
			? await worktreeManager.removeRegisteredWorktree(mainRepoPath, wt, {
					deleteBranch: false,
				})
			: await worktreeManager.removeWorktreeForce(mainRepoPath, wt.path);
	if (!removed.removed) {
		return skip(`remove_failed:${removed.error ?? "?"}`);
	}
	ctx.removedPaths.add(wt.path);

	// Local branch: CAS delete (occupancy re-checked inside the primitive).
	const branchTip = await gitExec(
		["rev-parse", "--verify", "-q", `refs/heads/${wt.branch}`],
		mainRepoPath,
	);
	let branchDeleted = false;
	// R6#6: the remove + rev-parse were slow awaits — re-check the deadline (and
	// consume a slot) BEFORE the branch CAS mutation.
	const branchBudgetOk =
		!applyMode?.budget ||
		(!applyMode.budget.shouldStop() && applyMode.budget.tryConsume());
	if (branchTip.code === 0 && branchBudgetOk) {
		const del = await casDeleteLocalBranch({
			mainRepoPath,
			branch: wt.branch,
			expectedSha: branchTip.stdout.trim(),
		});
		branchDeleted = del.deleted;
	}
	store.deleteCleanupRefObservation(projectName, "worktree", wt.path);
	audit("lifecycle_sweep_worktree_removed", {
		path: wt.path,
		branch: wt.branch,
		family,
		headSha: head,
		quarantinePath: quarantinePath ?? null,
		branchDeleted,
	});
	return {
		kind: "worktree",
		ref: wt.path,
		family,
		action: quarantinePath ? "quarantined_deleted" : "deleted",
		expectedSha: head,
		quarantinePath,
	};
}

/**
 * The sweep's OWN probes must be zero-write: a plain `git status` refreshes
 * the index file, which would trip the activity probe on every subsequent
 * pass and make the stability window unreachable (self-defeating). Both the
 * clean probe and the fingerprint probe therefore run `--no-optional-locks`.
 */
async function gitPorcelainFull(wtPath: string): Promise<string | undefined> {
	const res = await gitExec(
		[
			"--no-optional-locks",
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
		],
		wtPath,
	);
	return res.code === 0 ? res.stdout : undefined;
}

async function noLockWorktreeClean(
	wtPath: string,
): Promise<boolean | "unknown"> {
	const res = await gitExec(
		["--no-optional-locks", "status", "--porcelain"],
		wtPath,
	);
	if (res.code !== 0) return "unknown";
	return res.stdout.trim().length === 0;
}

function sqliteToMs(sqlite: string): number | undefined {
	if (!sqlite) return undefined;
	const t = new Date(`${sqlite.replace(" ", "T")}Z`).getTime();
	return Number.isNaN(t) ? undefined : t;
}

interface BranchSweepCtx {
	deps: LifecycleSweepDeps;
	dryRun: boolean;
	mayMutate: boolean;
	mainRepoPath: string;
	projectName: string;
	repoSlug: string;
	policy: CleanupPolicy & { enabled: true };
	protectedKeys: Set<string>;
	hasOrigin: boolean;
	gh: GhPrSets | undefined;
	hasOpenPr: (branch: string) => boolean | "unknown";
	isAncestorOfMain: (head: string) => Promise<boolean>;
	runGit: typeof gitExec;
	audit: (event: string, detail: Record<string, unknown>) => void;
	nowMs: () => number;
	result: LifecycleSweepResult;
	/** Codex R2#11: `${kind}:${ref}` seen this pass — end-of-pass inventory. */
	seenRefs: Set<string>;
}

async function sweepBranches(ctx: BranchSweepCtx): Promise<void> {
	const {
		deps,
		dryRun,
		mayMutate,
		mainRepoPath,
		projectName,
		repoSlug,
		policy,
		protectedKeys,
		runGit,
		audit,
		result,
	} = ctx;
	const { store, worktreeManager } = deps;
	const bundleDir = deps.bundleDir ?? defaultBundleDir();

	// Occupied branches (any worktree checkout) are never candidates.
	const registered = await worktreeManager.list(mainRepoPath);
	const occupied = new Set(
		registered.map((w) => w.branch).filter((b): b is string => !!b),
	);

	// Codex R4#5 + R5#5 (plan §72/73/133 govern): branch OWNERSHIP requires a
	// FRESH, mechanically-verified generation match — a mere historical
	// `binding.branch` STRING cannot defend against same-name ABA (the old
	// object deleted, a new same-name branch recreated inherits the stale
	// grant). A branch is owned iff its durable binding's live worktree admin
	// marker STILL reads the bound generation (the same four-way §2.1 proof the
	// worktree pass uses). A binding whose worktree is gone / whose generation
	// drifted → unowned (manual-only) for EVERY family: the periodic pass never
	// auto-deletes it, the dry-run lists it with its exact sha + reason, and
	// only a hashed apply with `includeUnowned=true` may delete.
	// R6#4 (plan.md:72/133): FULL four-way proof — the binding's worktree must
	// still be REGISTERED at binding.path AND still checked out on
	// binding.branch (a `git switch` inside the worktree does NOT move the
	// admin-marker generation, so generation-alone can't catch a same-worktree
	// branch swap), AND the fresh generation marker must still equal
	// binding.generation. Any mismatch → unowned (manual-only). Consequence:
	// an owned branch necessarily has a live worktree → it is `occupied` and
	// protected above, so the periodic branch auto-delete only ever fires for
	// unowned refs via the approved `includeUnowned` apply.
	const registeredByPath = new Map(registered.map((w) => [w.path, w]));
	const ownedBranches = new Set<string>();
	for (const b of store.listWorktreeBindings(projectName)) {
		if (!b.branch || !b.path || !b.generation) continue;
		const reg = registeredByPath.get(b.path);
		if (!reg || reg.branch !== b.branch) continue;
		const freshGen = await worktreeManager
			.readWorktreeGeneration?.(b.path)
			.catch(() => undefined);
		if (freshGen && freshGen === b.generation) ownedBranches.add(b.branch);
	}

	const evaluateRef = async (
		kind: "local_branch" | "remote_branch",
		branch: string,
		tipSha: string,
	): Promise<void> => {
		ctx.seenRefs.add(`${kind}:${branch}`);
		const skip = (reason: string) => {
			result.entries.push({ kind, ref: branch, action: "skipped", reason });
		};
		const key = worktreeManager.parseWorktreeKeyFromBranch(
			mainRepoPath,
			branch,
		);
		// Codex R1#10 — CONTINUOUS eligibility (same contract as the worktree
		// pass): a dynamic gate failure resets the durable stability anchor.
		const resetGate = (reason: string) => {
			if (!dryRun) store.deleteCleanupRefObservation(projectName, kind, branch);
			return skip(reason);
		};
		if (!key) return skip("not_managed_shape");
		if (isBaseBranch(branch)) return resetGate("base_branch");
		if (isReservedNamespaceKey(key)) return skip("reserved_namespace");
		if (protectedKeys.has(key)) return resetGate("protected_session_key");
		if (isProtectedBranch(branch, policy.protectedBranches)) {
			return resetGate("protected_branch_config");
		}
		if (occupied.has(branch)) return resetGate("branch_occupied");
		const open = ctx.hasOpenPr(branch);
		if (open !== false) {
			return resetGate(open === "unknown" ? "openpr_unknown" : "open_pr");
		}

		// FLY-1185 (R10#3) apply mode filter + drift CAS (same contract as the
		// worktree side).
		const applyMode = deps.apply;
		if (applyMode) {
			// Codex R2#7: kind-qualified approval — local_branch and
			// remote_branch approvals are distinct even for the same name+sha.
			const expected = applyMode.expectedByRef.get(`${kind}:${branch}`);
			if (expected === undefined) return skip("not_in_manifest");
			if (expected !== tipSha) return skip("manifest_drift");
		}

		// Eligibility class: merged / QA-ephemeral / stable-abandoned.
		const merged =
			(ctx.gh?.merged.get(branch)?.has(tipSha) ?? false) ||
			(await ctx.isAncestorOfMain(tipSha));
		const qa = isQaEphemeralKey(key);
		const family: SweepManifestEntry["family"] = merged
			? "clean_merged"
			: qa
				? "qa_ephemeral"
				: "stable_abandoned";

		// Codex R4#5 (plan §73): unowned branch = manual-only, every family.
		if (!ownedBranches.has(branch) && !applyMode?.includeUnowned) {
			if (dryRun) {
				result.entries.push({
					kind,
					ref: branch,
					family,
					action: kind === "local_branch" ? "would_bundle" : "would_delete",
					reason: "unowned_requires_include_unowned",
					expectedSha: tipSha,
					ownership: "unowned",
				});
				return;
			}
			return resetGate(`unowned_branch_${family}`);
		}

		// Stability gate on the ref tip (waived in apply mode — see above).
		// Codex R1#11: the dry-run manifest pass is READ-ONLY — it neither
		// starts nor advances the 3d clock (the periodic sweep owns it).
		if (!applyMode && !dryRun) {
			const obs = store.observeCleanupRef(projectName, kind, branch, tipSha);
			const firstSeenMs = sqliteToMs(obs.firstSeenEligibleAt);
			const stable =
				firstSeenMs !== undefined &&
				ctx.nowMs() - firstSeenMs >= STABILITY_WINDOW_MS;
			if (!stable) return skip("stability_window_open");
		}

		if (kind === "local_branch") {
			// R4#3: the PERIODIC path never deletes local refs — bundle+manifest.
			// The APPROVED apply is the one sanctioned local-delete door:
			// bundle first (recovery floor), then occupancy+CAS delete.
			if (dryRun) {
				result.entries.push({
					kind,
					ref: branch,
					family,
					action: "would_bundle",
					expectedSha: tipSha,
				});
				return;
			}
			if (!mayMutate) return skip("mutations_disabled");
			// R5#8: one budget slot per git mutator (local branch bundle+delete).
			if (
				applyMode?.budget &&
				(applyMode.budget.shouldStop() || !applyMode.budget.tryConsume())
			) {
				return skip("budget_exhausted");
			}
			const b = await bundleBranch({
				mainRepoPath,
				branch,
				expectedSha: tipSha,
				outDir: bundleDir,
			});
			if (!b.ok) return skip(`bundle_failed:${b.error}`);
			if (applyMode) {
				const del = await casDeleteLocalBranch({
					mainRepoPath,
					branch,
					expectedSha: tipSha,
				});
				store.deleteCleanupRefObservation(projectName, kind, branch);
				if (!del.deleted) {
					return skip(`local_delete_${del.reason}`);
				}
				audit("lifecycle_apply_local_branch_deleted", {
					branch,
					tipSha,
					family,
					bundlePath: b.bundlePath,
				});
				result.entries.push({
					kind,
					ref: branch,
					family,
					action: "deleted",
					expectedSha: tipSha,
					bundlePath: b.bundlePath,
				});
				return;
			}
			audit("lifecycle_sweep_local_branch_manifest", {
				branch,
				tipSha,
				family,
				bundlePath: b.bundlePath,
			});
			result.entries.push({
				kind,
				ref: branch,
				family,
				action: "bundled_manifest_only",
				expectedSha: tipSha,
				bundlePath: b.bundlePath,
			});
			return;
		}

		// REMOTE ref: eligible families delete under lease CAS; the
		// stable-abandoned class archives the tip first (bundle from the local
		// object store — fetch the ref first so the objects exist locally).
		if (dryRun) {
			result.entries.push({
				kind,
				ref: branch,
				family,
				action: "would_delete",
				expectedSha: tipSha,
			});
			return;
		}
		if (!mayMutate) return skip("mutations_disabled");
		// R5#8: one budget slot per git mutator (remote branch archive+delete).
		if (
			applyMode?.budget &&
			(applyMode.budget.shouldStop() || !applyMode.budget.tryConsume())
		) {
			return skip("budget_exhausted");
		}
		let bundlePath: string | undefined;
		if (family === "stable_abandoned" || family === "qa_ephemeral") {
			const fetch = await runGit(
				["fetch", "origin", `${branch}:refs/flywheel/archive/${branch}`],
				mainRepoPath,
			);
			if (fetch.code !== 0) return skip("archive_fetch_failed");
			const b = await bundleBranch({
				mainRepoPath,
				branch: `flywheel/archive/${branch}`,
				expectedSha: tipSha,
				outDir: bundleDir,
			});
			// bundleBranch bundles refs/heads/<name>; for the archive ref use raw git:
			if (!b.ok) {
				const alt = await runGit(
					[
						"bundle",
						"create",
						path.join(
							bundleDir,
							`${branch.replace(/[^A-Za-z0-9._-]/g, "_")}-remote.bundle`,
						),
						`refs/flywheel/archive/${branch}`,
					],
					mainRepoPath,
				);
				if (alt.code !== 0) return skip("archive_bundle_failed");
				bundlePath = path.join(
					bundleDir,
					`${branch.replace(/[^A-Za-z0-9._-]/g, "_")}-remote.bundle`,
				);
			} else {
				bundlePath = b.bundlePath;
			}
			audit("unmerged_tip_archived", { branch, tipSha, bundlePath });
		}
		const del = await casDeleteRemoteBranch({
			mainRepoPath,
			branch,
			expectedSha: tipSha,
		});
		if (!del.deleted) {
			store.deleteCleanupRefObservation(projectName, kind, branch);
			return skip(`remote_delete_${del.reason}`);
		}
		store.deleteCleanupRefObservation(projectName, kind, branch);
		audit("lifecycle_sweep_remote_branch_deleted", {
			branch,
			tipSha,
			family,
			bundlePath: bundlePath ?? null,
		});
		result.entries.push({
			kind,
			ref: branch,
			family,
			action: "deleted",
			expectedSha: tipSha,
			bundlePath,
		});
	};

	// LOCAL refs.
	const local = await runGit(
		[
			"for-each-ref",
			"--format=%(refname:short) %(objectname)",
			`refs/heads/${repoSlug}-*`,
		],
		mainRepoPath,
	);
	if (local.code === 0) {
		for (const line of local.stdout.split("\n")) {
			const [branch, sha] = line.trim().split(/\s+/);
			if (!branch || !sha) continue;
			await evaluateRef("local_branch", branch, sha);
		}
	}

	// REMOTE refs (fresh ls-remote — never a stale local remote-tracking view).
	if (ctx.hasOrigin) {
		const remote = await runGit(
			["ls-remote", "--heads", "origin", `${repoSlug}-*`],
			mainRepoPath,
		);
		if (remote.code === 0) {
			for (const line of remote.stdout.split("\n")) {
				const m = line.match(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/);
				if (!m || !m[1] || !m[2]) continue;
				await evaluateRef("remote_branch", m[2], m[1]);
			}
		}
	}
}
