/**
 * FLY-1244 commit A — CommDB source-event projector.
 *
 * CommDB owns the founder response/TURN source transaction. StateStore owns
 * the claims ledger. This drain deliberately re-reads the immutable source
 * rows through a durable rowid cursor: destination receipts make a cursor-loss
 * replay harmless, and a durable deadletter makes malformed/poison input
 * terminal and auditable.
 */

import {
	buildFounderInputDeadletterAlertPayload,
	type WorkflowEngineAlertIdentity,
	type WorkflowEngineAlertPayload,
} from "../StateStore.js";

interface WorkflowSourceRow {
	row_id: number;
	project: string;
	source_event_id: string;
	kind:
		| "founder_approval"
		| "founder_feedback"
		| "turn_grant"
		| "land_departure_cutoff";
	payload: string;
	payload_digest: string;
	schema_version: number;
	at: string;
}

interface WorkflowSourceDb {
	listWorkflowSourceEventsAfter(
		afterRowId: number,
		limit: number,
	): WorkflowSourceRow[];
	close?(): void;
}

interface WorkflowSourceStore {
	applyWorkflowSourceEvent(input: {
		project: string;
		sourceEventId: string;
		kind:
			| "founder_approval"
			| "founder_feedback"
			| "turn_grant"
			| "land_departure_cutoff";
		payloadJson: string;
		payloadDigest: string;
		schemaVersion: number;
		sourceRowId?: number;
		at: string;
		alertIdentity?: WorkflowEngineAlertIdentity;
	}): { status: "applied" | "replayed" };
	getWorkflowSourceDeadletter(project: string, sourceEventId: string): unknown;
	recordWorkflowSourceDeadletter(input: {
		project: string;
		sourceEventId: string;
		reason: string;
		founderOrigin?: {
			kind: "founder_approval" | "founder_feedback";
			payloadJson: string;
			alertIdentity: WorkflowEngineAlertIdentity;
		};
	}): undefined | { deadlettered: boolean; alertEnqueued: boolean };
	getWorkflowRun(
		runId: string,
	): { run_id: string; issue_id: string; project_name: string } | undefined;
	getWorkflowSourceCursor(project: string): number;
	advanceWorkflowSourceCursor(project: string, rowId: number): void;
}

export interface WorkflowSourceProjectorArgs {
	projects: readonly string[] | (() => readonly string[]);
	openCommDb(project: string): WorkflowSourceDb;
	store: WorkflowSourceStore;
	resolveAlertIdentity?(input: {
		project: string;
		issueId: string;
		runId: string;
	}): WorkflowEngineAlertIdentity;
	alertFallback?(
		payload: WorkflowEngineAlertPayload,
	): Promise<{ accepted: boolean }>;
	log?: (message: string) => void;
}

export interface WorkflowSourceDrainResult {
	applied: number;
	replayed: number;
	deadlettered: number;
	skipped: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTerminalSourceError(reason: string): boolean {
	return /(?:malformed|digest mismatch|\bpoison\b|source payload invalid|source project mismatch|commit-A TURN source)/i.test(
		reason,
	);
}

function isValidAlertIdentity(
	identity: unknown,
): identity is WorkflowEngineAlertIdentity {
	if (!identity || typeof identity !== "object") return false;
	const candidate = identity as Partial<WorkflowEngineAlertIdentity>;
	return Boolean(
		typeof candidate.leadId === "string" &&
			candidate.leadId.trim() &&
			typeof candidate.projectName === "string" &&
			candidate.projectName.trim() &&
			(candidate.leadResolution === "resolved" ||
				candidate.leadResolution === "fallback"),
	);
}

export function drainWorkflowSourceEvents(
	args: WorkflowSourceProjectorArgs,
): Promise<WorkflowSourceDrainResult> {
	return drainWorkflowSourceEventsAsync(args);
}

async function drainWorkflowSourceEventsAsync(
	args: WorkflowSourceProjectorArgs,
): Promise<WorkflowSourceDrainResult> {
	const result: WorkflowSourceDrainResult = {
		applied: 0,
		replayed: 0,
		deadlettered: 0,
		skipped: 0,
	};

	let projects: readonly string[];
	try {
		projects =
			typeof args.projects === "function" ? args.projects() : args.projects;
	} catch (error) {
		args.log?.(
			`[workflow-source-projector] project roster failed: ${errorMessage(error)}`,
		);
		return result;
	}

	for (const project of new Set(projects)) {
		let db: WorkflowSourceDb | undefined;
		try {
			db = args.openCommDb(project);
			const cursor = args.store.getWorkflowSourceCursor(project);
			for (const event of db.listWorkflowSourceEventsAfter(cursor, 256)) {
				if (
					args.store.getWorkflowSourceDeadletter(project, event.source_event_id)
				) {
					result.skipped += 1;
					args.store.advanceWorkflowSourceCursor(project, event.row_id);
					continue;
				}
				let advance = false;
				try {
					if (event.project !== project) {
						throw new Error(
							`workflow source project mismatch: expected ${project}, got ${event.project}`,
						);
					}
					let alertIdentity: WorkflowEngineAlertIdentity | undefined;
					if (event.kind === "founder_feedback" && args.resolveAlertIdentity) {
						try {
							const payload = JSON.parse(event.payload) as Record<
								string,
								unknown
							>;
							const resolvedIdentity = args.resolveAlertIdentity({
								project,
								issueId: String(payload.issue_id ?? "unknown-founder-input"),
								runId: String(
									payload.run_id ?? `unbound:${event.source_event_id}`,
								),
							});
							if (isValidAlertIdentity(resolvedIdentity)) {
								alertIdentity = resolvedIdentity;
							} else {
								args.log?.(
									`[workflow-source-projector] founder rework alert identity invalid ${event.project}/${event.source_event_id}`,
								);
							}
						} catch (error) {
							args.log?.(
								`[workflow-source-projector] founder rework alert identity unavailable ${event.project}/${event.source_event_id}: ${errorMessage(error)}`,
							);
						}
					}
					const applied = args.store.applyWorkflowSourceEvent({
						project,
						sourceEventId: event.source_event_id,
						kind: event.kind,
						payloadJson: event.payload,
						payloadDigest: event.payload_digest,
						schemaVersion: event.schema_version,
						sourceRowId: event.row_id,
						at: event.at,
						...(alertIdentity ? { alertIdentity } : {}),
					});
					result[applied.status] += 1;
					advance = true;
				} catch (error) {
					const reason = errorMessage(error);
					if (isTerminalSourceError(reason)) {
						if (
							event.kind === "founder_approval" ||
							event.kind === "founder_feedback"
						) {
							let payload: Record<string, unknown> = {};
							try {
								payload = JSON.parse(event.payload) as Record<string, unknown>;
							} catch {
								// Malformed founder input is deliberately routed through the
								// unbound durable fallback before the poison row is consumed.
							}
							const runId = String(payload.run_id ?? "");
							const issueId = String(payload.issue_id ?? "");
							const questionId = String(payload.question_id ?? "");
							const run = runId ? args.store.getWorkflowRun(runId) : undefined;
							const identity = args.resolveAlertIdentity?.({
								project,
								issueId: issueId || "unknown-founder-input",
								runId: runId || `unbound:${event.source_event_id}`,
							});
							const bindable =
								!!identity &&
								!!run &&
								!!issueId &&
								!!questionId &&
								run.issue_id === issueId &&
								run.project_name === project;
							if (bindable) {
								args.store.recordWorkflowSourceDeadletter({
									project,
									sourceEventId: event.source_event_id,
									reason,
									founderOrigin: {
										kind: event.kind,
										payloadJson: event.payload,
										alertIdentity: identity,
									},
								});
							} else {
								if (!identity || !args.alertFallback) {
									args.log?.(
										`[workflow-source-projector] founder deadletter alert sink unavailable for ${event.project}/${event.source_event_id}`,
									);
									break;
								}
								let accepted = false;
								try {
									accepted = (
										await args.alertFallback(
											buildFounderInputDeadletterAlertPayload({
												escalationUid: `founder_input_deadletter:${event.source_event_id}`,
												projectName: project,
												runId: runId || `unbound:${event.source_event_id}`,
												issueId: issueId || "unknown-founder-input",
												questionId: questionId || "unknown",
												nodeId: "workflow-source-projector",
												executionId: event.source_event_id,
												kind: event.kind,
												reason,
												identity,
											}),
										)
									).accepted;
								} catch (alertError) {
									args.log?.(
										`[workflow-source-projector] founder deadletter alert retry ${event.project}/${event.source_event_id}: ${errorMessage(alertError)}`,
									);
								}
								if (!accepted) break;
								args.store.recordWorkflowSourceDeadletter({
									project,
									sourceEventId: event.source_event_id,
									reason,
								});
							}
						} else {
							args.store.recordWorkflowSourceDeadletter({
								project,
								sourceEventId: event.source_event_id,
								reason,
							});
						}
						result.deadlettered += 1;
						advance = true;
						args.log?.(
							`[workflow-source-projector] deadletter ${event.project}/${event.source_event_id}: ${reason}`,
						);
					} else {
						args.log?.(
							`[workflow-source-projector] retryable ${event.project}/${event.source_event_id}: ${reason}`,
						);
						break;
					}
				}
				if (advance) {
					try {
						args.store.advanceWorkflowSourceCursor(project, event.row_id);
					} catch (error) {
						args.log?.(
							`[workflow-source-projector] cursor retry ${project}/${event.row_id}: ${errorMessage(error)}`,
						);
						break;
					}
				}
			}
		} catch (error) {
			args.log?.(
				`[workflow-source-projector] drain failed for ${project}: ${errorMessage(error)}`,
			);
		} finally {
			db?.close?.();
		}
	}

	return result;
}

export function startWorkflowSourceProjector(
	args: WorkflowSourceProjectorArgs & { intervalMs?: number },
): { stop(): void; whenIdle(): Promise<void> } {
	let running: Promise<WorkflowSourceDrainResult> | undefined;
	const drain = (): Promise<WorkflowSourceDrainResult> => {
		if (running) return running;
		const current = drainWorkflowSourceEvents(args);
		running = current;
		void current
			.catch((error) =>
				args.log?.(
					`[workflow-source-projector] tick failed: ${errorMessage(error)}`,
				),
			)
			.finally(() => {
				if (running === current) running = undefined;
			});
		return current;
	};
	void drain();
	const timer = setInterval(() => void drain(), args.intervalMs ?? 5_000);
	timer.unref?.();
	return {
		stop: () => clearInterval(timer),
		whenIdle: async () => {
			await running;
		},
	};
}
