import { CommDB, type TurnWakeOutboxRow } from "flywheel-comm/db";
import {
	TURN_WAKE_RETRY_AFTER_MS,
	wakeRunnerMailbox,
} from "flywheel-comm/wake";
import type { TurnWakeReceiptOutcome } from "./turn-wake-receipt-classifier.js";

export type { TurnWakeReceiptOutcome } from "./turn-wake-receipt-classifier.js";

interface PersistedWakeEnvelope {
	fromAgent: string;
	content: string;
	metadata?: Record<string, unknown>;
}

export interface TurnWakeReceiptCounts {
	projected: number;
	notApplicable: number;
	retried: number;
	quarantined: number;
}

/**
 * FLY-2828 C6: the only terminal-guard reasons that prove the obligation is
 * durably finished. Every other cancel reason (`rework_obligation_settled`,
 * `activation_target_terminal`, ...) can still be revived by a resume that
 * reuses the same wake id, so those rows keep flowing to the no-receipt alert.
 */
const COMPLETED_OBLIGATION_CANCEL_REASONS = new Set([
	"rework_obligation_completed",
	"carrier_obligation_completed",
]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	/** FLY-2828: retries before an unprojectable receipt leaves the window. */
	quarantineAfterAttempts?: number;
	/** FLY-2828: age of an acked-but-unprojected receipt before a Lead alert. */
	projectionAlertAfterMs?: number;
	onReceipt?: (row: TurnWakeOutboxRow) => Promise<TurnWakeReceiptOutcome>;
	onSecondPushUnacked?: (
		row: TurnWakeOutboxRow,
		projectName: string,
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	canDeliver?: (
		row: TurnWakeOutboxRow,
	) => Promise<{ disposition: "deliver" | "cancel" | "wait"; reason?: string }>;
}): Promise<{
	pushed: number;
	alerts: number;
	cancelled: number;
	receipts: TurnWakeReceiptCounts;
}> {
	const nowMs = input.nowMs ?? Date.now();
	const retryAfterMs = input.retryAfterMs ?? TURN_WAKE_RETRY_AFTER_MS;
	const alertAfterMs = input.alertAfterMs ?? 20 * 60_000;
	const leaseMs = input.leaseMs ?? 30_000;
	const maxPerProject = input.maxPerProject ?? 20;
	const quarantineAfterAttempts = input.quarantineAfterAttempts ?? 20;
	const projectionAlertAfterMs = input.projectionAlertAfterMs ?? 15 * 60_000;
	const wake = input.wake ?? wakeRunnerMailbox;
	let pushed = 0;
	let alerts = 0;
	let cancelled = 0;
	const receipts: TurnWakeReceiptCounts = {
		projected: 0,
		notApplicable: 0,
		retried: 0,
		quarantined: 0,
	};

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
						`envelope_corrupt:${errorMessage(error)}`,
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
								`[turn-wake] second-push pointer failed for ${claim.wake_id}: ${errorMessage(error)}`,
							);
							failedPointerWakeIds.add(claim.wake_id);
						}
					}
				}
			}
			// FLY-2828 C6: an obligation that already completed (C1 settlement or a
			// normal completion) but whose ACK was lost would otherwise sit at
			// push_count=2 forever and raise a false "no receipt" question.
			if (input.canDeliver) {
				for (const stale of db.listExhaustedUnackedTurnWakes(
					nowMs,
					maxPerProject,
				)) {
					let guard: { disposition: string; reason?: string };
					try {
						guard = await input.canDeliver(stale);
					} catch (error) {
						console.warn(
							`[turn-wake] exhausted-wake guard failed for ${stale.wake_id}: ${errorMessage(error)}`,
						);
						continue;
					}
					if (
						guard.disposition === "cancel" &&
						COMPLETED_OBLIGATION_CANCEL_REASONS.has(guard.reason ?? "")
					) {
						if (
							db.cancelTurnWake(stale.wake_id, `terminal_guard:${guard.reason}`)
						) {
							cancelled += 1;
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
				// FLY-2828 C2: one receipt can neither abort the loop nor occupy the
				// window forever. Every retry is counted with its reason; a receipt
				// that reaches the quarantine threshold leaves the window and gets
				// one durable Lead question below.
				const quarantinedWakeIds = new Set<string>();
				for (const receipt of db.listUnprojectedTurnWakeReceipts(
					maxPerProject,
					quarantineAfterAttempts,
				)) {
					let outcome: TurnWakeReceiptOutcome;
					try {
						outcome = await input.onReceipt(receipt);
					} catch (error) {
						outcome = {
							kind: "retry",
							reason: `exception:${errorMessage(error)}`,
						};
					}
					if (outcome.kind === "retry") {
						receipts.retried += 1;
						const attempt = db.recordTurnWakeReceiptProjectionAttempt(
							receipt.wake_id,
							outcome.reason,
							nowMs,
						);
						console.warn(
							`[turn-wake] receipt projection retry for ${receipt.wake_id} (${receipt.purpose}): ${outcome.reason} (attempt ${attempt?.attempts ?? "?"})`,
						);
						if (attempt && attempt.attempts >= quarantineAfterAttempts) {
							receipts.quarantined += 1;
							quarantinedWakeIds.add(receipt.wake_id);
						}
						continue;
					}
					const marked = db.markTurnWakeReceiptProjected(
						receipt.wake_id,
						nowMs,
						outcome.kind,
						outcome.kind === "not_applicable" ? outcome.reason : undefined,
					);
					if (!marked) {
						console.warn(
							`[turn-wake] receipt projection mark failed for ${receipt.wake_id} (${outcome.kind})`,
						);
					}
					if (outcome.kind === "not_applicable") {
						receipts.notApplicable += 1;
						console.warn(
							`[turn-wake] receipt not applicable for ${receipt.wake_id} (${receipt.purpose}): ${outcome.reason}`,
						);
					} else {
						receipts.projected += 1;
					}
				}
				alerts += db.materializeTurnWakeUnprojectedReceiptAlerts({
					nowMs,
					alertAfterMs: projectionAlertAfterMs,
				}).length;
				if (quarantinedWakeIds.size > 0) {
					alerts += db.materializeTurnWakeUnprojectedReceiptAlerts({
						nowMs,
						alertAfterMs: 0,
						wakeIds: [...quarantinedWakeIds],
					}).length;
				}
			}
		} finally {
			db.close();
		}
	}
	return { pushed, alerts, cancelled, receipts };
}
