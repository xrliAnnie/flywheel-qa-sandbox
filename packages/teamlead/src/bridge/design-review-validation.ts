import type { StateStore } from "../StateStore.js";
import { resolveRequiredReviewModel } from "../workflow-review-routing.js";
import { snapshotDesignReviewPlan } from "./design-review-manifest.js";
import { reviewModelMatches } from "./review-round-ingest.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const CODEX_ID_RE = /^[0-9A-Za-z-]{8,128}$/;

export type DesignReviewValidationResult =
	| { allowed: true; reviewerModelChecked: true }
	| { allowed: false; reason: string; httpStatus: 400 | 404 | 409 | 500 };

export interface ReviewerModelProjection {
	reviewerModel: string;
	reviewerEffort: string;
	codexThreadId: string;
	codexTurnId: string;
}

/** FLY-2891: the verified reviewer-model fields every new gate sends. */
export function readReviewerModelProjection(
	body: Record<string, unknown>,
): ReviewerModelProjection | undefined {
	const model = requiredString(body, "reviewerModel");
	const effort = requiredString(body, "reviewerEffort");
	const thread = body.codexThreadId;
	const turn = body.codexTurnId;
	if (
		!model ||
		!effort ||
		model.length > 128 ||
		effort.length > 128 ||
		typeof thread !== "string" ||
		!CODEX_ID_RE.test(thread) ||
		typeof turn !== "string" ||
		!CODEX_ID_RE.test(turn)
	)
		return undefined;
	return {
		reviewerModel: model,
		reviewerEffort: effort,
		codexThreadId: thread,
		codexTurnId: turn,
	};
}

/**
 * FLY-2891: compare the review's verified model with the route's required
 * reviewer model. The required value is route config, not a manifest secret,
 * so it may be echoed. A routing failure denies rather than skipping.
 */
export function checkReviewerModel(
	store: StateStore,
	executionId: string,
	reviewType: "design" | "code",
	projection: ReviewerModelProjection,
	requestId?: string,
): { ok: true } | { ok: false; reason: string; httpStatus: 409 | 500 } {
	let required: ReturnType<typeof resolveRequiredReviewModel>;
	try {
		required = resolveRequiredReviewModel(
			store,
			executionId,
			reviewType,
			requestId,
		);
	} catch {
		return {
			ok: false,
			reason: `cannot resolve the required ${reviewType} reviewer model for this execution`,
			httpStatus: 500,
		};
	}
	if (
		required &&
		reviewModelMatches(
			{ model: projection.reviewerModel, effort: projection.reviewerEffort },
			required,
		) !== true
	)
		return {
			ok: false,
			reason: `reviewer model mismatch: request requires ${required.reviewerModel}/${required.reviewerEffort}, review ran ${projection.reviewerModel}/${projection.reviewerEffort}`,
			httpStatus: 409,
		};
	return { ok: true };
}

function requiredString(
	body: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = body[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Validate only the runner's result projection against StateStore authority.
 * Denials deliberately contain a reason but never echo the expected manifest.
 */
export function validateDesignReviewProjection(
	store: StateStore,
	body: Record<string, unknown>,
): DesignReviewValidationResult {
	const executionId = requiredString(body, "executionId");
	const requestId = requiredString(body, "requestId");
	const reviewedTarget = requiredString(body, "reviewedTarget");
	const reviewedPlanBlobSha = requiredString(
		body,
		"reviewedPlanBlobSha",
	)?.toLowerCase();
	if (
		!executionId ||
		body.reviewType !== "design" ||
		body.status !== "APPROVED" ||
		!requestId ||
		!reviewedTarget ||
		!reviewedPlanBlobSha ||
		!FULL_SHA_RE.test(reviewedPlanBlobSha)
	) {
		return {
			allowed: false,
			reason: "invalid design review result projection",
			httpStatus: 400,
		};
	}
	const reviewerModel = readReviewerModelProjection(body);
	if (!reviewerModel) {
		return {
			allowed: false,
			reason:
				"design review result missing reviewer model (upgrade flywheel-comm and rerun the gate)",
			httpStatus: 400,
		};
	}

	const manifest = store.getCurrentDesignReviewManifest(executionId);
	if (!manifest) {
		return {
			allowed: false,
			reason: "no current design review request",
			httpStatus: 404,
		};
	}
	if (
		requestId !== manifest.request_id ||
		reviewedTarget !== manifest.expected_plan_path ||
		reviewedPlanBlobSha !== manifest.expected_blob_sha
	) {
		return {
			allowed: false,
			reason: "design review result does not match the current request",
			httpStatus: 409,
		};
	}
	const modelCheck = checkReviewerModel(
		store,
		executionId,
		"design",
		reviewerModel,
		manifest.request_id,
	);
	if (!modelCheck.ok) {
		return {
			allowed: false,
			reason: modelCheck.reason,
			httpStatus: modelCheck.httpStatus,
		};
	}

	const session = store.getSession(executionId);
	if (
		!session ||
		!session.worktree_path ||
		session.project_name !== manifest.project_name ||
		session.plan_path !== manifest.expected_plan_path
	) {
		return {
			allowed: false,
			reason: "design review session binding is unavailable or stale",
			httpStatus: 409,
		};
	}

	const snapshot = snapshotDesignReviewPlan(
		session,
		manifest.expected_plan_path,
	);
	if (!snapshot.ok) {
		return {
			allowed: false,
			reason:
				snapshot.reason === "dirty"
					? snapshot.message
					: "design plan is missing or cannot be resolved in the session worktree",
			httpStatus: 409,
		};
	}
	if (
		snapshot.blobSha !== manifest.expected_blob_sha ||
		snapshot.blobSha !== reviewedPlanBlobSha
	) {
		return {
			allowed: false,
			reason: "committed design plan changed after the review request",
			httpStatus: 409,
		};
	}
	const proof = store.getDesignReviewProofForManifest(
		manifest.request_id,
		manifest.revision,
	);
	const proofMatches =
		proof !== null &&
		proof.execution_id === executionId &&
		proof.project_name === manifest.project_name &&
		proof.plan_path === manifest.expected_plan_path &&
		proof.expected_blob_sha === snapshot.blobSha;

	// This endpoint validates the runner's projection, but it is not the
	// independently accepted review verdict that may seal authority. Missing or
	// mismatched proof therefore stays non-authoritative without rejecting the
	// shared result producer. An unrelated commit may move HEAD while the exact
	// reviewed plan blob remains unchanged.
	if (proofMatches && proof?.state === "captured") {
		store.validateDesignReviewApprovalProof({
			proofId: proof.proof_id,
			validationReceiptId: `design-review-validation:${manifest.request_id}:${manifest.revision}`,
			reviewedCommitSha: proof.reviewed_commit_sha,
			expectedBlobSha: snapshot.blobSha,
			validatedAt: new Date().toISOString(),
		});
	}
	return { allowed: true, reviewerModelChecked: true };
}
