/**
 * FLY-945 Fix D — external-merge convergence sweeper (bounded backstop).
 *
 * When a PR gets merged OUTSIDE the runner self-ship path (a human or a Lead
 * ran `gh pr merge` — FLY-921's executor-merge stopgap), the completion event
 * chain that drives post-ship finalization (tmux cleanup + 🏁 + thread archive
 * + Linear Done, the FLY-369 cascade) never fires and the founder ends up
 * manually asking for the archive. This pass converges such sessions on the
 * GatePoller patrol cadence (zero new timers).
 *
 * POSITIONING: this is a BACKSTOP convergence sweeper. Fix F simultaneously
 * retires executor-merge as Lead practice — the existence of this pass is NOT
 * permission to merge around the runner.
 *
 * Two candidate classes, two DIFFERENT validation paths (Codex R2 #1:
 * `computeShipDecision → verifyApproval` hard-requires status
 * `approved_to_ship`, so a completed row can never share path 1):
 *
 *  Path 1 — parked (awaiting_review / approved_to_ship), idle past TTL,
 *    PR MERGED (and only MERGED): pre-transition FLY-869 `computeShipDecision`
 *    (approval + codex + QA). NOT ship-eligible → parked with the standard
 *    merge_block marker (one loud alert, no finalize/archive — identical to
 *    the live merge-ship-gate semantics). Eligible → completed +
 *    `runPostShipFinalization` (same seam as the recovered-merge path).
 *
 *  Path 2 — completed-but-unfinalized (status=completed, PR clue, thread not
 *    archived, recent): narrow head-aware recovery validation (Codex R3 #1 —
 *    a head-less "the founder approved once" cannot distinguish "approved the
 *    OLD head, someone merged unapproved commits on top"): ① the bound review
 *    question's response exists, is structured `{approved:true}` AND is
 *    founder-attributed (Fix E trusted set); ② the merged PR's headRefOid
 *    EXACTLY equals the session's bound pr_head_sha (v1 deliberately requires
 *    exact match — a completed session's worktree may be gone, so ancestry
 *    can't be verified). Both → `runPostShipFinalization` directly (status is
 *    already completed; no transition). Either fails → NO finalize + a Lead
 *    alert (a rogue / head-drifted merge must be SEEN, not archived).
 *
 * PR open / unknown / closed-unmerged → untouched (closed ≠ merged; it may be
 * a reject flow). gh calls are throttled: at most N candidates per project per
 * pass (default 3), rotating.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CommDB } from "flywheel-comm/db";
import {
	isTrustedApprovalAttribution,
	resolveFounderId,
} from "flywheel-comm/founder-attribution";
import type { ShipEligibilityDecision } from "flywheel-comm/ship-eligibility";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { commDbPathForProject } from "./commdb-path.js";
import { evaluateWorkflowFounderReviewPrecondition } from "./founder-review-authority.js";
import { resolveWorkflowHeadAuthority } from "./head-authority.js";
import { makeLinearDoneFinalizer } from "./linear-issue-finalizer.js";
import type { MaterializedHeadAuthority } from "./materialized-head-authority.js";
import {
	computeAuthoritativeShipDecision,
	computeEngineWorkflowShipPrecondition,
	mergedPrCiProbe,
	parkMergeBlock,
} from "./merge-ship-gate.js";
import { runPostShipFinalization } from "./post-ship-finalization.js";
import { classifyBlockerLocal } from "./stale-blocker-guard.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";
import type { WorktreeCleanupFn } from "./worktree-cleanup.js";

const execFileP = promisify(execFile);

export interface PrMergeInfo {
	state: "merged" | "closed" | "open" | "unknown";
	/** The merge commit oid (merged PRs) — the synthetic landing evidence. */
	mergeCommitOid?: string;
	/** The PR branch head at merge time (path 2 exact-match validation). */
	headRefOid?: string;
	/** Bounded raw provider value retained for diagnostics and REST fallback. */
	rawHeadRefOid?: string;
}

/**
 * Bounded, fail-safe `gh pr view` — the FLY-742 query pattern extended with
 * merge evidence (`mergeCommit`, `headRefOid`), because this pass needs proof
 * of WHAT merged, not just that something did. Any error → `unknown`.
 */
export async function checkPrMergeViaGh(
	projectRoot: string,
	prNumber: number,
	timeoutMs = 10_000,
	probeRepoSlug?: string,
): Promise<PrMergeInfo> {
	if (!Number.isInteger(prNumber) || prNumber <= 0) return { state: "unknown" };
	try {
		const args = [
			"pr",
			"view",
			String(prNumber),
			...(probeRepoSlug ? ["--repo", probeRepoSlug] : []),
			"--json",
			"state,mergedAt,mergeCommit,headRefOid",
		];
		const { stdout } = await execFileP("gh", args, {
			cwd: projectRoot,
			timeout: Math.max(1, timeoutMs),
		});
		const parsed = JSON.parse(stdout) as {
			state?: string;
			mergedAt?: string | null;
			mergeCommit?: { oid?: string } | null;
			headRefOid?: string;
		};
		const rawHeadRefOid = parsed.headRefOid?.slice(0, 80);
		const normalizedHead = parsed.headRefOid?.toLowerCase();
		const headRefOid =
			normalizedHead && /^[0-9a-f]{40}$/.test(normalizedHead)
				? normalizedHead
				: undefined;
		if (parsed.mergedAt || parsed.state === "MERGED") {
			return {
				state: "merged",
				mergeCommitOid: parsed.mergeCommit?.oid?.toLowerCase(),
				headRefOid,
				rawHeadRefOid,
			};
		}
		if (parsed.state === "CLOSED") {
			return { state: "closed", headRefOid, rawHeadRefOid };
		}
		if (parsed.state === "OPEN") {
			return { state: "open", headRefOid, rawHeadRefOid };
		}
		return { state: "unknown" };
	} catch {
		return { state: "unknown" };
	}
}

export interface ExternalMergeReconcileDeps {
	store: StateStore;
	config: BridgeConfig;
	projects: ProjectEntry[];
	/** FLY-603 worktree cleanup closure (same one the sinks thread through). */
	removeCleanWorktree?: WorktreeCleanupFn;
	withIssueLifecycleMutex?: <T>(
		issueId: string,
		fn: () => Promise<T>,
	) => Promise<T>;
	/** Lead alert sink for the path-2 rogue-merge escalation. Best-effort. */
	alertLead?: (
		session: Session,
		title: string,
		body: string,
	) => Promise<void> | void;
	env?: Record<string, string | undefined>;
	now?: () => number;
	/** Path-1 idle TTL before a parked session is even gh-checked. Default 30min. */
	staleTtlMs?: number;
	/** Path-2 lookback window in days. Default 7. */
	windowDays?: number;
	/** gh-call budget per project per pass. Default 3. */
	maxCandidatesPerProject?: number;
	/** Test seam for the gh query. */
	checkPrMerge?: typeof checkPrMergeViaGh;
	/** Test seam for the path-2 trusted-approval read (default: CommDB). */
	hasTrustedApprovalImpl?: (session: Session) => boolean;
	/**
	 * FLY-1314: direct probe of a terminal TURN holder's persisted tmux target.
	 * The caller must return indeterminate on probe uncertainty; only dead_pin /
	 * absent authorize belt reclamation.
	 */
	probeTurnHolderLiveness?: (
		session: Session,
	) => Promise<"alive" | "dead_pin" | "absent" | "indeterminate">;
	/** PR-7.5 supplies the durable materialized-head reader for product runs. */
	materializedHeadAuthority?: MaterializedHeadAuthority;
	/**
	 * FLY-1204: the DAG workflow keep-alive phase finalizer (same one the
	 * DirectEventSink / event-route paths use). External merge is a real ship
	 * path, so it must reclaim the parked design/implement/qa phase sessions too;
	 * without it the external-merge finalize writes the post-ship claim but leaves
	 * the phase sessions leaked alive until the periodic patrol catches them.
	 * Optional → absent leaves the phases to the patrol (byte-compat).
	 */
	finalizeWorkflowPhaseRoles?: (
		issueId: string,
		projectName: string,
	) => Promise<void>;
	/**
	 * FLY-1448 E1: retire stale gates using this reconciler's independent
	 * GitHub authority. The sink must invoke `revalidate` before every
	 * irreversible mutation; only a fresh MERGED probe authorizes work.
	 */
	retireMergedGates?: (input: {
		projectName: string;
		canonicalIssueId: string;
		issueAliases: string[];
		prNumber: number;
		authorityCredential: string;
		revalidate: () => Promise<"authorized" | "unknown">;
	}) => Promise<void>;
	log?: (m: string) => void;
}

const PARK_STATES = new Set(["awaiting_review", "approved_to_ship"]);
const TERMINAL_TURN_HOLDER_STATES = new Set(["completed", "failed"]);

interface TurnBeltMergeCandidate {
	turn: ExternalMergeTurnRow;
	holder: Session;
	prNumber: number;
}

interface ExternalMergeTurnRow {
	issue_id: string;
	holder_exec_id: string;
	phase: string;
	epoch: number;
	granted_at: number;
}

interface ProjectMergeCandidate {
	issueId: string;
	prNumber: number;
	sessions: Session[];
	belt?: TurnBeltMergeCandidate;
}

function intEnv(
	env: Record<string, string | undefined>,
	key: string,
	fallback: number,
): number {
	const n = Number.parseInt(env[key] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Path 2 ①: the bound review question has a structured `{approved:true}`
 * response written by a founder-side writer (Fix E trusted set). Fail-closed
 * on every miss (no binding / unreadable CommDB / plain-text / untrusted).
 */
export function hasTrustedFounderApproval(
	session: Session,
	deps: { env?: Record<string, string | undefined>; dotenvPath?: string },
): boolean {
	const qid = session.review_question_id?.trim();
	if (!qid || qid === "unbound") return false;
	if (!session.project_name) return false;
	try {
		const db = CommDB.openReadonly(commDbPathForProject(session.project_name));
		try {
			const response = db.getResponse(qid);
			if (!response) return false;
			let approved: unknown;
			try {
				approved = (
					JSON.parse(response.content ?? "") as { approved?: unknown }
				)?.approved;
			} catch {
				return false;
			}
			if (approved !== true) return false;
			const founderId = resolveFounderId({
				argsEnv: deps.env as NodeJS.ProcessEnv | undefined,
				processEnv: process.env,
				dotenvPath: deps.dotenvPath,
			});
			return isTrustedApprovalAttribution(response.from_agent, founderId);
		} finally {
			db.close();
		}
	} catch {
		return false;
	}
}

export function createExternalMergeReconciler(
	deps: ExternalMergeReconcileDeps,
): { pass(): Promise<void> } {
	// Per-project rotation cursor so a >budget backlog makes progress across
	// passes instead of re-checking the same first N forever.
	const rotation = new Map<string, number>();
	const declaredRotation = new Map<string, number>();
	// FLY-1314: non-MERGED probes are new bounded in-memory state. They avoid
	// spending the shared gh budget on the same open/closed/unknown PR every
	// patrol tick; merged results are never cached negatively.
	const negativeMergeCache = new Map<string, number>();

	const log = deps.log ?? ((m: string) => console.log(m));
	const now = deps.now ?? (() => Date.now());
	const checkPr = deps.checkPrMerge ?? checkPrMergeViaGh;
	const hasTrusted =
		deps.hasTrustedApprovalImpl ??
		((s: Session) => hasTrustedFounderApproval(s, { env: deps.env }));

	function env(): Record<string, string | undefined> {
		return deps.env ?? process.env;
	}

	function isThreadArchived(session: Session): boolean {
		try {
			const { lead } = resolveLeadForIssue(
				deps.projects,
				session.project_name,
				parseLabels(session.issue_labels),
			);
			if (!lead.chatChannel) return false;
			const thread = deps.store.getChatThreadByIssue(
				session.issue_id,
				lead.chatChannel,
			);
			// No thread row → cannot use the archive as the finalized signal; the
			// post-ship-finalization claim event (checked by the caller) is the
			// real idempotency gate, so do NOT filter here.
			if (!thread) return false;
			return !!thread.archived_at;
		} catch {
			return false;
		}
	}

	function candidateKey(
		projectName: string,
		issueId: string,
		prNumber: number,
	): string {
		return `${projectName}\u0000${issueId}\u0000${prNumber}`;
	}

	function resolveTurnPrNumber(
		turn: ExternalMergeTurnRow,
		holder: Session,
	): { prNumber?: number; reason?: "missing" | "conflict" } {
		const numbers = new Set<number>();
		const collect = (session: Session): void => {
			const pr = session.pr_number;
			if (Number.isInteger(pr) && (pr as number) > 0) numbers.add(pr as number);
		};
		// Trust order is holder first, then issue-level implement/QA/landing
		// evidence. We still inspect the latter for conflicts: acting on one of two
		// contradictory PR numbers would be unsafe.
		collect(holder);
		for (const session of deps.store.getSessionHistory(turn.issue_id)) {
			const role = session.chat_thread_role ?? session.session_role ?? "main";
			if (role === "implement" || role === "qa" || role === "main") {
				collect(session);
			}
		}
		if (numbers.size === 0) return { reason: "missing" };
		if (numbers.size > 1) return { reason: "conflict" };
		return { prNumber: [...numbers][0] };
	}

	async function collectTurnBeltCandidates(
		projectName: string,
		nowMs: number,
	): Promise<{
		candidates: TurnBeltMergeCandidate[];
		scanned: number;
		missingPr: number;
		conflictingPr: number;
	}> {
		const stats = {
			candidates: [] as TurnBeltMergeCandidate[],
			scanned: 0,
			missingPr: 0,
			conflictingPr: 0,
		};
		if (env().FLYWHEEL_TURN_BELT_MERGED_RECLAIM === "0") return stats;
		if (!deps.probeTurnHolderLiveness) return stats;
		const ageMs = intEnv(
			env(),
			"FLYWHEEL_TURN_BELT_MERGED_RECLAIM_AGE_MS",
			30 * 60_000,
		);
		let db: CommDB | undefined;
		let turns: ExternalMergeTurnRow[];
		try {
			db = CommDB.openReadonly(commDbPathForProject(projectName));
			turns = db.listTurns() as ExternalMergeTurnRow[];
		} catch {
			return stats;
		} finally {
			db?.close();
		}
		stats.scanned = turns.length;
		for (const turn of turns) {
			if (nowMs - turn.granted_at <= ageMs) continue;
			const holder = deps.store.getSession(turn.holder_exec_id);
			if (!holder || holder.project_name !== projectName) continue;
			if (!TERMINAL_TURN_HOLDER_STATES.has(holder.status)) continue;
			if (!holder.tmux_session?.trim()) continue;
			let liveness: "alive" | "dead_pin" | "absent" | "indeterminate" =
				"indeterminate";
			try {
				liveness = await deps.probeTurnHolderLiveness(holder);
			} catch {
				liveness = "indeterminate";
			}
			if (liveness !== "dead_pin" && liveness !== "absent") continue;
			const resolved = resolveTurnPrNumber(turn, holder);
			if (!resolved.prNumber) {
				if (resolved.reason === "conflict") stats.conflictingPr++;
				else stats.missingPr++;
				continue;
			}
			stats.candidates.push({
				turn,
				holder,
				prNumber: resolved.prNumber,
			});
		}
		return stats;
	}

	async function reclaimTurnBelt(
		projectName: string,
		candidate: TurnBeltMergeCandidate,
		info: PrMergeInfo,
	): Promise<void> {
		let db: CommDB | undefined;
		let deleted = false;
		try {
			db = new CommDB(commDbPathForProject(projectName));
			deleted = db.deleteTurnIfCurrent(
				candidate.turn.issue_id,
				candidate.turn.holder_exec_id,
				candidate.turn.epoch,
			);
		} finally {
			db?.close();
		}
		if (!deleted) return;
		deps.store.insertEvent({
			event_id: `turn-belt-reclaimed-external-merge-${candidate.turn.issue_id}-${candidate.turn.holder_exec_id}-${candidate.turn.epoch}-${candidate.prNumber}`,
			execution_id: candidate.turn.holder_exec_id,
			issue_id: candidate.turn.issue_id,
			project_name: projectName,
			event_type: "turn_belt_reclaimed_external_merge",
			source: "bridge.external-merge-reconcile",
			payload: {
				issueId: candidate.turn.issue_id,
				holderExecId: candidate.turn.holder_exec_id,
				epoch: candidate.turn.epoch,
				prNumber: candidate.prNumber,
				mergeCommitOid: info.mergeCommitOid ?? null,
			},
		});
		log(
			`[external-merge] FLY-1314 reclaimed TURN ${candidate.turn.issue_id} holder=${candidate.turn.holder_exec_id} epoch=${candidate.turn.epoch} after PR #${candidate.prNumber} MERGED proof`,
		);
	}

	async function finalize(
		session: Session,
		info: PrMergeInfo,
		options: { runId?: string; omitMergedReceipt?: boolean } = {},
	): Promise<void> {
		await runPostShipFinalization(
			{
				executionId: session.execution_id,
				runId:
					options.runId ??
					deps.store.getWorkflowRunIdForExecution(session.execution_id),
				...(!options.omitMergedReceipt &&
				session.pr_number &&
				session.pr_head_sha
					? {
							mergedPr: {
								prNumber: session.pr_number,
								headSha: session.pr_head_sha,
							},
						}
					: {}),
				issueId: session.issue_id,
				issueIdentifier: session.issue_identifier,
				projectName: session.project_name,
				sessionStatus: "completed",
				discordOwnerUserId: deps.config.chatThreadsEnabled
					? deps.config.discordOwnerUserId
					: undefined,
				fallbackBotToken: deps.config.discordBotToken,
			},
			{
				store: deps.store,
				projects: deps.projects,
				removeCleanWorktree: deps.removeCleanWorktree,
				// FLY-1204: reclaim the parked DAG workflows on this ship path too.
				finalizeWorkflowPhaseRoles: deps.finalizeWorkflowPhaseRoles,
				markIssueDone: makeLinearDoneFinalizer(deps.config),
				withIssueLifecycleMutex: deps.withIssueLifecycleMutex,
			},
		);
		deps.store.insertEvent({
			event_id: `external-merge-finalized-${session.execution_id}`,
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "external_merge_finalized",
			source: "bridge.external-merge-reconcile",
			payload: {
				prNumber: session.pr_number,
				mergeCommitOid: info.mergeCommitOid ?? null,
				headRefOid: info.headRefOid ?? null,
				statusBefore: session.status,
			},
		});
	}

	async function reconcileDeclaredPrRuns(
		projectName: string,
		projectRoot: string,
		budget: number,
	): Promise<number> {
		const initial = deps.store.listWorkflowPrConvergenceRows(projectName);
		if (initial.length === 0) return 0;
		const groups = new Map<string, typeof initial>();
		for (const row of initial) {
			const group = groups.get(row.run_id) ?? [];
			group.push(row);
			groups.set(row.run_id, group);
		}
		const pending = initial.filter(
			(row) =>
				row.state !== "merged" &&
				(negativeMergeCache.get(
					candidateKey(projectName, row.issue_id, row.pr_number),
				) ?? 0) <= now(),
		);
		const declaredBudget = Math.max(1, budget);
		const start =
			pending.length > 0
				? (declaredRotation.get(projectName) ?? 0) % pending.length
				: 0;
		const picked = pending
			.map((_, index) => pending[(start + index) % pending.length]!)
			.slice(0, declaredBudget);
		declaredRotation.set(
			projectName,
			pending.length > 0 ? (start + picked.length) % pending.length : 0,
		);
		for (const row of picked) {
			const info = await checkPr(
				projectRoot,
				row.pr_number,
				10_000,
				row.probe_repo_slug,
			);
			if (
				info.state !== "merged" ||
				info.headRefOid?.toLowerCase() !== row.frozen_head_sha
			) {
				negativeMergeCache.set(
					candidateKey(projectName, row.issue_id, row.pr_number),
					now() +
						intEnv(
							env(),
							"FLYWHEEL_EXTERNAL_MERGE_NEGATIVE_CACHE_MS",
							10 * 60_000,
						),
				);
				continue;
			}
			negativeMergeCache.delete(
				candidateKey(projectName, row.issue_id, row.pr_number),
			);
			const marked = deps.store.markWorkflowDeclaredPrMerged({
				runId: row.run_id,
				repoIdentity: row.repo_identity,
				prNumber: row.pr_number,
				headSha: row.frozen_head_sha,
			});
			if (!marked.ok) {
				log(
					`[external-merge] declared PR ${row.run_id}/${row.repo_identity}#${row.pr_number} receipt refused: ${marked.reason}`,
				);
			}
		}
		for (const [runId, rows] of groups) {
			const current = deps.store.listCurrentWorkflowDeclaredPrs(runId);
			if (
				current.length === 0 ||
				current.some((row) => row.state !== "merged")
			) {
				continue;
			}
			const sourceExecutionId = rows.find(
				(row) => row.source_execution_id,
			)?.source_execution_id;
			const source = sourceExecutionId
				? deps.store.getSession(sourceExecutionId)
				: undefined;
			if (!source) {
				log(
					`[external-merge] declared PR run ${runId} is fully merged but has no source session; retrying on a later pass`,
				);
				continue;
			}
			const run = deps.store.getWorkflowRun(runId);
			if (run?.snapshot) {
				let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
				try {
					snapshot = parseWorkflowRunSnapshot(run.snapshot);
				} catch {
					const claimed = deps.store.insertEvent({
						event_id: `founder-review-finalization-hold-${runId}-snapshot-invalid`,
						execution_id: source.execution_id,
						issue_id: source.issue_id,
						project_name: projectName,
						event_type: "founder_review_finalization_hold",
						source: "bridge.external-merge-reconcile",
						payload: {
							runId,
							reason: "founder_review_snapshot_invalid",
						},
					});
					if (claimed) {
						await deps.alertLead?.(
							source,
							`Founder review blocks finalization — ${source.issue_identifier ?? source.issue_id}`,
							"⛔ 无法验证该 run 的阶段产出 founder review(snapshot invalid);不归档、不标 Done。",
						);
					}
					continue;
				}
				const producerIds = snapshot.manifest.nodes
					.filter((node) => node.founder_review === true)
					.map((node) => node.id);
				if (producerIds.length > 0) {
					const producerBindings = current
						.map((row) => {
							const authority = deps.store.resolveWorkflowExactHeadAuthority({
								runId,
								headSha: row.frozen_head_sha,
							});
							return authority.valid ? authority.binding : undefined;
						})
						.filter(
							(binding) =>
								binding !== undefined && producerIds.includes(binding.node_id),
						);
					const producerBinding =
						producerBindings.length === 1 ? producerBindings[0] : undefined;
					const review = producerBinding
						? await evaluateWorkflowFounderReviewPrecondition({
								store: deps.store,
								runId,
								projectName,
								snapshot,
								head: producerBinding.head_sha,
								processEnv: deps.env ?? process.env,
							})
						: {
								eligible: false as const,
								reason: "founder_review_artifact_binding_missing",
							};
					if (!review.eligible) {
						const holdHead =
							producerBinding?.head_sha ??
							current[0]?.frozen_head_sha ??
							"unknown";
						const claimed = deps.store.insertEvent({
							event_id: `founder-review-finalization-hold-${runId}-${holdHead}-${review.reason}`,
							execution_id: source.execution_id,
							issue_id: source.issue_id,
							project_name: projectName,
							event_type: "founder_review_finalization_hold",
							source: "bridge.external-merge-reconcile",
							payload: { runId, head: holdHead, reason: review.reason },
						});
						if (claimed) {
							await deps.alertLead?.(
								source,
								`Founder review blocks finalization — ${source.issue_identifier ?? source.issue_id}`,
								`⛔ 阶段产出尚未获得 founder 对当前版本的通过(${review.reason});不归档、不标 Done。`,
							);
						}
						continue;
					}
				}
			}
			await finalize(
				source,
				{ state: "merged", headRefOid: current.at(-1)?.frozen_head_sha },
				{ runId, omitMergedReceipt: true },
			);
		}
		return picked.length;
	}

	async function handleParked(session: Session, info: PrMergeInfo) {
		// Synthetic head fallback mirrors the sinks' erPrHead logic — the row may
		// predate the pr_head_sha write; the merged PR's own head is the evidence.
		const head =
			session.pr_head_sha?.trim().toLowerCase() || info.headRefOid || "";
		const decision: ShipEligibilityDecision & { authoritativeHead: string } =
			await computeAuthoritativeShipDecision(
				deps.store,
				session,
				head,
				(deps.env ?? process.env) as NodeJS.ProcessEnv,
				deps.materializedHeadAuthority,
				mergedPrCiProbe,
			);
		if (!decision.eligible) {
			// Identical semantics to the live merge-ship-gate: park + one loud alert.
			const claimed = parkMergeBlock(
				deps.store,
				session,
				decision.authoritativeHead || head,
				decision,
			);
			if (claimed) {
				log(
					`[external-merge] FLY-945 parked ${session.execution_id} (${session.issue_id}) — externally merged head ${head.slice(0, 8) || "(none)"} NOT ship-eligible (merge=${decision.mergeReason} qa=${decision.qaReason})`,
				);
				await deps.alertLead?.(
					session,
					`External merge NOT ship-eligible — ${session.issue_identifier ?? session.issue_id}`,
					`⛔ ${session.issue_identifier ?? session.issue_id} 的 PR 在 runner 外被 merge,但未通过 ship 闸(merge=${decision.mergeReason} qa=${decision.qaReason})。已挂 merge_block、不归档、不标 Done —— 需要人来处理。`,
				);
			}
			return;
		}
		// Eligible → completed + finalization (same seam as finalizeRecoveredMerge).
		deps.store.upsertSession({
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			issue_title: session.issue_title,
			project_name: session.project_name,
			status: "completed",
			last_activity_at: sqliteDatetime(),
		});
		log(
			`[external-merge] FLY-945 converging parked ${session.execution_id} (${session.issue_id}) — PR merged externally (${info.mergeCommitOid?.slice(0, 8) ?? "?"}), ship-eligible → completed + finalization`,
		);
		await finalize(session, info);
	}

	async function handleCompletedUnfinalized(
		session: Session,
		info: PrMergeInfo,
	) {
		const boundHead = session.pr_head_sha?.trim().toLowerCase();
		let authoritativeHead: string | undefined = boundHead;
		try {
			authoritativeHead = (
				await resolveWorkflowHeadAuthority(deps.store, session.execution_id)
			).prHeadSha;
		} catch {
			authoritativeHead = undefined;
		}
		const headMatch =
			!!boundHead &&
			!!authoritativeHead &&
			!!info.headRefOid &&
			boundHead === authoritativeHead &&
			authoritativeHead === info.headRefOid;
		const trusted = hasTrusted(session);
		const engineShip = await computeEngineWorkflowShipPrecondition(
			deps.store,
			session.execution_id,
			authoritativeHead ?? "",
			deps.materializedHeadAuthority,
		);
		if (headMatch && trusted && engineShip.eligible) {
			log(
				`[external-merge] FLY-945 finalizing completed-but-unfinalized ${session.execution_id} (${session.issue_id}) — merged head matches bound approval`,
			);
			await finalize(session, info);
			return;
		}
		// Rogue / head-drifted merge — must be SEEN, never auto-archived. One
		// alert per (exec, merged head), claimed durably.
		const claimId = `external-merge-rogue-alert-${session.execution_id}-${info.headRefOid ?? "unknown"}`;
		const claimed = deps.store.insertEvent({
			event_id: claimId,
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "external_merge_suspect",
			source: "bridge.external-merge-reconcile",
			payload: {
				boundHead: boundHead ?? null,
				mergedHead: info.headRefOid ?? null,
				trustedApproval: trusted,
				engineShipEligible: engineShip.eligible,
				engineShipReason:
					engineShip.engineOwned && !engineShip.eligible
						? engineShip.reason
						: null,
			},
		});
		if (claimed) {
			log(
				`[external-merge] FLY-945 SUSPECT merge for ${session.execution_id} (${session.issue_id}) — headMatch=${headMatch} trustedApproval=${trusted}; NOT finalizing, alerting Lead`,
			);
			await deps.alertLead?.(
				session,
				`Unverified external merge — ${session.issue_identifier ?? session.issue_id}`,
				`⚠️ ${session.issue_identifier ?? session.issue_id} 的 PR 已 merge(head ${info.headRefOid?.slice(0, 8) ?? "?"}),但${
					trusted
						? `批准绑定的是另一个 head(${boundHead?.slice(0, 8) ?? "无"})`
						: "找不到 founder 归属的批准"
				}。不自动归档 —— 请人工核对这次 merge。`,
			);
		}
	}

	return {
		async pass(): Promise<void> {
			const staleTtlMs = deps.staleTtlMs ?? 30 * 60_000;
			// FLY-2101: founder 2026-08-27 v4 fixed the former runtime flag at 7 days.
			const windowDays = deps.windowDays ?? 7;
			const budgetPerProject = deps.maxCandidatesPerProject ?? 3;
			const nowMs = now();

			for (const project of deps.projects) {
				const root = project.projectRoot;
				if (!root) continue;
				const projectName = project.projectName;
				const declaredProbeCount = await reconcileDeclaredPrRuns(
					projectName,
					root,
					budgetPerProject,
				);
				const ordinaryBudget = Math.max(
					0,
					budgetPerProject - declaredProbeCount,
				);

				// ── collect candidates (cheap local reads only) ──
				const parked = deps.store
					.listParkedSessionsForProject(projectName)
					.filter((s) => {
						if (!PARK_STATES.has(s.status)) return false;
						if (s.merge_block_reason) return false; // already explicitly held
						if (!s.pr_number) return false; // no gh handle
						return (
							classifyBlockerLocal({
								status: s.status,
								awaitingReviewEnteredAt: s.awaiting_review_entered_at,
								lastActivityAt: s.last_activity_at,
								nowMs,
								staleTtlMs,
							}).local === "needs_pr_check"
						);
					});
				const sinceMs = nowMs - windowDays * 24 * 3_600_000;
				const completed = deps.store
					.listCompletedSessionsWithPrSince(
						projectName,
						new Date(sinceMs).toISOString().replace("T", " ").slice(0, 19),
					)
					.filter((s) => {
						if (!s.pr_number) return false; // gh view needs a PR number
						// Already finalized once → the archive-once surface is done.
						if (isThreadArchived(s)) return false;
						// runPostShipFinalization's own claim is the finalize-once gate;
						// skip rows that already claimed it (idempotency, no gh spend).
						return !deps.store.hasFinalizationCompletedForIssue(s.issue_id);
					});

				const candidateMap = new Map<string, ProjectMergeCandidate>();
				for (const session of [...parked, ...completed]) {
					const prNumber = session.pr_number as number;
					const key = candidateKey(projectName, session.issue_id, prNumber);
					const candidate: ProjectMergeCandidate = candidateMap.get(key) ?? {
						issueId: session.issue_id,
						prNumber,
						sessions: [],
					};
					candidate.sessions.push(session);
					candidateMap.set(key, candidate);
				}

				// FLY-1314: TURN rows are first-class candidates. They are collected
				// even when every ordinary session was filtered by archive/finalization
				// claim/lookback, then deduped with ordinary work by (issue, PR).
				const belts = await collectTurnBeltCandidates(projectName, nowMs);
				for (const belt of belts.candidates) {
					const key = candidateKey(
						projectName,
						belt.turn.issue_id,
						belt.prNumber,
					);
					const candidate: ProjectMergeCandidate = candidateMap.get(key) ?? {
						issueId: belt.turn.issue_id,
						prNumber: belt.prNumber,
						sessions: [],
					};
					candidate.belt = belt;
					candidateMap.set(key, candidate);
				}
				if (belts.missingPr > 0 || belts.conflictingPr > 0) {
					log(
						`[external-merge] FLY-1314 ${projectName} TURN belts: scanned=${belts.scanned} eligible=${belts.candidates.length} missing_pr=${belts.missingPr} conflicting_pr=${belts.conflictingPr}`,
					);
				}

				const negativeTtlMs = intEnv(
					env(),
					"FLYWHEEL_EXTERNAL_MERGE_NEGATIVE_CACHE_MS",
					10 * 60_000,
				);
				for (const [key, expiresAt] of negativeMergeCache) {
					if (expiresAt <= nowMs) negativeMergeCache.delete(key);
				}
				const all = [...candidateMap.values()].filter((candidate) => {
					const key = candidateKey(
						projectName,
						candidate.issueId,
						candidate.prNumber,
					);
					return (negativeMergeCache.get(key) ?? 0) <= nowMs;
				});
				if (all.length === 0) continue;

				// ── rotate + budget the gh calls ──
				const start = rotation.get(projectName) ?? 0;
				const picked: ProjectMergeCandidate[] = [];
				for (let i = 0; i < all.length && picked.length < ordinaryBudget; i++) {
					const s = all[(start + i) % all.length];
					if (s) picked.push(s);
				}
				rotation.set(
					projectName,
					(start + picked.length) % Math.max(all.length, 1),
				);
				if (all.length > picked.length) {
					log(
						`[external-merge] ${projectName}: ${all.length} candidates, checking ${picked.length} this pass (remaining budget ${ordinaryBudget}, rotating)`,
					);
				}

				for (const candidate of picked) {
					try {
						const info = await checkPr(root, candidate.prNumber);
						// MERGED and ONLY merged acts; open/unknown/closed-unmerged are
						// untouched (closed may be a reject flow).
						const cacheKey = candidateKey(
							projectName,
							candidate.issueId,
							candidate.prNumber,
						);
						if (info.state !== "merged") {
							negativeMergeCache.set(cacheKey, nowMs + negativeTtlMs);
							continue;
						}
						negativeMergeCache.delete(cacheKey);
						if (deps.retireMergedGates) {
							const authorityCredential = `${projectName}:${candidate.prNumber}:${info.mergeCommitOid ?? info.headRefOid ?? "merged"}`;
							const issueAliases = [
								...new Set(
									[
										candidate.issueId,
										...candidate.sessions.flatMap((session) => [
											session.issue_id,
											session.issue_identifier,
										]),
										candidate.belt?.holder.issue_id,
										candidate.belt?.holder.issue_identifier,
									].filter((value): value is string => !!value),
								),
							];
							await deps.retireMergedGates({
								projectName,
								canonicalIssueId: candidate.issueId,
								issueAliases,
								prNumber: candidate.prNumber,
								authorityCredential,
								revalidate: async () => {
									const fresh = await checkPr(root, candidate.prNumber);
									return fresh.state === "merged" ? "authorized" : "unknown";
								},
							});
						}
						for (const session of candidate.sessions) {
							// Re-read the row — the world may have moved during the gh call.
							const fresh = deps.store.getSession(session.execution_id);
							if (!fresh) continue;
							if (PARK_STATES.has(fresh.status)) {
								if (!fresh.merge_block_reason) await handleParked(fresh, info);
							} else if (fresh.status === "completed") {
								await handleCompletedUnfinalized(fresh, info);
							}
						}
						// Belt reclaim is intentionally independent of path-1/path-2 ship
						// validation. MERGED proof + terminal/dead holder + CAS is enough.
						if (candidate.belt) {
							await reclaimTurnBelt(projectName, candidate.belt, info);
						}
					} catch (err) {
						log(
							`[external-merge] ${candidate.issueId}#${candidate.prNumber} reconcile error (isolated): ${(err as Error).message}`,
						);
					}
				}
			}
		},
	};
}

function parseLabels(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((l) => typeof l === "string")
			: [];
	} catch {
		return [];
	}
}
