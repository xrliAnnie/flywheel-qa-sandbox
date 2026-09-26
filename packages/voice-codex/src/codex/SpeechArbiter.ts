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
}

type SpeechAttemptOutcome = "spoken" | "failed";

interface QueueEntry extends SpeechArbiterRequest {
	attempts: number;
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
		this.queue.push({ ...request, attempts: 0, settled: false, resolve });
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
		if (removed) {
			this.floorActivity();
			this.requestPump();
		}
	}

	outputState(active: boolean): void {
		if (this.outputActive === active) return;
		this.outputActive = active;
		this.floorActivity();
		if (!active) this.requestPump();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.pumpTimer !== undefined) this.cancelScheduled(this.pumpTimer);
		if (this.providerTimer !== undefined)
			this.cancelScheduled(this.providerTimer);
		this.pumpTimer = undefined;
		this.providerTimer = undefined;
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
			const entry = this.queue.shift()!;
			if (entry.settled) continue;
			if (entry.expiresAt !== undefined && this.now() >= entry.expiresAt) {
				this.settle(entry, "stale_dropped");
				continue;
			}
			const pendingKey = `${entry.businessId}:attempt:${entry.attempts}`;
			const token = ++this.attemptToken;
			this.active = { entry, pendingKey, token };
			void this.options
				.speak({ text: entry.text, pendingKey })
				.then((outcome) => this.finishAttempt(token, outcome))
				.catch(() => this.finishAttempt(token, "failed"));
			return;
		}
	}

	private finishAttempt(token: number, outcome: SpeechAttemptOutcome): void {
		const active = this.active;
		if (!active || active.token !== token) return;
		this.active = undefined;
		this.settle(active.entry, outcome === "spoken" ? "spoken" : "failed");
		this.requestPump();
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
