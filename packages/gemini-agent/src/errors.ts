/**
 * FLY-1018 error classification (plan §2.4) — status/code FIELDS, never
 * message regexes (the spike's regex classifier was a misfire risk).
 *
 * Error-as-message discipline (design principles 3/8): recoverable API
 * errors are retried WITH BOUNDS inside the client; once retries are
 * exhausted (or the error is fatal) the client throws ModelCallError and
 * the loop converts it into a Terminal that carries the ORIGINAL error —
 * nothing is swallowed. AbortedError is the caller-cancellation signal.
 */

export type ErrorKind =
	| "quota" // 429 / RESOURCE_EXHAUSTED
	| "server" // 5xx / UNAVAILABLE / INTERNAL
	| "network" // fetch TypeError / timeout abort
	| "validation" // 4xx (non-429, non-auth)
	| "auth" // 401 / 403
	| "unknown";

export class ModelCallError extends Error {
	readonly kind: ErrorKind;
	readonly httpStatus?: number;
	constructor(kind: ErrorKind, message: string, httpStatus?: number) {
		super(message);
		this.name = "ModelCallError";
		this.kind = kind;
		this.httpStatus = httpStatus;
	}
}

/** Caller-initiated cancellation — maps to Terminal reason "aborted". */
export class AbortedError extends Error {
	constructor(message = "aborted by caller") {
		super(message);
		this.name = "AbortedError";
	}
}

export interface Classification {
	kind: ErrorKind;
	httpStatus?: number;
	/** Retry policy: how many retries this class is allowed. */
	maxRetries: number;
}

function statusOf(err: unknown): number | undefined {
	const status = (err as { status?: unknown })?.status;
	if (typeof status === "number") return status;
	return undefined;
}

function codeOf(err: unknown): string | undefined {
	const code = (err as { code?: unknown })?.code;
	if (typeof code === "string") return code;
	return undefined;
}

/**
 * Classify a raw SDK/fetch error. Retry bounds per plan §2.4:
 * quota/server ≤3, network ≤1, validation/auth 0 (immediately fatal).
 */
export function classifyError(err: unknown): Classification {
	const status = statusOf(err);
	const code = codeOf(err);

	if (status === 429 || code === "RESOURCE_EXHAUSTED") {
		return { kind: "quota", httpStatus: status ?? 429, maxRetries: 3 };
	}
	if (
		(status !== undefined && status >= 500) ||
		code === "UNAVAILABLE" ||
		code === "INTERNAL"
	) {
		return { kind: "server", httpStatus: status, maxRetries: 3 };
	}
	if (status === 401 || status === 403) {
		return { kind: "auth", httpStatus: status, maxRetries: 0 };
	}
	if (status !== undefined && status >= 400) {
		return { kind: "validation", httpStatus: status, maxRetries: 0 };
	}
	// fetch network failure (TypeError) or a timeout abort surfaced as
	// AbortError/TimeoutError DOMException — one retry.
	const name = (err as { name?: unknown })?.name;
	if (
		err instanceof TypeError ||
		name === "AbortError" ||
		name === "TimeoutError"
	) {
		return { kind: "network", maxRetries: 1 };
	}
	return { kind: "unknown", maxRetries: 0 };
}

/**
 * Honor a retry-after hint when the error carries one (header field or
 * SDK-provided number, seconds or ms). Returns undefined when absent.
 */
export function retryAfterMsFrom(err: unknown): number | undefined {
	const anyErr = err as {
		retryAfterMs?: unknown;
		headers?: unknown;
	};
	if (typeof anyErr?.retryAfterMs === "number" && anyErr.retryAfterMs >= 0) {
		return anyErr.retryAfterMs;
	}
	const headers = anyErr?.headers;
	let raw: unknown;
	if (headers && typeof (headers as Headers).get === "function") {
		raw = (headers as Headers).get("retry-after");
	} else if (headers && typeof headers === "object") {
		raw = (headers as Record<string, unknown>)["retry-after"];
	}
	if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
		return Number(raw.trim()) * 1000;
	}
	return undefined;
}

/** Fixed backoff ladder when no retry-after hint: 2s / 4s / 8s. */
export const BACKOFF_MS = [2_000, 4_000, 8_000] as const;
