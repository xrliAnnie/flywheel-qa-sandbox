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
import { deliverReviewArtifacts } from "flywheel-comm/xiaohongshu-review-delivery";
import type { ReviewLocator } from "flywheel-comm/xiaohongshu-review-locator";

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
	return {
		deliver(run) {
			// Shared pure artifact helper (codex R3#1): mint token + locator-first +
			// delivered run. The adapter does NOT mutate XiaohongshuState (that
			// owner-fenced step belongs to the CLI path only).
			const { reportToken, url } = deliverReviewArtifacts({
				writeRun: (r) => deps.analysis.writeRun(r),
				writeLocator: deps.writeLocator,
				run,
				baseUrl: deps.baseUrl,
				randomToken: deps.randomToken,
				now: deps.now,
			});
			return { reportToken, url };
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
