/**
 * FLY-1435 semantics: Discord repurposed `auto_archive_duration` to control how
 * long an inactive thread remains in the client channel list. The server-side
 * `archived` flag follows a separate adaptive timer and is not an acceptance
 * signal. See engineering/doc/FLY-1435-native-autoarchive-rootcause/research.md.
 */
/** Values accepted by Discord for thread auto-archive duration. */
export const VALID_AUTO_ARCHIVE_MINUTES: ReadonlySet<number> = new Set([
	60, 1440, 4320, 10080,
]);

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

type BotTokenSource = string | (() => string[] | string | undefined);

export interface ChannelArchiveDefaultProviderOptions {
	channelId: string;
	botToken: BotTokenSource;
	fetchImpl?: typeof fetch;
	ttlMs?: number;
	now?: () => number;
	logger?: { warn: (message: string) => void };
}

/**
 * A live channel-default lookup failed before any usable value was cached.
 * Callers must distinguish this from a successful response whose field is
 * absent (`null`): unavailable is retryable; absent is a real configuration
 * state.
 */
export class ChannelArchiveDefaultUnavailableError extends Error {
	constructor(
		public readonly channelId: string,
		public readonly reason: string,
	) {
		super(`archive default unavailable for channel ${channelId}: ${reason}`);
		this.name = "ChannelArchiveDefaultUnavailableError";
	}
}

/**
 * Resolve a Discord channel default to a legal per-thread value. Call sites may
 * supply their existing behavior as `fallback` (for example alert threads use
 * 1440). Without an explicit legal fallback, an unresolved/invalid parent
 * policy returns null so a creator cannot silently persist Discord's 4320-minute
 * API default.
 */
export function resolveAutoArchiveMinutes(
	channelDefault: number | null | undefined,
	fallback?: number,
): number | null {
	return typeof channelDefault === "number" &&
		VALID_AUTO_ARCHIVE_MINUTES.has(channelDefault)
		? channelDefault
		: typeof fallback === "number" && VALID_AUTO_ARCHIVE_MINUTES.has(fallback)
			? fallback
			: null;
}

function resolveTokens(source: BotTokenSource): string[] {
	const raw = typeof source === "function" ? source() : source;
	const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
	return [
		...new Set(
			values
				.map((value) => value.trim())
				.filter((value): value is string => value.length > 0),
		),
	];
}

/**
 * Build a long-lived cached reader for a parent channel's archive default.
 * Permission failures fall through an ordered token chain; any failed refresh
 * returns stale data. A successful response with the field absent is cached as
 * null; a failed cold read rejects so callers cannot confuse "unconfigured"
 * with "unavailable" and silently create a thread with the wrong policy.
 */
export function makeChannelArchiveDefaultProvider(
	opts: ChannelArchiveDefaultProviderOptions,
): () => Promise<number | null> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	const ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_TTL_MS);
	const logger = opts.logger ?? {
		warn: (message: string) => console.warn(message),
	};
	let cached: { value: number | null; fetchedAtMs: number } | undefined;

	return async (): Promise<number | null> => {
		const startedAt = now();
		if (cached && startedAt - cached.fetchedAtMs < ttlMs) return cached.value;

		let failure = "no readable bot token";
		try {
			const tokens = resolveTokens(opts.botToken);
			for (const token of tokens) {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
				try {
					const response = await fetchImpl(
						`${DISCORD_API}/channels/${opts.channelId}`,
						{
							headers: { Authorization: `Bot ${token}` },
							signal: controller.signal,
						},
					);
					if (response.ok) {
						const body = (await response.json()) as {
							default_auto_archive_duration?: unknown;
						};
						// Discord omits this key when a channel has no configured
						// default. Normalize that real wire shape to null and cache it.
						const value =
							body.default_auto_archive_duration === undefined
								? null
								: body.default_auto_archive_duration;
						if (value !== null && typeof value !== "number") {
							failure = "malformed channel response";
							break;
						}
						cached = { value, fetchedAtMs: now() };
						return value;
					}
					if (
						response.status === 401 ||
						response.status === 403 ||
						response.status === 404
					) {
						failure = `HTTP ${response.status} for all candidate tokens`;
						continue;
					}
					failure = `HTTP ${response.status}`;
					break;
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error);
					break;
				} finally {
					clearTimeout(timer);
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}

		logger.warn(
			`[channel-archive-default] failed to read channel ${opts.channelId} (${failure}); ${cached ? "using stale value" : "no cached value available"}`,
		);
		if (cached) return cached.value;
		throw new ChannelArchiveDefaultUnavailableError(opts.channelId, failure);
	};
}
