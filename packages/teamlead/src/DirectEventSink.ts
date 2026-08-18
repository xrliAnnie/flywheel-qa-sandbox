/**
 * GEO-168: DirectEventSink — bridge-local ExecutionEventEmitter that writes
 * directly to StateStore instead of HTTP self-post. Mirrors event-route.ts logic.
 */

import { randomUUID } from "node:crypto";
import {
	adapterTypeToFamily,
	DEFAULT_PROOFSHOT_CONFIG,
	isWorkflowPhaseRole,
	renderRunnerModelDisplay,
	resolveCompletionSessionRole,
	type SkillsConfig,
} from "flywheel-config";
import {
	isNoOutEdgeTerminalStatus,
	type TerminalFailureInfo,
} from "flywheel-core";
import type {
	EventEnvelope,
	ExecutionEventEmitter,
} from "flywheel-edge-worker";
import type { BlueprintResult } from "flywheel-edge-worker/dist/Blueprint.js";
import type { AutoQaCoordinator } from "./bridge/auto-qa-coordinator.js";
import { isReviewHeld } from "./bridge/auto-qa-held.js";
import type { ChatThreadCreator } from "./bridge/ChatThreadCreator.js";
import { resolveChatThreadId } from "./bridge/chat-thread-utils.js";
import {
	archiveEpochInterval,
	reactivateChatThreadForStartedSession,
	stateTimestampMs,
} from "./bridge/done-thread-archiver.js";
import type { EventFilter } from "./bridge/EventFilter.js";
import { buildSessionKey, type HookPayload } from "./bridge/hook-payload.js";
import type { IssueDisplayRefreshHolder } from "./bridge/issue-display-refresher.js";
import type { LeadEventEnvelope } from "./bridge/lead-runtime.js";
import { makeLinearDoneFinalizer } from "./bridge/linear-issue-finalizer.js";
import type { MaterializedHeadAuthority } from "./bridge/materialized-head-authority.js";
import {
	computeAuthoritativeShipDecision,
	isMergeBlocked,
	mergedPrCiProbe,
	parkMergeBlock,
} from "./bridge/merge-ship-gate.js";
import {
	isPostApproveShipComplete,
	markEvidenceGapCompletion,
	runPostShipFinalization,
	settleShipAttemptFailed,
} from "./bridge/post-ship-finalization.js";
import {
	getProofShotParams,
	patchSessionParams,
} from "./bridge/proofshot-session.js";
import {
	dispatchLeadEventCompat,
	type RuntimeRegistry,
} from "./bridge/runtime-registry.js";
import { STAGE_ORDER } from "./bridge/stage-utils.js";
import type { TerminalCommDbSync } from "./bridge/terminal-commdb-sync.js";
import type { TurnBeltReconciler } from "./bridge/turn-belt-reconcile.js";
import type { BridgeConfig } from "./bridge/types.js";
import type { WorktreeCleanupFn } from "./bridge/worktree-cleanup.js";
import { type ProjectEntry, resolveLeadForIssue } from "./ProjectConfig.js";
import type { StateStore } from "./StateStore.js";

function sqliteDatetime(): string {
	return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export class DirectEventSink implements ExecutionEventEmitter {
	private pending: Promise<void>[] = [];

	/**
	 * FLY-603 Layer A: worktree-cleanup closure, set by the Bridge composition
	 * root after construction (kept off the long constructor). Absent → no
	 * worktree cleanup on this path (byte-compat).
	 */
	public removeCleanWorktree?: WorktreeCleanupFn;
	/** FLY-1185: ship-entry lifecycle bundle (remote CAS + closeout + sweep). */
	public lifecycleInfra?: import("./bridge/post-ship-finalization.js").LifecycleShipInfra;

	/**
	 * FLY-579 (Codex R1 HIGH-1): late-bound auto-QA coordinator holder, set by
	 * the composition root after construction (the coordinator is built later, in
	 * startBridge). This in-process completed path is a production / dual-sink
	 * emitter, so it MUST drive auto-QA + suppress the founder review-required
	 * delivery exactly like the HTTP /events route — otherwise a held founder
	 * gate leaks here. Absent / `.current` undefined → byte-compatible (isQaHeld
	 * is always false with no held record).
	 */
	public autoQaCoordinator?: { current: AutoQaCoordinator | undefined };
	/** Late-bound TURN recovery shared by generalized workflow actors. */
	public turnBeltReconciler?: { current: TurnBeltReconciler | undefined };

	/**
	 * FLY-1282 Part C: targeted terminal-archive enqueue (pre-binding buffer →
	 * FLY-1165 scheduler consumer). Production always wires it; optionality is
	 * retained for embedding/test callers.
	 */
	public terminalArchiveEnqueue?: (issueId: string) => void;

	/**
	 * FLY-887: ship-time DAG workflow finalizer (closes the parked design +
	 * implement sessions before the shared worktree is removed). Set by the
	 * composition root after construction. Absent → no phase finalization
	 * (byte-compat; a single-session issue leaves nothing to finalize anyway).
	 */
	public finalizeWorkflowPhaseRoles?: (
		issueId: string,
		projectName: string,
	) => Promise<void>;

	/**
	 * FLY-907 (Step 4.1b): unified issue-display refresh holder. This in-process
	 * sink writes session status via `upsertSession` DIRECTLY (it deliberately
	 * does NOT route through applyTransition — see emitCompleted), so the
	 * onTransition hook never sees its writes. Set by the composition root;
	 * absent / `.current` undefined → byte-compat no-op. Enqueued after
	 * started/completed/failed writes; the AWAITED `refresh` is threaded into
	 * runPostShipFinalization so the ship-terminal display state lands BEFORE
	 * the thread archive.
	 */
	public issueDisplayRefresh?: IssueDisplayRefreshHolder;

	/**
	 * FLY-1066 Layer 1: this sink persists terminal StateStore rows directly,
	 * bypassing applyTransition. The composition root supplies the shared,
	 * non-blocking CommDB sync queue so failed/blocked registrations converge
	 * without doing SQLite work in this event path.
	 */
	public terminalCommDbSync?: Pick<TerminalCommDbSync, "enqueue">;

	/**
	 * FLY-1185 (Codex R4#1, plan.md:145): launch-claim activation hook — CAS
	 * starting→active under the canonical issue mutex, called by emitStarted
	 * AFTER the session row is durable. Refusal (a park cancelled the claim
	 * mid-spawn) is audited; the park-intent replay owns the newborn runner.
	 * Absent → byte-compatible (no launch-claim admission wired).
	 */
	public lifecycleActivate?: (
		executionId: string,
	) => Promise<{ ok: boolean; reason?: string }>;

	/** FLY-1307 PR-7.5: trusted receipt-backed head for output-backed reviews. */
	public materializedHeadAuthority?: MaterializedHeadAuthority;

	private notifyDisplayChanged(issueId: string): void {
		try {
			this.issueDisplayRefresh?.current?.enqueue(issueId);
		} catch (err) {
			console.warn(
				`[DirectEventSink] issue-display enqueue threw for ${issueId}: ${(err as Error).message}`,
			);
		}
	}

	private enqueueTerminalCommDbStatus(
		executionId: string,
		status: "failed" | "blocked",
		projectName: string,
	): void {
		try {
			this.terminalCommDbSync?.enqueue(executionId, status, projectName);
		} catch (err) {
			console.warn(
				`[DirectEventSink] terminal CommDB enqueue threw for ${executionId}: ${(err as Error).message}`,
			);
		}
	}

	constructor(
		private store: StateStore,
		private config: BridgeConfig,
		private projects: ProjectEntry[],
		private eventFilter?: EventFilter,
		private registry?: RuntimeRegistry,
		private chatThreadCreator?: ChatThreadCreator,
		/**
		 * GEO-151: Project SkillsConfig (from `<projectRoot>/.flywheel/config.yaml`).
		 * Used by `emitStarted()` to persist effective `proofshot.config` into
		 * `session_params` so Bridge event-route handlers can read it without
		 * re-loading the YAML file. Optional — projects that don't ship a config
		 * file (or omit `skills`) fall back to `DEFAULT_PROOFSHOT_CONFIG`
		 * (`enabled=false`), which makes ProofShot a no-op for them.
		 */
		private skillsConfig?: SkillsConfig,
	) {}

	async emitStarted(env: EventEnvelope): Promise<void> {
		const now = sqliteDatetime();
		const existingSession = this.store.getSession(env.executionId);
		const startedAt = existingSession?.started_at ?? now;
		const workflowNodeId = this.store.resolveWorkflowNodeIdForExecution(
			env.executionId,
		);
		// GEO-202: Ensure issue_identifier is never null — fallback to issueId
		const identifier = env.issueIdentifier || env.issueId;

		// Store event
		this.store.insertEvent({
			event_id: randomUUID(),
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			event_type: "session_started",
			source: "direct-event-sink",
		});

		// Upsert session
		this.store.upsertSession({
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			status: "running",
			// FLY-1709: activation time is set-once. A replay of an old running
			// execution must not impersonate a post-archive rework admission.
			started_at: startedAt,
			last_activity_at: now,
			heartbeat_at: now,
			issue_identifier: identifier,
			issue_title: env.issueTitle,
			retry_predecessor: env.retryPredecessor,
			run_attempt: env.runAttempt,
			issue_labels: env.labels ? JSON.stringify(env.labels) : undefined,
			session_stage: "started",
			stage_updated_at: now,
			session_role: env.sessionRole ?? "main",
			// FLY-793 (Step 11): persist the chat-thread role at start (this in-process
			// sink is the PRODUCTION started path). Set-once, immutable thereafter.
			chat_thread_role: env.chatThreadRole ?? "main",
			// FLY-493 (Codex code review R1): the PRODUCTION started path is this
			// in-process sink — persist the resolved executor backend as
			// adapter_type so the no-transport wake-guard (runner-wake.ts) can
			// recognize an antigravity session. The HTTP /events session_started
			// handler persists the same field for the loopback path.
			adapter_type: env.runnerBackend,
			// FLY-728: persist the resolved runner model as runner_model so the
			// dashboard / issue surfaces show which model the per-issue routed runner
			// is using. The HTTP /events session_started handler persists the same
			// field for the loopback path.
			runner_model: env.runnerModel,
			// FLY-1259: run-level effective design backend, set-once in StateStore.
			design_backend: env.designBackend,
			// FLY-615: persist the resolved ponytail condition (A/B join key for
			// FLY-614 token accounting + FLY-616 quality eval). HTTP /events path
			// persists the same field.
			ponytail_condition: env.ponytailCondition,
			// FLY-1356: persist the effective skill-framework arm + attribution
			// (A/B/C split eval join keys). Absent when the flag sat at its
			// default (upsertSession leaves the columns untouched when undefined).
			// HTTP /events path persists the same fields behind closed-enum guards.
			skill_framework_mode: env.skillFrameworkMode,
			skill_framework_mode_via: env.skillFrameworkModeVia,
			// FLY-1372 §2.5: Bridge-trusted behavior fields — set ONLY on engine-
			// owned generalized (pipeline.dag) starts, persisted atomically with
			// row creation (upsertSession leaves them untouched when undefined).
			// This in-process sink is the ONLY writer; the HTTP client never
			// transmits them and /events ignores same-named runner payload fields.
			doc_tier: env.docTier,
			issue_url: env.issueUrl,
			codex_skip:
				env.codexSkip === undefined ? undefined : env.codexSkip ? 1 : 0,
			workflow_node_id: workflowNodeId,
		});

		// FLY-1185 (Codex R5#1): the launch-claim starting→active CAS is NOT done
		// here — emitStarted runs fire-and-forget BEFORE the worktree/binding are
		// created (Blueprint.ts), so `active` here would still precede a durable
		// binding (plan.md:145 violation). Activation moved to emitWorktreeReady,
		// which runs AFTER bindWorktreeOnce makes the binding durable.

		// GEO-151: Persist effective proofshot config into session_params so
		// Bridge event-route handlers can read it without re-loading config.
		// Uses patchSessionParams (read-modify-write) so a replayed session_started
		// event does NOT clobber existing `proofshot.runs` or `last_artifact`
		// state from prior captures in the same execution (Bridge restart safety).
		this.persistProofShotConfig(env.executionId);
		if (env.routeSummary) {
			patchSessionParams(this.store, env.executionId, (cur) => ({
				...cur,
				workflowRoute: { summary: env.routeSummary },
			}));
		}

		// FLY-91: Await chat thread creation so first notification includes chat_thread_id.
		// Unlike ForumPost (fire-and-forget), chat_thread_id doesn't affect EventFilter
		// classification, so awaiting is safe and ensures first message goes to thread.
		if (this.config.chatThreadsEnabled && this.chatThreadCreator) {
			const eventLabels = env.labels ?? [];
			try {
				const { lead: ctLead } = resolveLeadForIssue(
					this.projects,
					env.projectName,
					eventLabels,
				);
				if (ctLead.chatChannel) {
					const botToken = ctLead.botToken ?? this.config.discordBotToken;
					if (botToken) {
						const existingThread = this.store.getChatThreadByIssue(
							env.issueId,
							ctLead.chatChannel,
						);
						const archivedAt = existingThread?.archived_at;
						const archiveEpoch = archivedAt
							? archiveEpochInterval(archivedAt)
							: null;
						const activationMs = stateTimestampMs(startedAt);
						if (
							existingThread &&
							archiveEpoch &&
							activationMs !== null &&
							activationMs > archiveEpoch.endMs
						) {
							await reactivateChatThreadForStartedSession(
								this.store,
								{
									threadId: existingThread.thread_id,
									issueId: env.issueId,
									projectName: env.projectName,
									executionId: env.executionId,
								},
								botToken,
							);
						} else if (archivedAt) {
							console.warn(
								`[DirectEventSink] cannot prove reactivation epoch for ${env.executionId}; archived thread remains protected (activation=${startedAt}, archive=${archivedAt})`,
							);
						}
						const resolvedTitle =
							env.issueTitle ??
							this.store.getSessionByIssue(env.issueId)?.issue_title ??
							undefined;
						console.log(
							`[DirectEventSink] ensureChatThread calling: issueId=${env.issueId} channel=${ctLead.chatChannel} lead=${ctLead.agentId} hasToken=true`,
						);
						const result = await this.chatThreadCreator.ensureChatThread({
							chatChannelId: ctLead.chatChannel,
							issueId: env.issueId,
							issueIdentifier: env.issueIdentifier,
							issueTitle: resolvedTitle,
							routeSummary: env.routeSummary,
							botToken,
							leadId: ctLead.agentId,
							ownerUserId: this.config.discordOwnerUserId,
							// FLY-1255: stamp the resolved runner model at thread creation.
							// `?? null` is authoritative and clears a stale marker when no
							// model was selected.
							modelMarker:
								renderRunnerModelDisplay({
									vendor: env.runnerBackend
										? adapterTypeToFamily(env.runnerBackend)
										: undefined,
									model: env.runnerModel,
								})?.threadMarker ?? null,
							// FLY-892 (converge): one issue = one thread — no per-phase
							// thread role is passed; the phase session and the Lead resolve
							// the SAME (issue, channel) thread. `chat_thread_role` is still
							// persisted on the session row (above) as the phase MARKER.
						});
						console.log(
							`[DirectEventSink] ensureChatThread: created=${result.created} threadId=${result.threadId ?? "none"} error=${result.error ?? "none"}`,
						);
					} else {
						console.warn(
							`[DirectEventSink] chatThread skipped for ${env.issueId}: no botToken (lead=${ctLead.agentId}, globalToken=${!!this.config.discordBotToken})`,
						);
					}
				} else {
					console.warn(
						`[DirectEventSink] chatThread skipped for ${env.issueId}: lead "${ctLead.agentId}" has no chatChannel`,
					);
				}
			} catch (err) {
				console.warn(
					`[DirectEventSink] ensureChatThread failed for ${env.issueId}:`,
					(err as Error).message,
				);
			}
		} else {
			console.log(
				`[DirectEventSink] chatThread guard: enabled=${!!this.config.chatThreadsEnabled} hasCreator=${!!this.chatThreadCreator} — skipping for ${env.issueId}`,
			);
		}

		// FLY-907: a fresh session row (incl. an operator-reset's replacement
		// exec) changes what all three display faces should show.
		this.notifyDisplayChanged(env.issueId);

		// Notify agent
		this.pushNotification(env, "session_started");
	}

	/**
	 * FLY-137: In-process counterpart to TeamLeadClient.emitWorktreeReady.
	 * Persists `session.worktree_path` immediately so downstream stage
	 * handlers (Codex auto-trigger / skip.json) write into the Runner's
	 * actual cwd.
	 *
	 * Codex R2 #1 fix: even though `emitStarted` runs its sync
	 * `store.upsertSession` before any await, future refactors might
	 * change that. Defensive upsert ensures `worktree_path` lands
	 * regardless of whether `emitStarted` has populated the row first.
	 */
	async emitWorktreeReady(
		env: EventEnvelope,
		worktreePath: string,
		binding?: {
			branch: string;
			generation: string;
			repoBaselineSetJson?: string;
			repoBaselineSetDigest?: string;
		},
	): Promise<void> {
		if (!worktreePath || worktreePath.length === 0) {
			console.warn(
				`[DirectEventSink] emitWorktreeReady for ${env.executionId} called with empty worktreePath`,
			);
			return;
		}
		const existing = this.store.getSession(env.executionId);
		if (!existing) {
			// Codex R3 #1 fix: leave status as `pending` so the later
			// session_started FSM transition (`pending → running`) is
			// legal. Upserting as `running` here would cause WorkflowFSM
			// to reject `running → running` and skip labels/title/thread
			// initialization in the started handler.
			this.store.upsertSession({
				execution_id: env.executionId,
				issue_id: env.issueId,
				project_name: env.projectName,
				status: "pending",
				worktree_path: worktreePath,
			});
		} else {
			this.store.patchSessionMetadata(env.executionId, {
				worktree_path: worktreePath,
			});
		}

		// FLY-1185 §2.1: this bridge-local sink is the ONLY authority channel —
		// the orchestrator-created binding (path/branch/generation) becomes
		// StateStore deletion authority via the atomic set-once bindWorktreeOnce.
		// A second bind attempt (retry replay / forged overwrite) is refused and
		// audited; the HTTP /events path structurally never reaches here.
		if (binding?.generation && binding.branch) {
			const res = this.store.bindWorktreeOnce(
				env.executionId,
				{
					path: worktreePath,
					branch: binding.branch,
					generation: binding.generation,
					...(binding.repoBaselineSetJson && binding.repoBaselineSetDigest
						? {
								repoBaselineSetJson: binding.repoBaselineSetJson,
								repoBaselineSetDigest: binding.repoBaselineSetDigest,
							}
						: {}),
				},
				{ issueId: env.issueId, projectName: env.projectName },
			);
			if (!res.bound && res.reason === "already_bound") {
				const current = this.store.getWorktreeBinding(env.executionId);
				const identical =
					current?.path === worktreePath &&
					current?.branch === binding.branch &&
					current?.generation === binding.generation;
				if (!identical) {
					this.store.insertEvent({
						event_id: `worktree-binding-rejected-${env.executionId}-${binding.generation}`,
						execution_id: env.executionId,
						issue_id: env.issueId,
						project_name: env.projectName,
						event_type: "worktree_binding_rejected",
						source: "direct-event-sink",
						payload: {
							attemptedPath: worktreePath,
							attemptedBranch: binding.branch,
							attemptedGeneration: binding.generation,
						},
					});
				}
			}

			// FLY-1185 (Codex R5#1, plan.md:145): the binding is DURABLE now —
			// THIS is the launch-claim's `active` commit point. A refusal means a
			// founder park cancelled the claim in the spawn window; the runner was
			// still born (activation only audits — it cannot unwind the already-
			// created worktree), so the park-intent replay (which keeps its intent
			// PARTIAL after cancelling a `starting` claim — see closeoutOneNode)
			// owns this newborn runner's teardown next tick via its binding-owned
			// residue. A crash between here and the next tick is covered by the
			// stale-starting-claims maintenance reaper.
			if (this.lifecycleActivate) {
				try {
					const act = await this.lifecycleActivate(env.executionId);
					if (!act.ok) {
						this.store.insertEvent({
							event_id: `lifecycle-activation-refused-${env.executionId}-${binding.generation}`,
							execution_id: env.executionId,
							issue_id: env.issueId,
							project_name: env.projectName,
							event_type: "lifecycle_activation_refused",
							source: "direct-event-sink",
							payload: { reason: act.reason },
						});
						console.warn(
							`[DirectEventSink] launch activation refused for ${env.executionId} (${act.reason}) — park replay owns this runner`,
						);
					}
				} catch (err) {
					console.warn(
						`[DirectEventSink] launch activation threw for ${env.executionId}: ${(err as Error).message}`,
					);
				}
			}
		}
	}

	async emitCompleted(
		env: EventEnvelope,
		result: BlueprintResult,
		summary?: string,
	): Promise<void> {
		const now = sqliteDatetime();
		// FLY-1404: this in-process carrier has no field that can hold the
		// CLI-minted, git-proven designHtmlEvidence attestation. Never fabricate a
		// positive state here: design-node completion must arrive through the HTTP
		// or marker carrier. The operational escape hatch is deliberately loud.
		const route: string | undefined = result.decision?.route;
		if (route === "phase_design_complete") {
			if (process.env.FLYWHEEL_DESIGN_HTML_GATE !== "0") {
				console.warn(
					`[DirectEventSink] founder design HTML evidence unavailable for ${env.executionId}; refusing design-node completion (use the flywheel-comm HTTP/marker path)`,
				);
				return;
			}
			console.warn(
				"[DirectEventSink] design-HTML gate DISABLED via FLYWHEEL_DESIGN_HTML_GATE=0 — skipping founder design HTML validation",
			);
		}
		const workflowNodeId = this.store.resolveWorkflowNodeIdForExecution(
			env.executionId,
		);
		const generalizedExecution =
			this.store.getGeneralizedWorkflowNodeForExecution(env.executionId);
		if (generalizedExecution) {
			// FLY-1434: BlueprintResult has no PR-number/target-repository evidence
			// carrier. Never infer a binding from session display metadata here.
			// PR-producing generalized nodes must complete through flywheel-comm's
			// HTTP /events path (`complete --route needs_review --pr ...`), where
			// Bridge re-derives repository/head authority server-side.
			if (generalizedExecution.node.capabilities.creates_pr) {
				console.warn(
					`[DirectEventSink] generalized PR completion rejected for ${env.executionId}; use flywheel-comm complete --pr via HTTP`,
				);
				return;
			}
			const recorded = this.store.recordEnrolledTerminalSignal({
				executionId: env.executionId,
				sourceEventId: randomUUID(),
				signal: "completed",
				source: "direct-event-sink",
				now,
			});
			if (!recorded.ok) {
				console.error(
					`[DirectEventSink] generalized completion persistence refused for ${env.executionId}: ${recorded.reason}`,
				);
			} else if (recorded.statusPreserved) {
				console.warn(
					`[DirectEventSink] FLY-1427 terminal-immune: ignored generalized completion overwrite for ${env.executionId}; effective status remains ${recorded.effectiveStatus}`,
				);
			}
			return;
		}

		const completionEventId = randomUUID();
		this.store.insertEvent({
			event_id: completionEventId,
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			event_type: "session_completed",
			source: "direct-event-sink",
		});

		// Status mapping (aligned with event-route.ts).
		// FLY-222 #1 (Codex code-review R2 HIGH-1): widen to `string` at this
		// consumption boundary so the sink can legally RECOGNIZE a runtime
		// `no_code` route. The Decision Layer's generated-route allowlist
		// (`DecisionRoute`) stays intentionally restricted — `no_code` is a
		// runner-emitted completion route, not a Decision Layer output — so we do
		// not pollute that type; the HTTP `/events` sink already reads route as a
		// plain string for the same reason.
		const landingStatus = result.evidence?.landingStatus as
			| { status?: string }
			| undefined;
		// FLY-102: capture existing status BEFORE upsertSession writes the new
		// one. isPostApproveShipComplete needs the approved_to_ship → completed
		// transition; FLY-208 5a additionally needs it for the status mapping
		// itself (hoisted above the mapping for that reason).
		const preExistingSession = this.store.getSession(env.executionId);
		const isApprovedToShip = preExistingSession?.status === "approved_to_ship";

		// FLY-222 #1 (Codex code-review MED-2): no_code is ONLY a running→completed
		// terminal. A no_code emission for a non-running (e.g. review-gated) session
		// must NOT clear that state — skip the status write entirely (symmetric
		// with event-route.ts's strict-guard skip; the session_completed audit
		// event above is still recorded). Without this, a non-running no_code would
		// fall through to the `else` default below, which also maps to `completed`.
		// FLY-493: pr_handoff (no-transport antigravity build+PR terminal) has the
		// SAME running-only constraint as no_code — skip from any non-running
		// state so it can't clear a review-gated session.
		// FLY-793 (Codex full-PR R1 #3): phase_design_complete has the SAME
		// running-only constraint — a duplicate/late Design completion for a session
		// already moved to design_done/completed must NOT re-write design_done and
		// re-invoke the workflow engine (→ duplicate Implement dispatch / status
		// regression). Parity with event-route.ts's phase_design_complete guard.
		if (
			(route === "no_code" ||
				route === "pr_handoff" ||
				route === "phase_design_complete") &&
			preExistingSession?.status !== "running"
		) {
			console.warn(
				`[DirectEventSink] route=${route} for non-running ${env.executionId} ` +
					`(status=${preExistingSession?.status ?? "none"}) — skipping ` +
					`(${route} only terminalizes a running runner)`,
			);
			return;
		}
		// FLY-208 5a × FLY-191 R5 interaction: a Phase-2-BOUND session's
		// status is owned by the HTTP `complete --question-id` path — this
		// in-process sink must never unstick (or otherwise move) it, or the
		// R5 protection (late qid-less emission can't regress/advance an
		// approved_to_ship session) regresses. The 5a evidence-gap unstick via
		// THIS sink therefore applies to legacy (non-bound) sessions only;
		// bound sessions get unstuck through event-route, which has its own
		// binding-aware handling.
		const desPhase2Bound = !!preExistingSession?.review_question_id;
		const isPostApproveShip =
			preExistingSession?.status === "approved_to_ship" && !desPhase2Bound;

		let status: string;
		// FLY-869 B: ship-eligibility gate — computed BEFORE any status mutation
		// (design R2 HIGH-1: verifyApproval requires the row still be
		// approved_to_ship, but this sink writes `completed` first, so the decision
		// MUST be taken pre-transition and threaded into finalization). A merged
		// landing that is NOT ship-eligible is parked with a durable merge_block
		// marker (决定③ — no auto-revert). Sister computation: event-route.ts
		// session_completed + W2 + complete-marker-reconciler — all MUST agree.
		const desMergedLanding = landingStatus?.status === "merged";
		// FLY-869 B (Codex R2 #1): on the first `complete --route needs_review` the row may
		// not have pr_head_sha yet (it is patched later) — so a merge_block parked HERE would
		// bind an empty head and later refuse same-head recovery. Fall back to the completion
		// event's own evidence.headSha so the marker is bound to the REAL merged head.
		const desPrHead =
			preExistingSession?.pr_head_sha?.trim() ||
			(result.evidence?.headSha as string | undefined)?.trim();
		// Always route through the shared predicate (it uniformly honors the
		// independent kill-switches). A missing/empty head → verifyApproval
		// fail-closes when the gate is ON, and the kill-switch still bypasses when OFF.
		const desDecision = desMergedLanding
			? await computeAuthoritativeShipDecision(
					this.store,
					preExistingSession ?? {
						execution_id: env.executionId,
						project_name: env.projectName,
					},
					desPrHead,
					process.env,
					this.materializedHeadAuthority,
					mergedPrCiProbe,
				)
			: undefined;
		const desShipEligible = desMergedLanding
			? (desDecision?.eligible ?? false)
			: undefined;
		const desParkUnapprovedMerge = (): "awaiting_review" => {
			if (preExistingSession) {
				const claimed = parkMergeBlock(
					this.store,
					preExistingSession,
					desDecision?.authoritativeHead ?? desPrHead ?? "",
					desDecision ?? {
						eligible: false,
						mergeApprovalOk: false,
						qaOk: false,
						mergeReason: "no_pr_head",
						qaReason: "session_not_found",
					},
				);
				if (claimed) {
					console.warn(
						`[DirectEventSink] FLY-869 merge_without_approval — ${env.executionId} ` +
							`merged head=${desPrHead ?? "(none)"} NOT ship-eligible ` +
							`(merge=${desDecision?.mergeReason ?? "no_head"} qa=${desDecision?.qaReason ?? "n/a"}); ` +
							`parked awaiting_review + merge_block marker (no auto-revert)`,
					);
					// FLY-869 决定③: one loud Discord alert (once per head — the
					// in-process twin of the event-route path).
					void this.autoQaCoordinator?.current?.alertMergeWithoutApproval(
						preExistingSession,
						`⛔ Runner ${env.executionId}（${preExistingSession.issue_id}）自行 merge 但未获批准 —— merged head ${desPrHead ?? "(none)"} 未通过 ship 闸（merge=${desDecision?.mergeReason ?? "no_head"} qa=${desDecision?.qaReason ?? "n/a"}）。已挂 merge_block、未标 Done、issue 留 open，不会自动 revert —— 需要人来处理。`,
					);
				}
			}
			return "awaiting_review";
		};
		// FLY-208 5a: approved_to_ship + auto_approve/needs_review WITHOUT
		// merged landing used to map to awaiting_review — FSM-invalid from
		// approved_to_ship → rejected → stuck forever (LEARN-12 incident).
		// Complete with an evidence-gap marker instead; finalization suppressed
		// (isPostApproveShipComplete requires merged landing). Sister mapping:
		// event-route.ts session_completed — both sinks MUST agree.
		//
		// FLY-945 Fix C sink agreement: event-route now maps approved_to_ship +
		// needs_review WITH a NEW reviewQuestionId (≠ current binding) back to
		// awaiting_review (review re-request after an expired approval). THIS
		// sink structurally never carries a reviewQuestionId (BlueprintResult
		// has no such field; the R5 comment below pins that a Phase-2-bound
		// session's status is owned by the HTTP `complete --question-id` path)
		// — so the "no new questionId" leg of the FLY-945 criterion holds here
		// by construction and the 5a mapping below stays byte-identical. The
		// recovery lap is reachable ONLY through event-route / the marker
		// reconciler, both of which carry the questionId.
		let evidenceGap = false;
		if (route === "phase_design_complete") {
			// FLY-793: a DAG workflow Design phase-session completed (docs on the
			// shared branch, no PR). Non-terminal design_done; the workflow engine
			// hands off to Implement. Sister mapping: event-route.ts session_completed.
			status = "design_done";
		} else if (route === "needs_review") {
			// FLY-115 v1.24.5 (FLY-120): if the Runner already finished shipping
			// (Lead unblocked the approve_to_ship gate via flywheel-comm respond,
			// then the Runner self-merged), short-circuit to "completed". The
			// previous mapping forced status back to "awaiting_review" even when
			// landingStatus.status === "merged", leaving Lead telling Annie a PR
			// already on main was still waiting for :cool:. Mirrors the
			// auto_approve+merged branch and the post-approve-ship completion
			// guard at packages/teamlead/src/bridge/event-route.ts:344-354.
			if (landingStatus?.status === "merged") {
				// FLY-869 B: merged → completed ONLY when ship-eligible (verified
				// approval + Codex + QA); otherwise park (merge_without_approval).
				status = desShipEligible ? "completed" : desParkUnapprovedMerge();
			} else if (isPostApproveShip) {
				status = "completed";
				evidenceGap = true;
			} else {
				status = "awaiting_review";
			}
		} else if (route === "auto_approve") {
			// FLY-58: merged → completed (not approved)
			if (landingStatus?.status === "merged") {
				// FLY-869 B: gate on ship-eligibility (see needs_review branch).
				status = desShipEligible ? "completed" : desParkUnapprovedMerge();
			} else if (isPostApproveShip) {
				status = "completed";
				evidenceGap = true;
			} else {
				status = "awaiting_review";
			}
		} else if (route === "blocked" || route === "ship_attempt_failed") {
			if (isApprovedToShip) {
				const settle = settleShipAttemptFailed(this.store, env.executionId, {
					// FLY-1505: the completion event owns the attempt head. Do
					// not reuse desPrHead (which is deliberately row-first).
					attemptHeadSha: result.evidence?.headSha,
					currentHeadSha: preExistingSession?.pr_head_sha,
					prNumber:
						result.evidence?.prNumber ??
						preExistingSession?.pr_number ??
						undefined,
					// This is a live sink: when a legacy completion omits its
					// binding, the simultaneously-read row is authoritative.
					// Delayed marker replay deliberately does not use this fallback.
					reviewQuestionId:
						result.reviewQuestionId ?? preExistingSession?.review_question_id,
					currentReviewQuestionId: preExistingSession?.review_question_id,
					summary,
				});
				if (
					(settle.outcome === "marked" ||
						settle.outcome === "unknown_head_marked") &&
					settle.firstAttemptForHead &&
					preExistingSession
				) {
					const retryPosture =
						settle.outcome === "marked"
							? "同 head 的自动重唤醒已暂停，请由 Lead 显式唤醒。"
							: "本次完成未携带可验证的 head；自动重唤醒仍开启（fail-open）。";
					void this.autoQaCoordinator?.current?.alertShipAttemptFailed(
						preExistingSession,
						`⚠️ Runner ${env.executionId}（${preExistingSession.issue_id}）报告 ship attempt 失败/停滞；会话保持 approved_to_ship，founder 批准仍有效。请检查 PR #${preExistingSession.pr_number ?? "unknown"} 的 ship workflow；诊断后重试前先重新运行 verify-approval。${retryPosture}`,
					);
				}
				console.warn(
					`[DirectEventSink] FLY-1505 ship_attempt_failed deflected for ${env.executionId} — approved_to_ship preserved (${settle.outcome})`,
				);
				return;
			}
			if (route === "ship_attempt_failed") {
				console.warn(
					`[DirectEventSink] ignoring ship_attempt_failed for non-approved session ${env.executionId} (status=${preExistingSession?.status ?? "missing"})`,
				);
				return;
			}
			status = "blocked";
		} else if (route === "no_code" || route === "pr_handoff") {
			// FLY-222 #1: no-code/no-merge clean success → terminal completed.
			// Sister branch: event-route.ts. evidenceGap stays false (not an
			// approved_to_ship merge-evidence gap); runPostShipFinalization is
			// gated on merged landing so it cannot fire for a no-merge completion.
			//
			// FLY-493 (Codex R3 #2): pr_handoff gets an EXPLICIT branch — it must
			// NOT fall through to the unknown-route `else` below, which would let a
			// pr_handoff for a non-running session clear review-gated state. The
			// running-only guard above already returns early for non-running, but
			// the explicit branch keeps the contract unambiguous.
			status = "completed";
		} else if (desMergedLanding) {
			// FLY-869 B: natural (:cool:) completion WITH a merged landing must also
			// pass the ship-eligibility gate (design R2 HIGH-3 — every merged→completed
			// surface). A legit approved+shipped session is eligible; an unapproved /
			// QA-unpassed merge is parked.
			status = desShipEligible ? "completed" : desParkUnapprovedMerge();
		} else {
			status = "completed";
			// FLY-208 5a: natural completion (no route) from approved_to_ship
			// without merge proof — mark the gap (FLY-210 finishes cleanup).
			if (isPostApproveShip && landingStatus?.status !== "merged") {
				evidenceGap = true;
			}
		}

		// FLY-222 #1 / FLY-228 (Codex-routed Finding K / I): a session already in a
		// NO-OUT-EDGE terminal state (completed / terminated / shelved / approved)
		// must NOT be touched by ANY subsequent completion — neither a
		// status-CHANGING one (e.g. a spurious route=`blocked` re-emission after a
		// Lead closes a parked-alive `no_code` Runner → would flip
		// `completed`→`blocked`) NOR a SAME-status duplicate (`completed`→
		// `completed`, which would otherwise overwrite decision_route/evidence and
		// double-notify). The HTTP /events sink is already protected: it routes
		// through `applyTransition`, which rejects EVERY edge out of a no-out-edge
		// terminal state (including `completed`→`completed`). This in-process sink
		// uses `upsertSession` (no FSM edge check), so mirror that rejection
		// explicitly and fully ignore (no status write, no metadata/decision_route
		// overwrite, no notification). The FIRST legitimate completion is
		// unaffected — at that point the pre-existing status is `running` (or
		// another out-edged state), so the guard does not fire. Re-finalization /
		// evidence-gap backfill (FLY-208/210) does NOT go through this path (it uses
		// patchSessionMetadata / markEvidenceGapCompletion), so it is unaffected.
		if (
			preExistingSession &&
			isNoOutEdgeTerminalStatus(preExistingSession.status)
		) {
			console.warn(
				`[DirectEventSink] ignoring duplicate/spurious "${status}" completion for already-terminal ${env.executionId} ` +
					`(status="${preExistingSession.status}", route="${route ?? "none"}") — terminal-immune (FLY-228 Finding K)`,
			);
			return;
		}

		const prNumber = result.evidence?.landingStatus?.prNumber;

		// GEO-292: Auto-infer stage from landing status
		let inferredStage: string | undefined;
		if (prNumber) {
			const landingStatusValue = (
				result.evidence?.landingStatus as { status?: string } | undefined
			)?.status;
			inferredStage = landingStatusValue === "merged" ? "ship" : "pr_created";
		}

		// FLY-191 Phase 2 (Codex R4 CRITICAL + R5 HIGH): a Phase-2-bound
		// session's status/binding/window are owned by the HTTP
		// `complete --question-id` path. Computed BEFORE upsertSession (R5):
		// a late qid-less needs_review emission landing AFTER approval would
		// otherwise drag approved_to_ship back to awaiting_review (upsertSession
		// has no FSM guard for that edge) and re-stamp the review window via
		// the entry-stamp logic — leaving verify-approval fail-closed on
		// status mismatch until a manual re-approve.
		const phase2Bound = desPhase2Bound;
		const evidenceOnly =
			status === "awaiting_review" &&
			phase2Bound &&
			preExistingSession !== undefined &&
			preExistingSession.status !== "awaiting_review";

		if (evidenceOnly) {
			// No status write, no entry stamp — metadata/evidence only.
			this.store.patchSessionMetadata(env.executionId, {
				last_activity_at: now,
				decision_route: route,
				decision_reasoning: result.decision?.reasoning,
				commit_count: result.evidence?.commitCount,
				files_changed: result.evidence?.filesChangedCount,
				lines_added: result.evidence?.linesAdded,
				lines_removed: result.evidence?.linesRemoved,
				summary,
				diff_summary: result.evidence?.diffSummary,
				commit_messages: result.evidence?.commitMessages?.join("\n"),
				changed_file_paths: result.evidence?.changedFilePaths?.join("\n"),
				issue_identifier: env.issueIdentifier || undefined,
				issue_title: env.issueTitle,
				pr_number: prNumber,
				// FLY-793: never downgrade a dispatched phase role (sister of the
				// event-route completion guard) — env.sessionRole is durable here,
				// but keep the invariant explicit + symmetric across sinks.
				session_role: resolveCompletionSessionRole(
					preExistingSession?.session_role,
					env.sessionRole,
				),
			});
			console.warn(
				`[DirectEventSink] qid-less needs_review for Phase-2-bound ${env.executionId} while status="${preExistingSession?.status}" — evidence-only (status/binding/window owned by the HTTP binding path)`,
			);
		} else {
			this.store.upsertSession({
				execution_id: env.executionId,
				issue_id: env.issueId,
				project_name: env.projectName,
				status,
				last_activity_at: now,
				decision_route: route,
				decision_reasoning: result.decision?.reasoning,
				commit_count: result.evidence?.commitCount,
				files_changed: result.evidence?.filesChangedCount,
				lines_added: result.evidence?.linesAdded,
				lines_removed: result.evidence?.linesRemoved,
				summary,
				diff_summary: result.evidence?.diffSummary,
				commit_messages: result.evidence?.commitMessages?.join("\n"),
				changed_file_paths: result.evidence?.changedFilePaths?.join("\n"),
				// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
				issue_identifier: env.issueIdentifier || undefined,
				issue_title: env.issueTitle,
				pr_number: prNumber,
				// FLY-793: preserve a dispatched phase role on completion (sister of
				// the event-route completion guard; byte-compat for non-phase roles).
				session_role: resolveCompletionSessionRole(
					preExistingSession?.session_role,
					env.sessionRole,
				),
				workflow_node_id: workflowNodeId,
			});
		}
		if (!evidenceOnly && status === "blocked") {
			this.enqueueTerminalCommDbStatus(
				env.executionId,
				"blocked",
				env.projectName,
			);
		}

		// FLY-208 5a: evidence-gap completion — persist the marker (FLY-210
		// consumes it) and warn loudly. Sister write: event-route.ts.
		if (evidenceGap && !evidenceOnly) {
			markEvidenceGapCompletion(this.store, env.executionId, {
				route,
				landingStatus: landingStatus?.status,
			});
			console.warn(
				`[DirectEventSink] FLY-208 evidence-gap completion for ${env.executionId}: ` +
					`approved_to_ship + route=${route} but landing=${landingStatus?.status ?? "(none)"} — ` +
					`completed WITHOUT merge evidence; post-ship finalization suppressed (FLY-210 owns later cleanup)`,
			);
		}

		// GEO-202: Post-upsert backfill — if session still has no identifier, fall back to issueId
		{
			const postSession = this.store.getSession(env.executionId);
			if (postSession && !postSession.issue_identifier) {
				this.store.patchSessionMetadata(env.executionId, {
					issue_identifier: env.issueId,
				});
			}
		}

		// FLY-907: completion status landed via upsertSession (bypasses the
		// applyTransition onTransition hook) — trigger the display refresh here.
		this.notifyDisplayChanged(env.issueId);

		// FLY-123 (Codex design review R1 #4): persist adapter session-resume
		// params (e.g. Codex threadId). MERGE-patch, never replace — proofshot
		// state (GEO-151 `proofshot.*`, `last_artifact`) lives under the same
		// session_params JSON and must not be clobbered.
		if (result.sessionParams && Object.keys(result.sessionParams).length > 0) {
			try {
				const existing = this.store.getSessionParams(env.executionId) ?? {};
				this.store.setSessionParams(env.executionId, {
					...existing,
					...result.sessionParams,
				});
			} catch (err) {
				console.warn(
					`[DirectEventSink] sessionParams persist failed for ${env.executionId}: ${(err as Error).message}`,
				);
			}
		}

		// FLY-191 Phase 2 (§5.5.2; Codex R2 HIGH-1 scoping + R4 CRITICAL): this
		// in-process sink is the LEGACY headless path — it has no gate
		// questionId source, so it must NEVER touch a Phase-2 review binding
		// in ANY part (the questionId AND the pr_head_sha are one atomic pair
		// owned by the HTTP `complete --question-id` path). R4 attack shape:
		// session bound to Q1+headA; a qid-less in-process emission carrying
		// headB would otherwise patch pr_head_sha=B while the binding stays
		// Q1 — letting Q1's (old) approval authorize the NEW head B through
		// verify-approval. So: any existing Phase-2 binding (real id OR the
		// UNBOUND sentinel) → evidence-only here, no sha write, no window
		// reset (no deadline drift from duplicate emissions). Pure-legacy
		// sessions (binding NULL — setReviewBinding never ran) keep the old
		// behavior: contribute pr_head_sha when valid + reset the window on
		// re-review.
		if (status === "awaiting_review" && !phase2Bound) {
			const headShaRaw = result.evidence?.headSha?.toLowerCase();
			if (headShaRaw && /^[0-9a-f]{40}$/.test(headShaRaw)) {
				this.store.patchSessionMetadata(env.executionId, {
					pr_head_sha: headShaRaw,
				});
			}
		}

		// FLY-191 Phase 2: review RE-REQUEST parity with event-route — a fresh
		// needs_review completion while already awaiting_review resets the
		// review window (upsertSession's entry-stamp deliberately ignores
		// same-status writes, so reset explicitly here). Phase-2-bound
		// sessions are excluded (R4): their window is owned by the HTTP
		// binding path; a qid-less duplicate must not extend the deadline.
		if (
			status === "awaiting_review" &&
			preExistingSession?.status === "awaiting_review" &&
			route === "needs_review" &&
			!phase2Bound
		) {
			this.store.resetAwaitingReviewWindow(env.executionId);
		}

		// GEO-292: Stage auto-inference (only advance, never regress)
		if (inferredStage) {
			const currentSession = this.store.getSession(env.executionId);
			const currentOrder =
				STAGE_ORDER[currentSession?.session_stage ?? ""] ?? -1;
			const inferredOrder = STAGE_ORDER[inferredStage] ?? -1;
			if (inferredOrder > currentOrder) {
				this.store.patchSessionMetadata(env.executionId, {
					session_stage: inferredStage,
					stage_updated_at: now,
				});
			}
		}

		// FLY-579 (Codex R1 HIGH-1): this in-process completed path is a
		// production / dual-sink emitter — it must drive auto-QA and suppress the
		// founder review-required delivery exactly like the HTTP /events route, or
		// a held founder gate leaks here. onMainAwaitingReview is idempotent
		// (atomic record claim) so a concurrent event-route claim is a no-op.
		if (
			status === "awaiting_review" &&
			(env.sessionRole ?? "main") === "main" &&
			this.autoQaCoordinator?.current
		) {
			const mainSession = this.store.getSession(env.executionId);
			// FLY-869 B: a merged-but-unapproved parked session sits in awaiting_review
			// with a merge_block marker — it MUST NOT drive auto-QA (design R2 HIGH-4
			// suppressor). Recovery (same-head approval) clears the marker + finalizes.
			if (mainSession && !isMergeBlocked(mainSession)) {
				try {
					await this.autoQaCoordinator.current.onMainAwaitingReview(
						mainSession,
						{
							// FLY-752: fresh review-pass (prior status wasn't
							// awaiting_review) vs re-emitted / parked-for-founder.
							freshTransition: preExistingSession?.status !== "awaiting_review",
						},
					);
				} catch (err) {
					console.error(
						`[DirectEventSink] onMainAwaitingReview threw for ${env.executionId}: ${(err as Error).message}`,
					);
				}
			}
		}

		// FLY-921 Fix C: this completion may have terminated the current TURN
		// holder — scoped reconcile (guard 1: only acts when this exec IS the
		// holder). Runs AFTER the handoff so a just-granted TURN is never raced.
		await this.reconcileTurnBeltAfterTerminal(env.executionId);

		// FLY-579 + FLY-827: hold the founder while review-held — suppress the
		// review-required delivery (the 🧪 / ship-ready posts reach the thread via the
		// coordinator's ThreadPoster, not this sink). isReviewHeld is false with no
		// held record AND codex satisfied, so this is byte-compatible when auto-QA is
		// off and the hard gate is off. FLY-827 (R4-HIGH-1): DirectEventSink is the
		// FOURTH founder-surface path — without isReviewHeld a Codex-held session
		// (no auto_qa_record → isQaHeld false) would leak the review-required push.
		if (
			isReviewHeld(this.store, this.store.getSession(env.executionId)) ||
			!this.store.workflowGatePresentationDisposition({
				executionId: env.executionId,
				checkpoint: "approve_to_ship",
			}).allow
		) {
			console.log(
				`[DirectEventSink] suppressing non-authoritative review-required delivery for ${env.executionId}`,
			);
		} else {
			this.pushNotification(env, "session_completed");
		}

		// FLY-102: Post-approve-ship finalization (tmux cleanup → notifier → archive).
		// Gated by predicate so only approve-ship completions (not route=needs_review
		// self-completes) trigger Runner lifecycle teardown. Codex Round 1 (post-Round 4
		// cycle): must also guard on `status === "completed"` — otherwise a ship that
		// lands as `status = "blocked"` (e.g. route=blocked after approved_to_ship)
		// would still trigger tmux teardown / thread archive before ship completes.
		// Must match event-route.ts:482 gate.
		const landingStatusForHook = result.evidence?.landingStatus as
			| { status?: string; prNumber?: number }
			| undefined;
		// FLY-1282 Part C: hoisted — the same predicate gates post-ship
		// finalization below AND excludes this completion from the targeted
		// terminal-archive enqueue (the post-ship owner's cleanup→archive
		// sequence is exclusive).
		const postShipOwned =
			status === "completed" &&
			isPostApproveShipComplete({
				existingStatus: preExistingSession?.status,
				route,
				landingStatus: landingStatusForHook,
				// FLY-869 B: thread the pre-transition decision (a parked session is
				// awaiting_review, not completed, so this is also guarded above).
				shipEligible: desShipEligible,
			});
		if (postShipOwned) {
			this.pending.push(
				runPostShipFinalization(
					{
						executionId: env.executionId,
						runId: this.store.getWorkflowRunIdForExecution(env.executionId),
						...(Number.isInteger(landingStatusForHook?.prNumber) &&
						landingStatusForHook!.prNumber! > 0 &&
						!!desPrHead
							? {
									mergedPr: {
										prNumber: landingStatusForHook!.prNumber!,
										headSha: desPrHead,
									},
								}
							: {}),
						issueId: env.issueId,
						issueIdentifier: env.issueIdentifier,
						projectName: env.projectName,
						sessionStatus: status,
						discordOwnerUserId: this.config.chatThreadsEnabled
							? this.config.discordOwnerUserId
							: undefined,
						fallbackBotToken: this.config.discordBotToken,
					},
					{
						store: this.store,
						projects: this.projects,
						removeCleanWorktree: this.removeCleanWorktree,
						// FLY-887: close the parked design + implement phases before the
						// shared worktree is removed.
						finalizeWorkflowPhaseRoles: this.finalizeWorkflowPhaseRoles,
						// FLY-799: auto-flip the shipped issue to Done (ship-success gated
						// by runPostShipFinalization's merge-evidence predicate).
						markIssueDone: makeLinearDoneFinalizer(this.config),
						// FLY-907: final terminal-state display refresh — awaited inside
						// the orchestrator AFTER phase finalization, BEFORE archive.
						refreshIssueDisplay: (issueId) =>
							this.issueDisplayRefresh?.current?.refresh(issueId) ??
							Promise.resolve(),
						// FLY-1185 entry A: remote branch CAS + issue closeout + sweep.
						...this.lifecycleInfra,
					},
				),
			);
		}

		// FLY-1282 Part C: targeted terminal-archive enqueue. Runs AFTER the
		// phase handoff above so a DAG workflow successor row is durable before
		// the targeted check reads alias state. Fresh getSession confirms the
		// row actually landed completed (a skipped / non-terminal write → zero
		// enqueue). Post-ship (merged) completions and FLY-208 evidence-gap
		// completions never enqueue. Sister call: event-route.ts.
		if (this.terminalArchiveEnqueue && !postShipOwned && !evidenceGap) {
			const freshTerminalRow = this.store.getSession(env.executionId);
			if (freshTerminalRow?.status === "completed") {
				try {
					this.terminalArchiveEnqueue(env.issueId);
				} catch (err) {
					console.error(
						`[DirectEventSink] terminal-archive enqueue threw for ${env.issueId}: ${(err as Error).message}`,
					);
				}
			}
		}
	}

	async emitFailed(
		env: EventEnvelope,
		error: string,
		_lastActivity?: string,
		failure?: TerminalFailureInfo,
	): Promise<void> {
		const now = sqliteDatetime();
		const goalBlocked = failure?.failureKind === "goal_blocked";
		const terminalStatus = goalBlocked ? "blocked" : "failed";
		const terminalError = goalBlocked ? failure.failureReason : error;
		const workflowNodeId = this.store.resolveWorkflowNodeIdForExecution(
			env.executionId,
		);
		const generalizedExecution =
			this.store.getGeneralizedWorkflowNodeForExecution(env.executionId);
		if (generalizedExecution) {
			const recorded = this.store.recordEnrolledTerminalSignal({
				executionId: env.executionId,
				sourceEventId: randomUUID(),
				signal: "failed",
				failureKind: failure?.failureKind,
				lastError: terminalError,
				source: "direct-event-sink",
				now,
			});
			if (!recorded.ok) {
				console.error(
					`[DirectEventSink] generalized failure persistence refused for ${env.executionId}: ${recorded.reason}`,
				);
				return;
			}
			await this.alertWorktreeTakeoverFailure(env.executionId, failure);
			if (recorded.statusPreserved) {
				console.warn(
					`[DirectEventSink] FLY-1427 terminal-immune: ignored generalized failure overwrite for ${env.executionId}; effective status remains ${recorded.effectiveStatus}`,
				);
				return;
			}
			this.enqueueTerminalCommDbStatus(
				env.executionId,
				recorded.status === "blocked" ? "blocked" : "failed",
				env.projectName,
			);
			return;
		}
		// FLY-793: pre-failure snapshot so a failure signal doesn't downgrade a
		// dispatched phase role (sister of the event-route failed guard).
		const preFailureSession = this.store.getSession(env.executionId);

		this.store.insertEvent({
			event_id: randomUUID(),
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			event_type: "session_failed",
			source: "direct-event-sink",
		});

		this.store.upsertSession({
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			status: terminalStatus,
			last_activity_at: now,
			last_error: terminalError,
			// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
			issue_identifier: env.issueIdentifier || undefined,
			issue_title: env.issueTitle,
			session_role: resolveCompletionSessionRole(
				preFailureSession?.session_role,
				env.sessionRole,
			),
			workflow_node_id: workflowNodeId,
		});
		this.enqueueTerminalCommDbStatus(
			env.executionId,
			terminalStatus,
			env.projectName,
		);
		try {
			await this.autoQaCoordinator?.current?.onQaSessionFailed(env.executionId);
		} catch (err) {
			console.error(
				`[DirectEventSink] auto-QA failure hook threw for ${env.executionId}: ${(err as Error).message}`,
			);
		}

		// GEO-202: Post-upsert backfill — if session still has no identifier, fall back to issueId
		{
			const session = this.store.getSession(env.executionId);
			if (session && !session.issue_identifier) {
				this.store.patchSessionMetadata(env.executionId, {
					issue_identifier: env.issueId,
				});
			}
		}
		await this.alertWorktreeTakeoverFailure(env.executionId, failure);

		// FLY-921 Fix C: session_failed never reaches onPhaseComplete — a killed
		// TURN holder (FLY-543 shape) must still release the belt. Sister call:
		// event-route.ts session_failed path.
		await this.reconcileTurnBeltAfterTerminal(env.executionId);

		// FLY-907: failure status landed via upsertSession (bypasses the
		// applyTransition onTransition hook) — trigger the display refresh here.
		this.notifyDisplayChanged(env.issueId);

		this.pushNotification(env, "session_failed");
	}

	private async alertWorktreeTakeoverFailure(
		executionId: string,
		failure?: TerminalFailureInfo,
	): Promise<void> {
		if (failure?.failureKind !== "worktree_takeover_failed") return;
		const session = this.store.getSession(executionId);
		if (!session) return;
		await this.turnBeltReconciler?.current?.alertWorktreeTakeoverFailure(
			session,
			failure.failureReason,
		);
	}

	/**
	 * FLY-921 Fix C: scoped turn-belt reconcile after a DAG workflow
	 * session hit a terminal signal (completed/failed). Guard 1 lives inside
	 * reconcileTurnBelt (terminalExecId must BE the holder). Never throws.
	 */
	private async reconcileTurnBeltAfterTerminal(
		executionId: string,
	): Promise<void> {
		const reconciler = this.turnBeltReconciler?.current;
		if (!reconciler) return;
		const session = this.store.getSession(executionId);
		if (!session?.project_name) return;
		if (!isWorkflowPhaseRole(session.session_role)) return;
		try {
			await reconciler.reconcileTurnBelt({
				issueId: session.issue_id,
				projectName: session.project_name,
				terminalExecId: executionId,
			});
		} catch (err) {
			console.error(
				`[DirectEventSink] reconcileTurnBelt threw for ${executionId}: ${(err as Error).message}`,
			);
		}
	}

	async emitHeartbeat(env: EventEnvelope): Promise<void> {
		this.store.updateHeartbeat(env.executionId);
	}

	async flush(): Promise<void> {
		await Promise.allSettled(this.pending);
		this.pending = [];
	}

	/**
	 * GEO-151: Persist the effective ProofShot config into
	 * `session_params.proofshot.config` so Bridge event-route handlers can read
	 * it without needing to re-load `.flywheel/config.yaml`.
	 *
	 * Replay-safe: uses `patchSessionParams` (read-modify-write) so a duplicate
	 * or replayed `session_started` event on an execution that already has
	 * `proofshot.runs` (from earlier captures in the same session) does NOT
	 * clobber that run state.
	 *
	 * Only overwrites `proofshot.config`; preserves `proofshot.runs` and
	 * unrelated `session_params` keys (e.g., `last_artifact`).
	 */
	private persistProofShotConfig(executionId: string): void {
		const effective = this.skillsConfig?.proofshot ?? DEFAULT_PROOFSHOT_CONFIG;
		patchSessionParams(this.store, executionId, (cur) => {
			const prior = getProofShotParams(cur);
			return {
				...cur,
				proofshot: {
					...prior,
					config: effective,
				},
			};
		});
	}

	private pushNotification(env: EventEnvelope, eventType: string): void {
		const session = this.store.getSession(env.executionId);
		if (!session) return;

		console.log(
			`[DirectEventSink] pushNotification: exec=${env.executionId} event=${eventType} ` +
				`registry=${!!this.registry} eventFilter=${!!this.eventFilter} ` +
				`status=${session.status}`,
		);

		if (!this.registry) {
			return;
		}

		try {
			const labels = this.store.getSessionLabels(env.executionId);
			const { runtime, lead } = this.registry.resolveWithLead(
				this.projects,
				env.projectName,
				labels,
			);
			const sessionKey = buildSessionKey(session);
			const hookPayload: HookPayload = {
				event_type: eventType,
				execution_id: env.executionId,
				issue_id: env.issueId,
				issue_identifier: session.issue_identifier,
				issue_title: session.issue_title,
				project_name: env.projectName,
				status: session.status,
				decision_route: session.decision_route,
				commit_count: session.commit_count,
				lines_added: session.lines_added,
				lines_removed: session.lines_removed,
				summary: session.summary,
				last_error: session.last_error,
				chat_channel: lead.chatChannel,
				issue_labels: labels,
				session_role: session.session_role ?? "main",
				design_backend: session.design_backend,
			};

			// FLY-91: Fill chat_thread_id for Lead thread routing
			if (this.config.chatThreadsEnabled) {
				hookPayload.chat_thread_id = resolveChatThreadId(
					this.store,
					env.issueId,
					lead.chatChannel,
				);
			}

			const doDeliver = async () => {
				// FLY-47 / FLY-163: Classify event — priority hints (chat-only).
				if (this.eventFilter) {
					const filterResult = this.eventFilter.classify(
						eventType,
						hookPayload,
					);
					hookPayload.filter_priority = filterResult.priority;
					hookPayload.notification_context = filterResult.reason;
				}

				// FLY-47: Always deliver ALL events to Lead
				const eventId = `direct-${env.executionId}-${eventType}-${Date.now()}`;
				const seq = this.store.appendLeadEvent(
					lead.agentId,
					eventId,
					eventType,
					JSON.stringify(hookPayload),
					sessionKey,
				);
				const envelope: LeadEventEnvelope = {
					seq,
					eventId,
					event: hookPayload,
					sessionKey,
					leadId: lead.agentId,
					timestamp: new Date().toISOString(),
				};
				const result = await dispatchLeadEventCompat(
					this.registry!,
					runtime,
					envelope,
				);
				if (result.delivered) this.store.markLeadEventDelivered(seq);
			};

			this.pending.push(
				doDeliver().catch((err) => {
					console.warn(
						`[DirectEventSink] Notification pipeline failed for ${env.executionId}:`,
						(err as Error).message,
					);
				}),
			);
		} catch (err) {
			console.warn(
				`[DirectEventSink] Unknown project "${env.projectName}" — skipping notification:`,
				(err as Error).message,
			);
		}
	}
}
