/**
 * FLY-1185 §2.12 — issue-lifecycle HTTP surface (reserved actions):
 *
 *   POST /api/lifecycle/park    — founder park-close. Executes via
 *     `parkIssue` (tombstone + terminal authority + closeout INSIDE one
 *     issue-mutex hold — Codex R1#5).
 *   POST /api/lifecycle/unpark  — founder unpark/supersede (mutex-held).
 *   POST /api/lifecycle/dry-run — READ-ONLY manifest pass: git objects
 *     (unowned listed WITH exact shas) + legacy-terminal issue snapshots.
 *     Returns the CANONICAL manifest string + sha256 (approval binds bytes).
 *   POST /api/lifecycle-apply   — the approved-manifest committer (R10#3):
 *     verifies sha256(manifestJson) === approvedHash BYTE-FOR-BYTE
 *     (includeUnowned lives INSIDE the hashed manifest — Codex R1#6), then
 *     executes INSIDE the Bridge process: git objects through the sweep
 *     engine (per-ref sha drift CAS), issues through full-snapshot
 *     recomputation — ANY drift rejects the WHOLE issue — then the unified
 *     `closeoutIssue`. The CLI is a submitter only.
 *
 * All endpoints fail closed without a configured apiToken (the /api token
 * middleware no-ops when apiToken is unset, so the routes must refuse).
 */

import { createHash } from "node:crypto";
import { Router } from "express";
import type { WorktreeManager } from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type { CleanupPolicyByProject } from "./cleanup-policy.js";
import {
	type ClosureReport,
	collectIssueCloseoutNodes,
} from "./lifecycle-closeout.js";
import { isUuidKey, resolveLifecycleRootKey } from "./lifecycle-root-key.js";
import { sweepProjectLifecycle } from "./lifecycle-sweep.js";
import type { WithRepoLock } from "./repo-mutation-lock.js";

export interface LifecycleRoutesDeps {
	store: StateStore;
	projects: Array<Pick<ProjectEntry, "projectName" | "projectRoot">>;
	policies?: CleanupPolicyByProject;
	worktreeManager: WorktreeManager;
	withRepoLock: WithRepoLock;
	/** Founder park — atomic tombstone + closeout (lifecycle-closeout.parkIssue). */
	parkFn: (input: {
		issueUuid: string;
		projectName: string;
		founderDecisionId: string;
	}) => Promise<ClosureReport>;
	/** Founder unpark — mutex-held supersede. */
	unparkFn: (input: {
		issueUuid: string;
		supersededBy: string;
	}) => Promise<boolean>;
	/**
	 * Codex R2#6: the SNAPSHOT-GUARDED executor for apply-driven issue
	 * closeouts — recompute + compare + fresh-Linear verification + closeout
	 * all under ONE issue-mutex hold (lifecycle-closeout.
	 * closeoutIssueWithSnapshotGuard). The route only submits.
	 */
	applySnapshotCloseoutFn: (
		approved: IssueSnapshot,
		approvedJson: string,
		approvedHash: string,
		/** R4#8: ONE run budget shared across every issue of the apply request
		 * (plan.md:158 — manual apply enters the same budget mechanism). */
		budget?: { tryConsume: () => boolean; shouldStop: () => boolean },
	) => Promise<ClosureReport | { rejected: true; reason: string }>;
	/** Fail-closed guard — routes refuse when the api token is not configured. */
	apiTokenConfigured: boolean;
	sweepFn?: typeof sweepProjectLifecycle;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Full-DAG issue snapshot (plan §2.12 apply binding) ──────────────────────

export interface IssueSnapshot {
	issueUuid: string;
	project: string;
	disposition: "shipped" | "canceled";
	linear: { stateType: string; updatedAt: string };
	nodes: Array<{
		executionId: string;
		status: string;
		/** R9#1: the executor's per-node branch depends on role + qaStatus — the
		 * approved snapshot must carry them so a resume can prove the current
		 * terminal status is a status THIS node (not another role) could have
		 * self-produced. */
		role: string;
		qaStatus?: string;
	}>;
	/** Codex R2#6: open launch claims are part of the approved node set — an
	 * admission racing the approval must reject the whole issue. */
	claims: Array<{ executionId: string; state: string }>;
	bindings: Array<{ executionId: string; branch: string; generation: string }>;
	prs: Array<{ executionId: string; prNumber: number; prHeadSha: string }>;
	threadIds: string[];
}

/** Deterministic snapshot of everything the apply approval binds for one
 * issue. Sorted throughout so recomputation compares byte-stably. */
export function computeIssueSnapshot(
	store: StateStore,
	input: { project: string; issueUuid: string },
): IssueSnapshot | undefined {
	const obs = store.getLinearStateObservation(input.project, input.issueUuid);
	if (!obs) return undefined;
	const resolution = resolveLifecycleRootKey(store, input.issueUuid, []);
	const aliasKeys = resolution.ok ? resolution.aliasKeys : [input.issueUuid];

	const nodes: IssueSnapshot["nodes"] = [];
	const bindings: IssueSnapshot["bindings"] = [];
	const prs: IssueSnapshot["prs"] = [];
	const rootKeyForNodes = resolution.ok ? resolution.rootKey : input.issueUuid;
	// R9#1: build nodes via the SAME collector the executor uses (adds auto-QA
	// children + role/qaStatus). Launch claims are the separate `claims` field.
	for (const n of collectIssueCloseoutNodes(store, {
		rootKey: rootKeyForNodes,
		aliasKeys,
		projectName: input.project,
	})) {
		if (n.role === "launch_claim") continue;
		const session = store.getSession(n.executionId);
		nodes.push({
			executionId: n.executionId,
			status: n.status ?? "",
			role: n.role,
			...(n.qaStatus !== undefined && { qaStatus: n.qaStatus }),
		});
		const binding = store.getWorktreeBinding(n.executionId);
		if (binding) {
			bindings.push({
				executionId: n.executionId,
				branch: binding.branch,
				generation: binding.generation,
			});
		}
		if (session?.pr_number && session.pr_head_sha) {
			prs.push({
				executionId: n.executionId,
				prNumber: session.pr_number,
				prHeadSha: session.pr_head_sha,
			});
		}
	}
	const aliasSet = new Set(aliasKeys);
	const threadIds = store
		.getUnarchivedIssueChatThreads()
		.filter((t) => aliasSet.has(t.issue_id))
		.map((t) => t.thread_id)
		.sort();
	const rootKey = resolution.ok ? resolution.rootKey : input.issueUuid;
	const claims = store
		.listOpenLaunchClaims(rootKey)
		.map((c) => ({ executionId: c.executionId, state: c.state as string }));

	const byExec = (a: { executionId: string }, b: { executionId: string }) =>
		a.executionId.localeCompare(b.executionId);
	nodes.sort(byExec);
	claims.sort(byExec);
	bindings.sort(byExec);
	prs.sort(byExec);

	return {
		issueUuid: input.issueUuid,
		project: input.project,
		disposition: obs.lastStateType === "canceled" ? "canceled" : "shipped",
		linear: {
			stateType: obs.lastStateType,
			updatedAt: obs.lastLinearUpdatedAt,
		},
		nodes,
		claims,
		bindings,
		prs,
		threadIds,
	};
}

interface ManifestV2 {
	project: string;
	includeUnowned: boolean;
	gitObjects: Array<{ kind: string; ref: string; expectedSha?: string }>;
	issues: IssueSnapshot[];
}

export function createLifecycleRouter(deps: LifecycleRoutesDeps): Router {
	const router = Router();

	const guard = (res: {
		status: (n: number) => { json: (b: unknown) => void };
	}): boolean => {
		if (!deps.apiTokenConfigured) {
			res.status(403).json({ error: "api_token_not_configured (fail-closed)" });
			return false;
		}
		return true;
	};

	// ── founder park-close (atomic tombstone + closeout, Codex R1#5) ──
	router.post("/park", async (req, res) => {
		if (!guard(res)) return;
		const { issueUuid, project, founderDecisionId } = req.body ?? {};
		if (
			typeof issueUuid !== "string" ||
			!isUuidKey(issueUuid) ||
			typeof project !== "string" ||
			!project ||
			typeof founderDecisionId !== "string" ||
			!founderDecisionId
		) {
			res.status(400).json({
				error: "issueUuid (UUID) + project + founderDecisionId required",
			});
			return;
		}
		try {
			const report = await deps.parkFn({
				issueUuid,
				projectName: project,
				founderDecisionId,
			});
			res.status(200).json({
				parked: true,
				outcome: report.outcome,
				nodes: report.nodes.length,
				operatorItems: report.operatorItems,
			});
		} catch (err) {
			res.status(500).json({
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// ── read-only manifest pass (Codex R1#11: ZERO writes — the sweep runs
	// with dryRun, which skips fetch + observation writes). ──
	router.post("/dry-run", async (req, res) => {
		if (!guard(res)) return;
		const { project: projectName, includeUnowned } = req.body ?? {};
		if (typeof projectName !== "string" || !projectName) {
			res.status(400).json({ error: "project required" });
			return;
		}
		const project = deps.projects.find((p) => p.projectName === projectName);
		if (!project) {
			res.status(404).json({ error: `unknown_project:${projectName}` });
			return;
		}
		try {
			const sweep = deps.sweepFn ?? sweepProjectLifecycle;
			const result = await sweep({
				store: deps.store,
				worktreeManager: deps.worktreeManager,
				project,
				policies: deps.policies,
				withRepoLock: deps.withRepoLock,
				dryRun: true,
			});
			// Manifest git objects = every sha-bearing candidate (unowned
			// included — Codex R1#6: the legacy inventory IS the point).
			const gitObjects = result.entries
				.filter((e) => e.expectedSha)
				.map((e) => ({
					kind: e.kind,
					ref: e.ref,
					expectedSha: e.expectedSha,
					family: e.family,
					action: e.action,
					reason: e.reason,
					ownership: e.ownership,
				}));
			// Legacy-terminal issue snapshots (this project only).
			const issues: IssueSnapshot[] = [];
			for (const legacyObs of deps.store.listLegacyTerminalObservations()) {
				if (legacyObs.project !== projectName) continue;
				const snap = computeIssueSnapshot(deps.store, {
					project: legacyObs.project,
					issueUuid: legacyObs.issueUuid,
				});
				if (snap) issues.push(snap);
			}
			issues.sort((a, b) => a.issueUuid.localeCompare(b.issueUuid));

			const manifest: ManifestV2 = {
				project: projectName,
				includeUnowned: includeUnowned === true,
				gitObjects,
				issues,
			};
			const manifestJson = JSON.stringify(manifest, null, 2);
			res.status(200).json({
				manifestJson,
				sha256: sha256Hex(manifestJson),
			});
		} catch (err) {
			res.status(500).json({
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// ── founder unpark/supersede (mutex-held) ──
	router.post("/unpark", async (req, res) => {
		if (!guard(res)) return;
		const { issueUuid, supersededBy } = req.body ?? {};
		if (
			typeof issueUuid !== "string" ||
			!isUuidKey(issueUuid) ||
			typeof supersededBy !== "string" ||
			!supersededBy
		) {
			res
				.status(400)
				.json({ error: "issueUuid (UUID) + supersededBy required" });
			return;
		}
		try {
			const changed = await deps.unparkFn({ issueUuid, supersededBy });
			if (!changed) {
				res.status(404).json({ error: "no_active_intent" });
				return;
			}
			res.status(200).json({ unparked: true });
		} catch (err) {
			res.status(500).json({
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	return router;
}

/** The /api/lifecycle-apply handler (mounted separately — no /lifecycle
 *  prefix, matching the reserved-endpoint path). */
export function createLifecycleApplyRouter(deps: LifecycleRoutesDeps): Router {
	const router = Router();

	router.post("/", async (req, res) => {
		if (!deps.apiTokenConfigured) {
			res.status(403).json({ error: "api_token_not_configured (fail-closed)" });
			return;
		}
		const { manifestJson, approvedHash } = req.body ?? {};
		if (typeof manifestJson !== "string" || typeof approvedHash !== "string") {
			res
				.status(400)
				.json({ error: "manifestJson (string) + approvedHash required" });
			return;
		}
		// The hash binds the EXACT bytes the approver saw — recomputed here, so
		// any in-flight edit (including includeUnowned, which lives INSIDE the
		// manifest — Codex R1#6) rejects the batch.
		const actualHash = sha256Hex(manifestJson);
		if (actualHash !== approvedHash) {
			res.status(409).json({ error: "approved_hash_mismatch", actualHash });
			return;
		}
		let manifest: ManifestV2;
		try {
			manifest = JSON.parse(manifestJson);
		} catch {
			res.status(400).json({ error: "manifest_not_json" });
			return;
		}
		const project = deps.projects.find(
			(p) => p.projectName === manifest.project,
		);
		if (!project) {
			res.status(404).json({ error: `unknown_project:${manifest.project}` });
			return;
		}
		const gitObjects = Array.isArray(manifest.gitObjects)
			? manifest.gitObjects
			: [];
		const issues = Array.isArray(manifest.issues) ? manifest.issues : [];
		// Codex R2#7: approval identity = (kind, ref); duplicates or unknown
		// kinds reject the whole batch (never a widened/ambiguous approval).
		const VALID_KINDS = new Set(["worktree", "local_branch", "remote_branch"]);
		const expectedByRef = new Map<string, string>();
		for (const e of gitObjects) {
			// R3#8: FULL schema validation FIRST — a malformed entry (missing
			// ref/sha, unknown kind) rejects the whole batch instead of being
			// silently skipped (the operator must never see applied:true for a
			// manifest that was not entirely understood).
			if (!e || typeof e !== "object" || !VALID_KINDS.has(e.kind)) {
				res
					.status(400)
					.json({ error: `manifest_unknown_kind:${e?.kind ?? "missing"}` });
				return;
			}
			if (
				typeof e.ref !== "string" ||
				!e.ref ||
				typeof e.expectedSha !== "string" ||
				!e.expectedSha
			) {
				res.status(400).json({
					error: `manifest_malformed_entry:${e.kind}:${e.ref ?? "?"}`,
				});
				return;
			}
			const key = `${e.kind}:${e.ref}`;
			if (expectedByRef.has(key)) {
				res.status(400).json({ error: `manifest_duplicate_entry:${key}` });
				return;
			}
			expectedByRef.set(key, e.expectedSha);
		}
		if (expectedByRef.size === 0 && issues.length === 0) {
			res.status(400).json({ error: "manifest_has_no_approvable_entries" });
			return;
		}

		try {
			// R4#8 (plan.md:158): ONE hardcoded run budget for the WHOLE apply
			// request — every issue closeout draws mutator slots from it and a
			// wall-clock deadline bounds the batch. Exhausted issues return
			// partial/blocked and resume safely through the approvedHash epoch.
			const APPLY_MAX_MUTATORS = 40;
			const APPLY_DEADLINE_MS = 10 * 60_000;
			const applyStartedMs = Date.now();
			let applyMutatorsUsed = 0;
			const applyBudget = {
				tryConsume: () => {
					if (
						applyMutatorsUsed >= APPLY_MAX_MUTATORS ||
						Date.now() - applyStartedMs >= APPLY_DEADLINE_MS
					) {
						return false;
					}
					applyMutatorsUsed++;
					return true;
				},
				shouldStop: () =>
					applyMutatorsUsed >= APPLY_MAX_MUTATORS ||
					Date.now() - applyStartedMs >= APPLY_DEADLINE_MS,
			};

			// (1) Git objects — Bridge-internal sweep apply: manifest-listed refs
			// only, per-ref sha drift CAS, mechanical safety gates kept.
			let entries: unknown[] = [];
			if (expectedByRef.size > 0) {
				const sweep = deps.sweepFn ?? sweepProjectLifecycle;
				const result = await sweep({
					store: deps.store,
					worktreeManager: deps.worktreeManager,
					project,
					policies: deps.policies,
					withRepoLock: deps.withRepoLock,
					apply: {
						expectedByRef,
						includeUnowned: manifest.includeUnowned === true,
						// R5#8: the git sweep now consumes from the SHARED run budget
						// BEFORE each mutator (deadline-checked), so a huge manifest
						// cannot delete unboundedly then starve the issue closeouts.
						budget: applyBudget,
					},
				});
				entries = result.entries;
				// R5#8: the sweep already consumed a budget slot before each
				// mutator (see LifecycleSweepDeps.apply.budget) — no after-the-fact
				// counting (which ignored deadline + let deletes happen first).
			}

			// (2) Issues — full-snapshot recomputation: ANY drift (node set /
			// status / binding generation / PR head / thread set / Linear state)
			// rejects the WHOLE issue; a clean match runs the unified closeout.
			const issueResults: Array<{
				issueUuid: string;
				result: "closed" | "rejected" | string;
				reason?: string;
			}> = [];
			for (const approved of issues) {
				// Codex R2#6: recompute/compare/fresh-Linear/closeout run INSIDE
				// the executor's issue mutex — the route only submits.
				const outcome = await deps.applySnapshotCloseoutFn(
					approved,
					JSON.stringify(approved),
					approvedHash,
					applyBudget,
				);
				if ("rejected" in outcome && outcome.rejected) {
					issueResults.push({
						issueUuid: approved.issueUuid,
						result: "rejected",
						reason: outcome.reason,
					});
					continue;
				}
				const report = outcome as ClosureReport;
				issueResults.push({
					issueUuid: approved.issueUuid,
					result: report.outcome === "complete" ? "closed" : report.outcome,
				});
			}

			res.status(200).json({
				applied: true,
				approvedHash,
				entries,
				issueResults,
			});
		} catch (err) {
			res.status(500).json({
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	return router;
}
