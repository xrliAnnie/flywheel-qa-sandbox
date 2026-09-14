import type Database from "better-sqlite3";
import { z } from "zod";
import { JUDGMENT_PROJECT, POLICY_VERSION } from "./contract.js";

const id = z.string().min(1).max(200);
export const showQuerySchema = z
	.object({
		project: z.literal(JUDGMENT_PROJECT),
		question: id.optional(),
		id: z.string().min(1).max(240).optional(),
	})
	.strict()
	.refine(
		(value) => Boolean(value.question) !== Boolean(value.id),
		"exactly one question or id required",
	);
export type ShowQuery = z.infer<typeof showQuerySchema>;
type Row = Record<string, unknown>;
const readers = [
	{
		kind: "auto_narrow_decision",
		table: "auto_narrow_decision_audit",
		key: "source_event_id",
		question: "question_id",
		at: "decision_at",
	},
	{
		kind: "input",
		table: "ship_judgment_input",
		key: "input_id",
		question: "question_id",
		at: "requested_at",
	},
	{
		kind: "evaluation",
		table: "ship_judgment_evaluation",
		key: "evaluation_id",
		question:
			"(SELECT question_id FROM ship_judgment_input WHERE input_id=t.input_id)",
		at: "created_at",
	},
	{
		kind: "opinion",
		table: "ship_judgment_opinion",
		key: "opinion_id",
		question: "question_id",
		at: "created_at",
	},
	{
		kind: "outcome",
		table: "ship_judgment_outcome",
		key: "outcome_id",
		question: "question_id",
		at: "observed_at",
	},
	{
		kind: "clarification",
		table: "ship_judgment_clarification",
		key: "clarification_id",
		question:
			"(SELECT question_id FROM ship_judgment_opinion WHERE opinion_id=t.opinion_id)",
		at: "verified_at",
	},
] as const;
const source = (row: Row) =>
	row.decision_source === "auto_narrow_gate" ||
	row.source_kind === "auto_narrow_gate"
		? "auto_narrow_gate"
		: row.source_kind === "retro"
			? "legacy_retro"
			: row.source_kind === "lead_manual"
				? "lead_manual"
				: "machine";
const MAX_RECORDS = 1000;
const MAX_BYTES = 1024 * 1024;
/** SELECT-only audit lookup. Fixed table/column names; all external selectors are bound. */
export class ShipJudgmentReader {
	constructor(private readonly db: Database.Database) {}
	show(value: ShowQuery) {
		const query = showQuerySchema.parse(value);
		return this.db.transaction(() => {
			let question = query.question;
			let record:
				| { kind: string; id: string; source: string; data: Row }
				| undefined;
			if (query.id) {
				for (const reader of readers) {
					const row = this.db
						.prepare(
							`SELECT t.*,${reader.question} AS bound_question FROM ${reader.table} t WHERE t.${reader.key}=?${reader.kind === "auto_narrow_decision" ? " AND t.project_name='flywheel'" : ""}`,
						)
						.get(query.id) as Row | undefined;
					if (!row) continue;
					if (record) throw new Error("ambiguous_audit_id");
					question = String(row.bound_question);
					delete row.bound_question;
					record = {
						kind: reader.kind,
						id: query.id,
						source: source(row),
						data: row,
					};
				}
				if (!record) return null;
			}
			const card = this.db
				.prepare(
					"SELECT h.question_id,h.run_id,h.card_message_id,r.issue_id FROM workflow_gate_holder h JOIN workflow_run r ON r.run_id=h.run_id WHERE h.question_id=? AND r.project_name=?",
				)
				.get(question, JUDGMENT_PROJECT) as Row | undefined;
			if (!card) return null;
			const envelope = {
				schema_version: 1,
				project: JUDGMENT_PROJECT,
				policy: POLICY_VERSION,
				questionId: question!,
				card,
			};
			if (record) {
				const result = { ...envelope, record };
				if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_BYTES)
					throw new Error("audit_record_size_exceeded");
				return result;
			}
			const records: {
				kind: string;
				id: string;
				source: string;
				at: unknown;
			}[] = [];
			for (const reader of readers) {
				const sourceColumn =
					reader.kind === "outcome"
						? "source_kind"
						: reader.kind === "auto_narrow_decision"
							? "decision_source AS source_kind"
							: "NULL AS source_kind";
				const rows = this.db
					.prepare(
						`SELECT ${reader.key} AS id,${reader.at} AS at,${sourceColumn} FROM ${reader.table} t WHERE ${reader.question}=?${reader.kind === "auto_narrow_decision" ? " AND t.project_name='flywheel'" : ""} ORDER BY ${reader.key} LIMIT ?`,
					)
					.all(question, MAX_RECORDS + 1) as Row[];
				for (const row of rows)
					records.push({
						kind: reader.kind,
						id: String(row.id),
						source: source(row),
						at: row.at,
					});
				if (records.length > MAX_RECORDS)
					throw new Error("audit_card_record_limit_exceeded_use_id");
			}
			return { ...envelope, records };
		})();
	}
}
