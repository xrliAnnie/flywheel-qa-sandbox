export interface VoiceSessionProjection {
	mode: "meeting" | "rg";
	projectName: string;
	leadId: string;
	displayName: string;
	realtimeVoice: string;
	guildId: string;
	voiceChannelId: string;
	threadId: string;
	boundChannelIds: string[];
	founderUserId: string;
	qaAllowUserIds: string[];
	evidenceDir?: string;
	meetingId?: string;
}

export interface VoiceOutboundItem {
	seq: number;
	messageId: string;
	text: string;
}

export class VoiceLease {
	private deadlineMs = Number.NEGATIVE_INFINITY;
	private active = false;
	private fenced = false;

	constructor(private readonly monoNow: () => number) {}

	get deadline(): number {
		return this.deadlineMs;
	}

	get remainingMs(): number {
		return Math.max(0, this.deadlineMs - this.monoNow());
	}

	install(sentAt: number, leaseTtlMs: number, httpTimeoutMs: number): void {
		if (this.fenced || (this.active && this.monoNow() >= this.deadlineMs)) {
			this.fence();
			throw new Error("voice_lease_fenced");
		}
		this.deadlineMs = sentAt + leaseTtlMs - httpTimeoutMs;
		this.active = true;
	}

	fence(): void {
		this.fenced = true;
		this.active = false;
	}

	assert(): void {
		if (!this.active || this.monoNow() >= this.deadlineMs) {
			this.fence();
			throw new Error("voice_lease_fenced");
		}
	}
}

export class BridgeVoiceHttpError extends Error {
	constructor(
		readonly status: number,
		readonly reason: string,
	) {
		super(`voice bridge ${status}: ${reason}`);
	}
}

export class BridgeVoiceClient {
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly monoNow: () => number;

	constructor(
		private readonly options: {
			baseUrl: string;
			token: string;
			httpTimeoutMs: number;
			fetchImpl?: typeof fetch;
			monoNow?: () => number;
		},
	) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.monoNow = options.monoNow ?? performance.now.bind(performance);
	}

	async desired(): Promise<{ sessionId: string } | null> {
		const body = await this.request<{ session: { sessionId: string } | null }>(
			"/api/voice/sessions/desired",
		);
		return body.session;
	}

	async claim(
		sessionId: string,
		daemonBootId: string,
	): Promise<{
		lease: VoiceLease;
		leaseToken: string;
		leaseExpiresAt: string;
		projection: VoiceSessionProjection;
	}> {
		const sentAt = this.monoNow();
		const body = await this.request<{
			leaseToken: string;
			leaseTtlMs: number;
			leaseExpiresAt: string;
			projection: VoiceSessionProjection;
		}>(`/api/voice/sessions/${encodeURIComponent(sessionId)}/claim`, {
			method: "POST",
			body: { daemonBootId },
		});
		const lease = new VoiceLease(this.monoNow);
		lease.install(sentAt, body.leaseTtlMs, this.options.httpTimeoutMs);
		return {
			lease,
			leaseToken: body.leaseToken,
			leaseExpiresAt: body.leaseExpiresAt,
			projection: body.projection,
		};
	}

	async renew(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
	): Promise<{ state: string; leaseExpiresAt: string }> {
		lease.assert();
		const sentAt = this.monoNow();
		const body = await this.request<{
			state: string;
			leaseTtlMs: number;
			leaseExpiresAt: string;
		}>(`/api/voice/sessions/${encodeURIComponent(sessionId)}/renew`, {
			method: "POST",
			leaseToken,
		});
		lease.install(sentAt, body.leaseTtlMs, this.options.httpTimeoutMs);
		return { state: body.state, leaseExpiresAt: body.leaseExpiresAt };
	}

	async renewRecovered(
		sessionId: string,
		leaseToken: string,
	): Promise<{ state: string; leaseExpiresAt: string; lease: VoiceLease }> {
		const sentAt = this.monoNow();
		const body = await this.request<{
			state: string;
			leaseTtlMs: number;
			leaseExpiresAt: string;
		}>(`/api/voice/sessions/${encodeURIComponent(sessionId)}/renew`, {
			method: "POST",
			leaseToken,
		});
		const lease = new VoiceLease(this.monoNow);
		lease.install(sentAt, body.leaseTtlMs, this.options.httpTimeoutMs);
		return { state: body.state, leaseExpiresAt: body.leaseExpiresAt, lease };
	}

	async setState(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
		state: "warming" | "live" | "ended" | "failed",
		reason?: string,
		abandonedCount?: number,
	): Promise<void> {
		if (state !== "failed") lease.assert();
		await this.request(
			`/api/voice/sessions/${encodeURIComponent(sessionId)}/state`,
			{
				method: "POST",
				leaseToken,
				body: {
					state,
					...(reason ? { reason } : {}),
					...(abandonedCount === undefined ? {} : { abandonedCount }),
				},
			},
		);
	}

	async outbound(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
	): Promise<VoiceOutboundItem[]> {
		lease.assert();
		return (
			await this.request<{ items: VoiceOutboundItem[] }>(
				`/api/voice/sessions/${encodeURIComponent(sessionId)}/outbound`,
				{ leaseToken },
			)
		).items;
	}

	async claimOutbound(
		sessionId: string,
		seq: number,
		leaseToken: string,
		lease: VoiceLease,
	): Promise<string> {
		lease.assert();
		return (
			await this.request<{ attemptToken: string }>(
				`/api/voice/sessions/${encodeURIComponent(sessionId)}/outbound/${seq}/claim`,
				{ method: "POST", leaseToken },
			)
		).attemptToken;
	}

	async receipt(
		sessionId: string,
		seq: number,
		leaseToken: string,
		lease: VoiceLease,
		attemptToken: string,
		status: "confirmed" | "unconfirmed" | "failed" | "dropped",
	): Promise<void> {
		lease.assert();
		await this.request(
			`/api/voice/sessions/${encodeURIComponent(sessionId)}/outbound/${seq}/receipt`,
			{
				method: "POST",
				leaseToken,
				body: { attemptToken, status },
			},
		);
	}

	private async request<T = Record<string, unknown>>(
		path: string,
		options: {
			method?: "GET" | "POST";
			body?: unknown;
			leaseToken?: string;
		} = {},
	): Promise<T> {
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method: options.method ?? "GET",
			signal: AbortSignal.timeout(this.options.httpTimeoutMs),
			headers: {
				Authorization: `Bearer ${this.options.token}`,
				...(options.leaseToken ? { "X-Voice-Lease": options.leaseToken } : {}),
				...(options.body === undefined
					? {}
					: { "Content-Type": "application/json" }),
			},
			...(options.body === undefined
				? {}
				: { body: JSON.stringify(options.body) }),
		});
		let body: Record<string, unknown> = {};
		try {
			body = (await response.json()) as Record<string, unknown>;
		} catch {
			// HTTP status remains authoritative.
		}
		if (!response.ok) {
			throw new BridgeVoiceHttpError(
				response.status,
				(typeof body.reason === "string" && body.reason) ||
					(typeof body.error === "string" && body.error) ||
					`http_${response.status}`,
			);
		}
		return body as T;
	}
}
