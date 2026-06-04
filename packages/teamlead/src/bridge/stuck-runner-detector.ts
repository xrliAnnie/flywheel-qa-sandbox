/**
 * FLY-195: Stuck-runner detector — the per-session orchestration layer.
 *
 * Wraps the pure `evaluateStuckCandidate` logic with the I/O it needs:
 *   - capture the runner's terminal (FAIL-CLOSED on error — never treat a
 *     tmux/CommDB probe failure as "stuck"; lesson from FLY-191 PR #213 R1,
 *     where a probe error was misread as "dead" and could reap a live runner);
 *   - query "legitimately parked" predicates (pending gate / pending review);
 *   - maintain the per-execution stuck-episode map (separate from the FLY-92
 *     idle state — Codex R1 LOW-8);
 *   - emit a `runner_stuck_escalation` once per episode (dedup) to the owning
 *     Lead via an injected emitter.
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
	/** True ⇒ runner has an unanswered gate question (legitimately parked). */
	hasPendingGate: (executionId: string, projectName: string) => boolean;
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
	 * Read the persisted Lead disposition for one episode (plan §3.4). The
	 * detector consults it (a) before re-paging the Lead for an episode that
	 * was already judged (Bridge-restart rebuild, Codex R1 LOW-7) and (b) in
	 * the Q7 fallback, including a durable re-read right before paging Annie
	 * (Codex R2 LOW-R2-2).
	 */
	getDisposition?: (
		executionId: string,
		episodeFingerprint: string,
	) => StuckDispositionRow | undefined;
	/**
	 * Q7 fallback (plan §3.6): page Annie about an episode no Lead disposed of
	 * within the grace window. MUST dedup internally per eventId
	 * `runner-stuck-unhandled:${execution_id}:${fingerprint}` (the
	 * LeadAlertNotifier claims path). Returns true once the alert is claimed /
	 * sent so the detector marks the episode resolved; false/throw ⇒ retry
	 * next poll.
	 */
	alertUnhandled?: (payload: StuckUnhandledPayload) => Promise<boolean>;
	/** Grace before the Q7 fallback fires (default LEAD_GRACE_MS). */
	graceMs?: number;
	/** Injectable clock. */
	now?: () => number;
	/** Override the stagnation threshold (default from stuck-candidate). */
	thresholdMs?: number;
	/** Optional structured logger for exclusions/skips. */
	log?: (msg: string) => void;
}

/** True when a disposition row currently suppresses (snooze must be unexpired). */
export function dispositionSuppresses(
	row: StuckDispositionRow | undefined,
	now: number,
): boolean {
	if (!row) return false;
	if (row.disposition === "snooze") {
		return row.snooze_until_ms != null && row.snooze_until_ms > now;
	}
	return true;
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
	 * Run one stuck check for a session. Returns the evaluation result (for
	 * logging/tests); emits a stuck escalation as a side effect when a candidate.
	 *
	 * @param precaptured Optional capture outcome from the caller's own poll
	 * (RunnerIdleWatchdog already captures each session for idle detection —
	 * reusing it keeps the cost at ONE tmux capture-pane per session per poll).
	 */
	async checkSession(
		session: Session,
		precaptured?: CaptureOutcome,
	): Promise<StuckCandidateResult | null> {
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

		let hasPendingGate = false;
		try {
			hasPendingGate = this.deps.hasPendingGate(execId, session.project_name);
		} catch (err) {
			// Same fail-closed posture: if we cannot determine "parked at a gate",
			// assume parked (do not escalate) rather than risk nudging a gate-waiter.
			this.deps.log?.(
				`[StuckDetector] pending-gate query failed for ${execId}: ${
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
			hasPendingGate,
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
			// Bridge-restart rebuild (Codex R1 LOW-7): if a persisted disposition
			// already judged this exact episode (same execution + fingerprint),
			// do NOT re-page the Lead — the in-memory map was lost, but the
			// receipt is authoritative. An expired snooze does not suppress.
			const disposition = this.readDispositionSafe(
				execId,
				result.episode.fingerprint,
			);
			if (dispositionSuppresses(disposition, this.now())) {
				// snooze is NOT terminal: leave annieAlerted unset so the Q7 pass
				// keeps re-reading and can page on expiry ("ask me again later").
				this.episodes.set(execId, {
					...result.episode,
					escalated: true,
					escalatedAt: this.now(),
					annieAlerted: disposition?.disposition !== "snooze",
				});
				this.deps.log?.(
					`[StuckDetector] ${execId} episode ${result.episode.fingerprint} already judged (${disposition?.disposition}) — suppressing re-escalation`,
				);
			} else {
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
	 * are authoritative (Codex R1 HIGH-1): any current receipt suppresses.
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

		// Durable re-read at claim time (Codex R2 LOW-R2-2): the disposition is
		// re-read from the persistent store in the same pass that claims the
		// Annie alert, eliminating the avoidable race where a receipt landed
		// after the escalation but before this fallback pass.
		let disposition: StuckDispositionRow | undefined;
		try {
			disposition = this.deps.getDisposition?.(
				session.execution_id,
				episode.fingerprint,
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
		if (dispositionSuppresses(disposition, now)) {
			// snooze suppresses only until expiry — do NOT mark terminal; this
			// pass re-reads each poll and pages once the snooze lapses (still
			// stuck). Other dispositions resolve the episode for good.
			if (disposition?.disposition !== "snooze") {
				this.episodes.set(session.execution_id, {
					...episode,
					annieAlerted: true,
				});
			}
			this.deps.log?.(
				`[StuckDetector] ${session.execution_id} episode ${episode.fingerprint} disposed (${disposition?.disposition}) — unhandled alert suppressed`,
			);
			return;
		}

		try {
			const resolved = await this.deps.alertUnhandled({
				session,
				episodeFingerprint: episode.fingerprint,
				stuckMinutes: Math.floor((now - episode.firstStagnantAt) / 60_000),
				escalatedAt: episode.escalatedAt,
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
	 * Disposition read used on the ESCALATION path. On read failure, treat as
	 * "no disposition" (emit): over-paging the Lead once is recoverable;
	 * silently dropping a stuck runner is not.
	 */
	private readDispositionSafe(
		executionId: string,
		fingerprint: string,
	): StuckDispositionRow | undefined {
		try {
			return this.deps.getDisposition?.(executionId, fingerprint);
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
