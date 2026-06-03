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

import type { Session } from "../StateStore.js";
import {
	evaluateStuckCandidate,
	type StuckCandidateResult,
	type StuckEpisodeState,
	type StuckEvidence,
} from "./stuck-candidate.js";

/** Result of capturing a runner's terminal. Discriminated union, fail-closed. */
export type CaptureOutcome =
	| { ok: true; output: string }
	| { ok: false; error: string };

export interface StuckEscalationPayload {
	session: Session;
	evidence: StuckEvidence;
	/** Episode fingerprint — stable per stuck episode; used for dedup/disposition. */
	episodeFingerprint: string;
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
	/** Injectable clock. */
	now?: () => number;
	/** Override the stagnation threshold (default from stuck-candidate). */
	thresholdMs?: number;
	/** Optional structured logger for exclusions/skips. */
	log?: (msg: string) => void;
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
	 */
	async checkSession(session: Session): Promise<StuckCandidateResult | null> {
		const execId = session.execution_id;

		const capture = await this.capture(execId, session.project_name);
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
			await this.emitEscalation(session, result.evidence, result.episode);
		} else if (result.exclusion) {
			this.deps.log?.(
				`[StuckDetector] ${execId} not a candidate: ${result.exclusion}`,
			);
		}

		return result;
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
			await this.deps.emit({
				session,
				evidence,
				episodeFingerprint: episode.fingerprint,
			});
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
