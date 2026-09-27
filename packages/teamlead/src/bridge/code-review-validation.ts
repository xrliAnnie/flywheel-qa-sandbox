import type { StateStore } from "../StateStore.js";
import {
	checkReviewerModel,
	readReviewerModelProjection,
} from "./design-review-validation.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export type CodeReviewValidationResult =
	| { allowed: true; reviewerModelChecked: true }
	| { allowed: false; reason: string; httpStatus: 400 | 404 | 409 | 500 };

/**
 * FLY-2891: the code review gate's Bridge check. The runner's gate has
 * already bound the result to the current HEAD and verified the model its
 * Codex turn ran; the Bridge compares that model with the route's required
 * code reviewer model and says so explicitly (`reviewerModelChecked`).
 */
export function validateCodeReviewProjection(
	store: StateStore,
	body: Record<string, unknown>,
): CodeReviewValidationResult {
	const executionId =
		typeof body.executionId === "string" && body.executionId.trim()
			? body.executionId.trim()
			: undefined;
	const head =
		typeof body.reviewedHeadSha === "string"
			? body.reviewedHeadSha.toLowerCase()
			: undefined;
	if (
		!executionId ||
		body.reviewType !== "code" ||
		!head ||
		!FULL_SHA_RE.test(head)
	)
		return {
			allowed: false,
			reason: "invalid code review result projection",
			httpStatus: 400,
		};
	const reviewerModel = readReviewerModelProjection(body);
	if (!reviewerModel)
		return {
			allowed: false,
			reason:
				"code review result missing reviewer model (upgrade flywheel-comm and rerun the gate)",
			httpStatus: 400,
		};
	if (!store.getSession(executionId))
		return {
			allowed: false,
			reason: "no session for this execution",
			httpStatus: 404,
		};
	const modelCheck = checkReviewerModel(
		store,
		executionId,
		"code",
		reviewerModel,
	);
	if (!modelCheck.ok)
		return {
			allowed: false,
			reason: modelCheck.reason,
			httpStatus: modelCheck.httpStatus,
		};
	return { allowed: true, reviewerModelChecked: true };
}
