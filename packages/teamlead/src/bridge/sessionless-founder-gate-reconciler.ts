import { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../StateStore.js";

const DEFAULT_LIMIT = 20;
const DEFAULT_MIN_INTERVAL_MS = 30_000;
const lastPassByStore = new WeakMap<object, number>();

type SessionlessGateStore = Pick<
	StateStore,
	| "listSessionlessWorkflowGateCandidates"
	| "terminateSessionlessWorkflowGate"
	| "listPendingSessionlessGateMailboxRetirements"
	| "appendWorkflowRunEventChecked"
>;

type SessionlessGateCommDb = Pick<
	CommDB,
	"retireGateForTerminalAuthority" | "getMessageById" | "close"
>;

export interface SessionlessWorkflowGateReconcileDeps {
	store: SessionlessGateStore;
	commDbPathForProject: (projectName: string) => string;
	openDb?: (path: string) => SessionlessGateCommDb;
	now?: () => string;
	limit?: number;
	minIntervalMs?: number;
	log?: (message: string) => void;
}

export interface SessionlessWorkflowGateReconcileResult {
	throttled: boolean;
	closeouts: number;
	retired: number;
	failed: number;
}

function emptyResult(
	throttled: boolean,
): SessionlessWorkflowGateReconcileResult {
	return { throttled, closeouts: 0, retired: 0, failed: 0 };
}

/**
 * Converges engine-owned founder gates whose attributed runner set is empty.
 * StateStore is always committed first; CommDB retirement is replayed from the
 * durable superseded holder on later passes after any cross-database failure.
 */
export async function reconcileSessionlessWorkflowGates(
	deps: SessionlessWorkflowGateReconcileDeps,
): Promise<SessionlessWorkflowGateReconcileResult> {
	const observedAt = (deps.now ?? (() => new Date().toISOString()))();
	const observedAtMs = Date.parse(observedAt);
	if (!Number.isFinite(observedAtMs)) {
		throw new Error("invalid_sessionless_gate_reconcile_time");
	}
	const minIntervalMs = Math.max(
		1,
		Math.trunc(deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS),
	);
	const previousPassAt = lastPassByStore.get(deps.store);
	if (
		previousPassAt !== undefined &&
		observedAtMs >= previousPassAt &&
		observedAtMs - previousPassAt < minIntervalMs
	) {
		return emptyResult(true);
	}
	lastPassByStore.set(deps.store, observedAtMs);

	const result = emptyResult(false);
	const limit = Math.max(
		1,
		Math.min(100, Math.trunc(deps.limit ?? DEFAULT_LIMIT)),
	);
	let candidates: ReturnType<
		SessionlessGateStore["listSessionlessWorkflowGateCandidates"]
	> = [];
	try {
		candidates = deps.store.listSessionlessWorkflowGateCandidates(limit);
	} catch (error) {
		result.failed += 1;
		deps.log?.(
			`[sessionless-founder-gate] candidate scan failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	for (const candidate of candidates) {
		try {
			const closed = deps.store.terminateSessionlessWorkflowGate({
				runId: candidate.runId,
				questionId: candidate.questionId,
				now: observedAt,
			});
			if (closed.ok) {
				result.closeouts += 1;
			} else {
				result.failed += 1;
				deps.log?.(
					`[sessionless-founder-gate] closeout refused for ${candidate.runId}/${candidate.questionId}: ${closed.reason}`,
				);
			}
		} catch (error) {
			result.failed += 1;
			deps.log?.(
				`[sessionless-founder-gate] closeout failed for ${candidate.runId}/${candidate.questionId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	let retirements: ReturnType<
		SessionlessGateStore["listPendingSessionlessGateMailboxRetirements"]
	> = [];
	try {
		retirements =
			deps.store.listPendingSessionlessGateMailboxRetirements(limit);
	} catch (error) {
		result.failed += 1;
		deps.log?.(
			`[sessionless-founder-gate] mailbox scan failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return result;
	}
	if (retirements.length === 0) return result;
	const byProject = new Map<string, typeof retirements>();
	for (const retirement of retirements) {
		const project = byProject.get(retirement.projectName) ?? [];
		project.push(retirement);
		byProject.set(retirement.projectName, project);
	}
	const openDb = deps.openDb ?? ((path: string) => new CommDB(path, false));
	for (const [projectName, projectRetirements] of byProject) {
		let db: SessionlessGateCommDb | undefined;
		try {
			db = openDb(deps.commDbPathForProject(projectName));
		} catch (error) {
			result.failed += projectRetirements.length;
			deps.log?.(
				`[sessionless-founder-gate] CommDB open failed for ${projectName}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		try {
			for (const retirement of projectRetirements) {
				try {
					const prior = db.getMessageById(retirement.questionId);
					const outcome = db.retireGateForTerminalAuthority({
						questionId: retirement.questionId,
						reason: "superseded_run_sessionless",
						now: observedAt,
					});
					deps.store.appendWorkflowRunEventChecked({
						runId: retirement.runId,
						eventUid: `sessionless_gate_mailbox_retired:${retirement.runId}:${retirement.questionId}`,
						kind: "sessionless_gate_mailbox_retired",
						nodeId: retirement.gateNodeId,
						executionId: retirement.sourceExecutionId,
						payload: {
							questionId: retirement.questionId,
							outcome: outcome.kind,
							reason: "superseded_run_sessionless",
							checkpoint: prior?.checkpoint ?? null,
							resolvedVia: prior?.resolved_via ?? null,
						},
					});
					result.retired += 1;
				} catch (error) {
					result.failed += 1;
					deps.log?.(
						`[sessionless-founder-gate] CommDB retirement failed for ${retirement.runId}/${retirement.questionId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		} finally {
			try {
				db.close();
			} catch (error) {
				deps.log?.(
					`[sessionless-founder-gate] CommDB close failed for ${projectName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	return result;
}
