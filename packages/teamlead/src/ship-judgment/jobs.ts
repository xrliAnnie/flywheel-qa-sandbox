import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalDigest, verdictSchema } from "./contract.js";

const LEASE_MS = 150_000;
const MAX_DAILY_SPAWNS = 30;
const idSchema = z.string().min(1).max(200);
const resultSchema = z
	.object({
		alignment: verdictSchema,
		coverage: verdictSchema,
		result: z.unknown(),
		resultCode: z.string().min(1).max(64),
		durationMs: z.number().int().nonnegative().safe(),
		usage: z.unknown(),
		costUsd: z.number().finite().nonnegative().nullable(),
	})
	.strict();
export type JobResult = z.infer<typeof resultSchema>;
export interface JobClaim {
	status: "claimed";
	inputId: string;
	owner: string;
	generation: number;
}
export type ClaimResult =
	| JobClaim
	| { status: "missing" | "settled" | "busy" | "daily_budget" };
interface JobRow {
	input_id: string;
	state: string;
	generation: number;
	lease_owner: string | null;
	spawned_at: string | null;
	expires_at: string | null;
}
function iso(now: number): string {
	z.number().int().nonnegative().safe().parse(now);
	return new Date(now).toISOString();
}

/** Internal persistence only. The worker checks current project/mode/materials before admission and spawn. */
export class ShipJudgmentJobs {
	constructor(private readonly db: Database.Database) {}

	queued(): string[] {
		return (
			this.db
				.prepare(`SELECT j.input_id FROM ship_judgment_job j
			JOIN ship_judgment_input i ON i.input_id=j.input_id
			WHERE j.state='queued' AND i.project_name='flywheel'
			ORDER BY i.requested_at,j.input_id LIMIT 50`)
				.all() as { input_id: string }[]
		).map((row) => row.input_id);
	}

	/** Only call after a process result proves no child spawned, or before launch was attempted. */
	confirmNotSpawned(claim: JobClaim, reason: string, now: number): boolean {
		z.string().min(1).max(64).parse(reason);
		const at = iso(now);
		return (
			this.db
				.prepare(`UPDATE ship_judgment_job SET state='failed',finished_at=?,last_error=?,
			spawned_at=NULL,reserved_at=NULL,lease_owner=NULL,expires_at=NULL
			WHERE input_id=? AND lease_owner=? AND generation=? AND state='running' AND expires_at>?`)
				.run(at, reason, claim.inputId, claim.owner, claim.generation, at)
				.changes === 1
		);
	}

	enqueue(inputId: string): void {
		idSchema.parse(inputId);
		this.db
			.prepare(
				"INSERT OR IGNORE INTO ship_judgment_job(input_id,state) VALUES (?,'queued')",
			)
			.run(inputId);
	}

	claim(inputId: string, owner: string, now: number): ClaimResult {
		idSchema.parse(inputId);
		idSchema.parse(owner);
		const at = iso(now);
		return this.db
			.transaction((): ClaimResult => {
				const row = this.db
					.prepare("SELECT * FROM ship_judgment_job WHERE input_id=?")
					.get(inputId) as JobRow | undefined;
				if (!row) return { status: "missing" };
				if (row.state === "done" || row.state === "failed")
					return { status: "settled" };
				// Expiry alone is not permission to spawn: recovery first records the lost attempt.
				if (
					this.db
						.prepare(
							"SELECT 1 FROM ship_judgment_job WHERE state='running' LIMIT 1",
						)
						.get()
				)
					return { status: "busy" };
				const day = at.slice(0, 10);
				const spent = this.db
					.prepare(`SELECT COUNT(*) AS n FROM ship_judgment_job j
				JOIN ship_judgment_input i ON i.input_id=j.input_id
				WHERE i.project_name='flywheel' AND j.budget_day=? AND (j.spawned_at IS NOT NULL OR j.reserved_at IS NOT NULL)`)
					.get(day) as { n: number };
				if (spent.n >= MAX_DAILY_SPAWNS) return { status: "daily_budget" };
				const generation = row.generation + 1;
				const changed = this.db
					.prepare(`UPDATE ship_judgment_job SET state='running',lease_owner=?,generation=?,expires_at=?,
				budget_day=?,reserved_at=? WHERE input_id=? AND state='queued' AND generation=?`)
					.run(
						owner,
						generation,
						iso(now + LEASE_MS),
						day,
						at,
						inputId,
						row.generation,
					).changes;
				return changed
					? { status: "claimed", inputId, owner, generation }
					: { status: "busy" };
			})
			.immediate();
	}

	/** Persist immediately before launching. An ambiguous crash consumes this attempt; never replay it. */
	markSpawned(claim: JobClaim, now: number): boolean {
		const at = iso(now);
		return (
			this.db
				.prepare(`UPDATE ship_judgment_job SET spawned_at=? WHERE input_id=? AND lease_owner=? AND generation=?
			AND state='running' AND spawned_at IS NULL AND expires_at>? AND budget_day=?`)
				.run(
					at,
					claim.inputId,
					claim.owner,
					claim.generation,
					at,
					at.slice(0, 10),
				).changes === 1
		);
	}

	finish(claim: JobClaim, value: JobResult, now: number): boolean {
		const parsed = resultSchema.parse(value);
		const evaluated =
			parsed.resultCode === "ok" || parsed.resultCode === "evaluated";
		const at = iso(now);
		canonicalDigest(parsed.result);
		canonicalDigest(parsed.usage);
		const json = JSON.stringify(parsed.result);
		const usage = parsed.usage === null ? null : JSON.stringify(parsed.usage);
		if (
			Buffer.byteLength(json) > 65536 ||
			(usage && Buffer.byteLength(usage) > 8192)
		)
			throw new Error("evaluation_budget_exceeded");
		return this.db
			.transaction(() => {
				const row = this.db
					.prepare(`SELECT * FROM ship_judgment_job WHERE input_id=? AND lease_owner=? AND generation=?
				AND state='running' AND spawned_at IS NOT NULL AND expires_at>?`)
					.get(claim.inputId, claim.owner, claim.generation, at) as
					| JobRow
					| undefined;
				if (!row) return false;
				this.insertEvaluation(claim.inputId, parsed, json, usage, at);
				this.db
					.prepare(`UPDATE ship_judgment_job SET state=?,finished_at=?,expires_at=NULL,lease_owner=NULL,
				reserved_at=NULL,last_error=? WHERE input_id=? AND generation=?`)
					.run(
						evaluated ? "done" : "failed",
						at,
						evaluated ? null : parsed.resultCode,
						claim.inputId,
						claim.generation,
					);
				return true;
			})
			.immediate();
	}

	recoverExpired(now: number): number {
		const at = iso(now);
		return this.db
			.transaction(() => {
				const rows = this.db
					.prepare(
						"SELECT * FROM ship_judgment_job WHERE state='running' AND expires_at<=?",
					)
					.all(at) as JobRow[];
				for (const row of rows) {
					if (row.spawned_at) {
						this.insertEvaluation(
							row.input_id,
							{
								alignment: "undetermined",
								coverage: "undetermined",
								result: {},
								resultCode: "worker_lost",
								durationMs: Math.max(0, now - Date.parse(row.spawned_at)),
								usage: null,
								costUsd: null,
							},
							"{}",
							null,
							at,
						);
					}
					this.db
						.prepare(`UPDATE ship_judgment_job SET state=?,generation=generation+1,lease_owner=NULL,expires_at=NULL,
					reserved_at=NULL,finished_at=?,last_error=? WHERE input_id=? AND generation=?`)
						.run("failed", at, "worker_lost", row.input_id, row.generation);
				}
				return rows.length;
			})
			.immediate();
	}

	private insertEvaluation(
		inputId: string,
		result: JobResult,
		json: string,
		usage: string | null,
		at: string,
	): void {
		this.db
			.prepare(`INSERT INTO ship_judgment_evaluation(evaluation_id,input_id,alignment,coverage,result_json,result_code,created_at,duration_ms,usage_json,cost_usd)
			VALUES (?,?,?,?,?,?,?,?,?,?)`)
			.run(
				randomUUID(),
				inputId,
				result.alignment,
				result.coverage,
				json,
				result.resultCode,
				at,
				result.durationMs,
				usage,
				result.costUsd,
			);
	}
}
