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
import {
	buildHookBody,
	buildSessionKey,
	type HookPayload,
	notifyAgent,
} from "./bridge/hook-payload.js";
import type { BridgeConfig } from "./bridge/types.js";
import type { StateStore } from "./StateStore.js";

function sqliteDatetime(): string {
	return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export class DirectEventSink implements ExecutionEventEmitter {
	private pending: Promise<void>[] = [];

	constructor(
		private store: StateStore,
		private config: BridgeConfig,
	) {}

	async emitStarted(env: EventEnvelope): Promise<void> {
		const now = sqliteDatetime();

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
			issue_identifier: env.issueIdentifier,
			issue_title: env.issueTitle,
			retry_predecessor: env.retryPredecessor,
			run_attempt: env.runAttempt,
		});

		// Thread inheritance (same as event-route.ts)
		const existingThread = this.store.getThreadByIssue(env.issueId);
		if (existingThread) {
			this.store.setSessionThreadId(env.executionId, existingThread.thread_id);
			this.store.clearArchived(existingThread.thread_id);
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
			issue_identifier: env.issueIdentifier,
			issue_title: env.issueTitle,
		});

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
			issue_identifier: env.issueIdentifier,
			issue_title: env.issueTitle,
		});

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
		if (!this.config.gatewayUrl || !this.config.hooksToken) return;

		const session = this.store.getSession(env.executionId);
		if (!session) return;

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
			channel: this.config.notificationChannel,
		};
		const body = buildHookBody("product-lead", hookPayload, sessionKey);
		const p = notifyAgent(
			this.config.gatewayUrl,
			this.config.hooksToken,
			body,
		).catch(() => {});
		this.pending.push(p);
	}
}
