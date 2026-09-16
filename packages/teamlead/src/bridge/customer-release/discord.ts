import { isDeepStrictEqual } from "node:util";
import { canAccessReleaseChannel } from "./access.js";
import type { ReleaseInteractionTarget } from "./actions.js";
import {
	assertReleaseMessageExtras,
	type releaseCard,
	releaseMessageDigest,
} from "./cards.js";
import type { ManualReleaseDelivery } from "./manual.js";
import { isDiscordId } from "./notice.js";

function valid(value: unknown): asserts value {
	if (!value) throw new Error("customer release Discord evidence unavailable");
}
function object(value: unknown): Record<string, unknown> {
	valid(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}
interface Options {
	token: string;
	target: () => ReleaseInteractionTarget;
	healthy: () => boolean;
	now: () => number;
	fetch?: typeof fetch;
}
/** Dedicated bot REST transport. Callers persist a send intent before invoking
 * send; this class never retries POSTs or interprets a timeout as non-delivery. */
export class ReleaseDiscordClient {
	private readonly fetcher: typeof fetch;
	constructor(private readonly options: Options) {
		valid(options.token && !/[\r\n]/.test(options.token));
		this.fetcher = options.fetch ?? fetch;
	}
	private target(): ReleaseInteractionTarget {
		const target = { ...this.options.target() };
		valid(
			[
				target.applicationId,
				target.botUserId,
				target.channelId,
				target.guildId,
				target.founderId,
			].every(isDiscordId) &&
				Number.isSafeInteger(target.epoch) &&
				target.epoch > 0 &&
				this.options.healthy(),
		);
		return target;
	}
	private same(target: ReleaseInteractionTarget) {
		valid(
			this.options.healthy() &&
				isDeepStrictEqual(target, this.options.target()),
		);
	}
	private async request(
		path: string,
		signal?: AbortSignal,
		body?: unknown,
	): Promise<unknown> {
		const response = await this.fetcher(`https://discord.com/api/v10${path}`, {
			method: body === undefined ? "GET" : "POST",
			redirect: "error",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(15000)])
				: AbortSignal.timeout(15000),
			headers: {
				authorization: `Bot ${this.options.token}`,
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (response.status !== 200 || response.redirected) {
			await response.body?.cancel();
			throw new Error("customer release Discord request failed");
		}
		valid(response.body);
		const reader = response.body.getReader(),
			chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > 512 * 1024) {
					await reader.cancel();
					throw new Error("customer release Discord response oversized");
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
	}
	private async access(target: ReleaseInteractionTarget, signal?: AbortSignal) {
		const results = await Promise.allSettled([
			this.request("/users/@me", signal),
			this.request("/applications/@me", signal),
			this.request(`/guilds/${target.guildId}`, signal),
			this.request(`/guilds/${target.guildId}/roles`, signal),
			this.request(
				`/guilds/${target.guildId}/members/${target.founderId}`,
				signal,
			),
			this.request(
				`/guilds/${target.guildId}/members/${target.botUserId}`,
				signal,
			),
			this.request(`/channels/${target.channelId}`, signal),
		]);
		valid(results.every((result) => result.status === "fulfilled"));
		const [user, app, guild, roles, member, bot, channel] = results.map(
			(result) => (result as PromiseFulfilledResult<unknown>).value,
		);
		valid(
			object(user).id === target.botUserId &&
				object(user).bot === true &&
				object(app).id === target.applicationId &&
				!object(app).interactions_endpoint_url,
		);
		const common = {
			guild,
			roles,
			channel,
			guildId: target.guildId,
			channelId: target.channelId,
			now: this.options.now(),
		};
		valid(
			canAccessReleaseChannel({
				...common,
				member,
				userId: target.founderId,
			}) &&
				canAccessReleaseChannel(
					{ ...common, member: bot, userId: target.botUserId },
					true,
				),
		);
		this.same(target);
	}
	private message(value: unknown, target: ReleaseInteractionTarget) {
		const message = object(value),
			author = object(message.author);
		valid(
			isDiscordId(message.id) &&
				message.channel_id === target.channelId &&
				author.id === target.botUserId &&
				author.bot === true &&
				!message.webhook_id &&
				message.type === 0 &&
				(message.application_id === undefined ||
					message.application_id === target.applicationId),
		);
		assertReleaseMessageExtras(message);
		return message;
	}
	async send(
		card: ReturnType<typeof releaseCard>,
		nonce: string,
		signal?: AbortSignal,
	): Promise<string> {
		const target = this.target();
		valid(/^[a-f0-9]{32}$/.test(nonce));
		releaseMessageDigest(card);
		valid(
			card.components[0]?.components[0]?.custom_id.endsWith(
				`:${target.epoch}:${nonce}`,
			),
		);
		await this.access(target, signal);
		this.same(target);
		signal?.throwIfAborted();
		const message = this.message(
			await this.request(`/channels/${target.channelId}/messages`, signal, {
				...card,
				allowed_mentions: { parse: [] },
				nonce: BigInt(`0x${nonce}`).toString(36),
				enforce_nonce: true,
			}),
			target,
		);
		this.same(target);
		valid(releaseMessageDigest(message) === releaseMessageDigest(card));
		return message.id as string;
	}
	async verifyMessage(
		messageId: string,
		messageDigest: string,
		signal?: AbortSignal,
	): Promise<ManualReleaseDelivery> {
		const target = this.target(),
			started = this.options.now();
		valid(isDiscordId(messageId) && /^[a-f0-9]{64}$/.test(messageDigest));
		await this.access(target, signal);
		const message = this.message(
			await this.request(
				`/channels/${target.channelId}/messages/${messageId}`,
				signal,
			),
			target,
		);
		valid(
			message.id === messageId &&
				releaseMessageDigest(message) === messageDigest,
		);
		this.same(target);
		const now = this.options.now();
		valid(
			Number.isSafeInteger(started) &&
				started >= 0 &&
				now >= started &&
				now - started <= 30000,
		);
		return {
			messageId,
			messageDigest,
			channelId: target.channelId,
			applicationId: target.applicationId,
			botUserId: target.botUserId,
			founderId: target.founderId,
			verifiedAt: started,
			accessVerified: true,
			gatewayHealthy: true,
		};
	}
	/** Bounded complete scan back to the first possible send. A missing/ambiguous
	 * marker gives no authority to POST again. Full message verification follows. */
	async findMessage(
		nonce: string,
		since: number,
		signal?: AbortSignal,
	): Promise<string | null> {
		const target = this.target();
		valid(
			/^[a-f0-9]{32}$/.test(nonce) && Number.isSafeInteger(since) && since >= 0,
		);
		let before: string | null = null,
			found: string | null = null;
		const seen = new Set<string>();
		for (let page = 0; page < 10; page++) {
			const rows = await this.request(
				`/channels/${target.channelId}/messages?limit=100${before ? `&before=${before}` : ""}`,
				signal,
			);
			valid(Array.isArray(rows) && rows.length <= 100);
			let reached = false;
			for (const value of rows) {
				const row = object(value);
				valid(
					isDiscordId(row.id) &&
						!seen.has(row.id) &&
						(before === null || BigInt(row.id) < BigInt(before)),
				);
				seen.add(row.id);
				before = row.id;
				valid(typeof row.timestamp === "string");
				const timestamp = Date.parse(row.timestamp);
				valid(Number.isFinite(timestamp));
				if (timestamp < since - 5000) {
					reached = true;
					break;
				}
				const author = object(row.author);
				if (author.id !== target.botUserId) continue;
				const components = row.components;
				const marker =
					Array.isArray(components) &&
					components.some((item) => {
						const component = object(item);
						return (
							Array.isArray(component.components) &&
							component.components.some((value) => {
								const button = object(value);
								return (
									typeof button.custom_id === "string" &&
									button.custom_id.endsWith(`:${nonce}`)
								);
							})
						);
					});
				if (marker || row.nonce === BigInt(`0x${nonce}`).toString(36)) {
					valid(found === null);
					found = row.id;
				}
			}
			this.same(target);
			if (reached || rows.length < 100) return found;
		}
		throw new Error("customer release Discord history truncated");
	}
}
