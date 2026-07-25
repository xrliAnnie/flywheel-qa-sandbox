import type {
	FounderDecisionConvergenceRow,
	StateStore,
} from "../StateStore.js";

export interface FounderDecisionConvergencePassDeps {
	store: Pick<
		StateStore,
		| "listFounderDecisionConvergence"
		| "resolveFounderDecisionConvergence"
		| "claimOverdueFounderDecisionAlerts"
		| "releaseFounderDecisionAlertClaim"
		| "markFounderDecisionAlertDelivered"
	>;
	resolve(
		row: FounderDecisionConvergenceRow,
	): Promise<string | null> | string | null;
	notifyDropped(row: FounderDecisionConvergenceRow): Promise<boolean> | boolean;
	now?: () => number;
	logger?: (message: string) => void;
}

export async function recordFounderDecisionAck(input: {
	react(): Promise<{ ok: boolean; status?: number }>;
	recordAudit(
		eventType: "founder_ack_reacted" | "founder_ack_failed",
		payload: {
			emoji: "❓";
			outcome: "dropped";
			status?: number;
		},
	): void;
}): Promise<void> {
	const result = await input.react();
	input.recordAudit(result.ok ? "founder_ack_reacted" : "founder_ack_failed", {
		emoji: "❓",
		outcome: "dropped",
		...(result.status ? { status: result.status } : {}),
	});
}

/**
 * FLY-1448 C: convergence rides an existing GatePoller cadence. Resolution is
 * per question; only a durably-classified approve/reject can be claimed for a
 * fail-loud alert. Ordinary founder chat remains audit-only.
 */
export async function runFounderDecisionConvergencePass(
	deps: FounderDecisionConvergencePassDeps,
): Promise<{ resolved: number; alerted: number; retried: number }> {
	const nowMs = (deps.now ?? Date.now)();
	let resolved = 0;
	let alerted = 0;
	let retried = 0;

	for (const row of deps.store.listFounderDecisionConvergence()) {
		if (row.resolved_at_ms !== null) continue;
		try {
			const resolution = await deps.resolve(row);
			if (!resolution) continue;
			deps.store.resolveFounderDecisionConvergence({
				threadId: row.thread_id,
				msgId: row.msg_id,
				questionId: row.question_id,
				resolution,
				resolvedAtMs: nowMs,
			});
			resolved += 1;
		} catch (error) {
			deps.logger?.(
				`founder decision resolve failed (${row.msg_id}/${row.question_id}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	for (const row of deps.store.claimOverdueFounderDecisionAlerts(nowMs)) {
		try {
			if (await deps.notifyDropped(row)) {
				deps.store.markFounderDecisionAlertDelivered({
					threadId: row.thread_id,
					msgId: row.msg_id,
					questionId: row.question_id,
					expectedAlertClaimedAtMs: nowMs,
					alertedAtMs: nowMs,
				});
				alerted += 1;
				continue;
			}
		} catch (error) {
			deps.logger?.(
				`founder decision alert failed (${row.msg_id}/${row.question_id}): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		deps.store.releaseFounderDecisionAlertClaim({
			threadId: row.thread_id,
			msgId: row.msg_id,
			questionId: row.question_id,
			expectedAlertClaimedAtMs: nowMs,
		});
		retried += 1;
	}

	return { resolved, alerted, retried };
}
