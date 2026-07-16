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
 *     wake routing is broken. NEVER resolved here; reported to the watchdog
 *     (dedicated unreachable-runner alert) while the founder messages flow
 *     through the bounded retry → dead-letter path.
 *
 * Kill-switch FLYWHEEL_ZOMBIE_GATE_RESOLVE (default ON): OFF short-circuits
 * the WHOLE Z1 branch BEFORE the intent write (zero new side effects — Codex
 * R2 #4); Z2 detection is governed by the watchdog's own switch.
 */

import type { CommDB } from "flywheel-comm/db";
import {
	isStateStoreIrreversibleTerminalForZombie,
	type SessionEvent,
} from "../StateStore.js";
import { isReviewGateCheckpoint } from "./review-gate-checkpoints.js";

export function zombieGateResolveEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_ZOMBIE_GATE_RESOLVE !== "0";
}

const SQLITE_UTC_TIMESTAMP =
	/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

function isCanonicalSqliteUtc(
	value: string | null | undefined,
): value is string {
	return typeof value === "string" && SQLITE_UTC_TIMESTAMP.test(value);
}

export interface ZombieCandidateQuestion {
	id: string;
	from_agent: string;
	checkpoint: string | null;
	/** CommDB SQLite UTC creation time. Nullable: the schema predates NOT NULL. */
	created_at?: string | null;
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
	/** Pending gate questions (checkpoint != null) for one lead. */
	pendingGateQuestions: ZombieCandidateQuestion[];
	/** One writable CommDB for this project (caller owns lifecycle). */
	db: ZombieCommDb;
	/** Z2 sink — the watchdog's unreachable-runner detector. */
	noteUnreachableRunner?: (args: {
		executionId: string;
		issueId: string;
		projectName: string;
		questionId: string;
	}) => void;
	env?: Record<string, string | undefined>;
}

export interface ZombieHygieneResult {
	resolved: string[];
	unreachable: string[];
}

export async function runZombieGateHygiene(
	deps: ZombieGateHygieneDeps,
): Promise<ZombieHygieneResult> {
	const env = deps.env ?? process.env;
	const result: ZombieHygieneResult = { resolved: [], unreachable: [] };

	for (const q of deps.pendingGateQuestions) {
		// FLY-161 boundary: runner_questions (checkpoint null) survive session
		// completion BY DESIGN — never candidates.
		if (q.checkpoint == null) continue;

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
		// SQLite UTC seconds, so canonical strings compare directly; missing,
		// malformed, and same-second values fail open permanently. Missing sessions
		// retain the pre-existing Z1 behavior because no chronology can be recovered.
		if (session) {
			if (
				!isCanonicalSqliteUtc(q.created_at) ||
				!isCanonicalSqliteUtc(session.terminal_at) ||
				q.created_at >= session.terminal_at
			) {
				continue;
			}
		}

		// ── Z1: kill-switch BEFORE the intent write (OFF = today's byte path).
		if (!zombieGateResolveEnabled(env)) continue;

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
		let outcome: string;
		if (mutated) {
			outcome = "resolved";
		} else if (deps.db.getResponse(q.id)) {
			outcome = "skipped_answered"; // a real answer won the race — history kept
		} else {
			const rowNow = deps.db.getMessageById(q.id);
			if (!rowNow) {
				outcome = "purged_after_retire"; // purge got it — NOT "answered"
			} else if (!deps.db.isQuestionPending(q.id)) {
				outcome = "already_retired"; // a prior pass's mutation succeeded
			} else {
				continue; // still pending, nothing changed → transient, retry next pass
			}
		}
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
	// three-phase audit always converges. Same kill-switch as Z1 (OFF = zero
	// side effects).
	if (zombieGateResolveEnabled(env)) {
		try {
			reconcileDanglingIntents(deps);
		} catch (err) {
			console.warn(
				`[zombie-gate-hygiene] dangling-intent reconcile error (${deps.projectName}): ${(err as Error).message}`,
			);
		}
	}
	return result;
}

function reconcileDanglingIntents(deps: ZombieGateHygieneDeps): void {
	const intents = deps.store.getEventsByType(
		"founder_gate_zombie_resolve_intent",
	);
	if (intents.length === 0) return;
	const resolvedIds = new Set(
		deps.store
			.getEventsByType("founder_gate_zombie_resolved")
			.map((e) => e.event_id),
	);
	for (const intent of intents) {
		if (intent.project_name !== deps.projectName) continue;
		const payload = (intent.payload ?? {}) as Record<string, unknown>;
		const questionId =
			typeof payload.questionId === "string" ? payload.questionId : undefined;
		if (!questionId) continue;
		if (resolvedIds.has(`founder-gate-zombie-resolved-${questionId}`)) continue;
		// Intent without outcome — classify by re-read (never guess).
		let outcome: string;
		try {
			if (deps.db.getResponse(questionId)) {
				outcome = "skipped_answered";
			} else if (!deps.db.getMessageById(questionId)) {
				outcome = "purged_after_retire";
			} else if (!deps.db.isQuestionPending(questionId)) {
				outcome = "already_retired";
			} else {
				continue; // still pending — the candidate loop owns it next pass
			}
		} catch {
			continue; // CommDB hiccup — next pass
		}
		deps.store.insertEvent({
			event_id: `founder-gate-zombie-resolved-${questionId}`,
			execution_id: intent.execution_id,
			issue_id: intent.issue_id,
			project_name: deps.projectName,
			event_type: "founder_gate_zombie_resolved",
			source: "bridge.zombie-gate-hygiene",
			payload: {
				questionId,
				fromAgent: intent.execution_id,
				outcome,
				reconciled: true,
			},
		});
	}
}
