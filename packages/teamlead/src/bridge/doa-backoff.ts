import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import type { StateStore } from "../StateStore.js";
import { resolveLifecycleRootKey } from "./lifecycle-root-key.js";
import type { DoaBackoffAdmissionFn } from "./run-dispatcher.js";

export const DOA_THRESHOLD_MS = 60_000;
export const DOA_RELEASE_LEASE_MS = 10 * 60_000;

type IssueMutex = <T>(keys: string[], fn: () => Promise<T>) => Promise<T>;

/**
 * Production admission decorator. Identity ambiguity and ledger read failures
 * fail open because this guard is an availability brake, not lifecycle
 * authority; both are loud so operators can repair the reconciliation source.
 */
export function createDoaBackoffAdmission(input: {
	store: StateStore;
	withIssueMutex: IssueMutex;
	now?: () => number;
	log?: (message: string) => void;
}): DoaBackoffAdmissionFn {
	const now = input.now ?? Date.now;
	const log = input.log ?? ((message: string) => console.warn(message));
	return async (request) => {
		const role =
			request.role.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() || "main";
		let resolved: ReturnType<typeof resolveLifecycleRootKey>;
		try {
			resolved = resolveLifecycleRootKey(
				input.store,
				request.issueKey,
				request.issueIdentifier ? [request.issueIdentifier] : [],
			);
		} catch (error) {
			log(
				`[doa-backoff] root reconciliation failed for ${request.projectName}/${request.issueKey}; failing open: ${(error as Error).message}`,
			);
			return { admitted: true, status: "allow", reason: "root_read_failed" };
		}
		if (!resolved.ok) {
			log(
				`[doa-backoff] ${request.projectName}/${request.issueKey} has no unambiguous lifecycle UUID (${resolved.reason}); failing open without an identifier-keyed ledger row`,
			);
			return {
				admitted: true,
				status: "allow",
				reason: resolved.reason,
			};
		}

		try {
			return await input.withIssueMutex(resolved.lockKeys, async () => {
				const decision = input.store.evaluateDoaBackoff({
					projectName: request.projectName,
					lifecycleRootUuid: resolved.rootKey,
					issueKeys: resolved.aliasKeys,
					issueId: request.issueKey,
					role,
					leadId: request.leadId?.trim() || "unknown-lead",
					successorExecutionId: request.executionId,
					nowMs: now(),
					thresholdMs: DOA_THRESHOLD_MS,
					leaseMs: DOA_RELEASE_LEASE_MS,
				});
				if (decision.ok) {
					return { admitted: true, status: decision.status };
				}
				return {
					admitted: false,
					status: decision.status,
					reason: decision.reason,
					...(decision.nextEligibleAtMs !== undefined
						? {
								retryAfterSeconds: Math.max(
									1,
									Math.ceil((decision.nextEligibleAtMs - now()) / 1_000),
								),
							}
						: {}),
				};
			});
		} catch (error) {
			log(
				`[doa-backoff] ledger evaluation failed for ${request.projectName}/${resolved.rootKey}/${role}; failing open: ${(error as Error).message}`,
			);
			return { admitted: true, status: "allow", reason: "ledger_read_failed" };
		}
	};
}

/**
 * Re-drive reservations whose Bridge-local binding was durable before a crash.
 * Closed/cancelled claims release; missing/indeterminate claims stay fenced.
 */
export async function repairDoaBackoffReservations(input: {
	store: StateStore;
	withIssueMutex: IssueMutex;
	log?: (message: string) => void;
}): Promise<void> {
	const log = input.log ?? ((message: string) => console.warn(message));
	for (const reservation of input.store.listDoaBackoffReservations()) {
		const owner = reservation.releaseOwnerExecutionId;
		if (!owner) continue;
		await input.withIssueMutex([reservation.lifecycleRootUuid], async () => {
			const binding = input.store.getWorktreeBinding(owner);
			const claim = input.store.getLaunchClaim(owner);
			if (claim?.state === "closed" || claim?.state === "cancelled") {
				input.store.closeLaunchAndReleaseDoa(owner);
				return;
			}
			if (!binding) return;
			if (!claim) {
				log(
					`[doa-backoff] bound reservation ${owner} has no lifecycle claim; keeping it fenced for operator reconciliation`,
				);
				return;
			}
			const result = input.store.activateLaunchAndSettleDoa(owner);
			if (!result.ok) {
				log(
					`[doa-backoff] reservation repair refused for ${owner}: ${result.reason}`,
				);
			}
		});
	}
}

/** One durable alert id per needs-lead lane; retry only non-durable skips. */
export async function drainDoaBackoffAlerts(input: {
	store: StateStore;
	alert: (payload: AlertPayload) => Promise<AlertResult>;
	now?: () => number;
}): Promise<void> {
	for (const row of input.store.listPendingDoaBackoffAlerts()) {
		const result = await input.alert({
			leadId: row.leadId,
			projectName: row.projectName,
			eventId: row.alertId,
			eventType: "crash_loop",
			title: `Re-dispatch held after ${row.count} immediate failures`,
			body:
				`${row.issueId} role ${row.role} failed within ${DOA_THRESHOLD_MS / 1_000}s ` +
				`${row.count} times across settled successors. Automatic re-dispatch is held; ` +
				"inspect the predecessor cause, then use the authenticated DOA reset endpoint.",
			severity: "severe",
		});
		if (
			result.sent ||
			result.queued ||
			result.deadLettered ||
			result.skipped === "duplicate"
		) {
			input.store.markDoaBackoffAlertDelivered(
				row.alertId,
				(input.now ?? Date.now)(),
			);
		}
	}
}
