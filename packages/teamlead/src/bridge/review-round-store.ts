import type Database from "better-sqlite3";

/**
 * FLY-2891: durable per-round record of Claude-author local Codex reviews plus
 * the review gate's acceptance of the final APPROVED round.
 *
 * One round = one Codex turn, identified by
 * (execution_id, review_type, codex_thread_id, codex_turn_id). History is never
 * rewritten: a resubmission with identical core facts is an idempotent no-op,
 * a differing one is a conflict. The only mutation is the evidence backfill
 * (model unknown → rollout-proven model) and a NULL→value reviewed_target fill.
 */

export type ReviewRoundType = "design" | "code";
export type ReviewRoundVerdict = "APPROVED" | "CHANGES_REQUESTED";

export interface ReviewRoundFindings {
	critical?: number;
	high?: number;
	medium?: number;
	low?: number;
}

export interface ReviewRoundInsert {
	executionId: string;
	reviewType: ReviewRoundType;
	codexThreadId: string;
	codexTurnId: string;
	round: number;
	projectName: string;
	issueId?: string;
	runId?: string;
	nodeId?: string;
	authorVendor?: string;
	authorModel?: string;
	verdict: ReviewRoundVerdict;
	findings?: ReviewRoundFindings;
	observedModel?: string;
	observedEffort?: string;
	modelEvidence: "rollout_turn" | "unavailable";
	requiredModel?: string;
	requiredEffort?: string;
	/** Server-computed; null = no requirement or nothing observed. */
	modelMatch: 0 | 1 | null;
	requestId?: string;
	reviewedTarget?: string;
	reviewedPlanBlobSha?: string;
	reviewedHeadSha?: string;
	delivery: "http" | "spool";
	reviewedAt: string;
	receivedAt: string;
}

export interface ReviewGateAcceptanceInsert {
	executionId: string;
	reviewType: ReviewRoundType;
	codexThreadId: string;
	codexTurnId: string;
	finalRound: number;
	roundsTotal: number;
	observedModel: string;
	observedEffort: string;
	requiredModel?: string;
	requiredEffort?: string;
	requestId?: string;
	reviewedTarget: string;
	reviewedPlanBlobSha?: string;
	reviewedHeadSha?: string;
	projectName: string;
	runId?: string;
	nodeId?: string;
	acceptedAt: string;
	receivedAt: string;
}

export type ReviewRecordOutcome =
	| { outcome: "inserted" }
	| { outcome: "duplicate"; filled?: boolean }
	| { outcome: "backfilled" }
	| { outcome: "conflict"; reason: string };

export interface ReviewRoundRow {
	execution_id: string;
	review_type: ReviewRoundType;
	codex_thread_id: string;
	codex_turn_id: string;
	round: number;
	project_name: string;
	issue_id: string | null;
	run_id: string | null;
	node_id: string | null;
	author_vendor: string | null;
	author_model: string | null;
	verdict: ReviewRoundVerdict;
	findings_critical: number | null;
	findings_high: number | null;
	findings_medium: number | null;
	findings_low: number | null;
	observed_model: string | null;
	observed_effort: string | null;
	model_evidence: "rollout_turn" | "unavailable";
	required_model: string | null;
	required_effort: string | null;
	model_match: 0 | 1 | null;
	request_id: string | null;
	reviewed_target: string | null;
	reviewed_plan_blob_sha: string | null;
	reviewed_head_sha: string | null;
	delivery: "http" | "spool";
	reviewed_at: string;
	received_at: string;
}

export interface ReviewGateAcceptanceRow {
	execution_id: string;
	review_type: ReviewRoundType;
	codex_thread_id: string;
	codex_turn_id: string;
	final_round: number;
	rounds_total: number;
	observed_model: string;
	observed_effort: string;
	required_model: string | null;
	required_effort: string | null;
	request_id: string | null;
	reviewed_target: string;
	reviewed_plan_blob_sha: string | null;
	reviewed_head_sha: string | null;
	project_name: string;
	run_id: string | null;
	node_id: string | null;
	accepted_at: string;
	received_at: string;
}

const nullable = <T>(value: T | undefined): T | null =>
	value === undefined ? null : value;

/** Uses StateStore's existing connection; no separate database. */
export class ReviewRoundStore {
	constructor(private readonly db: Database.Database) {}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS review_round_record (
				execution_id           TEXT NOT NULL,
				review_type            TEXT NOT NULL CHECK(review_type IN ('design','code')),
				codex_thread_id        TEXT NOT NULL,
				codex_turn_id          TEXT NOT NULL,
				round                  INTEGER NOT NULL CHECK(round BETWEEN 1 AND 200),
				project_name           TEXT NOT NULL,
				issue_id               TEXT,
				run_id                 TEXT,
				node_id                TEXT,
				author_vendor          TEXT,
				author_model           TEXT,
				verdict                TEXT NOT NULL CHECK(verdict IN ('APPROVED','CHANGES_REQUESTED')),
				findings_critical      INTEGER,
				findings_high          INTEGER,
				findings_medium        INTEGER,
				findings_low           INTEGER,
				observed_model         TEXT,
				observed_effort        TEXT,
				model_evidence         TEXT NOT NULL CHECK(model_evidence IN ('rollout_turn','unavailable')),
				required_model         TEXT,
				required_effort        TEXT,
				model_match            INTEGER CHECK(model_match IN (0,1)),
				request_id             TEXT,
				reviewed_target        TEXT,
				reviewed_plan_blob_sha TEXT,
				reviewed_head_sha      TEXT,
				delivery               TEXT NOT NULL CHECK(delivery IN ('http','spool')),
				reviewed_at            TEXT NOT NULL,
				received_at            TEXT NOT NULL,
				PRIMARY KEY (execution_id, review_type, codex_thread_id, codex_turn_id)
			);
			CREATE UNIQUE INDEX IF NOT EXISTS uq_review_round_thread_round
				ON review_round_record(execution_id, review_type, codex_thread_id, round);
			CREATE INDEX IF NOT EXISTS idx_review_round_run ON review_round_record(run_id);
			CREATE TABLE IF NOT EXISTS review_gate_acceptance (
				execution_id           TEXT NOT NULL,
				review_type            TEXT NOT NULL CHECK(review_type IN ('design','code')),
				codex_thread_id        TEXT NOT NULL,
				codex_turn_id          TEXT NOT NULL,
				final_round            INTEGER NOT NULL CHECK(final_round BETWEEN 1 AND 200),
				rounds_total           INTEGER NOT NULL CHECK(rounds_total BETWEEN 1 AND 200),
				observed_model         TEXT NOT NULL,
				observed_effort        TEXT NOT NULL,
				required_model         TEXT,
				required_effort        TEXT,
				request_id             TEXT,
				reviewed_target        TEXT NOT NULL,
				reviewed_plan_blob_sha TEXT,
				reviewed_head_sha      TEXT,
				project_name           TEXT NOT NULL,
				run_id                 TEXT,
				node_id                TEXT,
				accepted_at            TEXT NOT NULL,
				received_at            TEXT NOT NULL,
				PRIMARY KEY (execution_id, review_type, codex_turn_id)
			);
		`);
	}

	getRound(key: {
		executionId: string;
		reviewType: ReviewRoundType;
		codexThreadId: string;
		codexTurnId: string;
	}): ReviewRoundRow | undefined {
		return this.db
			.prepare(
				`SELECT * FROM review_round_record
				  WHERE execution_id = ? AND review_type = ?
				    AND codex_thread_id = ? AND codex_turn_id = ?`,
			)
			.get(
				key.executionId,
				key.reviewType,
				key.codexThreadId,
				key.codexTurnId,
			) as ReviewRoundRow | undefined;
	}

	recordRound(input: ReviewRoundInsert): ReviewRecordOutcome {
		return this.db.transaction((): ReviewRecordOutcome => {
			const existing = this.getRound(input);
			if (!existing) {
				const clash = this.db
					.prepare(
						`SELECT codex_turn_id FROM review_round_record
						  WHERE execution_id = ? AND review_type = ?
						    AND codex_thread_id = ? AND round = ?`,
					)
					.get(
						input.executionId,
						input.reviewType,
						input.codexThreadId,
						input.round,
					) as { codex_turn_id: string } | undefined;
				if (clash)
					return {
						outcome: "conflict",
						reason: `round ${input.round} of thread ${input.codexThreadId} is already recorded for turn ${clash.codex_turn_id}`,
					};
				this.db
					.prepare(
						`INSERT INTO review_round_record (
							execution_id, review_type, codex_thread_id, codex_turn_id, round,
							project_name, issue_id, run_id, node_id, author_vendor, author_model,
							verdict, findings_critical, findings_high, findings_medium, findings_low,
							observed_model, observed_effort, model_evidence, required_model,
							required_effort, model_match, request_id, reviewed_target,
							reviewed_plan_blob_sha, reviewed_head_sha, delivery, reviewed_at, received_at
						) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
					)
					.run(
						input.executionId,
						input.reviewType,
						input.codexThreadId,
						input.codexTurnId,
						input.round,
						input.projectName,
						nullable(input.issueId),
						nullable(input.runId),
						nullable(input.nodeId),
						nullable(input.authorVendor),
						nullable(input.authorModel),
						input.verdict,
						nullable(input.findings?.critical),
						nullable(input.findings?.high),
						nullable(input.findings?.medium),
						nullable(input.findings?.low),
						nullable(input.observedModel),
						nullable(input.observedEffort),
						input.modelEvidence,
						nullable(input.requiredModel),
						nullable(input.requiredEffort),
						input.modelMatch,
						nullable(input.requestId),
						nullable(input.reviewedTarget),
						nullable(input.reviewedPlanBlobSha),
						nullable(input.reviewedHeadSha),
						input.delivery,
						input.reviewedAt,
						input.receivedAt,
					);
				return { outcome: "inserted" };
			}
			const differs: string[] = [];
			if (existing.round !== input.round) differs.push("round");
			if (existing.verdict !== input.verdict) differs.push("verdict");
			if (
				existing.reviewed_plan_blob_sha !== nullable(input.reviewedPlanBlobSha)
			)
				differs.push("reviewedPlanBlobSha");
			if (existing.reviewed_head_sha !== nullable(input.reviewedHeadSha))
				differs.push("reviewedHeadSha");
			if (
				existing.observed_model !== null &&
				input.observedModel !== undefined &&
				existing.observed_model !== input.observedModel
			)
				differs.push("observedModel");
			if (
				existing.observed_effort !== null &&
				input.observedEffort !== undefined &&
				existing.observed_effort !== input.observedEffort
			)
				differs.push("observedEffort");
			if (differs.length > 0)
				return {
					outcome: "conflict",
					reason: `review round ${input.codexTurnId} already recorded with different ${differs.join(", ")}`,
				};
			const fillTarget =
				existing.reviewed_target === null && input.reviewedTarget !== undefined;
			if (
				existing.model_evidence === "unavailable" &&
				input.modelEvidence === "rollout_turn"
			) {
				this.db
					.prepare(
						`UPDATE review_round_record
						    SET observed_model = COALESCE(observed_model, ?),
						        observed_effort = COALESCE(observed_effort, ?),
						        model_evidence = 'rollout_turn',
						        model_match = ?,
						        reviewed_target = COALESCE(reviewed_target, ?)
						  WHERE execution_id = ? AND review_type = ?
						    AND codex_thread_id = ? AND codex_turn_id = ?`,
					)
					.run(
						nullable(input.observedModel),
						nullable(input.observedEffort),
						input.modelMatch,
						nullable(input.reviewedTarget),
						input.executionId,
						input.reviewType,
						input.codexThreadId,
						input.codexTurnId,
					);
				return { outcome: "backfilled" };
			}
			if (fillTarget) {
				this.db
					.prepare(
						`UPDATE review_round_record SET reviewed_target = ?
						  WHERE execution_id = ? AND review_type = ?
						    AND codex_thread_id = ? AND codex_turn_id = ?`,
					)
					.run(
						input.reviewedTarget,
						input.executionId,
						input.reviewType,
						input.codexThreadId,
						input.codexTurnId,
					);
				return { outcome: "duplicate", filled: true };
			}
			return { outcome: "duplicate" };
		})();
	}

	getGateAcceptance(key: {
		executionId: string;
		reviewType: ReviewRoundType;
		codexTurnId: string;
	}): ReviewGateAcceptanceRow | undefined {
		return this.db
			.prepare(
				`SELECT * FROM review_gate_acceptance
				  WHERE execution_id = ? AND review_type = ? AND codex_turn_id = ?`,
			)
			.get(key.executionId, key.reviewType, key.codexTurnId) as
			| ReviewGateAcceptanceRow
			| undefined;
	}

	recordGateAcceptance(input: ReviewGateAcceptanceInsert): ReviewRecordOutcome {
		return this.db.transaction((): ReviewRecordOutcome => {
			const existing = this.getGateAcceptance(input);
			if (!existing) {
				this.db
					.prepare(
						`INSERT INTO review_gate_acceptance (
							execution_id, review_type, codex_thread_id, codex_turn_id,
							final_round, rounds_total, observed_model, observed_effort,
							required_model, required_effort, request_id, reviewed_target,
							reviewed_plan_blob_sha, reviewed_head_sha, project_name, run_id,
							node_id, accepted_at, received_at
						) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
					)
					.run(
						input.executionId,
						input.reviewType,
						input.codexThreadId,
						input.codexTurnId,
						input.finalRound,
						input.roundsTotal,
						input.observedModel,
						input.observedEffort,
						nullable(input.requiredModel),
						nullable(input.requiredEffort),
						nullable(input.requestId),
						input.reviewedTarget,
						nullable(input.reviewedPlanBlobSha),
						nullable(input.reviewedHeadSha),
						input.projectName,
						nullable(input.runId),
						nullable(input.nodeId),
						input.acceptedAt,
						input.receivedAt,
					);
				return { outcome: "inserted" };
			}
			// Stable business facts only; accepted_at/received_at and the
			// server-derived required/project/run/node columns never compare.
			const pairs: Array<[string, unknown, unknown]> = [
				["codexThreadId", existing.codex_thread_id, input.codexThreadId],
				["finalRound", existing.final_round, input.finalRound],
				["roundsTotal", existing.rounds_total, input.roundsTotal],
				["observedModel", existing.observed_model, input.observedModel],
				["observedEffort", existing.observed_effort, input.observedEffort],
				["requestId", existing.request_id, nullable(input.requestId)],
				["reviewedTarget", existing.reviewed_target, input.reviewedTarget],
				[
					"reviewedPlanBlobSha",
					existing.reviewed_plan_blob_sha,
					nullable(input.reviewedPlanBlobSha),
				],
				[
					"reviewedHeadSha",
					existing.reviewed_head_sha,
					nullable(input.reviewedHeadSha),
				],
			];
			const differs = pairs
				.filter(([, left, right]) => left !== right)
				.map(([name]) => name);
			if (differs.length > 0)
				return {
					outcome: "conflict",
					reason: `gate acceptance for turn ${input.codexTurnId} already recorded with different ${differs.join(", ")}`,
				};
			return { outcome: "duplicate" };
		})();
	}

	listRoundsForExecutions(executionIds: readonly string[]): ReviewRoundRow[] {
		if (executionIds.length === 0) return [];
		return this.db
			.prepare(
				`SELECT * FROM review_round_record
				  WHERE execution_id IN (${executionIds.map(() => "?").join(",")})
				  ORDER BY reviewed_at, execution_id, review_type, codex_thread_id, round`,
			)
			.all(...executionIds) as ReviewRoundRow[];
	}

	listGateAcceptancesForExecutions(
		executionIds: readonly string[],
	): ReviewGateAcceptanceRow[] {
		if (executionIds.length === 0) return [];
		return this.db
			.prepare(
				`SELECT * FROM review_gate_acceptance
				  WHERE execution_id IN (${executionIds.map(() => "?").join(",")})
				  ORDER BY accepted_at, received_at`,
			)
			.all(...executionIds) as ReviewGateAcceptanceRow[];
	}
}
