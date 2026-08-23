import type { StateStore } from "../StateStore.js";
import { snapshotDesignReviewPlan } from "./design-review-manifest.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export type DesignReviewValidationResult =
	| { allowed: true }
	| { allowed: false; reason: string; httpStatus: 400 | 404 | 409 };

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
	return { allowed: true };
}
