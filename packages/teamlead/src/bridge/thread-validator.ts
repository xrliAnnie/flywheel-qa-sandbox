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

export type DiscordExistence =
	| { state: "confirmed" }
	| { state: "absent" }
	| { state: "transient"; status?: number }
	| { state: "denied"; status: 401 | 403 };

export interface DiscordExistenceDeps {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/** Side-effect-free exact probe used by FLY-1927's same-root replay path. */
export async function classifyThreadExistence(
	threadId: string,
	expectedParentId: string,
	botToken: string,
	deps: DiscordExistenceDeps = {},
): Promise<DiscordExistence> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
	try {
		const res = await (deps.fetchImpl ?? fetch)(
			`${DISCORD_API}/channels/${threadId}`,
			{
				headers: { Authorization: `Bot ${botToken}` },
				signal: controller.signal,
			},
		);
		if (res.status === 404) return { state: "absent" };
		if (res.status === 401 || res.status === 403) {
			return { state: "denied", status: res.status };
		}
		if (!res.ok) return { state: "transient", status: res.status };
		const data = (await res.json()) as { type?: number; parent_id?: string };
		const isThread = data.type === 10 || data.type === 11 || data.type === 12;
		return isThread && data.parent_id === expectedParentId
			? { state: "confirmed" }
			: { state: "absent" };
	} catch {
		return { state: "transient" };
	} finally {
		clearTimeout(timeout);
	}
}

/** Side-effect-free root-message probe paired with classifyThreadExistence. */
export async function classifyRootMessageExistence(
	channelId: string,
	rootMessageId: string,
	botToken: string,
	deps: DiscordExistenceDeps = {},
): Promise<
	Exclude<DiscordExistence, { state: "confirmed" }> | { state: "confirmed" }
> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
	try {
		const res = await (deps.fetchImpl ?? fetch)(
			`${DISCORD_API}/channels/${channelId}/messages/${rootMessageId}`,
			{
				headers: { Authorization: `Bot ${botToken}` },
				signal: controller.signal,
			},
		);
		if (res.status === 404) return { state: "absent" };
		if (res.status === 401 || res.status === 403) {
			return { state: "denied", status: res.status };
		}
		if (!res.ok) return { state: "transient", status: res.status };
		return { state: "confirmed" };
	} catch {
		return { state: "transient" };
	} finally {
		clearTimeout(timeout);
	}
}
