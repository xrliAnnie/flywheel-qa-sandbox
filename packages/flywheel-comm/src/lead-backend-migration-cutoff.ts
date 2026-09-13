/** One operator artifact, per Lead ruling c83ad949. Never a processing journal. */
export interface MigrationChannelCutoff {
	channelId: string;
	cutoffId: string | null;
	observedAt: string;
	lastBotReplyId: string | null;
	unresolvedMessageIds: string[];
	/** History older than this exclusive boundary remains for the new Lead to read. */
	unresolvedBefore: string | null;
}
export interface MigrationCutoffArtifact {
	version: 1;
	migrationId: "FLY-2459-honey-lemon";
	botUserId: string;
	writerStoppedAt: string;
	channels: MigrationChannelCutoff[];
}
interface DiscordMessage {
	id: string;
	author: { id: string };
}
const snowflake = (value: unknown): value is string =>
	typeof value === "string" && /^\d{17,20}$/.test(value);

/** Validate persisted evidence against the current canonical subscription identity. */
export function parseMigrationCutoffs(
	value: unknown,
	identity: { botUserId: string; channelIds: string[] },
): MigrationCutoffArtifact {
	const fail = (): never => {
		throw new Error("invalid migration cutoff artifact");
	};
	const record = (value: unknown, keys: string[]): Record<string, unknown> => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return fail();
		const row = value as Record<string, unknown>;
		if (
			Object.keys(row).length !== keys.length ||
			keys.some((key) => !Object.hasOwn(row, key))
		)
			return fail();
		return row;
	};
	const timestamp = (value: unknown): value is string =>
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value;
	const row = record(value, [
		"version",
		"migrationId",
		"botUserId",
		"writerStoppedAt",
		"channels",
	]);
	if (
		row.version !== 1 ||
		row.migrationId !== "FLY-2459-honey-lemon" ||
		!snowflake(row.botUserId) ||
		row.botUserId !== identity.botUserId ||
		!timestamp(row.writerStoppedAt) ||
		!Array.isArray(row.channels)
	)
		return fail();
	if (
		identity.channelIds.length < 1 ||
		identity.channelIds.length > 32 ||
		identity.channelIds.some((id) => !snowflake(id)) ||
		new Set(identity.channelIds).size !== identity.channelIds.length ||
		row.channels.length !== identity.channelIds.length
	)
		return fail();
	const seen = new Set<string>();
	for (const value of row.channels) {
		const channel = record(value, [
			"channelId",
			"cutoffId",
			"observedAt",
			"lastBotReplyId",
			"unresolvedMessageIds",
			"unresolvedBefore",
		]);
		if (
			!snowflake(channel.channelId) ||
			!identity.channelIds.includes(channel.channelId) ||
			seen.has(channel.channelId) ||
			!timestamp(channel.observedAt) ||
			channel.observedAt < row.writerStoppedAt
		)
			return fail();
		seen.add(channel.channelId);
		const { cutoffId, lastBotReplyId, unresolvedBefore, unresolvedMessageIds } =
			channel;
		if (
			(cutoffId !== null && !snowflake(cutoffId)) ||
			(lastBotReplyId !== null && !snowflake(lastBotReplyId)) ||
			(unresolvedBefore !== null && !snowflake(unresolvedBefore)) ||
			!Array.isArray(unresolvedMessageIds) ||
			unresolvedMessageIds.length > 1000 ||
			unresolvedMessageIds.some((id) => !snowflake(id))
		)
			return fail();
		if (cutoffId === null) {
			if (
				lastBotReplyId !== null ||
				unresolvedBefore !== null ||
				unresolvedMessageIds.length
			)
				return fail();
			continue;
		}
		if (
			lastBotReplyId !== null &&
			(BigInt(lastBotReplyId) > BigInt(cutoffId) || unresolvedBefore !== null)
		)
			return fail();
		let previous = lastBotReplyId === null ? 0n : BigInt(lastBotReplyId);
		for (const id of unresolvedMessageIds) {
			if (BigInt(id) <= previous || BigInt(id) > BigInt(cutoffId))
				return fail();
			previous = BigInt(id);
		}
		if (
			unresolvedBefore !== null &&
			unresolvedBefore !== unresolvedMessageIds[0]
		)
			return fail();
		if ((unresolvedMessageIds.at(-1) ?? lastBotReplyId) !== cutoffId)
			return fail();
	}
	return structuredClone(row) as unknown as MigrationCutoffArtifact;
}
async function boundedJson(response: Response): Promise<unknown> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`migration Discord HTTP ${response.status}`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing Discord response body");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			length += result.value.length;
			if (length > 1024 * 1024) throw new Error("Discord response too large");
			chunks.push(result.value);
		}
	} finally {
		await reader.cancel();
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("invalid Discord JSON");
	}
}
export async function collectMigrationCutoffs(input: {
	botToken: string;
	botUserId: string;
	channelIds: string[];
	assertStopped(): void;
	now?: () => string;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	maxPages?: number;
}): Promise<MigrationCutoffArtifact> {
	if (
		!input.botToken ||
		!snowflake(input.botUserId) ||
		input.channelIds.length === 0 ||
		input.channelIds.length > 32 ||
		input.channelIds.some((id) => !snowflake(id)) ||
		new Set(input.channelIds).size !== input.channelIds.length
	)
		throw new Error("invalid migration Discord identity");
	const maxPages = input.maxPages ?? 10;
	if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10)
		throw new Error("invalid cutoff page budget");
	input.assertStopped();
	const now = input.now ?? (() => new Date().toISOString());
	const writerStoppedAt = now();
	const request = input.fetch ?? fetch;
	const deadline = Date.now() + 30000;
	const channels: MigrationChannelCutoff[] = [];
	for (const channelId of input.channelIds) {
		const result: MigrationChannelCutoff = {
			channelId,
			cutoffId: null,
			observedAt: now(),
			lastBotReplyId: null,
			unresolvedMessageIds: [],
			unresolvedBefore: null,
		};
		let before: string | undefined;
		const seen = new Set<string>();
		for (let page = 0; page < maxPages; page++) {
			input.assertStopped();
			const remaining = deadline - Date.now();
			if (remaining <= 0)
				throw new Error("migration Discord collection timed out");
			const url = new URL(
				`https://discord.com/api/v10/channels/${channelId}/messages`,
			);
			url.searchParams.set("limit", "100");
			if (before) url.searchParams.set("before", before);
			const data = await boundedJson(
				await request(url.toString(), {
					headers: { Authorization: `Bot ${input.botToken}` },
					redirect: "error",
					signal: AbortSignal.timeout(Math.min(5000, remaining)),
				}),
			);
			if (
				!Array.isArray(data) ||
				data.length > 100 ||
				data.some(
					(row) =>
						!row ||
						!snowflake(row.id) ||
						!row.author ||
						!snowflake(row.author.id),
				)
			)
				throw new Error("invalid Discord message page");
			const messages = (data as DiscordMessage[]).sort((a, b) =>
				BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0,
			);
			if (page === 0) result.cutoffId = messages[0]?.id ?? null;
			for (const message of messages) {
				if (
					seen.has(message.id) ||
					(before && BigInt(message.id) >= BigInt(before))
				)
					throw new Error("Discord pagination did not advance");
				seen.add(message.id);
				if (message.author.id === input.botUserId) {
					result.lastBotReplyId = message.id;
					break;
				}
				result.unresolvedMessageIds.push(message.id);
			}
			if (result.lastBotReplyId || messages.length < 100) break;
			before = messages.at(-1)!.id;
			if (page === maxPages - 1) result.unresolvedBefore = before;
		}
		result.unresolvedMessageIds.sort((a, b) =>
			BigInt(a) < BigInt(b) ? -1 : 1,
		);
		channels.push(result);
	}
	input.assertStopped();
	return {
		version: 1,
		migrationId: "FLY-2459-honey-lemon",
		botUserId: input.botUserId,
		writerStoppedAt,
		channels,
	};
}
