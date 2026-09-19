import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const COMMIT = "1".repeat(40);
const BLOB = "2".repeat(40);

describe("FLY-2737 durable reviewed-plan approval proof", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	it("captures immutable coordinator identity and seals only after validation", () => {
		const captured = store.captureDesignReviewApprovalProof({
			lane: "coordinator",
			projectName: "flywheel",
			issueId: "FLY-2737",
			executionId: "exec-1",
			repositoryIdentity: "__main__",
			reviewJobRequestId: "review-request-1",
			planPath: "engineering/doc/FLY-2737-three-point-auto/plan.md",
			reviewedCommitSha: COMMIT,
			expectedBlobSha: BLOB,
			capturedAt: "2026-09-18T18:00:00.000Z",
		});

		expect(captured.state).toBe("captured");
		expect(
			store.sealDesignReviewApprovalProof({
				proofId: captured.proof_id,
				verdictReceiptId: "verdict-1",
				approvedAt: "2026-09-18T18:02:00.000Z",
			}),
		).toEqual({ ok: false, reason: "proof_not_validated" });

		const validated = store.validateDesignReviewApprovalProof({
			proofId: captured.proof_id,
			validationReceiptId: "validation-1",
			reviewedCommitSha: COMMIT,
			expectedBlobSha: BLOB,
			validatedAt: "2026-09-18T18:01:00.000Z",
		});
		expect(validated.state).toBe("validated");

		expect(
			store.sealDesignReviewApprovalProof({
				proofId: captured.proof_id,
				verdictReceiptId: "verdict-1",
				approvedAt: "2026-09-18T18:02:00.000Z",
			}),
		).toMatchObject({ ok: true, proof: { state: "approved" } });
		expect(
			store.getApprovedDesignReviewProofForReviewJob("review-request-1"),
		).toMatchObject({
			proof_id: captured.proof_id,
			reviewed_commit_sha: COMMIT,
			expected_blob_sha: BLOB,
			verdict_receipt_id: "verdict-1",
		});
	});

	it("keeps manifest and coordinator identities distinct and rejects conflicting replay", () => {
		const input = {
			lane: "manifest" as const,
			projectName: "flywheel",
			issueId: "FLY-2737",
			executionId: "exec-2",
			repositoryIdentity: "__main__",
			manifestRequestId: "manifest-request-1",
			manifestRevision: 1,
			planPath: "engineering/doc/FLY-2737-three-point-auto/plan.md",
			reviewedCommitSha: COMMIT,
			expectedBlobSha: BLOB,
			capturedAt: "2026-09-18T18:00:00.000Z",
		};
		const first = store.captureDesignReviewApprovalProof(input);
		expect(store.captureDesignReviewApprovalProof(input)).toEqual(first);
		expect(() =>
			store.captureDesignReviewApprovalProof({
				...input,
				expectedBlobSha: "3".repeat(40),
			}),
		).toThrow(/replay conflict/i);
		expect(
			store.getApprovedDesignReviewProofForReviewJob("manifest-request-1"),
		).toBeNull();
	});

	it("rejects validation for a different commit or blob and remains unapproved", () => {
		const captured = store.captureDesignReviewApprovalProof({
			lane: "coordinator",
			projectName: "flywheel",
			issueId: "FLY-2737",
			executionId: "exec-3",
			repositoryIdentity: "__main__",
			reviewJobRequestId: "review-request-3",
			planPath: "engineering/doc/FLY-2737-three-point-auto/plan.md",
			reviewedCommitSha: COMMIT,
			expectedBlobSha: BLOB,
			capturedAt: "2026-09-18T18:00:00.000Z",
		});

		expect(() =>
			store.validateDesignReviewApprovalProof({
				proofId: captured.proof_id,
				validationReceiptId: "validation-wrong",
				reviewedCommitSha: "4".repeat(40),
				expectedBlobSha: BLOB,
				validatedAt: "2026-09-18T18:01:00.000Z",
			}),
		).toThrow(/binding mismatch/i);
		expect(
			store.getApprovedDesignReviewProofForReviewJob("review-request-3"),
		).toBeNull();
	});

	it("captures the coordinator proof atomically with a new review job", () => {
		const inserted = store.insertCodexReviewJob({
			requestId: "review-request-atomic",
			executionId: "exec-atomic",
			issueId: "FLY-2737",
			projectName: "flywheel",
			reviewType: "design",
			questionId: "question-atomic",
			targetPath: "engineering/doc/FLY-2737-three-point-auto/plan.md",
			authorFamily: "codex",
			designPlanProof: {
				planPath: "engineering/doc/FLY-2737-three-point-auto/plan.md",
				reviewedCommitSha: COMMIT,
				expectedBlobSha: BLOB,
				capturedAt: "2026-09-18T18:00:00.000Z",
			},
		});

		expect(inserted.inserted).toBe(true);
		expect(
			store.getDesignReviewProofForReviewJob("review-request-atomic"),
		).toMatchObject({
			state: "captured",
			review_job_request_id: "review-request-atomic",
			reviewed_commit_sha: COMMIT,
			expected_blob_sha: BLOB,
		});
	});
});
