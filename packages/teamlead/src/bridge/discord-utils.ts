/**
 * Shared Discord utilities used by standup-service and claude-discord-runtime.
 */

export const DISCORD_API = "https://discord.com/api/v10";
export const MAX_DISCORD_MESSAGE_LENGTH = 1900; // Discord limit is 2000, leave margin

/**
 * Split a message into chunks that fit within Discord's message length limit.
 * Splits at newline boundaries when possible.
 */
export function splitDiscordMessage(content: string): string[] {
	if (content.length <= MAX_DISCORD_MESSAGE_LENGTH) return [content];
	const chunks: string[] = [];
	let remaining = content;
	while (remaining.length > 0) {
		if (remaining.length <= MAX_DISCORD_MESSAGE_LENGTH) {
			chunks.push(remaining);
			break;
		}
		// Split at last newline within limit
		const cutoff = remaining.lastIndexOf("\n", MAX_DISCORD_MESSAGE_LENGTH);
		const splitAt = cutoff > 0 ? cutoff : MAX_DISCORD_MESSAGE_LENGTH;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}
	return chunks;
}
