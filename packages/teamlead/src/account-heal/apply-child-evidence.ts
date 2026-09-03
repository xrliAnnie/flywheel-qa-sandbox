import { Buffer } from "node:buffer";

export interface ApplyChildEvidence {
	exitCode: number | null;
	childStarted: boolean | null;
	detail: string;
}

export type ReconcileOutcome =
	| "already_consistent"
	| "repaired"
	| "no_credential"
	| "unresolvable"
	| "malformed"
	| "execution_failed";

export interface ReconcileMachineResult {
	ok: boolean;
	outcome: ReconcileOutcome;
	from?: string;
	to?: string;
	reason?: string;
	exitCode: number | null;
	detail: string;
}

const DEFAULT_MAX_BYTES = 600;

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const ellipsis = "…";
	const budget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
	if (budget < 0) return "";
	let result = "";
	for (const character of value) {
		if (Buffer.byteLength(result + character, "utf8") > budget) break;
		result += character;
	}
	return result + ellipsis;
}

export function redactSecrets(text: string): string {
	return text
		.replace(/sk-ant-[A-Za-z0-9_-]{8,}/gi, "<redacted>")
		.replace(/Bearer\s+\S+/gi, "<redacted>")
		.replace(
			/"?(?:accessToken|refreshToken|access_token|refresh_token)"?\s*[:=]\s*"?[^"\s,]+"?/gi,
			"<redacted>",
		)
		.replace(/(?:token|secret|password)=\S+/gi, "<redacted>")
		.replace(/\p{Cc}/gu, "");
}

export function summarizeApplyFailure(
	rawStderr: string,
	fallbackMessage?: string,
	maxBytes = DEFAULT_MAX_BYTES,
): string {
	const kept: string[] = [];
	let errorKept = false;
	for (const line of rawStderr.split(/\r?\n/)) {
		if (/^FLYWHEEL_[A-Z_]+(?:\b|$)/.test(line)) {
			kept.push(line);
			continue;
		}
		if (!errorKept && line.startsWith("Error:")) {
			kept.push(line);
			errorKept = true;
		}
	}
	const selected =
		kept.length > 0
			? kept.join(" | ")
			: fallbackMessage
				? `Error: ${fallbackMessage}`
				: "";
	return truncateUtf8(redactSecrets(selected), maxBytes);
}

export function formatFailureDetail(
	prefix: string,
	sanitizedDetail: string,
	maxBytes = DEFAULT_MAX_BYTES,
): string {
	return truncateUtf8(`${prefix}${sanitizedDetail}`, maxBytes);
}

export function childEvidenceFromError(
	error: unknown,
	stderr: string,
): ApplyChildEvidence {
	const value =
		typeof error === "object" && error !== null
			? (error as {
					code?: unknown;
					message?: unknown;
					profileChildStarted?: unknown;
				})
			: undefined;
	return {
		exitCode:
			typeof value?.code === "number" && Number.isInteger(value.code)
				? value.code
				: null,
		childStarted:
			typeof value?.profileChildStarted === "boolean"
				? value.profileChildStarted
				: null,
		detail: summarizeApplyFailure(
			stderr,
			typeof value?.message === "string" ? value.message : undefined,
		),
	};
}
