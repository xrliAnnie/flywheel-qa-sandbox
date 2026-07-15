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
 * pass (default 3), rotating. Kill-switch: FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CommDB } from "flywheel-comm/db";
import {
	isTrustedApprovalAttribution,
	resolveFounderId,
} from "flywheel-comm/founder-attribution";
import {
	resolveWorkflowClaimsReadEnabled,
	type ShipEligibilityDecision,
} from "flywheel-comm/ship-eligibility";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { commDbPathForProject } from "./commdb-path.js";
import { resolveWorkflowHeadAuthority } from "./head-authority.js";
import { makeLinearDoneFinalizer } from "./linear-issue-finalizer.js";
import {
	computeAuthoritativeShipDecision,
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
): Promise<PrMergeInfo> {
	if (!Number.isInteger(prNumber) || prNumber <= 0) return { state: "unknown" };
	try {
		const { stdout } = await execFileP(
			"gh",
			[
				"pr",
				"view",
				String(prNumber),
				"--json",
				"state,mergedAt,mergeCommit,headRefOid",
			],
			{ cwd: projectRoot, timeout: Math.max(1, timeoutMs) },
		);
		const parsed = JSON.parse(stdout) as {
			state?: string;
			mergedAt?: string | null;
			mergeCommit?: { oid?: string } | null;
			headRefOid?: string;
		};
		const headRefOid = parsed.headRefOid?.toLowerCase();
		if (parsed.mergedAt || parsed.state === "MERGED") {
			return {
				state: "merged",
				mergeCommitOid: parsed.mergeCommit?.oid?.toLowerCase(),
				headRefOid,
			};
		}
		if (parsed.state === "CLOSED") return { state: "closed", headRefOid };
		if (parsed.state === "OPEN") return { state: "open", headRefOid };
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
	/** Path-2 lookback window in days (FLYWHEEL_MERGE_RECONCILE_WINDOW_DAYS). Default 7. */
	windowDays?: number;
	/** gh-call budget per project per pass. Default 3. */
	maxCandidatesPerProject?: number;
	/** Test seam for the gh query. */
	checkPrMerge?: typeof checkPrMergeViaGh;
	/** Test seam for the path-2 trusted-approval read (default: CommDB). */
	hasTrustedApprovalImpl?: (session: Session) => boolean;
	/**
	 * FLY-1204: the three-stage keep-alive phase finalizer (same one the
	 * DirectEventSink / event-route paths use). External merge is a real ship
	 * path, so it must reclaim the parked design/implement/qa phase sessions too;
	 * without it the external-merge finalize writes the post-ship claim but leaves
	 * the phase sessions leaked alive until the periodic patrol catches them.
	 * Optional → absent leaves the phases to the patrol (byte-compat).
	 */
	finalizeThreeStagePhases?: (
		issueId: string,
		projectName: string,
	) => Promise<void>;
	log?: (m: string) => void;
}

const PARK_STATES = new Set(["awaiting_review", "approved_to_ship"]);

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

	async function finalize(session: Session, info: PrMergeInfo): Promise<void> {
		await runPostShipFinalization(
			{
				executionId: session.execution_id,
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
				// FLY-1204: reclaim the parked three-stage phases on this ship path too.
				finalizeThreeStagePhases: deps.finalizeThreeStagePhases,
				markIssueDone: makeLinearDoneFinalizer(deps.config),
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

	async function handleParked(session: Session, info: PrMergeInfo) {
		// Synthetic head fallback mirrors the sinks' erPrHead logic — the row may
		// predate the pr_head_sha write; the merged PR's own head is the evidence.
		const head =
			session.pr_head_sha?.trim().toLowerCase() || info.headRefOid || "";
		const decision: ShipEligibilityDecision & { authoritativeHead: string } =
			await computeAuthoritativeShipDecision(deps.store, session, head);
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
		if (resolveWorkflowClaimsReadEnabled({ env: process.env })) {
			try {
				authoritativeHead = (
					await resolveWorkflowHeadAuthority(deps.store, session.execution_id)
				).prHeadSha;
			} catch {
				authoritativeHead = undefined;
			}
		}
		const headMatch =
			!!boundHead &&
			!!authoritativeHead &&
			!!info.headRefOid &&
			boundHead === authoritativeHead &&
			authoritativeHead === info.headRefOid;
		const trusted = hasTrusted(session);
		if (headMatch && trusted) {
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
			if (env().FLYWHEEL_EXTERNAL_MERGE_RECONCILE === "0") return;
			const staleTtlMs = deps.staleTtlMs ?? 30 * 60_000;
			const windowDays = intEnv(
				env(),
				"FLYWHEEL_MERGE_RECONCILE_WINDOW_DAYS",
				deps.windowDays ?? 7,
			);
			const budgetPerProject = deps.maxCandidatesPerProject ?? 3;
			const nowMs = now();

			for (const project of deps.projects) {
				const root = project.projectRoot;
				if (!root) continue;
				const projectName = project.projectName;

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
						const claimedAlready = deps.store
							.getEventsByExecution(s.execution_id)
							.some(
								(e) =>
									e.event_id === `post-ship-finalization-${s.execution_id}`,
							);
						return !claimedAlready;
					});

				const all = [...parked, ...completed];
				if (all.length === 0) continue;

				// ── rotate + budget the gh calls ──
				const start = rotation.get(projectName) ?? 0;
				const picked: Session[] = [];
				for (
					let i = 0;
					i < all.length && picked.length < budgetPerProject;
					i++
				) {
					const s = all[(start + i) % all.length];
					if (s) picked.push(s);
				}
				rotation.set(
					projectName,
					(start + picked.length) % Math.max(all.length, 1),
				);
				if (all.length > picked.length) {
					log(
						`[external-merge] ${projectName}: ${all.length} candidates, checking ${picked.length} this pass (budget ${budgetPerProject}, rotating)`,
					);
				}

				for (const session of picked) {
					try {
						const info = await checkPr(root, session.pr_number as number);
						// MERGED and ONLY merged acts; open/unknown/closed-unmerged are
						// untouched (closed may be a reject flow).
						if (info.state !== "merged") continue;
						// Re-read the row — the world may have moved during the gh call.
						const fresh = deps.store.getSession(session.execution_id);
						if (!fresh) continue;
						if (PARK_STATES.has(fresh.status)) {
							if (!fresh.merge_block_reason) await handleParked(fresh, info);
						} else if (fresh.status === "completed") {
							await handleCompletedUnfinalized(fresh, info);
						}
					} catch (err) {
						log(
							`[external-merge] ${session.execution_id} reconcile error (isolated): ${(err as Error).message}`,
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
