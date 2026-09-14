import type Database from "better-sqlite3";
import { z } from "zod";
import {
	DELIVERY_ERROR_AUDIT_MIGRATION,
	JUDGMENT_DELIVERY_ERROR_EVENT,
	JUDGMENT_PROJECT,
	JUDGMENT_VISIBLE_EVENT,
	type OverallVerdict,
	overallSchema,
} from "./contract.js";
import { type Pairing, ShipJudgmentLearning } from "./learning.js";

type Paired = Extract<Pairing, { status: "paired" }>;
const decisions = ["approved", "rework", "canceled"] as const;
const ratio = (numerator: number, denominator: number) => ({
	numerator,
	denominator,
	value: denominator === 0 ? null : numerator / denominator,
});
export function matrixSummary(pairs: Pick<Paired, "overall" | "decision">[]) {
	const matrix = Object.fromEntries(
		overallSchema.options.map((overall) => [
			overall,
			Object.fromEntries(decisions.map((decision) => [decision, 0])),
		]),
	) as Record<OverallVerdict, Record<(typeof decisions)[number], number>>;
	for (const pair of pairs) matrix[pair.overall][pair.decision]++;
	const approved = overallSchema.options.reduce(
		(n, key) => n + matrix[key].approved,
		0,
	);
	const canceled = overallSchema.options.reduce(
		(n, key) => n + matrix[key].canceled,
		0,
	);
	return {
		pairs: pairs.length,
		matrix,
		rates: {
			canShareOfHumanApprovals: ratio(matrix.can.approved, approved),
			reworkAfterCan: ratio(
				matrix.can.rework,
				matrix.can.approved + matrix.can.rework,
			),
			cancellationAfterCan: ratio(
				matrix.can.canceled,
				matrix.can.approved + matrix.can.rework + matrix.can.canceled,
			),
			cancellationShare: ratio(canceled, pairs.length),
		},
	};
}
const utc = z
	.string()
	.datetime()
	.refine(
		(value) => new Date(value).toISOString() === value,
		"canonical UTC timestamp required",
	);
export const statisticsRangeSchema = z
	.object({
		from: utc,
		to: utc,
		asOf: utc,
		policyVersion: z.string().min(1).max(200).optional(),
		modelSnapshotDigest: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	})
	.strict()
	.refine((r) => r.from < r.to && r.to <= r.asOf, "require from < to <= asOf");
export type StatisticsRange = z.infer<typeof statisticsRangeSchema>;
const LIMIT = 10000;
const exclusionNames = [
	"missing",
	"retro",
	"manual",
	"unknown_author",
	"unresolved_binding",
	"refresh_pending",
	"refresh_unknown",
	"inactive",
	"post_decision_override",
	"duplicate_cancellation",
	"timing_ambiguous",
	"late",
	"no_opinion",
	"superseded",
	"version_filtered",
] as const;

/** One read snapshot. Decision window is [from,to), evidence is bounded by asOf. */
export class ShipJudgmentStatistics {
	constructor(private readonly db: Database.Database) {}
	read(input: StatisticsRange) {
		const range = statisticsRangeSchema.parse(input);
		return this.db.transaction(() => {
			const rows = this.db
				.prepare(`SELECT o.outcome_id,o.source_kind FROM ship_judgment_outcome o JOIN workflow_run r ON r.run_id=o.run_id
 WHERE r.project_name=? AND julianday(o.decided_at)>=julianday(?) AND julianday(o.decided_at)<julianday(?) AND julianday(o.observed_at)<=julianday(?) ORDER BY o.decided_at,o.outcome_id LIMIT ?`)
				.all(JUDGMENT_PROJECT, range.from, range.to, range.asOf, LIMIT + 1) as {
				outcome_id: string;
				source_kind: string;
			}[];
			if (rows.length > LIMIT)
				throw new Error("statistics_outcome_limit_exceeded_narrow_interval");
			const exclusions = Object.fromEntries(
				exclusionNames.map((name) => [name, 0]),
			) as Record<(typeof exclusionNames)[number], number>;
			const sources = {
				automaticObservation: 0,
				leadManual: 0,
				legacyRetro: 0,
			};
			const paired: Paired[] = [];
			const learning = new ShipJudgmentLearning(this.db);
			for (const row of rows) {
				sources[
					row.source_kind === "retro"
						? "legacyRetro"
						: row.source_kind === "lead_manual"
							? "leadManual"
							: "automaticObservation"
				]++;
				const pair = learning.pair(row.outcome_id, range.asOf);
				if (pair.status !== "paired") {
					exclusions[pair.status]++;
					continue;
				}
				if (
					(range.policyVersion && pair.policyVersion !== range.policyVersion) ||
					(range.modelSnapshotDigest &&
						pair.modelSnapshotDigest !== range.modelSnapshotDigest)
				) {
					exclusions.version_filtered++;
					continue;
				}
				paired.push(pair);
			}
			const versions = new Map<string, Paired[]>();
			for (const pair of paired) {
				const key = JSON.stringify([
					pair.policyVersion,
					pair.modelSnapshotDigest,
				]);
				const group = versions.get(key) ?? [];
				group.push(pair);
				versions.set(key, group);
			}
			// Inventory includes gate questions created, judged, or decided within
			// the window. It is deliberately unfiltered by model so missing input stays visible.
			const inventory = this.db
				.prepare(`SELECT h.question_id FROM workflow_gate_holder h JOIN workflow_run r ON r.run_id=h.run_id
 WHERE r.project_name=? AND julianday(h.created_at)<=julianday(?) AND (
 (julianday(h.created_at)>=julianday(?) AND julianday(h.created_at)<julianday(?)) OR
 EXISTS(SELECT 1 FROM ship_judgment_opinion p WHERE p.question_id=h.question_id AND julianday(p.created_at)>=julianday(?) AND julianday(p.created_at)<julianday(?)) OR
 EXISTS(SELECT 1 FROM ship_judgment_outcome o WHERE o.question_id=h.question_id AND julianday(o.decided_at)>=julianday(?) AND julianday(o.decided_at)<julianday(?) AND julianday(o.observed_at)<=julianday(?))) ORDER BY h.question_id LIMIT ?`)
				.all(
					JUDGMENT_PROJECT,
					range.asOf,
					range.from,
					range.to,
					range.from,
					range.to,
					range.from,
					range.to,
					range.asOf,
					LIMIT + 1,
				) as { question_id: string }[];
			if (inventory.length > LIMIT)
				throw new Error("statistics_card_limit_exceeded_narrow_interval");
			const cards = {
				total: inventory.length,
				noOpinion: 0,
				undetermined: 0,
				pendingHumanDecision: 0,
				deliveryUnconfirmed: 0,
			};
			const opinionQuery = this.db.prepare(
				"SELECT opinion_id,overall FROM ship_judgment_opinion WHERE question_id=? AND julianday(created_at)<=julianday(?) ORDER BY created_at DESC,ordinal DESC LIMIT 1",
			);
			const decidedQuery = this.db.prepare(
				"SELECT 1 FROM ship_judgment_outcome WHERE question_id=? AND source_kind NOT IN ('retro','lead_manual') AND authorship='founder_verified' AND julianday(decided_at)<=julianday(?) AND julianday(observed_at)<=julianday(?) LIMIT 1",
			);
			const visibleQuery = this.db.prepare(
				`SELECT 1 FROM workflow_run_event WHERE kind=? AND json_extract(payload,'$.opinion_id')=? AND json_extract(payload,'$.question_id')=? AND julianday(json_extract(payload,'$.receipt_time'))<=julianday(?) AND julianday(COALESCE(json_extract(payload,'$.observed_at'),at))<=julianday(?) LIMIT 1`,
			);
			for (const card of inventory) {
				const opinion = opinionQuery.get(card.question_id, range.asOf) as
					| { opinion_id: string; overall: OverallVerdict }
					| undefined;
				if (!opinion) cards.noOpinion++;
				else {
					if (opinion.overall === "undetermined") cards.undetermined++;
					if (
						!visibleQuery.get(
							JUDGMENT_VISIBLE_EVENT,
							opinion.opinion_id,
							card.question_id,
							range.asOf,
							range.asOf,
						)
					)
						cards.deliveryUnconfirmed++;
				}
				if (!decidedQuery.get(card.question_id, range.asOf, range.asOf))
					cards.pendingHumanDecision++;
			}
			const coverage = this.db
				.prepare(
					"SELECT applied_at FROM state_store_migration WHERE migration_id=?",
				)
				.get(DELIVERY_ERROR_AUDIT_MIGRATION) as
				| { applied_at: string }
				| undefined;
			const coveredFrom =
				coverage && utc.safeParse(coverage.applied_at).success
					? coverage.applied_at
					: null;
			const complete = coveredFrom !== null && coveredFrom <= range.from;
			const errors = this.db
				.prepare(`
 SELECT h.question_id,json_extract(e.payload,'$.certainty') AS certainty
 FROM workflow_run_event e
 JOIN workflow_run r ON r.run_id=e.run_id
 JOIN workflow_gate_holder h ON h.run_id=e.run_id AND h.question_id=json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.question_id')
 JOIN ship_judgment_opinion p ON p.question_id=h.question_id AND p.opinion_id=json_extract(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.opinion_id')
 WHERE e.kind=? AND r.project_name=? AND json_valid(e.payload)
 AND json_extract(e.payload,'$.action') IN ('post','patch')
 AND json_extract(e.payload,'$.certainty') IN ('failed','unknown')
 AND julianday(json_extract(e.payload,'$.observed_at'))>=julianday(?)
 AND julianday(json_extract(e.payload,'$.observed_at'))<julianday(?)
 AND julianday(json_extract(e.payload,'$.observed_at'))<=julianday(?)
 ORDER BY e.seq LIMIT ?`)
				.all(
					JUDGMENT_DELIVERY_ERROR_EVENT,
					JUDGMENT_PROJECT,
					range.from,
					range.to,
					range.asOf,
					LIMIT + 1,
				) as { question_id: string; certainty: "failed" | "unknown" }[];
			if (errors.length > LIMIT)
				throw new Error(
					"statistics_delivery_error_limit_exceeded_narrow_interval",
				);
			const failed = errors.filter((error) => error.certainty === "failed");
			const observedFailedCards = new Set(
				failed.map((error) => error.question_id),
			).size;
			const deliveryEvidence = {
				scope: "opinion_post_patch" as const,
				observedFailedCards,
				failedAttempts: failed.length,
				uncertainAttempts: errors.length - failed.length,
				coveredFrom,
				complete,
			};
			return {
				range,
				project: JUDGMENT_PROJECT,
				outcomeRecords: rows.length,
				sources,
				cards,
				exclusions,
				summary: matrixSummary(paired),
				versions: [...versions.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, group]) => ({
						policyVersion: group[0]!.policyVersion,
						modelSnapshotDigest: group[0]!.modelSnapshotDigest,
						...matrixSummary(group),
					})),
				deliveryFailureCount: complete ? observedFailedCards : null,
				deliveryEvidence,
				notes: [
					"Decision window [from,to); evidence received by asOf. Card inventory includes unposted gate questions and is unfiltered by version; exclusions count outcome receipts, not unique cards.",
					"Visibility does not prove the founder read the opinion. Action agreement is neither causality nor quality accuracy.",
					"Cancellation is excluded from the can-to-rework denominator. Zero denominators are not computable.",
					"Delivery failures count cards with confirmed opinion POST/PATCH failures in the window, including recovered attempts. Unknown responses are separate; history edits and clarification delivery are excluded. Intervals before audit installation have incomplete coverage.",
				],
			};
		})();
	}
}
