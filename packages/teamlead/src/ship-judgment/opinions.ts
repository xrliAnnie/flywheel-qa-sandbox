import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
	aggregateJudgment,
	canonicalDigest,
	opinionCandidateSchema,
	type PointVerdict,
	type ShipJudgmentBinding,
} from "./contract.js";
import { ShipJudgmentInputs } from "./inputs.js";

export type OfferResult =
	| { status: "created"; opinionId: string }
	| {
			status:
				| "unchanged"
				| "deferred"
				| "binding_changed"
				| "mechanical_stale"
				| "candidate_budget_exceeded";
	  };
interface EvaluationRow {
	evaluation_id: string;
	alignment: PointVerdict;
	coverage: PointVerdict;
	result_json: string;
}
interface OpinionRow {
	opinion_id: string;
	presentation_digest: string;
	created_at: string;
	ordinal: number;
}

export class ShipJudgmentOpinions {
	constructor(
		private readonly db: Database.Database,
		private readonly readBinding: (
			questionId: string,
			channelId: string,
		) => ShipJudgmentBinding | undefined,
	) {}

	/** Called with a freshly revalidated mechanical snapshot, including when promoting a pending candidate. */
	offer(value: unknown, now: number): OfferResult {
		const candidate = opinionCandidateSchema.parse(value);
		const at = new Date(now).toISOString();
		const age = now - Date.parse(candidate.mechanical.checkedAt);
		if (age < 0 || age > 60_000) return { status: "mechanical_stale" };
		const json = JSON.stringify(candidate);
		if (Buffer.byteLength(json) > 98_304)
			return { status: "candidate_budget_exceeded" };
		return this.db
			.transaction((): OfferResult => {
				const binding = this.readBinding(
					candidate.questionId,
					candidate.channelId,
				);
				if (!binding || canonicalDigest(binding) !== candidate.bindingDigest)
					return { status: "binding_changed" };
				let evaluation: EvaluationRow | undefined;
				const delivery = this.db
					.prepare(
						"SELECT card_message_id,thread_id FROM ship_judgment_delivery WHERE purpose='opinion' AND subject_id=?",
					)
					.get(candidate.questionId) as
					| { card_message_id: string; thread_id: string }
					| undefined;
				if (
					delivery &&
					(delivery.card_message_id !== binding.cardMessageId ||
						delivery.thread_id !== binding.threadId)
				)
					return { status: "binding_changed" };
				if (candidate.inputId) {
					const input = new ShipJudgmentInputs(this.db, this.readBinding).get(
						candidate.inputId,
					);
					if (
						!input ||
						input.questionId !== candidate.questionId ||
						input.bindingDigest !== candidate.bindingDigest
					)
						return { status: "binding_changed" };
					const latest = this.db
						.prepare(
							"SELECT MAX(semantic_ordinal) AS ordinal FROM ship_judgment_input WHERE question_id=?",
						)
						.get(candidate.questionId) as { ordinal: number };
					if (latest.ordinal !== input.ordinal)
						return { status: "binding_changed" };
					evaluation = this.db
						.prepare(
							"SELECT evaluation_id,alignment,coverage,result_json FROM ship_judgment_evaluation WHERE input_id=?",
						)
						.get(candidate.inputId) as EvaluationRow | undefined;
				}
				const alignment = evaluation?.alignment ?? "undetermined";
				const coverage = evaluation?.coverage ?? "undetermined";
				const overall = aggregateJudgment(
					alignment,
					candidate.mechanical.verdict,
					coverage,
				);
				const {
					checkedAt: _checkedAt,
					digest: _digest,
					...displayMechanical
				} = candidate.mechanical;
				const presentationDigest = canonicalDigest({
					inputId: candidate.inputId,
					evaluationId: evaluation?.evaluation_id ?? null,
					semanticEvidence: evaluation
						? JSON.parse(evaluation.result_json)
						: null,
					mechanical: displayMechanical,
					alignment,
					coverage,
					overall,
					reason: candidate.reason,
				});
				const latest = this.db
					.prepare(
						"SELECT opinion_id,presentation_digest,created_at,ordinal FROM ship_judgment_opinion WHERE question_id=? ORDER BY ordinal DESC LIMIT 1",
					)
					.get(candidate.questionId) as OpinionRow | undefined;
				if (latest?.presentation_digest === presentationDigest) {
					this.db
						.prepare(`UPDATE ship_judgment_delivery SET latest_candidate_json=NULL,latest_candidate_digest=NULL,next_eligible_at=NULL,
					presentation_state_changed_at=CASE WHEN latest_candidate_digest IS NOT NULL OR (dirty_since IS NOT NULL AND posted_id=desired_id) THEN ? ELSE presentation_state_changed_at END,
 dirty_since=CASE WHEN posted_id=desired_id THEN NULL ELSE dirty_since END,validated_presentation_digest=?,validated_at=? WHERE purpose='opinion' AND subject_id=?`)
						.run(
							at,
							presentationDigest,
							candidate.mechanical.checkedAt,
							candidate.questionId,
						);
					return { status: "unchanged" };
				}
				this.db
					.prepare(`INSERT OR IGNORE INTO ship_judgment_delivery(purpose,subject_id,question_id,thread_id,card_message_id,state,marker)
				VALUES ('opinion',?,?,?,?, 'pending',?)`)
					.run(
						candidate.questionId,
						candidate.questionId,
						binding.threadId,
						binding.cardMessageId,
						`ship-judgment:${candidate.questionId}`,
					);
				const recent = this.db
					.prepare(
						"SELECT created_at FROM ship_judgment_opinion WHERE question_id=? AND created_at>? ORDER BY created_at",
					)
					.all(
						candidate.questionId,
						new Date(now - 3_600_000).toISOString(),
					) as { created_at: string }[];
				const next = Math.max(
					latest ? Date.parse(latest.created_at) + 600_000 : now,
					recent.length >= 6
						? Date.parse(recent[0]!.created_at) + 3_600_000
						: now,
				);
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET latest_candidate_json=?,latest_candidate_digest=?,dirty_since=COALESCE(dirty_since,?),next_eligible_at=?,validated_presentation_digest=NULL,validated_at=NULL,presentation_state_changed_at=?
				WHERE purpose='opinion' AND subject_id=?`)
					.run(
						json,
						presentationDigest,
						at,
						new Date(next).toISOString(),
						at,
						candidate.questionId,
					);
				if (next > now) return { status: "deferred" };
				const opinionId = randomUUID();
				this.db
					.prepare(`INSERT INTO ship_judgment_opinion(opinion_id,question_id,input_id,evaluation_id,ordinal,mechanical_json,mechanical_digest,presentation_digest,
				alignment,conflict,coverage,overall,status,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
					.run(
						opinionId,
						candidate.questionId,
						candidate.inputId,
						evaluation?.evaluation_id ?? null,
						(latest?.ordinal ?? 0) + 1,
						JSON.stringify({ ...candidate.mechanical, binding }),
						candidate.mechanical.digest,
						presentationDigest,
						alignment,
						candidate.mechanical.verdict,
						coverage,
						overall,
						overall === "undetermined" ? "undetermined" : "complete",
						candidate.reason,
						at,
					);
				this.db
					.prepare(`UPDATE ship_judgment_delivery SET desired_id=?,validated_presentation_digest=?,validated_at=?,generation=generation+1,
				state=CASE WHEN state IN ('posting','uncertain') AND message_id IS NULL THEN 'uncertain' ELSE 'pending' END,
				lease_owner=NULL,expires_at=NULL,latest_candidate_json=NULL,latest_candidate_digest=NULL,next_eligible_at=NULL
				WHERE purpose='opinion' AND subject_id=?`)
					.run(
						opinionId,
						presentationDigest,
						candidate.mechanical.checkedAt,
						candidate.questionId,
					);
				return { status: "created", opinionId };
			})
			.immediate();
	}
}
