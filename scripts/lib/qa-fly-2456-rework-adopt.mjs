import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { openSnapshot } from "./qa-fly-2456-db.mjs";

const text = (x) => typeof x === "string" && x.length > 0 && !x.includes("\0");
const conflict = (reason) => ({ action: "conflict", reason });
function schema(db, tables) {
	for (const [table, columns] of Object.entries(tables)) {
		if (
			!db
				.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'")
				.get(table)
		)
			throw new Error("table missing");
		const actual = db.prepare(`PRAGMA table_info("${table}")`).all();
		if (!columns.every((name) => actual.some((c) => c.name === name)))
			throw new Error("column missing");
		for (const column of actual.filter(
			(c) => columns.includes(c.name) && /TEXT|JSON/i.test(c.type),
		))
			if (
				db
					.prepare(
						`SELECT 1 FROM "${table}" WHERE "${column.name}" IS NOT NULL AND (typeof("${column.name}")!='text' OR instr("${column.name}",char(0))>0) LIMIT 1`,
					)
					.get()
			)
				throw new Error("storage invalid");
	}
}
function commonSchema(db) {
	schema(db, {
		workflow_run: ["run_id", "issue_id"],
		workflow_rework_request: [
			"request_id",
			"run_id",
			"source_event_id",
			"authority",
			"source_node_id",
			"source_attempt",
			"requested_at",
			"actor_id",
			"founder_quote_json",
			"lead_feedback",
		],
		workflow_rework_route_revision: [
			"request_id",
			"revision",
			"target_node_id",
			"target_attempt",
			"preferred_actor_execution_id",
		],
		workflow_rework_delivery: ["request_id", "route_revision", "state"],
	});
}
function delivered(db, request, detail) {
	const delivery = db
		.prepare("SELECT * FROM workflow_rework_delivery WHERE request_id=?")
		.get(request.request_id);
	if (!delivery || delivery.state !== "wake_delivered")
		return conflict("delivery_incomplete");
	const routes = db
		.prepare(
			"SELECT * FROM workflow_rework_route_revision WHERE request_id=? AND revision=?",
		)
		.all(request.request_id, delivery.route_revision);
	if (routes.length !== 1) return conflict("route_missing");
	const route = routes[0];
	if (
		route.target_node_id !== detail.targetNodeId ||
		route.target_attempt !== detail.targetAttempt ||
		route.preferred_actor_execution_id !== detail.preferredActorExecutionId ||
		!Number.isSafeInteger(route.revision) ||
		route.revision <= 0
	)
		return conflict("route_conflict");
	return {
		action: "adopt-existing",
		result: {
			requestId: request.request_id,
			runId: request.run_id,
			targetNodeId: route.target_node_id,
			targetAttempt: route.target_attempt,
			preferredActorExecutionId: route.preferred_actor_execution_id,
			routeRevision: route.revision,
			state: delivery.state,
		},
	};
}
function qa(db, comm, detail, intent, now, observed) {
	schema(comm, {
		runner_workflow_activation: [
			"execution_id",
			"activation_id",
			"run_id",
			"node_id",
			"attempt",
			"submission_credential",
		],
	});
	schema(db, {
		workflow_submission_credential: [
			"activation_id",
			"credential_hash",
			"run_id",
			"node_id",
			"execution_id",
			"attempt",
			"family",
			"expires_at",
			"permanent",
			"consumed_at",
			"revoked",
		],
	});
	if (!text(detail.qaExecutionId)) return conflict("qa_identity_invalid");
	const activations = comm
		.prepare(
			"SELECT * FROM runner_workflow_activation WHERE execution_id=? AND run_id=? AND node_id='qa' AND attempt=1",
		)
		.all(detail.qaExecutionId, detail.runId);
	if (activations.length !== 1 || !text(activations[0].submission_credential))
		return conflict("qa_activation_ambiguous");
	const activation = activations[0];
	const credentials = db
		.prepare(
			"SELECT * FROM workflow_submission_credential WHERE activation_id=?",
		)
		.all(activation.activation_id);
	if (credentials.length !== 1) return conflict("qa_credential_ambiguous");
	const credential = credentials[0];
	if (
		credential.credential_hash !==
			createHash("sha256")
				.update(activation.submission_credential)
				.digest("hex") ||
		credential.run_id !== detail.runId ||
		credential.node_id !== "qa" ||
		credential.execution_id !== detail.qaExecutionId ||
		credential.attempt !== 1 ||
		credential.family !== "qa_verdict" ||
		credential.revoked !== 0 ||
		![0, 1].includes(credential.permanent)
	)
		return conflict("qa_credential_conflict");
	const requests = db
		.prepare("SELECT * FROM workflow_rework_request WHERE run_id=?")
		.all(detail.runId);
	if (!requests.length) {
		if (
			credential.consumed_at !== null ||
			(credential.permanent === 0 &&
				(!Number.isFinite(Date.parse(credential.expires_at)) ||
					Date.parse(credential.expires_at) <= now))
		)
			return conflict("qa_consumed_without_request");
		return { action: "execute" };
	}
	if (requests.length !== 1) return conflict("qa_request_ambiguous");
	const request = requests[0];
	if (
		request.authority !== "qa" ||
		request.source_node_id !== "qa" ||
		request.source_attempt !== 1 ||
		!Number.isFinite(Date.parse(credential.consumed_at)) ||
		Date.parse(credential.consumed_at) < Date.parse(intent.createdAt) ||
		Date.parse(credential.consumed_at) > observed ||
		!Number.isFinite(Date.parse(request.requested_at)) ||
		Date.parse(request.requested_at) < Date.parse(intent.createdAt) ||
		Date.parse(request.requested_at) > observed
	)
		return conflict("qa_request_conflict");
	return delivered(db, request, detail);
}
function operator(db, detail, intent, observed) {
	schema(db, {
		workflow_run_event: [
			"event_uid",
			"run_id",
			"kind",
			"node_id",
			"execution_id",
			"payload",
		],
	});
	if (
		!text(detail.actor) ||
		!text(detail.leadFeedback) ||
		!text(detail.principal) ||
		!Object.hasOwn(detail, "founderQuote")
	)
		return conflict("operator_intent_invalid");
	const uid = `operator_rework:${detail.runId}:${intent.clientRequestId}`;
	const rows = db
		.prepare("SELECT * FROM workflow_run_event WHERE event_uid=?")
		.all(uid);
	if (!rows.length)
		return db
			.prepare("SELECT 1 FROM workflow_rework_request WHERE run_id=? LIMIT 1")
			.get(detail.runId)
			? conflict("operator_partial_or_other_request")
			: { action: "execute" };
	if (rows.length !== 1) return conflict("operator_ambiguous");
	const row = rows[0];
	const p = JSON.parse(row.payload);
	if (
		!p ||
		typeof p !== "object" ||
		Array.isArray(p) ||
		row.kind !== "operator_rework_requested" ||
		row.run_id !== detail.runId ||
		row.node_id !== detail.targetNodeId ||
		row.execution_id !== detail.preferredActorExecutionId ||
		!text(p.requestId) ||
		p.targetNodeId !== detail.targetNodeId ||
		p.targetAttempt !== detail.targetAttempt ||
		p.preferredActorExecutionId !== detail.preferredActorExecutionId ||
		p.authority !== "lead" ||
		p.actor !== detail.actor.trim() ||
		p.lead_feedback !== detail.leadFeedback.trim() ||
		p.principal !== detail.principal ||
		!isDeepStrictEqual(p.founder_quote, detail.founderQuote)
	)
		return conflict("operator_payload_conflict");
	if (!isDeepStrictEqual(p.escalationAck ?? null, detail.escalationAck ?? null))
		return conflict("operator_payload_conflict");
	if (
		p.founderAuthorEvidenceIdentityDigest !== undefined &&
		(!text(detail.founderAuthorEvidenceIdentityDigest) ||
			p.founderAuthorEvidenceIdentityDigest !==
				detail.founderAuthorEvidenceIdentityDigest)
	)
		return conflict("operator_payload_conflict");
	// Consent is informational in the producer's replay comparison; compare an explicit expected receipt only.
	if (
		Object.hasOwn(detail, "consent") &&
		!isDeepStrictEqual(p.consent, detail.consent)
	)
		return conflict("operator_payload_conflict");
	const requests = db
		.prepare("SELECT * FROM workflow_rework_request WHERE request_id=?")
		.all(p.requestId);
	if (requests.length !== 1) return conflict("operator_request_missing");
	const request = requests[0];
	if (
		request.run_id !== detail.runId ||
		request.source_event_id !== uid ||
		request.authority !== "lead" ||
		request.actor_id !== detail.actor.trim() ||
		request.lead_feedback !== detail.leadFeedback.trim() ||
		!isDeepStrictEqual(
			JSON.parse(request.founder_quote_json),
			detail.founderQuote,
		) ||
		!Number.isFinite(Date.parse(request.requested_at)) ||
		Date.parse(request.requested_at) < Date.parse(intent.createdAt) ||
		Date.parse(request.requested_at) > observed
	)
		return conflict("operator_request_conflict");
	return delivered(db, request, detail);
}
export function inspectReworkAdoption({
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
			detail = intent?.detail;
		if (!detail || !["qa-fail", "operator-rework"].includes(detail.kind))
			return conflict("kind_unsupported");
		const body = manifest.bodies?.[detail.label];
		if (
			!text(intent.createdAt) ||
			!Number.isFinite(Date.parse(intent.createdAt)) ||
			detail.label !== "B1" ||
			!body ||
			body.issueId !== manifest.config?.issues?.B1 ||
			detail.issueId !== body.issueId ||
			intent.idempotencyKey !== body.idempotencyKey ||
			intent.clientRequestId !== body.clientRequestId ||
			!text(intent.idempotencyKey) ||
			!text(intent.clientRequestId) ||
			!text(detail.runId) ||
			!text(detail.preferredActorExecutionId) ||
			detail.targetNodeId !== "implement" ||
			detail.targetAttempt !== 2
		)
			return conflict("manifest_identity_conflict");
		const current = typeof now === "number" ? now : Date.parse(now);
		const opened = openSnapshot(dbPath, {
			after: intent.createdAt,
			now: current,
			maxAgeMs: 600000,
		});
		db = opened.db;
		const observed = Date.parse(opened.metadata.observedAt);
		commonSchema(db);
		const run = db
			.prepare("SELECT issue_id FROM workflow_run WHERE run_id=?")
			.get(detail.runId);
		if (!run || run.issue_id !== body.issueId)
			return conflict("run_identity_conflict");
		let outcome;
		if (detail.kind === "qa-fail") {
			({ db: comm } = openSnapshot(commPath, {
				after: intent.createdAt,
				now: current,
				maxAgeMs: 600000,
			}));
			outcome = qa(db, comm, detail, intent, current, observed);
		} else outcome = operator(db, detail, intent, observed);
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
