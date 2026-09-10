import { isDeepStrictEqual } from "node:util";
import { openSnapshot } from "./qa-fly-2456-db.mjs";

const text = (x) => typeof x === "string" && x.length > 0 && !x.includes("\0");
const conflict = (reason) => ({ action: "conflict", reason });
function physical(db, table, columns) {
	if (
		!db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
			.get(table)
	)
		throw new Error("physical table missing");
	const schema = db.prepare(`PRAGMA table_info("${table}")`).all();
	for (const column of columns) {
		if (!schema.some((c) => c.name === column))
			throw new Error("column missing");
		if (
			column !== "attempt" &&
			db
				.prepare(
					`SELECT 1 FROM "${table}" WHERE "${column}" IS NOT NULL AND (typeof("${column}")!='text' OR instr("${column}",char(0))>0) LIMIT 1`,
				)
				.get()
		)
			throw new Error("invalid text");
	}
}
export function inspectQaIdentity({
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
			d = intent?.detail;
		if (
			d?.kind !== "qa-identity" ||
			!text(intent.createdAt) ||
			!Number.isFinite(Date.parse(intent.createdAt)) ||
			d.label !== "B1" ||
			!text(d.issueId) ||
			manifest.config?.issues?.B1 !== d.issueId ||
			![1, 4].includes(manifest.config?.slot)
		)
			return conflict("manifest_identity_conflict");
		const parents = Object.values(manifest.steps).filter(
			(e) =>
				e.intent?.detail?.kind === "start" &&
				e.intent.detail.label === d.label &&
				e.receipt,
		);
		if (
			parents.length !== 1 ||
			parents[0].receipt.result?.issueId !== d.issueId ||
			!text(parents[0].receipt.result.workflowRunId)
		)
			return conflict("parent_identity_conflict");
		const runId = parents[0].receipt.result.workflowRunId;
		db = openSnapshot(dbPath, {
			after: intent.createdAt,
			now,
			maxAgeMs: 600000,
		}).db;
		comm = openSnapshot(commPath, {
			after: intent.createdAt,
			now,
			maxAgeMs: 600000,
		}).db;
		physical(db, "sessions", ["execution_id", "issue_id", "project_name"]);
		physical(db, "workflow_run", ["run_id", "issue_id", "project_name"]);
		physical(db, "workflow_run_node", [
			"run_id",
			"node_id",
			"attempt",
			"execution_id",
		]);
		physical(comm, "runner_workflow_activation", [
			"execution_id",
			"activation_id",
			"run_id",
			"node_id",
			"attempt",
		]);
		const run = db
			.prepare("SELECT issue_id,project_name FROM workflow_run WHERE run_id=?")
			.get(runId);
		const nodes = db
			.prepare(
				"SELECT execution_id FROM workflow_run_node WHERE run_id=? AND node_id='qa' AND attempt=1",
			)
			.all(runId);
		if (
			!run ||
			run.issue_id !== d.issueId ||
			run.project_name !== `test-slot-${manifest.config.slot}` ||
			nodes.length !== 1 ||
			!text(nodes[0].execution_id)
		)
			return conflict("engine_identity_conflict");
		const executionId = nodes[0].execution_id;
		const session = db
			.prepare(
				"SELECT issue_id,project_name FROM sessions WHERE execution_id=?",
			)
			.get(executionId);
		const activations = comm
			.prepare(
				"SELECT activation_id,run_id,node_id,attempt FROM runner_workflow_activation WHERE execution_id=?",
			)
			.all(executionId);
		if (
			!session ||
			session.issue_id !== d.issueId ||
			session.project_name !== run.project_name ||
			activations.length !== 1 ||
			activations[0].run_id !== runId ||
			activations[0].node_id !== "qa" ||
			activations[0].attempt !== 1 ||
			!text(activations[0].activation_id)
		)
			return conflict("activation_identity_conflict");
		const result = {
			source: "workflow-engine",
			executionId,
			workflowRunId: runId,
			workflowNodeId: "qa",
			issueId: d.issueId,
			attempt: 1,
			activationId: activations[0].activation_id,
		};
		if (entry.receipt && !isDeepStrictEqual(entry.receipt.result, result))
			return conflict("receipt_authority_conflict");
		return { action: entry.receipt ? "replay" : "adopt-existing", result };
	} catch {
		return conflict("snapshot_schema_or_evidence_invalid");
	} finally {
		comm?.close();
		db?.close();
	}
}
