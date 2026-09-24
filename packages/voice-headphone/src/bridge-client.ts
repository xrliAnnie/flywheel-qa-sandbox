/**
 * Bridge voice API client (FLY-546 B2) — the daemon's ONLY window into
 * Bridge state. StateStore is sql.js (in-memory + full export, FLY-663),
 * so cross-process direct reads are unsafe: everything goes through the
 * four `/api/voice/*` endpoints.
 *
 * Failure posture:
 *  - context lookup failure → {kind:"unknown"} (message still enqueues,
 *    headline degrades — never silently dropped)
 *  - gate-binding lookup failure → {bound:false} (fail-closed toward a
 *    NORMAL item: a message must never become approvable by accident)
 *  - ship-approval failure → ok:false with the Bridge's reason (the turn
 *    machine narrates it; nothing retries silently)
 */

import type {
	HeadphoneInboxClaim,
	HeadphoneInboxItem,
	SpeakReceipt,
} from "flywheel-voice-core";

export type VoiceScope = {
	leadBotIds: string[];
	systemBotIds: string[];
	scopeChannelIds: string[];
	roundtableChannelIds: string[];
	founderIdFingerprint: string;
};

export type VoiceContext =
	| {
			kind: "issue_thread";
			issueId: string;
			issueIdentifier: string;
			issueTitle: string;
			agentId: string;
			stage?: string;
	  }
	| { kind: "lead_channel"; agentId: string }
	| { kind: "unknown" };

export type GateBinding =
	| {
			bound: true;
			questionId: string;
			prHeadSha: string;
			issueId: string;
			prNumber?: number;
	  }
	| { bound: false };

export type ShipApprovalRequest = {
	gateMessageId: string;
	questionId: string;
	prHeadSha: string;
	transcript: {
		id: string;
		text: string;
		atMs: number;
		/** the speaker the daemon attributed the utterance to (SSRC→user id). */
		founderUserId: string;
	};
	receiptMessageId: string;
};

export type ShipApprovalResult = {
	ok: boolean;
	written?: boolean;
	kind?: string;
	reason?: string;
	/** false = the response was written but the flip+wake hook did not confirm. */
	retrySafe?: boolean;
};

export type FetchLike = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface BridgeVoiceClientOptions {
	bridgeUrl: string;
	token?: string;
	fetchFn?: FetchLike;
}

export interface HeadphoneSessionBinding {
	sessionId: string;
	generation: number;
	leaseToken: string;
}

export type HeadphoneSourceState = {
	channelId: string;
	health: "healthy" | "recovering" | "rate_limited" | "source_gap";
	[key: string]: unknown;
};

export type HeadphoneSourceHealth = {
	healthy: boolean;
	sourceGap: boolean;
	sources: HeadphoneSourceState[];
};

function headphoneItem(value: unknown): HeadphoneInboxItem {
	const item = value as Record<string, unknown>;
	const id = item.id ?? item.itemId;
	if (
		typeof id !== "string" ||
		!Number.isSafeInteger(item.revision) ||
		(typeof item.createdAt !== "string" &&
			typeof item.sourceCreatedAt !== "string") ||
		typeof item.needsDecision !== "boolean" ||
		typeof item.text !== "string"
	)
		throw new Error("headphone inbox response invalid");
	const speechBrief = item.speechBrief;
	if (
		speechBrief !== undefined &&
		(!speechBrief ||
			typeof speechBrief !== "object" ||
			typeof (speechBrief as Record<string, unknown>).what !== "string" ||
			typeof (speechBrief as Record<string, unknown>).why !== "string" ||
			typeof (speechBrief as Record<string, unknown>).next !== "string")
	)
		throw new Error("headphone inbox response invalid");
	return {
		id,
		revision: item.revision as number,
		createdAt: String(item.createdAt ?? item.sourceCreatedAt),
		needsDecision: item.needsDecision,
		text: item.text,
		...(speechBrief
			? {
					speechBrief: speechBrief as HeadphoneInboxItem["speechBrief"],
				}
			: {}),
	};
}

export class BridgeVoiceClient {
	private readonly fetchFn: FetchLike;
	private readonly contextCache = new Map<string, VoiceContext>();

	constructor(private readonly opts: BridgeVoiceClientOptions) {
		this.fetchFn = opts.fetchFn ?? fetch;
	}

	private headers(): Record<string, string> {
		return this.opts.token
			? { authorization: `Bearer ${this.opts.token}` }
			: {};
	}

	private headphoneHeaders(
		binding: HeadphoneSessionBinding,
		json = false,
	): Record<string, string> {
		return {
			...this.headers(),
			"x-voice-lease": binding.leaseToken,
			...(json ? { "content-type": "application/json" } : {}),
		};
	}

	async listHeadphoneItems(
		binding: HeadphoneSessionBinding,
		limit = 100,
	): Promise<HeadphoneInboxItem[]> {
		const query = new URLSearchParams({
			sessionId: binding.sessionId,
			generation: String(binding.generation),
			limit: String(limit),
		});
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/headphone?${query}`,
			{ headers: this.headphoneHeaders(binding) },
		);
		if (!res.ok)
			throw new Error(`headphone inbox fetch failed: HTTP ${res.status}`);
		const body = (await res.json()) as { items?: unknown };
		if (!Array.isArray(body.items))
			throw new Error("headphone inbox response invalid");
		return body.items.map(headphoneItem);
	}

	async claimHeadphoneItem(
		binding: HeadphoneSessionBinding,
		item: HeadphoneInboxItem,
	): Promise<HeadphoneInboxClaim | undefined> {
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/headphone/claim`,
			{
				method: "POST",
				headers: this.headphoneHeaders(binding, true),
				body: JSON.stringify({
					sessionId: binding.sessionId,
					generation: binding.generation,
					itemId: item.id,
					revision: item.revision,
				}),
			},
		);
		if (res.status === 409) return undefined;
		if (!res.ok)
			throw new Error(`headphone inbox claim failed: HTTP ${res.status}`);
		const body = (await res.json()) as Record<string, unknown>;
		if (typeof body.claimToken !== "string")
			throw new Error("headphone inbox claim response invalid");
		const claimedItem = headphoneItem(body.item);
		if (claimedItem.id !== item.id || claimedItem.revision !== item.revision)
			throw new Error("headphone inbox claim response invalid");
		return { item: claimedItem, claimToken: body.claimToken };
	}

	async ackHeadphoneClaim(
		binding: HeadphoneSessionBinding,
		claim: HeadphoneInboxClaim,
		receipts: readonly SpeakReceipt[],
	): Promise<void> {
		if (
			receipts.length < 1 ||
			receipts.some(
				(receipt) =>
					receipt.outcome !== "completed" ||
					(receipt.contentProof !== "deterministic_tts" &&
						receipt.contentProof !== "transcript_equivalent"),
			)
		)
			throw new Error("headphone inbox ack requires proven completed speech");
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/headphone/ack`,
			{
				method: "POST",
				headers: this.headphoneHeaders(binding, true),
				body: JSON.stringify({
					sessionId: binding.sessionId,
					generation: binding.generation,
					itemId: claim.item.id,
					revision: claim.item.revision,
					claimToken: claim.claimToken,
					requestDigests: receipts.map((receipt) => receipt.requestDigest),
				}),
			},
		);
		if (!res.ok)
			throw new Error(`headphone inbox ack failed: HTTP ${res.status}`);
	}

	async getHeadphoneSourceHealth(
		binding: HeadphoneSessionBinding,
	): Promise<HeadphoneSourceHealth> {
		const query = new URLSearchParams({
			sessionId: binding.sessionId,
			generation: String(binding.generation),
		});
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/headphone/source-health?${query}`,
			{ headers: this.headphoneHeaders(binding) },
		);
		if (!res.ok)
			throw new Error(`headphone source health failed: HTTP ${res.status}`);
		const body = (await res.json()) as { sources?: unknown };
		if (!Array.isArray(body.sources))
			throw new Error("headphone source health response invalid");
		const sources = body.sources as HeadphoneSourceState[];
		if (
			sources.some(
				(source) =>
					typeof source.channelId !== "string" ||
					!["healthy", "recovering", "rate_limited", "source_gap"].includes(
						source.health,
					),
			)
		)
			throw new Error("headphone source health response invalid");
		return {
			healthy:
				sources.length > 0 && sources.every((s) => s.health === "healthy"),
			sourceGap: sources.some((s) => s.health === "source_gap"),
			sources,
		};
	}

	async getScope(): Promise<VoiceScope> {
		const res = await this.fetchFn(`${this.opts.bridgeUrl}/api/voice/scope`, {
			headers: this.headers(),
		});
		if (!res.ok) {
			throw new Error(`voice scope fetch failed: HTTP ${res.status}`);
		}
		return (await res.json()) as VoiceScope;
	}

	async getContext(channelId: string): Promise<VoiceContext> {
		const cached = this.contextCache.get(channelId);
		if (cached) return cached;
		try {
			const res = await this.fetchFn(
				`${this.opts.bridgeUrl}/api/voice/context?channelId=${encodeURIComponent(channelId)}`,
				{ headers: this.headers() },
			);
			if (!res.ok) return { kind: "unknown" };
			const ctx = (await res.json()) as VoiceContext;
			// only cache resolved contexts — an unknown may become known once
			// the Bridge registers the thread.
			if (ctx.kind !== "unknown") this.contextCache.set(channelId, ctx);
			return ctx;
		} catch {
			return { kind: "unknown" };
		}
	}

	async getGateBinding(messageId: string): Promise<GateBinding> {
		try {
			const res = await this.fetchFn(
				`${this.opts.bridgeUrl}/api/voice/gate-binding?messageId=${encodeURIComponent(messageId)}`,
				{ headers: this.headers() },
			);
			if (!res.ok) return { bound: false };
			return (await res.json()) as GateBinding;
		} catch {
			return { bound: false };
		}
	}

	async postShipApproval(
		body: ShipApprovalRequest,
	): Promise<ShipApprovalResult> {
		try {
			const res = await this.fetchFn(
				`${this.opts.bridgeUrl}/api/voice/ship-approval`,
				{
					method: "POST",
					headers: { ...this.headers(), "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			const parsed = (await res.json().catch(() => ({}))) as Record<
				string,
				unknown
			>;
			if (!res.ok) {
				return {
					ok: false,
					reason: `HTTP ${res.status}: ${String(parsed.error ?? "")}`.trim(),
				};
			}
			return {
				ok: true,
				written: parsed.written as boolean | undefined,
				kind: parsed.kind as string | undefined,
				reason: parsed.reason as string | undefined,
				retrySafe: parsed.retrySafe as boolean | undefined,
			};
		} catch (err) {
			return { ok: false, reason: `bridge unreachable: ${String(err)}` };
		}
	}
}
