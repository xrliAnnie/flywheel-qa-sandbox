import { Router } from "express";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import {
	buildHookBody,
	buildSessionKey,
	type HookPayload,
	notifyAgent,
} from "./hook-payload.js";
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
	_projects: ProjectEntry[],
	config: BridgeConfig,
	_cipherWriter?: unknown,
	transitionOpts?: ApplyTransitionOpts,
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

				// Auto-approve disabled by policy (v1.0 Phase 2)
				// CEO must approve via Slack before merge. No auto-merge flow.
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

		// Best-effort notification push (structured JSON + sessionKey)
		const session = store.getSession(event.execution_id);
		if (session && config.gatewayUrl && config.hooksToken) {
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
				channel: config.notificationChannel,
			};
			const body = buildHookBody("product-lead", hookPayload, sessionKey);
			notifyAgent(config.gatewayUrl, config.hooksToken, body).catch(() => {});
		}

		res.json({ ok: true });
	});

	return router;
}

// Export for testing
export { formatNotification };
