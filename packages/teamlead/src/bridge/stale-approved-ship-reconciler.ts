/**
 * FLY-799 Part B — stale approved_to_ship re-wake reconciler.
 *
 * The founder-approval self-ship flow flips awaiting_review → approved_to_ship
 * AND wakes the runner in one gate-poller pass. That wake is best-effort: if it
 * is missed (the runner was asleep, or the Bridge restarted between the response
 * write and the wake), the session strands in approved_to_ship forever — the
 * founder approved, but nothing ships.
 *
 * This reconciler catches that. For each stale approved_to_ship session with a
 * real review binding + pr_head, it probes the runner:
 *   - LIVE  → re-send the approval wake (idempotent; verify-approval still gates
 *             the actual ship, so a re-wake can never ship something unapproved).
 *   - DEAD  → alert ONCE and defer to FLY-795 (durable resume). It never
 *             self-ships (no `:cool:`) and never reads 795's progress.md — the
 *             re-wake is the ONLY action here (Codex R: re-wake-only reconciler).
 *
 * The reconcile core is pure + fully injected so it is unit-testable without a
 * Bridge; the gate-poller wires the real liveness probe / wake / alert.
 */

import { REVIEW_BINDING_UNBOUND } from "../StateStore.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";
import type { RunnerLiveness } from "./tmux-lookup.js";

/** Default: a session idle in approved_to_ship this long is "stranded". */
export const DEFAULT_REWAKE_GRACE_MS = 5 * 60_000;
/** Default: re-wake one stranded session at most this often. */
export const DEFAULT_REWAKE_BACKOFF_MS = 5 * 60_000;

export interface RewakeSessionProbe {
	execution_id: string;
	issue_id: string;
	project_name: string;
	status?: string;
	review_question_id?: string;
	pr_head_sha?: string;
	last_activity_at?: string;
	tmux_session?: string;
}

/**
 * A session eligible for re-wake: founder-approved (approved_to_ship) with a
 * REAL review binding (not null / not the `unbound` sentinel) + a pr_head, and
 * idle past the grace. The binding + pr_head requirement mirrors the write path
 * (verify-approval only honors a bound approval), so a re-wake here can only ever
 * nudge a genuinely-approved, genuinely-stranded ship.
 */
export function isRewakeCandidate(
	session: RewakeSessionProbe,
	opts: { nowMs: number; graceMs: number },
): boolean {
	if (session.status !== "approved_to_ship") return false;
	const qid = session.review_question_id;
	if (!qid || qid === REVIEW_BINDING_UNBOUND) return false;
	if (!session.pr_head_sha) return false;
	const lastMs = parseSqliteUtcMs(session.last_activity_at);
	if (lastMs === null) return false;
	return opts.nowMs - lastMs >= opts.graceMs;
}

export interface ReconcileStaleApprovedShipDeps {
	sessions: RewakeSessionProbe[];
	nowMs: number;
	graceMs: number;
	backoffMs: number;
	/** execId → next allowed re-wake time (survives across passes; caller-owned). */
	backoff: Map<string, number>;
	/** execIds already dead-alerted (survives across passes; caller-owned). */
	deadAlerted: Set<string>;
	/** Exact-target, three-state process evidence. */
	probe: (
		session: RewakeSessionProbe,
	) => Promise<"alive" | "dead" | "indeterminate">;
	/** Re-send the approval wake to a live runner. */
	reWake: (session: RewakeSessionProbe) => Promise<void>;
	/** One-time alert for a truly-dead stranded ship (defer to FLY-795). */
	/** True only when the alert sink durably accepted the event. */
	alertDead: (session: RewakeSessionProbe) => Promise<boolean>;
	/** Best-effort visibility for evidence that cannot authorize an action. */
	diagnose?: (
		session: RewakeSessionProbe,
		reason: "indeterminate" | "probe_error",
	) => void | Promise<void>;
}

/**
 * Translate exact-target tmux evidence into the reconciler's action vocabulary.
 * Only a persisted window whose panes are all dead is positive death evidence.
 * `absent` may instead mean a stale CommDB target, so it must stay diagnostic
 * and take the same harmless, idempotent re-wake path as an indeterminate probe.
 */
export function classifyStaleShipRunnerLiveness(
	verdict: RunnerLiveness,
): "alive" | "dead" | "indeterminate" {
	if (verdict === "alive") return "alive";
	if (verdict === "dead_pin") return "dead";
	return "indeterminate";
}

export function deadAlertAccepted(result: {
	sent?: boolean;
	queued?: boolean;
	dmSent?: boolean;
	skipped?: string;
}): boolean {
	return Boolean(
		result.sent ||
			result.queued ||
			result.dmSent ||
			result.skipped === "duplicate",
	);
}

export async function reconcileStaleApprovedShip(
	deps: ReconcileStaleApprovedShipDeps,
): Promise<{ rewoken: string[]; deadAlerted: string[] }> {
	const rewoken: string[] = [];
	const deadAlerted: string[] = [];

	for (const session of deps.sessions) {
		if (
			!isRewakeCandidate(session, {
				nowMs: deps.nowMs,
				graceMs: deps.graceMs,
			})
		) {
			continue;
		}

		// Per-session backoff: don't re-probe/re-wake every tick.
		const nextAt = deps.backoff.get(session.execution_id) ?? 0;
		if (deps.nowMs < nextAt) continue;
		deps.backoff.set(session.execution_id, deps.nowMs + deps.backoffMs);

		let verdict: "alive" | "dead" | "indeterminate";
		try {
			verdict = await deps.probe(session);
		} catch {
			await deps.diagnose?.(session, "probe_error");
			await deps.reWake(session);
			rewoken.push(session.execution_id);
			continue;
		}

		if (verdict === "indeterminate") {
			await deps.diagnose?.(session, "indeterminate");
			await deps.reWake(session);
			rewoken.push(session.execution_id);
			continue;
		}

		if (verdict === "alive") {
			await deps.reWake(session);
			rewoken.push(session.execution_id);
			continue;
		}

		// Dead: alert ONCE (do not spam every backoff window), defer to FLY-795.
		if (!deps.deadAlerted.has(session.execution_id)) {
			const accepted = await deps.alertDead(session);
			if (accepted) {
				deps.deadAlerted.add(session.execution_id);
				deadAlerted.push(session.execution_id);
			}
		}
	}

	return { rewoken, deadAlerted };
}
