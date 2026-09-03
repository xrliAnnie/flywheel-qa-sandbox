export interface InfraDiscordIdentity {
	botToken: string;
	guildId: string;
}

export interface DiscordActiveThread {
	id: string;
	parent_id: string;
	owner_id?: string;
	last_message_id?: string | null;
	thread_metadata?: {
		archived?: boolean;
		archive_timestamp?: string | null;
		auto_archive_duration?: number;
		locked?: boolean;
	};
}

export type ListActiveThreadsResult =
	| { ok: true; threads: DiscordActiveThread[] }
	| { ok: false; status?: number; retryAfterMs?: number; error: string };

const DISCORD_EPOCH_MS = 1_420_070_400_000;

export function resolveInfraDiscordIdentity(
	env: NodeJS.ProcessEnv = process.env,
): InfraDiscordIdentity | null {
	const botToken = env.CLAUDE_INFRA_BOT_TOKEN?.trim();
	const guildId =
		env.DISCORD_GUILD_ID?.trim() || env.FLYWHEEL_ROUNDTABLE_GUILD_ID?.trim();
	return botToken && guildId ? { botToken, guildId } : null;
}

export function isDiscordSnowflake(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{17,20}$/.test(value)) return false;
	try {
		return BigInt(value) > 0n;
	} catch {
		return false;
	}
}

export function snowflakeToMs(value: unknown): number | null {
	if (!isDiscordSnowflake(value)) return null;
	const timestamp = Number((BigInt(value) >> 22n) + BigInt(DISCORD_EPOCH_MS));
	return Number.isFinite(timestamp) ? timestamp : null;
}

export function lastActivityMs(thread: DiscordActiveThread): number | null {
	const messageAt = snowflakeToMs(thread.last_message_id);
	if (messageAt === null) return null;
	const archiveAt = Date.parse(thread.thread_metadata?.archive_timestamp ?? "");
	return Number.isFinite(archiveAt)
		? Math.max(messageAt, archiveAt)
		: messageAt;
}

function isActiveThread(value: unknown): value is DiscordActiveThread {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<DiscordActiveThread>;
	return (
		isDiscordSnowflake(candidate.id) && typeof candidate.parent_id === "string"
	);
}

function retryAfterMs(response: Response, body: unknown): number | undefined {
	const header = response.headers.get("retry-after");
	const headerSeconds = header === null ? Number.NaN : Number(header);
	const bodyValue = (body as { retry_after?: unknown } | null)?.retry_after;
	const bodySeconds =
		typeof bodyValue === "number" || typeof bodyValue === "string"
			? Number(bodyValue)
			: Number.NaN;
	const seconds = Number.isFinite(headerSeconds) ? headerSeconds : bodySeconds;
	return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

export async function listGuildActiveThreads(
	identity: InfraDiscordIdentity,
	opts: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<ListActiveThreadsResult> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	opts.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, opts.timeoutMs ?? 5_000);
	try {
		const response = await (opts.fetchImpl ?? fetch)(
			`https://discord.com/api/v10/guilds/${identity.guildId}/threads/active`,
			{
				headers: { Authorization: `Bot ${identity.botToken}` },
				signal: controller.signal,
			},
		);
		const body = await response.json().catch(() => undefined);
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				...(response.status === 429
					? { retryAfterMs: retryAfterMs(response, body) }
					: {}),
				error: `Discord ${response.status}`,
			};
		}
		const threads = (body as { threads?: unknown } | undefined)?.threads;
		if (!Array.isArray(threads)) {
			return {
				ok: false,
				error: "Discord active-thread response is malformed",
			};
		}
		return { ok: true, threads: threads.filter(isActiveThread) };
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error && error.name === "AbortError"
					? "timeout"
					: error instanceof Error
						? error.message
						: String(error),
		};
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", abort);
	}
}
