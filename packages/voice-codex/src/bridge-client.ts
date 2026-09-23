import { randomUUID } from "node:crypto";
import type { ReceiveHealth, VoiceUtterance } from "flywheel-voice-core";
import { validateVoiceBridgeUrl } from "./config.js";

export interface VoiceSessionProjection {
	sessionId: string;
	voiceBotUserId: string;
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
	/** FLY-2701: set only for a booked meeting — the earliest live instant. */
	notBeforeLiveAt?: string;
	/** Absolute deadline for the founder to show up; null for instant sessions. */
	presenceDeadlineAt?: string;
	/** Schedule revision this session belongs to; null for instant sessions. */
	scheduleRevision?: number;
}

export interface VoiceOutboundItem {
	seq: number;
	messageId: string;
	text: string;
}

export type VoiceBridgeOperation =
	| "desired"
	| "claim"
	| "renew"
	| "state"
	| "outbound"
	| "receipt"
	| "context"
	| "utterance"
	| "handoff";

export type VoiceBridgeReasonClass =
	| "bridge_connect_failed"
	| "bridge_timeout_headers"
	| "bridge_timeout_body"
	| "bridge_auth_rejected"
	| "bridge_http_error"
	| "bridge_protocol_invalid"
	| "unknown_failure";

export type VoiceBridgeCauseCode =
	| "request_timeout"
	| "invalid_json"
	| "invalid_response"
	| "http_401"
	| "http_403"
	| "http_4xx"
	| "http_5xx"
	| "http_error"
	| "dns_failed"
	| "connection_refused"
	| "connection_reset"
	| "fetch_failed"
	| "body_read_failed"
	| "unknown_error";

export interface VoiceBridgeRequestDiagnostic {
	operation: VoiceBridgeOperation;
	method: "GET" | "POST";
	routeTemplate: string;
	requestId: string;
	elapsedMs: number;
	phase: "headers" | "body";
	status?: number;
	timeoutMs: number;
	reasonClass: VoiceBridgeReasonClass;
	causeCode: VoiceBridgeCauseCode;
}

function diagnosticMessage(diagnostic: VoiceBridgeRequestDiagnostic): string {
	return `voice_bridge_request_failed ${JSON.stringify(diagnostic)}`;
}

export class BridgeVoiceRequestError extends Error {
	constructor(readonly diagnostic: VoiceBridgeRequestDiagnostic) {
		super(diagnosticMessage(diagnostic));
		this.name = "BridgeVoiceRequestError";
	}
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
		readonly diagnostic?: VoiceBridgeRequestDiagnostic,
	) {
		super(
			diagnostic
				? diagnosticMessage(diagnostic)
				: `voice_bridge_http_error status=${status}`,
		);
		this.name = "BridgeVoiceHttpError";
	}
}

class VoiceBridgeProtocolError extends Error {
	constructor(readonly causeCode: "invalid_json" | "invalid_response") {
		super("voice_bridge_protocol_invalid");
	}
}

class VoiceBridgeTimeoutError extends Error {
	constructor() {
		super("voice_bridge_request_timeout");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeDesired(value: unknown): { sessionId: string } | null {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 1 ||
		!("session" in value)
	) {
		throw new VoiceBridgeProtocolError("invalid_response");
	}
	if (value.session === null) return null;
	if (
		!isRecord(value.session) ||
		typeof value.session.sessionId !== "string" ||
		value.session.sessionId.trim() === ""
	) {
		throw new VoiceBridgeProtocolError("invalid_response");
	}
	return value.session as { sessionId: string };
}

function errorCode(error: unknown): unknown {
	if (!isRecord(error)) return undefined;
	if (typeof error.code === "string") return error.code;
	return isRecord(error.cause) && typeof error.cause.code === "string"
		? error.cause.code
		: undefined;
}

function transportFailure(
	error: unknown,
	phase: "headers" | "body",
): Pick<VoiceBridgeRequestDiagnostic, "reasonClass" | "causeCode"> {
	const code = errorCode(error);
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		return {
			reasonClass: "bridge_connect_failed",
			causeCode: "dns_failed",
		};
	}
	if (code === "ECONNREFUSED") {
		return {
			reasonClass: "bridge_connect_failed",
			causeCode: "connection_refused",
		};
	}
	if (code === "ECONNRESET") {
		return {
			reasonClass: "bridge_connect_failed",
			causeCode: "connection_reset",
		};
	}
	if (phase === "body") {
		return {
			reasonClass: "bridge_connect_failed",
			causeCode: "body_read_failed",
		};
	}
	if (error instanceof TypeError) {
		return {
			reasonClass: "bridge_connect_failed",
			causeCode: "fetch_failed",
		};
	}
	return { reasonClass: "unknown_failure", causeCode: "unknown_error" };
}

function httpFailure(
	status: number,
): Pick<VoiceBridgeRequestDiagnostic, "reasonClass" | "causeCode"> {
	if (status === 401) {
		return {
			reasonClass: "bridge_auth_rejected",
			causeCode: "http_401",
		};
	}
	if (status === 403) {
		return {
			reasonClass: "bridge_auth_rejected",
			causeCode: "http_403",
		};
	}
	return {
		reasonClass: "bridge_http_error",
		causeCode:
			status >= 500 ? "http_5xx" : status >= 400 ? "http_4xx" : "http_error",
	};
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new VoiceBridgeTimeoutError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new VoiceBridgeTimeoutError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
}

export class BridgeVoiceClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly httpTimeoutMs: number;
	private readonly idleHttpTimeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly monoNow: () => number;

	constructor(options: {
		baseUrl: string;
		token: string;
		httpTimeoutMs: number;
		idleHttpTimeoutMs?: number;
		fetchImpl?: typeof fetch;
		monoNow?: () => number;
	}) {
		this.baseUrl = validateVoiceBridgeUrl(options.baseUrl);
		this.token = options.token;
		this.httpTimeoutMs = options.httpTimeoutMs;
		this.idleHttpTimeoutMs = options.idleHttpTimeoutMs ?? options.httpTimeoutMs;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.monoNow = options.monoNow ?? performance.now.bind(performance);
	}

	async desired(): Promise<{ sessionId: string } | null> {
		return this.request("/api/voice/sessions/desired", {
			operation: "desired",
			routeTemplate: "/api/voice/sessions/desired",
			timeoutMs: this.idleHttpTimeoutMs,
			decode: decodeDesired,
		});
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
			operation: "claim",
			routeTemplate: "/api/voice/sessions/:sessionId/claim",
			method: "POST",
			body: { daemonBootId },
		});
		const lease = new VoiceLease(this.monoNow);
		lease.install(sentAt, body.leaseTtlMs, this.httpTimeoutMs);
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
		receiveHealth?: ReceiveHealth,
	): Promise<{ state: string; leaseExpiresAt: string }> {
		lease.assert();
		let sentAt = this.monoNow();
		let body: {
			state: string;
			leaseTtlMs: number;
			leaseExpiresAt: string;
		};
		try {
			body = await this.request(
				`/api/voice/sessions/${encodeURIComponent(sessionId)}/renew`,
				{
					operation: "renew",
					routeTemplate: "/api/voice/sessions/:sessionId/renew",
					method: "POST",
					leaseToken,
					...(receiveHealth ? { body: { receiveHealth } } : {}),
				},
			);
		} catch (error) {
			if (
				!receiveHealth ||
				!(error instanceof BridgeVoiceHttpError) ||
				error.status !== 400
			)
				throw error;
			console.warn("health_publish_failed");
			lease.assert();
			sentAt = this.monoNow();
			body = await this.request(
				`/api/voice/sessions/${encodeURIComponent(sessionId)}/renew`,
				{
					operation: "renew",
					routeTemplate: "/api/voice/sessions/:sessionId/renew",
					method: "POST",
					leaseToken,
				},
			);
		}
		lease.install(sentAt, body.leaseTtlMs, this.httpTimeoutMs);
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
			operation: "renew",
			routeTemplate: "/api/voice/sessions/:sessionId/renew",
			method: "POST",
			leaseToken,
		});
		const lease = new VoiceLease(this.monoNow);
		lease.install(sentAt, body.leaseTtlMs, this.httpTimeoutMs);
		return { state: body.state, leaseExpiresAt: body.leaseExpiresAt, lease };
	}

	/**
	 * FLY-2701: "in the room, model up" for a prewarmed meeting. The Bridge keeps
	 * the session warming and owns the decision to go live at the meeting time.
	 */
	async ready(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
		scheduleRevision: number | null,
	): Promise<void> {
		lease.assert();
		await this.request(
			`/api/voice/sessions/${encodeURIComponent(sessionId)}/ready`,
			{
				operation: "state",
				routeTemplate: "/api/voice/sessions/:sessionId/ready",
				method: "POST",
				leaseToken,
				body: { scheduleRevision },
			},
		);
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
				operation: "state",
				routeTemplate: "/api/voice/sessions/:sessionId/state",
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

	async context<T = Record<string, unknown>>(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
	): Promise<T> {
		lease.assert();
		return this.request<T>(
			`/api/voice/sessions/${encodeURIComponent(sessionId)}/context`,
			{
				operation: "context",
				routeTemplate: "/api/voice/sessions/:sessionId/context",
				leaseToken,
			},
		);
	}

	async recordUtterance(
		sessionId: string,
		leaseToken: string,
		lease: VoiceLease,
		input: Omit<VoiceUtterance, "sessionId" | "ts" | "interrupted"> & {
			captureDigest: string;
		},
	): Promise<{
		status: "inserted" | "replayed";
		receipt: {
			sessionId: string;
			transcriptId: string;
			contentDigest: string;
			receiptId: string;
		};
	}> {
		lease.assert();
		return this.request(
			`/api/voice/sessions/${encodeURIComponent(sessionId)}/utterances`,
			{
				operation: "utterance",
				routeTemplate: "/api/voice/sessions/:sessionId/utterances",
				method: "POST",
				leaseToken,
				body: input,
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
				{
					operation: "outbound",
					routeTemplate: "/api/voice/sessions/:sessionId/outbound",
					leaseToken,
				},
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
				{
					operation: "outbound",
					routeTemplate: "/api/voice/sessions/:sessionId/outbound/:seq/claim",
					method: "POST",
					leaseToken,
				},
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
				operation: "receipt",
				routeTemplate: "/api/voice/sessions/:sessionId/outbound/:seq/receipt",
				method: "POST",
				leaseToken,
				body: { attemptToken, status },
			},
		);
	}

	private async request<T = Record<string, unknown>>(
		path: string,
		options: {
			operation: VoiceBridgeOperation;
			routeTemplate: string;
			method?: "GET" | "POST";
			body?: unknown;
			leaseToken?: string;
			timeoutMs?: number;
			decode?: (value: unknown) => T;
		},
	): Promise<T> {
		const method = options.method ?? "GET";
		const timeoutMs = options.timeoutMs ?? this.httpTimeoutMs;
		const requestId = randomUUID();
		const startedAt = this.monoNow();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let phase: "headers" | "body" = "headers";
		let status: number | undefined;
		const diagnostic = (
			failure: Pick<VoiceBridgeRequestDiagnostic, "reasonClass" | "causeCode">,
		): VoiceBridgeRequestDiagnostic => ({
			operation: options.operation,
			method,
			routeTemplate: options.routeTemplate,
			requestId,
			elapsedMs: Math.max(0, Math.round(this.monoNow() - startedAt)),
			phase,
			...(status === undefined ? {} : { status }),
			timeoutMs,
			...failure,
		});
		try {
			const response = await waitForAbort(
				this.fetchImpl(`${this.baseUrl}${path}`, {
					method,
					signal: controller.signal,
					headers: {
						Authorization: `Bearer ${this.token}`,
						...(options.leaseToken
							? { "X-Voice-Lease": options.leaseToken }
							: {}),
						...(options.body === undefined
							? {}
							: { "Content-Type": "application/json" }),
					},
					...(options.body === undefined
						? {}
						: { body: JSON.stringify(options.body) }),
				}),
				controller.signal,
			);
			status = response.status;
			phase = "body";
			const text = await waitForAbort(response.text(), controller.signal);
			if (!response.ok) {
				const failure = httpFailure(response.status);
				throw new BridgeVoiceHttpError(
					response.status,
					failure.causeCode,
					diagnostic(failure),
				);
			}
			let body: unknown;
			try {
				body = JSON.parse(text) as unknown;
			} catch {
				throw new VoiceBridgeProtocolError("invalid_json");
			}
			return options.decode ? options.decode(body) : (body as T);
		} catch (error) {
			if (error instanceof BridgeVoiceHttpError) throw error;
			if (error instanceof VoiceBridgeProtocolError) {
				throw new BridgeVoiceRequestError(
					diagnostic({
						reasonClass: "bridge_protocol_invalid",
						causeCode: error.causeCode,
					}),
				);
			}
			if (
				error instanceof VoiceBridgeTimeoutError ||
				controller.signal.aborted
			) {
				throw new BridgeVoiceRequestError(
					diagnostic({
						reasonClass:
							phase === "headers"
								? "bridge_timeout_headers"
								: "bridge_timeout_body",
						causeCode: "request_timeout",
					}),
				);
			}
			throw new BridgeVoiceRequestError(
				diagnostic(transportFailure(error, phase)),
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
