import { createHash } from "node:crypto";

/**
 * FLY-2885 T8: the voice context snapshot shared by the Bridge (which builds
 * it) and the voice container (which re-verifies it before any realtime
 * session opens). Both sides compute the digest with this one module.
 */
export const VOICE_CONTEXT_VERSION = 2;
export const VOICE_CONTEXT_TOKENIZER = "js-tiktoken@1.0.21/o200k_base";
/** backing thread/start instructions (unchanged from v1). */
export const VOICE_BASE_MAX_BYTES = 128 * 1024;
export const VOICE_BASE_MAX_ESTIMATED_TOKENS = 32_768;
/** v3 realtime prompt: the server refuses more than 16,384 tokens (R3). */
export const VOICE_REALTIME_PROMPT_MAX_BYTES = 128 * 1024;
export const VOICE_REALTIME_PROMPT_MAX_TOKENS = 15_500;
/** Codex estimates bytes/4 and refuses >8,192 or >128 items (R3). */
export const VOICE_INITIAL_ITEMS_MAX_BYTES = 32_000;
export const VOICE_INITIAL_ITEMS_MAX_COUNT = 128;
/**
 * plan §12.3: past ~8,192 real o200k tokens the server silently drops every
 * item, so items are also held to Σ tokens + 8 per item ≤ 7,600.
 */
export const VOICE_INITIAL_ITEMS_MAX_TOKENS = 7_600;
/** plan §12.2: upper bound of the server's per-item wrapper (measured < 7.87). */
export const VOICE_INITIAL_ITEM_WRAPPER_TOKENS = 8;
/** plan §12.4: one memory segment per item, title and wrapper included. */
export const VOICE_MEMORY_SEGMENT_MAX_TOKENS = 2_000;
export const VOICE_MEMORY_SEGMENT_MAX_BYTES = 8_000;

export interface VoiceRealtimeItem {
	role: "developer";
	text: string;
}

/** plan §12.2: what the items cost the server, wrapper included. */
export function voiceInitialItemsTokens(itemTokens: readonly number[]): number {
	return itemTokens.reduce(
		(total, tokens) => total + tokens + VOICE_INITIAL_ITEM_WRAPPER_TOKENS,
		0,
	);
}

/** plan §12.5: context failures the Bridge reports with structured details. */
export const VOICE_CONTEXT_ERROR_REASONS = [
	"context_too_large",
	"context_token_count_unavailable",
	"context_stale",
	"context_source_unresolved",
	"context_state_unavailable",
] as const;
export type VoiceContextErrorReason =
	(typeof VOICE_CONTEXT_ERROR_REASONS)[number];

export function isVoiceContextErrorReason(
	value: unknown,
): value is VoiceContextErrorReason {
	return (VOICE_CONTEXT_ERROR_REASONS as readonly unknown[]).includes(value);
}

const VOICE_CONTEXT_ERROR_DETAIL_KEYS = [
	"block",
	"bytes",
	"estimatedTokens",
	"itemsTokens",
	"itemsCount",
	"maxBytes",
	"maxEstimatedTokens",
	"maxItemsTokens",
	"tokenizer",
] as const;
/** No "/" — a relative path is not an identifier. */
const SHORT_ASCII_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;

/**
 * plan §12.5: the only details that may leave the Bridge — whitelisted keys
 * holding a finite number or a short ASCII identifier (the tokenizer only as
 * this contract names it). Never text, paths or file contents.
 */
export function voiceContextErrorDetails(
	details: unknown,
): Record<string, number | string> {
	const safe: Record<string, number | string> = {};
	if (details === null || typeof details !== "object") return safe;
	for (const key of VOICE_CONTEXT_ERROR_DETAIL_KEYS) {
		const value = (details as Record<string, unknown>)[key];
		if (
			(typeof value === "number" && Number.isFinite(value)) ||
			(key === "tokenizer"
				? value === VOICE_CONTEXT_TOKENIZER
				: typeof value === "string" && SHORT_ASCII_IDENTIFIER.test(value))
		)
			safe[key] = value as number | string;
	}
	return safe;
}

/** Keys the Bridge adds to the source manifest; everything else is source. */
const DERIVED_MANIFEST_KEYS = new Set([
	"version",
	"sourceVersion",
	"capturedAt",
	"rosterDigest",
	"snapshotDigest",
	"leaseBindingDigest",
	"stateUnavailable",
	"meetingUnavailable",
	"tokenizer",
]);

/** Deterministic JSON: sorted keys, undefined dropped. */
export function voiceContextCanonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map(voiceContextCanonical).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => left.localeCompare(right));
	return `{${entries
		.map(
			([key, item]) => `${JSON.stringify(key)}:${voiceContextCanonical(item)}`,
		)
		.join(",")}}`;
}

export function voiceContextHeader(
	snapshotDigest: string,
	sessionId: string,
): string {
	return `[voice-context version=${VOICE_CONTEXT_VERSION} snapshotDigest=${snapshotDigest} sessionId=${sessionId}]`;
}

/**
 * The digest covers the unheaded bodies, the final items and the source
 * manifest as loaded — never anything derived from the digest itself.
 */
export function voiceContextDigest(input: {
	baseBody: string;
	realtimePromptBody: string;
	initialItems: readonly VoiceRealtimeItem[];
	leaseBindingDigest: string;
	sourceManifest: unknown;
	rosterDigest: string;
	sessionId: string;
}): string {
	return createHash("sha256")
		.update(
			voiceContextCanonical({
				baseBody: input.baseBody,
				realtimePromptBody: input.realtimePromptBody,
				initialItems: input.initialItems,
				leaseBindingDigest: input.leaseBindingDigest,
				sourceManifest: input.sourceManifest,
				rosterDigest: input.rosterDigest,
				sessionId: input.sessionId,
			}),
		)
		.digest("hex");
}

/** The source manifest exactly as loaded, recovered from a v2 manifest. */
export function voiceContextSourceManifest(
	manifest: Record<string, unknown>,
): Record<string, unknown> {
	const source: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(manifest))
		if (!DERIVED_MANIFEST_KEYS.has(key)) source[key] = value;
	source.version = manifest.sourceVersion;
	return source;
}
