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

export interface VoiceRealtimeItem {
	role: "developer";
	text: string;
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
