/**
 * GEO-200: Shared thread validation helper.
 * Verifies a Discord thread still exists before inheriting it.
 * Fail-open on all non-404 errors to avoid blocking session_started.
 */

const DISCORD_API = "https://discord.com/api/v10";

export interface ThreadValidationDeps {
	markDiscordMissing: (threadId: string) => void;
}

/**
 * Validate that a Discord thread still exists.
 * Returns true if valid (or on non-404 errors — fail-open).
 * Returns false and marks thread as missing on 404.
 */
export async function validateThreadExists(
	threadId: string,
	botToken: string,
	deps: ThreadValidationDeps,
): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		const res = await fetch(`${DISCORD_API}/channels/${threadId}`, {
			headers: { Authorization: `Bot ${botToken}` },
			signal: controller.signal,
		});
		if (res.status === 404) {
			deps.markDiscordMissing(threadId);
			return false;
		}
		return true; // fail-open for 429, 5xx, etc.
	} catch {
		return true; // fail-open on network/timeout error
	} finally {
		clearTimeout(timeout);
	}
}
