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
