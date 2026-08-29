/**
 * HeadphoneQueue — the §17 FIFO of founder-facing messages (FLY-546 B1-2).
 *
 * Pure in-memory structure with snapshot/restore hooks; the daemon owns
 * persistence (onPersist fires on every mutation). Dedupe is by Discord
 * messageId and survives shift + restore, so a re-delivered gateway event
 * or an offline-backfill overlap never announces the same message twice.
 */

export type QueueItem = {
	id: string;
	messageId: string;
	channelId: string;
	agentId: string;
	/** original Discord author (the Lead bot) — relayed replies @ it. */
	authorId?: string;
	kind: "normal" | "ship_gate";
	headline: {
		agentDisplay: string;
		issueRef?: string;
		issueTitle?: string;
		stageHint?: string;
	};
	body: string;
	enqueuedAt: string;
	gate?: {
		gateMessageId: string;
		questionId: string;
		prHeadSha: string;
		issueId: string;
		prNumber?: number;
	};
	/**
	 * Side-effect ledger (Codex R1 #2): after a crash the daemon resumes from
	 * the recorded external side-effect ids and suppresses duplicates — a
	 * relayed reply / receipt card / approval call is NEVER re-sent. Each
	 * completed side effect is persisted immediately.
	 */
	sideEffects?: {
		sentMessageId?: string;
		receiptMessageId?: string;
		approvalAttemptId?: string;
	};
};

export type QueueSnapshot = {
	items: QueueItem[];
	seenMessageIds: string[];
};

export interface HeadphoneQueueOptions {
	onPersist?: () => void;
}

export class HeadphoneQueue {
	private items: QueueItem[] = [];
	private seen = new Set<string>();

	constructor(private readonly opts: HeadphoneQueueOptions = {}) {}

	/** @returns false when the messageId was already seen (deduped). */
	push(item: QueueItem): boolean {
		if (this.seen.has(item.messageId)) return false;
		this.seen.add(item.messageId);
		this.items.push(item);
		this.opts.onPersist?.();
		return true;
	}

	peek(): QueueItem | undefined {
		return this.items[0];
	}

	shift(): QueueItem | undefined {
		const item = this.items.shift();
		if (item) this.opts.onPersist?.();
		return item;
	}

	/** Put an item back at the tail (silence / pause / unclear-twice). */
	defer(item: QueueItem): void {
		this.items.push(item);
		this.opts.onPersist?.();
	}

	/** Put an item back at the head (disconnect-grace recovery resumes it). */
	deferToFront(item: QueueItem): void {
		this.items.unshift(item);
		this.opts.onPersist?.();
	}

	size(): number {
		return this.items.length;
	}

	snapshot(): QueueSnapshot {
		return {
			items: structuredClone(this.items),
			seenMessageIds: [...this.seen],
		};
	}

	restore(snap: QueueSnapshot): void {
		this.items = structuredClone(snap.items);
		this.seen = new Set(snap.seenMessageIds);
		this.opts.onPersist?.();
	}
}
