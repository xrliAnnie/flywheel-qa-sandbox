/**
 * FLY-286 PR-2: web-local review route handlers (pure, injected deps — testable
 * without Express, like fleet-routes).
 *
 * Security model (codex design review, Fleet-mirrored):
 *  - mounted BEFORE the /api Bearer middleware (browser holds no apiToken);
 *  - GET: loopback Host + valid reportToken locator; Origin/Referer NOT required
 *    (a founder may paste the localhost URL → top-level navigation, no Origin).
 *  - POST: loopback Host + same-origin (Origin/Referer) + a valid run-scoped
 *    session token. Many one-action POSTs per page → a short-TTL session token
 *    (not single-use) + replace-by-noteId merge for idempotency.
 *  - feedback read-merge-write runs under the collection lock (injected) so
 *    concurrent POSTs can't clobber the whole-file FeedbackStore write.
 */

import { randomBytes } from "node:crypto";
import type {
	AnalysisStore,
	FeedbackStore,
	XiaohongshuFeedbackFile,
	XiaohongshuReviewAction,
	XiaohongshuReviewActionKind,
} from "flywheel-comm/xiaohongshu-analysis-store";
import type { ReviewLocator } from "flywheel-comm/xiaohongshu-review-locator";
import { isSameOrigin, loopbackSelfOrigin } from "./loopback-origin.js";
import { buildReviewHtml } from "./xhs-review-html.js";

export const FEEDBACK_SCHEMA_VERSION = 1 as const;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_COMMENT_LEN = 4000;
const ACTION_KINDS: readonly XiaohongshuReviewActionKind[] = [
	"keep",
	"close_created",
	"promote_candidate",
	"edit",
	"skip",
];

export interface ReviewHttpResult {
	status: number;
	/** string → text/html body; object → JSON body. */
	body: string | Record<string, unknown>;
	contentType?: string;
	headers?: Record<string, string>;
}

// ─── run-scoped session token store (in-memory, short TTL) ────────────────────

export interface ReviewTokenStore {
	/** Mint a token bound to a reportToken. */
	mint(reportToken: string): string;
	/** True iff `token` is live and bound to `reportToken`. */
	verify(token: string, reportToken: string): boolean;
}

export function createInMemoryTokenStore(
	opts: { now?: () => number; ttlMs?: number; randomHex?: () => string } = {},
): ReviewTokenStore {
	const now = opts.now ?? (() => Date.now());
	const ttlMs = opts.ttlMs ?? SESSION_TTL_MS;
	const randomHex = opts.randomHex ?? (() => randomBytes(24).toString("hex"));
	const live = new Map<string, { reportToken: string; expiresAt: number }>();
	return {
		mint(reportToken) {
			const token = randomHex();
			live.set(token, { reportToken, expiresAt: now() + ttlMs });
			return token;
		},
		verify(token, reportToken) {
			const e = live.get(token);
			if (!e) return false;
			if (e.expiresAt <= now()) {
				live.delete(token);
				return false;
			}
			return e.reportToken === reportToken;
		},
	};
}

// ─── deps ─────────────────────────────────────────────────────────────────────

export interface XhsReviewDeps {
	analysis: AnalysisStore;
	feedback: FeedbackStore;
	readLocator: (reportToken: string) => ReviewLocator | null;
	/** Serialize a per-collection critical section (prod wraps withCollectionLock). */
	runExclusive: <T>(
		project: string,
		collectionId: string,
		fn: () => T | Promise<T>,
	) => Promise<T>;
	tokens: ReviewTokenStore;
	nonce: () => string;
	now: () => string; // ISO
}

// Non-throwing report-token format guard (codex code R1#2 + R2#1): reportToken
// is an untrusted route param. The guard bounds BOTH charset AND length — a
// 128-bit hex token is 32 chars, so 128 is generous; without the length cap an
// overlong-but-safe-char token reaches the fs locator and can throw
// ENAMETOOLONG → 500. A malformed/overlong token yields a controlled 404 before
// readLocator is ever called.
const SAFE_REPORT_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;

function cspHeader(nonce: string): string {
	return [
		"default-src 'none'",
		"script-src 'none'",
		`style-src 'nonce-${nonce}'`,
		"form-action 'self'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
		"img-src 'none'",
	].join("; ");
}

/** GET /xhs-review/:reportToken — serve the interactive review page. */
export async function handleGetReview(
	deps: XhsReviewDeps,
	reportToken: string,
	headers: Record<string, string | undefined>,
): Promise<ReviewHttpResult> {
	// Loopback Host only (anti-DNS-rebinding); GET does NOT require Origin/Referer.
	if (!loopbackSelfOrigin(headers.host)) {
		return { status: 403, body: { error: "non-loopback host" } };
	}
	if (!SAFE_REPORT_TOKEN.test(reportToken)) {
		return { status: 404, body: { error: "unknown report" } };
	}
	const loc = deps.readLocator(reportToken);
	if (!loc) return { status: 404, body: { error: "unknown report" } };
	const run = deps.analysis.readRun(
		loc.project,
		loc.collectionId,
		loc.runToken,
	);
	if (!run) return { status: 404, body: { error: "run not found" } };
	const nonce = deps.nonce();
	const sessionToken = deps.tokens.mint(reportToken);
	const html = buildReviewHtml({ run, nonce, sessionToken, reportToken });
	return {
		status: 200,
		body: html,
		contentType: "text/html; charset=utf-8",
		headers: { "Content-Security-Policy": cspHeader(nonce) },
	};
}

/** POST /xhs-review/:reportToken/action — record ONE structured action + comment. */
export async function handlePostAction(
	deps: XhsReviewDeps,
	reportToken: string,
	body: Record<string, unknown>,
	headers: Record<string, string | undefined>,
): Promise<ReviewHttpResult> {
	const selfOrigin = loopbackSelfOrigin(headers.host);
	if (!selfOrigin) return { status: 403, body: { error: "non-loopback host" } };
	if (!isSameOrigin(headers, selfOrigin)) {
		return { status: 403, body: { error: "cross-origin" } };
	}
	if (!SAFE_REPORT_TOKEN.test(reportToken)) {
		return { status: 404, body: { error: "unknown report" } };
	}
	const sessionToken =
		typeof body.sessionToken === "string" ? body.sessionToken : "";
	if (!deps.tokens.verify(sessionToken, reportToken)) {
		return { status: 401, body: { error: "invalid or expired session token" } };
	}
	const loc = deps.readLocator(reportToken);
	if (!loc) return { status: 404, body: { error: "unknown report" } };
	const run = deps.analysis.readRun(
		loc.project,
		loc.collectionId,
		loc.runToken,
	);
	if (!run) return { status: 404, body: { error: "run not found" } };

	const noteId = typeof body.noteId === "string" ? body.noteId : "";
	const action = body.action as XiaohongshuReviewActionKind;
	const comment = typeof body.comment === "string" ? body.comment : "";
	const post = run.posts.find((p) => p.noteId === noteId);
	if (!post) return { status: 400, body: { error: "unknown noteId" } };
	if (!ACTION_KINDS.includes(action)) {
		return { status: 400, body: { error: "invalid action" } };
	}
	if (comment.length > MAX_COMMENT_LEN) {
		return { status: 400, body: { error: "comment too long" } };
	}

	const at = deps.now();
	const newAction: XiaohongshuReviewAction = {
		noteId,
		action,
		// close_created targets the auto-created issue's op id; promote references
		// the per-note candidate (one candidate per note in v1).
		...(action === "close_created" && post.createdIssue
			? { targetOpId: post.createdIssue.opId }
			: {}),
		...(action === "promote_candidate" ? { candidateId: noteId } : {}),
		at,
	};

	await deps.runExclusive(loc.project, loc.collectionId, () => {
		const existing =
			deps.feedback.readFeedback(loc.project, loc.collectionId, loc.runToken) ??
			({
				schemaVersion: FEEDBACK_SCHEMA_VERSION,
				runToken: loc.runToken,
				comments: [],
				actions: [],
				consumedActions: [],
			} satisfies XiaohongshuFeedbackFile);
		// ACTIONS: replace-by-noteId → ONE current structured decision per note, so
		// a duplicate POST is idempotent and a changed decision supersedes (codex
		// design R2#1). COMMENTS: append-with-dedup by (noteId,text) → founder
		// clarifications accumulate as a learning/escalation signal (codex code
		// R1#4) while an exact retry never spams a duplicate. Op-id dedup for the
		// external close/create happens later at the consume stage.
		const commentExists = existing.comments.some(
			(c) => c.noteId === noteId && c.text === comment,
		);
		const merged: XiaohongshuFeedbackFile = {
			...existing,
			actions: [
				...existing.actions.filter((a) => a.noteId !== noteId),
				newAction,
			],
			comments:
				comment && !commentExists
					? [...existing.comments, { noteId, text: comment, at }]
					: existing.comments,
		};
		deps.feedback.writeFeedback(loc.project, loc.collectionId, merged);
	});

	return { status: 200, body: { ok: true, noteId, action } };
}
