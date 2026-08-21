import { CommDB, type TurnWakeOutboxRow } from "flywheel-comm/db";
import {
	TURN_WAKE_RETRY_AFTER_MS,
	wakeRunnerMailbox,
} from "flywheel-comm/wake";

interface PersistedWakeEnvelope {
	fromAgent: string;
	content: string;
	metadata?: Record<string, unknown>;
}

export async function drainTurnWakeOutbox(input: {
	projectNames: string[];
	commDbPathForProject: (projectName: string) => string;
	wake?: typeof wakeRunnerMailbox;
	nowMs?: number;
	retryAfterMs?: number;
	alertAfterMs?: number;
	leaseMs?: number;
	maxPerProject?: number;
	onReceipt?: (
		row: TurnWakeOutboxRow,
	) => Promise<"projected" | "not_applicable" | "retry">;
	onSecondPushUnacked?: (
		row: TurnWakeOutboxRow,
		projectName: string,
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	canDeliver?: (
		row: TurnWakeOutboxRow,
	) => Promise<{ disposition: "deliver" | "cancel" | "wait"; reason?: string }>;
}): Promise<{ pushed: number; alerts: number; cancelled: number }> {
	const nowMs = input.nowMs ?? Date.now();
	const retryAfterMs = input.retryAfterMs ?? TURN_WAKE_RETRY_AFTER_MS;
	const alertAfterMs = input.alertAfterMs ?? 20 * 60_000;
	const leaseMs = input.leaseMs ?? 30_000;
	const maxPerProject = input.maxPerProject ?? 20;
	const wake = input.wake ?? wakeRunnerMailbox;
	let pushed = 0;
	let alerts = 0;
	let cancelled = 0;

	for (const projectName of input.projectNames) {
		const db = new CommDB(input.commDbPathForProject(projectName));
		try {
			const deferredWakeIds = new Set<string>();
			const failedPointerWakeIds = new Set<string>();
			for (let index = 0; index < maxPerProject; index += 1) {
				const claim = db.claimDueTurnWake({
					nowMs,
					retryAfterMs,
					leaseMs,
					excludeWakeIds: [...deferredWakeIds],
				});
				if (!claim) break;
				if (input.canDeliver) {
					const guard = await input.canDeliver(claim);
					if (guard.disposition === "cancel") {
						db.cancelTurnWake(
							claim.wake_id,
							`terminal_guard:${guard.reason ?? "target_not_deliverable"}`,
						);
						cancelled += 1;
						continue;
					}
					if (guard.disposition === "wait") {
						db.releaseTurnWakeClaim(claim.wake_id, claim.claim_token!);
						deferredWakeIds.add(claim.wake_id);
						continue;
					}
				}
				let envelope: PersistedWakeEnvelope;
				try {
					envelope = JSON.parse(claim.envelope_json) as PersistedWakeEnvelope;
					if (!envelope.fromAgent?.trim() || !envelope.content?.trim()) {
						throw new Error("required envelope fields missing");
					}
				} catch (error) {
					db.cancelTurnWake(
						claim.wake_id,
						`envelope_corrupt:${error instanceof Error ? error.message : String(error)}`,
					);
					cancelled += 1;
					continue;
				}
				const outcome = await wake({
					db,
					execId: claim.execution_id,
					fromAgent: envelope.fromAgent,
					content: envelope.content,
					metadata: envelope.metadata,
					backend: claim.backend,
					verified: claim.push_count === 1,
				});
				db.finishTurnWakePush({
					wakeId: claim.wake_id,
					claimToken: claim.claim_token!,
					pushedAtMs: nowMs,
					result: outcome.ok
						? "ok"
						: `error:${outcome.error ?? outcome.skippedReason ?? "wake_failed"}`,
				});
				pushed += 1;
				if (claim.push_count === 1 && input.onSecondPushUnacked) {
					const current = db.getTurnWake(claim.wake_id);
					if (current?.state !== "acked") {
						try {
							const pointer = await input.onSecondPushUnacked(
								current ?? claim,
								projectName,
							);
							if (!pointer.ok) failedPointerWakeIds.add(claim.wake_id);
						} catch (error) {
							console.warn(
								`[turn-wake] second-push pointer failed for ${claim.wake_id}: ${error instanceof Error ? error.message : String(error)}`,
							);
							failedPointerWakeIds.add(claim.wake_id);
						}
					}
				}
			}
			alerts += db.materializeTurnWakeNoReceiptAlerts({
				nowMs,
				alertAfterMs,
			}).length;
			if (failedPointerWakeIds.size > 0) {
				alerts += db.materializeTurnWakeNoReceiptAlerts({
					nowMs,
					alertAfterMs: 0,
					wakeIds: [...failedPointerWakeIds],
				}).length;
			}
			if (input.onReceipt) {
				for (const receipt of db.listUnprojectedTurnWakeReceipts(
					maxPerProject,
				)) {
					const outcome = await input.onReceipt(receipt);
					if (outcome !== "retry") {
						db.markTurnWakeReceiptProjected(receipt.wake_id, nowMs);
					}
				}
			}
		} finally {
			db.close();
		}
	}
	return { pushed, alerts, cancelled };
}
