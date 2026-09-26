/**
 * FLY-195: Stuck-runner detector — the per-session orchestration layer.
 *
 * Wraps the pure `evaluateStuckCandidate` logic with the I/O it needs:
 *   - capture the runner's terminal (FAIL-CLOSED on error — never treat a
 *     tmux/CommDB probe failure as "stuck"; lesson from FLY-191 PR #213 R1,
 *     where a probe error was misread as "dead" and could reap a live runner);
 *   - query "legitimately parked" predicates (pending gate / recent CommDB
 *     activity (FLY-253 L1) / pending review);
 *   - maintain the per-execution stuck-episode map (separate from the FLY-92
 *     idle state — Codex R1 LOW-8);
 *   - emit a `runner_stuck_escalation` once per episode (dedup) to the owning
 *     Lead via an injected emitter.
 *
 * FLY-253 (L2): Lead dispositions can be EXECUTION-scoped (sentinel row,
 * episode_fingerprint='*') so one `legitimate_wait` latches the whole runner
 * instead of one pane frame — the LEARN-57 incident was a disposition
 * treadmill where every pane change spawned a new episode that invalidated
 * the Lead's receipt. Timed receipts (snooze / TTL'd latches) expire into a
 * one-shot "reminder" that re-asks the LEAD (not Annie) once.
 *
 * All dependencies are injected so this is unit-testable without tmux/DB/Bridge.
 * It owns NO timer — the caller (RunnerIdleWatchdog) drives it from the existing
 * 30s poll (FLY-169: no new periodic timers).
 */

import type { Session, StuckDispositionRow } from "../StateStore.js";
import {
	evaluateStuckCandidate,
	type StuckCandidateResult,
	type StuckEpisodeState,
	type StuckEvidence,
} from "./stuck-candidate.js";

/**
 * Q7 fallback grace (plan §3.6): how long after escalating to the owning Lead
 * the Bridge waits for a disposition receipt before paging Annie directly
 * (`runner_stuck_unhandled`). Covers "Lead is down / also stuck".
 */
export const LEAD_GRACE_MS = 300_000;

/** Result of capturing a runner's terminal. Discriminated union, fail-closed. */
export type CaptureOutcome =
	| { ok: true; output: string }
	| { ok: false; error: string };

/**
 * FLY-253: the two CommDB liveness signals, probed together (ONE readonly
 * open per session per poll — the production probe lives in
 * stuck-escalation.ts `probeCommSignalsFromCommDb`).
 */
export interface CommSignals {
	/** Runner has an unanswered gate question (legitimately parked). */
	hasPendingGate: boolean;
	/** Runner sent ANY CommDB message within the activity window (L1). */
	hasRecentOutbound: boolean;
}

export interface StuckEscalationPayload {
	session: Session;
	evidence: StuckEvidence;
	/** Episode fingerprint — stable per stuck episode; used for dedup/disposition. */
	episodeFingerprint: string;
	/** Wall-clock ms when this episode's output first stagnated. */
	episodeStartedAt: number;
}

/** Payload for the Q7 fallback Annie alert (no raw pane content — privacy). */
export interface StuckUnhandledPayload {
	session: Session;
	episodeFingerprint: string;
	/** Whole minutes the output has been unchanged at alert time. */
	stuckMinutes: number;
	/** Wall-clock ms when the Lead escalation was emitted. */
	escalatedAt: number;
	/** FLY-927 (W-B): the episode classified as a 529 throttle STALL. */
	throttleStalled?: boolean;
}

/** Both rows that can govern one episode (FLY-253 L2). */
export interface StuckDispositionRows {
	/** Row keyed to this exact episode fingerprint. */
	exact?: StuckDispositionRow;
	/** Execution-scoped sentinel row (episode_fingerprint='*'). */
	sentinel?: StuckDispositionRow;
}

/** The row chosen by precedence, and whether it currently suppresses. */
export interface StuckDispositionSelection {
	row: StuckDispositionRow;
	effective: boolean;
}

export interface StuckRunnerDetectorDeps {
	/**
	 * Capture the runner's terminal output. MUST return { ok:false } on any
	 * tmux/CommDB error rather than throwing or returning empty output — the
	 * detector fails closed on capture errors (never escalates on a blind poll).
	 */
	capture: (
		executionId: string,
		projectName: string,
	) => Promise<CaptureOutcome>;
	/**
	 * Probe BOTH CommDB liveness signals (pending gate + recent outbound) in
	 * one call (FLY-253 L1: one readonly open per session per poll). Throwing
	 * fails closed — the session is treated as parked for this poll.
	 */
	probeCommSignals: (executionId: string, projectName: string) => CommSignals;
	/**
	 * True ⇒ durable "awaiting review" signal even if status row not yet flipped
	 * (gray zone). Default derives from the session's decision_route.
	 */
	hasPendingReviewSignal?: (session: Session) => boolean;
	/**
	 * Emit a runner_stuck_escalation to the owning Lead. Returns true if persisted
	 * (delivery may be retried by the guardrail pipeline).
	 */
	emit: (payload: StuckEscalationPayload) => Promise<boolean>;
	/**
	 * Decision-time session re-read (plan §3.1.3; Codex PR review R1
	 * MEDIUM-2): the caller's session object is a poll-start snapshot — if
	 * `/events` flips the session to awaiting_review / approved_to_ship /
	 * needs_review while the poll is in flight, the stale `running` snapshot
	 * must NOT escalate. Returning undefined means the session is gone
	 * (episode cleared). A thrown error fails closed (skip this poll).
	 */
	refreshSession?: (executionId: string) => Session | undefined;
	/**
	 * Read BOTH persisted Lead disposition rows for one episode (FLY-253 L2):
	 * the exact-fingerprint row and the execution-scoped '*' sentinel. The
	 * detector picks between them via `selectStuckDisposition` (a) before
	 * re-paging the Lead (Bridge-restart rebuild, Codex R1 LOW-7) and (b) in
	 * the Q7 fallback durable re-read (Codex R2 LOW-R2-2).
	 */
	getDispositionRows?: (
		executionId: string,
		episodeFingerprint: string,
	) => StuckDispositionRows;
	/**
	 * FLY-253 (Codex R2 #2): delete CURRENTLY-EXPIRED timed rows among
	 * {exact, '*'} — an expired receipt is a ONE-SHOT reminder token. Must
	 * guard with `snooze_until_ms <= now` so a concurrently-refreshed row
	 * survives.
	 *
	 * REQUIRED (Codex code R1 MEDIUM-4): an optional consumer silently
	 * recreates the infinite-reminder treadmill if a future wiring forgets it
	 * (expired rows never consumed ⇒ Lead re-reminded every generation, Annie
	 * never paged). The escalation path treats a throw as fail-closed (roll
	 * back + retry); the Q7 path resets the episode (see maybeAlertUnhandled —
	 * Codex code R1 HIGH-2).
	 */
	consumeExpiredDispositions: (
		executionId: string,
		episodeFingerprint: string,
		nowMs: number,
	) => void;
	/**
	 * Q7 fallback (plan §3.6): page Annie about an episode no Lead disposed of
	 * within the grace window. MUST dedup internally per eventId
	 * `runner-stuck-unhandled:${execution_id}:${fingerprint}:${escalatedAt}`
	 * (the LeadAlertNotifier claims path; escalatedAt is the generation salt —
	 * FLY-253 Codex R2 #3: a fingerprint-only id would let the persistent
	 * claims dedup swallow the fallback for a post-re-arm/TTL second
	 * generation). Returns true once the alert is claimed / sent so the
	 * detector marks the episode resolved; false/throw ⇒ retry next poll.
	 */
	alertUnhandled?: (payload: StuckUnhandledPayload) => Promise<boolean>;
	/** Grace before the Q7 fallback fires (default LEAD_GRACE_MS). */
	graceMs?: number;
	/**
	 * FLY-1048 PR-C (C4a): true when the UNIFIED detection-escalation flow owns
	 * an ACTIVE episode (detection_escalations row, status != RESOLVED) for
	 * this (executionId, episodeFingerprint) — the old emitters
	 * (runner_stuck_escalation + Q7 runner_stuck_unhandled/runner_throttle_
	 * stalled) skip so the Lead/founder is never double-paged for one episode.
	 * The guard is consulted EVERY poll (a short-circuit, not a hand-over):
	 * the moment the unified row goes inactive while the runner is STILL
	 * frozen, the old flow resumes — "C is never missed" outranks tidiness.
	 * A throw is treated as not-owned (fail toward alerting). Absent (env
	 * FLYWHEEL_DETECTION_ESCALATION unset → the plugin never wires it) =
	 * pre-PR-C behavior byte-for-byte.
	 */
	unifiedOwnsEpisode?: (
		executionId: string,
		episodeFingerprint: string,
	) => boolean;
	/** Injectable clock. */
	now?: () => number;
	/** Override the stagnation threshold (default from stuck-candidate). */
	thresholdMs?: number;
	/** Optional structured logger for exclusions/skips. */
	log?: (msg: string) => void;
}

/**
 * True when a disposition row currently suppresses.
 *
 * FLY-253: generalized to TIME-BOUNDED semantics — any row with a non-NULL
 * `snooze_until_ms` suppresses only until that instant (snooze AND the TTL'd
 * execution latches both ride this). A NULL row is a terminal receipt
 * (episode-level false_positive / handled_remanaged, or a TTL=0 permanent
 * latch). Exception kept from FLY-195: a `snooze` row with a missing
 * timestamp is malformed and never suppresses (fail toward alerting).
 */
export function dispositionSuppresses(
	row: StuckDispositionRow | undefined,
	now: number,
): boolean {
	if (!row) return false;
	if (row.disposition === "snooze") {
		return row.snooze_until_ms != null && row.snooze_until_ms > now;
	}
	if (row.snooze_until_ms != null) return row.snooze_until_ms > now;
	return true;
}

/**
 * FLY-253 (Codex R1 #3): precedence between the exact row and the execution
 * sentinel. ANY currently-effective row suppresses (effective exact wins for
 * attribution); only when neither is effective does an expired row surface —
 * it drives the one-shot reminder reset. An unconditional exact-first pick
 * would let an expired exact snooze shadow an active sentinel legitimate_wait
 * and re-open the alert treadmill.
 */
export function selectStuckDisposition(
	rows: StuckDispositionRows,
	now: number,
): StuckDispositionSelection | undefined {
	const { exact, sentinel } = rows;
	if (exact && dispositionSuppresses(exact, now)) {
		return { row: exact, effective: true };
	}
	if (sentinel && dispositionSuppresses(sentinel, now)) {
		return { row: sentinel, effective: true };
	}
	if (exact) return { row: exact, effective: false };
	if (sentinel) return { row: sentinel, effective: false };
	return undefined;
}

/**
 * An expired selection only triggers the reminder reset when it is a TIMED
 * receipt that lapsed (snooze / TTL latch). A malformed untimed snooze is
 * treated as "no receipt" (pre-FLY-253 posture: missing ts never suppresses,
 * and must not loop reminders either).
 */
function isExpiredTimedReceipt(
	selection: StuckDispositionSelection | undefined,
): boolean {
	return (
		selection !== undefined &&
		!selection.effective &&
		selection.row.snooze_until_ms != null
	);
}

/** Default gray-zone predicate: a needs_review route is a pending-review signal. */
export function defaultHasPendingReviewSignal(session: Session): boolean {
	return session.decision_route === "needs_review";
}

export class StuckRunnerDetector {
	private episodes = new Map<string, StuckEpisodeState>();
	private readonly now: () => number;
	private readonly hasPendingReviewSignal: (session: Session) => boolean;

	constructor(private deps: StuckRunnerDetectorDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.hasPendingReviewSignal =
			deps.hasPendingReviewSignal ?? defaultHasPendingReviewSignal;
	}

	/** Drop episode state for executions no longer in the active set. */
	pruneInactive(activeExecutionIds: Set<string>): void {
		for (const id of this.episodes.keys()) {
			if (!activeExecutionIds.has(id)) this.episodes.delete(id);
		}
	}

	/** Test/diagnostic accessor. */
	episodeFor(executionId: string): StuckEpisodeState | undefined {
		return this.episodes.get(executionId);
	}

	/**
	 * FLY-253 (Codex R1 #1): re-arm stuck detection for an execution after the
	 * Lead cleared its latch. Deleting the DB sentinel alone cannot reach the
	 * in-memory episode (already marked escalated/annieAlerted) — this drops
	 * it so the next poll rebuilds a fresh episode and re-escalates after the
	 * threshold, same fingerprint, no pane change required. Called by the
	 * stuck-remanage route via the plugin's late-bound holder.
	 */
	rearmExecution(executionId: string): void {
		this.episodes.delete(executionId);
		this.deps.log?.(
			`[StuckDetector] ${executionId} re-armed — episode state cleared`,
		);
	}

	/**
	 * Run one stuck check for a session. Returns the evaluation result (for
	 * logging/tests); emits a stuck escalation as a side effect when a candidate.
	 *
	 * @param precaptured Optional capture outcome from the caller's own poll
	 * (RunnerIdleWatchdog already captures each session for idle detection —
	 * reusing it keeps the cost at ONE tmux capture-pane per session per poll).
	 */
	async checkSession(
		sessionSnapshot: Session,
		precaptured?: CaptureOutcome,
	): Promise<StuckCandidateResult | null> {
		// `sessionSnapshot` is the caller's poll-start view; `session` below is
		// re-pointed at the live row by the decision-time re-read (MEDIUM-2).
		let session = sessionSnapshot;
		const execId = session.execution_id;

		const capture =
			precaptured ?? (await this.capture(execId, session.project_name));
		if (!capture.ok) {
			// FAIL-CLOSED (FLY-191 #213 R1): a probe error is NOT evidence of being
			// stuck. Skip this poll without advancing or clearing the episode clock,
			// so a transient tmux blip neither escalates nor resets stagnation.
			this.deps.log?.(
				`[StuckDetector] capture failed for ${execId}: ${capture.error} — skipping (fail-closed)`,
			);
			return null;
		}

		// Decision-time re-read (plan §3.1.3; Codex PR R1 MEDIUM-2): the caller's
		// session is a poll-start snapshot. Re-read the live row so a session
		// that flipped to awaiting_review/approved_to_ship/needs_review (or any
		// other label) while this poll was in flight is excluded by the status
		// hard gate below, not escalated off stale data.
		if (this.deps.refreshSession) {
			let fresh: Session | undefined;
			try {
				fresh = this.deps.refreshSession(execId);
			} catch (err) {
				// Fail closed: can't confirm the live status ⇒ don't escalate and
				// don't touch the episode clock this poll.
				this.deps.log?.(
					`[StuckDetector] session re-read failed for ${execId}: ${
						err instanceof Error ? err.message : String(err)
					} — skipping (fail-closed)`,
				);
				return null;
			}
			if (!fresh) {
				// Session row vanished mid-poll — nothing to escalate; drop episode.
				this.episodes.delete(execId);
				this.deps.log?.(
					`[StuckDetector] ${execId} no longer in StateStore — episode cleared`,
				);
				return null;
			}
			session = fresh;
		}

		let signals: CommSignals;
		try {
			signals = this.deps.probeCommSignals(execId, session.project_name);
		} catch (err) {
			// Same fail-closed posture: if we cannot determine "parked at a gate /
			// recently active", assume parked (do not escalate) rather than risk
			// nudging a gate-waiter.
			this.deps.log?.(
				`[StuckDetector] CommDB probe failed for ${execId}: ${
					err instanceof Error ? err.message : String(err)
				} — treating as parked (fail-closed)`,
			);
			return null;
		}

		const result = evaluateStuckCandidate({
			status: session.status,
			output: capture.output,
			now: this.now(),
			prior: this.episodes.get(execId),
			hasPendingGate: signals.hasPendingGate,
			hasRecentCommActivity: signals.hasRecentOutbound,
			hasPendingReviewSignal: this.hasPendingReviewSignal(session),
			thresholdMs: this.deps.thresholdMs,
		});

		// Advance/clear the per-execution episode map.
		if (result.episode === null) {
			this.episodes.delete(execId);
		} else {
			this.episodes.set(execId, result.episode);
		}

		if (result.candidate && result.evidence && result.episode) {
			// FLY-1048 PR-C (C4a): the unified detection-escalation flow owns an
			// active episode for this exact fingerprint — the old Lead emit must
			// not double-fire. Roll the escalated flag back (the emit-failure
			// rollback posture) so EVERY next poll re-evaluates the guard: the
			// moment the unified row resolves while the pane is still frozen,
			// the old flow resumes.
			if (this.unifiedOwnsSafe(execId, result.episode.fingerprint)) {
				this.episodes.set(execId, { ...result.episode, escalated: false });
				this.deps.log?.(
					`[StuckDetector] ${execId} episode ${result.episode.fingerprint} owned by the unified detection flow — old emitter suppressed (C4a)`,
				);
				return result;
			}
			// Bridge-restart rebuild (Codex R1 LOW-7): a persisted disposition —
			// exact OR execution sentinel (FLY-253 L2) — already judged this
			// runner; do NOT re-page the Lead. The in-memory map was lost, but
			// the receipt is authoritative.
			const selection = this.readDispositionSafe(
				execId,
				result.episode.fingerprint,
			);
			if (selection?.effective) {
				// Terminal-by-time (Codex R2 #1): only an UNTIMED receipt (NULL
				// snooze_until_ms — episode false_positive/handled_remanaged or a
				// permanent latch) terminally resolves the Q7 pass. Any timed row
				// (snooze / TTL'd latch) leaves annieAlerted unset so the Q7 pass
				// keeps re-reading and observes the expiry ("ask me again later").
				this.episodes.set(execId, {
					...result.episode,
					escalated: true,
					escalatedAt: this.now(),
					annieAlerted: selection.row.snooze_until_ms == null,
				});
				this.deps.log?.(
					`[StuckDetector] ${execId} episode ${result.episode.fingerprint} already judged (${selection.row.disposition}${selection.row.episode_fingerprint === "*" ? ", execution latch" : ""}) — suppressing re-escalation`,
				);
			} else {
				if (isExpiredTimedReceipt(selection)) {
					// Reminder path (Codex R2 #2): the receipt lapsed — consume it
					// (one-shot token) BEFORE emitting so the next grace expiry pages
					// Annie instead of looping reminders forever.
					try {
						this.deps.consumeExpiredDispositions(
							execId,
							result.episode.fingerprint,
							this.now(),
						);
					} catch (err) {
						// Fail closed, and roll back the candidate's escalated flag
						// (Codex R3 LOW-1): without the rollback the next poll lands in
						// already_escalated with no escalatedAt — permanently neither
						// emitting nor paging.
						this.episodes.set(execId, {
							...result.episode,
							escalated: false,
						});
						this.deps.log?.(
							`[StuckDetector] expired-receipt consume failed for ${execId}: ${
								err instanceof Error ? err.message : String(err)
							} — will retry next poll`,
						);
						return result;
					}
					this.deps.log?.(
						`[StuckDetector] ${execId} expired ${selection?.row.disposition} receipt consumed — reminding the Lead`,
					);
				}
				await this.emitEscalation(session, result.evidence, result.episode);
			}
		} else if (result.exclusion === "already_escalated" && result.episode) {
			// Episode persists past escalation — drive the Q7 fallback window.
			await this.maybeAlertUnhandled(session, result.episode);
		} else if (result.exclusion) {
			this.deps.log?.(
				`[StuckDetector] ${execId} not a candidate: ${result.exclusion}`,
			);
		}

		return result;
	}

	/**
	 * Q7 fallback (plan §3.6): the escalation went out, the episode is still
	 * stuck, and the grace window elapsed without a Lead disposition → page
	 * Annie directly (covers "Lead is down / also stuck"). Lead dispositions
	 * are authoritative (Codex R1 HIGH-1): any currently-effective receipt
	 * (exact or execution sentinel) suppresses. An EXPIRED timed receipt
	 * triggers the reminder reset instead of paging (FLY-253: snooze/TTL
	 * expiry re-asks the LEAD first; Annie only if the Lead stays silent
	 * through the new grace).
	 */
	private async maybeAlertUnhandled(
		session: Session,
		episode: StuckEpisodeState,
	): Promise<void> {
		if (!this.deps.alertUnhandled) return;
		if (episode.annieAlerted) return;
		// escalatedAt unset ⇒ the emit itself is still failing/retrying — the
		// grace window only starts once the Lead actually had the escalation.
		if (episode.escalatedAt === undefined) return;
		const now = this.now();
		const graceMs = this.deps.graceMs ?? LEAD_GRACE_MS;
		if (now - episode.escalatedAt < graceMs) return;

		// FLY-1048 PR-C (C4a): the unified flow owns the episode — its ~30min
		// reconcile owns the founder page, so Q7 stays quiet. Deliberately NOT
		// marked annieAlerted: if the unified row goes inactive while the pane
		// is still frozen, the Q7 fallback resumes on the next poll.
		if (this.unifiedOwnsSafe(session.execution_id, episode.fingerprint)) {
			this.deps.log?.(
				`[StuckDetector] ${session.execution_id} episode ${episode.fingerprint} owned by the unified detection flow — Q7 fallback suppressed (C4a)`,
			);
			return;
		}

		// Durable re-read at claim time (Codex R2 LOW-R2-2): the disposition is
		// re-read from the persistent store in the same pass that claims the
		// Annie alert, eliminating the avoidable race where a receipt landed
		// after the escalation but before this fallback pass.
		let selection: StuckDispositionSelection | undefined;
		try {
			selection = selectStuckDisposition(
				this.deps.getDispositionRows?.(
					session.execution_id,
					episode.fingerprint,
				) ?? {},
				now,
			);
		} catch (err) {
			// Transient read failure: neither page (might violate a real receipt)
			// nor terminally suppress (might hide a stuck runner). Retry next poll.
			this.deps.log?.(
				`[StuckDetector] disposition re-read failed for ${session.execution_id}: ${
					err instanceof Error ? err.message : String(err)
				} — deferring unhandled alert to next poll`,
			);
			return;
		}
		if (selection?.effective) {
			// Terminal-by-time (Codex R2 #1): an untimed receipt resolves the
			// episode for good; a timed one (snooze / TTL latch) keeps this pass
			// re-reading each poll so the expiry is observed.
			if (selection.row.snooze_until_ms == null) {
				this.episodes.set(session.execution_id, {
					...episode,
					annieAlerted: true,
				});
			}
			this.deps.log?.(
				`[StuckDetector] ${session.execution_id} episode ${episode.fingerprint} disposed (${selection.row.disposition}) — unhandled alert suppressed`,
			);
			return;
		}
		if (isExpiredTimedReceipt(selection)) {
			// Reminder reset (FLY-253, Codex R1 #2 + R2 #2): consume the expired
			// receipt (one-shot token), then drop the in-memory episode. The next
			// polls rebuild a fresh episode → threshold → a NEW escalation to the
			// LEAD, re-anchoring the grace; Annie is paged only if the Lead stays
			// silent again.
			//
			// Codex code R1 HIGH-2: the episode is reset EVEN IF consume throws.
			// StateStore (sql.js) mutates memory before persisting — a save()
			// failure can leave the rows already gone; keeping the old escalated
			// episode would let the next poll read "no receipt" and page Annie
			// directly off the OLD grace, skipping the Lead reminder. Resetting
			// unconditionally forces every outcome back through the candidate
			// path (fresh threshold → consume-if-still-there → emit to the LEAD
			// first); the only cost of a spurious reset is one extra threshold
			// wait, never a skipped reminder.
			try {
				this.deps.consumeExpiredDispositions(
					session.execution_id,
					episode.fingerprint,
					now,
				);
			} catch (err) {
				this.deps.log?.(
					`[StuckDetector] expired-receipt consume failed for ${session.execution_id}: ${
						err instanceof Error ? err.message : String(err)
					} — episode reset anyway (Lead-reminder-first guarantee)`,
				);
			}
			this.episodes.delete(session.execution_id);
			this.deps.log?.(
				`[StuckDetector] ${session.execution_id} ${selection?.row.disposition} expired — reminder reset (the Lead will be re-asked after the threshold)`,
			);
			return;
		}

		try {
			const resolved = await this.deps.alertUnhandled({
				session,
				episodeFingerprint: episode.fingerprint,
				stuckMinutes: Math.floor((now - episode.firstStagnantAt) / 60_000),
				escalatedAt: episode.escalatedAt,
				// FLY-927 (W-B): the candidate-time throttle-stall classification.
				throttleStalled: episode.throttleStalled,
			});
			if (resolved) {
				this.episodes.set(session.execution_id, {
					...episode,
					annieAlerted: true,
				});
				this.deps.log?.(
					`[StuckDetector] runner_stuck_unhandled alerted for ${session.execution_id} episode ${episode.fingerprint}`,
				);
			}
		} catch (err) {
			this.deps.log?.(
				`[StuckDetector] unhandled alert failed for ${session.execution_id}: ${
					err instanceof Error ? err.message : String(err)
				} — will retry next poll`,
			);
		}
	}

	/**
	 * C4a guard read. A missing dep or a throw both mean "not owned" — the
	 * old flow stays authoritative (over-paging once is recoverable; silently
	 * dropping a stuck runner is not).
	 */
	private unifiedOwnsSafe(executionId: string, fingerprint: string): boolean {
		if (!this.deps.unifiedOwnsEpisode) return false;
		try {
			return this.deps.unifiedOwnsEpisode(executionId, fingerprint);
		} catch (err) {
			this.deps.log?.(
				`[StuckDetector] unified-episode guard failed for ${executionId}: ${
					err instanceof Error ? err.message : String(err)
				} — treating as not owned`,
			);
			return false;
		}
	}

	/**
	 * Disposition read used on the ESCALATION path. On read failure, treat as
	 * "no disposition" (emit): over-paging the Lead once is recoverable;
	 * silently dropping a stuck runner is not.
	 */
	private readDispositionSafe(
		executionId: string,
		fingerprint: string,
	): StuckDispositionSelection | undefined {
		try {
			return selectStuckDisposition(
				this.deps.getDispositionRows?.(executionId, fingerprint) ?? {},
				this.now(),
			);
		} catch (err) {
			this.deps.log?.(
				`[StuckDetector] disposition read failed for ${executionId}: ${
					err instanceof Error ? err.message : String(err)
				} — treating as none`,
			);
			return undefined;
		}
	}

	private async capture(
		executionId: string,
		projectName: string,
	): Promise<CaptureOutcome> {
		try {
			return await this.deps.capture(executionId, projectName);
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private async emitEscalation(
		session: Session,
		evidence: StuckEvidence,
		episode: StuckEpisodeState,
	): Promise<void> {
		try {
			const persisted = await this.deps.emit({
				session,
				evidence,
				episodeFingerprint: episode.fingerprint,
				episodeStartedAt: episode.firstStagnantAt,
			});
			if (persisted) {
				// Escalation is out — anchor the Q7 fallback grace window.
				this.episodes.set(session.execution_id, {
					...episode,
					escalatedAt: this.now(),
				});
			} else {
				// Not persisted (e.g. no owning Lead resolvable for the project).
				// Roll back so the next poll retries instead of silently dropping
				// a stuck runner behind an unset escalatedAt.
				this.episodes.set(session.execution_id, {
					...episode,
					escalated: false,
				});
				this.deps.log?.(
					`[StuckDetector] emit not persisted for ${session.execution_id} — will retry next poll`,
				);
			}
		} catch (err) {
			// Emission failure must not crash the poll; the episode stays marked
			// escalated, but a persisted-failure path / guardrail retry is the
			// emitter's responsibility. Roll back the escalated flag so the next
			// poll retries the emit for the same still-stuck episode.
			this.episodes.set(session.execution_id, { ...episode, escalated: false });
			this.deps.log?.(
				`[StuckDetector] emit failed for ${session.execution_id}: ${
					err instanceof Error ? err.message : String(err)
				} — will retry next poll`,
			);
		}
	}
}
