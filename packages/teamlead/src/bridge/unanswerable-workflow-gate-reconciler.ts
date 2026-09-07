import { CommDB } from "flywheel-comm/db";
import type {
	WorkflowEngineAlertIdentity,
	WorkflowGateOriginInspectionReceipt,
	WorkflowGateQuestionRecoveryCandidate,
	WorkflowGateQuestionRecoveryResult,
} from "../StateStore.js";
import type { WorkflowGateOriginInspectionResult } from "./gate-origin-preflight.js";

const DEFAULT_LIMIT = 20;
const DEFAULT_MIN_INTERVAL_MS = 30_000;
const RECOVERY_LIMIT = 3;
const lastPassByStore = new WeakMap<object, Map<string, number>>();

type RecoveryAlertKind = "origin_inspection_blocked" | "recovery_limit_reached";

interface WorkflowGateQuestionRecoveryStore {
	listWorkflowGateQuestionRecoveryCandidates(
		projectName: string,
		limit?: number,
	): WorkflowGateQuestionRecoveryCandidate[];
	recoverUnanswerableWorkflowGate(input: {
		runId: string;
		gateNodeId: string;
		questionId: string;
		headSha: string;
		originReceipt: WorkflowGateOriginInspectionReceipt;
		now: string;
	}): WorkflowGateQuestionRecoveryResult;
	recordWorkflowGateQuestionRecoveryAlert(input: {
		kind: RecoveryAlertKind;
		candidate: WorkflowGateQuestionRecoveryCandidate;
		alertIdentity: WorkflowEngineAlertIdentity;
		now: string;
	}): { ok: true; idempotentReplay: boolean } | { ok: false; reason: string };
}

type RecoveryCommDb = Pick<CommDB, "inspectFounderShipGateQuestion" | "close">;

export interface UnanswerableWorkflowGateReconcileDeps {
	enabled: boolean;
	projectName: string;
	commDbPath: string;
	store: WorkflowGateQuestionRecoveryStore;
	openDb?: (path: string) => RecoveryCommDb;
	inspectOrigin: (
		questionId: string,
	) => Promise<WorkflowGateOriginInspectionResult>;
	resolveAlertIdentity?: (
		candidate: WorkflowGateQuestionRecoveryCandidate,
	) => WorkflowEngineAlertIdentity;
	now?: () => string;
	limit?: number;
	minIntervalMs?: number;
	log?: (message: string) => void;
}

export interface UnanswerableWorkflowGateReconcileResult {
	disabled: boolean;
	throttled: boolean;
	examined: number;
	recovered: number;
	skipped: number;
	failed: number;
	newQuestionIds: string[];
}

function emptyResult(input: {
	disabled: boolean;
	throttled: boolean;
}): UnanswerableWorkflowGateReconcileResult {
	return {
		...input,
		examined: 0,
		recovered: 0,
		skipped: 0,
		failed: 0,
		newQuestionIds: [],
	};
}

function defaultAlertIdentity(
	candidate: WorkflowGateQuestionRecoveryCandidate,
): WorkflowEngineAlertIdentity {
	return {
		leadId: "unassigned",
		projectName: candidate.projectName,
		leadResolution: "fallback",
	};
}

function shouldRecover(
	inspection: ReturnType<RecoveryCommDb["inspectFounderShipGateQuestion"]>,
): boolean {
	return !inspection.answerable && !inspection.founderSourceEventExists;
}

/**
 * Replaces an active founder ship gate only when its CommDB question is no
 * longer answerable and no founder decision source event exists. Every
 * candidate is independently fenced so one bad gate cannot stop the pass.
 */
export async function reconcileUnanswerableWorkflowGates(
	deps: UnanswerableWorkflowGateReconcileDeps,
): Promise<UnanswerableWorkflowGateReconcileResult> {
	if (!deps.enabled) {
		return emptyResult({ disabled: true, throttled: false });
	}

	const now = deps.now ?? (() => new Date().toISOString());
	const observedAt = now();
	const observedAtMs = Date.parse(observedAt);
	if (!Number.isFinite(observedAtMs)) {
		throw new Error("invalid_workflow_gate_question_recovery_time");
	}
	const minIntervalMs = Math.max(
		1,
		Math.trunc(deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS),
	);
	const storePasses =
		lastPassByStore.get(deps.store) ?? new Map<string, number>();
	const previousPassAt = storePasses.get(deps.projectName);
	if (
		previousPassAt !== undefined &&
		observedAtMs >= previousPassAt &&
		observedAtMs - previousPassAt < minIntervalMs
	) {
		return emptyResult({ disabled: false, throttled: true });
	}
	storePasses.set(deps.projectName, observedAtMs);
	lastPassByStore.set(deps.store, storePasses);

	const result = emptyResult({ disabled: false, throttled: false });
	const limit = Math.max(
		1,
		Math.min(100, Math.trunc(deps.limit ?? DEFAULT_LIMIT)),
	);
	let candidates: WorkflowGateQuestionRecoveryCandidate[];
	try {
		candidates = deps.store.listWorkflowGateQuestionRecoveryCandidates(
			deps.projectName,
			limit,
		);
	} catch (error) {
		result.failed = 1;
		deps.log?.(
			`[workflow-gate-question-recovery] candidate scan failed for ${deps.projectName}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return result;
	}
	if (candidates.length === 0) return result;

	const openDb = deps.openDb ?? ((path: string) => new CommDB(path, false));
	let db: RecoveryCommDb;
	try {
		db = openDb(deps.commDbPath);
	} catch (error) {
		result.failed = candidates.length;
		deps.log?.(
			`[workflow-gate-question-recovery] CommDB open failed for ${deps.projectName}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return result;
	}

	const alertIdentity = deps.resolveAlertIdentity ?? defaultAlertIdentity;
	try {
		for (const candidate of candidates) {
			result.examined += 1;
			try {
				const inspection = db.inspectFounderShipGateQuestion(
					candidate.questionId,
					candidate.projectName,
				);
				if (!shouldRecover(inspection)) {
					result.skipped += 1;
					continue;
				}
				if (candidate.recoveryCount >= RECOVERY_LIMIT) {
					const alerted = deps.store.recordWorkflowGateQuestionRecoveryAlert({
						kind: "recovery_limit_reached",
						candidate,
						alertIdentity: alertIdentity(candidate),
						now: observedAt,
					});
					if (!alerted.ok) result.failed += 1;
					result.skipped += 1;
					continue;
				}
				const origin = await deps.inspectOrigin(candidate.questionId);
				if (!origin.ok || !origin.receipt) {
					const alerted = deps.store.recordWorkflowGateQuestionRecoveryAlert({
						kind: "origin_inspection_blocked",
						candidate,
						alertIdentity: alertIdentity(candidate),
						now: observedAt,
					});
					if (!alerted.ok) result.failed += 1;
					result.skipped += 1;
					continue;
				}
				const recovered = deps.store.recoverUnanswerableWorkflowGate({
					runId: candidate.runId,
					gateNodeId: candidate.gateNodeId,
					questionId: candidate.questionId,
					headSha: candidate.headSha,
					originReceipt: origin.receipt,
					now: now(),
				});
				if (recovered.ok) {
					result.recovered += 1;
					result.newQuestionIds.push(recovered.questionId);
					continue;
				}
				if (recovered.reason === "recovery_limit_reached") {
					const alerted = deps.store.recordWorkflowGateQuestionRecoveryAlert({
						kind: "recovery_limit_reached",
						candidate,
						alertIdentity: alertIdentity(candidate),
						now: observedAt,
					});
					if (!alerted.ok) result.failed += 1;
					result.skipped += 1;
					continue;
				}
				if (recovered.reason === "recovery_transaction_failed") {
					result.failed += 1;
				} else {
					result.skipped += 1;
				}
			} catch (error) {
				result.failed += 1;
				deps.log?.(
					`[workflow-gate-question-recovery] candidate failed for ${candidate.runId}/${candidate.questionId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} finally {
		try {
			db.close();
		} catch (error) {
			deps.log?.(
				`[workflow-gate-question-recovery] CommDB close failed for ${deps.projectName}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return result;
}
