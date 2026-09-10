import { isDeepStrictEqual } from "node:util";
import { openSnapshot } from "./qa-fly-2456-db.mjs";

const text = (x) => typeof x === "string" && x.length > 0 && !x.includes("\0");
const conflict = (reason) => ({ action: "conflict", reason });
function time(value) {
	if (typeof value !== "string") return NaN;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value))
		return Date.parse(value.replace(" ", "T") + "Z");
	if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
	return Date.parse(value);
}
function schema(db, tables) {
	for (const [table, names] of Object.entries(tables)) {
		if (
			!db
				.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
				.get(table)
		)
			throw new Error("table missing");
		const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
		if (!names.every((name) => columns.some((c) => c.name === name)))
			throw new Error("column missing");
		for (const c of columns.filter(
			(c) => names.includes(c.name) && /TEXT/i.test(c.type),
		))
			if (
				db
					.prepare(
						`SELECT 1 FROM "${table}" WHERE "${c.name}" IS NOT NULL AND (typeof("${c.name}")!='text' OR instr("${c.name}",char(0))>0) LIMIT 1`,
					)
					.get()
			)
				throw new Error("storage invalid");
	}
}
function inspect(db, comm, intent, stateObserved, commObserved) {
	const d = intent.detail;
	const session = db
		.prepare(
			"SELECT execution_id,issue_id,project_name,status FROM sessions WHERE execution_id=?",
		)
		.get(d.executionId);
	const run = db
		.prepare(
			"SELECT run_id,issue_id,project_name,status FROM workflow_run WHERE run_id=?",
		)
		.get(d.runId);
	if (
		!session ||
		!run ||
		session.issue_id !== d.issueId ||
		run.issue_id !== d.issueId ||
		session.project_name !== run.project_name ||
		run.status !== "active"
	)
		return conflict("park_identity_conflict");
	const nodes = db
		.prepare(
			"SELECT * FROM workflow_run_node WHERE run_id=? AND node_id='implement' ORDER BY attempt",
		)
		.all(d.runId);
	if (
		nodes.length !== 1 ||
		nodes[0].attempt !== 1 ||
		nodes[0].execution_id !== d.executionId
	)
		return conflict("park_node_conflict");
	const node = nodes[0];
	const projection = comm
		.prepare("SELECT * FROM workflow_engine_park WHERE execution_id=?")
		.get(d.executionId);
	const events = db
		.prepare(
			"SELECT * FROM workflow_engine_park_outbox WHERE execution_id=? ORDER BY generation DESC,row_id DESC",
		)
		.all(d.executionId);
	// DEVIATION #12 (FLY-2456 host drill): on main the engine writes a cleared park projection at
	// admission (reason activation_spawn_admitted, outbox event park_cleared). A body is "not yet
	// parked" when the projection is absent or cleared and every outbox event is park_cleared.
	const notYetParked =
		(!projection || projection.state === "cleared") &&
		events.every((e) => e.event === "park_cleared");
	if (session.status === "running" && node.state === "running" && notYetParked)
		return { action: "execute" };
	if (
		session.status !== "ship_parked" ||
		node.state !== "done" ||
		!projection ||
		projection.state !== "open" ||
		!events.length
	)
		return conflict("park_partial_or_not_open");
	const event = events[0];
	if (
		event.event !== "park_opened" ||
		event.project_name !== run.project_name ||
		projection.source_row_id !== event.row_id ||
		!Number.isSafeInteger(event.row_id) ||
		event.row_id <= 0 ||
		!Number.isSafeInteger(event.generation) ||
		event.generation <= 0 ||
		!text(event.activation_id) ||
		!text(event.event_id)
	)
		return conflict("park_source_conflict");
	for (const field of [
		"execution_id",
		"run_id",
		"node_id",
		"attempt",
		"activation_id",
		"generation",
		"reason",
	])
		if (projection[field] !== event[field])
			return conflict("park_projection_conflict");
	if (
		event.run_id !== d.runId ||
		event.node_id !== "implement" ||
		event.attempt !== 1 ||
		projection.updated_at !== event.created_at
	)
		return conflict("park_projection_conflict");
	const at = time(event.created_at);
	if (
		!Number.isFinite(at) ||
		at <= time(intent.createdAt) ||
		at > stateObserved ||
		at > commObserved
	)
		return conflict("park_chronology_conflict");
	return {
		action: "adopt-existing",
		result: {
			executionId: d.executionId,
			runId: d.runId,
			nodeId: "implement",
			attempt: 1,
			status: "ship_parked",
			parkEventId: event.event_id,
			parkSourceRowId: event.row_id,
			activationId: event.activation_id,
			generation: event.generation,
		},
	};
}
export function inspectParkAdoption({
	manifest,
	step,
	dbPath,
	commPath,
	now = Date.now(),
}) {
	let db, comm;
	try {
		const entry = manifest?.steps?.[step],
			intent = entry?.intent,
			d = intent?.detail,
			body = manifest?.bodies?.[d?.label];
		if (
			!d ||
			d.kind !== "park-complete" ||
			!body ||
			body.issueId !== manifest.config?.issues?.[d.label] ||
			body.issueId !== d.issueId ||
			intent.idempotencyKey !== body.idempotencyKey ||
			intent.clientRequestId !== body.clientRequestId ||
			!text(intent.idempotencyKey) ||
			!text(intent.clientRequestId) ||
			!text(d.executionId) ||
			!text(d.runId) ||
			!Number.isFinite(time(intent.createdAt))
		)
			return conflict("manifest_identity_conflict");
		const state = openSnapshot(dbPath, {
			after: intent.createdAt,
			now,
			maxAgeMs: 600000,
		});
		db = state.db;
		const communication = openSnapshot(commPath, {
			after: intent.createdAt,
			now,
			maxAgeMs: 600000,
		});
		comm = communication.db;
		schema(db, {
			sessions: ["execution_id", "issue_id", "project_name", "status"],
			workflow_run: ["run_id", "issue_id", "project_name", "status"],
			workflow_run_node: [
				"run_id",
				"node_id",
				"attempt",
				"execution_id",
				"state",
			],
			workflow_engine_park_outbox: [
				"row_id",
				"event_id",
				"project_name",
				"execution_id",
				"run_id",
				"node_id",
				"attempt",
				"activation_id",
				"generation",
				"event",
				"reason",
				"created_at",
			],
		});
		schema(comm, {
			workflow_engine_park: [
				"execution_id",
				"run_id",
				"node_id",
				"attempt",
				"activation_id",
				"generation",
				"state",
				"reason",
				"source_row_id",
				"updated_at",
			],
		});
		const outcome = inspect(
			db,
			comm,
			intent,
			time(state.metadata.observedAt),
			time(communication.metadata.observedAt),
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
		comm?.close();
		db?.close();
	}
}
