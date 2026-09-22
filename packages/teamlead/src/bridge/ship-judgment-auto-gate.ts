import type { ShipJudgmentApprovalEnvelopeV1 } from "flywheel-comm/ship-judgment-approval-contract";

interface ShipJudgmentAutoGateStore {
	listPendingShipJudgmentAutoCandidates(
		limit?: number,
		startAfterQuestionId?: string,
	): string[];
	commitShipJudgmentSourceIfEligible(input: {
		questionId: string;
		at: string;
		writeSource: (args: {
			expectedOwner: string;
			projectedThroughSourceRowId: number;
			envelope: ShipJudgmentApprovalEnvelopeV1;
		}) => { written: boolean; replayed: boolean };
	}): {
		status:
			| "not_auto"
			| "not_candidate"
			| "ineligible"
			| "written"
			| "replayed";
	};
}

interface ShipJudgmentAutoGateCommDb {
	insertShipJudgmentApprovalWithSource(input: {
		project: string;
		expectedOwner: string;
		projectedThroughSourceRowId: number;
		envelope: unknown;
	}): { written: boolean; replayed: boolean };
	close(): void;
}

export interface ReconcileShipJudgmentAutoGateDeps {
	store: ShipJudgmentAutoGateStore;
	openCommDb(project: string): ShipJudgmentAutoGateCommDb;
	now?: () => string;
	scanAfterQuestionId?: string;
	monotonicNow?: () => number;
	log?: (message: string) => void;
}

export interface ReconcileShipJudgmentAutoGateResult {
	scanned: number;
	written: number;
	replayed: number;
	skipped: number;
	failed: number;
	cursor: string | null;
}

/** Bounded synchronous pump; evidence collection and Discord delivery happen before this seam. */
export function reconcileShipJudgmentAutoGate(
	deps: ReconcileShipJudgmentAutoGateDeps,
): ReconcileShipJudgmentAutoGateResult {
	const monotonicNow = deps.monotonicNow ?? Date.now;
	const startedAt = monotonicNow();
	const result: ReconcileShipJudgmentAutoGateResult = {
		scanned: 0,
		written: 0,
		replayed: 0,
		skipped: 0,
		failed: 0,
		cursor: null,
	};
	const at = deps.now?.() ?? new Date().toISOString();
	for (const questionId of deps.store.listPendingShipJudgmentAutoCandidates(
		20,
		deps.scanAfterQuestionId,
	)) {
		if (result.scanned > 0 && monotonicNow() - startedAt >= 200) break;
		result.scanned += 1;
		result.cursor = questionId;
		const db = deps.openCommDb("flywheel");
		try {
			const outcome = deps.store.commitShipJudgmentSourceIfEligible({
				questionId,
				at,
				writeSource: ({
					expectedOwner,
					projectedThroughSourceRowId,
					envelope,
				}) =>
					db.insertShipJudgmentApprovalWithSource({
						project: "flywheel",
						expectedOwner,
						projectedThroughSourceRowId,
						envelope,
					}),
			});
			if (outcome.status === "written") result.written += 1;
			else if (outcome.status === "replayed") result.replayed += 1;
			else result.skipped += 1;
		} catch (error) {
			result.failed += 1;
			const detail = error instanceof Error ? error.message : String(error);
			deps.log?.(`[ship-judgment-auto] ${questionId}: ${detail}`);
			if (/SQLITE_(?:BUSY|LOCKED)|database is (?:locked|busy)/i.test(detail)) {
				break;
			}
		} finally {
			db.close();
		}
	}
	return result;
}
