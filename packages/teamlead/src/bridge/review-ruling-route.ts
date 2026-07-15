import type { RequestHandler } from "express";
import type {
	ReviewRulingPayload,
	ReviewRulingResult,
} from "./review-request-coordinator.js";

export interface ReviewRulingCoordinatorFace {
	reviewRuling(payload: ReviewRulingPayload): Promise<ReviewRulingResult>;
}

/**
 * Late-bound Bridge route handler for the supervised governance channel.
 * Authentication is mounted by plugin.ts with the same ingest-token middleware
 * as /review-requests; this function owns only readiness and result mapping.
 */
export function createReviewRulingHandler(holder: {
	current: ReviewRulingCoordinatorFace | undefined;
}): RequestHandler {
	return (req, res) => {
		const coordinator = holder.current;
		if (!coordinator) {
			res.status(503).json({
				accepted: false,
				reason: "review coordinator not ready",
			});
			return;
		}
		coordinator
			.reviewRuling((req.body ?? {}) as Record<string, unknown>)
			.then((result) => res.status(result.httpStatus).json(result))
			.catch((err) => {
				console.error(
					`[review-rulings] request crashed: ${err instanceof Error ? err.message : String(err)}`,
				);
				res.status(500).json({ accepted: false, reason: "internal error" });
			});
	};
}
