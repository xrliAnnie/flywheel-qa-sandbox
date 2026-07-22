import { randomUUID } from "node:crypto";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import type { StateStore } from "../StateStore.js";

export interface WorkflowRouteReminderAlertSink {
	alert(payload: AlertPayload): Promise<AlertResult>;
}

/**
 * Drain a bounded batch of FLY-1407 route reminders (rejected explicit input or
 * successful generic fallback). Request-level dedup lives in StateStore; each
 * transport attempt has a distinct eventId so a notifier claim from a crashed
 * attempt cannot make the retry look delivered.
 */
export async function drainWorkflowRouteReminders(input: {
	store: StateStore;
	notifier: WorkflowRouteReminderAlertSink;
	owner?: string;
	now?: () => Date;
	maxItems?: number;
	leaseMs?: number;
}): Promise<{ attempted: number; accepted: number; failed: number }> {
	const owner = input.owner ?? `workflow-route-reminder-${randomUUID()}`;
	const now = input.now ?? (() => new Date());
	const maxItems = input.maxItems ?? 20;
	const leaseMs = input.leaseMs ?? 60_000;
	let attempted = 0;
	let accepted = 0;
	let failed = 0;
	for (let index = 0; index < maxItems; index += 1) {
		const claimedAt = now();
		const claim = input.store.claimWorkflowRouteReminder({
			owner,
			now: claimedAt.toISOString(),
			leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs).toISOString(),
		});
		if (!claim) break;
		attempted += 1;
		try {
			const genericFallback = claim.errorCode === "WORK_KIND_DEFAULT_FALLBACK";
			const result = await input.notifier.alert({
				leadId: claim.recipientLeadId,
				projectName: claim.project,
				eventId: claim.eventId,
				eventType: "workflow_route_input_rejected",
				title: genericFallback
					? `${claim.issueId} used generic work-kind fallback`
					: `${claim.issueId} work-kind dispatch rejected`,
				body: genericFallback
					? `No task category was provided, so this dispatch used the generic single-session fallback. Add an explicit category on the next dispatch when a specialized workflow is intended. dedup=${claim.dedupKey}`
					: `Dispatch rejected with ${claim.errorCode}. Correct the explicit input and retry. dedup=${claim.dedupKey} payload=${JSON.stringify(claim.payload)}`,
				severity: "warning",
				sessionKey: claim.issueId,
			});
			const delivered = result.sent === true || result.queued === true;
			input.store.completeWorkflowRouteReminder({
				dedupKey: claim.dedupKey,
				owner,
				attempt: claim.attempt,
				outcome: delivered ? "accepted" : "retry",
				error: delivered ? undefined : JSON.stringify(result),
				now: now().toISOString(),
			});
			if (delivered) accepted += 1;
			else failed += 1;
		} catch (error) {
			input.store.completeWorkflowRouteReminder({
				dedupKey: claim.dedupKey,
				owner,
				attempt: claim.attempt,
				outcome: "retry",
				error: error instanceof Error ? error.message : String(error),
				now: now().toISOString(),
			});
			failed += 1;
		}
	}
	return { attempted, accepted, failed };
}
