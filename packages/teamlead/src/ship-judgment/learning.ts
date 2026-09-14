import type Database from "better-sqlite3";
import { z } from "zod";
import {
	JUDGMENT_VISIBLE_EVENT,
	type OverallVerdict,
	overallSchema,
} from "./contract.js";

type Decision = "approved" | "rework" | "canceled";
export type Relation = "aligned" | "divergent" | "abstained";
export function decisionRelation(
	machine: OverallVerdict,
	decision: Decision,
): Relation {
	if (machine === "can")
		return decision === "approved" ? "aligned" : "divergent";
	if (machine === "recommend_reject")
		return decision === "approved"
			? "divergent"
			: decision === "rework"
				? "aligned"
				: "abstained";
	return machine === "cannot" && decision === "approved"
		? "divergent"
		: "abstained";
}
export type Pairing =
	| {
			status: "paired";
			outcomeId: string;
			opinionId: string;
			overall: OverallVerdict;
			decision: Decision;
			relation: Relation;
			createdAt: string;
			visibleAt: string;
			decidedAt: string;
			readGapMs: number;
			policyVersion: string;
			modelSnapshotDigest: string;
	  }
	| {
			status:
				| "missing"
				| "retro"
				| "manual"
				| "unknown_author"
				| "unresolved_binding"
				| "refresh_pending"
				| "refresh_unknown"
				| "inactive"
				| "post_decision_override"
				| "duplicate_cancellation"
				| "timing_ambiguous"
				| "late"
				| "no_opinion"
				| "superseded";
	  };
interface Outcome {
	outcome_id: string;
	question_id: string;
	run_id: string;
	card_message_id: string;
	targets_digest: string;
	source_kind: string;
	authorship: string;
	decision: Decision;
	decided_at: string;
	evidence_json: string;
}

/** Reads only the new learning ledger and non-authoritative visibility receipts. Never changes a gate. */
export class ShipJudgmentLearning {
	constructor(private readonly db: Database.Database) {}
	pair(outcomeId: string, asOf = "9999-12-31T23:59:59.999Z"): Pairing {
		z.string().min(1).max(200).parse(outcomeId);
		const cutoff = new Date(
			z.string().datetime({ offset: true }).parse(asOf),
		).toISOString();
		return this.db.transaction(() => this.pairSnapshot(outcomeId, cutoff))();
	}
	private pairSnapshot(outcomeId: string, asOf: string): Pairing {
		const outcome = this.db
			.prepare(
				"SELECT * FROM ship_judgment_outcome WHERE outcome_id=? AND julianday(observed_at)<=julianday(?) AND julianday(decided_at)<=julianday(?)",
			)
			.get(outcomeId, asOf, asOf) as Outcome | undefined;
		if (!outcome) return { status: "missing" };
		if (outcome.source_kind === "retro") return { status: "retro" };
		if (outcome.source_kind === "lead_manual") return { status: "manual" };
		if (outcome.authorship !== "founder_verified")
			return { status: "unknown_author" };
		const decided = Date.parse(outcome.decided_at);
		if (!Number.isFinite(decided)) return { status: "timing_ambiguous" };
		const evidence = JSON.parse(outcome.evidence_json) as Record<
			string,
			unknown
		>;
		const cancellation = z
			.object({
				attribution_policy: z.literal("linear-canceled-closeout-run-v1"),
				linear_observation: z.object({
					issue_uuid: z.string().min(1),
					last_state_type: z.literal("canceled"),
					terminal_authorized: z.literal(1),
					last_linear_updated_at: z.string().datetime({ offset: true }),
				}),
			})
			.safeParse(evidence);
		const cancellationRoot =
			outcome.source_kind === "closeout" &&
			outcome.decision === "canceled" &&
			cancellation.success &&
			Date.parse(
				cancellation.data.linear_observation.last_linear_updated_at,
			) === decided
				? cancellation.data.linear_observation.issue_uuid
				: null;
		// Receipt retries remain immutable audit rows. Use their local append order
		// to keep the first receipt canonical without changing its earlier pairing.
		const sameCancellation = `COALESCE(run_id=? AND question_id=? AND card_message_id=?
 AND source_kind='closeout' AND decision='canceled' AND authorship='founder_verified' AND decided_at=?
 AND json_extract(evidence_json,'$.attribution_policy')='linear-canceled-closeout-run-v1'
 AND json_extract(evidence_json,'$.linear_observation.issue_uuid')=?,0)`;
		const episodeArgs = [
			outcome.run_id,
			outcome.question_id,
			outcome.card_message_id,
			outcome.decided_at,
			cancellationRoot,
		];
		if (cancellationRoot !== null) {
			const first = this.db
				.prepare(
					`SELECT outcome_id FROM ship_judgment_outcome WHERE ${sameCancellation} AND julianday(observed_at)<=julianday(?) ORDER BY rowid LIMIT 1`,
				)
				.get(...episodeArgs, asOf) as { outcome_id: string } | undefined;
			if (first && first.outcome_id !== outcomeId)
				return { status: "duplicate_cancellation" };
		}
		const earlier = this.db
			.prepare(`SELECT decided_at FROM ship_judgment_outcome WHERE question_id=? AND card_message_id=?
 AND authorship='founder_verified' AND source_kind NOT IN ('retro','lead_manual') AND outcome_id<>? AND decided_at<=? AND julianday(observed_at)<=julianday(?) AND NOT (${sameCancellation}) ORDER BY decided_at LIMIT 1`)
			.get(
				outcome.question_id,
				outcome.card_message_id,
				outcomeId,
				outcome.decided_at,
				asOf,
				...episodeArgs,
			) as { decided_at: string } | undefined;
		if (earlier)
			return {
				status:
					earlier.decided_at === outcome.decided_at
						? "timing_ambiguous"
						: "post_decision_override",
			};
		if (evidence.binding_status !== "resolved")
			return { status: "unresolved_binding" };
		if (evidence.refresh_history === "pending")
			return { status: "refresh_pending" };
		if (evidence.refresh_history === "inactive") return { status: "inactive" };
		if (evidence.refresh_history !== "clear")
			return { status: "refresh_unknown" };
		const match = this.db
			.prepare(`SELECT o.opinion_id,o.overall,o.created_at,v.created_at AS evaluated_at,i.policy_version,i.model_snapshot_digest,
 json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.receipt_time') AS visible_at
 FROM ship_judgment_opinion o JOIN ship_judgment_input i ON i.input_id=o.input_id
 LEFT JOIN ship_judgment_evaluation v ON v.evaluation_id=o.evaluation_id
 JOIN workflow_run_event e ON e.run_id=i.run_id AND e.kind=?
 AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.opinion_id')=o.opinion_id
 AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.question_id')=o.question_id
 WHERE o.question_id=? AND i.run_id=? AND i.card_message_id=? AND i.targets_digest=?
 AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.receipt_time')<=?
 AND julianday(o.created_at)<=julianday(?) AND julianday(i.requested_at)<=julianday(?)
 AND (v.created_at IS NULL OR julianday(v.created_at)<=julianday(?))
 AND julianday(COALESCE(json_extract(e.payload,'$.observed_at'),e.at))<=julianday(?)
 ORDER BY visible_at DESC,o.created_at DESC,o.ordinal DESC LIMIT 1`)
			.get(
				JUDGMENT_VISIBLE_EVENT,
				outcome.question_id,
				outcome.run_id,
				outcome.card_message_id,
				outcome.targets_digest,
				outcome.decided_at,
				asOf,
				asOf,
				asOf,
				asOf,
			) as
			| {
					opinion_id: string;
					overall: OverallVerdict;
					created_at: string;
					evaluated_at: string | null;
					policy_version: string;
					model_snapshot_digest: string;
					visible_at: string;
			  }
			| undefined;
		if (!match) {
			const matching = this.db
				.prepare(
					`SELECT 1 FROM ship_judgment_opinion o JOIN ship_judgment_input i ON i.input_id=o.input_id WHERE o.question_id=? AND i.targets_digest=? AND julianday(o.created_at)<=julianday(?) LIMIT 1`,
				)
				.get(outcome.question_id, outcome.targets_digest, asOf);
			if (matching) return { status: "late" };
			return {
				status: this.db
					.prepare(
						"SELECT 1 FROM ship_judgment_opinion WHERE question_id=? AND julianday(created_at)<=julianday(?) LIMIT 1",
					)
					.get(outcome.question_id, asOf)
					? "superseded"
					: "no_opinion",
			};
		}
		const visible = Date.parse(match.visible_at),
			created = Date.parse(match.created_at),
			evaluated = match.evaluated_at ? Date.parse(match.evaluated_at) : created;
		if (
			![visible, created, evaluated].every(Number.isFinite) ||
			visible >= decided ||
			created >= decided ||
			evaluated >= decided ||
			visible < created
		)
			return { status: "timing_ambiguous" };
		const overall = overallSchema.parse(match.overall);
		return {
			status: "paired",
			outcomeId,
			opinionId: match.opinion_id,
			overall,
			decision: outcome.decision,
			relation: decisionRelation(overall, outcome.decision),
			createdAt: match.created_at,
			visibleAt: match.visible_at,
			decidedAt: outcome.decided_at,
			readGapMs: decided - visible,
			policyVersion: match.policy_version,
			modelSnapshotDigest: match.model_snapshot_digest,
		};
	}
}
