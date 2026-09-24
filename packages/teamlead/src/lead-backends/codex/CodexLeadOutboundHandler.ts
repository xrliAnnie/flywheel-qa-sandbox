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

import { createHash } from "node:crypto";
import type { ChatThreadWriteGuard } from "../../bridge/chat-thread-write-guard.js";

export interface OutboundSendBody {
	projectName?: unknown;
	leadId?: unknown;
	channelId?: unknown;
	probe?: unknown;
	roundtableEngage?: unknown;
	text?: unknown;
	idempotencyKey?: unknown;
	nonce?: unknown;
	replyTo?: unknown;
	deliveryContext?: unknown;
}

export type OutboundSendStatus =
	| "pending"
	| "authorized"
	| "sent"
	| "deduped"
	| "ambiguous"
	| "rejected";

export interface OutboundSendOutcome {
	httpStatus: number;
	sendStatus?: "sent";
	engagement?: "pending" | "ready";
	threadId?: string;
	status: OutboundSendStatus;
	messageId?: string;
	reason?: string;
}

export interface OutboundEngagementBinding {
	projectName: string;
	leadId: string;
	parentChannelId: string;
	payloadHash: string;
}

export function engagementBindingKey(
	binding?: OutboundEngagementBinding,
): string | null {
	return binding
		? JSON.stringify([
				binding.projectName,
				binding.leadId,
				binding.parentChannelId,
				binding.payloadHash,
			])
		: null;
}

export interface DedupRecord {
	idempotencyKey: string;
	status: "in_flight" | "sent";
	messageId?: string;
	binding?: OutboundEngagementBinding;
	engagement?: "pending" | "ready";
}

export interface OutboundDedupStore {
	get(key: string): DedupRecord | undefined;
	/** ATOMICALLY claim the key as in_flight. Returns `true` iff THIS call created the
	 * marker (won the race); `false` if a record already existed (sent or in_flight).
	 * This atomic claim — not the preceding get() — is the exactly-once authority that
	 * closes the get→set TOCTOU (two concurrent racers cannot both win). */
	setInFlight(key: string, binding?: OutboundEngagementBinding): boolean;
	markEngagementReady(
		key: string,
		binding: OutboundEngagementBinding,
		messageId: string,
	): void;
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
	replyTo?: string;
	guard?: ChatThreadWriteGuard;
}) => Promise<string>;

export type PrepareProactiveEngagement = (identity: {
	projectName: string;
	leadId: string;
	channelId: string;
}) => Promise<
	(receipt: {
		eventId: string;
		messageId: string;
		payloadHash: string;
	}) => Promise<"pending" | "ready">
>;
export interface CodexLeadOutboundHandlerOptions {
	prepareProactiveEngagement?: PrepareProactiveEngagement;
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
	) => boolean | "unavailable" | Promise<boolean | "unavailable">;
	produceVoiceLeadResult?: (input: {
		projectName: string;
		sourceLeadId: string;
		sourceDeliveryId: string;
		operationId: string;
		text: string;
	}) => unknown | Promise<unknown>;
	logger?: { warn: (m: string, c?: unknown) => void };
}

export class CodexLeadOutboundHandler {
	private readonly store: OutboundDedupStore;
	private readonly prepareProactiveEngagement?: PrepareProactiveEngagement;
	private readonly send: DiscordSendFn;
	private readonly expectedApiToken: string;
	private readonly authorizeLeadChannel?: (
		projectName: string,
		leadId: string,
		channelId: string,
	) => boolean | "unavailable" | Promise<boolean | "unavailable">;
	private readonly produceVoiceLeadResult?: CodexLeadOutboundHandlerOptions["produceVoiceLeadResult"];
	private readonly logger: { warn: (m: string, c?: unknown) => void };

	constructor(opts: CodexLeadOutboundHandlerOptions) {
		if (!opts.expectedApiToken) {
			throw new Error(
				"CodexLeadOutboundHandler: expectedApiToken required (reserved endpoint)",
			);
		}
		this.store = opts.store;
		this.prepareProactiveEngagement = opts.prepareProactiveEngagement;
		this.send = opts.send;
		this.expectedApiToken = opts.expectedApiToken;
		this.authorizeLeadChannel = opts.authorizeLeadChannel;
		this.produceVoiceLeadResult = opts.produceVoiceLeadResult;
		this.logger = opts.logger ?? { warn: () => {} };
	}

	async handle(req: {
		body: OutboundSendBody;
		providedToken: string | undefined;
		/** Supplied only by trusted in-process adapter; HTTP handlers do not read it from body. */
		guard?: ChatThreadWriteGuard;
		/** Trusted parent journal entry only. Never read from model input or the HTTP body. */
		deliveryContext?: string;
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
		const { projectName, leadId, channelId } = v.value;

		// 3. Anti-impersonation (defense-in-depth): the caller may only post as a
		// (projectName, leadId, channelId) it actually owns — keyed by project because
		// agentId isn't globally unique. Full fix = per-Lead auth (FLY-246).
		const channelAuthorization = await this.authorizeLeadChannel?.(
			projectName,
			leadId,
			channelId,
		);
		if (channelAuthorization === "unavailable") {
			return {
				httpStatus: 503,
				status: "rejected",
				reason: "channel_parent_lookup_unavailable",
			};
		}
		if (channelAuthorization === false) {
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
		if (req.body.roundtableEngage === true) return this.handleProactive(v);
		if (v.probe) return { httpStatus: 200, status: "authorized" };
		const { text, nonce, replyTo } = v.value;
		if (
			req.deliveryContext !== undefined &&
			v.value.deliveryContext !== undefined &&
			req.deliveryContext !== v.value.deliveryContext
		)
			return {
				httpStatus: 400,
				status: "rejected",
				reason: "delivery_context_conflict",
			};
		const deliveryContext = req.deliveryContext ?? v.value.deliveryContext;
		if (
			deliveryContext !== undefined &&
			(typeof deliveryContext !== "string" ||
				!deliveryContext ||
				deliveryContext.length > 512 ||
				[...deliveryContext].some(
					(character) =>
						character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
				))
		)
			return {
				httpStatus: 400,
				status: "rejected",
				reason: "invalid_delivery_context",
			};
		// Both send paths share the existing durable claim. Unknown claims remain
		// ambiguous; only a confirmed sent record can suppress a second delivery.
		const idempotencyKey =
			deliveryContext === undefined
				? v.value.idempotencyKey
				: `delivery-context:${createHash("sha256")
						.update(
							JSON.stringify([
								projectName,
								leadId,
								deliveryContext,
								channelId,
								replyTo ?? null,
								createHash("sha256").update(text).digest("hex"),
							]),
						)
						.digest("hex")}`;
		try {
			if (req.guard?.beforeSideEffect) await req.guard.beforeSideEffect();
			req.guard?.assertSideEffectCurrent?.();
			if (req.guard?.signal?.aborted) throw new Error();
		} catch {
			return {
				httpStatus: 403,
				status: "rejected",
				reason: "outbound_scope_revoked",
			};
		}
		const voicePrefix = `chat:${leadId}:voice-handoff:`;
		if (deliveryContext?.startsWith(voicePrefix)) {
			if (!this.produceVoiceLeadResult)
				return {
					httpStatus: 503,
					status: "rejected",
					reason: "voice_result_producer_unavailable",
				};
			try {
				await this.produceVoiceLeadResult({
					projectName,
					sourceLeadId: leadId,
					sourceDeliveryId: deliveryContext,
					operationId: v.value.idempotencyKey,
					text,
				});
			} catch (error) {
				this.logger.warn("voice result commit failed before Discord mirror", {
					projectName,
					leadId,
					error: (error as Error).message,
				});
				return {
					httpStatus: 503,
					status: "rejected",
					reason: "voice_result_commit_failed",
				};
			}
		}

		// 4. Durable dedup — fast path on an existing record.
		const existing = this.store.get(idempotencyKey);
		if (existing?.binding)
			return {
				httpStatus: 409,
				status: "rejected",
				reason: "outbound_binding_conflict",
			};
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
				...(replyTo ? { replyTo } : {}),
				...(req.guard ? { guard: req.guard } : {}),
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
	private async handleProactive(
		v: Extract<ReturnType<typeof validateBody>, { ok: true }>,
	): Promise<OutboundSendOutcome> {
		const identity = {
			projectName: v.value.projectName,
			leadId: v.value.leadId,
			channelId: v.value.channelId,
		};
		const pending = (messageId: string): OutboundSendOutcome => ({
			httpStatus: 202,
			status: "pending",
			sendStatus: "sent",
			messageId,
			engagement: "pending",
		});
		const binding: OutboundEngagementBinding | undefined = v.probe
			? undefined
			: {
					projectName: identity.projectName,
					leadId: identity.leadId,
					parentChannelId: identity.channelId,
					payloadHash: createHash("sha256")
						.update(JSON.stringify([v.value.text, v.value.nonce]))
						.digest("hex"),
				};
		const existing = v.probe
			? undefined
			: this.store.get(v.value.idempotencyKey);
		if (
			existing &&
			engagementBindingKey(existing.binding) !== engagementBindingKey(binding)
		)
			return {
				httpStatus: 409,
				status: "rejected",
				reason: "outbound_binding_conflict",
			};
		let engage: Awaited<ReturnType<PrepareProactiveEngagement>>;
		try {
			if (!this.prepareProactiveEngagement) throw new Error("unavailable");
			engage = await this.prepareProactiveEngagement(identity);
		} catch {
			return existing?.status === "sent" && existing.messageId
				? pending(existing.messageId)
				: {
						httpStatus: 503,
						status: "rejected",
						reason: "proactive_engagement_unavailable",
					};
		}
		if (v.probe) return { httpStatus: 200, status: "authorized" };
		const { idempotencyKey, text, nonce } = v.value;
		let messageId = existing?.messageId;
		if (existing?.status === "in_flight")
			return {
				httpStatus: 409,
				status: "ambiguous",
				reason: "prior_attempt_unproven",
			};
		if (!existing) {
			try {
				if (!this.store.setInFlight(idempotencyKey, binding))
					return this.handleProactive(v);
			} catch {
				return {
					httpStatus: 409,
					status: "rejected",
					reason: "outbound_binding_conflict",
				};
			}
			try {
				messageId = await this.send({ ...identity, text, nonce });
			} catch {
				return {
					httpStatus: 409,
					status: "ambiguous",
					reason: "send_threw_unproven",
				};
			}
			if (!/^\d{17,20}$/.test(messageId))
				return {
					httpStatus: 409,
					status: "ambiguous",
					reason: "send_receipt_invalid",
				};
			this.store.markSent(idempotencyKey, messageId);
		}
		if (!messageId || !binding)
			return {
				httpStatus: 409,
				status: "ambiguous",
				reason: "send_receipt_missing",
			};
		try {
			const state = await engage({
				eventId: idempotencyKey,
				messageId,
				payloadHash: binding.payloadHash,
			});
			if (state !== "ready") return pending(messageId);
			this.store.markEngagementReady(idempotencyKey, binding, messageId);
			return {
				httpStatus: 200,
				status: "sent",
				sendStatus: "sent",
				messageId,
				threadId: messageId,
				engagement: "ready",
			};
		} catch {
			return pending(messageId);
		}
	}
}

function validateBody(body: OutboundSendBody):
	| {
			ok: true;
			probe: true;
			value: {
				projectName: string;
				leadId: string;
				channelId: string;
			};
	  }
	| {
			ok: true;
			probe: false;
			value: {
				projectName: string;
				leadId: string;
				channelId: string;
				text: string;
				idempotencyKey: string;
				nonce: string;
				replyTo?: string;
				deliveryContext?: string;
			};
	  }
	| { ok: false; reason: string } {
	if (
		body.roundtableEngage !== undefined &&
		typeof body.roundtableEngage !== "boolean"
	)
		return { ok: false, reason: "roundtableEngage_invalid" };
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
	if (body.probe === true) {
		return {
			ok: true,
			probe: true,
			value: { projectName, leadId, channelId },
		};
	}
	if (typeof text !== "string" || text === "")
		return { ok: false, reason: "text_required" };
	if (typeof idempotencyKey !== "string" || idempotencyKey === "")
		return { ok: false, reason: "idempotencyKey_required" };
	if (typeof nonce !== "string" || nonce === "")
		return { ok: false, reason: "nonce_required" };
	if (
		body.replyTo !== undefined &&
		(typeof body.replyTo !== "string" || !/^\d{17,20}$/.test(body.replyTo))
	)
		return { ok: false, reason: "invalid_reply_target" };
	if (
		body.deliveryContext !== undefined &&
		(typeof body.deliveryContext !== "string" ||
			!/^[A-Za-z0-9_.:-]{1,512}$/u.test(body.deliveryContext))
	)
		return { ok: false, reason: "invalid_delivery_context" };
	return {
		ok: true,
		probe: false,
		value: {
			projectName,
			leadId,
			channelId,
			text,
			idempotencyKey,
			nonce,
			...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}),
			...(typeof body.deliveryContext === "string"
				? { deliveryContext: body.deliveryContext }
				: {}),
		},
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
		return r
			? { ...r, ...(r.binding ? { binding: { ...r.binding } } : {}) }
			: undefined;
	}
	setInFlight(key: string, binding?: OutboundEngagementBinding): boolean {
		const existing = this.m.get(key);
		if (existing) {
			if (
				engagementBindingKey(existing.binding) !== engagementBindingKey(binding)
			)
				throw new Error("outbound_binding_conflict");
			return false;
		}
		this.m.set(key, {
			idempotencyKey: key,
			status: "in_flight",
			...(binding
				? { binding: { ...binding }, engagement: "pending" as const }
				: {}),
		});
		return true;
	}
	markSent(key: string, messageId: string): void {
		const existing = this.m.get(key);
		if (
			existing?.binding &&
			existing.messageId &&
			existing.messageId !== messageId
		)
			throw new Error("outbound_receipt_conflict");
		this.m.set(key, {
			...existing,
			idempotencyKey: key,
			status: "sent",
			messageId,
		});
	}
	markEngagementReady(
		key: string,
		binding: OutboundEngagementBinding,
		messageId: string,
	): void {
		const existing = this.m.get(key);
		if (
			!existing?.binding ||
			engagementBindingKey(existing.binding) !==
				engagementBindingKey(binding) ||
			existing.status !== "sent" ||
			existing.messageId !== messageId
		)
			throw new Error("outbound_engagement_receipt_invalid");
		existing.engagement = "ready";
	}
	delete(key: string): void {
		this.m.delete(key);
	}
}
