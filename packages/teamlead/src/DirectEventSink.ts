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
import type { EventFilter } from "./bridge/EventFilter.js";
import type { ForumPostCreator } from "./bridge/ForumPostCreator.js";
import type { ForumTagUpdater } from "./bridge/ForumTagUpdater.js";
import {
	buildHookBody,
	buildSessionKey,
	type HookPayload,
	notifyAgent,
} from "./bridge/hook-payload.js";
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
					this.forumPostCreator
						.ensureForumPost({
							forumChannelId: fpLead.forumChannel,
							issueId: env.issueId,
							issueIdentifier: env.issueIdentifier,
							issueTitle: env.issueTitle,
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
			// Mirror event-route.ts: merged → approved, otherwise awaiting_review
			const landingStatus = result.evidence?.landingStatus as
				| { status?: string }
				| undefined;
			status =
				landingStatus?.status === "merged" ? "approved" : "awaiting_review";
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

	private pushNotification(env: EventEnvelope, eventType: string): void {
		const session = this.store.getSession(env.executionId);
		if (!session) return;

		// Fallback: when no RuntimeRegistry is available (e.g., retry-runtime path),
		// use the legacy notifyAgent() path directly via BridgeConfig OpenClaw credentials.
		if (!this.registry) {
			if (this.config.gatewayUrl && this.config.hooksToken) {
				const sessionKey = buildSessionKey(session);
				const hookPayload: HookPayload = {
					event_type: eventType,
					execution_id: env.executionId,
					issue_id: env.issueId,
					issue_identifier: session.issue_identifier,
					issue_title: session.issue_title,
					project_name: env.projectName,
					status: session.status,
				};
				const body = buildHookBody(
					this.config.defaultLeadAgentId,
					hookPayload,
					sessionKey,
				);
				this.pending.push(
					notifyAgent(
						this.config.gatewayUrl,
						this.config.hooksToken,
						body,
					).catch(() => {}),
				);
			}
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
			};

			const doDeliver = async () => {
				if (this.eventFilter) {
					const filterResult = this.eventFilter.classify(
						eventType,
						hookPayload,
					);

					let tagResult: HookPayload["forum_tag_update_result"];
					if (this.forumTagUpdater) {
						tagResult = await this.forumTagUpdater.updateTag({
							threadId: session.thread_id,
							status: session.status ?? "",
							eventType,
							discordBotToken: lead.botToken ?? this.config.discordBotToken,
							statusTagMap: lead.statusTagMap,
						});
					}

					if (filterResult.action === "notify_agent") {
						hookPayload.filter_priority = filterResult.priority;
						hookPayload.notification_context = filterResult.reason;
						hookPayload.forum_tag_update_result = tagResult;
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
						// Advisory events — best-effort, mark delivered regardless
						await runtime.deliver(envelope);
						this.store.markLeadEventDelivered(seq);
					}
				} else {
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
					// Advisory events — best-effort, mark delivered regardless
					await runtime.deliver(envelope);
					this.store.markLeadEventDelivered(seq);
				}
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
