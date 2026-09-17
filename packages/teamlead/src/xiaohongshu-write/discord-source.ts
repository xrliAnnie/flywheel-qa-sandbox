import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReviewTransport } from "./cards.js";
import type { FounderSource } from "./observer.js";
import type { ReviewFile } from "./preview.js";

const id = z.string().regex(/^[1-9][0-9]{16,19}$/);
const attachmentSchema = z.object({
	id,
	url: z.string(),
	filename: z.string(),
	size: z
		.number()
		.int()
		.positive()
		.max(10 * 1024 * 1024),
});
const messageSchema = z
	.object({
		id,
		channel_id: id,
		attachments: z.array(attachmentSchema).max(10).optional(),
	})
	.passthrough();
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** Holds the dedicated bot token in authority memory, never in a broker response. */
export class DiscordXhsSource implements FounderSource, ReviewTransport {
	readonly #token: string;
	private readonly sentIds = new Set<string>();
	private readonly fetcher: Fetch;
	private readonly channelId: string;
	private readonly probe: boolean;
	private readonly urls = new Map<string, { url: string; size: number }>();
	constructor(options: {
		channelId: string;
		token: string;
		fetch?: Fetch;
		purpose?: "review" | "probe";
	}) {
		this.probe = options.purpose === "probe";
		this.channelId = id.parse(options.channelId);
		if (!options.token || /[\r\n]/.test(options.token))
			throw Error("founder_source_unavailable");
		this.#token = options.token;
		this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
	}
	private channel(channelId: string): void {
		if (channelId !== this.channelId) throw Error("founder_source_unavailable");
	}
	private async bytes(
		url: string,
		max: number,
		authenticated: boolean,
		method: "GET" | "POST" | "DELETE" = "GET",
		body?: FormData,
	): Promise<Buffer> {
		const response = await this.fetcher(url, {
			method,
			...(body ? { body } : {}),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
			...(authenticated
				? { headers: { Authorization: `Bot ${this.#token}` } }
				: {}),
		});
		if (method === "DELETE" && response.status === 204) return Buffer.alloc(0);
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw Error();
		}
		const declared = response.headers.get("content-length");
		if (
			declared !== null &&
			(!/^\d+$/.test(declared) || Number(declared) > max)
		) {
			await response.body.cancel();
			throw Error();
		}
		const reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let size = 0;
		try {
			for (;;) {
				const result = await reader.read();
				if (result.done) break;
				size += result.value.byteLength;
				if (size > max) throw Error();
				chunks.push(Buffer.from(result.value));
			}
		} catch (error) {
			await reader.cancel();
			throw error;
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks, size);
	}
	private async api(path: string): Promise<unknown> {
		return JSON.parse(
			(
				await this.bytes(`https://discord.com/api/v10${path}`, 512 * 1024, true)
			).toString("utf8"),
		);
	}
	/** Read-only preflight; empty history or bot-authored content cannot prove this capability. */
	async preflight(expected: {
		botId: string;
		guildId: string;
		founderId: string;
	}): Promise<void> {
		try {
			for (const value of Object.values(expected)) id.parse(value);
			const self = z
				.object({ id, bot: z.literal(true) })
				.parse(await this.api("/users/@me"));
			if (self.id !== expected.botId) throw Error();
			const app = z
				.object({ flags: z.number().int().nonnegative().safe() })
				.parse(await this.api("/applications/@me"));
			if ((BigInt(app.flags) & ((1n << 18n) | (1n << 19n))) === 0n)
				throw Error();
			if ((await this.channelGuild(this.channelId)) !== expected.guildId)
				throw Error();
			const bytes = await this.bytes(
				`https://discord.com/api/v10/channels/${this.channelId}/messages?limit=100`,
				8 * 1024 * 1024,
				true,
			);
			const page = z
				.array(z.unknown())
				.max(100)
				.parse(JSON.parse(bytes.toString("utf8")));
			const probe = z.object({
				id,
				channel_id: id,
				type: z.literal(0),
				author: z.object({ id, bot: z.literal(false).optional() }),
				content: z.string().min(1),
				mentions: z.array(z.object({ id })),
				webhook_id: z.never().optional(),
				message_snapshots: z.never().optional(),
			});
			if (
				!page.some((raw) => {
					const result = probe.safeParse(raw);
					return (
						result.success &&
						result.data.channel_id === this.channelId &&
						result.data.author.id === expected.founderId &&
						result.data.content.trim().length > 0 &&
						!result.data.mentions.some((mention) => mention.id === self.id)
					);
				})
			)
				throw Error();
		} catch {
			throw Error("founder_source_unavailable");
		}
	}

	async listMessageIdsBefore(before: string | null): Promise<string[]> {
		try {
			if (before !== null) id.parse(before);
			const query = `?limit=100${before === null ? "" : `&before=${before}`}`;
			const bytes = await this.bytes(
				`https://discord.com/api/v10/channels/${this.channelId}/messages${query}`,
				8 * 1024 * 1024,
				true,
			);
			const messages = z
				.array(z.object({ id, channel_id: id }))
				.max(100)
				.parse(JSON.parse(bytes.toString("utf8")));
			if (messages.some((message) => message.channel_id !== this.channelId))
				throw Error();
			return messages.map((message) => message.id);
		} catch {
			throw Error("founder_source_unavailable");
		}
	}
	async notify(eventId: string, content: string): Promise<void> {
		if (!eventId || eventId.length > 256)
			throw Error("notification_delivery_failed");
		const nonce = createHash("sha256")
			.update(eventId)
			.digest("hex")
			.slice(0, 25);
		try {
			await this.post(content, [], { parse: [] }, nonce);
		} catch {
			throw Error("notification_delivery_failed");
		}
	}
	async send(
		content: string,
		files: ReviewFile[],
		allowedMentions: { parse: never[] },
	): Promise<string> {
		return this.post(content, files, allowedMentions);
	}
	private async post(
		content: string,
		files: ReviewFile[],
		allowedMentions: { parse: never[] },
		nonce?: string,
	): Promise<string> {
		try {
			if (
				typeof content !== "string" ||
				content.length > 2000 ||
				!Array.isArray(files) ||
				files.length > 10 ||
				!Array.isArray(allowedMentions.parse) ||
				allowedMentions.parse.length
			)
				throw Error();
			if (
				this.probe &&
				(nonce !== undefined ||
					files.length !== 1 ||
					files[0]?.bytes.length !== 10 * 1024 * 1024)
			)
				throw Error();
			if (
				files.some(
					(file) =>
						!(this.probe
							? file.name === "xhs-attachment-probe.bin"
							: /^(review\.txt|media-[1-9][0-9]*\.(png|jpg|webp|mp4))$/.test(
									file.name,
								)) ||
						!Buffer.isBuffer(file.bytes) ||
						file.bytes.length > 10 * 1024 * 1024,
				) ||
				files.reduce((sum, file) => sum + file.bytes.length, 0) >
					20 * 1024 * 1024
			)
				throw Error();
			const form = new FormData();
			form.set(
				"payload_json",
				JSON.stringify({
					content,
					...(nonce ? { nonce, enforce_nonce: true } : {}),
					allowed_mentions: { parse: [], replied_user: false },
					attachments: files.map((file, index) => ({
						id: index,
						filename: file.name,
					})),
				}),
			);
			for (const [index, file] of files.entries())
				form.set(
					`files[${index}]`,
					new Blob([new Uint8Array(file.bytes)]),
					file.name,
				);
			const response = await this.bytes(
				`https://discord.com/api/v10/channels/${this.channelId}/messages`,
				512 * 1024,
				true,
				"POST",
				form,
			);
			const message = messageSchema.parse(
				JSON.parse(response.toString("utf8")),
			);
			if (message.channel_id !== this.channelId) throw Error();
			if (!nonce) this.sentIds.add(message.id);
			return message.id;
		} catch {
			throw Error("preview_delivery_failed");
		}
	}
	async fetch(messageId: string) {
		const message = z
			.object({
				id,
				channel_id: id,
				author: z.object({ id }),
				content: z.string(),
				attachments: z.array(
					z.object({ id, filename: z.string(), size: z.number() }),
				),
			})
			.parse(await this.fetchMessage(this.channelId, messageId));
		return {
			id: message.id,
			channelId: message.channel_id,
			authorId: message.author.id,
			content: message.content,
			attachments: message.attachments.map((file) => ({
				id: file.id,
				name: file.filename,
				size: file.size,
			})),
		};
	}
	async remove(messageId: string): Promise<void> {
		try {
			if (!this.sentIds.has(messageId)) throw Error();
			await this.bytes(
				`https://discord.com/api/v10/channels/${this.channelId}/messages/${messageId}`,
				512 * 1024,
				true,
				"DELETE",
			);
			this.sentIds.delete(messageId);
		} catch {
			throw Error("preview_cleanup_failed");
		}
	}

	async fetchMessage(channelId: string, messageId: string): Promise<unknown> {
		try {
			this.channel(channelId);
			id.parse(messageId);
			const raw = await this.api(
				`/channels/${channelId}/messages/${messageId}`,
			);
			const message = messageSchema.parse(raw);
			if (message.id !== messageId || message.channel_id !== channelId)
				throw Error();
			const staged: Array<[string, { url: string; size: number }]> = [];
			for (const attachment of message.attachments ?? []) {
				const url = new URL(attachment.url);
				if (
					url.protocol !== "https:" ||
					url.port ||
					url.username ||
					url.password ||
					!["cdn.discordapp.com", "media.discordapp.net"].includes(
						url.hostname,
					) ||
					!url.pathname.startsWith(
						`/attachments/${channelId}/${attachment.id}/`,
					)
				)
					throw Error();
				staged.push([attachment.id, { url: url.href, size: attachment.size }]);
			}
			for (const [key, value] of staged) {
				this.urls.delete(key);
				this.urls.set(key, value);
				if (this.urls.size > 256)
					this.urls.delete(this.urls.keys().next().value!);
			}
			return raw;
		} catch {
			throw Error("founder_source_unavailable");
		}
	}
	async channelGuild(channelId: string): Promise<string> {
		try {
			this.channel(channelId);
			const channel = z
				.object({
					id,
					guild_id: id,
					type: this.probe
						? z.union([z.literal(0), z.literal(11), z.literal(12)])
						: z.union([z.literal(11), z.literal(12)]),
				})
				.parse(await this.api(`/channels/${channelId}`));
			if (channel.id !== channelId) throw Error();
			return channel.guild_id;
		} catch {
			throw Error("founder_source_unavailable");
		}
	}
	async readAttachment(attachmentId: string): Promise<Buffer> {
		try {
			const record = this.urls.get(attachmentId);
			if (!record) throw Error();
			const bytes = await this.bytes(record.url, record.size, false);
			if (bytes.length !== record.size) throw Error();
			return bytes;
		} catch {
			throw Error("founder_source_unavailable");
		}
	}
}
