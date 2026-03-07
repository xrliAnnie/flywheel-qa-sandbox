import { Router } from "express";
import type { StateStore, Session } from "../StateStore.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { BridgeConfig } from "./types.js";
import { approveExecution } from "./actions.js";

interface IngestEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	payload?: Record<string, unknown>;
	source?: string;
}

function sqliteDatetime(): string {
	return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function formatNotification(session: Session, eventType: string): string {
	const id = session.issue_identifier ?? session.issue_id;
	switch (eventType) {
		case "session_completed":
			if (session.decision_route === "auto_approve") {
				return `[Auto-merged] ${id}: ${session.issue_title ?? ""}. ${session.commit_count ?? 0} commits. PR automatically merged by bridge.`;
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

async function notifyAgent(
	gatewayUrl: string,
	hooksToken: string,
	message: string,
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 3000);
	try {
		await fetch(`${gatewayUrl}/hooks/agent`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${hooksToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ agentId: "product-lead", message }),
			signal: controller.signal,
		});
	} catch (err) {
		console.warn("[notify] Failed to push to OpenClaw gateway:", (err as Error).message);
	} finally {
		clearTimeout(timeout);
	}
}

export function createEventRouter(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
): Router {
	const router = Router();

	router.post("/", async (req, res) => {
		const event = req.body as IngestEvent | undefined;
		if (!event || typeof event !== "object") {
			res.status(400).json({ error: "expected JSON object" });
			return;
		}

		// Validate required fields
		const required = ["event_id", "execution_id", "issue_id", "project_name", "event_type"] as const;
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

		if (event.event_type === "session_started") {
			store.upsertSession({
				execution_id: event.execution_id,
				issue_id: event.issue_id,
				project_name: event.project_name,
				status: "running",
				started_at: now,
				last_activity_at: now,
				issue_identifier: payload.issueIdentifier as string | undefined,
				issue_title: payload.issueTitle as string | undefined,
			});
		} else if (event.event_type === "session_completed") {
			const decision = payload.decision as Record<string, unknown> | undefined;
			const evidence = payload.evidence as Record<string, unknown> | undefined;
			const route = decision?.route as string | undefined;

			// auto_approve → write awaiting_review first, then auto-merge
			let status: string;
			if (route === "needs_review") status = "awaiting_review";
			else if (route === "auto_approve") status = "awaiting_review";
			else if (route === "blocked") status = "blocked";
			else status = "completed";

			store.upsertSession({
				execution_id: event.execution_id,
				issue_id: event.issue_id,
				project_name: event.project_name,
				status,
				last_activity_at: now,
				decision_route: route,
				decision_reasoning: decision?.reasoning as string | undefined,
				commit_count: evidence?.commitCount as number | undefined,
				files_changed: evidence?.filesChangedCount as number | undefined,
				lines_added: evidence?.linesAdded as number | undefined,
				lines_removed: evidence?.linesRemoved as number | undefined,
				summary: payload.summary as string | undefined,
				diff_summary: evidence?.diffSummary as string | undefined,
				commit_messages: Array.isArray(evidence?.commitMessages)
					? (evidence.commitMessages as string[]).join("\n")
					: undefined,
				changed_file_paths: Array.isArray(evidence?.changedFilePaths)
					? (evidence.changedFilePaths as string[]).join("\n")
					: undefined,
				issue_identifier: payload.issueIdentifier as string | undefined,
				issue_title: payload.issueTitle as string | undefined,
			});

			// Auto-approve flow: bridge auto-merges
			if (route === "auto_approve") {
				const result = await approveExecution(store, projects, event.execution_id);
				if (!result.success) {
					console.warn(`[event-route] Auto-approve failed for ${event.execution_id}: ${result.message}`);
				}
			}
		} else if (event.event_type === "session_failed") {
			store.upsertSession({
				execution_id: event.execution_id,
				issue_id: event.issue_id,
				project_name: event.project_name,
				status: "failed",
				last_activity_at: now,
				last_error: payload.error as string | undefined,
				issue_identifier: payload.issueIdentifier as string | undefined,
				issue_title: payload.issueTitle as string | undefined,
			});
		}

		// Best-effort notification push
		const session = store.getSession(event.execution_id);
		if (session && config.gatewayUrl && config.hooksToken) {
			const message = formatNotification(session, event.event_type);
			notifyAgent(config.gatewayUrl, config.hooksToken, message).catch(() => {});
		}

		res.json({ ok: true });
	});

	return router;
}

// Export for testing
export { formatNotification, notifyAgent };
