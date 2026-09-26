/**
 * FLY-927 (Task 3.1, Watchdog v2): the checkpoint-park TUPLE — the truthful
 * answer to "where is this session stopped, and whose ball is it?".
 *
 * FLY-912 root cause: the old alert GUESSED the stage from heuristics and
 * called a founder ship-gate wait "stuck in Code Review" for 3.8h. Every
 * session already reports its authoritative stage via `flywheel-comm stage
 * set` → `sessions.session_stage` — so the tuple DERIVES, never guesses:
 *  - stage    = sessions.session_stage (null when never reported — the alert
 *               copy then says so instead of inventing a stage name)
 *  - party    = who the ball is with (founder | lead | runner | ci)
 *  - owner    = the resolved owning Lead (first responder — NOT the founder)
 *  - waiting  = gate created_at | awaiting_review entry | stage update
 *  - evidence = has a founder-facing delivery audit actually landed?
 *
 * Pure derivation; the GatePoller patrol (Task 3.2) consumes it and the
 * wording collapse (Task 3.3) renders it.
 */

export type BlockedParty = "founder" | "lead" | "runner" | "ci";

export interface ParkTuple {
	issueId: string;
	identifier: string | null;
	/** Authoritative reported stage — NEVER guessed; null = not reported. */
	stage: string | null;
	party: BlockedParty;
	ownerLeadId: string | null;
	waitingSinceMs: number;
	/** A successful founder-facing delivery audit exists for this park. */
	notifiedEvidence: boolean;
	/** The truthful "下一步" for the alert template. */
	nextStep: string;
}

export interface ParkTupleInput {
	session: {
		issue_id: string;
		issue_identifier?: string | null;
		status: string;
		session_stage?: string | null;
		stage_updated_at?: string | null;
		awaiting_review_entered_at?: string | null;
	};
	/** Open blocking gates for this session (CommDB pending questions). */
	pendingGates: Array<{ checkpoint: string | null; createdAtMs: number }>;
	/** An auto-QA run is active for this session (best-effort). */
	autoQaActive: boolean;
	/** session_events shows a SUCCESSFUL founder delivery for this park. */
	notifiedEvidence: boolean;
	ownerLeadId?: string | null;
	nowMs: number;
}

function sqliteUtcMs(s: string | null | undefined): number | null {
	if (!s) return null;
	const t = Date.parse(`${s.replace(" ", "T")}Z`);
	return Number.isNaN(t) ? null : t;
}

/**
 * Derive the park tuple, or null when the session is not parked anywhere a
 * patrol should care about (terminal states; running with no signal).
 */
export function deriveParkTuple(input: ParkTupleInput): ParkTuple | null {
	const { session } = input;
	const identifier = session.issue_identifier ?? null;
	const label = identifier ?? session.issue_id;
	const stage = session.session_stage ?? null;

	const founderGate = input.pendingGates.find(
		(g) => g.checkpoint === "brainstorm" || g.checkpoint === "approve_to_ship",
	);
	const questionGate = input.pendingGates.find(
		(g) => g.checkpoint === "question",
	);

	// founder: a founder checkpoint gate, or the awaiting_review park itself.
	if (founderGate || session.status === "awaiting_review") {
		const waitingSinceMs =
			founderGate?.createdAtMs ??
			sqliteUtcMs(session.awaiting_review_entered_at) ??
			sqliteUtcMs(session.stage_updated_at) ??
			input.nowMs;
		const nextStep =
			founderGate?.checkpoint === "brainstorm"
				? `在 [${label}] thread 确认 runner 的 brainstorm 理解`
				: `等你 ship ${label}(待你拍板)`;
		return {
			issueId: session.issue_id,
			identifier,
			stage,
			party: "founder",
			ownerLeadId: input.ownerLeadId ?? null,
			waitingSinceMs,
			notifiedEvidence: input.notifiedEvidence,
			nextStep,
		};
	}

	// lead: a runner's blocking question waiting on the Lead.
	if (questionGate) {
		return {
			issueId: session.issue_id,
			identifier,
			stage,
			party: "lead",
			ownerLeadId: input.ownerLeadId ?? null,
			waitingSinceMs: questionGate.createdAtMs,
			notifiedEvidence: input.notifiedEvidence,
			nextStep: `答 runner 的 question(${label})`,
		};
	}

	// ci: auto-QA is running — the ball is with the pipeline, not a human.
	if (input.autoQaActive) {
		return {
			issueId: session.issue_id,
			identifier,
			stage,
			party: "ci",
			ownerLeadId: input.ownerLeadId ?? null,
			waitingSinceMs: sqliteUtcMs(session.stage_updated_at) ?? input.nowMs,
			notifiedEvidence: input.notifiedEvidence,
			nextStep: `等 QA/CI 跑完(${label})`,
		};
	}

	// runner: still running with a reported-but-stalled stage. v1 derives only
	// (FLY-195 / auto-QA guards own runner stalls); no stage report = nothing
	// to say truthfully → not parked.
	if (session.status === "running" && stage) {
		return {
			issueId: session.issue_id,
			identifier,
			stage,
			party: "runner",
			ownerLeadId: input.ownerLeadId ?? null,
			waitingSinceMs: sqliteUtcMs(session.stage_updated_at) ?? input.nowMs,
			notifiedEvidence: input.notifiedEvidence,
			nextStep: `runner 推进 ${stage}(停滞需查)`,
		};
	}

	return null;
}

/**
 * FLY-912 truthful wording (Task 3.3 renders through this):
 * `[FLY-XXX] [Runner] 停在<真实stage>已<N>h,球在<party>,owner=<Lead>,下一步=<…>`
 * A missing stage report says so — it is NEVER guessed.
 */
export function formatParkAlert(tuple: ParkTuple, nowMs: number): string {
	const label = tuple.identifier ?? tuple.issueId;
	const hours =
		Math.round((Math.max(0, nowMs - tuple.waitingSinceMs) / 3_600_000) * 10) /
		10;
	const stage = tuple.stage ?? "(stage未上报)";
	const party = tuple.party === "founder" ? "founder(待你拍板)" : tuple.party;
	return `[${label}] [Runner] 停在${stage}已${hours}h,球在${party},owner=${tuple.ownerLeadId ?? "—"},下一步=${tuple.nextStep}`;
}
