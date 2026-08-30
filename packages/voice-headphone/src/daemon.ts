/**
 * Headphone daemon composition root (FLY-546 B2) — wires discord.js to the
 * gateway-agnostic core, the turn machine, and the desktop dry-run audio
 * face. All decision logic lives in daemon-core / voice-core headphone and
 * is unit-tested there; this file only composes.
 */
import {
	ChannelType,
	Client,
	GatewayIntentBits,
	type Message,
	Partials,
} from "discord.js";
import {
	buildEdgeTtsBackend,
	HeadphoneQueue,
	HeadphoneTurnMachine,
	resolveConfig,
	type TimerHost,
	VoiceDirectory,
} from "flywheel-voice-core";
import { BridgeVoiceClient } from "./bridge-client.js";
import type { HeadphoneConfig } from "./config.js";
import { type GatewayMessage, HeadphoneDaemonCore } from "./daemon-core.js";
import { LocalEdgeAnnouncer } from "./local-announcer.js";
import type { DiscordSenderLike } from "./null-audio-io.js";
import { NullAudioIO } from "./null-audio-io.js";
import { normalizeRestoredTurn, sendMarker } from "./recovery.js";
import { loadState, STATE_SCHEMA_VERSION, saveState } from "./state-file.js";

const SCOPE_REFRESH_MS = 5 * 60_000;

class NodeTimerHost implements TimerHost {
	private readonly timers = new Map<string, NodeJS.Timeout>();
	set(tag: string, delayMs: number, fire: () => void): void {
		this.clear(tag);
		this.timers.set(tag, setTimeout(fire, delayMs));
	}
	clear(tag: string): void {
		const t = this.timers.get(tag);
		if (t) clearTimeout(t);
		this.timers.delete(tag);
	}
}

function toGatewayMessage(
	message: Message,
	founderUserId: string,
): GatewayMessage {
	return {
		id: message.id,
		channelId: message.channelId,
		channelName:
			"name" in message.channel
				? (message.channel.name ?? undefined)
				: undefined,
		authorId: message.author.id,
		authorIsBot: message.author.bot,
		content: message.content,
		mentionsFounder: message.mentions.users.has(founderUserId),
	};
}

class DiscordSender implements DiscordSenderLike {
	constructor(private readonly client: Client) {}

	private async textChannel(channelId: string) {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel || !("send" in channel)) {
			throw new Error(`channel ${channelId} is not sendable`);
		}
		return channel;
	}

	async sendMessage(
		channelId: string,
		content: string,
		replyToMessageId?: string,
	): Promise<string> {
		const channel = await this.textChannel(channelId);
		const sent = await channel.send(
			replyToMessageId
				? { content, reply: { messageReference: replyToMessageId } }
				: { content },
		);
		return sent.id;
	}

	async scanRecent(
		channelId: string,
	): Promise<Array<{ id: string; content: string }>> {
		const channel = await this.textChannel(channelId);
		if (!("messages" in channel)) return [];
		const recent = await channel.messages.fetch({ limit: 25 });
		return [...recent.values()].map((m) => ({ id: m.id, content: m.content }));
	}
}

export async function runHeadphoneDaemon(cfg: HeadphoneConfig): Promise<void> {
	const bridge = new BridgeVoiceClient({
		bridgeUrl: cfg.bridgeUrl,
		token: cfg.bridgeToken,
	});

	// scope contract comes from the Bridge — refuse to start on a founder
	// identity mismatch (two sources must agree, fail-closed).
	const scope = await bridge.getScope();
	if (scope.founderIdFingerprint !== cfg.founderUserId) {
		throw new Error(
			`headphone: founderUserId mismatch — config says ${cfg.founderUserId}, Bridge scope says ${scope.founderIdFingerprint}. Refusing to start.`,
		);
	}

	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
		],
		partials: [Partials.Channel, Partials.Message],
	});

	const restored = loadState(cfg.stateFile);
	const queue = new HeadphoneQueue({ onPersist: () => persistAll() });
	if (restored) queue.restore(restored.queue);

	const sender = new DiscordSender(client);
	const voiceConfig = resolveConfig();
	const announcer = new LocalEdgeAnnouncer(buildEdgeTtsBackend(voiceConfig));
	const directory = new VoiceDirectory(cfg.voices ?? {}, {
		voiceId: voiceConfig.voice,
	});

	// late-bound refs: the queue/machine persistence hooks fire during
	// construction, before the machine/core exist — fall back to restored
	// values until they are wired.
	const refs: {
		machine?: HeadphoneTurnMachine;
		core?: HeadphoneDaemonCore;
	} = {};

	const io = new NullAudioIO({
		announcer,
		directory,
		sender,
		bridge,
		founderUserId: cfg.founderUserId,
		persist: () => persistAll(),
	});

	function persistAll(): void {
		saveState(cfg.stateFile, {
			schemaVersion: STATE_SCHEMA_VERSION,
			modeOn: refs.core?.modeOn ?? restored?.modeOn ?? false,
			cursors: { ...(refs.core?.cursors ?? restored?.cursors ?? {}) },
			queue: queue.snapshot(),
			turn: refs.machine?.persistedSnapshot() ?? restored?.turn,
		});
	}

	// boot recovery: reconcile a turn that died mid-"sending" against the
	// side-effect ledger — adopt marked outbound messages, never re-send.
	const normalizedTurn = restored?.turn
		? await normalizeRestoredTurn(restored.turn, queue, {
				adoptSend: async (itemId, channelId) => {
					const recent = await sender
						.scanRecent(channelId)
						.catch(() => [] as Array<{ id: string; content: string }>);
					return recent.find((m) => m.content.includes(sendMarker(itemId)))?.id;
				},
			})
		: undefined;

	const machine = new HeadphoneTurnMachine({
		io,
		queue,
		timers: new NodeTimerHost(),
		vocabulary: cfg.phrases,
		restore: normalizedTurn,
		onModeOff: (recap) => {
			refs.core?.onModeOff();
			// VC-exit recap goes out as TEXT to the core channel (she is no
			// longer in the VC to hear one); spoken exits already got a spoken
			// recap but the text one is the durable record either way.
			void sender
				.sendMessage(
					cfg.coreChannelId,
					`🎧 耳机模式结束(${recap.reason === "vc_exit" ? "离开语音频道" : "口令退出"}):处理了 ${recap.processed} 条,剩 ${recap.remaining} 条留在 Discord。`,
				)
				.catch((err) => console.error("[headphone] recap post failed:", err));
		},
	});

	const theCore = new HeadphoneDaemonCore({
		scope,
		bridge,
		queue,
		machine,
		selfBotId: "", // filled on clientReady below
		founderUserId: cfg.founderUserId,
		coreChannelId: cfg.coreChannelId,
		includeRoundtable: cfg.includeRoundtable,
		modeOn: restored?.modeOn ?? false,
		persist: () => persistAll(),
	});
	refs.machine = machine;
	refs.core = theCore;
	// Cursors are only meaningful while the mode is ON (they anchor the
	// offline backfill). Booting with the mode OFF drops them: mode-off
	// downtime must never seed a later backfill that would flood the queue
	// with history she already read on screen (Codex R1 MEDIUM-4).
	if (restored?.cursors && theCore.modeOn) {
		Object.assign(theCore.cursors, restored.cursors);
	}

	// Startup buffering (Codex R2 HIGH): live gateway delivery starts the
	// moment we log in — before backfill has fetched from the persisted
	// cursors. Buffer live messages until backfill is done so a startup-window
	// message can never advance a cursor past the offline gap (which would
	// drop those missed messages forever).
	theCore.beginStartupBuffer();

	client.on("messageCreate", (message) => {
		void theCore
			.onGatewayMessage(toGatewayMessage(message, cfg.founderUserId))
			.catch((err) => console.error("[headphone] ingest failed:", err));
	});

	await client.login(cfg.botToken);
	await new Promise<void>((resolve) =>
		client.once("clientReady", () => resolve()),
	);
	const selfId = client.user?.id;
	if (!selfId)
		throw new Error("headphone: bot user id unavailable after ready");
	// echo immunity depends on the self id — known only after login.
	theCore.selfBotId = selfId;

	console.log(
		`[headphone] up — listening ${theCore.scopeChannels.length} channels, mode=${theCore.modeOn ? "ON" : "OFF"}, approval=enabled`,
	);

	// offline backfill (only meaningful when the mode survived the restart)
	if (theCore.modeOn) {
		await theCore.backfill(async (channelId, after) => {
			try {
				const channel = await client.channels.fetch(channelId);
				if (
					!channel ||
					!("messages" in channel) ||
					channel.type === ChannelType.GuildVoice
				) {
					return [];
				}
				const fetched = await channel.messages.fetch(
					after ? { after, limit: 100 } : { limit: 0 },
				);
				return [...fetched.values()].map((m) =>
					toGatewayMessage(m, cfg.founderUserId),
				);
			} catch (err) {
				console.error(`[headphone] backfill ${channelId} failed:`, err);
				return [];
			}
		});
	}
	// drain the startup buffer AFTER backfill anchored on pristine cursors
	// (mode OFF boots drain immediately — nothing was backfilled).
	await theCore.endStartupBuffer();

	// periodic scope refresh keeps new leads/threads listenable without restart
	setInterval(() => {
		void bridge
			.getScope()
			.then((s) => theCore.updateScope(s))
			.catch((err) => console.error("[headphone] scope refresh failed:", err));
	}, SCOPE_REFRESH_MS).unref();
}
