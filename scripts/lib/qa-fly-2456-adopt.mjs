import { isDeepStrictEqual } from "node:util";
import { openGates, openSnapshot } from "./qa-fly-2456-db.mjs";
import { inspectReworkAdoption } from "./qa-fly-2456-rework-adopt.mjs";

const conflict = (reason) => ({ action: "conflict", reason });
const text = (value) =>
	typeof value === "string" && value.length > 0 && !value.includes("\0");
function normalizeStart(result) {
	if (
		!result ||
		result.success !== true ||
		result.generalized !== true ||
		!["executionId", "workflowRunId", "workflowNodeId"].every((k) =>
			text(result[k]),
		) ||
		(result.issueId !== undefined && !text(result.issueId))
	)
		return null;
	return {
		success: true,
		generalized: true,
		executionId: result.executionId,
		workflowRunId: result.workflowRunId,
		workflowNodeId: result.workflowNodeId,
		...(result.issueId !== undefined ? { issueId: result.issueId } : {}),
	};
}
function requireTables(db, required) {
	for (const [table, columns] of Object.entries(required)) {
		if (
			!db
				.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
				.get(table)
		)
			throw new Error("table missing");
		const actual = db.prepare(`PRAGMA table_info("${table}")`).all();
		if (!columns.every((name) => actual.some((c) => c.name === name)))
			throw new Error("column missing");
		for (const column of columns.filter((name) => name !== "attempt")) {
			if (
				db
					.prepare(
						`SELECT 1 FROM "${table}" WHERE "${column}" IS NOT NULL AND (typeof("${column}")!='text' OR instr("${column}",char(0))>0) LIMIT 1`,
					)
					.get()
			)
				throw new Error("invalid text storage");
		}
	}
}
function inspectStart(db, intent, issueId) {
	requireTables(db, {
		workflow_start_reservation: [
			"idempotency_key",
			"selection_digest",
			"run_id",
			"node_id",
			"attempt",
			"execution_id",
		],
		workflow_start_stage: ["idempotency_key", "stage"],
		workflow_start_response: ["idempotency_key", "response_json"],
		workflow_run: ["run_id", "issue_id", "status"],
		workflow_run_issue_alias: ["run_id", "issue_alias"],
	});
	const { detail } = intent;
	if (!text(detail.selectionDigest)) return conflict("start_identity_invalid");
	const reservation = db
		.prepare("SELECT * FROM workflow_start_reservation WHERE idempotency_key=?")
		.get(intent.idempotencyKey);
	if (!reservation) {
		const other = db
			.prepare(
				"SELECT 1 FROM workflow_run r WHERE (r.issue_id=? OR EXISTS (SELECT 1 FROM workflow_run_issue_alias a WHERE a.run_id=r.run_id AND a.issue_alias=?)) AND (r.status='active' OR EXISTS (SELECT 1 FROM workflow_start_reservation s WHERE s.run_id=r.run_id)) LIMIT 1",
			)
			.get(issueId, issueId);
		return other ? conflict("issue_start_conflict") : { action: "execute" };
	}
	const run = db
		.prepare("SELECT * FROM workflow_run WHERE run_id=?")
		.get(reservation.run_id);
	if (
		!run ||
		run.issue_id !== issueId ||
		reservation.selection_digest !== detail.selectionDigest ||
		!["run_id", "node_id", "execution_id"].every((k) => text(reservation[k])) ||
		!Number.isInteger(reservation.attempt) ||
		reservation.attempt <= 0
	)
		return conflict("start_identity_conflict");
	for (const [field, column] of [
		["workflowRunId", "run_id"],
		["workflowNodeId", "node_id"],
		["executionId", "execution_id"],
		["attempt", "attempt"],
	])
		if (detail[field] !== undefined && detail[field] !== reservation[column])
			return conflict("start_identity_conflict");
	const stage = db
		.prepare("SELECT stage FROM workflow_start_stage WHERE idempotency_key=?")
		.get(intent.idempotencyKey);
	if (stage?.stage !== "responded") return conflict("start_incomplete");
	const stored = db
		.prepare(
			"SELECT response_json FROM workflow_start_response WHERE idempotency_key=?",
		)
		.get(intent.idempotencyKey);
	if (!stored || !text(stored.response_json))
		return conflict("start_response_conflict");
	const result = normalizeStart(JSON.parse(stored.response_json));
	if (
		!result ||
		result.executionId !== reservation.execution_id ||
		result.workflowRunId !== reservation.run_id ||
		result.workflowNodeId !== reservation.node_id ||
		(result.issueId !== undefined && result.issueId !== issueId)
	)
		return conflict("start_response_conflict");
	return { action: "adopt-existing", result };
}
function inspectGate(db, detail, slot) {
	if (!text(detail.executionId) || !/^[1-9][0-9]*$/.test(String(slot)))
		return conflict("gate_identity_conflict");
	const gates = openGates(db, detail.executionId);
	if (!gates.length) return { action: "execute" };
	if (gates.length > 1) return conflict("gate_ambiguous");
	const gate = gates[0];
	if (
		!text(gate.id) ||
		gate.to_agent !== `flywheel-test-${slot}` ||
		gate.content !== "FLY-2456 drill hold" ||
		gate.checkpoint !== (detail.checkpoint ?? "question")
	)
		return conflict("gate_identity_conflict");
	return { action: "adopt-existing", result: { questionId: gate.id } };
}
export function inspectAdoption({
	manifest,
	step,
	dbPath,
	commPath,
	now = Date.now(),
}) {
	if (
		["qa-fail", "operator-rework"].includes(
			manifest?.steps?.[step]?.intent?.detail?.kind,
		)
	)
		return inspectReworkAdoption({ manifest, step, dbPath, commPath, now });
	let db;
	try {
		const entry = manifest?.steps?.[step];
		const intent = entry?.intent;
		const detail = intent?.detail;
		if (!detail || !["start", "gate"].includes(detail.kind))
			return conflict("kind_unsupported");
		const body =
			detail.label === "PRE"
				? manifest.auxiliaryBodies?.PRE
				: manifest.bodies?.[detail.label];
		if (
			!body ||
			!text(body.issueId) ||
			body.issueId !==
				(detail.label === "PRE"
					? manifest.auxiliaryBodies?.PRE?.issueId
					: manifest.config?.issues?.[detail.label]) ||
			(detail.issueId !== undefined && detail.issueId !== body.issueId) ||
			intent.idempotencyKey !== body.idempotencyKey ||
			intent.clientRequestId !== body.clientRequestId ||
			!text(intent.idempotencyKey) ||
			!text(intent.clientRequestId)
		)
			return conflict("manifest_identity_conflict");
		if (!text(intent.createdAt)) return conflict("manifest_identity_conflict");
		({ db } = openSnapshot(detail.kind === "start" ? dbPath : commPath, {
			after: intent.createdAt,
			now,
			maxAgeMs: 600000,
		}));
		const outcome =
			detail.kind === "start"
				? inspectStart(db, intent, body.issueId)
				: inspectGate(db, detail, manifest.config.slot);
		if (entry.receipt) {
			const recorded =
				detail.kind === "start"
					? normalizeStart(entry.receipt.result)
					: entry.receipt.result;
			if (
				outcome.action !== "adopt-existing" ||
				!recorded ||
				!isDeepStrictEqual(recorded, outcome.result)
			)
				return conflict("receipt_authority_conflict");
			return { ...outcome, action: "replay" };
		}
		return outcome;
	} catch {
		return conflict("snapshot_or_schema_invalid");
	} finally {
		db?.close();
	}
}
