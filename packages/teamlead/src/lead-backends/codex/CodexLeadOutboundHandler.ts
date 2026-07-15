/**
 * FLY-224 Phase 2b — CodexLeadOutboundHandler: the Bridge-side `/api/lead-outbound/
 * send` handler (plan §6.4, Phase 0A §4). This is the server piece paired with
 * CodexOutboundSender — and the EXACTLY-ONCE AUTHORITY the sender's docstring
 * defers to.
 *
 * The sender is at-least-once (durable outbox, free to re-POST). This handler makes
 * delivery exactly-once via a DURABLE idempotencyKey dedup (NOT a time window) plus
 * an explicit ambiguous state for the irreducible crash gap:
 *
 *   record(idempotencyKey):
 *     - SENT      → return the prior messageId, DO NOT re-send (exactly-once).
 *     - IN_FLIGHT → a prior attempt may have posted but we crashed/errored before
 *                   recording the result → AMBIGUOUS. DO NOT blind re-send; surface
 *                   for reconciliation (the Discord nonce still dedups a fast retry).
 *     - absent    → ATOMICALLY claim IN_FLIGHT (setInFlight returns whether THIS call
 *                   won — closes the get→set TOCTOU; a concurrent racer that lost the
 *                   claim is treated as IN_FLIGHT → ambiguous), send, then mark SENT.
 *                   A thrown send is AMBIGUOUS (it may have reached Discord — the
 *                   response could be lost AFTER the post), so the marker is KEPT, not
 *                   deleted: a retry is ambiguous, never a blind double-post (HIGH-3).
 *
 * Security: it is a reserved endpoint — the apiToken is verified here (fail-closed),
 * the per-Lead Discord token is resolved server-side by the injected `send` (never in
 * the request), and an optional `authorizeLeadChannel` rejects a request whose
 * (leadId, channelId) the caller does not own (defense-in-depth vs cross-Lead/channel
 * impersonation — the full fix is per-Lead auth, FLY-246). Body validated at the boundary.
 *
 * Store + Discord send are injected → UNIT-TESTED ONLY (no real Bridge/Discord).
 * The SQLite dedup store + the plugin.ts mount are the following 2b sub-steps.
 */

export interface OutboundSendBody {
	projectName?: unknown;
	leadId?: unknown;
	channelId?: unknown;
	text?: unknown;
	idempotencyKey?: unknown;
	nonce?: unknown;
}

export type OutboundSendStatus = "sent" | "deduped" | "ambiguous" | "rejected";

export interface OutboundSendOutcome {
	httpStatus: number;
	status: OutboundSendStatus;
	messageId?: string;
	reason?: string;
}

export interface DedupRecord {
	idempotencyKey: string;
	status: "in_flight" | "sent";
	messageId?: string;
}

export interface OutboundDedupStore {
	get(key: string): DedupRecord | undefined;
	/** ATOMICALLY claim the key as in_flight. Returns `true` iff THIS call created the
	 * marker (won the race); `false` if a record already existed (sent or in_flight).
	 * This atomic claim — not the preceding get() — is the exactly-once authority that
	 * closes the get→set TOCTOU (two concurrent racers cannot both win). */
	setInFlight(key: string): boolean;
	markSent(key: string, messageId: string): void;
	delete(key: string): void;
}

/** Resolves the per-Lead Discord token server-side + posts; returns messageId. The
 * token is resolved by (projectName, leadId) so a reused agentId can't cross over. */
export type DiscordSendFn = (args: {
	projectName: string;
	leadId: string;
	channelId: string;
	text: string;
	nonce: string;
}) => Promise<string>;

export interface CodexLeadOutboundHandlerOptions {
	store: OutboundDedupStore;
	send: DiscordSendFn;
	/** The Bridge apiToken; the request must present it (fail-closed). */
	expectedApiToken: string;
	/** Optional anti-impersonation guard: returns whether the Lead `leadId` IN PROJECT
	 * `projectName` is allowed to post to `channelId` (its configured chat/core
	 * channels). Keyed by (projectName, leadId) because agentId is NOT globally unique —
	 * a reused agentId in another project must not inherit this project's channels.
	 * Rejected → 403. Omitted → no extra channel check (back-compat). */
	authorizeLeadChannel?: (
		projectName: string,
		leadId: string,
		channelId: string,
	) => boolean;
	logger?: { warn: (m: string, c?: unknown) => void };
}

export class CodexLeadOutboundHandler {
	private readonly store: OutboundDedupStore;
	private readonly send: DiscordSendFn;
	private readonly expectedApiToken: string;
	private readonly authorizeLeadChannel?: (
		projectName: string,
		leadId: string,
		channelId: string,
	) => boolean;
	private readonly logger: { warn: (m: string, c?: unknown) => void };

	constructor(opts: CodexLeadOutboundHandlerOptions) {
		if (!opts.expectedApiToken) {
			throw new Error(
				"CodexLeadOutboundHandler: expectedApiToken required (reserved endpoint)",
			);
		}
		this.store = opts.store;
		this.send = opts.send;
		this.expectedApiToken = opts.expectedApiToken;
		this.authorizeLeadChannel = opts.authorizeLeadChannel;
		this.logger = opts.logger ?? { warn: () => {} };
	}

	async handle(req: {
		body: OutboundSendBody;
		providedToken: string | undefined;
	}): Promise<OutboundSendOutcome> {
		// 1. Auth — reserved endpoint, fail-closed.
		if (
			!req.providedToken ||
			!tokensEqual(req.providedToken, this.expectedApiToken)
		) {
			return { httpStatus: 401, status: "rejected", reason: "unauthorized" };
		}

		// 2. Validate the body at the boundary.
		const v = validateBody(req.body);
		if (!v.ok) {
			return { httpStatus: 400, status: "rejected", reason: v.reason };
		}
		const { projectName, leadId, channelId, text, idempotencyKey, nonce } =
			v.value;

		// 3. Anti-impersonation (defense-in-depth): the caller may only post as a
		// (projectName, leadId, channelId) it actually owns — keyed by project because
		// agentId isn't globally unique. Full fix = per-Lead auth (FLY-246).
		if (
			this.authorizeLeadChannel &&
			!this.authorizeLeadChannel(projectName, leadId, channelId)
		) {
			this.logger.warn("lead-outbound rejected: lead/channel not authorized", {
				leadId,
				channelId,
			});
			return {
				httpStatus: 403,
				status: "rejected",
				reason: "lead_channel_unauthorized",
			};
		}

		// 4. Durable dedup — fast path on an existing record.
		const existing = this.store.get(idempotencyKey);
		if (existing?.status === "sent") {
			return {
				httpStatus: 200,
				status: "deduped",
				messageId: existing.messageId,
			};
		}
		if (existing?.status === "in_flight") {
			// A prior attempt may have posted; we can't prove it → ambiguous.
			return {
				httpStatus: 409,
				status: "ambiguous",
				reason: "prior_attempt_unproven",
			};
		}

		// 5. ATOMIC CLAIM (HIGH-2: closes the get→set TOCTOU). Only the racer that
		// CREATES the in_flight marker sends; a concurrent racer that loses the claim
		// re-reads and is deduped/ambiguous — never a second send.
		if (!this.store.setInFlight(idempotencyKey)) {
			const now = this.store.get(idempotencyKey);
			if (now?.status === "sent") {
				return { httpStatus: 200, status: "deduped", messageId: now.messageId };
			}
			return {
				httpStatus: 409,
				status: "ambiguous",
				reason: "concurrent_attempt_unproven",
			};
		}

		// 6. We won the claim → send exactly once.
		let messageId: string;
		try {
			messageId = await this.send({
				projectName,
				leadId,
				channelId,
				text,
				nonce,
			});
		} catch (err) {
			// HIGH-3: a thrown send is AMBIGUOUS — the message may have reached Discord
			// (the response can be lost AFTER it posted). Do NOT delete the marker (that
			// would let a retry BLIND-RESEND → double post). Keep it in_flight → this and
			// any retry are ambiguous; the Discord nonce is the secondary in-window guard.
			// (A typed "definitely-not-posted" send error to enable a safe auto-retry is
			// a refinement — FLY-246.)
			this.logger.warn(
				"lead-outbound send threw → ambiguous (marker kept; no blind-resend)",
				{ idempotencyKey, err: (err as Error).message },
			);
			return {
				httpStatus: 409,
				status: "ambiguous",
				reason: "send_threw_unproven",
			};
		}
		this.store.markSent(idempotencyKey, messageId);
		return { httpStatus: 200, status: "sent", messageId };
	}
}

function validateBody(body: OutboundSendBody):
	| {
			ok: true;
			value: {
				projectName: string;
				leadId: string;
				channelId: string;
				text: string;
				idempotencyKey: string;
				nonce: string;
			};
	  }
	| { ok: false; reason: string } {
	const projectName = body.projectName;
	const leadId = body.leadId;
	const channelId = body.channelId;
	const text = body.text;
	const idempotencyKey = body.idempotencyKey;
	const nonce = body.nonce;
	if (typeof projectName !== "string" || projectName === "")
		return { ok: false, reason: "projectName_required" };
	if (typeof leadId !== "string" || leadId === "")
		return { ok: false, reason: "leadId_required" };
	if (typeof channelId !== "string" || channelId === "")
		return { ok: false, reason: "channelId_required" };
	if (typeof text !== "string" || text === "")
		return { ok: false, reason: "text_required" };
	if (typeof idempotencyKey !== "string" || idempotencyKey === "")
		return { ok: false, reason: "idempotencyKey_required" };
	if (typeof nonce !== "string" || nonce === "")
		return { ok: false, reason: "nonce_required" };
	return {
		ok: true,
		value: { projectName, leadId, channelId, text, idempotencyKey, nonce },
	};
}

/** Length-aware constant-time-ish token compare (avoid trivial early-exit leak). */
function tokensEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** In-memory dedup store (tests + reference). Prod uses a SQLite-backed store. */
export class InMemoryOutboundDedupStore implements OutboundDedupStore {
	private readonly m = new Map<string, DedupRecord>();
	get(key: string): DedupRecord | undefined {
		const r = this.m.get(key);
		return r ? { ...r } : undefined;
	}
	setInFlight(key: string): boolean {
		// Atomic claim: only create the marker if absent — return whether we won.
		if (this.m.has(key)) return false;
		this.m.set(key, { idempotencyKey: key, status: "in_flight" });
		return true;
	}
	markSent(key: string, messageId: string): void {
		this.m.set(key, { idempotencyKey: key, status: "sent", messageId });
	}
	delete(key: string): void {
		this.m.delete(key);
	}
}
