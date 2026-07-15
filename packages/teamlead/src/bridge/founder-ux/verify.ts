/**
 * FLY-598: founder-facing UX gate — the crown jewel: server-side verification
 * that Annie HERSELF approved (Codex R1-#4 / R2-#1).
 *
 * The Lead only INTERPRETS Annie's natural-language "可以/好/OK" and cites its
 * Discord message id. The Bridge does the authority work: it SERVER-FETCHES that
 * exact message from the issue's registered Discord thread and verifies
 *   (1) the message id exists IN that thread (thread binding),
 *   (2) authorId === founderUserId (it is genuinely Annie — not a Lead forgery),
 *   (3) it is within the freshness window,
 * and ONLY then writes the StateStore sign-off (bound to uxHash). The
 * CLI-supplied quote is NEVER trusted; the stored excerpt is the fetched content.
 *
 * deps are injected so this is unit-testable with a fake fetch + thread resolver.
 */

import type { StateStore } from "../../StateStore.js";
import {
	DiscordFetcher,
	type FetchImpl,
} from "../founder-consent/discord-fetch.js";
import { writeSignoff } from "./signoff.js";

/** Per-session Discord coordinates needed to fetch + verify the founder message. */
export interface ResolvedUxThread {
	threadId: string;
	botToken: string;
}

export interface FounderUxVerifyDeps {
	store: StateStore;
	/** Resolve the issue's Discord thread + bot token for a run (null if none). */
	resolveThread: (executionId: string) => ResolvedUxThread | null;
	/** Founder's Discord user id (FLYWHEEL_FOUNDER_USER_ID). Empty → fail-closed. */
	founderUserId: string;
	fetchImpl?: FetchImpl;
	now?: () => number;
	/** Freshness window — the cited approval must be at most this old. Default 48h. */
	windowMs?: number;
	/** How many recent thread messages to scan for the cited id. Default 100. */
	maxMsgs?: number;
	/** Optional audit sink; returns an audit id stored on the sign-off. */
	audit?: (row: {
		executionId: string;
		uxHash: string;
		annieMsgId: string;
		decision: "allow" | "deny";
		reason: string;
	}) => string | undefined;
}

export type VerifyResult =
	| { ok: true; auditId?: string }
	| { ok: false; status: number; reason: string };

const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEFAULT_MAX_MSGS = 100;
const EXCERPT_MAX = 240;

export async function verifyAndRecordFounderUxSignoff(
	deps: FounderUxVerifyDeps,
	input: { executionId: string; uxHash: string; annieMsgId: string },
): Promise<VerifyResult> {
	const audit = (decision: "allow" | "deny", reason: string) =>
		deps.audit?.({ ...input, decision, reason });

	if (!input.uxHash || !input.annieMsgId) {
		const reason = "uxHash and annieMsgId are required";
		audit("deny", reason);
		return { ok: false, status: 400, reason };
	}

	// Fail-closed: cannot verify "is it Annie" without a configured founder id.
	if (!deps.founderUserId) {
		const reason =
			"founder identity not configured (FLYWHEEL_FOUNDER_USER_ID) — cannot verify";
		audit("deny", reason);
		return { ok: false, status: 503, reason };
	}

	const thread = deps.resolveThread(input.executionId);
	if (!thread || !thread.threadId) {
		const reason = "no Discord thread registered for this run";
		audit("deny", reason);
		return { ok: false, status: 422, reason };
	}
	if (!thread.botToken) {
		const reason = "no Discord bot token to read the issue thread";
		audit("deny", reason);
		return { ok: false, status: 503, reason };
	}

	let messages: Awaited<ReturnType<DiscordFetcher["fetchThreadMessages"]>>;
	try {
		const fetcher = new DiscordFetcher(thread.botToken, deps.fetchImpl);
		messages = await fetcher.fetchThreadMessages(
			thread.threadId,
			deps.maxMsgs ?? DEFAULT_MAX_MSGS,
		);
	} catch (err) {
		const reason = `could not fetch the issue thread: ${err instanceof Error ? err.message : String(err)}`;
		audit("deny", reason);
		return { ok: false, status: 502, reason };
	}

	// (1) thread binding: the cited message must be IN this issue's thread.
	const msg = messages.find((m) => m.id === input.annieMsgId);
	if (!msg) {
		const reason =
			"cited approval message id is not in this issue's Discord thread";
		audit("deny", reason);
		return { ok: false, status: 422, reason };
	}

	// (2) founder identity: it must be authored by Annie herself (anti-forgery).
	if (msg.authorId !== deps.founderUserId) {
		const reason =
			"cited approval message was not authored by the founder (authorId mismatch)";
		audit("deny", reason);
		return { ok: false, status: 403, reason };
	}

	// (3) freshness: the approval must be recent.
	const now = deps.now ? deps.now() : Date.now();
	const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
	const msgTime = Date.parse(msg.ts);
	if (!Number.isFinite(msgTime) || now - msgTime > windowMs) {
		const reason = "cited approval message is outside the freshness window";
		audit("deny", reason);
		return { ok: false, status: 422, reason };
	}

	const auditId = audit(
		"allow",
		"founder-authored approval verified in-thread",
	);
	writeSignoff(deps.store, input.executionId, {
		uxHash: input.uxHash,
		annieMsgId: input.annieMsgId,
		fetchedExcerpt: msg.content.slice(0, EXCERPT_MAX),
		ts: new Date(now).toISOString(),
		auditId,
	});
	return { ok: true, auditId };
}
