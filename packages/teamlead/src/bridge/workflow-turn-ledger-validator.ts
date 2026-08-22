import { CommDB } from "flywheel-comm/db";
import type { WorkflowEngineAlertIdentity } from "../StateStore.js";

export interface WorkflowTurnExpectation {
	expectationKey: string;
	runId: string;
	nodeId: string;
	issueId: string;
	projectName: string;
	executionId: string;
	epoch: number;
	activationId: string | null;
	requiredSince: string;
	source: "activation" | "carrier";
}

interface WorkflowTurnLedgerValidatorStore {
	listWorkflowTurnExpectations(): WorkflowTurnExpectation[];
	listOpenWorkflowTurnDivergences(): Array<{ expectationKey: string }>;
	observeWorkflowTurnDivergence(input: {
		expectationKey: string;
		runId: string;
		issueId: string;
		projectName: string;
		expectedExecutionId: string;
		expectedEpoch: number;
		expectedActivationId: string | null;
		observedExecutionId: string | null;
		observedEpoch: number | null;
		observedActivationId: string | null;
		now: string;
		alertIdentity: WorkflowEngineAlertIdentity;
		alertEnabled?: boolean;
	}): { opened: boolean; alerted: boolean };
	closeWorkflowTurnDivergence(input: {
		expectationKey: string;
		now: string;
		reason: "recovered" | "no_longer_required";
	}): boolean;
}

function exactMatch(
	expectation: WorkflowTurnExpectation,
	turn: ReturnType<CommDB["getTurn"]>,
): boolean {
	return (
		turn !== null &&
		turn.holder_exec_id === expectation.executionId &&
		turn.epoch === expectation.epoch &&
		(turn.activation_id ?? null) === expectation.activationId
	);
}

/**
 * Compare the engine's durable activation/carrier ledger with the per-project
 * TURN belt. The existing GatePoller tick owns scheduling; this validator has
 * no timer and only records/alerts after a durable grace and a two-sided
 * re-read.
 */
export async function reconcileWorkflowTurnLedgers(input: {
	store: WorkflowTurnLedgerValidatorStore;
	commDbPathForProject: (projectName: string) => string;
	resolveAlertIdentity: (
		expectation: WorkflowTurnExpectation,
	) => WorkflowEngineAlertIdentity;
	now?: Date;
	graceMs?: number;
	alertEnabled?: boolean;
	onError?: (message: string) => void;
}): Promise<{ divergent: number; recovered: number }> {
	const now = input.now ?? new Date();
	const nowIso = now.toISOString();
	const graceMs = input.graceMs ?? 5 * 60_000;
	if (!Number.isFinite(graceMs) || graceMs < 0) {
		throw new Error("workflow TURN ledger grace must be non-negative");
	}
	const initial = input.store.listWorkflowTurnExpectations();
	const initialKeys = new Set(initial.map((item) => item.expectationKey));
	let recovered = 0;
	for (const episode of input.store.listOpenWorkflowTurnDivergences()) {
		if (initialKeys.has(episode.expectationKey)) continue;
		if (
			input.store.closeWorkflowTurnDivergence({
				expectationKey: episode.expectationKey,
				now: nowIso,
				reason: "no_longer_required",
			})
		) {
			recovered += 1;
		}
	}

	const due = initial.filter(
		(expectation) =>
			now.getTime() - Date.parse(expectation.requiredSince) >= graceMs,
	);
	if (due.length === 0) return { divergent: 0, recovered };

	// Founder acceptance: never alert from a snapshot captured across the
	// grant boundary. Re-read StateStore once, then re-open CommDB for each due
	// expectation immediately before deciding.
	const refreshed = new Map(
		input.store
			.listWorkflowTurnExpectations()
			.map((expectation) => [expectation.expectationKey, expectation]),
	);
	let divergent = 0;
	for (const stale of due) {
		const expectation = refreshed.get(stale.expectationKey);
		if (!expectation) continue;
		let db: CommDB | undefined;
		try {
			db = new CommDB(input.commDbPathForProject(expectation.projectName));
			const turn = db.getTurn(expectation.issueId);
			if (exactMatch(expectation, turn)) {
				if (
					input.store.closeWorkflowTurnDivergence({
						expectationKey: expectation.expectationKey,
						now: nowIso,
						reason: "recovered",
					})
				) {
					recovered += 1;
				}
				continue;
			}
			input.store.observeWorkflowTurnDivergence({
				expectationKey: expectation.expectationKey,
				runId: expectation.runId,
				issueId: expectation.issueId,
				projectName: expectation.projectName,
				expectedExecutionId: expectation.executionId,
				expectedEpoch: expectation.epoch,
				expectedActivationId: expectation.activationId,
				observedExecutionId: turn?.holder_exec_id ?? null,
				observedEpoch: turn?.epoch ?? null,
				observedActivationId: turn?.activation_id ?? null,
				now: nowIso,
				alertIdentity: input.resolveAlertIdentity(expectation),
				alertEnabled: input.alertEnabled !== false,
			});
			divergent += 1;
		} catch (error) {
			input.onError?.(
				`TURN ledger read failed for ${expectation.projectName}/${expectation.issueId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			db?.close();
		}
	}
	return { divergent, recovered };
}
