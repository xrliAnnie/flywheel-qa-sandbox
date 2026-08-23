/**
 * FLY-1099 §5 — zombie gate hygiene (the FLY-977/980/1041/1049 head-of-line
 * blocker: a pending gate whose runner session is gone keeps matching founder
 * messages, WAKE-only fails forever with no_session_lead, and the thread's
 * processed-through cursor pins for 32+ hours).
 *
 * Two DISTINCT branches (Codex R1 #6):
 *   Z1 (resolve): StateStore session missing OR irreversibly terminal
 *     (isStateStoreIrreversibleTerminalForZombie) AND the CommDB registration
 *     row is gone → the gate can never be answered through the normal flow.
 *     Three-phase: durable INTENT audit → GUARDED mutation (retireShipGate for
 *     approve_to_ship; retireQuestionGuarded otherwise — an answered gate is
 *     untouchable, a concurrent response wins) → OUTCOME audit classified by
 *     RE-READ (Codex R2 #4: a false mutation return is NOT proof of a
 *     concurrent answer — re-read distinguishes answered / already_retired /
 *     purged / transient).
 *   Z2 (active-but-unreachable — tonight's FLY-1049 shape): session LIVE
 *     (e.g. awaiting_review) but the CommDB row is missing → the gate is real,
 *     wake routing is broken. NEVER resolved here; reported to the reconcile
 *     (dedicated unreachable-runner alert) while the founder messages flow
 *     through the bounded retry → dead-letter path.
 *
 * Z1 is retained as a low-level audit-replay seam only. Production does not
 * enable it; Z2 detection and checkpoint-less ask hygiene remain live.
 */

import type { CommDB } from "flywheel-comm/db";
import {
	isStateStoreIrreversibleTerminalForZombie,
	type SessionEvent,
} from "../StateStore.js";
import { isReviewGateCheckpoint } from "./review-gate-checkpoints.js";

/**
 * FLY-1328 A2: an ask younger than this is never swept. Longer than the A1
 * cascade grace because a sweep candidate's runner died WITHOUT a teardown —
 * we have less certainty about when it stopped, so we buy more margin.
 */
const ASK_SWEEP_MIN_AGE_MS = 30 * 60_000;
const SESSIONLESS_ASK_SWEEP_MIN_AGE_MS = 24 * 60 * 60_000;
const SESSIONLESS_ASK_SENDER = "voice-honeylemon-fly1911";

/** FLY-1328: fail-closed identity guard — runner execution ids are UUIDs. */
const RUNNER_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SQLITE_UTC_TIMESTAMP =
	/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const ISO_UTC_TIMESTAMP =
	/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function utcTimestampToMs(value: string | null | undefined): number {
	if (typeof value !== "string") return Number.NaN;
	if (SQLITE_UTC_TIMESTAMP.test(value)) {
		return Date.parse(`${value.replace(" ", "T")}Z`);
	}
	return ISO_UTC_TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
}

export interface ZombieCandidateQuestion {
	id: string;
	from_agent: string;
	checkpoint: string | null;
	/** CommDB UTC creation time. Nullable: the schema predates NOT NULL. */
	created_at?: string | null;
	/** FLY-1041 'report' vs a plain ask — recorded in the FLY-1328 audit only. */
	kind?: string | null;
}

export interface ZombieHygieneStore {
	getSession(executionId: string):
		| {
				status?: string;
				issue_id?: string;
				project_name?: string;
				terminal_at?: string | null;
		  }
		| undefined;
	insertEvent(event: SessionEvent): boolean;
	/** Codex code R1 MED-1: dangling-intent reconcile source (StateStore has it). */
	getEventsByType(eventType: string): SessionEvent[];
}

/** Writable CommDB face for the guarded mutation + outcome re-read. */
export type ZombieCommDb = Pick<
	CommDB,
	| "retireShipGate"
	| "retireQuestionGuarded"
	| "getResponse"
	| "getMessageById"
	| "isQuestionPending"
	| "getSession"
>;

export interface ZombieGateHygieneDeps {
	store: ZombieHygieneStore;
	projectName: string;
	leadId?: string;
	/** Pending gate questions (checkpoint != null) for one lead. */
	pendingGateQuestions: ZombieCandidateQuestion[];
	/** One writable CommDB for this project (caller owns lifecycle). */
	db: ZombieCommDb;
	/** Z2 sink — the founder-reply unreachable-runner reconcile. */
	noteUnreachableRunner?: (args: {
		executionId: string;
		issueId: string;
		projectName: string;
		questionId: string;
	}) => void;
	/** Historical Z1 audit replay only; production leaves this false. */
	resolveDeadGates?: boolean;
	env?: Record<string, string | undefined>;
}

export interface ZombieHygieneResult {
	resolved: string[];
	unreachable: string[];
	/** FLY-1328: checkpoint-less asks retired by the A2 sweep this pass. */
	retiredAsks: string[];
}

/**
 * FLY-1328 A2 — retire one ownerless ask, or leave it alone. Predicates are
 * ordered cheap-first (string shape → CommDB row → age → StateStore) so the
 * expensive StateStore read only happens for a real candidate.
 *
 * Every "leave it alone" here is deliberate: this sweep is the last line
 * between a Lead's queue and a swallowed question, so anything short of proof
 * that nobody can read the answer means the ask stays.
 */
async function sweepOwnerlessAsk(
	q: ZombieCandidateQuestion,
	deps: ZombieGateHygieneDeps,
	result: ZombieHygieneResult,
): Promise<void> {
	if (!RUNNER_UUID.test(q.from_agent)) {
		await sweepSessionlessAsk(q, deps, result);
		return;
	}

	// Teardown evidence. The registration row surviving means the runner may be
	// completed-but-alive or parked and can still answer (FLY-161) — not a
	// candidate, at any age.
	let commRow: unknown;
	try {
		commRow = deps.db.getSession(q.from_agent);
	} catch {
		return; // CommDB hiccup — next pass
	}
	if (commRow) return;

	// Age: the same delivery-race guard as the A1 cascade, with more margin
	// because an untorn-down death gives us no teardown timestamp to trust. A
	// missing or malformed clock fails OPEN (never retire on a clock we cannot
	// read) — the FLY-1257 discipline.
	const createdAtMs = utcTimestampToMs(q.created_at);
	if (!Number.isFinite(createdAtMs)) return;
	const ageMs = Date.now() - createdAtMs;
	if (!Number.isFinite(ageMs) || ageMs < ASK_SWEEP_MIN_AGE_MS) return;

	// StateStore cross-check. A LIVE session whose CommDB row vanished is the Z2
	// shape (FLY-1049 broken wake routing): the runner is there, the ask is real,
	// and retiring it would delete a live question. Leave it — and deliberately do
	// NOT noteUnreachableRunner: Z2 alerting is the gate branch's job, and asks
	// would only add noise to a founder-facing alert surface.
	const session = deps.store.getSession(q.from_agent);
	if (session && !isStateStoreIrreversibleTerminalForZombie(session.status)) {
		return;
	}

	// FLY-1257 chronology. An ask written AFTER a terminal session's terminal_at
	// is evidence the runner was reopened under the same execution identity and is
	// genuinely waiting — `ask` needs no session row, so "terminal status + no
	// CommDB row" does NOT by itself imply nobody will read the answer. Both
	// clocks are immutable UTC values, but CommDB and StateStore use different
	// encodings, so compare their parsed instants rather than their strings.
	//
	// Deliberately NARROWER than the gate branch's version, which spares whenever
	// the clock is missing. Measured on production: of 184 sweep candidates, 83
	// have NO terminal_at and ZERO are in the post-terminal shape — so failing
	// open on a missing clock would forfeit ~45% of the backlog this ticket exists
	// to clear, to defend a shape that does not currently occur. A missing clock
	// is not evidence of reopening; it is no evidence either way, and the other
	// four predicates still have to hold. So chronology only speaks when it can:
	// present + readable UTC + post-terminal → spare.
	const terminalAtMs = utcTimestampToMs(session?.terminal_at);
	if (session && Number.isFinite(terminalAtMs) && createdAtMs >= terminalAtMs) {
		return;
	}

	const issueId = session?.issue_id ?? "unknown";
	// Phase 1 — durable intent (idempotent; a crash before the outcome is
	// reconciled by the tail pass).
	//
	// FLY-1328: underscores, not hyphens — and do NOT "tidy" them back.
	//
	// This feature's name ends in "-ask" + "-hygiene". Spell that with hyphens
	// and the last two letters of "ask" plus the hyphen form the OpenAI key
	// prefix; the release tree's secret gate (FLY-1062 vendor set, see
	// scripts/lib/fleet-sanitize.sh) flags that prefix followed by 20+ word
	// characters. A hyphenated intent id here runs 22 characters past it and
	// fails the packaged-payload scan — dist ships this file verbatim, so even
	// a COMMENT naming the literal string re-breaks CI (it did, once).
	// The finding is a false positive, but the gate is right to be blunt about
	// key shapes, so the name gives way instead.
	deps.store.insertEvent({
		event_id: `ask_hygiene_retire_intent_${q.id}`,
		execution_id: q.from_agent,
		issue_id: issueId,
		project_name: deps.projectName,
		event_type: "ask_hygiene_retire_intent",
		source: "bridge.ask-hygiene",
		payload: {
			questionId: q.id,
			fromAgent: q.from_agent,
			kind: q.kind ?? null,
			ageHours: Number((ageMs / 3_600_000).toFixed(2)),
			sessionStatus: session?.status ?? "missing",
		},
	});

	// Phase 2 — guarded mutation. A concurrent answer wins.
	let mutated = false;
	try {
		mutated = deps.db.retireQuestionGuarded(q.id, {
			expectedFromAgent: q.from_agent,
			requireUnanswered: true,
			resolvedVia: "owner_closed_sweep",
			retention: "ask_forensic",
		});
	} catch {
		return; // transient — intent kept, next pass retries
	}

	// Phase 3 — outcome, classified by RE-READ (a false return is not proof of
	// an answer).
	const outcome = classifyRetireOutcome(q.id, mutated, deps);
	if (!outcome) return; // still pending → transient, retry next pass
	deps.store.insertEvent({
		// Underscores, paired with the intent id above — see the FLY-1328 note
		// there. This one is under the gate's 20-char threshold today only by
		// luck (the template stops the run at "${"), which is not a property to
		// depend on; both ids stay hyphen-free on purpose.
		event_id: `ask_hygiene_retired_${q.id}`,
		execution_id: q.from_agent,
		issue_id: issueId,
		project_name: deps.projectName,
		event_type: "ask_hygiene_retired",
		source: "bridge.ask-hygiene",
		payload: {
			questionId: q.id,
			fromAgent: q.from_agent,
			kind: q.kind ?? null,
			resolvedVia: "owner_closed_sweep",
			ageHours: Number((ageMs / 3_600_000).toFixed(2)),
			outcome,
		},
	});
	if (outcome === "resolved" || outcome === "already_retired") {
		result.retiredAsks.push(q.id);
	}
}

/** FLY-1995: dispose only old, checkpoint-less asks with no owner in either DB. */
async function sweepSessionlessAsk(
	q: ZombieCandidateQuestion,
	deps: ZombieGateHygieneDeps,
	result: ZombieHygieneResult,
): Promise<void> {
	if (q.from_agent !== SESSIONLESS_ASK_SENDER) return;
	const createdAtMs = utcTimestampToMs(q.created_at);
	if (!Number.isFinite(createdAtMs)) return;
	const ageMs = Date.now() - createdAtMs;
	if (!Number.isFinite(ageMs) || ageMs <= SESSIONLESS_ASK_SWEEP_MIN_AGE_MS) {
		return;
	}
	if (deps.store.getSession(q.from_agent)) return;
	try {
		if (deps.db.getSession(q.from_agent)) return;
	} catch {
		return;
	}
	deps.store.insertEvent({
		event_id: `orphan_question_dispose_intent_${q.id}`,
		execution_id: q.from_agent,
		issue_id: "unknown",
		project_name: deps.projectName,
		event_type: "orphan_question_dispose_intent",
		source: "bridge.ask-hygiene",
		payload: {
			questionId: q.id,
			fromAgent: q.from_agent,
			lead: deps.leadId ?? null,
			kind: q.kind ?? null,
			ageHours: Number((ageMs / 3_600_000).toFixed(2)),
		},
	});

	let mutated = false;
	try {
		mutated = deps.db.retireQuestionGuarded(q.id, {
			expectedFromAgent: q.from_agent,
			requireUnanswered: true,
			resolvedVia: "fly1995_sessionless_ask",
			retention: "ask_forensic",
		});
	} catch {
		return;
	}
	const outcome = classifyRetireOutcome(q.id, mutated, deps);
	if (!outcome) return;

	deps.store.insertEvent({
		event_id: `orphan_question_disposed_${q.id}`,
		execution_id: q.from_agent,
		issue_id: "unknown",
		project_name: deps.projectName,
		event_type: "orphan_question_disposed",
		source: "bridge.ask-hygiene",
		payload: {
			questionId: q.id,
			fromAgent: q.from_agent,
			lead: deps.leadId ?? null,
			kind: q.kind ?? null,
			ageHours: Number((ageMs / 3_600_000).toFixed(2)),
			resolvedVia: "fly1995_sessionless_ask",
			outcome,
		},
	});
	if (outcome === "resolved" || outcome === "already_retired") {
		result.retiredAsks.push(q.id);
		console.warn(
			`[ask-hygiene] disposed sessionless orphan qid=${q.id} from_agent=${q.from_agent} age_hours=${(ageMs / 3_600_000).toFixed(2)}`,
		);
	}
}

/**
 * Shared outcome classifier for both branches' phase 3. Returns undefined when
 * the question is still pending — i.e. nothing actually happened, so the caller
 * must retry rather than record a fiction.
 */
function classifyRetireOutcome(
	questionId: string,
	mutated: boolean,
	deps: Pick<ZombieGateHygieneDeps, "db">,
): string | undefined {
	if (mutated) return "resolved";
	if (deps.db.getResponse(questionId)) return "skipped_answered";
	if (!deps.db.getMessageById(questionId)) return "purged_after_retire";
	if (!deps.db.isQuestionPending(questionId)) return "already_retired";
	return undefined;
}

export async function runZombieGateHygiene(
	deps: ZombieGateHygieneDeps,
): Promise<ZombieHygieneResult> {
	const result: ZombieHygieneResult = {
		resolved: [],
		unreachable: [],
		retiredAsks: [],
	};

	for (const q of deps.pendingGateQuestions) {
		// FLY-161 boundary: a checkpoint-less ask survives session COMPLETION by
		// design — a completed-but-alive runner can still be answered. FLY-1328
		// narrows that to survives-completion, not survives-TEARDOWN: once the
		// CommDB registration row is gone the runner is provably torn down and
		// nobody can ever read the answer. Those asks go to the ask branch; the
		// gate branch below is byte-unchanged.
		if (q.checkpoint == null) {
			await sweepOwnerlessAsk(q, deps, result);
			continue;
		}

		const session = deps.store.getSession(q.from_agent);
		let commRow: unknown;
		try {
			commRow = deps.db.getSession(q.from_agent);
		} catch {
			continue; // CommDB hiccup — try next pass
		}
		if (commRow) continue; // wake routing intact — not a zombie of either kind

		const terminal =
			!session || isStateStoreIrreversibleTerminalForZombie(session.status);
		if (!terminal) {
			// ── Z2: active-but-unreachable (FLY-1049) — gate is ALIVE, never
			// auto-resolve; surface loudly instead.
			deps.noteUnreachableRunner?.({
				executionId: q.from_agent,
				issueId: session?.issue_id ?? "unknown",
				projectName: deps.projectName,
				questionId: q.id,
			});
			result.unreachable.push(q.id);
			continue;
		}

		// FLY-1257 defect ④ (Codex R5 HIGH): review gates (`review_design` /
		// `review_code`) are NEVER answered by the authoring runner — the
		// cross-family reviewer answers them after `request-review` BINDS them
		// (isReviewGateCheckpoint, the same set path-2 + finalizeSession exempt).
		// So the Z1 "gone runner ⇒ dead gate" premise is FALSE for them: retiring
		// one expires it before re-review can bind it. finalizeSession spares the
		// gate but DELETES the session row, so the R5 path is precisely a review
		// gate whose session is now MISSING — which the chronology guard below
		// (`if (session)`) skips, dropping it straight into Z1 retirement. Exempt
		// unconditionally here, before Z1, regardless of chronology or whether a
		// session row survives. (Z2 above still surfaces a live-but-unreachable
		// review gate — that's an alert, not a retirement.)
		if (isReviewGateCheckpoint(q.checkpoint)) continue;

		// FLY-1257: an existing terminal session needs chronology proof before Z1
		// may retire its gate. A post-terminal gate is evidence that the blocked
		// runner was intentionally reopened for review. Both clocks are immutable
		// UTC values; missing,
		// malformed, and same-second values fail open permanently. Missing sessions
		// retain the pre-existing Z1 behavior because no chronology can be recovered.
		if (session) {
			const createdAtMs = utcTimestampToMs(q.created_at);
			const terminalAtMs = utcTimestampToMs(session.terminal_at);
			if (
				!Number.isFinite(createdAtMs) ||
				!Number.isFinite(terminalAtMs) ||
				createdAtMs >= terminalAtMs
			) {
				continue;
			}
		}

		if (!deps.resolveDeadGates) continue;

		const issueId = session?.issue_id ?? "unknown";
		// Phase 1 — durable intent (idempotent per question; a crash between
		// intent and mutation re-enters naturally: the question is still pending
		// next pass, the duplicate intent insert is a no-op).
		deps.store.insertEvent({
			event_id: `founder-gate-zombie-resolve-intent-${q.id}`,
			execution_id: q.from_agent,
			issue_id: issueId,
			project_name: deps.projectName,
			event_type: "founder_gate_zombie_resolve_intent",
			source: "bridge.zombie-gate-hygiene",
			payload: {
				questionId: q.id,
				fromAgent: q.from_agent,
				checkpoint: q.checkpoint,
				sessionStatus: session?.status ?? "missing",
			},
		});

		// Phase 2 — guarded mutation (answered gates untouchable in both prims).
		let mutated = false;
		try {
			mutated =
				q.checkpoint === "approve_to_ship"
					? deps.db.retireShipGate(q.id)
					: deps.db.retireQuestionGuarded(q.id, {
							expectedFromAgent: q.from_agent,
							requireUnanswered: true,
						});
		} catch {
			continue; // transient — intent kept, next pass retries
		}

		// Phase 3 — outcome, classified by RE-READ (Codex R2 #4: false ≠ answered).
		const outcome = classifyRetireOutcome(q.id, mutated, deps);
		if (!outcome) continue; // still pending, nothing changed → retry next pass
		deps.store.insertEvent({
			event_id: `founder-gate-zombie-resolved-${q.id}`,
			execution_id: q.from_agent,
			issue_id: issueId,
			project_name: deps.projectName,
			event_type: "founder_gate_zombie_resolved",
			source: "bridge.zombie-gate-hygiene",
			payload: {
				questionId: q.id,
				fromAgent: q.from_agent,
				checkpoint: q.checkpoint,
				outcome,
			},
		});
		if (outcome === "resolved" || outcome === "already_retired") {
			result.resolved.push(q.id);
		}
	}

	// ── Codex code R1 MED-1: dangling-intent reconcile. A crash between the
	// guarded mutation and the outcome audit leaves an intent with no outcome —
	// and since the retired question is no longer pending, the candidate loop
	// above will never revisit it. Re-read + classify those here so the
	// three-phase audit always converges when audit replay is requested.
	if (deps.resolveDeadGates) {
		try {
			reconcileDanglingIntents(deps, GATE_INTENT_FAMILY);
		} catch (err) {
			console.warn(
				`[zombie-gate-hygiene] dangling-intent reconcile error (${deps.projectName}): ${(err as Error).message}`,
			);
		}
	}
	// FLY-1328: the ask branch owns an isomorphic reconcile over its OWN event
	// family. Separate event types on purpose — feeding ask intents to the gate
	// reconcile would let them be classified as gate dispositions.
	try {
		reconcileDanglingIntents(deps, ASK_INTENT_FAMILY);
	} catch (err) {
		console.warn(
			`[ask-hygiene] dangling-intent reconcile error (${deps.projectName}): ${(err as Error).message}`,
		);
	}
	try {
		reconcileDanglingIntents(deps, SESSIONLESS_ASK_INTENT_FAMILY);
	} catch (err) {
		console.warn(
			`[ask-hygiene] sessionless dangling-intent reconcile error (${deps.projectName}): ${(err as Error).message}`,
		);
	}
	return result;
}

/** The (intent, outcome, id-prefix, source) tuple identifying one audit family. */
interface IntentFamily {
	intentType: string;
	outcomeType: string;
	outcomeIdPrefix: string;
	source: string;
}

const GATE_INTENT_FAMILY: IntentFamily = {
	intentType: "founder_gate_zombie_resolve_intent",
	outcomeType: "founder_gate_zombie_resolved",
	outcomeIdPrefix: "founder-gate-zombie-resolved-",
	source: "bridge.zombie-gate-hygiene",
};

const ASK_INTENT_FAMILY: IntentFamily = {
	intentType: "ask_hygiene_retire_intent",
	outcomeType: "ask_hygiene_retired",
	outcomeIdPrefix: "ask_hygiene_retired_",
	source: "bridge.ask-hygiene",
};

const SESSIONLESS_ASK_INTENT_FAMILY: IntentFamily = {
	intentType: "orphan_question_dispose_intent",
	outcomeType: "orphan_question_disposed",
	outcomeIdPrefix: "orphan_question_disposed_",
	source: "bridge.ask-hygiene",
};

function reconcileDanglingIntents(
	deps: ZombieGateHygieneDeps,
	family: IntentFamily,
): void {
	const intents = deps.store.getEventsByType(family.intentType);
	if (intents.length === 0) return;
	const resolvedIds = new Set(
		deps.store.getEventsByType(family.outcomeType).map((e) => e.event_id),
	);
	for (const intent of intents) {
		if (intent.project_name !== deps.projectName) continue;
		const payload = (intent.payload ?? {}) as Record<string, unknown>;
		const questionId =
			typeof payload.questionId === "string" ? payload.questionId : undefined;
		if (!questionId) continue;
		if (resolvedIds.has(`${family.outcomeIdPrefix}${questionId}`)) continue;
		// Intent without outcome — classify by re-read (never guess).
		let outcome: string | undefined;
		try {
			outcome = classifyRetireOutcome(questionId, false, deps);
		} catch {
			continue; // CommDB hiccup — next pass
		}
		if (!outcome) continue; // still pending — the candidate loop owns it next pass
		deps.store.insertEvent({
			event_id: `${family.outcomeIdPrefix}${questionId}`,
			execution_id: intent.execution_id,
			issue_id: intent.issue_id,
			project_name: deps.projectName,
			event_type: family.outcomeType,
			source: family.source,
			payload: {
				questionId,
				fromAgent: intent.execution_id,
				outcome,
				reconciled: true,
			},
		});
	}
}
