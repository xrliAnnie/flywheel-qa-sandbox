import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const T0 = "2026-07-14T00:00:00.000Z";
const T1 = "2026-07-14T01:00:00.000Z";
const T2 = "2026-07-14T02:00:00.000Z";

async function storeWithRun(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1244",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	return store;
}

function admit(store: StateStore, overrides: Record<string, unknown> = {}) {
	return store.admitWorkflowExecution({
		runId: "run-1",
		nodeId: "qa",
		executionId: "qa-exec-1",
		attempt: 1,
		family: "qa_verdict",
		expiresAt: T1,
		absoluteDeadlineAt: T2,
		now: T0,
		...overrides,
	});
}

describe("workflow claims admission — fail-closed enrollment + immutable binding", () => {
	it("atomically enrolls the run, binds the exact QA attempt, and stores only the credential hash", async () => {
		const store = await storeWithRun();
		const result = admit(store);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(store.getWorkflowRun("run-1")).toMatchObject({
			claims_read_enrolled: 1,
			current_qa_attempt: 1,
		});
		expect(store.getWorkflowRunNode("run-1", "qa", 1)).toMatchObject({
			execution_id: "qa-exec-1",
		});
		expect(store.getWorkflowExecutionBinding("qa-exec-1")).toMatchObject({
			run_id: "run-1",
			node_id: "qa",
			attempt: 1,
		});
		const credential = store.getWorkflowSubmissionCredential(
			result.credentialId,
		);
		expect(credential?.credential_hash).toBe(
			createHash("sha256").update(result.credential).digest("hex"),
		);
		expect(credential?.credential_hash).not.toBe(result.credential);
	});

	it("a conflicting physical execution for the same logical attempt refuses with no partial enrollment", async () => {
		const store = await storeWithRun();
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "qa",
			attempt: 1,
			state: "running",
			executionId: "already-running",
		});
		const result = admit(store);
		expect(result).toEqual({ ok: false, reason: "attempt_execution_conflict" });
		expect(store.getWorkflowRun("run-1")).toMatchObject({
			claims_read_enrolled: 0,
			current_qa_attempt: null,
		});
		expect(store.getWorkflowExecutionBinding("qa-exec-1")).toBeUndefined();
		expect(store.getWorkflowSubmissionCredential(1)).toBeUndefined();
	});

	it("the execution binding rejects UPDATE and DELETE at the database layer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1244-binding-"));
		const dbPath = join(dir, "state.db");
		const store = await StateStore.create(dbPath);
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1244",
			projectName: "flywheel",
			claimsReadEnrolled: false,
		});
		expect(admit(store).ok).toBe(true);
		store.close();
		const raw = new Database(dbPath);
		try {
			expect(() =>
				raw
					.prepare(
						"UPDATE workflow_execution_binding SET attempt = 2 WHERE execution_id = 'qa-exec-1'",
					)
					.run(),
			).toThrow(/immutable/);
			expect(() =>
				raw
					.prepare(
						"DELETE FROM workflow_execution_binding WHERE execution_id = 'qa-exec-1'",
					)
					.run(),
			).toThrow(/immutable/);
		} finally {
			raw.close();
		}
	});
});

describe("submitWorkflowDecisionByCredential — durable exact replay", () => {
	it("writes and returns one head-bound claim, consuming credential + internal capability atomically", async () => {
		const store = await storeWithRun();
		const admission = admit(store);
		expect(admission.ok).toBe(true);
		if (!admission.ok) return;
		const result = store.submitWorkflowDecisionByCredential({
			credential: admission.credential,
			clientRequestId: "req-1",
			predicate: "qa_passed",
			subjectDigest: H1,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: T1,
			now: T0,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const claim = store.getWorkflowClaim(result.claimId);
		expect(claim).toMatchObject({
			predicate: "qa_passed",
			subject_digest: H1,
			issuer_execution_id: "qa-exec-1",
			attempt: 1,
		});
		const credential = store.getWorkflowSubmissionCredential(
			admission.credentialId,
		);
		expect(credential?.claim_id).toBe(result.claimId);
		expect(credential?.decision_capability_id).toBeTypeOf("number");
		expect(
			store.getWorkflowDecisionCapability(
				credential?.decision_capability_id ?? -1,
			)?.consumed_claim_id,
		).toBe(result.claimId);
	});

	it("claim-commit/response-loss replay returns the same claim before checking expiry", async () => {
		const store = await storeWithRun();
		const admission = admit(store);
		if (!admission.ok) throw new Error(admission.reason);
		const input = {
			credential: admission.credential,
			clientRequestId: "req-1",
			predicate: "qa_passed",
			subjectDigest: H1,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: T1,
		};
		const first = store.submitWorkflowDecisionByCredential({
			...input,
			now: T0,
		});
		expect(first.ok).toBe(true);
		const replay = store.submitWorkflowDecisionByCredential({
			...input,
			now: "2026-07-15T00:00:00.000Z",
		});
		expect(replay).toMatchObject({
			ok: true,
			idempotentReplay: true,
			claimId: first.ok ? first.claimId : -1,
		});
		expect(store.countWorkflowClaims("run-1")).toBe(1);
	});

	it("a consumed credential with mismatched request bytes refuses; unknown/expired credentials write nothing", async () => {
		const store = await storeWithRun();
		const admission = admit(store);
		if (!admission.ok) throw new Error(admission.reason);
		const submit = (overrides: Record<string, unknown> = {}) =>
			store.submitWorkflowDecisionByCredential({
				credential: admission.credential,
				clientRequestId: "req-1",
				predicate: "qa_passed",
				subjectDigest: H1,
				issuerVendor: "claude",
				issuerModel: "opus",
				subjectProducerExecutionId: "impl-exec",
				subjectProducerVendor: "codex",
				claimExpiresAt: T1,
				now: T0,
				...overrides,
			});
		expect(submit().ok).toBe(true);
		expect(submit({ subjectDigest: H2 })).toEqual({
			ok: false,
			reason: "replay_payload_mismatch",
		});
		expect(submit({ credential: "unknown" })).toEqual({
			ok: false,
			reason: "credential_not_found",
		});
		expect(store.countWorkflowClaims("run-1")).toBe(1);
	});
});
