/**
 * FeedPipeline (FLY-545 PR-2 P10′) — the huddle's silent context feed,
 * designed as a FIRST-CLASS citizen (FLY-968's negative control: a session
 * that misses feed entries confidently fabricates meeting facts — a lossy
 * feed is worse than no feed).
 *
 * The pipeline keeps an append-only meeting journal (founder final
 * transcripts + each speaking Lead's output transcription, speaker-labelled)
 * and fans every entry out to all registered sessions except the ones that
 * ALREADY heard it first-hand (the addressed session heard the founder's
 * audio; a speaking Lead heard its own words). Delivery is tracked with a
 * per-session cursor:
 *
 *  - inject() throws → the cursor stays put and the entry is retried on the
 *    next append (or an explicit retry()); after maxFailures consecutive
 *    misses the onLag callback fires ONCE (TIV surfaces "context sync
 *    lagging" — fail-visible, never silent) until a delivery succeeds.
 *  - a session resumed via rotator keeps its Gemini-side context, so nothing
 *    re-delivers; a session REBUILT from scratch calls replay() to get the
 *    whole journal again.
 *
 * The journal is also the single source for the recap/summary path
 * (transcriptSnapshot), so what the Leads were fed and what lands in the
 * kickoff issue can never diverge.
 */

export interface FeedEntry {
	seq: number;
	/** display label, e.g. "Annie" / "Tadashi". */
	speaker: string;
	text: string;
	/** ISO timestamp (verbatim-quote anchor for the summary). */
	ts: string;
	/** leadIds that heard this first-hand — skipped, cursor still advances. */
	exclude: string[];
}

export interface FeedTarget {
	/** silent context injection (ConversationSession.injectContext). throws = retry. */
	inject(text: string): void;
}

export interface FeedPipelineOptions {
	/** consecutive delivery failures per session before onLag fires. default 3. */
	maxFailures?: number;
	/** fail-visible hook (TIV warning). fires once per lag episode. */
	onLag?: (leadId: string, failedCount: number) => void;
	now?: () => Date;
}

const DEFAULT_MAX_FAILURES = 3;

export class FeedPipeline {
	private readonly journal: FeedEntry[] = [];
	private readonly targets = new Map<string, FeedTarget>();
	private readonly cursors = new Map<string, number>();
	private readonly failures = new Map<string, number>();
	private readonly lagged = new Set<string>();

	constructor(private readonly opts: FeedPipelineOptions = {}) {}

	register(leadId: string, target: FeedTarget): void {
		this.targets.set(leadId, target);
		// a late joiner starts at the head — use replay() to backfill instead.
		if (!this.cursors.has(leadId))
			this.cursors.set(leadId, this.journal.length);
	}

	unregister(leadId: string): void {
		this.targets.delete(leadId);
	}

	/** append one meeting fact and fan it out to every lagging-or-current session. */
	append(e: { speaker: string; text: string; exclude?: string[] }): FeedEntry {
		const entry: FeedEntry = {
			seq: this.journal.length,
			speaker: e.speaker,
			text: e.text,
			ts: (this.opts.now?.() ?? new Date()).toISOString(),
			exclude: e.exclude ?? [],
		};
		this.journal.push(entry);
		for (const leadId of this.targets.keys()) this.drain(leadId);
		return entry;
	}

	/** re-attempt pending deliveries (rotator settled, transient error passed). */
	retry(): void {
		for (const leadId of this.targets.keys()) this.drain(leadId);
	}

	/** full-journal re-delivery for a session rebuilt WITHOUT resume. */
	replay(leadId: string): void {
		this.cursors.set(leadId, 0);
		this.failures.set(leadId, 0);
		this.drain(leadId);
	}

	/** formatted journal — recap/summary source AND fresh-session preamble. */
	transcriptSnapshot(): string {
		return this.journal
			.map((e) => `[${e.ts}] ${e.speaker}: ${e.text}`)
			.join("\n");
	}

	entries(): readonly FeedEntry[] {
		return this.journal;
	}

	/** entries not yet delivered to this session (observability). */
	backlog(leadId: string): number {
		const cursor = this.cursors.get(leadId);
		if (cursor === undefined) return 0;
		let pending = 0;
		for (let i = cursor; i < this.journal.length; i++) {
			if (!this.journal[i]?.exclude.includes(leadId)) pending++;
		}
		return pending;
	}

	private drain(leadId: string): void {
		const target = this.targets.get(leadId);
		if (!target) return;
		let cursor = this.cursors.get(leadId) ?? this.journal.length;
		while (cursor < this.journal.length) {
			const entry = this.journal[cursor];
			if (!entry) break;
			if (entry.exclude.includes(leadId)) {
				cursor++;
				continue;
			}
			try {
				target.inject(`[会议记录] ${entry.speaker}: ${entry.text}`);
			} catch {
				const failed = (this.failures.get(leadId) ?? 0) + 1;
				this.failures.set(leadId, failed);
				const max = this.opts.maxFailures ?? DEFAULT_MAX_FAILURES;
				if (failed >= max && !this.lagged.has(leadId)) {
					this.lagged.add(leadId);
					this.opts.onLag?.(leadId, failed);
				}
				break; // keep order: never skip past an undelivered entry
			}
			cursor++;
			this.failures.set(leadId, 0);
			this.lagged.delete(leadId);
		}
		this.cursors.set(leadId, cursor);
	}
}
