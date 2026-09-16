import WebSocket, { type RawData } from "ws";
import { assertReleaseMessageExtras } from "./cards.js";
import { isDiscordId } from "./notice.js";

export interface VerifiedReleaseInteraction {
	interactionId: string;
	actorId: string;
	applicationId: string;
	guildId: string;
	channelId: string;
	messageId: string;
	action: "veto" | "go" | "enable" | "disable";
	nonce: string;
	epoch: number;
	content: string;
	components: unknown[];
	embeds?: unknown;
	attachments?: unknown;
	stickers?: unknown;
	sticker_items?: unknown;
}
interface GatewayOptions {
	applicationId: string;
	botUserId: string;
	guildId: string;
	channelId: string;
	token: string;
	founderId: () => string | null;
	epoch: () => number;
	/** Synchronous durable transaction. The token is deliberately not part of this object. */
	commit: (action: VerifiedReleaseInteraction) => string;
	invalidate: (reason: string) => void;
	fetch?: typeof fetch;
	socket?: (url: string) => WebSocket;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid release Gateway event");
	return value as Record<string, unknown>;
}
function requireValid(value: unknown): asserts value {
	if (!value) throw new Error("invalid release Gateway event");
}

/** Dedicated authenticated Discord session. No HTTP interaction ingress or runner bearer path. */
export class ReleaseInteractionGateway {
	private ws: WebSocket | null = null;
	private running = false;
	private generation = 0;
	private retryDelay = 5000;
	private ready = false;
	private acked = false;
	private lastAckAt: number | null = null;
	private heartbeatInterval = 0;
	private awaitingAck = false;
	private sequence: number | null = null;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private reconnect: ReturnType<typeof setTimeout> | null = null;
	private acknowledgments = 0;
	private readonly replied = new Set<string>();
	private readonly fetcher: typeof fetch;
	constructor(private readonly options: GatewayOptions) {
		requireValid(
			[
				options.applicationId,
				options.botUserId,
				options.guildId,
				options.channelId,
			].every(isDiscordId) &&
				options.token &&
				!/[\r\n]/.test(options.token),
		);
		this.fetcher = options.fetch ?? fetch;
	}
	healthy(): boolean {
		return (
			this.running &&
			this.ready &&
			this.acked &&
			this.lastAckAt !== null &&
			Date.now() >= this.lastAckAt &&
			Date.now() - this.lastAckAt < this.heartbeatInterval * 2 &&
			this.ws?.readyState === WebSocket.OPEN
		);
	}
	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			this.options.invalidate("gateway_starting");
		} catch {
			this.running = false;
			return;
		}
		await this.connect();
	}
	stop(): void {
		this.running = false;
		this.fail("gateway_stopped");
	}
	private fail(reason: string, delay = 5000): void {
		this.generation++;
		this.ready = false;
		this.acked = false;
		this.lastAckAt = null;
		this.heartbeatInterval = 0;
		this.awaitingAck = false;
		this.sequence = null;
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (this.reconnect) clearTimeout(this.reconnect);
		this.heartbeat = null;
		this.reconnect = null;
		const ws = this.ws;
		this.ws = null;
		try {
			ws?.close();
		} catch {
			/* Health is already revoked. */
		}
		try {
			this.options.invalidate(reason);
		} catch {
			this.running = false;
		}
		if (this.running) {
			this.reconnect = setTimeout(
				() => {
					this.reconnect = null;
					void this.connect();
				},
				Math.max(this.retryDelay, delay),
			);
			this.retryDelay = Math.min(60000, this.retryDelay * 2);
			this.reconnect.unref?.();
		}
	}
	private async api(path: string): Promise<Record<string, unknown>> {
		const response = await this.fetcher(`https://discord.com/api/v10${path}`, {
			headers: { authorization: `Bot ${this.options.token}` },
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
		requireValid(response.status === 200 && !response.redirected);
		requireValid(response.body);
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				total += chunk.value.byteLength;
				if (total > 65536) {
					await reader.cancel();
					throw new Error("Gateway response too large");
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return object(
			JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
			),
		);
	}
	private async connect(): Promise<void> {
		const generation = this.generation;
		try {
			const user = await this.api("/users/@me");
			const app = await this.api("/applications/@me");
			requireValid(
				user.id === this.options.botUserId &&
					user.bot === true &&
					app.id === this.options.applicationId &&
					!app.interactions_endpoint_url,
			);
			const gateway = await this.api("/gateway/bot");
			const limits = object(gateway.session_start_limit);
			requireValid(
				Number.isSafeInteger(limits.remaining) &&
					Number.isSafeInteger(limits.reset_after),
			);
			if (!this.running || this.generation !== generation) return;
			if ((limits.remaining as number) <= 0) {
				this.fail(
					"gateway_session_limit",
					Math.min(86400000, Math.max(5000, limits.reset_after as number)),
				);
				return;
			}
			const url = new URL(String(gateway.url));
			requireValid(
				url.protocol === "wss:" &&
					url.hostname === "gateway.discord.gg" &&
					!url.port &&
					!url.username &&
					!url.password &&
					url.pathname === "/" &&
					!url.search &&
					!url.hash,
			);
			url.search = "?v=10&encoding=json";
			const ws =
				this.options.socket?.(url.href) ??
				new WebSocket(url.href, {
					handshakeTimeout: 10000,
					maxPayload: 65536,
					perMessageDeflate: false,
				});
			this.ws = ws;
			ws.on("message", (data: RawData, binary: boolean) => {
				if (this.ws === ws) this.receive(data, binary);
			});
			ws.on("error", () => {
				if (this.ws === ws) this.fail("gateway_error");
			});
			ws.on("close", () => {
				if (this.ws === ws) this.fail("gateway_disconnected");
			});
		} catch {
			if (this.running && this.generation === generation)
				this.fail("gateway_start_failed");
		}
	}
	private send(value: unknown): void {
		requireValid(this.ws?.readyState === WebSocket.OPEN);
		this.ws.send(JSON.stringify(value));
	}
	private beat(): void {
		this.send({ op: 1, d: this.sequence });
		this.awaitingAck = true;
	}
	private receive(data: RawData, binary: boolean): void {
		try {
			const bytes = Array.isArray(data)
				? Buffer.concat(data)
				: Buffer.from(data as ArrayBuffer);
			requireValid(!binary && bytes.byteLength <= 65536);
			const event = object(JSON.parse(bytes.toString("utf8")));
			if (event.op === 10) {
				requireValid(!this.heartbeat);
				const interval = object(event.d).heartbeat_interval;
				requireValid(
					Number.isSafeInteger(interval) &&
						(interval as number) >= 100 &&
						(interval as number) <= 120000,
				);
				this.send({
					op: 2,
					d: {
						token: this.options.token,
						intents: 0,
						properties: {
							os: process.platform,
							browser: "flywheel-release",
							device: "flywheel-release",
						},
					},
				});
				this.heartbeatInterval = interval as number;
				this.beat();
				this.heartbeat = setInterval(() => {
					if (this.awaitingAck) {
						this.fail("gateway_heartbeat_timeout");
						return;
					}
					try {
						this.beat();
					} catch {
						this.fail("gateway_heartbeat_failed");
					}
				}, interval as number);
				this.heartbeat.unref?.();
				return;
			}
			if (event.op === 11) {
				requireValid(this.awaitingAck);
				this.awaitingAck = false;
				this.acked = true;
				this.lastAckAt = Date.now();
				if (this.ready) this.retryDelay = 5000;
				return;
			}
			if (event.op === 1) {
				this.beat();
				return;
			}
			if (event.op === 7 || event.op === 9) {
				this.fail("gateway_session_invalid");
				return;
			}
			requireValid(
				event.op === 0 &&
					Number.isSafeInteger(event.s) &&
					(event.s as number) >= 0,
			);
			requireValid(this.sequence === null || event.s === this.sequence + 1);
			this.sequence = event.s as number;
			const body = object(event.d);
			if (event.t === "READY") {
				requireValid(
					!this.ready &&
						object(body.user).id === this.options.botUserId &&
						object(body.application).id === this.options.applicationId,
				);
				this.ready = true;
				if (this.acked) this.retryDelay = 5000;
				return;
			}
			if (event.t !== "INTERACTION_CREATE") return;
			requireValid(this.healthy());
			this.interaction(body);
		} catch {
			this.fail("gateway_event_invalid");
		}
	}
	private interaction(body: Record<string, unknown>): void {
		// Valid interactions outside this project or from another user are not a
		// Gateway outage. Ignore them without giving outsiders a release veto.
		if (
			body.type !== 3 ||
			body.application_id !== this.options.applicationId ||
			body.guild_id !== this.options.guildId ||
			body.channel_id !== this.options.channelId
		)
			return;
		const user = object(object(body.member).user),
			data = object(body.data),
			message = object(body.message),
			author = object(message.author);
		const custom =
			typeof data.custom_id === "string"
				? /^fwrel:(veto|go|enable|disable):([1-9]\d{0,15}):([a-f0-9]{32})$/.exec(
						data.custom_id,
					)
				: null;
		if (
			!custom ||
			user.id !== this.options.founderId() ||
			user.bot === true ||
			body.user ||
			author.id !== this.options.botUserId ||
			author.bot !== true ||
			Number(custom[2]) !== this.options.epoch()
		)
			return;
		requireValid(
			body.version === 1 &&
				data.component_type === 2 &&
				isDiscordId(body.id) &&
				isDiscordId(message.id) &&
				isDiscordId(user.id) &&
				Number.isSafeInteger(Number(custom[2])) &&
				typeof message.content === "string" &&
				Array.isArray(message.components) &&
				typeof body.token === "string" &&
				/^[A-Za-z0-9._-]{1,512}$/.test(body.token) &&
				this.acknowledgments < 8,
		);
		const received = Date.now();
		assertReleaseMessageExtras(message);
		const content = this.options.commit({
			interactionId: body.id,
			actorId: user.id,
			applicationId: this.options.applicationId,
			guildId: this.options.guildId,
			channelId: this.options.channelId,
			messageId: message.id,
			action: custom[1] as VerifiedReleaseInteraction["action"],
			nonce: custom[3]!,
			epoch: Number(custom[2]),
			content: message.content,
			components: message.components,
			embeds: message.embeds,
			attachments: message.attachments,
			stickers: message.stickers,
			sticker_items: message.sticker_items,
		});
		requireValid(
			typeof content === "string" &&
				content.length > 0 &&
				content.length <= 2000 &&
				Date.now() - received < 2500,
		);
		if (this.replied.has(body.id)) return;
		this.replied.add(body.id);
		if (this.replied.size > 256)
			this.replied.delete(this.replied.values().next().value!);
		const generation = this.generation;
		const ackFailed = () => {
			this.replied.delete(body.id as string);
			if (this.running && this.generation === generation)
				this.fail("gateway_ack_failed");
		};
		this.acknowledgments++;
		void this.fetcher(
			`https://discord.com/api/v10/interactions/${body.id}/${encodeURIComponent(body.token)}/callback`,
			{
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(2500),
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: 4,
					data: { content, flags: 64, allowed_mentions: { parse: [] } },
				}),
			},
		)
			.then((response) => {
				if (response.status !== 204 && response.status !== 200) ackFailed();
				void response.body?.cancel();
			})
			.catch(ackFailed)
			.finally(() => {
				this.acknowledgments--;
			});
	}
}
