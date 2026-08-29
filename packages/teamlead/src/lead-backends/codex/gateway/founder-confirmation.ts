/**
 * FLY-245 Phase D-e — founder confirmation observer (plan §5.6, Codex R1#11).
 *
 * A runner-lifecycle action is authorized by a FOUNDER STRUCTURED ACTION, not by
 * the model's free-text. Two observation paths, both checking the founder's exact
 * Discord id (never a name/semantic match):
 *   - REACTION (preferred, L1): the gateway polls its own confirmation message's
 *     reactions for the configured emoji and looks for the founder's reactor id.
 *   - TOKEN (fallback): the founder replies `confirm <nonce>` bound to the
 *     confirmation channel + that exact request.
 *
 * Discipline (R1#11): 403 / 404 / malformed / rate-limit-exhaustion are treated as
 * NON-approval (fail-closed). The FIRST durable trusted observation is the
 * IRREVERSIBLE authorization edge — once observed, a later un-react is NOT a
 * revocation (the state machine, D-f, latches it and stops polling).
 *
 * Pure detection + a thin injected-HTTP poller → exhaustively unit-tested. The
 * real bot-token / channel wiring is Phase F.
 */

/** The emoji a founder reacts with to confirm (configurable; default ✅). */
export const FOUNDER_CONFIRM_EMOJI = "✅";

/** URL-encode an emoji for the Discord reactions endpoint path segment. */
export function encodeReactionEmoji(emoji: string): string {
	return encodeURIComponent(emoji);
}

/** Extract reactor user ids from a Discord `GET reactions/{emoji}` response
 * (an array of user objects). Defensive: a non-array / malformed shape yields
 * an empty list (→ non-approval). */
export function extractReactorIds(apiResponse: unknown): string[] {
	if (!Array.isArray(apiResponse)) return [];
	const ids: string[] = [];
	for (const u of apiResponse) {
		if (
			u &&
			typeof u === "object" &&
			typeof (u as { id?: unknown }).id === "string"
		) {
			ids.push((u as { id: string }).id);
		}
	}
	return ids;
}

/** True iff the founder's exact id is among the reactors. */
export function founderReacted(
	reactorIds: readonly string[],
	founderId: string,
): boolean {
	return !!founderId && reactorIds.includes(founderId);
}

/** Parse a `confirm <nonce>` reply; returns the nonce or null. Exact, anchored —
 * no fuzzy/semantic interpretation. */
export function parseConfirmToken(text: string): { nonce: string } | null {
	const m = /^\s*confirm\s+(\S+)\s*$/i.exec(text ?? "");
	return m?.[1] ? { nonce: m[1] } : null;
}

export interface TokenConfirmationMessage {
	text: string;
	authorId: string;
	channelId: string;
}

export interface TokenConfirmationExpectation {
	nonce: string;
	channelId: string;
	founderId: string;
}

/** True iff a message is a valid founder token confirmation: authored by the
 * founder, in the expected channel, carrying the exact request nonce. */
export function isFounderTokenConfirmation(
	msg: TokenConfirmationMessage,
	exp: TokenConfirmationExpectation,
): boolean {
	if (msg.authorId !== exp.founderId) return false;
	if (msg.channelId !== exp.channelId) return false;
	const parsed = parseConfirmToken(msg.text);
	return parsed !== null && parsed.nonce === exp.nonce;
}

export interface ReactionFetchResult {
	/** HTTP status (200 = ok; 403/404/429/5xx → non-approval). */
	status: number;
	/** Parsed JSON body (the reactors array) when status is 200. */
	body?: unknown;
}

/** Fetch one page of reactors for the confirmation message's emoji (injected;
 * real impl is a Discord REST GET with the Lead bot token, Phase F). The `after`
 * cursor (a reactor id) drives pagination (R1 LOW-10). */
export type ReactionFetcher = (args: {
	channelId: string;
	messageId: string;
	emoji: string;
	after?: string;
}) => Promise<ReactionFetchResult>;

export interface ReactionConfirmationCheck {
	confirmed: boolean;
	reason: "confirmed" | "not_yet" | "http_error" | "rate_limited" | "malformed";
}

/** Discord's reactions endpoint max page size, and a bounded page cap so a
 * confirmation message with a flood of reactors can't loop unbounded (R1
 * LOW-10). 100 × 20 = 20k reactors covered; beyond that → non-approval, the next
 * observe pass retries. */
const REACTION_PAGE_SIZE = 100;
const MAX_REACTION_PAGES = 20;

/**
 * Check the founder-reaction confirmation for one confirmation message,
 * PAGINATING through reactors (R1 LOW-10: >100 reactors must not hide the
 * founder behind page 1). Any HTTP non-200 (403/404/5xx), a 429 rate-limit, or a
 * malformed body on ANY page is NON-approval (fail-closed) — never an error that
 * could be mistaken for a yes. Stops early the moment the founder is found.
 */
export async function checkReactionConfirmation(
	fetcher: ReactionFetcher,
	args: {
		channelId: string;
		messageId: string;
		founderId: string;
		emoji?: string;
	},
): Promise<ReactionConfirmationCheck> {
	const emoji = args.emoji ?? FOUNDER_CONFIRM_EMOJI;
	let after: string | undefined;
	for (let page = 0; page < MAX_REACTION_PAGES; page++) {
		let res: ReactionFetchResult;
		try {
			res = await fetcher({
				channelId: args.channelId,
				messageId: args.messageId,
				emoji,
				after,
			});
		} catch {
			return { confirmed: false, reason: "http_error" };
		}
		if (res.status === 429) return { confirmed: false, reason: "rate_limited" };
		if (res.status !== 200) return { confirmed: false, reason: "http_error" };
		if (!Array.isArray(res.body)) {
			return { confirmed: false, reason: "malformed" };
		}
		const reactors = extractReactorIds(res.body);
		if (founderReacted(reactors, args.founderId)) {
			return { confirmed: true, reason: "confirmed" };
		}
		// A short page (or empty) is the last one — no more reactors to scan.
		if (reactors.length < REACTION_PAGE_SIZE) {
			return { confirmed: false, reason: "not_yet" };
		}
		after = reactors[reactors.length - 1];
	}
	// Page cap reached without finding the founder — non-approval (retry later).
	return { confirmed: false, reason: "not_yet" };
}
