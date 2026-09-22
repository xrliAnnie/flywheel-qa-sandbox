export const RECEIVE_STATES = ["unknown", "receiving", "degraded"] as const;
export type ReceiveState = (typeof RECEIVE_STATES)[number];

export const RECEIVE_REASONS = [
	"awaiting_audio",
	"dave_decrypt",
	"opus_decode",
	"receive_packet",
	"receive_no_pcm",
	"retry_exhausted",
	"audio_observed",
] as const;
export type ReceiveReason = (typeof RECEIVE_REASONS)[number];

export interface ReceiveHealth {
	version: 1;
	sequence: number;
	state: ReceiveState;
	reason: ReceiveReason;
	failures: number;
	retries: number;
	lastPcmAt: string | null;
}

const FIELDS = new Set([
	"version",
	"sequence",
	"state",
	"reason",
	"failures",
	"retries",
	"lastPcmAt",
]);

function isBoundedInteger(value: unknown, minimum: number): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
	);
}

function invalid(): never {
	throw new Error("invalid_receive_health");
}

export function parseReceiveHealth(value: unknown): ReceiveHealth {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== FIELDS.size ||
		Object.keys(record).some((key) => !FIELDS.has(key)) ||
		record.version !== 1 ||
		!isBoundedInteger(record.sequence, 1) ||
		!RECEIVE_STATES.includes(record.state as ReceiveState) ||
		!RECEIVE_REASONS.includes(record.reason as ReceiveReason) ||
		!isBoundedInteger(record.failures, 0) ||
		!isBoundedInteger(record.retries, 0) ||
		(record.lastPcmAt !== null &&
			(typeof record.lastPcmAt !== "string" ||
				!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(
					record.lastPcmAt,
				) ||
				!Number.isFinite(Date.parse(record.lastPcmAt))))
	) {
		invalid();
	}
	return {
		version: 1,
		sequence: record.sequence,
		state: record.state as ReceiveState,
		reason: record.reason as ReceiveReason,
		failures: record.failures,
		retries: record.retries,
		lastPcmAt: record.lastPcmAt,
	};
}
