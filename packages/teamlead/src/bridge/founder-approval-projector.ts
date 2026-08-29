/**
 * FLY-1244 commit A — CommDB source-event projector.
 *
 * CommDB owns the founder response/TURN source transaction. StateStore owns
 * the claims ledger. This drain deliberately re-reads the immutable source
 * rows through a durable rowid cursor: destination receipts make a cursor-loss
 * replay harmless, and a durable deadletter makes malformed/poison input
 * terminal and auditable.
 */

interface WorkflowSourceRow {
	row_id: number;
	project: string;
	source_event_id: string;
	kind: "founder_approval" | "turn_grant";
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
		kind: "founder_approval" | "turn_grant";
		payloadJson: string;
		payloadDigest: string;
		schemaVersion: number;
		at: string;
	}): { status: "applied" | "replayed" };
	getWorkflowSourceDeadletter(project: string, sourceEventId: string): unknown;
	recordWorkflowSourceDeadletter(input: {
		project: string;
		sourceEventId: string;
		reason: string;
	}): void;
	getWorkflowSourceCursor(project: string): number;
	advanceWorkflowSourceCursor(project: string, rowId: number): void;
}

export interface WorkflowSourceProjectorArgs {
	projects: readonly string[] | (() => readonly string[]);
	openCommDb(project: string): WorkflowSourceDb;
	store: WorkflowSourceStore;
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

export function drainWorkflowSourceEvents(
	args: WorkflowSourceProjectorArgs,
): WorkflowSourceDrainResult {
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
					args.store.getWorkflowSourceDeadletter(
						event.project,
						event.source_event_id,
					)
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
					const applied = args.store.applyWorkflowSourceEvent({
						project: event.project,
						sourceEventId: event.source_event_id,
						kind: event.kind,
						payloadJson: event.payload,
						payloadDigest: event.payload_digest,
						schemaVersion: event.schema_version,
						at: event.at,
					});
					result[applied.status] += 1;
					advance = true;
				} catch (error) {
					const reason = errorMessage(error);
					if (isTerminalSourceError(reason)) {
						args.store.recordWorkflowSourceDeadletter({
							project: event.project,
							sourceEventId: event.source_event_id,
							reason,
						});
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
): { stop(): void } {
	const drain = () => drainWorkflowSourceEvents(args);
	drain();
	const timer = setInterval(drain, args.intervalMs ?? 5_000);
	timer.unref?.();
	return { stop: () => clearInterval(timer) };
}
