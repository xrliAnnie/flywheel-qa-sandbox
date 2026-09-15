import type Database from "better-sqlite3";
import { z } from "zod";
import { evidenceSummaryText } from "./evidence-labels.js";
import { evidenceLedgerSchema } from "./evidence-ledger.js";
import {
	type HistoryRow,
	historyContentDigest,
	historyRowSchema,
} from "./history-pages.js";
import { ShipJudgmentLearning } from "./learning.js";

const asOfSchema = z
	.string()
	.datetime()
	.refine((value) => new Date(value).toISOString() === value);
const LIMIT = 10000;
type Outcome = {
	outcome_id: string;
	decision: HistoryRow["decision"];
	authorship: HistoryRow["authorship"];
	source_kind: string;
	decided_at: string;
	observed_at: string;
	card_message_id: string;
};
const source = (kind: string): HistoryRow["source"] =>
	kind === "retro"
		? "legacy_retro"
		: kind === "lead_manual"
			? "lead_manual"
			: "machine";
/** Independent project-wide snapshot: no active-Epic membership or network dependency. */
export class ShipJudgmentHistory {
	constructor(private readonly db: Database.Database) {}
	read(input: string) {
		const asOf = asOfSchema.parse(input),
			from = new Date(Date.parse(asOf) - 30 * 86400000).toISOString();
		return this.db.transaction(() => {
			const cards = this.db
				.prepare(`
 WITH activity AS (
 SELECT question_id,created_at AS at FROM workflow_gate_holder
 UNION ALL SELECT question_id,created_at FROM ship_judgment_opinion
 UNION ALL SELECT question_id,decided_at FROM ship_judgment_outcome WHERE julianday(observed_at)<=julianday(@asOf)
 UNION ALL SELECT question_id,decision_at FROM auto_narrow_decision_audit WHERE project_name='flywheel'
 UNION ALL SELECT o.question_id,c.verified_at FROM ship_judgment_clarification c
 JOIN ship_judgment_outcome o ON o.outcome_id=c.outcome_id JOIN ship_judgment_opinion p ON p.opinion_id=c.opinion_id
 WHERE c.resolution='explained' AND julianday(o.observed_at)<=julianday(@asOf) AND julianday(o.decided_at)<=julianday(@asOf) AND julianday(p.created_at)<=julianday(@asOf)
 )
 SELECT h.question_id,h.run_id,h.card_message_id,r.issue_id,MAX(julianday(a.at)) AS activity
 FROM activity a JOIN workflow_gate_holder h ON h.question_id=a.question_id JOIN workflow_run r ON r.run_id=h.run_id
 WHERE r.project_name='flywheel' AND julianday(h.created_at)<=julianday(@asOf)
 AND julianday(a.at)>=julianday(@from) AND julianday(a.at)<=julianday(@asOf)
 GROUP BY h.question_id ORDER BY activity DESC,h.question_id LIMIT @limit
 `)
				.all({ asOf, from, limit: LIMIT + 1 }) as {
				question_id: string;
				run_id: string;
				card_message_id: string | null;
				issue_id: string;
				activity: number;
			}[];
			if (cards.length > LIMIT) throw new Error("history_card_limit_exceeded");
			const learning = new ShipJudgmentLearning(this.db);
			const rows: HistoryRow[] = [];
			for (const card of cards) {
				const opinion = this.db
					.prepare(
						"SELECT opinion_id,overall,reason,created_at,evidence_json FROM ship_judgment_opinion WHERE question_id=? AND julianday(created_at)<=julianday(?) ORDER BY julianday(created_at) DESC,ordinal DESC LIMIT 1",
					)
					.get(card.question_id, asOf) as
					| {
							opinion_id: string;
							overall: HistoryRow["overall"];
							reason: string;
							evidence_json: string | null;
							created_at: string;
					  }
					| undefined;
				const outcome = this.db
					.prepare(
						"SELECT outcome_id,decision,authorship,source_kind,decided_at,observed_at,card_message_id FROM ship_judgment_outcome WHERE question_id=? AND julianday(decided_at)<=julianday(?) AND julianday(observed_at)<=julianday(?) ORDER BY julianday(decided_at) DESC,outcome_id DESC LIMIT 1",
					)
					.get(card.question_id, asOf, asOf) as Outcome | undefined;
				const auto = this.db
					.prepare(
						"SELECT source_event_id,decision_at FROM auto_narrow_decision_audit WHERE question_id=? AND project_name='flywheel' AND julianday(decision_at)<=julianday(?) LIMIT 1",
					)
					.get(card.question_id, asOf) as
					| { source_event_id: string; decision_at: string }
					| undefined;
				const useAuto =
					auto &&
					(!outcome ||
						Date.parse(auto.decision_at) > Date.parse(outcome.decided_at));
				const explanation = this.db
					.prepare(`
 SELECT c.clarification_id,c.verified_at,c.outcome_id FROM ship_judgment_clarification c
 JOIN ship_judgment_outcome o ON o.outcome_id=c.outcome_id JOIN ship_judgment_opinion p ON p.opinion_id=c.opinion_id
 WHERE o.question_id=@question AND c.resolution='explained' AND julianday(c.verified_at)<=julianday(@asOf)
 AND julianday(o.observed_at)<=julianday(@asOf) AND julianday(o.decided_at)<=julianday(@asOf) AND julianday(p.created_at)<=julianday(@asOf)
 ORDER BY julianday(c.verified_at) DESC,c.clarification_id DESC LIMIT 1
 `)
					.get({ question: card.question_id, asOf }) as
					| {
							clarification_id: string;
							verified_at: string;
							outcome_id: string;
					  }
					| undefined;
				const pair =
					outcome && !useAuto
						? learning.pair(outcome.outcome_id, asOf)
						: undefined;
				const pendingRoots = this.db
					.prepare(`
 SELECT DISTINCT o.outcome_id FROM ship_judgment_clarification c
 JOIN ship_judgment_outcome o ON o.outcome_id=c.outcome_id JOIN ship_judgment_opinion p ON p.opinion_id=c.opinion_id
 WHERE o.question_id=@question AND p.question_id=@question AND c.supersedes IS NULL
 AND julianday(o.observed_at)<=julianday(@asOf) AND julianday(o.decided_at)<=julianday(@asOf) AND julianday(p.created_at)<=julianday(@asOf)
 AND NOT EXISTS(SELECT 1 FROM ship_judgment_clarification reply WHERE reply.supersedes=c.clarification_id AND reply.resolution='explained' AND julianday(reply.verified_at)<=julianday(@asOf))
 LIMIT 1001
 `)
					.all({ question: card.question_id, asOf }) as {
					outcome_id: string;
				}[];
				if (pendingRoots.length > 1000)
					throw new Error("history_clarification_limit_exceeded");
				const pendingHistorical = pendingRoots.some((root) => {
					const original = learning.pair(root.outcome_id, asOf);
					return (
						original.status === "paired" && original.relation === "divergent"
					);
				});
				const frozen = this.db
					.prepare(
						"SELECT thread_id,card_message_id FROM ship_judgment_input WHERE question_id=? AND julianday(requested_at)<=julianday(?) ORDER BY semantic_ordinal DESC LIMIT 1",
					)
					.get(card.question_id, asOf) as
					| { thread_id: string; card_message_id: string }
					| undefined;
				const threads = this.db
					.prepare(
						"SELECT thread_id FROM chat_threads WHERE issue_id=? LIMIT 2",
					)
					.all(card.issue_id) as { thread_id: string }[];
				const thread =
					frozen?.thread_id ??
					(threads.length === 1 ? threads[0]!.thread_id : null);
				const message =
					frozen?.card_message_id ??
					outcome?.card_message_id ??
					card.card_message_id;
				const validId = (value: string | null | undefined) =>
					Boolean(value && /^\d{17,20}$/.test(value));
				const clocks = [
					opinion?.created_at,
					outcome?.observed_at,
					useAuto ? auto?.decision_at : undefined,
					explanation?.verified_at,
				].filter((value): value is string => Boolean(value));
				const updatedAt = clocks.length
					? new Date(Math.max(...clocks.map(Date.parse))).toISOString()
					: new Date((card.activity - 2440587.5) * 86400000).toISOString();
				rows.push(
					historyRowSchema.parse({
						questionId: card.question_id,
						issue: card.issue_id,
						auditId:
							opinion?.opinion_id ??
							(useAuto ? auto!.source_event_id : (outcome?.outcome_id ?? null)),
						source: opinion
							? "machine"
							: useAuto
								? "auto_narrow_gate"
								: outcome
									? source(outcome.source_kind)
									: "machine",
						overall: opinion?.overall ?? null,
						decision: useAuto ? "approved" : (outcome?.decision ?? null),
						decisionSource: useAuto
							? "auto_narrow_gate"
							: outcome
								? source(outcome.source_kind)
								: "machine",
						decisionAuditId: useAuto
							? auto!.source_event_id
							: (outcome?.outcome_id ?? null),
						authorship: useAuto ? "auto" : (outcome?.authorship ?? "unknown"),
						clarification:
							pendingHistorical ||
							(pair?.status === "paired" &&
								pair.relation === "divergent" &&
								explanation?.outcome_id !== outcome?.outcome_id)
								? "pending"
								: explanation
									? "explained"
									: "none",
						clarificationAuditId: explanation?.clarification_id ?? null,
						summary: opinion?.evidence_json
							? evidenceSummaryText(
									evidenceLedgerSchema.parse(JSON.parse(opinion.evidence_json)),
								)
							: (opinion?.reason ?? ""),
						cardUrl:
							validId(thread) && validId(message)
								? `https://discord.com/channels/@me/${thread}/${message}`
								: null,
						updatedAt,
					}),
				);
			}
			return { asOf, from, rows, digest: historyContentDigest(rows) };
		})();
	}
}
