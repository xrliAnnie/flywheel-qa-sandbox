import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD = "1".repeat(40);

async function fixture() {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1956",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	const admission = store.admitWorkflowExecution({
		runId: "run-1",
		nodeId: "qa",
		executionId: "qa-exec",
		attempt: 1,
		family: "qa_verdict",
		expiresAt: "2026-07-14T01:00:00.000Z",
		absoluteDeadlineAt: "2026-07-14T02:00:00.000Z",
		now: "2026-07-14T00:00:00.000Z",
	});
	if (!admission.ok) throw new Error(admission.reason);
	store.upsertSession({
		execution_id: "qa-exec",
		issue_id: "FLY-1956",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "qa",
	});
	const input = {
		credential: admission.credential,
		clientRequestId: "request-1",
		status: "pass" as const,
		summary: "verified",
		clientHead: HEAD,
	};
	const consume = () =>
		store.submitWorkflowDecisionByCredential({
			nodeReuseEnabled: false,
			credential: admission.credential,
			clientRequestId: input.clientRequestId,
			predicate: "qa_passed",
			subjectDigest: HEAD,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: "2026-07-14T01:00:00.000Z",
			evidence: { summary: input.summary },
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
			now: "2026-07-14T00:00:00.000Z",
		});
	const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
	return { store, input, consume, db };
}

describe("read-only workflow decision receipt replay", () => {
	it("leaves unknown and unconsumed credentials to normal admission", async () => {
		const { store, input, db } = await fixture();
		try {
			db.pragma("query_only = ON");
			expect(store.replayWorkflowDecisionReceipt(input)).toBeUndefined();
			expect(
				store.replayWorkflowDecisionReceipt({
					...input,
					credential: "unknown",
				}),
			).toBeUndefined();
		} finally {
			db.pragma("query_only = OFF");
			store.close();
		}
	});

	it("refuses multiple typed lead event receipts without repairing them", async () => {
		const { store, input, consume, db } = await fixture();
		try {
			const first = consume();
			if (!first.ok) throw new Error(first.reason);
			const original = store.getLeadEventBySeq(first.leadEventSeq);
			if (!original) throw new Error("missing receipt");
			store.appendLeadEvent(
				"another-lead",
				original.event_id,
				original.event_type,
				original.payload,
				"wf:run-1",
			);
			db.pragma("query_only = ON");
			expect(store.replayWorkflowDecisionReceipt(input)).toEqual({
				ok: false,
				reason: "credential_receipt_corrupt",
			});
		} finally {
			db.pragma("query_only = OFF");
			store.close();
		}
	});

	it.each([
		"UPDATE workflow_claims SET client_request_id = 'wrong'",
		"UPDATE workflow_claims SET submission_digest = 'wrong'",
		"UPDATE workflow_claims SET workflow_run_id = 'wrong'",
		"UPDATE workflow_claims SET node_id = 'wrong'",
		"UPDATE workflow_claims SET attempt = 2",
		"UPDATE workflow_claims SET issuer_execution_id = 'wrong'",
		"UPDATE workflow_claims SET issuer_node_id = 'wrong'",
		"UPDATE workflow_claims SET decision_kind = 'code_review'",
		"UPDATE workflow_claims SET predicate = 'codex_approved'",
		"UPDATE workflow_claims SET authority_id = 'wrong'",
		"UPDATE workflow_decision_capability SET consumed_claim_id = 999",
		"UPDATE workflow_decision_capability SET execution_id = 'wrong'",
		"UPDATE workflow_decision_capability SET run_id = 'wrong'",
		"UPDATE workflow_decision_capability SET node_id = 'wrong'",
		"UPDATE workflow_decision_capability SET attempt = 2",
		"UPDATE workflow_decision_capability SET allowed_predicate_family = 'review_verdict'",

		"UPDATE workflow_claims SET evidence = '{'",
		"DELETE FROM workflow_claims",
		"DELETE FROM lead_events",
		"UPDATE lead_events SET event_type = 'wrong'",
		"UPDATE lead_events SET payload = '{}'",
		"UPDATE lead_events SET payload = '{'",
	])("refuses damaged durable receipts: %s", async (damage) => {
		const { store, input, consume, db } = await fixture();
		try {
			expect(consume().ok).toBe(true);
			// Deliberately simulate damaged historical storage in this isolated fixture.
			db.exec(
				"DROP TRIGGER IF EXISTS workflow_claims_no_update; DROP TRIGGER IF EXISTS workflow_claims_no_delete;",
			);
			db.pragma("foreign_keys = OFF");
			db.exec(damage);
			db.pragma("foreign_keys = ON");
			db.pragma("query_only = ON");
			expect(store.replayWorkflowDecisionReceipt(input)).toEqual({
				ok: false,
				reason: "credential_receipt_corrupt",
			});
		} finally {
			db.pragma("query_only = OFF");
			store.close();
		}
	});

	it.each([
		{ clientRequestId: "another-request" },
		{ status: "fail" as const },
		{ summary: "different evidence" },
		{ clientHead: "2".repeat(40) },
	])("refuses changed client payload %j without writing", async (change) => {
		const { store, input, consume, db } = await fixture();
		try {
			expect(consume().ok).toBe(true);
			db.pragma("query_only = ON");
			expect(
				store.replayWorkflowDecisionReceipt({ ...input, ...change }),
			).toEqual({ ok: false, reason: "replay_payload_mismatch" });
		} finally {
			db.pragma("query_only = OFF");
			store.close();
		}
	});

	it("returns the original receipt for a consumed legacy admission with SQLite writes disabled", async () => {
		const { store, input, consume, db } = await fixture();
		try {
			const first = consume();
			expect(first.ok).toBe(true);
			if (!first.ok) throw new Error(first.reason);
			db.pragma("query_only = ON");
			expect(store.replayWorkflowDecisionReceipt(input)).toEqual({
				...first,
				idempotentReplay: true,
			});
		} finally {
			db.pragma("query_only = OFF");
			store.close();
		}
	});
});
