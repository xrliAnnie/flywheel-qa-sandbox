import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import type { CompleteMarkerHeldAlert } from "./complete-marker-reconciler.js";
import { buildSessionKey } from "./hook-payload.js";

export interface ReviewAuthorizationAlertsDeps {
	projects: ProjectEntry[];
	leadAlertNotifier?: {
		alert: (payload: AlertPayload) => Promise<AlertResult>;
	};
	now?: () => number;
	logger?: {
		warn(message: string): void;
		error?(message: string): void;
	};
}

/** Neutral Lead alerts for review/ship authorization failures. */
export class ReviewAuthorizationAlerts {
	constructor(private readonly deps: ReviewAuthorizationAlertsDeps) {}

	private resolveLeadId(session: Session): string | undefined {
		try {
			return resolveLeadForIssue(
				this.deps.projects,
				session.project_name,
				parseLabels(session.issue_labels),
			).lead.agentId;
		} catch {
			return undefined;
		}
	}

	async alertMergeWithoutApproval(
		session: Session,
		reason: string,
	): Promise<void> {
		try {
			if (!this.deps.leadAlertNotifier) {
				this.deps.logger?.error?.(
					`[review-authorization-alerts] merge alert (no alert sink): ${reason}`,
				);
				return;
			}
			const leadId = this.resolveLeadId(session);
			if (!leadId) {
				this.deps.logger?.error?.(
					`[review-authorization-alerts] merge alert (no lead): ${reason}`,
				);
				return;
			}
			await this.deps.leadAlertNotifier.alert({
				leadId,
				projectName: session.project_name,
				eventId: `merge-authorization-held:${session.execution_id}:${this.deps.now?.() ?? Date.now()}`,
				eventType: "auto_qa_stuck",
				title: `Merge authorization held — ${session.issue_identifier ?? session.issue_id}`,
				body: reason,
				severity: "warning",
				sessionKey: buildSessionKey(session),
			});
		} catch (error) {
			this.deps.logger?.warn(
				`[review-authorization-alerts] merge-without-approval alert failed for ${session.issue_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async alertShipAttemptFailed(
		session: Session,
		reason: string,
	): Promise<void> {
		if (!this.deps.leadAlertNotifier) {
			this.deps.logger?.error?.(
				`[review-authorization-alerts] ship attempt failed (no alert sink): ${reason}`,
			);
			throw new Error("ship attempt failed: no alert sink");
		}
		const leadId = this.resolveLeadId(session);
		if (!leadId) {
			this.deps.logger?.error?.(
				`[review-authorization-alerts] ship attempt failed (no lead): ${session.issue_id}`,
			);
			throw new Error("ship attempt failed: no lead");
		}
		const binding = session.review_question_id ?? "unbound";
		const head = session.pr_head_sha?.toLowerCase() ?? "unknown";
		const result = await this.deps.leadAlertNotifier.alert({
			leadId,
			projectName: session.project_name,
			eventId: `ship-attempt-failed:${session.execution_id}:${binding}:${head}`,
			eventType: "ship_attempt_failed",
			title: `Founder-approved ship attempt failed — ${session.issue_identifier ?? session.issue_id}`,
			body: reason,
			severity: "severe",
			sessionKey: buildSessionKey(session),
		});
		if (!durableAlertAccepted(result)) {
			throw new Error(
				`ship attempt alert not accepted: ${JSON.stringify(result)}`,
			);
		}
	}

	/** Live event paths are best-effort; durable marker replay uses the strict method above. */
	async alertShipAttemptFailedBestEffort(
		session: Session,
		reason: string,
	): Promise<void> {
		try {
			await this.alertShipAttemptFailed(session, reason);
		} catch (error) {
			this.deps.logger?.warn(
				`[review-authorization-alerts] ship-attempt alert failed for ${session.issue_id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async alertCompleteMarkerHeld(args: CompleteMarkerHeldAlert): Promise<void> {
		if (!this.deps.leadAlertNotifier) {
			throw new Error("complete-marker alert: no alert sink");
		}
		let leadId: string | undefined;
		try {
			leadId = resolveLeadForIssue(
				this.deps.projects,
				args.projectName,
				args.session ? parseLabels(args.session.issue_labels) : [],
			).lead.agentId;
		} catch {
			// Fail closed below: marker ledger remains pending for replay.
		}
		if (!leadId) throw new Error("complete-marker alert: no lead");
		const result = await this.deps.leadAlertNotifier.alert({
			leadId,
			projectName: args.projectName,
			eventId: args.eventId,
			eventType: "complete_marker_held",
			title:
				args.kind === "engine_invariant"
					? `Workflow completion held — ${args.session?.issue_identifier ?? args.issueId}`
					: `Workflow completion replay degraded — ${args.session?.issue_identifier ?? args.issueId}`,
			body: args.reason,
			severity: "severe",
			sessionKey: args.session ? buildSessionKey(args.session) : undefined,
		});
		if (!durableAlertAccepted(result)) {
			throw new Error(
				`complete-marker alert not accepted: ${JSON.stringify(result)}`,
			);
		}
	}
}

function durableAlertAccepted(result: AlertResult): boolean {
	if (result.deadLettered) return false;
	return Boolean(
		result.sent ||
			result.queued ||
			result.dmSent ||
			result.skipped === "duplicate",
	);
}

function parseLabels(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value)
			? value.filter((label): label is string => typeof label === "string")
			: [];
	} catch {
		return [];
	}
}
