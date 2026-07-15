/**
 * FLY-162 Layer 2 — Bridge-side reply guard (preventive routing enforcement).
 *
 * The forked Discord plugin's `reply` / `edit_message` handlers call
 * `POST /api/discord/reply-guard` before sending. This module holds the pure,
 * side-effect-free decision logic so it can be unit-tested without Express or
 * StateStore.
 *
 * Hard rule (v1): a post to a Lead's chatChannel TOP LEVEL that contains >= 1
 * configured-prefix issue token is denied. Issue-bound content must go to the
 * issue's thread via `POST /api/chat-threads/send` (Layer 1). Top-level replies
 * are reserved for issue-free free-form messages. This boundary closes the
 * "split a cross-issue answer into two single-issue top-level replies" evasion
 * and matches the Layer 1 rule that issue content lives in issue threads.
 *
 * `wrong_thread` (issue-Y content posted into issue-X's thread) is NOT
 * hard-denied in v1 — a passing mention ("similar to FLY-100") is legitimate
 * and distinguishing it from cross-talk needs semantic judgement. We emit it as
 * allow=true soft telemetry instead.
 *
 * See plan §12 (doc/engineer/plan/inprogress/v1.28.0-FLY-162-lead-thread-routing.md).
 */

export type ChatClassification =
	| "channel-top-level"
	| "issue-thread"
	| "other"
	// FLY-173: the project core channel (ProjectEntry.generalChannel). Coordination
	// / triage-overview / cross-issue messages legitimately reference issue tokens
	// here, so it is ALWAYS allowed — even when the core channel coincides with a
	// Lead's chatChannel (the cos-lead / Simba case, where the two IDs are equal).
	// The route classifies core BEFORE channel-top-level so this exemption wins.
	| "core-channel";

export interface ReplyGuardDecision {
	allow: boolean;
	/** Machine-readable reason: "issue_at_top_level" | "guard_bypass" | undefined */
	reason?: string;
	/** Issue identifiers involved (denied tokens, or foreign tokens for telemetry). */
	issues?: string[];
	/** Human/LLM-readable guidance returned on deny. */
	guidance?: string;
	/** Soft-telemetry tag (allow=true). e.g. "potential_wrong_thread". */
	telemetry?: string;
}

/**
 * Issue token pattern. Case-insensitive on the prefix so we catch `fly-159`,
 * `FLY-159`, and mixed case. `\b` boundaries handle `FLY-159/FLY-161`,
 * `[FLY-159](url)` markdown links, and CJK-adjacent text (CJK chars are not
 * ASCII word chars, so a boundary exists). Prefix is then filtered against the
 * configured allow-list to drop false positives like `HTTP-2` / `GPT-4`.
 */
const ISSUE_TOKEN_RE = /\b([A-Za-z]{2,})-(\d+)\b/g;

const TOP_LEVEL_DENY_GUIDANCE =
	"This reply references issue(s) at the chat-channel top level. " +
	"Issue-bound content must go to each issue's thread via " +
	"POST /api/chat-threads/send (one call per issueIdentifier). " +
	"Top-level replies are only for issue-free free-form messages.";

/**
 * Extract the set of distinct, normalized issue identifiers from `text` that
 * match one of the configured team prefixes. Returns uppercase identifiers in
 * first-seen order, deduplicated.
 */
export function scanIssueTokens(text: string, prefixes: string[]): string[] {
	if (!text) return [];
	const allowed = new Set(prefixes.map((p) => p.trim().toUpperCase()));
	const found = new Set<string>();
	for (const match of text.matchAll(ISSUE_TOKEN_RE)) {
		const rawPrefix = match[1];
		const number = match[2];
		if (!rawPrefix || !number) continue;
		const prefix = rawPrefix.toUpperCase();
		if (allowed.has(prefix)) {
			found.add(`${prefix}-${number}`);
		}
	}
	return [...found];
}

/**
 * Pure decision: given the chat classification, the bound issue (for threads),
 * and the issue tokens found in the text, decide allow/deny.
 */
export function evaluateReplyGuard(params: {
	classification: ChatClassification;
	boundIssueIdentifier?: string | null;
	issueTokens: string[];
}): ReplyGuardDecision {
	const { classification, boundIssueIdentifier, issueTokens } = params;

	// FLY-173: the project core channel is exempt — coordination / triage-overview
	// / cross-issue messages here legitimately list issue numbers. Always allow,
	// regardless of issue tokens. (Classified by the route via generalChannel,
	// ahead of channel-top-level, so the cos-lead/core overlap resolves here.)
	if (classification === "core-channel") {
		return { allow: true };
	}

	// Hard rule: issue token(s) at the Lead's chatChannel top level -> deny.
	if (classification === "channel-top-level" && issueTokens.length >= 1) {
		return {
			allow: false,
			reason: "issue_at_top_level",
			issues: issueTokens,
			guidance: TOP_LEVEL_DENY_GUIDANCE,
		};
	}

	// Soft telemetry: foreign issue tokens inside an issue-bound thread.
	if (classification === "issue-thread") {
		const bound = boundIssueIdentifier?.toUpperCase() ?? null;
		const foreign = issueTokens.filter((t) => t.toUpperCase() !== bound);
		if (foreign.length > 0) {
			return {
				allow: true,
				telemetry: "potential_wrong_thread",
				issues: foreign,
			};
		}
	}

	return { allow: true };
}
