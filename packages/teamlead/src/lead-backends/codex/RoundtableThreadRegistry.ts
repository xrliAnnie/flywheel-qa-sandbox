export interface SubscriptionEntry {
	threadId: string;
	parentChannelId: string;
	source: "mention" | "discovery" | "restore";
	subscribedAt: string;
	lastActivityAt: string;
	expiresAt: string;
}
export interface RegistrySnapshot {
	version: 1;
	entries: SubscriptionEntry[];
}
export type SubscriptionInput = Partial<SubscriptionEntry> & {
	threadId: string;
};
export interface RestoreDrop {
	entry: SubscriptionEntry;
	why: "wrong_parent" | "expired" | "duplicate" | "over_cap";
}

/** Shared membership authority. Durable callers must persist a plan before commit. */
export class RoundtableThreadRegistry {
	private state: RegistrySnapshot = { version: 1, entries: [] };
	private readonly ttlMs: number;
	private readonly cap: number;
	private readonly now: () => number;
	constructor(opts: { ttlMs?: number; cap?: number; now?: () => number } = {}) {
		this.ttlMs = opts.ttlMs ?? Infinity;
		this.cap = opts.cap ?? Infinity;
		this.now = opts.now ?? Date.now;
	}
	private deadline(now: number): string {
		return new Date(Math.min(now + this.ttlMs, 8640000000000000)).toISOString();
	}
	add(input: string | SubscriptionInput): boolean {
		const plan = this.planAdd(
			typeof input === "string" ? { threadId: input } : input,
		);
		this.commit(plan.next);
		return plan.added;
	}
	remove(threadId: string): boolean {
		const plan = this.planRemove(threadId);
		this.commit(plan.next);
		return plan.removed;
	}
	touch(threadId: string): boolean {
		const plan = this.planTouch(threadId);
		this.commit(plan.next);
		return plan.touched;
	}
	has(threadId: string): boolean {
		return this.state.entries.some(
			(e) => e.threadId === threadId && Date.parse(e.expiresAt) > this.now(),
		);
	}
	list(): string[] {
		return this.entries()
			.filter((e) => Date.parse(e.expiresAt) > this.now())
			.map((e) => e.threadId);
	}
	entries(): SubscriptionEntry[] {
		return this.state.entries.map((e) => ({ ...e }));
	}
	snapshot(): RegistrySnapshot {
		return { version: 1, entries: this.entries() };
	}
	get size(): number {
		return this.list().length;
	}
	oldest(): string | undefined {
		return this.list()[0];
	}
	commit(next: RegistrySnapshot): void {
		this.state = { version: 1, entries: next.entries.map((e) => ({ ...e })) };
	}
	planAdd(input: SubscriptionInput): {
		next: RegistrySnapshot;
		added: boolean;
		evicted: SubscriptionEntry[];
	} {
		const next = this.snapshot();
		if (!input.threadId || this.has(input.threadId))
			return { next, added: false, evicted: [] };
		const now = this.now();
		const evicted = next.entries.filter((e) => Date.parse(e.expiresAt) <= now);
		next.entries = next.entries.filter((e) => Date.parse(e.expiresAt) > now);
		next.entries.push({
			threadId: input.threadId,
			parentChannelId: input.parentChannelId ?? "",
			source: input.source ?? "mention",
			subscribedAt: input.subscribedAt ?? new Date(now).toISOString(),
			lastActivityAt: input.lastActivityAt ?? new Date(now).toISOString(),
			expiresAt: input.expiresAt ?? this.deadline(now),
		});
		while (next.entries.length > this.cap) {
			const entry = next.entries.shift();
			if (entry) evicted.push(entry);
		}
		return { next, added: true, evicted };
	}
	planRemove(threadId: string): { next: RegistrySnapshot; removed: boolean } {
		const next = this.snapshot();
		const before = next.entries.length;
		next.entries = next.entries.filter((e) => e.threadId !== threadId);
		return { next, removed: next.entries.length !== before };
	}
	planTouch(threadId: string): { next: RegistrySnapshot; touched: boolean } {
		const next = this.snapshot();
		const entry = next.entries.find((e) => e.threadId === threadId);
		if (!entry || !this.has(threadId)) return { next, touched: false };
		const now = this.now();
		entry.lastActivityAt = new Date(now).toISOString();
		entry.expiresAt = this.deadline(now);
		return { next, touched: true };
	}
	planSweep(): { next: RegistrySnapshot; expired: SubscriptionEntry[] } {
		const entries = this.entries();
		const now = this.now();
		return {
			next: {
				version: 1,
				entries: entries.filter((e) => Date.parse(e.expiresAt) > now),
			},
			expired: entries.filter((e) => Date.parse(e.expiresAt) <= now),
		};
	}
	planRestore(
		snapshot: RegistrySnapshot,
		expectedParentChannelId?: string,
	): {
		next: RegistrySnapshot;
		restored: SubscriptionEntry[];
		dropped: RestoreDrop[];
	} {
		const dropped: RestoreDrop[] = [];
		const kept = new Map<string, SubscriptionEntry>();
		const seen = new Set<string>();
		for (const entry of [...snapshot.entries].sort(
			(a, b) => Date.parse(b.subscribedAt) - Date.parse(a.subscribedAt),
		)) {
			const why =
				expectedParentChannelId !== undefined &&
				entry.parentChannelId !== expectedParentChannelId
					? "wrong_parent"
					: Date.parse(entry.expiresAt) <= this.now()
						? "expired"
						: seen.has(entry.threadId)
							? "duplicate"
							: kept.size >= this.cap
								? "over_cap"
								: undefined;
			if (why) dropped.push({ entry: { ...entry }, why });
			else kept.set(entry.threadId, { ...entry });
			if (why !== "wrong_parent" && why !== "expired") seen.add(entry.threadId);
		}
		const restored = [...kept.values()].reverse();
		return { next: { version: 1, entries: restored }, restored, dropped };
	}
}
