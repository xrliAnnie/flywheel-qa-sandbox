/**
 * FLY-224 Phase 6 — LeadHealthProbe: the health model for a Codex Lead (plan §6.8).
 *
 * A Codex Lead is a PROCESS (app-server over stdio), NOT a Claude tmux pane — so
 * the existing pane-text `LeadWatchdog` does not apply (Phase 6b filters Codex
 * Leads out of it). This is the Codex-appropriate model, built to AVOID the
 * FLY-83/FLY-193 false-alarm trap (reading a healthy IDLE Lead as frozen):
 *
 *   - A Codex Lead with NO in-flight turn is HEALTHY-IDLE — silence is normal
 *     (waiting for input), never an alert.
 *   - "Stuck" is judged from REAL progress signals, not screen text:
 *       process dead  → unhealthy (definitive),
 *       a turn in flight (dispatching/dispatched) AND the app-server has produced
 *         NOTHING for `stuckTurnMs` (no deltas/responses) AND the journal row hasn't
 *         advanced for `stuckTurnMs` → unhealthy (genuinely stuck). A turn that is
 *         streaming deltas (recent `lastActivityAt`) is HEALTHY-BUSY even if long.
 *       a delivery row (model_completed/output_pending) stalled past
 *         `stuckDeliveryMs` → degraded (the sender is wedged).
 *   - If no app-server activity signal is available, "stuck" is NOT asserted
 *     (can't prove silence → don't false-alarm).
 */

export type LeadHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface LeadHealthVerdict {
	status: LeadHealthStatus;
	reasons: string[];
}

export interface UnfinishedSummary {
	id: string;
	state: string;
	updatedAt: number;
}

export interface LeadHealthInputs {
	processAlive: boolean;
	now: number;
	/** Last time the app-server produced ANY output (delta/notification/response). */
	lastActivityAt?: number;
	/** Journal rows not in a terminal state (from `journal.listUnfinished()`). */
	unfinished: UnfinishedSummary[];
}

export interface LeadHealthThresholds {
	/** An in-flight turn silent this long (app + journal) → stuck. */
	stuckTurnMs: number;
	/** A delivery row stalled this long → degraded. */
	stuckDeliveryMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: LeadHealthThresholds = {
	stuckTurnMs: 30 * 60 * 1000, // 30 min
	stuckDeliveryMs: 5 * 60 * 1000, // 5 min
};

const IN_FLIGHT_STATES: ReadonlySet<string> = new Set([
	"dispatching",
	"dispatched",
]);
const DELIVERY_STATES: ReadonlySet<string> = new Set([
	"model_completed",
	"output_pending",
]);

/** Pure health assessment from progress signals (no screen text). */
export function assessLeadHealth(
	inputs: LeadHealthInputs,
	thresholds: LeadHealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): LeadHealthVerdict {
	if (!inputs.processAlive) {
		return { status: "unhealthy", reasons: ["process_not_running"] };
	}

	const reasons: string[] = [];
	let status: LeadHealthStatus = "healthy";

	// App-server silence: only assertable when we actually have an activity signal.
	const haveActivity = typeof inputs.lastActivityAt === "number";
	const appSilentMs = haveActivity
		? inputs.now - (inputs.lastActivityAt as number)
		: undefined;

	// In-flight turn stuck = journal row in flight too long AND app-server silent
	// too long. A streaming turn (recent activity) is HEALTHY-BUSY, never flagged.
	for (const e of inputs.unfinished) {
		if (!IN_FLIGHT_STATES.has(e.state)) continue;
		const turnAgeMs = inputs.now - e.updatedAt;
		if (
			turnAgeMs > thresholds.stuckTurnMs &&
			appSilentMs !== undefined &&
			appSilentMs > thresholds.stuckTurnMs
		) {
			reasons.push(
				`turn_stuck:${e.id}(${e.state},turnAge=${turnAgeMs}ms,appSilent=${appSilentMs}ms)`,
			);
			status = "unhealthy";
		}
	}

	// Delivery wedged (the sender is hung) — degraded, independent of app activity.
	for (const e of inputs.unfinished) {
		if (!DELIVERY_STATES.has(e.state)) continue;
		if (inputs.now - e.updatedAt > thresholds.stuckDeliveryMs) {
			reasons.push(`delivery_stuck:${e.id}(${e.state})`);
			if (status === "healthy") status = "degraded";
		}
	}

	return { status, reasons };
}

export interface LeadHealthProbeSources {
	/** Is the app-server child process running? */
	processAlive: () => boolean;
	/** Last app-server activity timestamp (ms), or undefined if unknown. */
	lastActivityAt: () => number | undefined;
	/** The Lead's journal (for unfinished rows). */
	journal: { listUnfinished: () => UnfinishedSummary[] };
	now?: () => number;
	thresholds?: LeadHealthThresholds;
}

/** Gathers live signals and produces a verdict. The supervisor (Phase 6b) decides
 * what to do with it (alert / restart is launchd's job per Phase 0A §6). */
export class LeadHealthProbe {
	private readonly sources: LeadHealthProbeSources;
	private readonly now: () => number;
	private readonly thresholds: LeadHealthThresholds;

	constructor(sources: LeadHealthProbeSources) {
		this.sources = sources;
		this.now = sources.now ?? (() => Date.now());
		this.thresholds = sources.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;
	}

	probe(): LeadHealthVerdict {
		return assessLeadHealth(
			{
				processAlive: this.sources.processAlive(),
				now: this.now(),
				lastActivityAt: this.sources.lastActivityAt(),
				unfinished: this.sources.journal.listUnfinished(),
			},
			this.thresholds,
		);
	}
}
