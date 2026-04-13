/**
 * GEO-168: DirectEventSink — bridge-local ExecutionEventEmitter that writes
 * directly to StateStore instead of HTTP self-post. Mirrors event-route.ts logic.
 */

import { randomUUID } from "node:crypto";
import type {
	EventEnvelope,
	ExecutionEventEmitter,
} from "flywheel-edge-worker";
import type { BlueprintResult } from "flywheel-edge-worker/dist/Blueprint.js";
import type { ChatThreadCreator } from "./bridge/ChatThreadCreator.js";
import {
	archiveChatThread,
	removeUserFromChatThread,
	resolveChatThreadId,
} from "./bridge/chat-thread-utils.js";
import type { EventFilter } from "./bridge/EventFilter.js";
import type { ForumPostCreator } from "./bridge/ForumPostCreator.js";
import {
	type ForumTagUpdater,
	postThreadStatusMessage,
} from "./bridge/ForumTagUpdater.js";
import { buildSessionKey, type HookPayload } from "./bridge/hook-payload.js";
import type { LeadEventEnvelope } from "./bridge/lead-runtime.js";
import type { RuntimeRegistry } from "./bridge/runtime-registry.js";
import { STAGE_ORDER } from "./bridge/stage-utils.js";
import { validateThreadExists } from "./bridge/thread-validator.js";
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
		private forumTagUpdater?: ForumTagUpdater,
		private registry?: RuntimeRegistry,
		private forumPostCreator?: ForumPostCreator,
		private chatThreadCreator?: ChatThreadCreator,
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

		// Thread inheritance (same as event-route.ts)
		const existingThread = this.store.getThreadByIssue(env.issueId);
		if (existingThread) {
			// GEO-200: Validate thread still exists + per-lead bot token (GEO-252)
			let botToken = this.config.discordBotToken;
			if (this.registry) {
				try {
					const labels = this.store.getSessionLabels(env.executionId);
					const { lead } = this.registry.resolveWithLead(
						this.projects,
						env.projectName,
						labels,
					);
					botToken = lead.botToken ?? this.config.discordBotToken;
				} catch {
					// Partial registry (lead not registered yet) — fall back to global token
				}
			}
			let threadValid = true;
			if (botToken) {
				threadValid = await validateThreadExists(
					existingThread.thread_id,
					botToken,
					{
						markDiscordMissing: (id) => this.store.markDiscordMissing(id),
					},
				);
			}
			if (threadValid) {
				this.store.setSessionThreadId(
					env.executionId,
					existingThread.thread_id,
				);
				this.store.clearArchived(existingThread.thread_id);
			}
		}

		// FLY-24: ForumPostCreator — fire-and-forget (preserves EventFilter notification semantics).
		// Must NOT await before pushNotification: if thread_id is set before EventFilter runs,
		// session_started gets classified as "forum_only" instead of "notify_agent", suppressing
		// the Lead notification. Same pattern as event-route.ts:245.
		// The /api/runs/start poll reads store directly, so it picks up thread_id async.
		if (
			!this.store.getSession(env.executionId)?.thread_id &&
			this.forumPostCreator
		) {
			const eventLabels = env.labels ?? [];
			try {
				const { lead: fpLead } = resolveLeadForIssue(
					this.projects,
					env.projectName,
					eventLabels,
				);
				// GEO-275: skip Forum Post creation for leads without forumChannel
				if (fpLead.forumChannel) {
					const botToken = fpLead.botToken ?? this.config.discordBotToken;
					// Resolve issue title: prefer env, fall back to session history
					const resolvedTitle =
						env.issueTitle ??
						this.store.getSessionByIssue(env.issueId)?.issue_title ??
						undefined;
					this.forumPostCreator
						.ensureForumPost({
							forumChannelId: fpLead.forumChannel,
							issueId: env.issueId,
							issueIdentifier: env.issueIdentifier,
							issueTitle: resolvedTitle,
							executionId: env.executionId,
							status: "running",
							discordBotToken: botToken,
							statusTagMap: fpLead.statusTagMap,
						})
						.then((result) => {
							console.log(
								`[DirectEventSink] ensureForumPost: created=${result.created} threadId=${result.threadId ?? "none"} error=${result.error ?? "none"}`,
							);
						})
						.catch((err: Error) => {
							console.warn(
								`[DirectEventSink] ensureForumPost failed for ${env.issueId}:`,
								err.message,
							);
						});
				}
			} catch (err) {
				console.warn(
					`[DirectEventSink] resolveLeadForIssue threw for project="${env.projectName}" labels=${JSON.stringify(eventLabels)}:`,
					(err as Error).message,
				);
			}
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
		let status: string;
		if (route === "needs_review") status = "awaiting_review";
		else if (route === "auto_approve") {
			// FLY-58: Mirror event-route.ts: merged → completed (not approved)
			const landingStatus = result.evidence?.landingStatus as
				| { status?: string }
				| undefined;
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

		this.pushNotification(env, "session_completed", "running");

		// FLY-91: Remove owner + archive chat thread on terminal status
		if (status === "completed") {
			this.removeOwnerFromChatThread(env);
			this.archiveChatThread(env);
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

		this.pushNotification(env, "session_failed", "running");
	}

	async emitHeartbeat(env: EventEnvelope): Promise<void> {
		this.store.updateHeartbeat(env.executionId);
	}

	async flush(): Promise<void> {
		await Promise.allSettled(this.pending);
		this.pending = [];
	}

	/**
	 * FLY-91: Remove owner from chat thread membership on terminal states.
	 * This clears the thread from Annie's Discord sidebar.
	 * Fire-and-forget — failures are logged but don't block.
	 */
	private removeOwnerFromChatThread(env: EventEnvelope): void {
		if (!this.config.chatThreadsEnabled || !this.config.discordOwnerUserId)
			return;

		try {
			const labels = this.store.getSessionLabels(env.executionId);
			const { lead } = resolveLeadForIssue(
				this.projects,
				env.projectName,
				labels,
			);
			if (!lead.chatChannel) return;

			const botToken = lead.botToken ?? this.config.discordBotToken;
			if (!botToken) return;

			const chatThread = this.store.getChatThreadByIssue(
				env.issueId,
				lead.chatChannel,
			);
			if (!chatThread) return;

			removeUserFromChatThread(
				chatThread.thread_id,
				this.config.discordOwnerUserId,
				botToken,
			).catch((err) =>
				console.warn(
					`[DirectEventSink] removeOwnerFromChatThread failed:`,
					(err as Error).message,
				),
			);
		} catch (err) {
			console.warn(
				`[DirectEventSink] removeOwnerFromChatThread error:`,
				(err as Error).message,
			);
		}
	}

	/**
	 * FLY-91: Archive chat thread on completed/merged.
	 * Archived threads disappear from sidebar. If Annie replies later,
	 * Discord auto-unarchives. Fire-and-forget.
	 */
	private archiveChatThread(env: EventEnvelope): void {
		if (!this.config.chatThreadsEnabled) return;

		try {
			const labels = this.store.getSessionLabels(env.executionId);
			const { lead } = resolveLeadForIssue(
				this.projects,
				env.projectName,
				labels,
			);
			if (!lead.chatChannel) return;

			const botToken = lead.botToken ?? this.config.discordBotToken;
			if (!botToken) return;

			const chatThread = this.store.getChatThreadByIssue(
				env.issueId,
				lead.chatChannel,
			);
			if (!chatThread) return;

			archiveChatThread(chatThread.thread_id, botToken).catch((err) =>
				console.warn(
					`[DirectEventSink] archiveChatThread failed:`,
					(err as Error).message,
				),
			);
		} catch (err) {
			console.warn(
				`[DirectEventSink] archiveChatThread error:`,
				(err as Error).message,
			);
		}
	}

	private pushNotification(
		env: EventEnvelope,
		eventType: string,
		previousStatus?: string,
	): void {
		const session = this.store.getSession(env.executionId);
		if (!session) return;

		// FLY-24 debug: trace tag update prerequisites
		console.log(
			`[DirectEventSink] pushNotification: exec=${env.executionId} event=${eventType} ` +
				`registry=${!!this.registry} eventFilter=${!!this.eventFilter} ` +
				`tagUpdater=${!!this.forumTagUpdater} threadId=${session.thread_id ?? "none"} ` +
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
			const existingThread = this.store.getThreadByIssue(env.issueId);
			const forumChannel = existingThread?.channel ?? lead.forumChannel;
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
				thread_id: session.thread_id,
				forum_channel: forumChannel,
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
				// FLY-47: Classify event — priority hints + Forum gating
				let updateForum = true; // default: update Forum when no filter
				if (this.eventFilter) {
					const filterResult = this.eventFilter.classify(
						eventType,
						hookPayload,
					);
					hookPayload.filter_priority = filterResult.priority;
					hookPayload.notification_context = filterResult.reason;
					updateForum = filterResult.updateForum;
				}

				// Forum tag update — only for status-changing events
				let tagResult: HookPayload["forum_tag_update_result"];
				if (updateForum && this.forumTagUpdater) {
					// FLY-24 Bug 2: Re-read session to get latest thread_id.
					const freshSession = this.store.getSession(env.executionId);
					const freshThreadId = freshSession?.thread_id ?? session.thread_id;
					const tagStatus = freshSession?.status ?? session.status ?? "";
					console.log(
						`[DirectEventSink] updateTag: exec=${env.executionId} threadId=${freshThreadId ?? "none"} ` +
							`status=${tagStatus} event=${eventType} lead=${lead.agentId} ` +
							`botToken=${(lead.botToken ?? this.config.discordBotToken) ? "set" : "MISSING"} ` +
							`statusTagMap=${lead.statusTagMap ? JSON.stringify(Object.keys(lead.statusTagMap)) : "none(using-global)"}`,
					);
					tagResult = await this.forumTagUpdater.updateTag({
						threadId: freshThreadId,
						status: tagStatus,
						eventType,
						discordBotToken: lead.botToken ?? this.config.discordBotToken,
						statusTagMap: lead.statusTagMap,
					});
					console.log(
						`[DirectEventSink] updateTag result: ${tagResult} for exec=${env.executionId}`,
					);
					// FLY-24: Post status change message to Forum thread
					if (tagResult === "succeeded" && previousStatus) {
						await postThreadStatusMessage({
							threadId: freshThreadId,
							previousStatus,
							newStatus: tagStatus,
							botToken: lead.botToken ?? this.config.discordBotToken,
						});
					}
				}
				hookPayload.forum_tag_update_result = tagResult;

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
