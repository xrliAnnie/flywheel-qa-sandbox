/**
 * HeadphoneDaemonCore (FLY-546 B2-2) — gateway-agnostic daemon logic:
 * message tap → filter → context/gate-binding lookup → enqueue, per-channel
 * cursors + offline backfill, and the typed passphrase path. The real
 * discord.js wiring lives in daemon.ts (composition root); this core is
 * driven module-style in tests with fakes.
 */
import {
	type HeadphoneQueue,
	matchPhrase,
	OPEN_WORD,
	type QueueItem,
	STOP_WORD,
	shouldEnqueue,
	type TurnEvent,
} from "flywheel-voice-core";
import type { GateBinding, VoiceContext, VoiceScope } from "./bridge-client.js";

export type GatewayMessage = {
	id: string;
	channelId: string;
	channelName?: string;
	authorId: string;
	authorIsBot: boolean;
	content: string;
	mentionsFounder: boolean;
};

export interface BridgeLookups {
	getContext(channelId: string): Promise<VoiceContext>;
	getGateBinding(messageId: string): Promise<GateBinding>;
}

export interface MachineLike {
	handleEvent(ev: TurnEvent): void;
}

export interface DaemonCoreOptions {
	scope: VoiceScope;
	bridge: BridgeLookups;
	queue: HeadphoneQueue;
	machine: MachineLike;
	selfBotId: string;
	founderUserId: string;
	coreChannelId: string;
	includeRoundtable: boolean;
	modeOn: boolean;
	/** persist the daemon state file (cursors + queue + mode). */
	persist: () => void;
	openWords?: readonly string[];
	stopWords?: readonly string[];
}

/** compare Discord snowflakes (numeric strings too large for Number). */
function snowflakeLess(a: string, b: string): boolean {
	if (a.length !== b.length) return a.length < b.length;
	return a < b;
}

export class HeadphoneDaemonCore {
	modeOn: boolean;
	/** the daemon's own bot id (echo immunity) — settable once known at ready. */
	selfBotId: string;
	readonly cursors: Record<string, string> = {};
	private scope: VoiceScope;
	private startupBuffer?: GatewayMessage[];

	constructor(private readonly opts: DaemonCoreOptions) {
		this.modeOn = opts.modeOn;
		this.selfBotId = opts.selfBotId;
		this.scope = opts.scope;
	}

	/**
	 * Startup buffering (Codex R2 HIGH): the live gateway listener is wired
	 * before boot backfill runs, and live ingest advances the SAME cursors
	 * backfill anchors on — a live message during the startup window would
	 * push a channel cursor past the offline gap and lose those messages
	 * forever. While buffering, gateway messages are held (no cursor, no
	 * ingest); after backfill fetched from the pristine persisted cursors,
	 * endStartupBuffer drains them in snowflake order (queue dedupe absorbs
	 * any overlap with the backfilled fetch).
	 */
	beginStartupBuffer(): void {
		this.startupBuffer = [];
	}

	async endStartupBuffer(): Promise<void> {
		const buffer = this.startupBuffer;
		if (!buffer) return;
		// The buffer stays ACTIVE while draining (Codex R3): each drained
		// message awaits async Bridge lookups, and a live messageCreate firing
		// in that window must keep appending here — clearing the buffer first
		// would let it bypass and enqueue ahead of older buffered messages.
		// Single-threaded JS: the loop-exit check and the deactivation below
		// have no await between them, so nothing can slip past the shutdown.
		while (buffer.length > 0) {
			buffer.sort((a, b) => (snowflakeLess(a.id, b.id) ? -1 : 1));
			const next = buffer.shift() as GatewayMessage;
			await this.processGatewayMessage(next);
		}
		this.startupBuffer = undefined;
	}

	/** periodic scope refresh keeps new leads/threads listenable. */
	updateScope(scope: VoiceScope): void {
		this.scope = scope;
	}

	get scopeChannels(): string[] {
		const set = new Set([
			...this.scope.scopeChannelIds,
			...(this.opts.includeRoundtable ? this.scope.roundtableChannelIds : []),
		]);
		return [...set];
	}

	async onGatewayMessage(msg: GatewayMessage): Promise<void> {
		if (this.startupBuffer) {
			this.startupBuffer.push(msg);
			return;
		}
		await this.processGatewayMessage(msg);
	}

	private async processGatewayMessage(msg: GatewayMessage): Promise<void> {
		this.advanceCursor(msg.channelId, msg.id);
		// founder passphrase path (typed, core channel) comes before any
		// mode check — it IS the mode switch.
		if (
			msg.channelId === this.opts.coreChannelId &&
			msg.authorId === this.opts.founderUserId
		) {
			this.onFounderCoreMessage(msg.content);
			this.opts.persist();
			return;
		}
		if (this.modeOn) await this.ingest(msg);
		this.opts.persist();
	}

	/** turn machine reports mode OFF (spoken exit / VC exit). */
	onModeOff(): void {
		this.modeOn = false;
		this.opts.persist();
	}

	private onFounderCoreMessage(content: string): void {
		const open = matchPhrase(content, this.opts.openWords ?? OPEN_WORD);
		if (open && !this.modeOn) {
			this.modeOn = true;
			this.opts.machine.handleEvent({ type: "start" });
			return;
		}
		const stop = matchPhrase(content, this.opts.stopWords ?? STOP_WORD);
		if (stop && this.modeOn) {
			// route into the machine so the confirm step applies (typed 芝麻关门
			// is equivalent to the spoken one).
			this.opts.machine.handleEvent({ type: "utterance", text: content });
		}
	}

	private async ingest(msg: GatewayMessage): Promise<void> {
		// gate-binding lookup for every bot message in scope channels — the
		// binding both classifies ship_gate items AND rescues unknown bots
		// (filter ⑦: classify by persisted binding, never by author guess).
		let binding: GateBinding = { bound: false };
		if (
			msg.authorIsBot &&
			(this.scope.scopeChannelIds.includes(msg.channelId) ||
				this.scope.roundtableChannelIds.includes(msg.channelId))
		) {
			binding = await this.opts.bridge.getGateBinding(msg.id);
		}
		const include = shouldEnqueue(
			{
				authorId: msg.authorId,
				authorIsBot: msg.authorIsBot,
				channelId: msg.channelId,
				mentionsFounder: msg.mentionsFounder,
				hasGateBinding: binding.bound,
			},
			{
				leadBotIds: new Set(this.scope.leadBotIds),
				systemBotIds: new Set(this.scope.systemBotIds),
				scopeChannelIds: new Set(this.scope.scopeChannelIds),
				roundtableChannelIds: new Set(this.scope.roundtableChannelIds),
				includeRoundtable: this.opts.includeRoundtable,
				selfBotId: this.selfBotId,
				founderId: this.opts.founderUserId,
			},
		);
		if (!include) return;

		const ctx = await this.opts.bridge.getContext(msg.channelId);
		const item = this.buildItem(msg, ctx, binding);
		if (this.opts.queue.push(item)) {
			this.opts.machine.handleEvent({ type: "queue_pushed" });
		}
	}

	private buildItem(
		msg: GatewayMessage,
		ctx: VoiceContext,
		binding: GateBinding,
	): QueueItem {
		const headline =
			ctx.kind === "issue_thread"
				? {
						agentDisplay: ctx.agentId,
						issueRef: ctx.issueIdentifier,
						issueTitle: ctx.issueTitle,
						stageHint: ctx.stage,
					}
				: ctx.kind === "lead_channel"
					? { agentDisplay: ctx.agentId }
					: // degraded headline (context miss): locate by channel name —
						// the message still enqueues, never silently dropped.
						{ agentDisplay: msg.channelName ?? "未知频道" };
		const agentId =
			ctx.kind === "issue_thread" || ctx.kind === "lead_channel"
				? ctx.agentId
				: (msg.channelName ?? "system");
		return {
			id: `hp-${msg.id}`,
			messageId: msg.id,
			channelId: msg.channelId,
			agentId,
			authorId: msg.authorId,
			kind: binding.bound ? "ship_gate" : "normal",
			headline,
			body: msg.content,
			enqueuedAt: new Date().toISOString(),
			gate: binding.bound
				? {
						gateMessageId: msg.id,
						questionId: binding.questionId,
						prHeadSha: binding.prHeadSha,
						issueId: binding.issueId,
						prNumber: binding.prNumber,
					}
				: undefined,
		};
	}

	private advanceCursor(channelId: string, messageId: string): void {
		const cur = this.cursors[channelId];
		if (!cur || snowflakeLess(cur, messageId)) {
			this.cursors[channelId] = messageId;
		}
	}

	/**
	 * Offline backfill (recovery ledger ①): replay messages missed while the
	 * daemon was down, strictly after each channel's persisted cursor, then
	 * GLOBALLY ordered by snowflake across all channels (Codex R1 MEDIUM-4:
	 * FIFO is arrival order, not per-channel batches). Queue dedupe absorbs
	 * overlap with live delivery.
	 */
	async backfill(
		fetchAfter: (
			channelId: string,
			afterMessageId: string | undefined,
		) => Promise<GatewayMessage[]>,
	): Promise<void> {
		const missed: GatewayMessage[] = [];
		for (const channelId of this.scopeChannels) {
			missed.push(...(await fetchAfter(channelId, this.cursors[channelId])));
		}
		missed.sort((a, b) => (snowflakeLess(a.id, b.id) ? -1 : 1));
		for (const msg of missed) {
			await this.onGatewayMessage(msg);
		}
	}
}
