/**
 * FLY-286 PR-3: pure review-delivery ARTIFACTS helper.
 *
 * Shared by the teamlead web-local `ReviewChannel` adapter AND the
 * `xhs-analysis deliver` CLI so the two never diverge (codex design R1#4/R3#1).
 * It is PURE artifact creation — NO owner, NO XiaohongshuState mutation: it
 * mints a reportToken, writes the locator FIRST then the delivered run, and
 * returns the result. The OWNER-FENCED state update (lastAnalysisRunToken /
 * lastReportToken / pendingFeedbackRunTokens) is a SEPARATE step
 * (`recordAnalysisDelivered` in xiaohongshu-state) done only by the CLI path.
 *
 * Write order (codex R1#5): locator first, then the delivered run. A crash
 * after the locator write leaves an orphan locator — harmless: the GET route
 * 404s when the run is absent. The caller emits the URL ONLY after this returns
 * (i.e. after both writes succeeded).
 */

import type { XiaohongshuAnalysisRun } from "./xiaohongshu-analysis-store.js";
import {
	type ReviewLocator,
	XIAOHONGSHU_LOCATOR_SCHEMA_VERSION,
} from "./xiaohongshu-review-locator.js";

export interface DeliverReviewArtifactsDeps {
	/** Persist the delivered run (AnalysisStore.writeRun). */
	writeRun: (run: XiaohongshuAnalysisRun) => void;
	writeLocator: (locator: ReviewLocator) => void;
	run: XiaohongshuAnalysisRun;
	/** Bridge loopback base, e.g. "http://127.0.0.1:9876". */
	baseUrl: string;
	/** Unguessable 128-bit reportToken minter. */
	randomToken: () => string;
	now: () => string; // ISO
}

export interface DeliveredArtifacts {
	reportToken: string;
	url: string;
	deliveredRun: XiaohongshuAnalysisRun;
}

/** Validate + normalize a delivery base URL (fail-closed; codex R1#8). */
export function validateBaseUrl(baseUrl: string): string {
	if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
		throw new Error("xiaohongshu-review-delivery: base URL is required");
	}
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let u: URL;
	try {
		u = new URL(trimmed);
	} catch {
		throw new Error(
			`xiaohongshu-review-delivery: invalid base URL ${JSON.stringify(baseUrl)}`,
		);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error(
			`xiaohongshu-review-delivery: base URL must be http(s), got ${u.protocol}`,
		);
	}
	return trimmed;
}

/**
 * Mint a reportToken, write the locator FIRST then the delivered run, and
 * return `{reportToken, url, deliveredRun}`. Throws (no partial return) if a
 * write fails — the caller emits the URL only on success.
 */
export function deliverReviewArtifacts(
	deps: DeliverReviewArtifactsDeps,
): DeliveredArtifacts {
	const base = validateBaseUrl(deps.baseUrl);
	const reportToken = deps.randomToken();
	const deliveredAt = deps.now();
	const deliveredRun: XiaohongshuAnalysisRun = {
		...deps.run,
		review: { reportToken, deliveredAt },
	};
	// Locator FIRST (R1#5): an orphan locator is harmless (route 404s on missing
	// run); a delivered-run-without-locator would be unreachable.
	deps.writeLocator({
		schemaVersion: XIAOHONGSHU_LOCATOR_SCHEMA_VERSION,
		reportToken,
		project: deps.run.project,
		collectionId: deps.run.collectionId,
		runToken: deps.run.runToken,
		createdAt: deliveredAt,
	});
	deps.writeRun(deliveredRun);
	return {
		reportToken,
		url: `${base}/xhs-review/${reportToken}`,
		deliveredRun,
	};
}
