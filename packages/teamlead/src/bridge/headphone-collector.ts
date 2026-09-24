import { extractSpeechBrief } from "flywheel-voice-core";
import { DISCORD_API } from "./discord-utils.js";
import type {
	HeadphoneInboxSourceState,
	HeadphoneInboxStore,
	HeadphoneInboxUpsertInput,
} from "./headphone-inbox.js";

export interface HeadphoneCollectorScope {
	projectName: string;
	founderUserId: string;
	channelId: string;
	allowedAuthorIds: readonly string[];
	token: string;
}

export interface HeadphoneCollectorMessage {
	id: string;
	authorId: string;
	content: string;
	timestamp: string;
	editedTimestamp?: string | null;
	needsDecision?: boolean;
	resolved?: boolean;
	embeds?: readonly {
		title?: string;
		description?: string;
		fields?: readonly { name: string; value: string }[];
	}[];
	components?: readonly { label?: string }[];
	attachments?: readonly { url: string; filename?: string }[];
}

export type HeadphoneCollectorFetchResult =
	| { kind: "page"; messages: readonly HeadphoneCollectorMessage[] }
	| { kind: "rate_limited"; retryAfterMs?: number }
	| { kind: "source_gap"; reason: string }
	| { kind: "unavailable"; reason: string };

function retryAfterMs(response: Response, body: unknown): number | undefined {
	const jsonValue =
		body && typeof body === "object"
			? (body as { retry_after?: unknown }).retry_after
			: undefined;
	const seconds =
		typeof jsonValue === "number"
			? jsonValue
			: Number(response.headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds > 0
		? Math.ceil(seconds * 1_000)
		: undefined;
}

/** Discord REST adapter kept outside the collector state machine for deterministic tests. */
export async function fetchDiscordHeadphonePage(
	input: {
		scope: HeadphoneCollectorScope;
		before?: string;
		after?: string;
		limit: 100;
	},
	fetchImpl: typeof fetch = fetch,
): Promise<HeadphoneCollectorFetchResult> {
	const query = new URLSearchParams({ limit: String(input.limit) });
	if (input.before) query.set("before", input.before);
	if (input.after) query.set("after", input.after);
	let response: Response;
	try {
		response = await fetchImpl(
			`${DISCORD_API}/channels/${input.scope.channelId}/messages?${query}`,
			{ headers: { Authorization: `Bot ${input.scope.token}` } },
		);
	} catch {
		return { kind: "unavailable", reason: "discord_network" };
	}
	if (response.status === 403 || response.status === 404)
		return {
			kind: "source_gap",
			reason: `discord_http_${response.status}`,
		};
	if (response.status === 429) {
		const body = await response.json().catch(() => undefined);
		return { kind: "rate_limited", retryAfterMs: retryAfterMs(response, body) };
	}
	if (!response.ok)
		return { kind: "unavailable", reason: `discord_http_${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { kind: "unavailable", reason: "discord_json_invalid" };
	}
	if (!Array.isArray(body))
		return { kind: "unavailable", reason: "discord_page_invalid" };
	const messages: HeadphoneCollectorMessage[] = [];
	for (const value of body) {
		if (!value || typeof value !== "object")
			return { kind: "unavailable", reason: "discord_message_invalid" };
		const message = value as Record<string, unknown>;
		const author = message.author as Record<string, unknown> | undefined;
		if (
			typeof message.id !== "string" ||
			typeof author?.id !== "string" ||
			typeof message.content !== "string" ||
			typeof message.timestamp !== "string" ||
			!Number.isFinite(Date.parse(message.timestamp))
		)
			return { kind: "unavailable", reason: "discord_message_invalid" };
		messages.push({
			id: message.id,
			authorId: author.id,
			content: message.content,
			timestamp: message.timestamp,
			editedTimestamp:
				typeof message.edited_timestamp === "string"
					? message.edited_timestamp
					: null,
			embeds: Array.isArray(message.embeds)
				? (message.embeds as HeadphoneCollectorMessage["embeds"])
				: [],
			components: Array.isArray(message.components)
				? (message.components as HeadphoneCollectorMessage["components"])
				: [],
			attachments: Array.isArray(message.attachments)
				? (message.attachments as HeadphoneCollectorMessage["attachments"])
				: [],
		});
	}
	return { kind: "page", messages };
}

export interface HeadphoneCollectorOptions {
	store: HeadphoneInboxStore;
	listScopes(): readonly HeadphoneCollectorScope[];
	fetchPage(input: {
		scope: HeadphoneCollectorScope;
		before?: string;
		after?: string;
		limit: 100;
	}): Promise<HeadphoneCollectorFetchResult>;
	classifyMessages?(
		scope: HeadphoneCollectorScope,
		messages: readonly HeadphoneCollectorMessage[],
	): ReadonlyMap<
		string,
		{
			questionId: string;
			needsDecision: boolean;
			resolved: boolean;
		}
	>;
	projectQuestions?(): void;
	now?: () => number;
	minimumPageIntervalMs?: number;
	notificationsPending?(): boolean;
}

export type HeadphoneCollectorTick =
	| "collected"
	| "waiting"
	| "idle"
	| "rate_limited"
	| "source_gap"
	| "unavailable";

function snowflakeCompare(left: string, right: string): number {
	return left.length - right.length || left.localeCompare(right);
}

function readableText(message: HeadphoneCollectorMessage): string {
	const parts = [message.content.trim()];
	for (const embed of message.embeds ?? []) {
		if (embed.title?.trim()) parts.push(embed.title.trim());
		if (embed.description?.trim()) parts.push(embed.description.trim());
		for (const field of embed.fields ?? []) {
			if (field.name.trim() || field.value.trim())
				parts.push(`${field.name.trim()}：${field.value.trim()}`);
		}
	}
	for (const component of message.components ?? []) {
		if (component.label?.trim()) parts.push(component.label.trim());
	}
	for (const attachment of message.attachments ?? []) {
		parts.push(
			`附件${attachment.filename ? ` ${attachment.filename}` : ""}：${attachment.url}`,
		);
	}
	return parts.filter(Boolean).join("\n");
}

function sourceTime(state: HeadphoneInboxSourceState | undefined): number {
	return state?.updatedAt ? Date.parse(state.updatedAt) : 0;
}

/** One shared-token page per tick. It runs independently of headphone mode and
 * advances a source cursor in the same transaction as every accepted item. */
export class HeadphoneInboxCollector {
	private readonly now: () => number;
	private readonly minimumPageIntervalMs: number;
	private nextPageAt = 0;
	private running?: Promise<HeadphoneCollectorTick>;

	constructor(private readonly options: HeadphoneCollectorOptions) {
		this.now = options.now ?? Date.now;
		this.minimumPageIntervalMs = options.minimumPageIntervalMs ?? 5_000;
	}

	tick(): Promise<HeadphoneCollectorTick> {
		if (this.running) return this.running;
		const running = this.run().finally(() => {
			if (this.running === running) this.running = undefined;
		});
		this.running = running;
		return running;
	}

	private async run(): Promise<HeadphoneCollectorTick> {
		this.options.projectQuestions?.();
		const nowMs = this.now();
		if (this.options.notificationsPending?.()) return "waiting";
		if (nowMs < this.nextPageAt) return "waiting";
		const scopes = this.options
			.listScopes()
			.filter(
				(scope) =>
					scope.projectName &&
					scope.founderUserId &&
					scope.channelId &&
					scope.token &&
					scope.allowedAuthorIds.length > 0,
			);
		if (scopes.length === 0) return "idle";
		const states = scopes.map((scope) => ({
			scope,
			state: this.options.store.getSourceState(
				scope.projectName,
				scope.founderUserId,
				scope.channelId,
			),
		}));
		const tokenNextAllowed = new Map<string, number>();
		for (const { scope, state } of states) {
			const next = state?.nextAllowedAt ? Date.parse(state.nextAllowedAt) : 0;
			tokenNextAllowed.set(
				scope.token,
				Math.max(tokenNextAllowed.get(scope.token) ?? 0, next),
			);
		}
		const candidates = states
			.filter(({ scope }) => (tokenNextAllowed.get(scope.token) ?? 0) <= nowMs)
			.sort(
				(left, right) =>
					sourceTime(left.state) - sourceTime(right.state) ||
					Number(left.state?.bootstrapComplete ?? false) -
						Number(right.state?.bootstrapComplete ?? false) ||
					left.scope.channelId.localeCompare(right.scope.channelId),
			);
		const candidate = candidates[0];
		if (!candidate) return "waiting";
		this.nextPageAt = nowMs + this.minimumPageIntervalMs;
		const bootstrap = !(candidate.state?.bootstrapComplete ?? false);
		const result = await this.options.fetchPage({
			scope: candidate.scope,
			...(bootstrap && candidate.state?.cursor
				? { before: candidate.state.cursor }
				: !bootstrap && candidate.state?.cursor
					? { after: candidate.state.cursor }
					: {}),
			limit: 100,
		});
		const updatedAt = new Date(nowMs).toISOString();
		if (result.kind === "rate_limited") {
			const retryAfterMs =
				result.retryAfterMs && result.retryAfterMs > 0
					? result.retryAfterMs
					: 30_000;
			this.nextPageAt = nowMs + retryAfterMs;
			this.options.store.setSourceState({
				projectName: candidate.scope.projectName,
				founderUserId: candidate.scope.founderUserId,
				channelId: candidate.scope.channelId,
				cursor: candidate.state?.cursor ?? undefined,
				highWatermark: candidate.state?.highWatermark ?? undefined,
				bootstrapComplete: candidate.state?.bootstrapComplete ?? false,
				health: "rate_limited",
				healthReason: "discord_rate_limited",
				nextAllowedAt: new Date(this.nextPageAt).toISOString(),
				updatedAt,
			});
			return "rate_limited";
		}
		if (result.kind !== "page") {
			this.options.store.setSourceState({
				projectName: candidate.scope.projectName,
				founderUserId: candidate.scope.founderUserId,
				channelId: candidate.scope.channelId,
				cursor: candidate.state?.cursor ?? undefined,
				highWatermark: candidate.state?.highWatermark ?? undefined,
				bootstrapComplete: candidate.state?.bootstrapComplete ?? false,
				health: result.kind === "source_gap" ? "source_gap" : "recovering",
				healthReason: result.reason,
				nextAllowedAt: new Date(this.nextPageAt).toISOString(),
				updatedAt,
			});
			return result.kind;
		}
		const ordered = [...result.messages].sort((left, right) =>
			snowflakeCompare(left.id, right.id),
		);
		const accepted: HeadphoneInboxUpsertInput[] = [];
		const allowed = new Set(candidate.scope.allowedAuthorIds);
		let authority:
			| ReturnType<NonNullable<HeadphoneCollectorOptions["classifyMessages"]>>
			| undefined;
		try {
			authority = this.options.classifyMessages?.(candidate.scope, ordered);
		} catch (error) {
			console.warn(
				`[headphone-inbox] message classification ignored for ${candidate.scope.projectName}/${candidate.scope.channelId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const message of ordered) {
			if (
				message.authorId === candidate.scope.founderUserId ||
				!allowed.has(message.authorId)
			)
				continue;
			const text = readableText(message);
			if (!text) continue;
			const question = authority?.get(message.id);
			accepted.push({
				...(question ? { questionId: question.questionId } : {}),
				projectName: candidate.scope.projectName,
				founderUserId: candidate.scope.founderUserId,
				channelId: candidate.scope.channelId,
				sourceMessageId: message.id,
				sourceRevision: message.editedTimestamp ?? message.id,
				authorId: message.authorId,
				needsDecision:
					question?.needsDecision ?? message.needsDecision ?? false,
				text,
				speechBrief: extractSpeechBrief({
					content: message.content,
					embeds: message.embeds,
				}),
				sourceCreatedAt: message.timestamp,
				sourceResolved: question?.resolved ?? message.resolved,
			});
		}
		const first = ordered[0]?.id;
		const last = ordered.at(-1)?.id;
		const highWatermark = bootstrap
			? [candidate.state?.highWatermark, last]
					.filter((value): value is string => !!value)
					.sort(snowflakeCompare)
					.at(-1)
			: candidate.state?.highWatermark;
		const bootstrapComplete = bootstrap && result.messages.length < 100;
		const cursor = bootstrap
			? bootstrapComplete
				? highWatermark
				: first
			: (last ?? candidate.state?.cursor);
		try {
			this.options.store.ingestPage({
				items: accepted,
				source: {
					projectName: candidate.scope.projectName,
					founderUserId: candidate.scope.founderUserId,
					channelId: candidate.scope.channelId,
					cursor: cursor ?? undefined,
					highWatermark: highWatermark ?? undefined,
					bootstrapComplete:
						(candidate.state?.bootstrapComplete ?? false) || bootstrapComplete,
					health: "healthy",
					nextAllowedAt: new Date(this.nextPageAt).toISOString(),
					updatedAt,
				},
			});
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.message !== "headphone_inbox_revision_conflict"
			)
				throw error;
			// Keep the cursor on the conflicting page for audit/recovery, but move
			// this source to the back of the fair rotation so one poisoned Discord
			// revision cannot starve every other channel.
			this.options.store.setSourceState({
				projectName: candidate.scope.projectName,
				founderUserId: candidate.scope.founderUserId,
				channelId: candidate.scope.channelId,
				cursor: candidate.state?.cursor ?? undefined,
				highWatermark: candidate.state?.highWatermark ?? undefined,
				bootstrapComplete: candidate.state?.bootstrapComplete ?? false,
				health: "recovering",
				healthReason: error.message,
				nextAllowedAt: new Date(this.nextPageAt).toISOString(),
				updatedAt,
			});
			return "unavailable";
		}
		return "collected";
	}
}
