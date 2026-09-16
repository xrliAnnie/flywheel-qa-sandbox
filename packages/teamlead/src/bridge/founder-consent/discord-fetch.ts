/**
 * FLY-175 Track 2 — Discord REST message fetch + role annotation (plan §7.2).
 *
 * Uses the Discord REST API with the bot token, NOT the Lead-side MCP
 * `fetch_messages` (Codex R1 HIGH-2). `fetch` is injectable for tests.
 */

export type MessageRole = "founder" | "lead" | "runner" | "other" | "bot";

export interface DiscordMessage {
	id: string;
	authorId: string;
	content: string;
	/** ISO 8601 timestamp. */
	ts: string;
	isBot: boolean;
}

export interface AnnotatedMessage extends DiscordMessage {
	role: MessageRole;
}

export type DiscordFetchErrorKind =
	| "auth" // 401/403 — bot token misconfigured
	| "not_found" // 404 — thread not found
	| "rate_limited" // 429
	| "upstream" // 5xx
	| "network"; // fetch threw / non-JSON

export class DiscordFetchError extends Error {
	constructor(
		readonly kind: DiscordFetchErrorKind,
		readonly status: number | null,
		message: string,
	) {
		super(message);
		this.name = "DiscordFetchError";
	}
}

/** Minimal fetch shape so tests can inject. */
export type FetchImpl = (
	url: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}>;

interface RawDiscordMessage {
	id: string;
	content: string;
	timestamp: string;
	author?: { id?: string; bot?: boolean };
}

export class DiscordFetcher {
	private readonly apiBase: string;

	constructor(
		private readonly botToken: string,
		private readonly fetchImpl: FetchImpl = globalThis.fetch as unknown as FetchImpl,
		apiBase = "https://discord.com/api/v10",
	) {
		this.apiBase = apiBase.replace(/\/+$/, "");
	}
	/** Read exact message ownership before emitting a reply reference. */
	async fetchMessage(
		threadId: string,
		messageId: string,
		options: { signal?: AbortSignal } = {},
	): Promise<DiscordMessage> {
		if (!/^\d{17,20}$/.test(threadId) || !/^\d{17,20}$/.test(messageId))
			throw new Error("invalid_discord_message_target");
		options.signal?.throwIfAborted();
		let response: Awaited<ReturnType<FetchImpl>>;
		try {
			response = await this.fetchImpl(
				`${this.apiBase}/channels/${threadId}/messages/${messageId}`,
				{
					method: "GET",
					headers: { Authorization: `Bot ${this.botToken}` },
					...(options.signal ? { signal: options.signal } : {}),
				},
			);
		} catch {
			throw new DiscordFetchError(
				"network",
				null,
				"Discord message fetch failed",
			);
		}
		if (!response.ok) {
			const status = response.status;
			throw new DiscordFetchError(
				status === 401 || status === 403
					? "auth"
					: status === 404
						? "not_found"
						: status === 429
							? "rate_limited"
							: "upstream",
				status,
				"Discord message unavailable",
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new DiscordFetchError(
				"network",
				response.status,
				"Discord message returned non-JSON",
			);
		}
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw new DiscordFetchError(
				"network",
				response.status,
				"Discord message invalid",
			);
		const data = body as RawDiscordMessage & { channel_id?: string };
		if (data.id !== messageId || data.channel_id !== threadId)
			throw new DiscordFetchError(
				"network",
				response.status,
				"Discord reply target mismatch",
			);
		if (
			typeof data.author?.id !== "string" ||
			!/^\d{17,20}$/.test(data.author.id) ||
			typeof data.content !== "string" ||
			typeof data.timestamp !== "string" ||
			!Number.isFinite(Date.parse(data.timestamp))
		)
			throw new DiscordFetchError(
				"network",
				response.status,
				"Discord message invalid",
			);
		return {
			id: data.id,
			authorId: data.author.id,
			content: data.content,
			ts: data.timestamp,
			isBot: Boolean(data.author.bot),
		};
	}

	/**
	 * Fetch the latest `limit` messages from a thread/channel, newest first.
	 * Throws `DiscordFetchError` (mapped per plan §9.2) on any non-200.
	 */
	async fetchThreadMessages(
		threadId: string,
		limit: number,
		options: { before?: string; signal?: AbortSignal } = {},
	): Promise<DiscordMessage[]> {
		if (options.before !== undefined && !/^[0-9]{1,20}$/.test(options.before))
			throw new Error("invalid_discord_cursor");
		const url = `${this.apiBase}/channels/${encodeURIComponent(
			threadId,
		)}/messages?limit=${Math.max(1, Math.min(100, limit))}${options.before !== undefined ? `&before=${options.before}` : ""}`;

		let res: Awaited<ReturnType<FetchImpl>>;
		try {
			res = await this.fetchImpl(url, {
				method: "GET",
				headers: { Authorization: `Bot ${this.botToken}` },
				...(options.signal ? { signal: options.signal } : {}),
			});
		} catch (err) {
			throw new DiscordFetchError(
				"network",
				null,
				`Discord fetch failed: ${(err as Error).message}`,
			);
		}

		if (!res.ok) {
			const s = res.status;
			if (s === 401 || s === 403) {
				throw new DiscordFetchError(
					"auth",
					s,
					"Discord bot token misconfigured (401/403)",
				);
			}
			if (s === 404) {
				throw new DiscordFetchError("not_found", s, "Discord thread not found");
			}
			if (s === 429) {
				throw new DiscordFetchError(
					"rate_limited",
					s,
					"Discord rate limited (429), retry later",
				);
			}
			throw new DiscordFetchError(
				"upstream",
				s,
				`Discord upstream error (${s})`,
			);
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch (err) {
			throw new DiscordFetchError(
				"network",
				res.status,
				`Discord returned non-JSON: ${(err as Error).message}`,
			);
		}
		if (!Array.isArray(body)) {
			throw new DiscordFetchError(
				"network",
				res.status,
				"Discord messages response was not an array",
			);
		}

		return (body as RawDiscordMessage[]).map((m) => ({
			id: String(m.id),
			authorId: String(m.author?.id ?? ""),
			content: typeof m.content === "string" ? m.content : "",
			ts: String(m.timestamp ?? ""),
			isBot: Boolean(m.author?.bot),
		}));
	}
}

export interface RoleAnnotationContext {
	founderUserId: string;
	/** Bot user ids of the project's Lead bots. */
	leadBotIds: ReadonlySet<string>;
	/** Bot user ids of known Runner bots (if tracked). */
	runnerBotIds: ReadonlySet<string>;
}

/**
 * Annotate every message with a role. Only `founder`-role messages may serve
 * as authorization evidence; lead/runner/other are context (plan §7.2).
 */
export function annotateRoles(
	messages: DiscordMessage[],
	ctx: RoleAnnotationContext,
): AnnotatedMessage[] {
	return messages.map((m) => {
		let role: MessageRole;
		if (m.authorId && m.authorId === ctx.founderUserId) {
			role = "founder";
		} else if (ctx.leadBotIds.has(m.authorId)) {
			role = "lead";
		} else if (
			ctx.runnerBotIds.has(m.authorId) ||
			/^\s*\[runner\]/i.test(m.content)
		) {
			role = "runner";
		} else if (m.isBot) {
			role = "bot";
		} else {
			role = "other";
		}
		return { ...m, role };
	});
}
