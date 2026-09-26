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

export type GapSuspicionKind =
	| "gap1_parked_unreported" // 漏①: parked/awaiting-needs-human with NO reporting artifact
	| "gap2_ask_unanswered" // 漏②: non-blocking ask with no response past threshold
	| "delivery_unconsumed" // D6: delivered-but-unread push instruction past threshold
	| "pane_progress_suspect"; // stage/activity stall — feeds A7 focused frames ONLY

export interface SuspicionRecord {
	kind: GapSuspicionKind;
	/** Runner execution id. */
	targetKey: string;
	projectName: string;
	/** First time THIS (kind, target) condition was observed (registry keeps it). */
	firstSeenMs: number;
	/** One-line summary. NEVER pane text (this layer never captures panes). */
	evidence: string;
}

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

export interface GapScanInput {
	session: {
		executionId: string;
		projectName: string;
		status: string;
		lastActivityAtMs?: number | null;
	};
	comm: GapCommEvidence;
	/** Durable founder-notified evidence exists for this exec (session_events).
	 * null = unreadable → gap1 degrades (fail-closed). */
	founderNotified: boolean | null;
	nowMs: number;
	thresholds: GapThresholds;
}

export interface GapThresholds {
	/** gap2: unanswered non-blocking ask age (default 30min). */
	askUnansweredMs: number;
	/** delivery_unconsumed: delivered-but-unread age (default 30min). */
	unconsumedMs: number;
	/** pane_progress_suspect: running-session activity stall (default 45min). */
	progressStallMs: number;
	/** gap1: "no recent exec→lead comm" window (default 30min). */
	commWindowMs: number;
}

export function defaultGapThresholds(env: NodeJS.ProcessEnv): GapThresholds {
	const num = (name: string, fallback: number): number => {
		const v = Number.parseInt(env[name] ?? "", 10);
		return Number.isFinite(v) && v > 0 ? v : fallback;
	};
	return {
		askUnansweredMs: num("FLYWHEEL_GAP_ASK_UNANSWERED_MS", 1_800_000),
		unconsumedMs: num("FLYWHEEL_GAP_UNCONSUMED_MS", 1_800_000),
		progressStallMs: num("FLYWHEEL_GAP_PROGRESS_STALL_MS", 2_700_000),
		commWindowMs: num("FLYWHEEL_GAP_COMM_WINDOW_MS", 1_800_000),
	};
}

/** Session statuses that mean "waiting on a human" for the gap1 judgement. */
const AWAITING_HUMAN_STATUSES = new Set([
	"awaiting_review",
	"approved_to_ship",
]);

/**
 * Pure judgement matrix. Every trigger is a MULTI-condition AND (risk list #1:
 * the two-gap semantics must not turn park/ask from suppression into spam) and
 * every judgement degrades to silence when a required signal is unreadable.
 */
export function evaluateGapSuspicion(input: GapScanInput): SuspicionRecord[] {
	const { session, comm, founderNotified, nowMs, thresholds } = input;
	const out: SuspicionRecord[] = [];
	const base = {
		targetKey: session.executionId,
		projectName: session.projectName,
		firstSeenMs: nowMs,
	};

	// gap1 漏①: parked (declared) or awaiting-needs-human, with NO reporting
	// artifact anywhere: no pending question, no recent exec→lead message, no
	// founder-notified evidence. Any unreadable signal → silent (fail-closed).
	const parkedish =
		comm.declaredParked === true || AWAITING_HUMAN_STATUSES.has(session.status);
	if (
		parkedish &&
		comm.pendingQuestionCount === 0 &&
		comm.outbound.readable &&
		(comm.outbound.latestAgeMs === null ||
			comm.outbound.latestAgeMs > thresholds.commWindowMs) &&
		founderNotified === false
	) {
		out.push({
			...base,
			kind: "gap1_parked_unreported",
			evidence: `parked/awaiting (${comm.declaredParked === true ? "declared park" : session.status}) with no pending question, no lead comm in window, no founder-notified evidence`,
		});
	}

	// gap2 漏②: a non-blocking ask nobody answered past the threshold.
	if (
		comm.oldestUnansweredAskAgeMs !== null &&
		comm.oldestUnansweredAskAgeMs >= thresholds.askUnansweredMs
	) {
		out.push({
			...base,
			kind: "gap2_ask_unanswered",
			evidence: `non-blocking ask unanswered for ${Math.round(comm.oldestUnansweredAskAgeMs / 60_000)}min`,
		});
	}

	// D6: delivered-but-unread push instruction past the threshold.
	if (
		comm.oldestUnconsumedDeliveryAgeMs !== null &&
		comm.oldestUnconsumedDeliveryAgeMs >= thresholds.unconsumedMs
	) {
		out.push({
			...base,
			kind: "delivery_unconsumed",
			evidence: `push delivery unconsumed for ${Math.round(comm.oldestUnconsumedDeliveryAgeMs / 60_000)}min`,
		});
	}

	// pane_progress_suspect: an active session whose activity stamp stalled.
	// NOT an alert — it queues the target for focused frames (A7).
	if (
		session.status === "running" &&
		session.lastActivityAtMs != null &&
		nowMs - session.lastActivityAtMs >= thresholds.progressStallMs
	) {
		out.push({
			...base,
			kind: "pane_progress_suspect",
			evidence: `running with no recorded activity for ${Math.round((nowMs - session.lastActivityAtMs) / 60_000)}min`,
		});
	}

	return out;
}

/**
 * Codex R4 #1/#2: the kinds whose judgement COMPLETELY ran for this input —
 * every required signal readable, so the absence of a suspicion record is
 * durable "condition cleared" evidence. A kind outside this set was degraded
 * (missing schema / unreadable founder evidence / unknowable parkedish), and
 * its episodes must NOT be absence-cleared this pass. Targets that were never
 * evaluated at all (skipped project, non-active keep-alive session) simply
 * contribute nothing here — conservatively held, never falsely resolved.
 */
export function evaluatedGapConditions(
	input: GapScanInput,
): Set<Exclude<GapSuspicionKind, "pane_progress_suspect">> {
	const { session, comm, founderNotified } = input;
	const out = new Set<Exclude<GapSuspicionKind, "pane_progress_suspect">>();
	const parkedishKnowable =
		comm.declaredParked !== null || AWAITING_HUMAN_STATUSES.has(session.status);
	if (
		parkedishKnowable &&
		comm.pendingQuestionCount !== null &&
		comm.outbound.readable &&
		founderNotified !== null
	) {
		out.add("gap1_parked_unreported");
	}
	if (comm.askSignalReadable) out.add("gap2_ask_unanswered");
	if (comm.unconsumedSignalReadable) out.add("delivery_unconsumed");
	return out;
}

// ── in-process suspicion registry ──────────────────────────────────────────

export interface SuspicionRegistry {
	/** Replace the active set with this sweep's records, preserving each
	 * surviving (kind, target) pair's original firstSeenMs. Records absent
	 * from the sweep are dropped (the condition cleared). */
	sweep(records: SuspicionRecord[], nowMs: number): void;
	snapshot(): SuspicionRecord[];
}

export function createSuspicionRegistry(): SuspicionRegistry {
	let active = new Map<string, SuspicionRecord>();
	const keyOf = (r: SuspicionRecord) => `${r.kind}|${r.targetKey}`;
	return {
		sweep(records) {
			const next = new Map<string, SuspicionRecord>();
			for (const record of records) {
				const key = keyOf(record);
				const prior = active.get(key);
				next.set(
					key,
					prior ? { ...record, firstSeenMs: prior.firstSeenMs } : record,
				);
			}
			active = next;
		},
		snapshot() {
			return [...active.values()];
		},
	};
}

// ── readonly CommDB gap reader ──────────────────────────────────────────────

export interface GapReader {
	evidenceFor(
		execId: string,
		leadId: string | null,
		nowMs: number,
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
		evidenceFor(execId, leadId, nowMs) {
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
					const row = db
						.prepare(
							`SELECT MIN(delivered_at) AS oldest FROM messages
							 WHERE to_agent = ? AND type = 'instruction'
							   AND delivered_at IS NOT NULL AND read_at IS NULL`,
						)
						.get(execId) as { oldest: string | null };
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
