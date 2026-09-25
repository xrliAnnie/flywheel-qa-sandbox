/**
 * FLY-2869 — a CommDB row that says `running` while no process or lease backs
 * it (2519/2608/2619 on 2026-09-25) must not block readiness forever, but one
 * `ps` that happened to miss a restarting daemon must not exempt it either
 * (Lead ruling 0a4b84d5 + Q3). The absence has to hold across consecutive
 * complete collections for at least 60 s, measured on a monotonic clock from
 * the moment the first confirming collection COMMITTED.
 */

const MATURE_AFTER_MS = 60_000;
const SQLITE_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/** SQLite CURRENT_TIMESTAMP is UTC; reject anything else, including 02-30. */
export function parseSqliteUtcTimestamp(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = SQLITE_TIMESTAMP_RE.exec(value);
	if (!match) return null;
	const rewritten = `${match[1]}T${match[2]}Z`;
	const parsed = new Date(rewritten);
	if (
		!Number.isFinite(parsed.getTime()) ||
		`${parsed.toISOString().slice(0, 19)}Z` !== rewritten
	)
		return null;
	return parsed.getTime();
}

export interface StaleRunningRound {
	generation: number;
	startedAt: number;
}

export class StaleRunningTracker {
	private started = 0;
	private lastCommitted = 0;
	/** key -> monotonic time the first confirming round committed. */
	private readonly firstConfirmedAt = new Map<string, number>();

	begin(startedAt: number): StaleRunningRound {
		return { generation: ++this.started, startedAt };
	}

	/**
	 * Commit a complete round's candidates; returns the keys that matured. A
	 * round older than the last committed one changes nothing and matures nothing.
	 */
	commit(
		round: StaleRunningRound,
		candidates: ReadonlySet<string>,
		committedAt: number,
	): Set<string> {
		const matured = new Set<string>();
		if (round.generation <= this.lastCommitted) return matured;
		this.lastCommitted = round.generation;
		for (const key of [...this.firstConfirmedAt.keys()])
			if (!candidates.has(key)) this.firstConfirmedAt.delete(key);
		for (const key of candidates) {
			const first = this.firstConfirmedAt.get(key);
			if (first === undefined) this.firstConfirmedAt.set(key, committedAt);
			else if (round.startedAt >= first + MATURE_AFTER_MS) matured.add(key);
		}
		return matured;
	}

	/** An incomplete round breaks every sustained-absence streak. */
	fail(round: StaleRunningRound): void {
		if (round.generation <= this.lastCommitted) return;
		this.lastCommitted = round.generation;
		this.firstConfirmedAt.clear();
	}
}
