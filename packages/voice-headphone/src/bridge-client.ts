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
	AgendaBriefRequestInput,
	AgendaDispositionRecord,
	AgendaSnapshot,
	AgendaState,
	HeadphoneInboxClaim,
	HeadphoneInboxItem,
	SpeakReceipt,
	VoiceHandoffReceipt,
	VoiceHandoffRequest,
	VoiceHandoffResultEvent,
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
	record?(event: Record<string, unknown>): void;
	replyReconnectDelayMs?: number;
	replyReconnectMaxDelayMs?: number;
	replyReconnectMaxAttempts?: number;
}

export interface HeadphoneSessionBinding {
	sessionId: string;
	generation: number;
	leaseToken: string;
}

export interface VoiceReplyWake {
	sessionId: string;
	generation: number;
	handoffId: string;
}

export type VoiceReplyListener = (event: VoiceReplyWake) => void;

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

export interface VoiceHandoffResultsPage {
	events: VoiceHandoffResultEvent[];
	highWatermark: number;
	nextCursor: number;
}

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
		speechBrief !== null &&
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
	private readonly registeredHandoffs = new Map<string, Set<string>>();

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

	private bindingKey(binding: HeadphoneSessionBinding): string {
		return `${binding.sessionId}:${binding.generation}`;
	}

	async listHeadphoneItems(
		binding: HeadphoneSessionBinding,
		limit = 100,
	): Promise<HeadphoneInboxItem[]> {
		const items: HeadphoneInboxItem[] = [];
		let cursor: string | undefined;
		let snapshotId: string | undefined;
		let highWatermark: number | undefined;
		const seenCursors = new Set<string>();
		for (;;) {
			const query = new URLSearchParams({
				sessionId: binding.sessionId,
				generation: String(binding.generation),
				limit: String(limit),
				...(cursor ? { cursor } : {}),
			});
			const res = await this.fetchFn(
				`${this.opts.bridgeUrl}/api/voice/headphone?${query}`,
				{ headers: this.headphoneHeaders(binding) },
			);
			if (!res.ok)
				throw new Error(`headphone inbox fetch failed: HTTP ${res.status}`);
			const body = (await res.json()) as Record<string, unknown>;
			if (
				typeof body.snapshotId !== "string" ||
				!Number.isSafeInteger(body.highWatermark) ||
				!Array.isArray(body.items) ||
				(body.nextCursor !== null && typeof body.nextCursor !== "string")
			)
				throw new Error("headphone inbox response invalid");
			if (
				(snapshotId !== undefined && body.snapshotId !== snapshotId) ||
				(highWatermark !== undefined && body.highWatermark !== highWatermark)
			)
				throw new Error("headphone inbox snapshot changed during pagination");
			snapshotId = body.snapshotId;
			highWatermark = body.highWatermark as number;
			items.push(...body.items.map(headphoneItem));
			if (body.nextCursor === null) return items;
			cursor = body.nextCursor as string;
			if (seenCursors.has(cursor))
				throw new Error("headphone inbox cursor loop");
			seenCursors.add(cursor);
		}
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
		if (
			typeof body.claimToken !== "string" ||
			!Number.isSafeInteger(body.attempt) ||
			typeof body.pendingKey !== "string"
		)
			throw new Error("headphone inbox claim response invalid");
		const claimedItem = headphoneItem(body.item);
		if (claimedItem.id !== item.id || claimedItem.revision !== item.revision)
			throw new Error("headphone inbox claim response invalid");
		return {
			item: claimedItem,
			claimToken: body.claimToken,
			attempt: body.attempt as number,
			pendingKey: body.pendingKey,
		};
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
					receipts,
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

	async handoffToLead(
		binding: HeadphoneSessionBinding,
		request: VoiceHandoffRequest,
	): Promise<VoiceHandoffReceipt> {
		if (
			request.sessionId !== binding.sessionId ||
			request.generation !== binding.generation
		)
			throw new Error("voice handoff session binding mismatch");
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/handoffs/`,
			{
				method: "POST",
				headers: this.headphoneHeaders(binding, true),
				body: JSON.stringify(request),
			},
		);
		if (!res.ok && res.status !== 202)
			throw new Error(`voice handoff failed: HTTP ${res.status}`);
		const body = (await res.json()) as VoiceHandoffReceipt;
		if (
			body.handoffId !== request.handoffId ||
			body.requestDigest !== request.requestDigest ||
			![
				"authorized",
				"dispatching",
				"committed",
				"rejected",
				"ambiguous",
				"needs_human",
			].includes(body.state)
		)
			throw new Error("voice handoff response invalid");
		const key = this.bindingKey(binding);
		const handoffs = this.registeredHandoffs.get(key) ?? new Set<string>();
		handoffs.add(request.handoffId);
		this.registeredHandoffs.set(key, handoffs);
		return body;
	}

	subscribeReplies(
		binding: HeadphoneSessionBinding,
		listener: VoiceReplyListener,
	): () => void {
		if (!this.opts.token)
			throw new Error("voice reply subscription requires token");
		if (
			!binding.sessionId ||
			!Number.isSafeInteger(binding.generation) ||
			binding.generation < 1 ||
			!binding.leaseToken
		)
			throw new Error("voice reply subscription binding invalid");

		const query = new URLSearchParams({
			sessionId: binding.sessionId,
			generation: String(binding.generation),
		});
		const url = `${this.opts.bridgeUrl}/api/voice/handoffs/replies?${query}`;
		const key = this.bindingKey(binding);
		const reconnectDelay = this.opts.replyReconnectDelayMs ?? 1_000;
		const reconnectMaxDelay = this.opts.replyReconnectMaxDelayMs ?? 30_000;
		const reconnectMaxAttempts = this.opts.replyReconnectMaxAttempts ?? 5;
		if (
			!Number.isSafeInteger(reconnectDelay) ||
			reconnectDelay < 1 ||
			!Number.isSafeInteger(reconnectMaxDelay) ||
			reconnectMaxDelay < reconnectDelay ||
			!Number.isSafeInteger(reconnectMaxAttempts) ||
			reconnectMaxAttempts < 0
		)
			throw new Error("voice reply reconnect policy invalid");
		let stopped = false;
		let admissionStarted = false;
		let connectedOnce = false;
		let reconnectAttempts = 0;
		let controller: AbortController | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let reconnectResetTimer: ReturnType<typeof setTimeout> | undefined;

		const clearReconnectReset = () => {
			if (reconnectResetTimer) clearTimeout(reconnectResetTimer);
			reconnectResetTimer = undefined;
		};

		const recordFailure = (error: unknown) => {
			this.opts.record?.({
				kind: "voice_reply_subscription_failed",
				sessionId: binding.sessionId,
				generation: binding.generation,
				message: error instanceof Error ? error.message : String(error),
			});
		};
		const notify = (event: VoiceReplyWake) => {
			try {
				listener(event);
			} catch (error) {
				this.opts.record?.({
					kind: "voice_reply_listener_failed",
					sessionId: binding.sessionId,
					generation: binding.generation,
					handoffId: event.handoffId,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		};
		const handleFrame = (frame: string) => {
			let eventName = "message";
			const dataLines: string[] = [];
			for (const line of frame.split("\n")) {
				if (line.startsWith("event: ")) eventName = line.slice(7);
				else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
			}
			if (dataLines.length === 0) return;
			const payload = JSON.parse(dataLines.join("\n")) as Record<
				string,
				unknown
			>;
			if (eventName === "ready") {
				if (
					Object.keys(payload).length !== 2 ||
					payload.sessionId !== binding.sessionId ||
					payload.generation !== binding.generation
				)
					throw new Error("voice reply subscription ready binding mismatch");
				if (connectedOnce) {
					for (const handoffId of this.registeredHandoffs.get(key) ?? [])
						notify({
							sessionId: binding.sessionId,
							generation: binding.generation,
							handoffId,
						});
				}
				connectedOnce = true;
				clearReconnectReset();
				if (reconnectAttempts > 0) {
					reconnectResetTimer = setTimeout(() => {
						reconnectAttempts = 0;
						reconnectResetTimer = undefined;
					}, reconnectMaxDelay);
					reconnectResetTimer.unref?.();
				}
				return;
			}
			if (eventName !== "reply") return;
			if (
				Object.keys(payload).length !== 3 ||
				payload.sessionId !== binding.sessionId ||
				payload.generation !== binding.generation ||
				typeof payload.handoffId !== "string" ||
				!payload.handoffId
			)
				throw new Error("voice reply subscription event invalid");
			notify(payload as unknown as VoiceReplyWake);
		};
		const scheduleReconnect = (open: () => void) => {
			if (stopped || retryTimer) return;
			if (reconnectAttempts >= reconnectMaxAttempts) {
				this.opts.record?.({
					kind: "voice_reply_subscription_exhausted",
					sessionId: binding.sessionId,
					generation: binding.generation,
					reconnectAttempts,
				});
				return;
			}
			const delayMs = Math.min(
				reconnectMaxDelay,
				reconnectDelay * 2 ** reconnectAttempts,
			);
			reconnectAttempts += 1;
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				open();
			}, delayMs);
			retryTimer.unref?.();
		};
		const open = () => {
			if (stopped) return;
			controller = new AbortController();
			let response: Promise<Response>;
			try {
				response = this.fetchFn(url, {
					headers: this.headphoneHeaders(binding),
					signal: controller.signal,
				});
			} catch (error) {
				if (!admissionStarted) throw error;
				recordFailure(error);
				scheduleReconnect(open);
				return;
			}
			admissionStarted = true;
			void (async () => {
				try {
					const res = await response;
					if (!res.ok)
						throw new Error(
							`voice reply subscription failed: HTTP ${res.status}`,
						);
					if (!res.headers.get("content-type")?.includes("text/event-stream"))
						throw new Error("voice reply subscription response invalid");
					if (!res.body)
						throw new Error("voice reply subscription body missing");
					reader = res.body.getReader();
					const decoder = new TextDecoder();
					let pending = "";
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						pending += decoder
							.decode(chunk.value, { stream: true })
							.replaceAll("\r\n", "\n");
						for (;;) {
							const boundary = pending.indexOf("\n\n");
							if (boundary < 0) break;
							handleFrame(pending.slice(0, boundary));
							pending = pending.slice(boundary + 2);
						}
					}
					if (!stopped)
						throw new Error("voice reply subscription disconnected");
				} catch (error) {
					if (stopped) return;
					clearReconnectReset();
					recordFailure(error);
					scheduleReconnect(open);
				} finally {
					reader = undefined;
				}
			})();
		};

		open();
		return () => {
			if (stopped) return;
			stopped = true;
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = undefined;
			clearReconnectReset();
			controller?.abort();
			void reader?.cancel().catch(() => undefined);
			reader = undefined;
		};
	}

	// ── FLY-2863 voice agenda (lease-bound) ──

	async getAgendaSnapshot(
		binding: HeadphoneSessionBinding,
	): Promise<AgendaSnapshot> {
		const query = new URLSearchParams({
			sessionId: binding.sessionId,
			generation: String(binding.generation),
		});
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/agenda?${query}`,
			{ headers: this.headphoneHeaders(binding) },
		);
		if (!res.ok) throw new Error(`voice agenda failed: HTTP ${res.status}`);
		const body = (await res.json()) as AgendaSnapshot;
		if (
			typeof body.snapshotId !== "string" ||
			!Array.isArray(body.items) ||
			typeof body.complete !== "boolean" ||
			!body.sourceStatus ||
			typeof body.sourceStatus !== "object" ||
			!Number.isSafeInteger(body.olderUnspokenCount) ||
			body.items.some(
				(item) =>
					typeof item?.itemKey !== "string" ||
					typeof item.sourceKey !== "string" ||
					typeof item.class !== "string",
			)
		)
			throw new Error("voice agenda response invalid");
		return body;
	}

	async getAgendaState(
		binding: HeadphoneSessionBinding,
	): Promise<AgendaState | undefined> {
		const query = new URLSearchParams({
			sessionId: binding.sessionId,
			generation: String(binding.generation),
		});
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/agenda/state?${query}`,
			{ headers: this.headphoneHeaders(binding) },
		);
		if (!res.ok)
			throw new Error(`voice agenda state failed: HTTP ${res.status}`);
		const body = (await res.json()) as { state?: AgendaState | null };
		return body.state ?? undefined;
	}

	async putAgendaState(
		binding: HeadphoneSessionBinding,
		input: {
			state: AgendaState;
			expectedVersion: number;
			dispositions: readonly AgendaDispositionRecord[];
		},
	): Promise<{ ok: true } | { ok: false; current?: AgendaState }> {
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/agenda/state`,
			{
				method: "PUT",
				headers: this.headphoneHeaders(binding, true),
				body: JSON.stringify({
					sessionId: binding.sessionId,
					generation: binding.generation,
					...input,
				}),
			},
		);
		if (res.status === 409) {
			const body = (await res.json()) as { current?: AgendaState };
			return { ok: false, ...(body.current ? { current: body.current } : {}) };
		}
		if (!res.ok)
			throw new Error(`voice agenda state write failed: HTTP ${res.status}`);
		return { ok: true };
	}

	async requestAgendaBrief(
		binding: HeadphoneSessionBinding,
		input: AgendaBriefRequestInput,
	): Promise<{ requestId: string }> {
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/agenda/requests`,
			{
				method: "POST",
				headers: this.headphoneHeaders(binding, true),
				body: JSON.stringify({
					sessionId: binding.sessionId,
					generation: binding.generation,
					...input,
				}),
			},
		);
		if (!res.ok)
			throw new Error(`voice agenda request failed: HTTP ${res.status}`);
		const body = (await res.json()) as { requestId?: unknown; state?: unknown };
		if (typeof body.requestId !== "string" || !body.requestId)
			throw new Error("voice agenda request response invalid");
		if (body.state === "rejected" || body.state === "needs_human")
			throw new Error(`voice agenda request ${String(body.state)}`);
		// Replayed on reconnect like a handoff, so no Lead answer is missed.
		const key = this.bindingKey(binding);
		const handoffs = this.registeredHandoffs.get(key) ?? new Set<string>();
		handoffs.add(body.requestId);
		this.registeredHandoffs.set(key, handoffs);
		return { requestId: body.requestId };
	}

	async bindAgendaTurn(
		binding: HeadphoneSessionBinding,
		input: { utteranceId: string; turnId: string; itemKey: string },
	): Promise<void> {
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/agenda/turns`,
			{
				method: "POST",
				headers: this.headphoneHeaders(binding, true),
				body: JSON.stringify({
					sessionId: binding.sessionId,
					generation: binding.generation,
					...input,
				}),
			},
		);
		if (!res.ok)
			throw new Error(`voice agenda turn bind failed: HTTP ${res.status}`);
	}

	async listVoiceHandoffResults(
		binding: HeadphoneSessionBinding,
		handoffId: string,
		after = 0,
		limit = 100,
	): Promise<VoiceHandoffResultsPage> {
		const query = new URLSearchParams({
			sessionId: binding.sessionId,
			generation: String(binding.generation),
			after: String(after),
			limit: String(limit),
		});
		const res = await this.fetchFn(
			`${this.opts.bridgeUrl}/api/voice/handoffs/${encodeURIComponent(handoffId)}/results?${query}`,
			{ headers: this.headphoneHeaders(binding) },
		);
		if (!res.ok)
			throw new Error(`voice handoff results failed: HTTP ${res.status}`);
		const body = (await res.json()) as VoiceHandoffResultsPage;
		if (
			!Array.isArray(body.events) ||
			!Number.isSafeInteger(body.highWatermark) ||
			!Number.isSafeInteger(body.nextCursor) ||
			body.nextCursor < after ||
			body.highWatermark < body.nextCursor ||
			body.events.some(
				(event) =>
					event.handoffId !== handoffId ||
					!Number.isSafeInteger(event.seq) ||
					event.seq <= after,
			)
		)
			throw new Error("voice handoff results response invalid");
		return body;
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
