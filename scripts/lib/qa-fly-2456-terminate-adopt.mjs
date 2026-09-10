import { isDeepStrictEqual } from "node:util";
import { openSnapshot } from "./qa-fly-2456-db.mjs";
// Canonical ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES, workflow-ledger-states.ts.
export const TERMINAL_STATUSES = Object.freeze([
	"completed",
	"failed",
	"terminated",
	"blocked",
	"rejected",
	"deferred",
	"shelved",
]);
const actionable = new Set([
	"pending",
	"running",
	"ship_parked",
	"awaiting_review",
	"approved_to_ship",
	"design_done",
]);
const text = (x) => typeof x === "string" && x.length > 0 && !x.includes("\0");
const conflict = (reason) => ({ action: "conflict", reason });
function timestamp(value) {
	if (typeof value !== "string") return NaN;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value))
		return Date.parse(value.replace(" ", "T") + "Z");
	if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
	return Date.parse(value);
}
function schema(db) {
	for (const [table, names] of Object.entries({
		sessions: [
			"execution_id",
			"issue_id",
			"project_name",
			"status",
			"terminal_at",
			"last_error",
		],
		lead_events: ["event_id", "event_type", "payload", "created_at"],
	})) {
		if (
			!db
				.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'")
				.get(table)
		)
			throw new Error("table missing");
		const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
		if (!names.every((name) => columns.some((c) => c.name === name)))
			throw new Error("column missing");
		for (const name of names)
			if (
				db
					.prepare(
						`SELECT 1 FROM "${table}" WHERE "${name}" IS NOT NULL AND (typeof("${name}")!='text' OR instr("${name}",char(0))>0) LIMIT 1`,
					)
					.get()
			)
				throw new Error("text storage invalid");
	}
}
function authority(db, intent, observed) {
	const d = intent.detail;
	const session = db
		.prepare(
			"SELECT execution_id,issue_id,project_name,status,terminal_at,last_error FROM sessions WHERE execution_id=?",
		)
		.get(d.executionId);
	if (!session) return conflict("session_missing");
	if (d.purpose === "qa-fallback" && TERMINAL_STATUSES.includes(session.status))
		return {
			action: "adopt-existing",
			result: {
				executionId: d.executionId,
				status: session.status,
				noop: true,
				outcome: "not-executed",
				purpose: d.purpose,
			},
		};
	const after = timestamp(intent.createdAt);
	const reason = (d.reason.trim() || "Terminated by CEO").slice(0, 500);
	const actionEvents = db
		.prepare(
			"SELECT seq,event_id,payload,created_at FROM lead_events WHERE event_type='action_executed' ORDER BY seq",
		)
		.all()
		.map((row) => ({ ...row, parsed: JSON.parse(row.payload) }));
	if (
		actionEvents.some(
			(e) =>
				!e.parsed ||
				typeof e.parsed !== "object" ||
				Array.isArray(e.parsed) ||
				!Number.isFinite(timestamp(e.created_at)),
		)
	)
		throw new Error("action evidence invalid");
	const related = actionEvents.filter(
		(e) =>
			e.parsed.execution_id === d.executionId &&
			e.parsed.action === "terminate" &&
			timestamp(e.created_at) > after,
	);
	if (actionable.has(session.status))
		return related.length
			? conflict("session_action_conflict")
			: { action: "execute" };
	if (d.purpose !== "precondition" || session.status !== "terminated")
		return conflict("precondition_not_proven");
	const terminalAt = timestamp(session.terminal_at);
	if (
		!Number.isFinite(terminalAt) ||
		terminalAt <= after ||
		terminalAt > observed ||
		session.last_error !== reason
	)
		return conflict("termination_identity_conflict");
	const matches = related.filter(
		(e) =>
			timestamp(e.created_at) <= observed &&
			e.parsed.event_type === "action_executed" &&
			e.parsed.issue_id === session.issue_id &&
			e.parsed.project_name === session.project_name &&
			e.parsed.status === "terminated" &&
			e.parsed.action_target_status === "terminated" &&
			actionable.has(e.parsed.action_source_status) &&
			e.parsed.action_reason === reason,
	);
	if (related.length !== 1 || matches.length !== 1)
		return conflict("terminate_action_missing_or_conflicting");
	const event = matches[0];
	return {
		action: "adopt-existing",
		result: {
			executionId: d.executionId,
			status: "terminated",
			noop: false,
			outcome: "executed",
			purpose: d.purpose,
			reason,
			actionEventId: event.event_id,
			actionEventSeq: event.seq,
		},
	};
}
export function inspectTerminateAdoption({
	manifest,
	step,
	dbPath,
	now = Date.now(),
}) {
	let db;
	try {
		const entry = manifest?.steps?.[step],
			intent = entry?.intent,
			d = intent?.detail;
		if (
			!d ||
			d.kind !== "terminate" ||
			!["precondition", "qa-fallback"].includes(d.purpose) ||
			!text(d.executionId) ||
			typeof d.reason !== "string" ||
			!Number.isFinite(timestamp(intent.createdAt))
		)
			return conflict("intent_invalid");
		const opened = openSnapshot(dbPath, {
			after: intent.createdAt,
			now,
			maxAgeMs: 600000,
		});
		db = opened.db;
		schema(db);
		const outcome = authority(
			db,
			intent,
			timestamp(opened.metadata.observedAt),
		);
		if (entry.receipt) {
			if (
				outcome.action !== "adopt-existing" ||
				!isDeepStrictEqual(entry.receipt.result, outcome.result)
			)
				return conflict("receipt_authority_conflict");
			return { ...outcome, action: "replay" };
		}
		return outcome;
	} catch {
		return conflict("snapshot_schema_or_evidence_invalid");
	} finally {
		db?.close();
	}
}
