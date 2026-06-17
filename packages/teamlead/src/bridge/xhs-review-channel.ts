/**
 * FLY-286 PR-2: the `web-local` ReviewChannel adapter.
 *
 * Per the approved overall plan + codex design R1#4: the pure `ReviewChannel`
 * interface is the FLY-298 reuse seam; the concrete web-local ADAPTER lives in
 * teamlead/Bridge (NOT flywheel-comm). FLY-298 will add a `web-public` adapter
 * over the SAME AnalysisStore/FeedbackStore + locator records.
 *
 * `deliver` persists the analysis run + a reportToken→{project,collectionId,
 * runToken} locator, and returns the localhost review URL. `collectFeedback`
 * resolves the locator back to the FeedbackStore.
 */

import type {
	AnalysisStore,
	FeedbackStore,
	XiaohongshuAnalysisRun,
	XiaohongshuFeedbackFile,
} from "flywheel-comm/xiaohongshu-analysis-store";
import {
	type ReviewLocator,
	XIAOHONGSHU_LOCATOR_SCHEMA_VERSION,
} from "./xhs-review-locator.js";

/** The seam reused by FLY-298 (web-public). */
export interface ReviewChannel {
	/** Persist a run + locator; return the opaque reportToken + review URL. */
	deliver(run: XiaohongshuAnalysisRun): { reportToken: string; url: string };
	/** Resolve a reportToken to its collected feedback (null if none/unknown). */
	collectFeedback(reportToken: string): XiaohongshuFeedbackFile | null;
}

export interface WebLocalReviewChannelDeps {
	analysis: AnalysisStore;
	feedback: FeedbackStore;
	/** Locator write/read already bound to the trusted state dir. */
	writeLocator: (locator: ReviewLocator) => void;
	readLocator: (reportToken: string) => ReviewLocator | null;
	/** Bridge loopback base, e.g. "http://127.0.0.1:9876". */
	baseUrl: string;
	/** Unguessable reportToken minter (128-bit hex). */
	randomToken: () => string;
	now: () => string; // ISO
}

export function createWebLocalReviewChannel(
	deps: WebLocalReviewChannelDeps,
): ReviewChannel {
	const base = deps.baseUrl.replace(/\/+$/, "");
	return {
		deliver(run) {
			const reportToken = deps.randomToken();
			const deliveredAt = deps.now();
			// Persist the run marked DELIVERED (codex code R1#3): the merged schema
			// documents `review` as set once the review page is delivered. Stamp it
			// so the stored run is consistent with the locator/URL we return.
			deps.analysis.writeRun({ ...run, review: { reportToken, deliveredAt } });
			deps.writeLocator({
				schemaVersion: XIAOHONGSHU_LOCATOR_SCHEMA_VERSION,
				reportToken,
				project: run.project,
				collectionId: run.collectionId,
				runToken: run.runToken,
				createdAt: deliveredAt,
			});
			return { reportToken, url: `${base}/xhs-review/${reportToken}` };
		},
		collectFeedback(reportToken) {
			const loc = deps.readLocator(reportToken);
			if (!loc) return null;
			return deps.feedback.readFeedback(
				loc.project,
				loc.collectionId,
				loc.runToken,
			);
		},
	};
}
