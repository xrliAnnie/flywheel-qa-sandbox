/**
 * GEO-168: DirectEventSink — bridge-local ExecutionEventEmitter that writes
 * directly to StateStore instead of HTTP self-post. Mirrors event-route.ts logic.
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_PROOFSHOT_CONFIG, type SkillsConfig } from "flywheel-config";
import type {
	EventEnvelope,
	ExecutionEventEmitter,
} from "flywheel-edge-worker";
import type { BlueprintResult } from "flywheel-edge-worker/dist/Blueprint.js";
import type { ChatThreadCreator } from "./bridge/ChatThreadCreator.js";
import { resolveChatThreadId } from "./bridge/chat-thread-utils.js";
import type { EventFilter } from "./bridge/EventFilter.js";
import { buildSessionKey, type HookPayload } from "./bridge/hook-payload.js";
import type { LeadEventEnvelope } from "./bridge/lead-runtime.js";
import {
	isPostApproveShipComplete,
	runPostShipFinalization,
} from "./bridge/post-ship-finalization.js";
import {
	getProofShotParams,
	patchSessionParams,
} from "./bridge/proofshot-session.js";
import type { RuntimeRegistry } from "./bridge/runtime-registry.js";
import { STAGE_ORDER } from "./bridge/stage-utils.js";
import type { BridgeConfig } from "./bridge/types.js";
import { type ProjectEntry, resolveLeadForIssue } from "./ProjectConfig.js";
import type { StateStore } from "./StateStore.js";

function sqliteDatetime(): string {
	return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export class DirectEventSink implements ExecutionEventEmitter {
	private pending: Promise<void>[] = [];

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
			started_at: now,
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
		});

		// GEO-151: Persist effective proofshot config into session_params so
		// Bridge event-route handlers can read it without re-loading config.
		// Uses patchSessionParams (read-modify-write) so a replayed session_started
		// event does NOT clobber existing `proofshot.runs` or `last_artifact`
		// state from prior captures in the same execution (Bridge restart safety).
		this.persistProofShotConfig(env.executionId);

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
							botToken,
							leadId: ctLead.agentId,
							ownerUserId: this.config.discordOwnerUserId,
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
			return;
		}
		this.store.patchSessionMetadata(env.executionId, {
			worktree_path: worktreePath,
		});
	}

	async emitCompleted(
		env: EventEnvelope,
		result: BlueprintResult,
		summary?: string,
	): Promise<void> {
		const now = sqliteDatetime();

		this.store.insertEvent({
			event_id: randomUUID(),
			execution_id: env.executionId,
			issue_id: env.issueId,
			project_name: env.projectName,
			event_type: "session_completed",
			source: "direct-event-sink",
		});

		// Status mapping (aligned with event-route.ts)
		const route = result.decision?.route;
		const landingStatus = result.evidence?.landingStatus as
			| { status?: string }
			| undefined;
		let status: string;
		if (route === "needs_review") {
			// FLY-115 v1.24.5 (FLY-120): if the Runner already finished shipping
			// (Lead unblocked the approve_to_ship gate via flywheel-comm respond,
			// then the Runner self-merged), short-circuit to "completed". The
			// previous mapping forced status back to "awaiting_review" even when
			// landingStatus.status === "merged", leaving Lead telling Annie a PR
			// already on main was still waiting for :cool:. Mirrors the
			// auto_approve+merged branch and the post-approve-ship completion
			// guard at packages/teamlead/src/bridge/event-route.ts:344-354.
			status =
				landingStatus?.status === "merged" ? "completed" : "awaiting_review";
		} else if (route === "auto_approve") {
			// FLY-58: merged → completed (not approved)
			status =
				landingStatus?.status === "merged" ? "completed" : "awaiting_review";
		} else if (route === "blocked") status = "blocked";
		else status = "completed";

		const prNumber = result.evidence?.landingStatus?.prNumber;

		// GEO-292: Auto-infer stage from landing status
		let inferredStage: string | undefined;
		if (prNumber) {
			const landingStatusValue = (
				result.evidence?.landingStatus as { status?: string } | undefined
			)?.status;
			inferredStage = landingStatusValue === "merged" ? "ship" : "pr_created";
		}

		// FLY-102: capture existing status BEFORE upsertSession writes the new one.
		// isPostApproveShipComplete needs to see approved_to_ship → completed transition.
		const preExistingSession = this.store.getSession(env.executionId);

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
			session_role: env.sessionRole ?? "main",
		});

		// GEO-202: Post-upsert backfill — if session still has no identifier, fall back to issueId
		{
			const postSession = this.store.getSession(env.executionId);
			if (postSession && !postSession.issue_identifier) {
				this.store.patchSessionMetadata(env.executionId, {
					issue_identifier: env.issueId,
				});
			}
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

		this.pushNotification(env, "session_completed");

		// FLY-102: Post-approve-ship finalization (tmux cleanup → notifier → archive).
		// Gated by predicate so only approve-ship completions (not route=needs_review
		// self-completes) trigger Runner lifecycle teardown. Codex Round 1 (post-Round 4
		// cycle): must also guard on `status === "completed"` — otherwise a ship that
		// lands as `status = "blocked"` (e.g. route=blocked after approved_to_ship)
		// would still trigger tmux teardown / thread archive before ship completes.
		// Must match event-route.ts:482 gate.
		const landingStatusForHook = result.evidence?.landingStatus as
			| { status?: string }
			| undefined;
		if (
			status === "completed" &&
			isPostApproveShipComplete({
				existingStatus: preExistingSession?.status,
				route,
				landingStatus: landingStatusForHook,
			})
		) {
			this.pending.push(
				runPostShipFinalization(
					{
						executionId: env.executionId,
						issueId: env.issueId,
						issueIdentifier: env.issueIdentifier,
						projectName: env.projectName,
						sessionStatus: status,
						discordOwnerUserId: this.config.chatThreadsEnabled
							? this.config.discordOwnerUserId
							: undefined,
						fallbackBotToken: this.config.discordBotToken,
					},
					{ store: this.store, projects: this.projects },
				),
			);
		}
	}

	async emitFailed(
		env: EventEnvelope,
		error: string,
		_lastActivity?: string,
	): Promise<void> {
		const now = sqliteDatetime();

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
			status: "failed",
			last_activity_at: now,
			last_error: error,
			// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
			issue_identifier: env.issueIdentifier || undefined,
			issue_title: env.issueTitle,
			session_role: env.sessionRole ?? "main",
		});

		// GEO-202: Post-upsert backfill — if session still has no identifier, fall back to issueId
		{
			const session = this.store.getSession(env.executionId);
			if (session && !session.issue_identifier) {
				this.store.patchSessionMetadata(env.executionId, {
					issue_identifier: env.issueId,
				});
			}
		}

		this.pushNotification(env, "session_failed");
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
					event: hookPayload,
					sessionKey,
					leadId: lead.agentId,
					timestamp: new Date().toISOString(),
				};
				await runtime.deliver(envelope);
				this.store.markLeadEventDelivered(seq);
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
