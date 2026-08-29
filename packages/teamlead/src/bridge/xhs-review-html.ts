/**
 * FLY-286 PR-2: pure HTML builder for the founder's local review page.
 *
 * Pure (run + nonce → HTML string), so it is unit-testable without Express.
 * Security (codex design review R1#6 / R2#6): EVERY note/founder-derived string
 * is HTML-escaped; the note URL becomes an <a href> ONLY after parse + scheme
 * allowlist (https:) + host allowlist; a javascript:/foreign-host URL renders as
 * inert escaped text. Plain <form> POSTs (no fetch) so `form-action 'self'`
 * suffices — no `connect-src` / inline script needed (R2#3).
 *
 * The page has NO images (the merged analysis schema carries no thumbnail field
 * — R2#7); CSP `img-src 'none'`.
 */

import type {
	XiaohongshuAnalysisRun,
	XiaohongshuAnalyzedPost,
} from "flywheel-comm/xiaohongshu-analysis-store";

/** Original-note host allowlist (exact host OR a subdomain of these). */
const ALLOWED_NOTE_HOSTS = ["xiaohongshu.com", "xhslink.com", "rednote.com"];

/** Escape the 5 dangerous HTML chars for text + double-quoted attribute context. */
export function escapeHtml(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Is `host` exactly an allowed domain or a subdomain of one? */
function hostAllowed(host: string): boolean {
	const h = host.toLowerCase();
	return ALLOWED_NOTE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Return a SAFE https note URL (allowlisted host) or null. A javascript:,
 * non-https, malformed, or foreign-host URL → null (caller renders inert text).
 */
export function safeNoteUrl(url: string): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.protocol !== "https:") return null;
	if (!hostAllowed(u.hostname)) return null;
	return u.href;
}

/** Per-post structured controls by what action the Runner took. */
function controlsFor(post: XiaohongshuAnalyzedPost): string[] {
	switch (post.status) {
		case "created":
			return ["keep", "close_created", "edit"];
		case "candidate":
			return ["promote_candidate", "skip", "edit"];
		default: // analyzed / no_action
			return ["promote_candidate", "skip"];
	}
}

const ACTION_LABELS: Record<string, string> = {
	keep: "Keep",
	close_created: "Close (not useful)",
	promote_candidate: "Create issue",
	skip: "Skip",
	edit: "Needs edit",
};

function renderPost(
	post: XiaohongshuAnalyzedPost,
	sessionToken: string,
	actionPath: string,
): string {
	const noteId = escapeHtml(post.noteId);
	const title = escapeHtml(post.title || "(untitled)");
	const summary = escapeHtml(post.summary || "");
	const safeUrl = safeNoteUrl(post.url);
	const titleHtml = safeUrl
		? `<a href="${escapeHtml(safeUrl)}" rel="noopener noreferrer">${title}</a>`
		: `${title} <span class="inert">${escapeHtml(post.url)}</span>`;
	const action = post.createdIssue
		? `auto-created issue <code>${escapeHtml(post.createdIssue.issueId)}</code> (${escapeHtml(post.createdIssue.state)})`
		: post.status === "candidate"
			? "candidate (not created)"
			: "no action";
	const buttons = controlsFor(post)
		.map(
			(a) =>
				`<button type="submit" name="action" value="${escapeHtml(a)}">${escapeHtml(ACTION_LABELS[a] ?? a)}</button>`,
		)
		.join(" ");
	// One plain <form> per post; the clicked button supplies `action`. The form
	// posts to an ABSOLUTE path (codex code R1#1) — a relative "action" would
	// resolve to /xhs-review/action (sibling of /xhs-review/:reportToken), missing
	// the mounted POST /xhs-review/:reportToken/action route.
	return `<section class="post">
  <h3>${titleHtml}</h3>
  <p class="summary">${summary}</p>
  <p class="action"><strong>Runner action:</strong> ${action}</p>
  <form method="POST" action="${escapeHtml(actionPath)}">
    <input type="hidden" name="noteId" value="${noteId}">
    <input type="hidden" name="sessionToken" value="${escapeHtml(sessionToken)}">
    <label>Comment (optional): <textarea name="comment" rows="2" maxlength="4000"></textarea></label>
    <div class="controls">${buttons}</div>
  </form>
</section>`;
}

/**
 * Build the full review page. `nonce` is the CSP nonce (style); `sessionToken`
 * is the run-scoped POST token embedded in each form (NOT an apiToken).
 */
export function buildReviewHtml(args: {
	run: XiaohongshuAnalysisRun;
	nonce: string;
	sessionToken: string;
	/** Opaque report token — used to build the absolute POST action path. */
	reportToken: string;
}): string {
	const { run, nonce, sessionToken, reportToken } = args;
	const actionPath = `/xhs-review/${encodeURIComponent(reportToken)}/action`;
	const posts = run.posts
		.map((p) => renderPost(p, sessionToken, actionPath))
		.join("\n");
	const heading = escapeHtml(
		`${run.collectionLabel} — ${run.summary.analyzed} analyzed, ${run.summary.created} created, ${run.summary.candidates} candidates`,
	);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Xiaohongshu learning review</title>
<style nonce="${escapeHtml(nonce)}">
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 860px; margin: 2rem auto; color: #1d1d1f; }
  .post { border: 1px solid #d2d2d7; border-radius: 12px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .summary { color: #333; }
  .action { color: #555; font-size: .9rem; }
  .inert { color: #999; }
  textarea { width: 100%; }
  .controls { margin-top: .5rem; }
  button { margin-right: .5rem; }
</style>
</head>
<body>
<h1>Xiaohongshu learning review</h1>
<p>${heading}</p>
${posts}
</body>
</html>`;
}
