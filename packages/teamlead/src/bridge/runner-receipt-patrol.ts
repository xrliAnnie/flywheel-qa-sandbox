import type { CommDB, RunnerPhaseWake } from "flywheel-comm/db";
import { CommDB as CommDatabase } from "flywheel-comm/db";

export const DEFAULT_WAKE_T1_MS = 90_000;
export const DEFAULT_WAKE_T2_MS = 5 * 60_000;
export const DEFAULT_WAKE_T3_MS = 12 * 60_000;

export interface ReceiptWakePatrolOptions {
	projectNames: readonly string[];
	commDbPathForProject: (projectName: string) => string;
	receiptFoundationEnabled: () => boolean;
	resolveTargetState?: (input: {
		projectName: string;
		executionId: string;
	}) => "live" | "terminal" | "missing";
	now?: () => number;
	t1Ms?: number;
	t2Ms?: number;
	t3Ms?: number;
	pushWake: (input: {
		db: CommDB;
		projectName: string;
		wake: RunnerPhaseWake;
		verified: true;
	}) => Promise<{ ok: boolean; error?: string; skippedReason?: string }>;
	nudgeWakePointer: (input: {
		projectName: string;
		wake: RunnerPhaseWake;
		causalQuestionId?: string;
	}) => Promise<{ nudged: boolean; error?: string }>;
	notifyWakeFailure: (input: {
		projectName: string;
		wake: RunnerPhaseWake;
		reason: string;
		firstDetectedAtMs: number;
	}) => Promise<boolean>;
	openDb?: (path: string) => CommDB;
}

function envelopeMetadata(wake: RunnerPhaseWake): Record<string, unknown> {
	if (!wake.envelope_json) return {};
	try {
		const parsed = JSON.parse(wake.envelope_json) as {
			metadata?: Record<string, unknown>;
		};
		return parsed.metadata ?? {};
	} catch {
		return {};
	}
}

function resultReason(error: string | undefined): string {
	return (error ?? "unknown").replaceAll(/\s+/g, " ").slice(0, 240);
}

/**
 * FLY-1392 wake ladder. It owns no timer: GatePoller calls one pass from its
 * existing cadence. Every external action is preceded by a durable claim.
 */
export class RunnerReceiptPatrol {
	private readonly openDb: (path: string) => CommDB;

	constructor(private readonly options: ReceiptWakePatrolOptions) {
		this.openDb = options.openDb ?? ((path) => new CommDatabase(path, false));
	}

	async pass(): Promise<void> {
		if (!this.options.receiptFoundationEnabled()) return;
		const nowMs = (this.options.now ?? Date.now)();
		for (const projectName of this.options.projectNames) {
			let db: CommDB | undefined;
			try {
				db = this.openDb(this.options.commDbPathForProject(projectName));
				for (const wake of db.listPendingRunnerReceiptWakes()) {
					await this.advance(db, projectName, wake, nowMs);
				}
			} catch (error) {
				console.warn(
					`[receipt-wake-patrol] ${projectName}: ${(error as Error).message}`,
				);
			} finally {
				db?.close();
			}
		}
	}

	private async advance(
		db: CommDB,
		projectName: string,
		wake: RunnerPhaseWake,
		nowMs: number,
	): Promise<void> {
		const session = db.getSession(wake.execution_id);
		const targetState = this.options.resolveTargetState
			? this.options.resolveTargetState({
					projectName,
					executionId: wake.execution_id,
				})
			: !session
				? "missing"
				: session.status === "running"
					? "live"
					: "terminal";
		if (targetState !== "live") {
			await this.escalate(
				db,
				projectName,
				wake,
				nowMs,
				targetState === "missing"
					? "target_missing_before_started"
					: "terminal_before_started",
			);
			return;
		}
		const durablePark =
			db.getEffectiveDeclaredState(wake.execution_id, nowMs)?.kind === "parked";
		if (wake.purpose === "message_traffic" && !durablePark) {
			db.disposeRunnerPhaseWakePending(
				wake.execution_id,
				wake.message_id,
				nowMs,
			);
			return;
		}

		const ageMs = nowMs - wake.queued_at;
		const t3Ms = this.options.t3Ms ?? DEFAULT_WAKE_T3_MS;
		if (ageMs >= t3Ms) {
			await this.escalate(
				db,
				projectName,
				wake,
				nowMs,
				"t3_no_started_receipt",
			);
			return;
		}

		const t2Ms = this.options.t2Ms ?? DEFAULT_WAKE_T2_MS;
		if (ageMs >= t2Ms && !wake.t2_claimed_at) {
			const claimed = db.claimRunnerReceiptWakeT2(
				wake.execution_id,
				wake.message_id,
				nowMs,
				t2Ms,
			);
			if (!claimed) return;
			const metadata = envelopeMetadata(claimed);
			const questionId =
				typeof metadata.questionId === "string"
					? metadata.questionId
					: undefined;
			let outcome: { nudged: boolean; error?: string };
			try {
				outcome = await this.options.nudgeWakePointer({
					projectName,
					wake: claimed,
					...(questionId ? { causalQuestionId: questionId } : {}),
				});
			} catch (error) {
				outcome = { nudged: false, error: (error as Error).message };
			}
			const result = outcome.nudged
				? "sent"
				: `forbidden:${resultReason(outcome.error)}`;
			db.completeRunnerReceiptWakeT2(
				wake.execution_id,
				wake.message_id,
				result,
			);
			if (!outcome.nudged) {
				await this.escalate(
					db,
					projectName,
					wake,
					nowMs,
					`wake_pointer_${resultReason(outcome.error)}`,
				);
			}
			return;
		}

		const claim = db.claimRunnerReceiptWakePush(
			wake.execution_id,
			wake.message_id,
			nowMs,
			{
				t1Ms: this.options.t1Ms ?? DEFAULT_WAKE_T1_MS,
				claimTtlMs: 30_000,
			},
		);
		if (!claim) return;
		let outcome: { ok: boolean; error?: string; skippedReason?: string };
		try {
			outcome = await this.options.pushWake({
				db,
				projectName,
				wake: claim.wake,
				verified: true,
			});
		} catch (error) {
			outcome = { ok: false, error: (error as Error).message };
		}
		db.completeRunnerReceiptWakePush({
			executionId: wake.execution_id,
			messageId: wake.message_id,
			claimToken: claim.claimToken,
			attempt: claim.attempt,
			result: outcome.ok
				? "verified"
				: outcome.skippedReason
					? `skipped:${outcome.skippedReason}`
					: `failed:${resultReason(outcome.error)}`,
			nowMs,
		});
	}

	private async escalate(
		db: CommDB,
		projectName: string,
		wake: RunnerPhaseWake,
		nowMs: number,
		reason: string,
	): Promise<void> {
		const alert = db.enqueueRunnerReceiptWakeEscalation({
			executionId: wake.execution_id,
			messageId: wake.message_id,
			reason,
			nowMs,
		});
		if (!alert) return;
		const live = db.revalidateRunnerReceiptWakeAlert(alert.id, nowMs);
		if (!live) return;
		const delivered = await this.options.notifyWakeFailure({
			projectName,
			wake,
			reason,
			firstDetectedAtMs: wake.queued_at,
		});
		if (delivered) db.markReceiptAlertDelivered(alert.id, nowMs);
	}
}
