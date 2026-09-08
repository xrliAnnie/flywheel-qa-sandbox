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

export type ThreadParentLookup =
	| { state: "resolved"; parentId: string }
	| { state: "not_thread" }
	| { state: "absent" }
	| { state: "transient"; status?: number }
	| { state: "denied"; status: 401 | 403 };

/** Resolve a Discord thread's parent for fail-closed channel authorization. */
export async function lookupThreadParent(
	channelId: string,
	botToken: string,
	deps: DiscordExistenceDeps = {},
): Promise<ThreadParentLookup> {
	try {
		const res = await (deps.fetchImpl ?? fetch)(
			`${DISCORD_API}/channels/${channelId}`,
			{
				headers: { Authorization: `Bot ${botToken}` },
				signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
			},
		);
		if (res.status === 404) return { state: "absent" };
		if (res.status === 401 || res.status === 403) {
			return { state: "denied", status: res.status };
		}
		if (!res.ok) return { state: "transient", status: res.status };
		const data = (await res.json()) as { type?: number; parent_id?: string };
		const isThread = data.type === 10 || data.type === 11 || data.type === 12;
		return isThread && typeof data.parent_id === "string"
			? { state: "resolved", parentId: data.parent_id }
			: { state: "not_thread" };
	} catch {
		return { state: "transient" };
	}
}

/** Side-effect-free exact probe used by FLY-1927's same-root replay path. */
export async function classifyThreadExistence(
	threadId: string,
	expectedParentId: string,
	botToken: string,
	deps: DiscordExistenceDeps = {},
): Promise<DiscordExistence> {
	const result = await lookupThreadParent(threadId, botToken, deps);
	if (result.state === "resolved") {
		return result.parentId === expectedParentId
			? { state: "confirmed" }
			: { state: "absent" };
	}
	if (result.state === "denied" || result.state === "transient") return result;
	return { state: "absent" };
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
