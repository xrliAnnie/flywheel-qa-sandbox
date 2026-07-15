export const AUTOMATED_MESSAGE_PREFIX = "🤖[自动] ";

export type DiscordMessageOrigin = "lead_authored" | "automation";

/**
 * Mark system-generated Discord text without ever double-marking retries,
 * edits, or already-materialized founder-action ledger payloads.
 */
export function markAutomatedDiscordText(text: string): string {
	return text.startsWith(AUTOMATED_MESSAGE_PREFIX)
		? text
		: `${AUTOMATED_MESSAGE_PREFIX}${text}`;
}
