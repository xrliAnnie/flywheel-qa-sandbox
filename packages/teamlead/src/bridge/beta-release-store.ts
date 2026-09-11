import type Database from "better-sqlite3";
import {
	type BetaBinding,
	type BetaLane,
	type BetaOccurrence,
	betaOccurrenceId,
} from "./beta-release-contract.js";
import type { BetaReceipt } from "./beta-release-receipt.js";

const laneSelect = `project_name AS projectName, repo_id AS repositoryId, canonical_repo AS canonicalRepo,
 workflow_id AS workflowId, default_branch AS defaultBranch, binding_revision AS bindingRevision,
 activated_at_ms AS activatedAtMs, last_due_at_ms AS lastDueAtMs, next_due_at_ms AS nextDueAtMs,
 active_occurrence_id AS activeOccurrenceId, interval_ms AS intervalMs`;
const occurrenceSelect = `occurrence_id AS occurrenceId, project_name AS projectName,
 binding_revision AS bindingRevision, scheduled_at_ms AS scheduledAtMs, source_commit AS sourceCommit,
 state, run_ids_json AS runIdsJson, attempt_count AS attemptCount, retry_at_ms AS retryAtMs,
 last_error AS lastError, created_at_ms AS createdAtMs, settled_at_ms AS settledAtMs`;

/** Uses StateStore's existing connection; no separate database or network transactions. */
export class BetaReleaseStore {
	constructor(private readonly db: Database.Database) {}
	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS beta_schedule_lanes (
				project_name TEXT PRIMARY KEY, repo_id INTEGER NOT NULL, canonical_repo TEXT NOT NULL,
				workflow_id INTEGER NOT NULL, default_branch TEXT NOT NULL, binding_revision TEXT NOT NULL,
				activated_at_ms INTEGER NOT NULL, last_due_at_ms INTEGER, next_due_at_ms INTEGER NOT NULL,
				active_occurrence_id TEXT, status TEXT NOT NULL DEFAULT 'ready', last_error TEXT, observed_at_ms INTEGER
			);
			CREATE TABLE IF NOT EXISTS beta_schedule_occurrences (
				occurrence_id TEXT PRIMARY KEY, project_name TEXT NOT NULL,
				binding_revision TEXT NOT NULL, scheduled_at_ms INTEGER NOT NULL, source_commit TEXT NOT NULL,
				state TEXT NOT NULL, run_ids_json TEXT NOT NULL, attempt_count INTEGER NOT NULL,
				retry_at_ms INTEGER, last_error TEXT, result_json TEXT, created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER,
				UNIQUE(project_name, binding_revision, scheduled_at_ms)
			);
		`);
		const columns = this.db
			.prepare("PRAGMA table_info(beta_schedule_lanes)")
			.all() as { name: string }[];
		if (!columns.some((c) => c.name === "interval_ms"))
			this.db.exec(
				"ALTER TABLE beta_schedule_lanes ADD COLUMN interval_ms INTEGER",
			);
	}
	/** Persist interval changes, without undoing the no-burst cursor after settlement. */
	due(project: string, intervalMs: number, now: number): number | null {
		if (
			!Number.isSafeInteger(intervalMs) ||
			intervalMs <= 0 ||
			!Number.isSafeInteger(now) ||
			now < 0
		)
			throw new Error("beta clock or interval invalid");
		return this.db
			.transaction(() => {
				const lane = this.lane(project);
				if (!lane || lane.activeOccurrenceId) return null;
				if (lane.intervalMs !== intervalMs) {
					lane.nextDueAtMs =
						(lane.lastDueAtMs ?? lane.activatedAtMs) + intervalMs;
					this.db
						.prepare(
							"UPDATE beta_schedule_lanes SET next_due_at_ms=?,interval_ms=? WHERE project_name=?",
						)
						.run(lane.nextDueAtMs, intervalMs, project);
				}
				if (now < lane.nextDueAtMs) return null;
				return (
					lane.nextDueAtMs +
					Math.floor((now - lane.nextDueAtMs) / intervalMs) * intervalMs
				);
			})
			.immediate();
	}
	lanes(): BetaLane[] {
		return this.db
			.prepare(
				`SELECT ${laneSelect} FROM beta_schedule_lanes ORDER BY project_name`,
			)
			.all() as BetaLane[];
	}
	lane(project: string): BetaLane | null {
		return (
			(this.db
				.prepare(
					`SELECT ${laneSelect} FROM beta_schedule_lanes WHERE project_name = ?`,
				)
				.get(project) as BetaLane | undefined) ?? null
		);
	}
	active(project: string): BetaOccurrence | null {
		const id = this.lane(project)?.activeOccurrenceId;
		if (!id) return null;
		const row = this.db
			.prepare(
				`SELECT ${occurrenceSelect} FROM beta_schedule_occurrences WHERE occurrence_id = ?`,
			)
			.get(id) as
			| (Omit<BetaOccurrence, "runIds"> & { runIdsJson: string })
			| undefined;
		if (!row) throw new Error("beta active occurrence missing");
		const { runIdsJson, ...rest } = row;
		return { ...rest, runIds: JSON.parse(runIdsJson) };
	}
	bind(
		binding: BetaBinding,
		activatedAtMs: number,
		intervalMs: number,
	): BetaLane {
		return this.db
			.transaction(() => {
				const existing = this.lane(binding.projectName);
				if (existing) {
					for (const key of Object.keys(binding) as (keyof BetaBinding)[]) {
						if (binding[key] !== existing[key])
							throw new Error(
								"beta binding change requires paused and drained re-enrollment",
							);
					}
					return existing;
				}
				const lane: BetaLane = {
					...binding,
					activatedAtMs,
					intervalMs,
					lastDueAtMs: null,
					nextDueAtMs: activatedAtMs + intervalMs,
					activeOccurrenceId: null,
				};
				this.db
					.prepare(`INSERT INTO beta_schedule_lanes (project_name,repo_id,canonical_repo,workflow_id,default_branch,binding_revision,activated_at_ms,next_due_at_ms,interval_ms)
			 VALUES (@projectName,@repositoryId,@canonicalRepo,@workflowId,@defaultBranch,@bindingRevision,@activatedAtMs,@nextDueAtMs,@intervalMs)`)
					.run(lane);
				return lane;
			})
			.immediate();
	}
	reserve(
		project: string,
		due: number,
		sourceCommit: string,
		now: number,
	): BetaOccurrence | null {
		if (!/^[a-f0-9]{40}$/.test(sourceCommit))
			throw new Error("beta source commit invalid");
		if (
			!Number.isSafeInteger(due) ||
			!Number.isSafeInteger(now) ||
			due < 0 ||
			now < 0
		)
			throw new Error("beta clock invalid");
		return this.db
			.transaction(() => {
				const lane = this.lane(project);
				if (
					!lane ||
					lane.activeOccurrenceId ||
					due > now ||
					due < lane.nextDueAtMs ||
					(lane.lastDueAtMs !== null && due <= lane.lastDueAtMs)
				)
					return null;
				const occurrence: BetaOccurrence = {
					occurrenceId: betaOccurrenceId(project, lane.bindingRevision, due),
					projectName: project,
					bindingRevision: lane.bindingRevision,
					scheduledAtMs: due,
					sourceCommit,
					state: "prepared",
					runIds: [],
					attemptCount: 0,
					retryAtMs: null,
					lastError: null,
					createdAtMs: now,
					settledAtMs: null,
				};
				const inserted = this.db
					.prepare(`INSERT OR IGNORE INTO beta_schedule_occurrences
			 (occurrence_id,project_name,binding_revision,scheduled_at_ms,source_commit,state,run_ids_json,attempt_count,created_at_ms)
			 VALUES (@occurrenceId,@projectName,@bindingRevision,@scheduledAtMs,@sourceCommit,@state,'[]',0,@createdAtMs)`)
					.run(occurrence);
				if (!inserted.changes) return null;
				this.db
					.prepare(
						"UPDATE beta_schedule_lanes SET active_occurrence_id=? WHERE project_name=?",
					)
					.run(occurrence.occurrenceId, project);
				return occurrence;
			})
			.immediate();
	}
	latestResult(project: string): BetaReceipt[] | null {
		const row = this.db
			.prepare(
				"SELECT result_json FROM beta_schedule_occurrences WHERE project_name=? AND result_json IS NOT NULL ORDER BY scheduled_at_ms DESC LIMIT 1",
			)
			.get(project) as { result_json: string } | undefined;
		return row ? JSON.parse(row.result_json) : null;
	}
	transition(
		project: string,
		id: string,
		expected: BetaOccurrence["state"],
		patch: Partial<
			Pick<
				BetaOccurrence,
				"state" | "runIds" | "attemptCount" | "retryAtMs" | "lastError"
			>
		> & { result?: BetaReceipt[] },
	): boolean {
		return this.db
			.transaction(() => {
				const active = this.active(project);
				if (!active || active.occurrenceId !== id || active.state !== expected)
					return false;
				const next = { ...active, ...patch };
				return (
					this.db
						.prepare(`UPDATE beta_schedule_occurrences SET state=@state,run_ids_json=@runIdsJson,
			 attempt_count=@attemptCount,retry_at_ms=@retryAtMs,last_error=@lastError,result_json=COALESCE(@resultJson,result_json)
			 WHERE occurrence_id=@occurrenceId AND state=@expected`)
						.run({
							...next,
							resultJson: patch.result ? JSON.stringify(patch.result) : null,
							runIdsJson: JSON.stringify(next.runIds),
							expected,
						}).changes === 1
				);
			})
			.immediate();
	}
	settle(project: string, id: string, now: number, intervalMs: number): void {
		if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
			throw new Error("beta interval invalid");
		this.db
			.transaction(() => {
				const active = this.active(project);
				if (!active || active.occurrenceId !== id) return;
				if (!["succeeded", "exhausted"].includes(active.state))
					throw new Error("beta occurrence is not terminal");
				const due = active.scheduledAtMs;
				const next =
					due +
					Math.max(1, Math.floor((now - due) / intervalMs) + 1) * intervalMs;
				this.db
					.prepare(
						"UPDATE beta_schedule_occurrences SET settled_at_ms=? WHERE occurrence_id=?",
					)
					.run(now, id);
				this.db
					.prepare(
						"UPDATE beta_schedule_lanes SET active_occurrence_id=NULL,last_due_at_ms=?,next_due_at_ms=?,interval_ms=? WHERE project_name=? AND active_occurrence_id=?",
					)
					.run(due, next, intervalMs, project, id);
			})
			.immediate();
	}
}
