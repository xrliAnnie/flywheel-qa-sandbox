import { Router } from "express";
import type { CipherWriter, SnapshotInputDto } from "flywheel-edge-worker";
import { extractDimensions, generatePatternKeys } from "flywheel-edge-worker";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type { EventFilter } from "./EventFilter.js";
import type { ForumPostCreator } from "./ForumPostCreator.js";
import type { ForumTagUpdater } from "./ForumTagUpdater.js";
import { buildSessionKey, type HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";

interface IngestEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	payload?: Record<string, unknown>;
	source?: string;
}

/** Coerce a value to string or undefined — prevents non-string payload fields from crashing upsertSession. */
function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** Coerce a value to number or undefined. */
function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function formatNotification(session: Session, eventType: string): string {
	const id = session.issue_identifier ?? session.issue_id;
	switch (eventType) {
		case "session_completed":
			if (session.decision_route === "auto_approve") {
				if (session.status === "approved") {
					return `[Already Merged] ${id}: ${session.issue_title ?? ""}. PR was already merged.`;
				}
				return `[Review Required] ${id}: ${session.issue_title ?? ""}. ${session.commit_count ?? 0} commits. Awaiting CEO approval.`;
			}
			if (session.decision_route === "needs_review") {
				return `[Review Required] ${id}: ${session.issue_title ?? ""}. ${session.commit_count ?? 0} commits, +${session.lines_added ?? 0}/-${session.lines_removed ?? 0} lines. Please review.`;
			}
			if (session.decision_route === "blocked") {
				return `[Blocked] ${id}: ${session.issue_title ?? ""}. Reason: ${session.decision_reasoning ?? "unknown"}`;
			}
			return `[Completed] ${id}: ${session.issue_title ?? ""}`;
		case "session_failed":
			return `[Failed] ${id}: ${session.issue_title ?? ""}. Error: ${session.last_error ?? "unknown"}`;
		case "session_started":
			return `[Started] ${id}: ${session.issue_title ?? ""}`;
		default:
			return `[${eventType}] ${id}`;
	}
}

export function createEventRouter(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
	cipherWriter?: CipherWriter,
	transitionOpts?: ApplyTransitionOpts,
	eventFilter?: EventFilter,
	forumTagUpdater?: ForumTagUpdater,
	registry?: RuntimeRegistry,
	forumPostCreator?: ForumPostCreator,
): Router {
	const router = Router();

	// Dedicated heartbeat route — lightweight, no session_events write, no OpenClaw notification
	router.post("/heartbeat", (req, res) => {
		const body = req.body as { execution_id?: string } | undefined;
		if (
			!body ||
			typeof body.execution_id !== "string" ||
			body.execution_id.length === 0
		) {
			res.status(400).json({ error: "missing or invalid field: execution_id" });
			return;
		}
		store.updateHeartbeat(body.execution_id);
		res.json({ ok: true });
	});

	router.post("/", async (req, res) => {
		const event = req.body as IngestEvent | undefined;
		if (!event || typeof event !== "object") {
			res.status(400).json({ error: "expected JSON object" });
			return;
		}

		// Validate required fields
		const required = [
			"event_id",
			"execution_id",
			"issue_id",
			"project_name",
			"event_type",
		] as const;
		for (const field of required) {
			if (typeof event[field] !== "string" || event[field].length === 0) {
				res.status(400).json({ error: `missing or invalid field: ${field}` });
				return;
			}
		}

		// Store event (idempotent)
		const isNew = store.insertEvent({
			event_id: event.event_id,
			execution_id: event.execution_id,
			issue_id: event.issue_id,
			project_name: event.project_name,
			event_type: event.event_type,
			payload: event.payload,
			source: typeof event.source === "string" ? event.source : "orchestrator",
		});

		if (!isNew) {
			res.json({ ok: true, duplicate: true });
			return;
		}

		// Update session read model
		const now = sqliteDatetime();
		const payload = event.payload ?? {};
		let transitionRejected = false;

		try {
			const ctx = {
				executionId: event.execution_id,
				issueId: event.issue_id,
				projectName: event.project_name,
				trigger: event.event_type,
			};

			if (event.event_type === "session_started") {
				// GEO-152: store issue labels for multi-lead routing
				const eventLabels = Array.isArray(payload.labels)
					? (payload.labels as string[])
					: [];
				const issueLabelsJson =
					eventLabels.length > 0 ? JSON.stringify(eventLabels) : undefined;

				if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						"running",
						ctx,
						{
							started_at: now,
							last_activity_at: now,
							heartbeat_at: now,
							issue_identifier: asString(payload.issueIdentifier),
							issue_title: asString(payload.issueTitle),
							issue_labels: issueLabelsJson,
						},
					);
					if (!result.ok) {
						console.warn(
							`[event-route] FSM rejected ${event.event_type}: ${result.error}`,
						);
						transitionRejected = true;
					}
				} else {
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status: "running",
						started_at: now,
						last_activity_at: now,
						heartbeat_at: now,
						issue_identifier: asString(payload.issueIdentifier),
						issue_title: asString(payload.issueTitle),
						issue_labels: issueLabelsJson,
					});
				}

				if (!transitionRejected) {
					// Inherit existing thread for this issue (retry/reopen reuses thread)
					const existingThread = store.getThreadByIssue(event.issue_id);
					if (existingThread) {
						store.setSessionThreadId(
							event.execution_id,
							existingThread.thread_id,
						);
						store.clearArchived(existingThread.thread_id);
					} else if (forumPostCreator) {
						// GEO-195: Bridge auto-creates Forum Post when no thread exists.
						// Previously only OpenClaw Lead did this; Claude Lead can't (no thread-create).
						const { lead: fpLead } = resolveLeadForIssue(
							projects,
							event.project_name,
							eventLabels,
						);
						forumPostCreator
							.ensureForumPost({
								forumChannelId: fpLead.forumChannel,
								issueId: event.issue_id,
								issueIdentifier: asString(payload.issueIdentifier),
								issueTitle: asString(payload.issueTitle),
								executionId: event.execution_id,
								status: "running",
								discordBotToken: config.discordBotToken,
								statusTagMap: fpLead.statusTagMap,
							})
							.catch((err) => {
								console.warn(
									`[event-route] ForumPostCreator failed for ${event.issue_id}:`,
									(err as Error).message,
								);
							});
					}
				}
			} else if (event.event_type === "session_completed") {
				const decision = payload.decision as
					| Record<string, unknown>
					| undefined;
				const evidence = payload.evidence as
					| Record<string, unknown>
					| undefined;
				const route = asString(decision?.route);

				// Status mapping: all routes → appropriate status
				let status: string;
				if (route === "needs_review") status = "awaiting_review";
				else if (route === "auto_approve") {
					const landingStatus = evidence?.landingStatus as
						| { status?: string }
						| undefined;
					if (landingStatus?.status === "merged") {
						status = "approved";
					} else {
						status = "awaiting_review";
					}
				} else if (route === "blocked") status = "blocked";
				else status = "completed";

				if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						status,
						ctx,
						{
							last_activity_at: now,
							issue_identifier: asString(payload.issueIdentifier),
							issue_title: asString(payload.issueTitle),
						},
					);
					if (!result.ok) {
						console.warn(
							`[event-route] FSM rejected ${event.event_type} → ${status}: ${result.error}`,
						);
						transitionRejected = true;
					} else {
						// Metadata via patchSessionMetadata only on successful transition
						store.patchSessionMetadata(event.execution_id, {
							decision_route: route,
							decision_reasoning: asString(decision?.reasoning),
							commit_count: asNumber(evidence?.commitCount),
							files_changed: asNumber(evidence?.filesChangedCount),
							lines_added: asNumber(evidence?.linesAdded),
							lines_removed: asNumber(evidence?.linesRemoved),
							summary: asString(payload.summary),
							diff_summary: asString(evidence?.diffSummary),
							commit_messages: Array.isArray(evidence?.commitMessages)
								? (evidence.commitMessages as string[]).join("\n")
								: undefined,
							changed_file_paths: Array.isArray(evidence?.changedFilePaths)
								? (evidence.changedFilePaths as string[]).join("\n")
								: undefined,
						});
					}
				} else {
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status,
						last_activity_at: now,
						decision_route: route,
						decision_reasoning: asString(decision?.reasoning),
						commit_count: asNumber(evidence?.commitCount),
						files_changed: asNumber(evidence?.filesChangedCount),
						lines_added: asNumber(evidence?.linesAdded),
						lines_removed: asNumber(evidence?.linesRemoved),
						summary: asString(payload.summary),
						diff_summary: asString(evidence?.diffSummary),
						commit_messages: Array.isArray(evidence?.commitMessages)
							? (evidence.commitMessages as string[]).join("\n")
							: undefined,
						changed_file_paths: Array.isArray(evidence?.changedFilePaths)
							? (evidence.changedFilePaths as string[]).join("\n")
							: undefined,
						issue_identifier: asString(payload.issueIdentifier),
						issue_title: asString(payload.issueTitle),
					});
				}

				// GEO-152: store labels on completed events (not just started)
				if (!transitionRejected) {
					const payloadLabels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: undefined;
					if (payloadLabels && payloadLabels.length > 0) {
						store.patchSessionMetadata(event.execution_id, {
							issue_labels: JSON.stringify(payloadLabels),
						});
					}
				}

				// Auto-approve disabled by policy (v1.0 Phase 2)
				// CEO must approve via Slack before merge. No auto-merge flow.

				// CIPHER Phase A: save snapshot for awaiting_review sessions
				// Skip if FSM rejected the transition (out-of-order/duplicate events)
				if (
					cipherWriter &&
					status === "awaiting_review" &&
					!transitionRejected
				) {
					const labels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: null;
					const changedFilePaths = Array.isArray(evidence?.changedFilePaths)
						? (evidence.changedFilePaths as string[])
						: null;
					const projectId = asString(payload.projectId);

					if (!labels || !changedFilePaths) {
						console.warn(
							`[CIPHER] Skipping snapshot for ${event.execution_id}: missing required fields` +
								` (labels=${!!labels}, paths=${!!changedFilePaths})`,
						);
					} else {
						const snapshotInput: SnapshotInputDto = {
							labels,
							exitReason: asString(payload.exitReason) || "completed",
							changedFilePaths,
							commitCount: asNumber(evidence?.commitCount) ?? 0,
							filesChangedCount: asNumber(evidence?.filesChangedCount) ?? 0,
							linesAdded: asNumber(evidence?.linesAdded) ?? 0,
							linesRemoved: asNumber(evidence?.linesRemoved) ?? 0,
							consecutiveFailures: asNumber(payload.consecutiveFailures) ?? 0,
						};
						const dimensions = extractDimensions(snapshotInput);
						const patternKeys = generatePatternKeys(dimensions);

						try {
							await cipherWriter.saveSnapshot({
								executionId: event.execution_id,
								issueId: event.issue_id,
								issueIdentifier: asString(payload.issueIdentifier) ?? "",
								issueTitle: asString(payload.issueTitle) ?? "",
								projectId: projectId ?? "",
								issueLabels: labels,
								dimensions,
								patternKeys,
								systemRoute: asString(decision?.route) ?? "",
								systemConfidence: asNumber(decision?.confidence) ?? 0,
								decisionSource: asString(decision?.decisionSource) ?? "",
								decisionReasoning: asString(decision?.reasoning),
								commitCount: snapshotInput.commitCount,
								filesChanged: snapshotInput.filesChangedCount,
								linesAdded: snapshotInput.linesAdded,
								linesRemoved: snapshotInput.linesRemoved,
								diffSummary: asString(evidence?.diffSummary),
								commitMessages: Array.isArray(evidence?.commitMessages)
									? (evidence.commitMessages as string[])
									: [],
								changedFilePaths,
								exitReason: snapshotInput.exitReason,
								durationMs: asNumber(evidence?.durationMs) ?? 0,
								consecutiveFailures: snapshotInput.consecutiveFailures,
							});
						} catch (err) {
							console.error(
								`[CIPHER] saveSnapshot failed for ${event.execution_id}:`,
								err,
							);
						}
					}
				}
			} else if (event.event_type === "session_failed") {
				if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						"failed",
						ctx,
						{
							last_activity_at: now,
							last_error: asString(payload.error),
							issue_identifier: asString(payload.issueIdentifier),
							issue_title: asString(payload.issueTitle),
						},
					);
					if (!result.ok) {
						console.warn(
							`[event-route] FSM rejected ${event.event_type}: ${result.error}`,
						);
						transitionRejected = true;
					}
				} else {
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status: "failed",
						last_activity_at: now,
						last_error: asString(payload.error),
						issue_identifier: asString(payload.issueIdentifier),
						issue_title: asString(payload.issueTitle),
					});
				}

				// GEO-152: store labels on failed events (not just started)
				if (!transitionRejected) {
					const payloadLabels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: undefined;
					if (payloadLabels && payloadLabels.length > 0) {
						store.patchSessionMetadata(event.execution_id, {
							issue_labels: JSON.stringify(payloadLabels),
						});
					}
				}
			}
		} catch (err) {
			console.error(
				`[event-route] Session update failed for ${event.execution_id}:`,
				err,
			);
			// Event is already stored — return success with a warning rather than 500
			// so retries don't get stuck on duplicate detection
			res.json({ ok: true, warning: "event stored but session update failed" });
			return;
		}

		// Skip notification when FSM rejected the transition
		if (transitionRejected) {
			res.json({
				ok: true,
				warning:
					"FSM rejected transition — event stored but session not updated",
			});
			return;
		}

		// Best-effort notification push via RuntimeRegistry (GEO-195)
		const session = store.getSession(event.execution_id);
		if (session && registry) {
			try {
				// GEO-152: fallback to payload labels when session labels are empty
				const storedLabels = store.getSessionLabels(event.execution_id);
				const labels =
					storedLabels.length > 0
						? storedLabels
						: Array.isArray(payload.labels)
							? (payload.labels as string[])
							: [];
				const { runtime, lead } = registry.resolveWithLead(
					projects,
					event.project_name,
					labels,
				);
				const existingThread = store.getThreadByIssue(event.issue_id);
				const forumChannel = existingThread?.channel ?? lead.forumChannel;
				const sessionKey = buildSessionKey(session);
				const hookPayload: HookPayload = {
					event_type: event.event_type,
					execution_id: event.execution_id,
					issue_id: event.issue_id,
					issue_identifier: session.issue_identifier,
					issue_title: session.issue_title,
					project_name: event.project_name,
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

				// EventFilter: classify and route (GEO-187)
				if (eventFilter) {
					const filterResult = eventFilter.classify(
						event.event_type,
						hookPayload,
					);

					// Forum tag update (fire-and-forget for both paths)
					let tagResult: HookPayload["forum_tag_update_result"];
					if (forumTagUpdater) {
						tagResult = await forumTagUpdater.updateTag({
							threadId: session.thread_id,
							status: session.status ?? "",
							eventType: event.event_type,
							discordBotToken: config.discordBotToken,
							statusTagMap: lead.statusTagMap,
						});
					}

					if (filterResult.action === "notify_agent") {
						hookPayload.filter_priority = filterResult.priority;
						hookPayload.notification_context = filterResult.reason;
						hookPayload.forum_tag_update_result = tagResult;
						const seq = store.appendLeadEvent(
							lead.agentId,
							event.event_id,
							event.event_type,
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
						runtime
							.deliver(envelope)
							.then(() => store.markLeadEventDelivered(seq))
							.catch(() => {});
					}
					// forum_only and skip: no delivery
				} else {
					// Legacy path: no EventFilter, deliver unconditionally
					const seq = store.appendLeadEvent(
						lead.agentId,
						event.event_id,
						event.event_type,
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
					runtime
						.deliver(envelope)
						.then(() => store.markLeadEventDelivered(seq))
						.catch(() => {});
				}
			} catch (err) {
				console.warn(
					`[event-route] Unknown project "${event.project_name}" — skipping notification:`,
					(err as Error).message,
				);
			}
		}

		res.json({ ok: true });
	});

	return router;
}

// Export for testing
export { formatNotification };
