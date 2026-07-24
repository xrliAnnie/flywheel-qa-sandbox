import { createHash } from "node:crypto";
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
	/** StateStore-owned identity for one continuous terminal lifecycle. */
	terminalLifecycleIdFor?: (input: {
		projectName: string;
		executionId: string;
	}) => string | undefined;
	/** StateStore-owned durable park states (for example ship_parked). */
	isDurablyParked?: (input: {
		projectName: string;
		executionId: string;
	}) => boolean;
	auditWakeDisposition?: (input: {
		projectName: string;
		executionId: string;
		messageId: string;
		reason: string;
	}) => void;
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
		episodeFingerprint?: string;
		identityKind?: "terminal_episode" | "founder_message";
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

/** Stable within one unresolved failure episode; changes only after recovery. */
export function wakeFailureEpisodeFingerprint(
	executionId: string,
	firstDetectedAtMs: number,
): string {
	return createHash("sha256")
		.update(`${executionId}|wake_failed|${firstDetectedAtMs}`)
		.digest("hex")
		.slice(0, 16);
}

export function wakeFailureNotificationFingerprint(input: {
	executionId: string;
	messageId: string;
	firstDetectedAtMs: number;
	identityKind?: "terminal_episode" | "founder_message";
	explicitFingerprint?: string;
}): string {
	if (input.explicitFingerprint) return input.explicitFingerprint;
	if (input.identityKind === "founder_message") {
		return createHash("sha256")
			.update(input.messageId)
			.digest("hex")
			.slice(0, 16);
	}
	return wakeFailureEpisodeFingerprint(
		input.executionId,
		input.firstDetectedAtMs,
	);
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
		const metadata = envelopeMetadata(wake);
		if (targetState === "terminal") {
			if (metadata.origin === "founder") {
				const terminalLifecycleId = this.options.terminalLifecycleIdFor?.({
					projectName,
					executionId: wake.execution_id,
				});
				if (terminalLifecycleId) {
					await this.completeTerminal(
						db,
						projectName,
						wake,
						nowMs,
						terminalLifecycleId,
					);
					return;
				}
				await this.escalate(
					db,
					projectName,
					wake,
					nowMs,
					"terminal_before_started",
				);
				return;
			}
			db.disposeRunnerPhaseWakeForTerminal(
				wake.execution_id,
				wake.message_id,
				nowMs,
			);
			return;
		}
		if (targetState === "missing") {
			await this.escalate(
				db,
				projectName,
				wake,
				nowMs,
				"target_missing_before_started",
			);
			return;
		}
		const isDurablyParked = () =>
			db.getEffectiveDeclaredState(wake.execution_id, nowMs)?.kind ===
				"parked" ||
			this.options.isDurablyParked?.({
				projectName,
				executionId: wake.execution_id,
			}) === true;
		const durablePark = isDurablyParked();
		if (wake.purpose === "message_traffic" && !durablePark) {
			if (metadata.origin === "founder") {
				await this.escalate(
					db,
					projectName,
					wake,
					nowMs,
					"founder_wake_undeliverable",
				);
				return;
			}
			const disposed = db.disposeRunnerPhaseWakePending(
				wake.execution_id,
				wake.message_id,
				nowMs,
			);
			if (disposed) {
				this.options.auditWakeDisposition?.({
					projectName,
					executionId: wake.execution_id,
					messageId: wake.message_id,
					reason: "live_non_parked_normal_traffic",
				});
			}
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
		if (wake.purpose === "message_traffic" && !isDurablyParked()) {
			db.completeRunnerReceiptWakePush({
				executionId: wake.execution_id,
				messageId: wake.message_id,
				claimToken: claim.claimToken,
				attempt: claim.attempt,
				result: "skipped:durable_park_fence",
				nowMs,
			});
			if (metadata.origin === "founder") {
				await this.escalate(
					db,
					projectName,
					wake,
					nowMs,
					"founder_wake_undeliverable",
				);
				return;
			}
			const disposed = db.disposeRunnerPhaseWakePending(
				wake.execution_id,
				wake.message_id,
				nowMs,
			);
			if (disposed) {
				this.options.auditWakeDisposition?.({
					projectName,
					executionId: wake.execution_id,
					messageId: wake.message_id,
					reason: "live_non_parked_normal_traffic",
				});
			}
			return;
		}
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

	private async completeTerminal(
		db: CommDB,
		projectName: string,
		wake: RunnerPhaseWake,
		nowMs: number,
		terminalLifecycleId: string,
	): Promise<void> {
		const result = db.completeRunnerPhaseWakeTerminal({
			executionId: wake.execution_id,
			messageId: wake.message_id,
			reason: "terminal_before_started",
			terminalLifecycleId,
			nowMs,
		});
		if (!result) return;
		const live = db.revalidateRunnerReceiptWakeAlert(result.alert.id, nowMs);
		if (!live) return;
		const firstDetectedAtMs = Date.parse(result.alert.created_at);
		const delivered = await this.options.notifyWakeFailure({
			projectName,
			wake: result.wake,
			reason: "terminal_before_started",
			firstDetectedAtMs: Number.isFinite(firstDetectedAtMs)
				? firstDetectedAtMs
				: wake.queued_at,
			episodeFingerprint: result.episodeFingerprint,
			identityKind: result.identityKind,
		});
		if (delivered) db.markReceiptAlertDelivered(result.alert.id, nowMs);
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
		const firstDetectedAtMs =
			db.getRunnerWakeFailureEpisodeStartedAt(wake.execution_id) ??
			wake.queued_at;
		const live = db.revalidateRunnerReceiptWakeAlert(alert.id, nowMs);
		if (!live) return;
		const delivered = await this.options.notifyWakeFailure({
			projectName,
			wake,
			reason,
			firstDetectedAtMs,
			...(envelopeMetadata(wake).origin === "founder"
				? { identityKind: "founder_message" as const }
				: {}),
		});
		if (delivered) db.markReceiptAlertDelivered(alert.id, nowMs);
	}
}
