import type { SessionSlotLease } from "./SessionSlot.js";

export type ResidentVoiceMode = "meeting" | "rg";

export interface ResidentSelfFilterProof {
	outputBotDropped: boolean;
	earsBotDropped: boolean;
	unknownDropped: boolean;
	allowedHumanPassed: boolean;
}

export interface ResidentBindingProof extends ResidentSelfFilterProof {
	version: 1;
	projectName: string;
	guildId: string;
	voiceChannelId: string;
	ownerBootId: string;
	sessionGeneration: number;
	outputBotUserId: string;
	earsBotUserId: string;
	observedAt: string;
	expiresAt: string;
}

export interface ResidentVoiceClaimInput {
	requestId: string;
	mode: ResidentVoiceMode;
	leadId: string;
}

export type ResidentVoiceState = "warming" | "live" | "ended" | "failed";

/** Canonical durable reason for a resident session that ended normally. */
export const RESIDENT_VOICE_NORMAL_END_REASON = "voice-stop" as const;
export type ResidentVoiceClose =
	| [state: "ended", reason: typeof RESIDENT_VOICE_NORMAL_END_REASON]
	| [state: "failed", reason: string];

export interface ResidentVoiceLease {
	readonly mode: ResidentVoiceMode;
	readonly sessionId: string;
	readonly sessionGeneration: number;
	readonly leaseToken: string;
	readonly leaseTtlMs: number;
	toSlotLease(slotMode?: string): SessionSlotLease;
	assertActive(): void;
	renew(): Promise<void>;
	setState(state: "warming" | "live"): Promise<void>;
	startRenewing(onLost?: (error: Error) => void): () => void;
	close(...args: ResidentVoiceClose): Promise<void>;
}

export interface ResidentVoiceSessionClientOptions {
	bridgeUrl: string;
	apiToken: string;
	projectName: string;
	guildId: string;
	voiceChannelId: string;
	outputBotUserId: string;
	earsBotUserId: string;
	ownerBootId: string;
	selfFilterProof: () => ResidentSelfFilterProof;
	proofTtlMs?: number;
	requestTimeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

interface ClaimResponse {
	status: "inserted" | "replayed";
	sessionId: string;
	state: "claimed";
	carrierKind: "resident";
	ownerBootId: string;
	sessionGeneration: number;
	leaseToken: string;
	leaseTtlMs: number;
	leaseExpiresAt: string;
}

interface RenewResponse {
	leaseTtlMs: number;
	leaseExpiresAt: string;
}

const DEFAULT_PROOF_TTL_MS = 60_000;
export const DEFAULT_RESIDENT_VOICE_REQUEST_TIMEOUT_MS = 2_000;

function requiredText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseExpiry(value: unknown): number {
	if (!requiredText(value)) throw new Error("resident_voice_response_invalid");
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed))
		throw new Error("resident_voice_response_invalid");
	return parsed;
}

class Lease implements ResidentVoiceLease {
	private active = true;
	private leaseExpiresAt: number;
	private renewTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly client: ResidentVoiceSessionClient,
		readonly mode: ResidentVoiceMode,
		readonly sessionId: string,
		readonly sessionGeneration: number,
		readonly leaseToken: string,
		readonly leaseTtlMs: number,
		leaseExpiresAt: number,
	) {
		this.leaseExpiresAt = leaseExpiresAt;
	}

	toSlotLease(slotMode = this.mode): SessionSlotLease {
		return {
			mode: slotMode,
			sessionId: this.sessionId,
			sessionGeneration: this.sessionGeneration,
			leaseToken: this.leaseToken,
		};
	}

	assertActive(): void {
		if (!this.active || this.client.nowMs() >= this.leaseExpiresAt)
			throw new Error("resident_voice_lease_lost");
	}

	async renew(): Promise<void> {
		this.assertActive();
		try {
			const result = await this.client.request<RenewResponse>(
				`/api/voice/sessions/${encodeURIComponent(this.sessionId)}/renew`,
				{
					ownerBootId: this.client.ownerBootId,
					sessionGeneration: this.sessionGeneration,
					bindingProof: this.client.bindingProof(this.sessionGeneration),
				},
				this.leaseToken,
				"renew",
			);
			if (!Number.isSafeInteger(result.leaseTtlMs) || result.leaseTtlMs < 1)
				throw new Error("resident_voice_response_invalid");
			this.leaseExpiresAt = parseExpiry(result.leaseExpiresAt);
		} catch (error) {
			this.deactivate();
			throw error;
		}
	}

	async setState(state: "warming" | "live"): Promise<void> {
		this.assertActive();
		await this.client.request(
			`/api/voice/sessions/${encodeURIComponent(this.sessionId)}/state`,
			{
				state,
				ownerBootId: this.client.ownerBootId,
				sessionGeneration: this.sessionGeneration,
			},
			this.leaseToken,
		);
	}

	startRenewing(onLost?: (error: Error) => void): () => void {
		this.assertActive();
		if (this.renewTimer) return () => this.stopRenewing();
		const intervalMs = Math.max(1_000, Math.floor(this.leaseTtlMs / 3));
		this.renewTimer = setInterval(() => {
			void this.renew().catch((error: unknown) => {
				onLost?.(
					error instanceof Error
						? error
						: new Error("resident_voice_lease_lost"),
				);
			});
		}, intervalMs);
		this.renewTimer.unref?.();
		return () => this.stopRenewing();
	}

	async close(...[state, reason]: ResidentVoiceClose): Promise<void> {
		if (!this.active) return;
		this.stopRenewing();
		try {
			await this.client.request(
				`/api/voice/sessions/${encodeURIComponent(this.sessionId)}/state`,
				{
					state,
					ownerBootId: this.client.ownerBootId,
					sessionGeneration: this.sessionGeneration,
					reason,
				},
				this.leaseToken,
			);
		} finally {
			this.deactivate();
		}
	}

	private stopRenewing(): void {
		if (!this.renewTimer) return;
		clearInterval(this.renewTimer);
		this.renewTimer = undefined;
	}

	private deactivate(): void {
		this.active = false;
		this.stopRenewing();
	}
}

export class ResidentVoiceSessionClient {
	private generation = 0;
	private readonly claims = new Map<string, Promise<ResidentVoiceLease>>();
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly proofTtlMs: number;
	private readonly requestTimeoutMs: number;
	readonly ownerBootId: string;

	constructor(private readonly options: ResidentVoiceSessionClientOptions) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
		this.proofTtlMs = options.proofTtlMs ?? DEFAULT_PROOF_TTL_MS;
		this.requestTimeoutMs =
			options.requestTimeoutMs ?? DEFAULT_RESIDENT_VOICE_REQUEST_TIMEOUT_MS;
		if (
			!Number.isSafeInteger(this.requestTimeoutMs) ||
			this.requestTimeoutMs < 1
		)
			throw new Error("resident_voice_request_timeout_invalid");
		this.ownerBootId = options.ownerBootId;
	}

	claim(input: ResidentVoiceClaimInput): Promise<ResidentVoiceLease> {
		if (!input.requestId || !input.leadId)
			return Promise.reject(new Error("resident_voice_claim_invalid"));
		const existing = this.claims.get(input.requestId);
		if (existing) return existing;
		const sessionGeneration = ++this.generation;
		const pending = this.claimNew(input, sessionGeneration).catch((error) => {
			this.claims.delete(input.requestId);
			throw error;
		});
		this.claims.set(input.requestId, pending);
		return pending;
	}

	nowMs(): number {
		return this.now();
	}

	bindingProof(sessionGeneration: number): ResidentBindingProof {
		const observedAt = this.now();
		return {
			version: 1,
			projectName: this.options.projectName,
			guildId: this.options.guildId,
			voiceChannelId: this.options.voiceChannelId,
			ownerBootId: this.options.ownerBootId,
			sessionGeneration,
			outputBotUserId: this.options.outputBotUserId,
			earsBotUserId: this.options.earsBotUserId,
			...this.options.selfFilterProof(),
			observedAt: new Date(observedAt).toISOString(),
			expiresAt: new Date(observedAt + this.proofTtlMs).toISOString(),
		};
	}

	async request<T = unknown>(
		path: string,
		body: unknown,
		leaseToken?: string,
		operation: "request" | "claim" | "renew" = "request",
	): Promise<T> {
		const signal = AbortSignal.timeout(this.requestTimeoutMs);
		let response: Response;
		try {
			response = await this.fetchImpl(
				new URL(path, this.options.bridgeUrl).toString(),
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.options.apiToken}`,
						"Content-Type": "application/json",
						...(leaseToken ? { "X-Voice-Lease": leaseToken } : {}),
					},
					body: JSON.stringify(body),
					signal,
				},
			);
		} catch (error) {
			if (signal.aborted) {
				throw new Error(
					`resident_voice_${operation}_timeout:${this.requestTimeoutMs}ms`,
					{ cause: error },
				);
			}
			throw error;
		}
		if (!response.ok)
			throw new Error(`resident_voice_${operation}_failed:${response.status}`);
		return (await response.json()) as T;
	}

	private async claimNew(
		input: ResidentVoiceClaimInput,
		sessionGeneration: number,
	): Promise<ResidentVoiceLease> {
		const result = await this.request<ClaimResponse>(
			"/api/voice/sessions/resident/claim",
			{
				requestId: input.requestId,
				mode: input.mode,
				projectName: this.options.projectName,
				leadId: input.leadId,
				ownerBootId: this.options.ownerBootId,
				sessionGeneration,
				bindingProof: this.bindingProof(sessionGeneration),
			},
			undefined,
			"claim",
		);
		if (
			(result.status !== "inserted" && result.status !== "replayed") ||
			result.state !== "claimed" ||
			result.carrierKind !== "resident" ||
			result.ownerBootId !== this.options.ownerBootId ||
			result.sessionGeneration !== sessionGeneration ||
			!requiredText(result.sessionId) ||
			!requiredText(result.leaseToken) ||
			!Number.isSafeInteger(result.leaseTtlMs) ||
			result.leaseTtlMs < 1
		)
			throw new Error("resident_voice_response_invalid");
		return new Lease(
			this,
			input.mode,
			result.sessionId,
			result.sessionGeneration,
			result.leaseToken,
			result.leaseTtlMs,
			parseExpiry(result.leaseExpiresAt),
		);
	}
}
