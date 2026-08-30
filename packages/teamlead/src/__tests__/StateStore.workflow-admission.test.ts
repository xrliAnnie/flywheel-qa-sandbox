import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalSubmissionDigest } from "flywheel-config";
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
	const result = store.admitWorkflowExecution({
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
	if (result.ok) {
		store.upsertSession({
			execution_id: String(overrides.executionId ?? "qa-exec-1"),
			issue_id: "FLY-1244",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: String(overrides.nodeId ?? "qa"),
		});
	}
	return result;
}

describe("workflow claims admission — fail-closed enrollment + immutable binding", () => {
	it("atomically enrolls the run, binds the exact QA attempt, and stores only the credential hash", async () => {
		const store = await storeWithRun();
		const result = admit(store);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(store.getWorkflowRun("run-1")).toMatchObject({
			claims_read_enrolled: 1,
			current_qa_attempt: null,
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
		expect(credential?.permanent).toBe(1);
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

	it("migrates existing QA credentials to permanent while keeping review credentials bounded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1655-permanent-migration-"));
		const dbPath = join(dir, "state.db");
		const store = await StateStore.create(dbPath);
		for (const [runId, issueId] of [
			["run-qa", "FLY-1655-QA"],
			["run-review", "FLY-1655-REVIEW"],
		] as const) {
			store.createWorkflowRun({
				runId,
				issueId,
				projectName: "flywheel",
				claimsReadEnrolled: false,
			});
		}
		const qa = store.admitWorkflowExecution({
			runId: "run-qa",
			nodeId: "qa",
			executionId: "qa-exec",
			attempt: 1,
			family: "qa_verdict",
			expiresAt: T1,
			absoluteDeadlineAt: T2,
			now: T0,
		});
		const review = store.admitWorkflowExecution({
			runId: "run-review",
			nodeId: "review",
			executionId: "review-exec",
			attempt: 1,
			family: "review_verdict",
			expiresAt: T1,
			absoluteDeadlineAt: T2,
			now: T0,
		});
		if (!qa.ok || !review.ok) throw new Error("fixture admission failed");
		store.close();

		const raw = new Database(dbPath);
		raw.pragma("foreign_keys = OFF");
		raw.exec(`
			DROP INDEX ux_workflow_submission_live;
			CREATE TABLE workflow_submission_credential_legacy (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				activation_id TEXT NOT NULL,
				credential_hash TEXT NOT NULL UNIQUE,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				family TEXT NOT NULL CHECK (family IN ('qa_verdict','review_verdict')),
				decision_capability_id INTEGER,
				issued_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				absolute_deadline_at TEXT NOT NULL,
				consumed_at TEXT,
				consumed_client_request_id TEXT,
				consumed_submission_digest TEXT,
				claim_id INTEGER,
				revoked INTEGER NOT NULL DEFAULT 0,
				revoked_reason TEXT
			);
			INSERT INTO workflow_submission_credential_legacy
				(id, activation_id, credential_hash, run_id, node_id, execution_id,
				 attempt, family, decision_capability_id, issued_at, expires_at,
				 absolute_deadline_at, consumed_at, consumed_client_request_id,
				 consumed_submission_digest, claim_id, revoked, revoked_reason)
			SELECT id, activation_id, credential_hash, run_id, node_id, execution_id,
			       attempt, family, decision_capability_id, issued_at, expires_at,
			       absolute_deadline_at, consumed_at, consumed_client_request_id,
			       consumed_submission_digest, claim_id, revoked, revoked_reason
			  FROM workflow_submission_credential;
			DROP TABLE workflow_submission_credential;
			ALTER TABLE workflow_submission_credential_legacy
				RENAME TO workflow_submission_credential;
		`);
		raw.close();

		const migrated = await StateStore.create(dbPath);
		expect(
			migrated.getWorkflowSubmissionCredential(qa.credentialId)?.permanent,
		).toBe(1);
		expect(
			migrated.getWorkflowSubmissionCredential(review.credentialId)?.permanent,
		).toBe(0);
		migrated.close();
	});
});

describe("submitWorkflowDecisionByCredential — durable exact replay", () => {
	it("rejects a late verdict after the admitted writer is superseded", async () => {
		const store = await storeWithRun();
		const admission = admit(store);
		if (!admission.ok) throw new Error("fixture admission failed");
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run_node SET state = 'superseded' WHERE run_id = 'run-1' AND node_id = 'qa' AND attempt = 1",
		);

		expect(
			store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				credential: admission.credential,
				clientRequestId: "late-verdict",
				predicate: "qa_passed",
				subjectDigest: H1,
				issuerVendor: "claude",
				issuerModel: "opus",
				subjectProducerExecutionId: "impl-exec",
				subjectProducerVendor: "codex",
				claimExpiresAt: T1,
				now: T0,
			}),
		).toEqual({ ok: false, reason: "binding_not_current" });
		expect(store.countWorkflowClaims("run-1")).toBe(0);
		store.close();
	});

	it("writes and returns one head-bound claim, consuming credential + internal capability atomically", async () => {
		const store = await storeWithRun();
		const admission = admit(store);
		expect(admission.ok).toBe(true);
		if (!admission.ok) return;
		const result = store.submitWorkflowDecisionByCredential({
			nodeReuseEnabled: false,
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
			nodeReuseEnabled: false,
			...input,
			now: T0,
		});
		expect(first.ok).toBe(true);
		const replay = store.submitWorkflowDecisionByCredential({
			nodeReuseEnabled: false,
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
				nodeReuseEnabled: false,
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

	it("rejects a genuinely expired unconsumed credential without minting a claim", async () => {
		const store = await storeWithRun();
		const admission = admit(store, { family: "review_verdict" });
		if (!admission.ok) throw new Error(admission.reason);

		expect(
			store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				credential: admission.credential,
				clientRequestId: "expired-request",
				predicate: "codex_approved",
				subjectDigest: H1,
				issuerVendor: "claude",
				issuerModel: "opus",
				subjectProducerExecutionId: "impl-exec",
				subjectProducerVendor: "codex",
				claimExpiresAt: T2,
				now: T2,
			}),
		).toEqual({ ok: false, reason: "credential_expired" });
		expect(store.countWorkflowClaims("run-1")).toBe(0);
	});

	it("accepts an expired permanent QA credential and mints a permanent claim through a fresh internal capability", async () => {
		const store = await storeWithRun();
		const admission = admit(store);
		if (!admission.ok) throw new Error(admission.reason);

		const result = store.submitWorkflowDecisionByCredential({
			nodeReuseEnabled: false,
			credential: admission.credential,
			clientRequestId: "late-qa-verdict",
			predicate: "qa_passed",
			subjectDigest: H1,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: "caller-controlled-garbage",
			now: T2,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(store.getWorkflowClaim(result.claimId)).toMatchObject({
			expires_at: null,
			permanent: 1,
		});
		const credential = store.getWorkflowSubmissionCredential(
			admission.credentialId,
		);
		const capability = store.getWorkflowDecisionCapability(
			credential?.decision_capability_id ?? -1,
		);
		expect(Date.parse(capability?.expires_at ?? "")).toBeGreaterThan(
			Date.parse(capability?.issued_at ?? ""),
		);
		expect(Date.parse(capability?.expires_at ?? "")).toBeLessThanOrEqual(
			Date.parse(capability?.absolute_deadline_at ?? ""),
		);
	});

	it("keeps the bounded credential replay digest byte-identical to the legacy shape", async () => {
		const store = await storeWithRun();
		const admission = admit(store, { family: "review_verdict" });
		if (!admission.ok) throw new Error(admission.reason);
		const input = {
			credential: admission.credential,
			clientRequestId: "legacy-bounded-request",
			predicate: "codex_approved",
			subjectDigest: H1,
			issuerVendor: "claude",
			issuerModel: "opus",
			subjectProducerExecutionId: "impl-exec",
			subjectProducerVendor: "codex",
			claimExpiresAt: T1,
			evidence: { verdict: "approved" },
		};

		expect(
			store.submitWorkflowDecisionByCredential({ ...input, now: T0 }).ok,
		).toBe(true);
		expect(
			store.getWorkflowSubmissionCredential(admission.credentialId)
				?.consumed_submission_digest,
		).toBe(
			canonicalSubmissionDigest({
				clientRequestId: input.clientRequestId,
				predicate: input.predicate,
				subjectKind: "git_head",
				subjectDigest: input.subjectDigest,
				issuerVendor: input.issuerVendor,
				issuerModel: input.issuerModel,
				subjectProducerExecutionId: input.subjectProducerExecutionId,
				subjectProducerVendor: input.subjectProducerVendor,
				claimExpiresAt: input.claimExpiresAt,
				evidence: input.evidence,
			}),
		);
		expect(
			store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: false,
				...input,
				now: "2026-07-15T00:00:00.000Z",
			}),
		).toMatchObject({ ok: true, idempotentReplay: true });
	});

	it.each(["canceled", "failed", "completed"])(
		"revokes an unconsumed permanent credential when its QA session becomes %s",
		async (status) => {
			const store = await storeWithRun();
			store.upsertSession({
				execution_id: "qa-exec-1",
				issue_id: "FLY-1244",
				project_name: "flywheel",
				status: "running",
			});
			const admission = admit(store);
			if (!admission.ok) throw new Error(admission.reason);
			store.forceStatus("qa-exec-1", status, T0);

			expect(
				store.submitWorkflowDecisionByCredential({
					nodeReuseEnabled: false,
					credential: admission.credential,
					clientRequestId: `terminal-${status}`,
					predicate: "qa_passed",
					subjectDigest: H1,
					issuerVendor: "claude",
					issuerModel: "opus",
					subjectProducerExecutionId: "impl-exec",
					subjectProducerVendor: "codex",
					claimExpiresAt: T1,
					now: T0,
				}),
			).toEqual({ ok: false, reason: "credential_revoked" });
		},
	);
});
