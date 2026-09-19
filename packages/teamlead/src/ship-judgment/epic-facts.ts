import type Database from "better-sqlite3";
import { z } from "zod";
import { overallSchema, POLICY_VERSION, verdictSchema } from "./contract.js";
import { evidenceSummary, evidenceSummarySchema } from "./evidence-labels.js";
import { evidenceLedgerSchema } from "./evidence-ledger.js";

// Keep the page document bounded independently of HTML/attention budgets.
// Full records remain available through the existing evaluation/opinion audit IDs.
const EVIDENCE_PART_BYTES = 960;
function pageEvidence(
	raw: string | null | undefined,
	auditId: string | null | undefined,
): unknown {
	if (!raw) return null;
	const bytes = Buffer.byteLength(raw, "utf8");
	return bytes <= EVIDENCE_PART_BYTES
		? JSON.parse(raw)
		: { truncated: true, original_bytes: bytes, audit_id: auditId };
}
export const epicJudgmentSchema = z
	.object({
		question_id: z.string().min(1).max(200),
		opinion_id: z.string().nullable(),
		input_id: z.string().nullable(),
		evaluation_id: z.string().nullable(),
		source: z.literal("machine"),
		overall: overallSchema.nullable(),
		alignment: verdictSchema.nullable(),
		conflict: verdictSchema.nullable(),
		coverage: verdictSchema.nullable(),
		display: z.enum(["pending", "published", "history"]),
		reason: z.string(),
		policy_version: z.string(),
		model_snapshot_digest: z.string().nullable(),
		points: evidenceSummarySchema.optional(),
		evidence: z
			.object({ evaluation: z.unknown(), mechanical: z.unknown() })
			.strict()
			.refine(
				(value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 2048,
				"Epic judgment evidence exceeds 2048 bytes",
			),
	})
	.strict();
export type EpicJudgment = z.infer<typeof epicJudgmentSchema>;
/** One read snapshot. It carries audit evidence, never an approval instruction. */
export function readEpicJudgment(
	db: Database.Database,
	project: string,
	issueKeys: string[],
): { value: EpicJudgment | null; source_updated_at?: string } {
	if (project !== "flywheel") return { value: null };
	const keys = z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(2)
		.parse(issueKeys);
	const placeholders = keys.map(() => "?").join(",");
	return db.transaction(() => {
		const holder = db
			.prepare(`SELECT h.question_id,strftime('%Y-%m-%dT%H:%M:%fZ',h.created_at) AS created_at
 FROM workflow_gate_holder h JOIN workflow_run r ON r.run_id=h.run_id
 WHERE r.project_name=? AND (r.issue_id IN (${placeholders}) OR EXISTS(SELECT 1 FROM workflow_run_issue_alias a WHERE a.run_id=r.run_id AND a.issue_alias IN (${placeholders})))
 ORDER BY julianday(h.created_at) DESC,h.attempt DESC,h.question_id DESC LIMIT 1`)
			.get(project, ...keys, ...keys) as
			| { question_id: string; created_at: string }
			| undefined;
		if (!holder) return { value: null };
		const row = db
			.prepare(`SELECT p.*,i.policy_version,i.model_snapshot_digest,e.result_json
 FROM ship_judgment_opinion p LEFT JOIN ship_judgment_input i ON i.input_id=p.input_id LEFT JOIN ship_judgment_evaluation e ON e.evaluation_id=p.evaluation_id
 WHERE p.question_id=? ORDER BY p.ordinal DESC LIMIT 1`)
			.get(holder.question_id) as
			| {
					opinion_id: string;
					input_id: string | null;
					evaluation_id: string | null;
					overall: string;
					alignment: string;
					conflict: string;
					coverage: string;
					reason: string;
					created_at: string;
					presentation_digest: string;
					policy_version: string | null;
					model_snapshot_digest: string | null;
					result_json: string | null;
					mechanical_json: string;
					evidence_json: string | null;
			  }
			| undefined;
		const delivery = db
			.prepare(
				"SELECT state,posted_id,message_id,visible_at,delivery_mode,mode_label,validated_presentation_digest,dirty_since FROM ship_judgment_delivery WHERE purpose='opinion' AND subject_id=?",
			)
			.get(holder.question_id) as
			| {
					state: string;
					posted_id: string | null;
					message_id: string | null;
					visible_at: string | null;
					delivery_mode: string;
					mode_label: string;
					validated_presentation_digest: string | null;
					dirty_since: string | null;
			  }
			| undefined;
		const historical =
			delivery &&
			(delivery.delivery_mode === "off" || delivery.mode_label === "history");
		const published =
			row &&
			delivery &&
			delivery.state === "delivered" &&
			delivery.posted_id === row.opinion_id &&
			delivery.message_id &&
			delivery.visible_at &&
			delivery.validated_presentation_digest === row.presentation_digest &&
			!delivery.dirty_since;
		const ledger = row?.evidence_json
			? evidenceLedgerSchema.parse(JSON.parse(row.evidence_json))
			: undefined;
		const value = epicJudgmentSchema.parse({
			question_id: holder.question_id,
			opinion_id: row?.opinion_id ?? null,
			input_id: row?.input_id ?? null,
			evaluation_id: row?.evaluation_id ?? null,
			source: "machine",
			overall: row?.overall ?? null,
			alignment: row?.alignment ?? null,
			conflict: row?.conflict ?? null,
			coverage: row?.coverage ?? null,
			display: historical ? "history" : published ? "published" : "pending",
			reason: row?.reason ?? "no_opinion",
			policy_version:
				ledger?.policyVersion ?? row?.policy_version ?? POLICY_VERSION,
			model_snapshot_digest: ledger
				? ledger.semantic.modelSnapshotDigest
				: (row?.model_snapshot_digest ?? null),
			...(ledger ? { points: evidenceSummary(ledger) } : {}),
			evidence: {
				evaluation: pageEvidence(row?.result_json, row?.evaluation_id),
				mechanical: pageEvidence(row?.mechanical_json, row?.opinion_id),
			},
		});
		return { value, source_updated_at: row?.created_at ?? holder.created_at };
	})();
}
