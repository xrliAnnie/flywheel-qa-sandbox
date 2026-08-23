import { createHash } from "node:crypto";
import type { RunnerShutdownControl } from "flywheel-comm/db";
import { CommDB } from "flywheel-comm/db";
import type {
	LandOperationClaim,
	LandOperationRow,
	Session,
	StateStore,
} from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import {
	isWorkflowManifestLand,
	workflowTerminalNode,
} from "../workflow-template.js";
import { resolveCommDbPath } from "./commdb-session-prune.js";
import {
	type CleanupTmuxTargetResult,
	cleanupTmuxTarget,
} from "./post-merge.js";
import {
	DEFAULT_ACK_TIMEOUT_MS,
	isWorkflowPhaseSession,
	type RunnerShutdownDb,
} from "./runner-shutdown-evidence.js";
import {
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	type TmuxTarget,
} from "./tmux-lookup.js";

export type ShippedHuskPaneEvidence =
	| { kind: "alive"; tmuxWindow: string }
	| { kind: "gone" | "indeterminate" };

export interface ShippedHuskEvidenceInput {
	session: Session | undefined;
	issueId: string;
	nowMs: number;
	pane: ShippedHuskPaneEvidence;
	control: RunnerShutdownControl | null;
	operation: LandOperationRow | undefined;
	claim: LandOperationClaim;
	currentRetryEpochKey: string;
	runIsLandTerminal: boolean;
	sessionBelongsToRun: boolean;
}

export type ShippedHuskEvidenceDecision =
	| {
			eligible: true;
			tmuxWindow: string;
			requestId: string;
	  }
	| { eligible: false; reason: string };

export function evaluateShippedHuskEvidence(
	input: ShippedHuskEvidenceInput,
): ShippedHuskEvidenceDecision {
	const session = input.session;
	if (!isWorkflowPhaseSession(session) || session?.issue_id !== input.issueId) {
		return { eligible: false, reason: "not_issue_workflow_phase" };
	}
	if (input.pane.kind !== "alive") {
		return { eligible: false, reason: `pane_${input.pane.kind}` };
	}
	const control = input.control;
	if (
		!control ||
		control.state !== "requested" ||
		!Number.isFinite(control.requested_at) ||
		input.nowMs - control.requested_at < DEFAULT_ACK_TIMEOUT_MS ||
		input.nowMs - control.requested_at < 0
	) {
		return { eligible: false, reason: "shutdown_window_incomplete" };
	}
	const operation = input.operation;
	if (!input.sessionBelongsToRun) {
		return { eligible: false, reason: "session_not_bound_to_land_run" };
	}
	if (
		!operation ||
		operation.retry_count < 1 ||
		operation.retry_epoch_key !== input.currentRetryEpochKey
	) {
		return { eligible: false, reason: "closeout_retry_not_observed" };
	}
	if (
		operation.state !== "running" ||
		operation.superseded_at !== null ||
		operation.owner_id !== input.claim.ownerId ||
		operation.generation !== input.claim.generation ||
		operation.operation_id !== input.claim.operationId ||
		operation.merge_confirmed_at === null ||
		!input.runIsLandTerminal ||
		!operation.lease_expires_at ||
		Date.parse(operation.lease_expires_at) <= input.nowMs
	) {
		return { eligible: false, reason: "land_authority_unavailable" };
	}
	return {
		eligible: true,
		tmuxWindow: input.pane.tmuxWindow,
		requestId: control.request_id,
	};
}

export type ShippedHuskFailureCause =
	| "window_identity_mismatch"
	| "window_cleanup_failed"
	| "authority_lost";

export interface ForceShippedHusksInput {
	issueId: string;
	projectName: string;
	operationId: string;
	claim: LandOperationClaim;
}

interface ShippedHuskShutdownDb
	extends Pick<RunnerShutdownDb, "getRunnerShutdown" | "close"> {}

export interface ForceShippedHusksDeps {
	now?: () => number;
	forceEnabled?: () => boolean;
	resolveCommDbPath?: (projectName: string) => string | undefined;
	openCommDb?: (dbPath: string) => ShippedHuskShutdownDb;
	lookupTarget?: typeof lookupTmuxTarget;
	probe?: typeof probeRunnerProcessLiveness;
	runIsLandTerminal?: (operation: LandOperationRow) => boolean;
	sessionBelongsToRun?: (
		executionId: string,
		operation: LandOperationRow,
	) => boolean;
	cleanupTarget?: (
		input: Parameters<typeof cleanupTmuxTarget>[0],
	) => Promise<CleanupTmuxTargetResult>;
}

export interface ForceShippedHusksResult {
	cleared: string[];
	cause?: ShippedHuskFailureCause;
	affectedExecutionIds?: string[];
}

interface GatheredEvidence {
	decision: ShippedHuskEvidenceDecision;
	pane: ShippedHuskPaneEvidence;
	session?: Session;
	target?: TmuxTarget;
}

function defaultRunIsLandTerminal(
	store: StateStore,
	operation: LandOperationRow,
): boolean {
	if (!operation.run_id) return false;
	const run = store.getWorkflowRun(operation.run_id);
	if (!run?.snapshot || run.engine_owned !== 1 || run.status !== "active") {
		return false;
	}
	try {
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		return (
			isWorkflowManifestLand(snapshot.manifest) &&
			run.current_node_id === workflowTerminalNode(snapshot.manifest)
		);
	} catch {
		return false;
	}
}

function event(
	store: StateStore,
	session: Session,
	intentId: string,
	type: string,
	payload: Record<string, unknown>,
): void {
	store.insertEvent({
		event_id: `${intentId}:${type}`,
		execution_id: session.execution_id,
		issue_id: session.issue_id,
		project_name: session.project_name,
		event_type: type,
		source: "bridge.shipped-husk-force",
		payload: { intentId, ...payload },
	});
}

/**
 * Tear down only a shipped, repeatedly-blocking workflow-node husk. Every
 * destructive step revalidates the live land claim and the tmux execution
 * marker; uncertainty returns without signalling or killing anything.
 */
export async function forceShippedHusks(
	input: ForceShippedHusksInput,
	store: StateStore,
	deps: ForceShippedHusksDeps = {},
): Promise<ForceShippedHusksResult> {
	if (!(deps.forceEnabled ?? (() => true))()) return { cleared: [] };
	const now = deps.now ?? Date.now;
	const lookupTarget = deps.lookupTarget ?? lookupTmuxTarget;
	const probe = deps.probe ?? probeRunnerProcessLiveness;
	const resolvePath = deps.resolveCommDbPath ?? resolveCommDbPath;
	const openDb = deps.openCommDb ?? ((path: string) => new CommDB(path));
	const runIsLandTerminal =
		deps.runIsLandTerminal ??
		((operation: LandOperationRow) =>
			defaultRunIsLandTerminal(store, operation));
	const cleanupTarget = deps.cleanupTarget ?? cleanupTmuxTarget;
	const sessionBelongsToRun =
		deps.sessionBelongsToRun ??
		((executionId: string, operation: LandOperationRow) =>
			Boolean(
				operation.run_id &&
					store
						.listWorkflowActivationsForActor(executionId)
						.some((activation) => activation.run_id === operation.run_id),
			));

	const authorityAvailable = (): boolean => {
		const operation = store.getLandOperation(input.operationId);
		const nowIso = new Date(now()).toISOString();
		return Boolean(
			operation?.issue_id === input.issueId &&
				operation.project_name === input.projectName &&
				operation.merge_confirmed_at &&
				runIsLandTerminal(operation) &&
				store.isCurrentLandOperationClaim({
					operation,
					claim: input.claim,
					now: nowIso,
				}),
		);
	};

	const gather = async (executionId: string): Promise<GatheredEvidence> => {
		const session = store.getSession(executionId);
		const observedAt = now();
		const lookup = lookupTarget(executionId, input.projectName);
		let pane: ShippedHuskPaneEvidence = { kind: "indeterminate" };
		let target: TmuxTarget | undefined;
		if (lookup.kind === "gone") {
			pane = { kind: "gone" };
		} else if (lookup.kind === "found") {
			target = lookup.target;
			try {
				const liveness = await probe(target.tmuxWindow);
				pane =
					liveness === "alive"
						? { kind: "alive", tmuxWindow: target.tmuxWindow }
						: liveness === "indeterminate"
							? { kind: "indeterminate" }
							: { kind: "gone" };
			} catch {
				pane = { kind: "indeterminate" };
			}
		}

		let control: RunnerShutdownControl | null = null;
		const dbPath = resolvePath(input.projectName);
		if (dbPath) {
			let db: ShippedHuskShutdownDb | undefined;
			try {
				db = openDb(dbPath);
				control = db.getRunnerShutdown(executionId);
			} catch {
				control = null;
			} finally {
				db?.close();
			}
		}
		const operation = store.getLandOperation(input.operationId);
		const retryEpoch = store.getLandOperationRetryEpoch(input.operationId);
		return {
			pane,
			session,
			target,
			decision: evaluateShippedHuskEvidence({
				session,
				issueId: input.issueId,
				nowMs: observedAt,
				pane,
				control,
				operation,
				claim: input.claim,
				currentRetryEpochKey: retryEpoch?.epochKey ?? "",
				runIsLandTerminal: operation ? runIsLandTerminal(operation) : false,
				sessionBelongsToRun: operation
					? sessionBelongsToRun(executionId, operation)
					: false,
			}),
		};
	};

	const cleared: string[] = [];
	const recordClearedReceipt = (
		session: Session,
		intentId: string,
		tmuxWindow: string,
	) =>
		store.recordLandOperationStep({
			operationId: input.operationId,
			ownerId: input.claim.ownerId,
			generation: input.claim.generation,
			step: `aux:husk_force_cleared:${session.execution_id}:${createHash("sha256").update(intentId).digest("hex").slice(0, 16)}`,
			receipt: { intentId, tmuxWindow },
			now: new Date(now()).toISOString(),
		});
	for (const listedSession of store.getPhaseSessionsForIssue(input.issueId)) {
		if (!isWorkflowPhaseSession(listedSession)) continue;
		const initial = await gather(listedSession.execution_id);
		const session = initial.session;
		if (!session) continue;
		const priorEvents = store.getEventsByExecution(session.execution_id);
		const intentPrefix = `shipped-husk-force:${input.operationId}:`;
		const finishedIntents = new Set(
			priorEvents
				.filter((entry) =>
					[
						"shipped_husk_force_reaped",
						"shipped_husk_force_failed",
						"shipped_husk_force_aborted",
					].includes(entry.event_type),
				)
				.map((entry) => (entry.payload as { intentId?: string })?.intentId)
				.filter(
					(value): value is string =>
						typeof value === "string" && value.startsWith(intentPrefix),
				),
		);
		const openIntent = priorEvents
			.filter((entry) => entry.event_type === "shipped_husk_force_started")
			.map(
				(entry) => entry.payload as { intentId?: string; tmuxWindow?: string },
			)
			.reverse()
			.find(
				(payload) =>
					typeof payload.intentId === "string" &&
					payload.intentId.startsWith(intentPrefix) &&
					!finishedIntents.has(payload.intentId),
			);
		if (openIntent?.intentId && authorityAvailable()) {
			event(store, session, openIntent.intentId, "shipped_husk_force_aborted", {
				reason:
					initial.pane.kind === "gone"
						? "window_gone_after_force_intent"
						: "recovered_open_force_intent",
			});
			finishedIntents.add(openIntent.intentId);
		}
		if (!initial.decision.eligible || !initial.target) continue;
		const retryCount = store.getLandOperation(input.operationId)?.retry_count;
		const digest = createHash("sha256")
			.update(
				JSON.stringify({
					requestId: initial.decision.requestId,
					retryCount,
					tmuxWindow: initial.decision.tmuxWindow,
				}),
			)
			.digest("hex");
		const intentId = `shipped-husk-force:${input.operationId}:${input.claim.generation}:${session.execution_id}:${digest}`;
		if (
			store
				.listLandOperationSteps(input.operationId)
				.some((step) => step.receipt.intentId === intentId)
		) {
			continue;
		}
		if (finishedIntents.has(intentId)) continue;
		event(store, session, intentId, "shipped_husk_force_started", {
			requestId: initial.decision.requestId,
			retryCount,
			tmuxWindow: initial.decision.tmuxWindow,
		});

		const beforeWindow = await gather(session.execution_id);
		if (
			beforeWindow.pane.kind === "indeterminate" ||
			beforeWindow.target?.tmuxWindow !== initial.decision.tmuxWindow ||
			(beforeWindow.pane.kind === "alive" && !beforeWindow.decision.eligible) ||
			!authorityAvailable()
		) {
			event(store, session, intentId, "shipped_husk_force_aborted", {
				reason: "evidence_changed_before_window_cleanup",
			});
			continue;
		}
		const cleanup = await cleanupTarget({
			target: beforeWindow.target,
			session,
			strict: {
				expectedExecutionId: session.execution_id,
				authorityCheck: async () => authorityAvailable(),
			},
		});
		if (!cleanup.physicalGone) {
			const cause = cleanup.strictFailure ?? "window_cleanup_failed";
			event(
				store,
				session,
				intentId,
				cleanup.strictFailure === "authority_lost"
					? "shipped_husk_force_aborted"
					: "shipped_husk_force_failed",
				{ cause, errors: cleanup.errors },
			);
			return {
				cleared,
				cause,
				affectedExecutionIds: [session.execution_id],
			};
		}
		const receipt = recordClearedReceipt(
			session,
			intentId,
			initial.decision.tmuxWindow,
		);
		if (!receipt.ok) {
			event(store, session, intentId, "shipped_husk_force_aborted", {
				reason: receipt.reason,
			});
			return {
				cleared,
				cause: "authority_lost",
				affectedExecutionIds: [session.execution_id],
			};
		}
		event(store, session, intentId, "shipped_husk_force_reaped", {
			tmuxWindow: initial.decision.tmuxWindow,
		});
		cleared.push(session.execution_id);
	}
	return { cleared };
}
