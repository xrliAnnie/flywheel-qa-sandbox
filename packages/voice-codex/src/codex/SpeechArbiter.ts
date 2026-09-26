import type { VoiceUnplayedItem } from "../voice-minutes.js";
export type SpeechArbiterKind =
	| "cue"
	| "result"
	| "tell"
	| "agenda"
	| "fallback";

export type SpeechArbiterTerminal =
	| "spoken"
	| "fallback_posted"
	| "stale_dropped"
	| "failed";

export interface SpeechArbiterRequest {
	businessId: string;
	kind: SpeechArbiterKind;
	text: string;
	threadText?: string;
	expiresAt?: number;
	revalidate?(): Promise<boolean>;
}

/** `deferred`: the speaker was not live (a realtime generation is being
 * replaced); the entry is replayed, not dropped (FLY-2886 QA@4 D2). */
type SpeechAttemptOutcome = "spoken" | "failed" | "deferred";

interface QueueEntry extends SpeechArbiterRequest {
	attempts: number;
	deferrals: number;
	/** Settle as stale once the active playback ends (see `retire`). */
	retired?: boolean;
	/** Set while a deferred entry waits for a live generation or its retry. */
	deferredUntil?: number;
	settled: boolean;
	resolve(outcome: SpeechArbiterTerminal): void;
}

interface ActiveAttempt {
	entry: QueueEntry;
	pendingKey: string;
	token: number;
}

export interface SpeechArbiterOptions {
	now?(): number;
	schedule?(callback: () => void, delayMs: number): unknown;
	cancelScheduled?(handle: unknown): void;
	speak(request: {
		text: string;
		pendingKey: string;
	}): Promise<SpeechAttemptOutcome>;
	cancelSpeech(pendingKey: string): void;
	postThread?(request: { businessId: string; text: string }): Promise<void>;
	floorQuietMs?: number;
	providerStaleMs?: number;
	/** Retry cadence for a deferred entry when no generation change arrives. */
	deferRetryMs?: number;
	/** Deferrals after which a retryable entry falls back to the thread. */
	maxDeferrals?: number;
}

const RESULT_PREFIX = "刚才查到的：";
const DEFAULT_POINTER = "这条我发到 thread 了，请看文字。";

/**
 * The only outlet for speech the foreground model did not originate itself.
 * It owns floor arbitration and retries, but never produces the delegation
 * acknowledgement (the model alone says “我去看一下”).
 */
export class SpeechArbiter {
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => unknown;
	private readonly cancelScheduled: (handle: unknown) => void;
	private readonly floorQuietMs: number;
	private readonly providerStaleMs: number;
	private readonly deferRetryMs: number;
	private readonly maxDeferrals: number;
	private deferTimer?: unknown;
	private readonly localUtterances = new Set<string>();
	private readonly providerSegments = new Map<
		string,
		{ generation: number; itemId: string; startedAt: number }
	>();
	private readonly queue: QueueEntry[] = [];
	private outputActive = false;
	private lastFloorActivityAt: number;
	private lastLocalEndAt?: number;
	private lastRawVoiceAt?: number;
	private pumpTimer?: unknown;
	private providerTimer?: unknown;
	private active?: ActiveAttempt;
	private attemptToken = 0;
	private closed = false;

	constructor(private readonly options: SpeechArbiterOptions) {
		this.now = options.now ?? Date.now;
		this.schedule =
			options.schedule ??
			((callback, delayMs) => setTimeout(callback, delayMs));
		this.cancelScheduled =
			options.cancelScheduled ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.floorQuietMs = options.floorQuietMs ?? 800;
		this.providerStaleMs = options.providerStaleMs ?? 3_000;
		this.deferRetryMs = options.deferRetryMs ?? 1_000;
		this.maxDeferrals = options.maxDeferrals ?? 30;
		this.lastFloorActivityAt = this.now();
	}

	get userActive(): boolean {
		return this.localUtterances.size > 0 || this.providerSegments.size > 0;
	}

	get busy(): boolean {
		return Boolean(this.active) || this.queue.length > 0;
	}

	enqueue(request: SpeechArbiterRequest): Promise<SpeechArbiterTerminal> {
		if (this.closed || !request.businessId || !request.text) {
			return Promise.resolve("failed");
		}
		let resolve!: (outcome: SpeechArbiterTerminal) => void;
		const result = new Promise<SpeechArbiterTerminal>((done) => {
			resolve = done;
		});
		this.queue.push({
			...request,
			attempts: 0,
			deferrals: 0,
			settled: false,
			resolve,
		});
		this.requestPump();
		return result;
	}

	drop(businessId: string, kind?: SpeechArbiterKind): void {
		for (let index = this.queue.length - 1; index >= 0; index -= 1) {
			const entry = this.queue[index]!;
			if (entry.businessId !== businessId || (kind && entry.kind !== kind))
				continue;
			this.queue.splice(index, 1);
			this.settle(entry, "stale_dropped");
		}
		const active = this.active;
		if (
			active?.entry.businessId === businessId &&
			(!kind || active.entry.kind === kind)
		) {
			this.active = undefined;
			this.attemptToken += 1;
			this.options.cancelSpeech(active.pendingKey);
			this.settle(active.entry, "stale_dropped");
			this.requestPump();
		}
	}

	/**
	 * Like `drop`, but an entry that is already playing is left to finish: its
	 * obligation is settled, yet cutting it off would force a realtime
	 * generation restart (a self-inflicted barge-in, FLY-2886 QA@4 D2).
	 */
	retire(businessId: string, kind?: SpeechArbiterKind): void {
		for (let index = this.queue.length - 1; index >= 0; index -= 1) {
			const entry = this.queue[index]!;
			if (entry.businessId !== businessId || (kind && entry.kind !== kind))
				continue;
			this.queue.splice(index, 1);
			this.settle(entry, "stale_dropped");
		}
		const active = this.active;
		if (
			active?.entry.businessId === businessId &&
			(!kind || active.entry.kind === kind)
		)
			active.entry.retired = true;
	}

	localUtteranceStarted(utteranceId: string): void {
		if (!utteranceId || this.closed) return;
		this.localUtterances.add(utteranceId);
		this.floorActivity();
		this.interruptActive();
	}

	localUtteranceEnded(utteranceId: string): void {
		if (!this.localUtterances.delete(utteranceId)) return;
		this.lastLocalEndAt = this.now();
		this.floorActivity();
		this.scheduleProviderFallback();
		this.requestPump();
	}

	observeRawVoiceActivity(): void {
		this.lastRawVoiceAt = this.now();
		this.floorActivity();
		this.scheduleProviderFallback();
	}

	providerSpeechStarted(generation: number, itemId: string): void {
		if (!itemId || this.closed) return;
		this.providerSegments.set(`${generation}:${itemId}`, {
			generation,
			itemId,
			startedAt: this.now(),
		});
		this.floorActivity();
	}

	providerSpeechFinished(generation: number, itemId: string): void {
		if (!this.providerSegments.delete(`${generation}:${itemId}`)) return;
		this.floorActivity();
		this.requestPump();
	}

	generationChanged(generation: number): void {
		let removed = false;
		for (const [key, segment] of this.providerSegments) {
			if (segment.generation === generation) continue;
			this.providerSegments.delete(key);
			removed = true;
		}
		if (removed) this.floorActivity();
		// A new live generation is exactly what a deferred entry waits for.
		if (removed || this.hasDeferred()) this.requestPump();
	}

	outputState(active: boolean): void {
		if (this.outputActive === active) return;
		this.outputActive = active;
		this.floorActivity();
		if (!active) this.requestPump();
	}

	/** Snapshot content before cancellation settles and removes queue entries. */
	unplayed(): readonly VoiceUnplayedItem[] {
		const rows: VoiceUnplayedItem[] = [];
		const add = (entry: QueueEntry, status: "playing" | "queued") => {
			if (entry.kind === "cue" || entry.settled) return;
			rows.push(
				Object.freeze({
					businessId: entry.businessId,
					kind: entry.kind,
					text: entry.threadText ?? entry.text,
					status,
					attempts: entry.attempts,
				}),
			);
		};
		if (this.active) add(this.active.entry, "playing");
		for (const entry of this.queue) add(entry, "queued");
		return Object.freeze(rows);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.pumpTimer !== undefined) this.cancelScheduled(this.pumpTimer);
		if (this.providerTimer !== undefined)
			this.cancelScheduled(this.providerTimer);
		if (this.deferTimer !== undefined) this.cancelScheduled(this.deferTimer);
		this.pumpTimer = undefined;
		this.providerTimer = undefined;
		this.deferTimer = undefined;
		const active = this.active;
		this.active = undefined;
		if (active) {
			this.options.cancelSpeech(active.pendingKey);
			this.settle(active.entry, "failed");
		}
		for (const entry of this.queue.splice(0)) this.settle(entry, "failed");
	}

	private floorActivity(): void {
		this.lastFloorActivityAt = this.now();
		if (this.pumpTimer !== undefined) {
			this.cancelScheduled(this.pumpTimer);
			this.pumpTimer = undefined;
		}
	}

	private requestPump(): void {
		if (this.closed || this.active || this.queue.length === 0) return;
		if (this.userActive || this.outputActive) return;
		const delay = Math.max(
			0,
			this.lastFloorActivityAt + this.floorQuietMs - this.now(),
		);
		if (delay === 0) {
			this.pump();
			return;
		}
		if (this.pumpTimer !== undefined) this.cancelScheduled(this.pumpTimer);
		this.pumpTimer = this.schedule(() => {
			this.pumpTimer = undefined;
			this.pump();
		}, delay);
	}

	private pump(): void {
		if (this.closed || this.active || this.userActive || this.outputActive)
			return;
		while (this.queue.length > 0) {
			// Results stay in order: a deferred head holds the queue until the
			// session is live again (generation change) or its retry timer fires.
			if (this.queue[0]!.deferredUntil !== undefined) return;
			const entry = this.queue.shift()!;
			if (entry.settled) continue;
			if (entry.expiresAt !== undefined && this.now() >= entry.expiresAt) {
				this.settle(entry, "stale_dropped");
				continue;
			}
			const token = ++this.attemptToken;
			// The speaker memoizes by key, so every replay needs a fresh one.
			const pendingKey =
				entry.kind === "cue"
					? `${entry.businessId}:cue:${token}`
					: `${entry.businessId}:attempt:${entry.attempts}${entry.deferrals ? `:defer:${entry.deferrals}` : ""}`;
			this.active = { entry, pendingKey, token };
			if (entry.revalidate) void this.validateAttempt(this.active);
			else this.startAttempt(this.active);
			return;
		}
	}

	private async validateAttempt(attempt: ActiveAttempt): Promise<void> {
		try {
			const valid = await attempt.entry.revalidate!();
			if (this.active !== attempt || this.closed) return;
			if (!valid) {
				this.active = undefined;
				this.settle(attempt.entry, "stale_dropped");
				this.requestPump();
				return;
			}
			if (
				this.userActive ||
				this.outputActive ||
				this.now() < this.lastFloorActivityAt + this.floorQuietMs
			) {
				this.active = undefined;
				this.queue.unshift(attempt.entry);
				this.requestPump();
				return;
			}
			this.startAttempt(attempt);
		} catch {
			this.finishAttempt(attempt.token, "failed");
		}
	}

	private startAttempt(attempt: ActiveAttempt): void {
		void this.options
			.speak({ text: attempt.entry.text, pendingKey: attempt.pendingKey })
			.then((outcome) => this.finishAttempt(attempt.token, outcome))
			.catch(() => this.finishAttempt(attempt.token, "failed"));
	}

	private finishAttempt(token: number, outcome: SpeechAttemptOutcome): void {
		const active = this.active;
		if (!active || active.token !== token) return;
		this.active = undefined;
		const entry = active.entry;
		if (outcome === "deferred" && !entry.retired) {
			this.defer(entry);
			this.requestPump();
			return;
		}
		this.settle(
			entry,
			outcome === "spoken"
				? "spoken"
				: outcome === "deferred"
					? "stale_dropped"
					: "failed",
		);
		this.requestPump();
	}

	/** Park an entry the speaker could not take because it was not live. */
	private defer(entry: QueueEntry): void {
		if (!this.retryable(entry.kind)) {
			this.settle(entry, "stale_dropped");
			return;
		}
		entry.deferrals += 1;
		if (entry.deferrals > this.maxDeferrals) {
			void this.fallback(entry);
			return;
		}
		entry.deferredUntil = this.now() + this.deferRetryMs;
		this.queue.unshift(entry);
		if (this.deferTimer !== undefined) this.cancelScheduled(this.deferTimer);
		this.deferTimer = this.schedule(() => {
			this.deferTimer = undefined;
			for (const queued of this.queue) queued.deferredUntil = undefined;
			this.requestPump();
		}, this.deferRetryMs);
	}

	private hasDeferred(): boolean {
		let found = false;
		for (const entry of this.queue) {
			if (entry.deferredUntil === undefined) continue;
			entry.deferredUntil = undefined;
			found = true;
		}
		return found;
	}

	private interruptActive(): void {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		this.attemptToken += 1;
		this.options.cancelSpeech(active.pendingKey);
		const entry = active.entry;
		if (!this.retryable(entry.kind)) {
			this.settle(entry, "stale_dropped");
			return;
		}
		entry.attempts += 1;
		if (entry.attempts > 2) {
			void this.fallback(entry);
			return;
		}
		if (!entry.text.startsWith(RESULT_PREFIX))
			entry.text = `${RESULT_PREFIX}${entry.text}`;
		this.queue.unshift(entry);
	}

	private retryable(kind: SpeechArbiterKind): boolean {
		return kind === "result" || kind === "tell" || kind === "agenda";
	}

	private async fallback(entry: QueueEntry): Promise<void> {
		if (!this.options.postThread || !entry.threadText) {
			this.settle(entry, "failed");
			return;
		}
		try {
			await this.options.postThread({
				businessId: entry.businessId,
				text: entry.threadText,
			});
			this.settle(entry, "fallback_posted");
			void this.enqueue({
				businessId: `${entry.businessId}:thread-pointer`,
				kind: "fallback",
				text: DEFAULT_POINTER,
			});
		} catch {
			this.settle(entry, "failed");
		}
	}

	private settle(entry: QueueEntry, outcome: SpeechArbiterTerminal): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.resolve(outcome);
	}

	private scheduleProviderFallback(): void {
		if (
			this.closed ||
			this.localUtterances.size > 0 ||
			this.providerSegments.size === 0 ||
			this.lastLocalEndAt === undefined
		)
			return;
		const quietSince = Math.max(
			this.lastLocalEndAt,
			this.lastRawVoiceAt ?? this.lastLocalEndAt,
		);
		const delay = Math.max(0, quietSince + this.providerStaleMs - this.now());
		if (this.providerTimer !== undefined)
			this.cancelScheduled(this.providerTimer);
		this.providerTimer = this.schedule(() => {
			this.providerTimer = undefined;
			this.pruneStaleProviderSegments();
		}, delay);
	}

	private pruneStaleProviderSegments(): void {
		if (this.lastLocalEndAt === undefined || this.localUtterances.size > 0)
			return;
		const quietSince = Math.max(
			this.lastLocalEndAt,
			this.lastRawVoiceAt ?? this.lastLocalEndAt,
		);
		if (this.now() - quietSince < this.providerStaleMs) {
			this.scheduleProviderFallback();
			return;
		}
		let removed = false;
		for (const [key, segment] of this.providerSegments) {
			if (segment.startedAt > this.lastLocalEndAt) continue;
			this.providerSegments.delete(key);
			removed = true;
		}
		if (removed) {
			this.floorActivity();
			this.requestPump();
		}
	}
}
