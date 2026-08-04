/**
 * FLY-1048 (Task A6): cheap gap/state scan — zero token, zero pane capture,
 * minutes-scale cadence (GatePoller piggyback, plan §2 A6).
 *
 * PR-A contract: OBSERVE ONLY. The scan produces SuspicionRecords into an
 * in-process registry (+ debug logs) so the focused-frame scheduler (A7) and
 * the PR-C unified escalation flow can consume them. No user-visible
 * notification is emitted from here.
 *
 * Readonly read contract (Codex R1 #6): comm.db is opened read-only WITHOUT
 * schema creation/migrations (CommDB.openReadonly precedent) — an old writer's
 * db may lack `runner_declared_states`, `delivered_at`, `checkpoint`, … Every
 * table/column is probed defensively (getEffectiveDeclaredState precedent):
 * missing → that judgement silently degrades to "no signal" (never throw,
 * never false-positive); an unopenable/missing db file → the whole project is
 * skipped this round (fail-closed).
 */

import Database from "better-sqlite3";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";

/** Outbound exec→lead comm signal. Discriminated so "none found" (a TRIGGER
 * condition for gap1) can never be confused with "unreadable" (degrade). */
export type OutboundSignal =
	| { readable: false }
	| { readable: true; latestAgeMs: number | null };

export interface GapCommEvidence {
	/** Effective declared park (FLY-626). null = table unreadable. */
	declaredParked: boolean | null;
	/** Live pending questions FROM this exec (any checkpoint, incl. NULL).
	 * null = unreadable → gap1 degrades (fail-closed). */
	pendingQuestionCount: number | null;
	/** Live pending BLOCKING gates (checkpoint IS NOT NULL) from this exec.
	 * The b_parked corroboration signal (PR-B): a non-blocking ask must NOT
	 * count as park evidence — that is exactly the 漏② gap. null = unreadable. */
	pendingBlockingGateCount: number | null;
	outbound: OutboundSignal;
	/** Age of the OLDEST live non-blocking ask (checkpoint IS NULL) without a
	 * response. null = none or unreadable (identical outcome: no trigger). */
	oldestUnansweredAskAgeMs: number | null;
	/** Codex R4 #1: false when the ask signal could not be READ (missing
	 * schema) — a null age then proves nothing, so gap2 is not "evaluated"
	 * and its episodes must not be absence-cleared. */
	askSignalReadable: boolean;
	/** Age of the OLDEST delivered-but-unread push instruction TO this exec.
	 * null = none or unreadable. Only the FLY-109 push path carries this
	 * evidence today; the Lead-mailbox consumption gap is PRD-bound (D7). */
	oldestUnconsumedDeliveryAgeMs: number | null;
	/** Codex R4 #1: readability of the unconsumed-delivery signal (as above). */
	unconsumedSignalReadable: boolean;
}

// ── readonly CommDB gap reader ──────────────────────────────────────────────

export interface GapReader {
	evidenceFor(
		execId: string,
		leadId: string | null,
		nowMs: number,
		/** FLY-1282 Part B: the SAME per-tick V2 snapshot the judgement
		 * functions receive — never read env here (Codex R10 #2). */
		opts?: { deliveryUnconsumedV2?: boolean },
	): GapCommEvidence;
	close(): void;
}

/** Missing-schema shapes that mean "signal unavailable", never a bug. */
const MISSING_SCHEMA = /no such (?:table|column)/i;

/**
 * Open a project's comm.db read-only for gap evidence. Missing/unopenable
 * file → null (caller skips the project this round, fail-closed).
 */
export function openGapReader(dbPath: string): GapReader | null {
	let db: Database.Database;
	try {
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
		db.pragma("busy_timeout = 5000");
	} catch {
		return null;
	}

	/** Run a query; missing table/column → fallback; other errors rethrow. */
	function probe<T>(fallback: T, run: () => T): T {
		try {
			return run();
		} catch (err) {
			if (MISSING_SCHEMA.test((err as Error).message)) return fallback;
			throw err;
		}
	}

	return {
		evidenceFor(execId, leadId, nowMs, opts) {
			const declaredParked = probe<boolean | null>(null, () => {
				const row = db
					.prepare(
						"SELECT kind, expires_at FROM runner_declared_states WHERE execution_id = ?",
					)
					.get(execId) as
					| { kind: string; expires_at: number | null }
					| undefined;
				if (!row) return false;
				if (row.expires_at !== null && row.expires_at <= nowMs) return false;
				return row.kind === "parked";
			});

			const pendingQuestionCount = probe<number | null>(null, () => {
				const row = db
					.prepare(
						`SELECT COUNT(*) AS n FROM messages q
						 WHERE q.from_agent = ? AND q.type = 'question'
						   AND q.expires_at > datetime('now')
						   AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response')`,
					)
					.get(execId) as { n: number };
				return row.n;
			});

			const pendingBlockingGateCount = probe<number | null>(null, () => {
				const row = db
					.prepare(
						`SELECT COUNT(*) AS n FROM messages q
						 WHERE q.from_agent = ? AND q.type = 'question' AND q.checkpoint IS NOT NULL
						   AND q.expires_at > datetime('now')
						   AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response')`,
					)
					.get(execId) as { n: number };
				return row.n;
			});

			const outbound = probe<OutboundSignal>({ readable: false }, () => {
				const row = db
					.prepare(
						`SELECT MAX(created_at) AS latest FROM messages
						 WHERE from_agent = ? AND (? IS NULL OR to_agent = ?)`,
					)
					.get(execId, leadId, leadId) as { latest: string | null };
				if (!row.latest) return { readable: true, latestAgeMs: null };
				const ts = parseSqliteUtcMs(row.latest);
				// Codex R5 #1: a NON-NULL timestamp that cannot be parsed is a
				// degraded signal, not "no traffic" — the judgement did not run.
				if (ts === null) return { readable: false };
				return { readable: true, latestAgeMs: Math.max(0, nowMs - ts) };
			});

			// Codex R4 #1: unreadable (missing schema) is NOT the same as "none" —
			// the readable bit records whether the judgement could actually run.
			const ask = probe<{ readable: boolean; ageMs: number | null }>(
				{ readable: false, ageMs: null },
				() => {
					const row = db
						.prepare(
							`SELECT MIN(created_at) AS oldest FROM messages q
							 WHERE q.from_agent = ? AND q.type = 'question' AND q.checkpoint IS NULL
							   AND q.expires_at > datetime('now')
							   AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = q.id AND r.type = 'response')`,
						)
						.get(execId) as { oldest: string | null };
					if (!row.oldest) return { readable: true, ageMs: null };
					const ts = parseSqliteUtcMs(row.oldest);
					// Codex R5 #1: non-null but unparsable = degraded, NOT "none".
					if (ts === null) return { readable: false, ageMs: null };
					return { readable: true, ageMs: Math.max(0, nowMs - ts) };
				},
			);

			const unconsumed = probe<{ readable: boolean; ageMs: number | null }>(
				{ readable: false, ageMs: null },
				() => {
					// FLY-1282 Part B (V2, Codex R11 #1 + R12 #1): exclude
					// instructions with a correlated consumption receipt — a later
					// message FROM the runner containing the FULL instruction id.
					// No delivered_at comparison (send.ts stamps delivered_at only
					// after the mailbox wake returns; a runner can legitimately
					// report before the stamp lands) — the full random id is
					// unknowable before delivery, so the id itself is the causal
					// proof. V1 (legacy) keeps the exact read_at-only query.
					const sql = opts?.deliveryUnconsumedV2
						? `SELECT MIN(m.delivered_at) AS oldest FROM messages m
						   WHERE m.to_agent = ? AND m.type = 'instruction'
						     AND m.delivered_at IS NOT NULL AND m.read_at IS NULL
						     AND NOT EXISTS (
						       SELECT 1 FROM messages r
						       WHERE r.from_agent = m.to_agent
						         AND instr(r.content, m.id) > 0
						     )`
						: `SELECT MIN(delivered_at) AS oldest FROM messages
						   WHERE to_agent = ? AND type = 'instruction'
						     AND delivered_at IS NOT NULL AND read_at IS NULL`;
					const row = db.prepare(sql).get(execId) as {
						oldest: string | null;
					};
					if (!row.oldest) return { readable: true, ageMs: null };
					const ts = parseSqliteUtcMs(row.oldest);
					// Codex R5 #1: non-null but unparsable = degraded, NOT "none".
					if (ts === null) return { readable: false, ageMs: null };
					return { readable: true, ageMs: Math.max(0, nowMs - ts) };
				},
			);

			return {
				declaredParked,
				pendingQuestionCount,
				pendingBlockingGateCount,
				outbound,
				oldestUnansweredAskAgeMs: ask.ageMs,
				askSignalReadable: ask.readable,
				oldestUnconsumedDeliveryAgeMs: unconsumed.ageMs,
				unconsumedSignalReadable: unconsumed.readable,
			};
		},
		close() {
			try {
				db.close();
			} catch {
				/* already closed */
			}
		},
	};
}
