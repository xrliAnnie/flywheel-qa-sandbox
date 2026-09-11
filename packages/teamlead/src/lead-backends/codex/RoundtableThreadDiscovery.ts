/** Reconcile durable subscriptions against Discord; discovery never creates interest. */

const DISCORD_API = "https://discord.com/api/v10";
const REQ_TIMEOUT_MS = 5_000;

interface RawActiveThread {
	id: string;
	parent_id?: string;
}
interface RawThreadMember {
	id?: string; // thread id
	user_id?: string;
}

export interface ChannelSubscriber {
	addChannel(channelId: string): Promise<void>;
	removeChannel(channelId: string): void;
	isSubscribed(channelId: string): boolean;
}

export interface ThreadRegistryLike {
	add(threadId: string): boolean;
	remove(threadId: string): boolean;
	has(threadId: string): boolean;
	list(): string[];
	oldest(): string | undefined;
	readonly size: number;
}

export interface RoundtableThreadDiscoveryOptions {
	guildId: string;
	roundtableChannelId: string;
	botUserId: string;
	botToken: string;
	registry: ThreadRegistryLike;
	source: ChannelSubscriber;
	/** Removal must persist through the owning wiring before changing membership. */
	removeThread: (threadId: string, reason: string) => Promise<boolean>;
	reconcileIntervalMs?: number;
	fetchImpl?: typeof fetch;
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
	logger?: { warn: (m: string, c?: unknown) => void };
}

export class RoundtableThreadDiscovery {
	private readonly guildId: string;
	private readonly roundtableChannelId: string;
	private readonly botUserId: string;
	private readonly botToken: string;
	private readonly registry: ThreadRegistryLike;
	private readonly source: ChannelSubscriber;
	private readonly removeThread: (
		threadId: string,
		reason: string,
	) => Promise<boolean>;
	private readonly reconcileIntervalMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly setTimer: (
		fn: () => void,
		ms: number,
	) => { cancel: () => void };
	private readonly logger: { warn: (m: string, c?: unknown) => void };

	private timer: { cancel: () => void } | null = null;
	private running = false;

	constructor(opts: RoundtableThreadDiscoveryOptions) {
		this.guildId = opts.guildId;
		this.roundtableChannelId = opts.roundtableChannelId;
		this.botUserId = opts.botUserId;
		this.botToken = opts.botToken;
		this.registry = opts.registry;
		this.source = opts.source;
		this.removeThread = opts.removeThread;
		this.reconcileIntervalMs = opts.reconcileIntervalMs ?? 60_000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.setTimer =
			opts.setTimer ??
			((fn, ms) => {
				const h = setTimeout(fn, ms);
				h.unref?.();
				return { cancel: () => clearTimeout(h) };
			});
		this.logger = opts.logger ?? { warn: () => {} };
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		await this.reconcileOnce();
		this.scheduleNext();
	}

	async stop(): Promise<void> {
		this.running = false;
		this.timer?.cancel();
		this.timer = null;
	}

	private scheduleNext(): void {
		if (!this.running) return;
		this.timer = this.setTimer(() => {
			void this.reconcileOnce().finally(() => this.scheduleNext());
		}, this.reconcileIntervalMs);
	}

	/** One reconciliation pass (path ii). Never throws. */
	async reconcileOnce(): Promise<void> {
		let active: { threads: RawActiveThread[]; joined: Set<string> };
		try {
			active = await this.fetchActiveJoinedThreads();
		} catch (err) {
			this.logger.warn(
				"[RoundtableThreadDiscovery] active-threads fetch failed",
				{
					err: (err as Error).message,
				},
			);
			return;
		}
		const desired = new Set(
			active.threads
				.filter((t) => t.parent_id === this.roundtableChannelId)
				.map((t) => t.id)
				.filter((id) => active.joined.has(id)),
		);
		for (const id of this.registry.list()) {
			try {
				if (!desired.has(id)) await this.removeThread(id, "archived");
				else if (!this.source.isSubscribed(id) && this.registry.has(id))
					await this.source.addChannel(id);
			} catch (error) {
				this.logger.warn(
					"[RoundtableThreadDiscovery] reconcile source failed",
					{ id, error: String(error) },
				);
			}
		}
	}

	/** GET /guilds/{guildId}/threads/active → {threads, joined-by-this-bot set}. */
	private async fetchActiveJoinedThreads(): Promise<{
		threads: RawActiveThread[];
		joined: Set<string>;
	}> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
		try {
			const res = await this.fetchImpl(
				`${DISCORD_API}/guilds/${this.guildId}/threads/active`,
				{
					headers: { Authorization: `Bot ${this.botToken}` },
					signal: controller.signal,
				},
			);
			if (!res.ok) {
				throw new Error(`Discord GET active threads ${res.status}`);
			}
			const body = (await res.json()) as {
				threads?: RawActiveThread[];
				members?: RawThreadMember[];
			};
			const threads = Array.isArray(body.threads) ? body.threads : [];
			// `members[]` lists, per returned thread, a member object IFF the current
			// user has joined it. Use `member.id === thread.id`; check `user_id` only
			// when present + non-empty (R2#3 — the field is optional in the schema).
			const joined = new Set<string>();
			for (const m of body.members ?? []) {
				if (!m.id) continue;
				if (m.user_id && m.user_id !== this.botUserId) continue;
				joined.add(m.id);
			}
			return { threads, joined };
		} finally {
			clearTimeout(timer);
		}
	}
}
