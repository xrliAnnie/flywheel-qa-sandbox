import type { CommDB, GateSupersedeRow } from "flywheel-comm/db";

interface IssueGateSupersedeStore {
	getSession(executionId: string): { issue_id?: string } | undefined;
	getCodexReviewJobByQuestionId(
		questionId: string,
	): { execution_id: string; issue_id?: string } | null;
	insertEvent(event: {
		event_id: string;
		execution_id: string;
		issue_id: string;
		project_name: string;
		event_type: string;
		source: string;
		payload?: Record<string, unknown>;
	}): boolean;
}

export interface IssueGateSupersedeStats {
	scanned: number;
	candidates: number;
	retired: number;
	unmapped: number;
}

const SOURCE = "bridge.issue-gate-supersede";

function mutationLimit(env: Record<string, string | undefined>): number {
	const parsed = Number.parseInt(
		env.FLYWHEEL_ISSUE_GATE_SUPERSEDE_MAX_MUTATIONS ?? "",
		10,
	);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 50;
}

function issueFor(
	row: GateSupersedeRow,
	db: CommDB,
	store: IssueGateSupersedeStore,
): string | undefined {
	const stateIssue = store.getSession(row.from_agent)?.issue_id?.trim();
	if (stateIssue) return stateIssue;
	const commIssue = db.getSession(row.from_agent)?.issue_id?.trim();
	if (commIssue) return commIssue;
	if (row.checkpoint === "approve_to_ship") return undefined;
	const reviewIssue = store
		.getCodexReviewJobByQuestionId(row.id)
		?.issue_id?.trim();
	return reviewIssue || undefined;
}

function auditEventType(row: GateSupersedeRow): string {
	return row.checkpoint === "approve_to_ship"
		? "ship_gate_superseded"
		: "review_gate_superseded";
}

function auditEventId(row: GateSupersedeRow): string {
	return row.checkpoint === "approve_to_ship"
		? `ship-gate-superseded-${row.id}`
		: `review-gate-superseded-${row.id}`;
}

function insertAudit(
	row: GateSupersedeRow,
	issueId: string,
	projectName: string,
	store: IssueGateSupersedeStore,
): void {
	store.insertEvent({
		event_id: auditEventId(row),
		execution_id: row.from_agent,
		issue_id: issueId,
		project_name: projectName,
		event_type: auditEventType(row),
		source: SOURCE,
		payload: {
			questionId: row.id,
			checkpoint: row.checkpoint,
			supersededBy: row.superseded_by,
		},
	});
}

function recordUnmapped(
	row: GateSupersedeRow,
	projectName: string,
	store: IssueGateSupersedeStore,
): void {
	store.insertEvent({
		event_id: `gate-supersede-unmapped-${row.id}`,
		execution_id: row.from_agent,
		issue_id: "unmapped",
		project_name: projectName,
		event_type: "gate_supersede_unmapped",
		source: SOURCE,
		payload: { questionId: row.id, checkpoint: row.checkpoint },
	});
}

export function sweepIssueGatesForProject(args: {
	projectName: string;
	db: CommDB;
	store: IssueGateSupersedeStore;
	env: Record<string, string | undefined>;
	log?: (message: string) => void;
}): IssueGateSupersedeStats {
	const stats: IssueGateSupersedeStats = {
		scanned: 0,
		candidates: 0,
		retired: 0,
		unmapped: 0,
	};
	const mode = args.env.FLYWHEEL_ISSUE_GATE_SUPERSEDE;
	if (mode === "0") return stats;

	// Reconcile durable dispositions before considering new mutations. A crash
	// after the CommDB stamp but before this StateStore write heals next tick.
	for (const stamped of args.db.getSupersededGates()) {
		const issueId = issueFor(stamped, args.db, args.store);
		if (!issueId) {
			stats.unmapped++;
			recordUnmapped(stamped, args.projectName, args.store);
			continue;
		}
		try {
			insertAudit(stamped, issueId, args.projectName, args.store);
		} catch (error) {
			args.log?.(
				`[gate-supersede] audit reconcile failed for ${stamped.id}: ${(error as Error).message}`,
			);
		}
	}

	const rows = args.db.getGatesForSupersede();
	stats.scanned = rows.length;
	const groups = new Map<string, GateSupersedeRow[]>();
	for (const row of rows) {
		const issueId = issueFor(row, args.db, args.store);
		if (!issueId) {
			stats.unmapped++;
			recordUnmapped(row, args.projectName, args.store);
			continue;
		}
		const key = `${issueId}\u0000${row.checkpoint}`;
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}

	const candidates: Array<{
		row: GateSupersedeRow;
		supersessor: GateSupersedeRow;
		issueId: string;
	}> = [];
	for (const [key, group] of groups) {
		if (group.length < 2) continue;
		group.sort(
			(a, b) => a.created_at.localeCompare(b.created_at) || a.row_id - b.row_id,
		);
		const supersessor = group.at(-1)!;
		const issueId = key.slice(0, key.indexOf("\u0000"));
		for (const row of group.slice(0, -1)) {
			if (row.pending !== 1) continue;
			candidates.push({ row, supersessor, issueId });
		}
	}
	candidates.sort(
		(a, b) =>
			a.row.created_at.localeCompare(b.row.created_at) ||
			a.row.row_id - b.row.row_id,
	);
	stats.candidates = candidates.length;

	if (mode === "observe") {
		for (const { row, supersessor, issueId } of candidates) {
			args.store.insertEvent({
				event_id: `gate-supersede-candidate-${row.id}`,
				execution_id: row.from_agent,
				issue_id: issueId,
				project_name: args.projectName,
				event_type: "gate_supersede_candidate",
				source: SOURCE,
				payload: {
					questionId: row.id,
					checkpoint: row.checkpoint,
					supersededBy: supersessor.id,
				},
			});
		}
		return stats;
	}

	for (const { row, supersessor, issueId } of candidates.slice(
		0,
		mutationLimit(args.env),
	)) {
		if (!args.db.canSupersedeGate(row.id, supersessor.id)) continue;
		const retired =
			row.checkpoint === "approve_to_ship"
				? args.db.retireShipGate(row.id, { supersededBy: supersessor.id })
				: args.db.retireQuestionGuarded(row.id, {
						expectedFromAgent: row.from_agent,
						requireUnanswered: true,
						supersededBy: supersessor.id,
					});
		if (!retired) continue;
		stats.retired++;
		try {
			insertAudit(
				{ ...row, superseded_by: supersessor.id },
				issueId,
				args.projectName,
				args.store,
			);
		} catch (error) {
			args.log?.(
				`[gate-supersede] audit write failed for ${row.id}: ${(error as Error).message}`,
			);
		}
	}
	return stats;
}
