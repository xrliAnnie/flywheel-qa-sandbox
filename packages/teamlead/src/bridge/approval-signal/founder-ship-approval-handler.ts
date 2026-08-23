/**
 * FLY-799 Part A — founder ship-approval handler.
 *
 * The assembly the deliverer's ship branch calls (`tryFounderShipApproval`).
 * Composes the tested primitives:
 *   identity (canonical founder) → A-2 narrow to EXACTLY ONE current ship gate
 *   (session awaiting_review && review_question_id === questionId) → TextSource
 *   → shared `writeGateResponseAndRunPostWrite`.
 *
 * FLY-1099 §3.2/§4: the return contract is the explicit `ShipApprovalOutcome`
 * disposition —
 *   - `bound`: the decision's POSTCONDITION was reached (Codex R2 #1 —
 *     approve: response + FSM flip; reject: response + wake hook ok), NOT a
 *     bare `written:true`.
 *   - `deferred`: the gate is held on a self-clearing reason
 *     (codex_pending / qa_not_green) and the decision was durably parked for
 *     the rebind pass (Tadashi Q2). merge_block is NEVER deferrable (it only
 *     clears via same-head recovery — Codex R1 #2).
 *   - `retry`: transient infra failure (Tier-3 spawn / deferral write /
 *     postcondition pending) — the deliverer pins the cursor (bounded).
 *   - null: unattributable (non-founder / narrow miss / unclear / write
 *     refused) → the deliverer's byte-compatible WAKE-only fallback.
 */

import type { FounderReworkHint } from "../../workflow-rework-hint.js";
import type { ShipApprovalOutcome } from "../founder-reply-deliverer.js";
import type {
	MergedGateGuard,
	MergedGateGuardResult,
} from "../merged-gate-guard.js";
import {
	isDeferrableReviewHoldReason,
	type ReviewHoldReason,
} from "../review-hold.js";
import type { GateAuthorityView } from "./gate-authority-view.js";
import {
	makeGuardedOnResponseWritten,
	type ResponseGuardDb,
} from "./response-guard.js";
import { evaluateTextSource } from "./text-approval-source.js";
import type {
	ApprovalAttributionEvidence,
	ApprovalSignal,
	GateBinding,
} from "./types.js";
import {
	type FounderGateMessageContext,
	type GateResponseDb,
	type WriteGateResponseArgs,
	writeGateResponseAndRunPostWrite,
} from "./write-gate-response.js";

interface HandlerSession {
	status?: string;
	review_question_id?: string | null;
	pr_head_sha?: string | null;
	pr_number?: number | null;
	issue_identifier?: string | null;
}

/**
 * FLY-1099 §4.3 (b): the statuses that prove the approve post-write hook
 * flipped the session. `approved_to_ship` is the normal flip;
 * `completed` is the FLY-869 B-3 recovered terminal — the production hook
 * (`buildGateResponsePostWriteHook`, plugin.ts) drives an already-merged
 * parked session straight to completed + Done on this exact path.
 */
const APPROVE_FLIPPED_STATUSES = new Set(["approved_to_ship", "completed"]);

/**
 * FLY-1099 §4.2: the deferral support face (factory-built per callback call,
 * closing over the thread ctx). Absent → the legacy FLY-1041 held behavior
 * (held_declined → WAKE-only), byte-compatible.
 */
export interface DeferralSupport {
	/** Why the session is founder-held (null = not held). */
	holdReason(executionId: string): ReviewHoldReason | null;
	/**
	 * Durable single-transaction deferral: deferred row + `held_reply` thread
	 * notice intent (§4.2 step 2). Throws on failure (mapped to retry).
	 */
	defer(args: {
		questionId: string;
		msgId: string;
		executionId: string;
		prHeadSha: string;
		decision: "approve" | "reject";
		content: string;
		authorUserId: string;
		/** The canonical founder id THIS attribution ran under (rebind re-verifies). */
		founderIdAtCapture: string;
		holdReason: "codex_pending" | "qa_not_green";
		founderRework?: FounderReworkHint;
	}): "inserted" | "noop_existing";
	/**
	 * Queue the held explainer thread notice (merge_block recovery pointer,
	 * readiness pointer, or deferred-OFF explainer). Idempotent per
	 * (questionId, msgId); best-effort (must not throw into attribution).
	 */
	queueHeldNotice(args: {
		questionId: string;
		msgId: string;
		executionId: string;
		kind: "merge_block" | "readiness_hold" | "deferred_off";
		holdReason: ReviewHoldReason;
	}): void;
	/**
	 * FLY-1099 (Codex code R1 HIGH-1): park a decision whose RESPONSE reached a
	 * durable state but whose postcondition did not (FSM unflipped / hook
	 * unsafe / UNIQUE race needing re-classification). Once a response exists
	 * the gate drops out of `getPendingQuestions`, so the deliverer can NEVER
	 * re-match the founder message — the REBIND pass (whose gate-alive check
	 * accepts an answered-but-unflipped binding) is the only convergence owner.
	 * Same durable row as `defer` but WITHOUT the "已存着" thread notice (the
	 * decision is already recorded — only convergence is pending). Throws on
	 * failure (mapped to retry).
	 */
	parkForConvergence(args: {
		questionId: string;
		msgId: string;
		executionId: string;
		prHeadSha: string;
		decision: "approve" | "reject";
		content: string;
		authorUserId: string;
		founderIdAtCapture: string;
		reason: string;
		founderRework?: FounderReworkHint;
	}): void;
	/**
	 * FLY-1099 (Codex code R1 HIGH-2): durably commit the reject feedback wake
	 * as an action-ledger intent — the production post-write hook returns void
	 * (its sendRunnerWake is fire-and-forget), so "hook ok" proves nothing.
	 * The (b') postcondition for a LIVE reject = response durable + THIS intent
	 * committed; delivery is the drain's at-least-once job. Throws on failure.
	 */
	queueFeedbackWake(args: {
		questionId: string;
		msgId: string;
		executionId: string;
		feedback: string;
	}): void;
}

export interface ShipApprovalHandlerDeps {
	canonicalFounderId: string;
	store: { getSession(executionId: string): HandlerSession | undefined };
	gateAuthorityView?: GateAuthorityView;
	db: GateResponseDb;
	evaluateTextImpl?: typeof evaluateTextSource;
	writeGateResponseImpl?: typeof writeGateResponseAndRunPostWrite;
	cardAuthority?: WriteGateResponseArgs["cardAuthority"];
	onResponseWritten?: Parameters<
		typeof writeGateResponseAndRunPostWrite
	>[0]["onResponseWritten"];
	/**
	 * FLY-1041 Chunk 4: attribution audit sink. Called at every decision point
	 * (narrowing, hold, signal evaluation, write outcome) with a stage keyword
	 * + payload; the factory turns it into an idempotent
	 * `founder_ship_attribution` session_event. Absent → zero audit (tests /
	 * legacy assemblies unchanged).
	 */
	auditSink?: (stage: string, payload?: Record<string, unknown>) => void;
	/**
	 * FLY-1041 Chunk 5: the shared founder-approval hold guard
	 * (`founderApprovalHoldGuard` — codex gate / QA / merge_block). While held,
	 * founder text is NEVER written. FLY-1099: when `deferral` is wired its
	 * reason-classified `holdReason` supersedes this boolean; kept for legacy
	 * assemblies. Absent (and no deferral) → no hold check (byte-compat).
	 */
	isHeld?: (executionId: string) => boolean;
	/** FLY-1099 §4.2: deferral support (absent → legacy held_declined). */
	deferral?: DeferralSupport;
	/** FLY-1238: shared last-mile PR-state guard. */
	mergedGateGuard?: MergedGateGuard;
}

export interface ShipApprovalHandlerArgs {
	msg: {
		id: string;
		content?: string;
		authorId?: string;
	};
	shipGates: {
		questionId: string;
		checkpoint: string | null;
		executionId: string;
		createdAtMs: number;
	}[];
	ctx: {
		issueId: string;
		threadId: string;
		projectName?: string;
		projectRoot?: string;
	};
	recordDecisionClassification?: (decision: "approve" | "reject") => void;
	/**
	 * FLY-1041 Chunk 7: this founder message is a VERIFIED Discord reply
	 * (type 19 + reference in this thread) to THIS gate's ship card — the
	 * deliverer already narrowed shipGates to that one gate. Threaded into the
	 * Tier-3 prompt so short affirmations on the card bind deterministically.
	 */
	replyToCard?: boolean;
	founderMessage?: FounderGateMessageContext;
}

const excerpt = (s: string | undefined, max = 200): string => {
	const t = s ?? "";
	return t.length > max ? `${t.slice(0, max)}…` : t;
};

export async function tryFounderShipApproval(
	args: ShipApprovalHandlerArgs,
	deps: ShipApprovalHandlerDeps,
): Promise<ShipApprovalOutcome | null> {
	// Identity: only the canonical founder's own message can attribute approval.
	if (args.msg.authorId !== deps.canonicalFounderId) return null;
	// FLY-1847: machine verdicts require an immutable card anchor. Ordinary
	// thread speech belongs to the Lead discussion lane and cannot close a gate.
	if (args.replyToCard !== true) {
		deps.auditSink?.("card_anchor_missing", {});
		return null;
	}

	// A-2: narrow to gates whose session is awaiting_review AND whose current
	// review question is exactly this gate. Require EXACTLY ONE (Codex R1 #2).
	const current = args.shipGates.filter((g) => {
		const authority = deps.gateAuthorityView?.resolve(
			g.questionId,
			g.executionId,
		);
		if (authority) return authority.state === "awaiting_review";
		const s = deps.store.getSession(g.executionId);
		return (
			s?.status === "awaiting_review" && s?.review_question_id === g.questionId
		);
	});
	if (current.length === 0) {
		deps.auditSink?.("narrow_zero", {
			shipGateQids: args.shipGates.map((g) => g.questionId),
		});
		return null;
	}
	if (current.length > 1) {
		deps.auditSink?.("narrow_multi", {
			candidates: current.map((g) => {
				const s = deps.store.getSession(g.executionId);
				return {
					questionId: g.questionId,
					executionId: g.executionId,
					status: s?.status,
					reviewQuestionId: s?.review_question_id,
				};
			}),
		});
		return null;
	}

	const gate = current[0];
	if (!gate) return null;
	const engineAuthority = deps.gateAuthorityView?.resolve(
		gate.questionId,
		gate.executionId,
	);
	const session = engineAuthority
		? {
				status: engineAuthority.state,
				review_question_id: engineAuthority.questionId,
				pr_head_sha: engineAuthority.headSha,
				pr_number: engineAuthority.prNumber,
				issue_identifier: engineAuthority.issueIdentifier,
			}
		: deps.store.getSession(gate.executionId);
	if (!session?.pr_head_sha) {
		deps.auditSink?.("narrow_no_head", { questionId: gate.questionId });
		return null;
	}

	const retryOutcome = (
		stage: string,
		reason: string,
	): ShipApprovalOutcome => ({
		bound: [],
		deferred: [],
		retry: true,
		stage,
		reason,
	});

	const binding: Omit<GateBinding, "targetMessageId"> = {
		questionId: gate.questionId,
		executionId: gate.executionId,
		issueId: args.ctx.issueId,
		issueIdentifier: session.issue_identifier ?? undefined,
		prHeadSha: session.pr_head_sha,
		prNumber: session.pr_number ?? undefined,
		threadId: args.ctx.threadId,
		canonicalFounderId: deps.canonicalFounderId,
	};

	const runMergedGuard = async (): Promise<MergedGateGuardResult | null> => {
		if (!deps.mergedGateGuard) return null;
		return deps.mergedGateGuard({
			executionId: gate.executionId,
			issueId: args.ctx.issueId,
			questionId: gate.questionId,
			projectName: args.ctx.projectName ?? "",
			projectRoot: args.ctx.projectRoot,
			prNumber: session.pr_number ?? undefined,
			source: "text",
		});
	};
	const guardDisposition = (
		result: MergedGateGuardResult,
	): ShipApprovalOutcome | null | undefined => {
		if (result.kind === "continue") return undefined;
		deps.auditSink?.(`merged_gate_guard_${result.kind}`, {
			questionId: gate.questionId,
			...("reason" in result ? { reason: result.reason } : {}),
		});
		if (result.kind === "retry_later") {
			return retryOutcome("merged_gate_guard_retry", result.reason);
		}
		if (result.kind === "terminal_unavailable") {
			return {
				bound: [],
				deferred: [],
				retry: false,
				deadLetter: {
					questionId: gate.questionId,
					stage: "merged_gate_guard_terminal",
					reason: result.reason,
				},
			};
		}
		return {
			bound: [],
			deferred: [],
			suppressed: [{ questionId: gate.questionId }],
			retry: false,
		};
	};

	// ── signal evaluation (text), shared by the live and held paths ──
	let signalAudited = false;
	let classificationFailure: Error | undefined;
	const evaluateSignal = async (): Promise<ApprovalSignal | null> => {
		const evaluateText = deps.evaluateTextImpl ?? evaluateTextSource;
		const signal = await evaluateText({
			gate: binding,
			message: {
				id: args.msg.id,
				content: args.msg.content ?? "",
				authorId: args.msg.authorId ?? "",
			},
			replyToCard: args.replyToCard,
		});
		if (!signal) return null;
		// FLY-1041 Chunk 4: audit the evaluation outcome — the evidence stage the
		// text source provided.
		if (!signalAudited) {
			signalAudited = true;
			const evidence = (signal as { evidence?: ApprovalAttributionEvidence })
				.evidence;
			deps.auditSink?.(evidence?.stage ?? `signal_${signal.kind}`, {
				questionId: gate.questionId,
				kind: signal.kind,
				...(evidence?.reason !== undefined ? { reason: evidence.reason } : {}),
			});
		}
		if (
			(signal.kind === "approve" || signal.kind === "reject") &&
			args.recordDecisionClassification
		) {
			try {
				args.recordDecisionClassification(signal.kind);
			} catch (error) {
				classificationFailure =
					error instanceof Error ? error : new Error(String(error));
				deps.auditSink?.("decision_classification_failed", {
					questionId: gate.questionId,
					decision: signal.kind,
					error: classificationFailure.message,
				});
			}
		}
		return signal;
	};

	/** unclear disposition: infra failure → bounded retry (FLY-1099 §7.3); a
	 * model "unclear" → WAKE-only (retrying won't make semantics clearer). */
	const unclearDisposition = (
		signal: ApprovalSignal,
	): ShipApprovalOutcome | null => {
		const evidence = (signal as { evidence?: ApprovalAttributionEvidence })
			.evidence;
		if (evidence?.stage === "tier3_runner_failed") {
			return retryOutcome(
				"tier3_runner_failed",
				evidence.reason ?? "classifier spawn failed",
			);
		}
		return null;
	};

	// ── held disposition (FLY-1099 §4.2 + §4.4 truth table) ──
	const handleHeld = async (
		reason: ReviewHoldReason | "legacy",
		preEvaluated: ApprovalSignal | null | undefined,
	): Promise<ShipApprovalOutcome | null> => {
		const deferral = deps.deferral;
		if (!deferral || reason === "legacy") {
			// FLY-1041 Chunk 5 byte path: held → decline every founder text write.
			deps.auditSink?.("held_declined", {
				questionId: gate.questionId,
				executionId: gate.executionId,
			});
			return null;
		}
		if (!isDeferrableReviewHoldReason(reason)) {
			// merge_block only clears via same-head recovery; evidence/reviewer
			// readiness holds require a fresh founder action after they clear. None
			// may park an early approval for automatic replay.
			deps.auditSink?.("held_declined", {
				questionId: gate.questionId,
				executionId: gate.executionId,
				holdReason: reason,
			});
			const guardResult = await runMergedGuard();
			if (guardResult) {
				const disposition = guardDisposition(guardResult);
				if (disposition !== undefined) return disposition;
			}
			deferral.queueHeldNotice({
				questionId: gate.questionId,
				msgId: args.msg.id,
				executionId: gate.executionId,
				kind:
					reason === "merge_block"
						? "merge_block"
						: reason === "qa_evidence_missing" ||
								reason === "qa_evidence_unknown"
							? "readiness_hold"
							: "deferred_off",
				holdReason: reason,
			});
			return null;
		}
		// Deferred flag ON: classify (read-only; fail-closed semantics unchanged).
		const signal =
			preEvaluated === undefined ? await evaluateSignal() : preEvaluated;
		if (!signal) return null;
		if (classificationFailure) {
			return retryOutcome(
				"decision_classification_failed",
				classificationFailure.message,
			);
		}
		if (signal.kind === "unclear") {
			// R1 #2 truth-in-time: NEVER a "已存着" reply for unclear — nothing was
			// stored. WAKE-only + ❓ (or bounded retry on infra failure).
			return unclearDisposition(signal);
		}
		const founderRework =
			signal.source === "text" ? signal.founderRework : undefined;
		try {
			const outcome = deferral.defer({
				questionId: gate.questionId,
				msgId: args.msg.id,
				executionId: gate.executionId,
				prHeadSha: session.pr_head_sha as string,
				decision: signal.kind,
				content: args.msg.content ?? "",
				authorUserId: args.msg.authorId ?? "",
				founderIdAtCapture: deps.canonicalFounderId,
				holdReason: reason,
				founderRework,
			});
			deps.auditSink?.("founder_approval_deferred", {
				questionId: gate.questionId,
				decision: signal.kind,
				holdReason: reason,
				outcome,
			});
			return {
				bound: [],
				deferred: [{ questionId: gate.questionId, decision: signal.kind }],
				retry: false,
			};
		} catch (err) {
			deps.auditSink?.("founder_approval_defer_failed", {
				questionId: gate.questionId,
				error: (err as Error).message,
			});
			return retryOutcome("defer_write_failed", (err as Error).message);
		}
	};

	/** Held state: the reason-classified deferral face wins; legacy isHeld kept. */
	const heldState = (): ReviewHoldReason | "legacy" | null => {
		if (deps.deferral) return deps.deferral.holdReason(gate.executionId);
		return deps.isHeld?.(gate.executionId) ? "legacy" : null;
	};

	// FLY-1041 Chunk 5 position preserved: hold check BEFORE classification.
	const heldBefore = heldState();
	if (heldBefore) return handleHeld(heldBefore, undefined);

	if (args.replyToCard) {
		deps.auditSink?.("reply_to_card_hit", { questionId: gate.questionId });
	}

	const signal = await evaluateSignal();
	if (!signal) return null;
	if (classificationFailure) {
		return retryOutcome(
			"decision_classification_failed",
			classificationFailure.message,
		);
	}
	if (signal.kind === "unclear") return unclearDisposition(signal);

	// ── FLY-1099 §4.3 (Codex R3 #2): pre-write re-verify, immediately before the
	// writer. The Tier-3 evaluation awaits an external CLI (seconds + a retry) —
	// a TOCTOU window in which codex/QA/head/binding can move. Re-read the live
	// session: hold reappeared → the held disposition (with the signal already
	// in hand); anything else drifted → fail-closed WAKE-only (never write a
	// stale gate).
	const liveAuthority = deps.gateAuthorityView?.resolve(
		gate.questionId,
		gate.executionId,
	);
	const live = liveAuthority
		? {
				status: liveAuthority.state,
				review_question_id: liveAuthority.questionId,
				pr_head_sha: liveAuthority.headSha,
			}
		: deps.store.getSession(gate.executionId);
	if (
		!live ||
		(live.status !== "awaiting_review" && !liveAuthority) ||
		live.review_question_id !== gate.questionId ||
		live.pr_head_sha !== session.pr_head_sha
	) {
		deps.auditSink?.("prewrite_reverify_failed", {
			questionId: gate.questionId,
			status: live?.status,
			reviewQuestionId: live?.review_question_id,
			prHeadSha: live?.pr_head_sha,
		});
		return null;
	}
	const heldNow = heldState();
	if (heldNow) return handleHeld(heldNow, signal);
	const mergedGuardResult = await runMergedGuard();
	if (mergedGuardResult) {
		const disposition = guardDisposition(mergedGuardResult);
		if (disposition !== undefined) return disposition;
	}

	const write = deps.writeGateResponseImpl ?? writeGateResponseAndRunPostWrite;
	const founderRework =
		signal.source === "text" && signal.kind === "reject"
			? signal.founderRework
			: undefined;
	const answer =
		signal.kind === "approve"
			? '{"approved": true}'
			: JSON.stringify({ approved: false, feedback: args.msg.content ?? "" });

	// FLY-1099 §4.3 (Codex R4 #2 + R5 #1): the guarded onResponseWritten wrapper
	// — the conflict judgement runs BEFORE the production hook can wake/flip.
	const guard = makeGuardedOnResponseWritten<
		Parameters<
			NonNullable<
				Parameters<
					typeof writeGateResponseAndRunPostWrite
				>[0]["onResponseWritten"]
			>
		>[0]
	>({
		db: deps.db as ResponseGuardDb,
		canonicalFounderId: deps.canonicalFounderId,
		decision: signal.kind,
		expectedAnswer: answer,
		original: deps.onResponseWritten,
	});

	/**
	 * FLY-1099 (Codex code R1 HIGH-1): once a response reaches a durable state
	 * the gate leaves `getPendingQuestions`, so the deliverer can NEVER
	 * re-match this founder message — a bare retry disposition is unreachable
	 * and the pinned cursor would later skip the message as "irrelevant" and
	 * wipe its retry row. Convergence ownership therefore moves to the REBIND
	 * pass: durably park the decision (no thread notice — the decision is
	 * already recorded) and report `deferred`. Only when no deferral is wired
	 * (legacy assemblies) does the old retry disposition remain.
	 */
	const parkOrRetry = (
		decision: "approve" | "reject",
		stage: string,
		reason: string,
	): ShipApprovalOutcome => {
		if (deps.deferral) {
			try {
				deps.deferral.parkForConvergence({
					questionId: gate.questionId,
					msgId: args.msg.id,
					executionId: gate.executionId,
					prHeadSha: session.pr_head_sha as string,
					decision,
					content: args.msg.content ?? "",
					authorUserId: args.msg.authorId ?? "",
					founderIdAtCapture: deps.canonicalFounderId,
					reason,
					founderRework,
				});
				deps.auditSink?.("founder_approval_parked_convergence", {
					questionId: gate.questionId,
					decision,
					stage,
					reason,
				});
				return {
					bound: [],
					deferred: [{ questionId: gate.questionId, decision }],
					retry: false,
				};
			} catch (err) {
				// Codex code R3 HIGH: the response is durable AND the park failed —
				// no pending-gate rematch can EVER recover this message, so a retry
				// disposition would be unreachable (the cursor would later skip the
				// message as irrelevant and wipe its retry row). The only honest
				// terminal is an IMMEDIATE dead-letter: the deliverer lands the
				// durable audit + must-deliver alert without a bounded-retry lap.
				deps.auditSink?.("convergence_park_failed", {
					questionId: gate.questionId,
					error: (err as Error).message,
				});
				return {
					bound: [],
					deferred: [],
					retry: false,
					deadLetter: {
						questionId: gate.questionId,
						stage: "convergence_park_failed",
						reason: `${reason}; park failed: ${(err as Error).message}`,
					},
				};
			}
		}
		deps.auditSink?.(stage, { questionId: gate.questionId, decision, reason });
		return retryOutcome(stage, reason);
	};

	let res: Awaited<ReturnType<typeof writeGateResponseAndRunPostWrite>>;
	try {
		res = await write({
			db: deps.db,
			store: deps.store,
			gateAuthorityView: deps.gateAuthorityView,
			questionId: gate.questionId,
			executionId: gate.executionId,
			source: "text",
			cardAuthority: deps.cardAuthority,
			actor: deps.canonicalFounderId,
			founderId: deps.canonicalFounderId,
			founderMessage: args.founderMessage,
			founderRework,
			...(signal.kind === "reject" ? { intent: "kickback" as const } : {}),
			answer,
			expectedCurrentReviewQuestionId: session.review_question_id ?? undefined,
			holdReasonFor: deps.deferral
				? (executionId) => deps.deferral!.holdReason(executionId)
				: deps.isHeld
					? (executionId) => (deps.isHeld!(executionId) ? "qa_not_green" : null)
					: undefined,
			onResponseWritten: guard.hook,
		});
	} catch (err) {
		// e.g. a UNIQUE race on insertResponse — a response now exists, so the
		// deliverer can never re-match this message (HIGH-1); park for the
		// rebind pass to re-classify (guard: exact retry / conflict / gate_gone).
		deps.auditSink?.("write_error", {
			questionId: gate.questionId,
			error: (err as Error).message,
		});
		return parkOrRetry(signal.kind, "write_error", (err as Error).message);
	}

	// ── outcome state machine (FLY-1099 §4.3, R2 #1 postcondition-based) ──
	const refusal = guard.state.refusal;
	if (refusal === "content_mismatch") {
		// R4 #2: canonical founder's SAME-direction reject with DIFFERENT
		// feedback — terminal conflicting_prior_feedback: the stored response
		// stays authoritative, zero hook / zero wake of the new text.
		deps.auditSink?.("conflicting_prior_feedback", {
			questionId: gate.questionId,
			stored: excerpt(guard.state.priorContent),
			requested: excerpt(answer),
		});
		return null;
	}
	if (refusal) {
		// actor_mismatch / direction_mismatch / missing_response: someone (or
		// something) else answered — nothing for this path to do (gate_gone
		// semantics; the audit carries the truth).
		deps.auditSink?.("prior_response_mismatch", {
			questionId: gate.questionId,
			refusal,
			priorActor: guard.state.priorActor,
		});
		return null;
	}

	const decision = signal.kind;
	if (res.written || res.reason === "already_answered") {
		if (decision === "reject") {
			// (a')+(b') for the LIVE path (Codex code R1 HIGH-2): the production
			// hook returns void (its wake is fire-and-forget), so "hook ok" proves
			// nothing about delivery. The reject postcondition = response durable +
			// a DURABLE feedback_wake intent committed (the drain delivers it
			// at-least-once). The hook still ran (immediate wake attempt — a
			// harmless duplicate hint).
			if (deps.deferral) {
				try {
					deps.deferral.queueFeedbackWake({
						questionId: gate.questionId,
						msgId: args.msg.id,
						executionId: gate.executionId,
						feedback: args.msg.content ?? "",
					});
				} catch (err) {
					// Codex code R2 HIGH: the reject response is ALREADY durable here,
					// so a bare retry is the same unreachable shape as HIGH-1 (the gate
					// leaves getPendingQuestions and the cursor skips the message as
					// irrelevant). Park for the rebind pass — its exact-response path
					// commits the feedback_wake intent atomically with consume.
					deps.auditSink?.("feedback_wake_queue_failed", {
						questionId: gate.questionId,
						error: (err as Error).message,
					});
					return parkOrRetry(
						"reject",
						"feedback_wake_queue_failed",
						(err as Error).message,
					);
				}
			} else if (!res.retrySafe) {
				// Legacy (no deferral wired): the hook is the only wake carrier.
				deps.auditSink?.("postcondition_pending", {
					questionId: gate.questionId,
					decision,
					written: res.written,
				});
				return retryOutcome(
					"postcondition_pending",
					"post-write hook did not reach a safe state",
				);
			}
		} else {
			// approve — (b): the FSM must actually have flipped; `written:true` /
			// "hook ok" alone are not the postcondition (R2 #1). Unflipped →
			// convergence is the rebind pass's job (HIGH-1: the deliverer can
			// never re-match an answered gate).
			if (!res.retrySafe) {
				return parkOrRetry(
					decision,
					"postcondition_pending",
					"post-write hook did not reach a safe state",
				);
			}
			const afterAuthority = deps.gateAuthorityView?.resolve(
				gate.questionId,
				gate.executionId,
			);
			const after = deps.store.getSession(gate.executionId);
			if (
				!afterAuthority &&
				(!after || !APPROVE_FLIPPED_STATUSES.has(after.status ?? ""))
			) {
				return parkOrRetry(
					decision,
					"postcondition_pending",
					`approve response durable but session not flipped (status=${after?.status ?? "missing"})`,
				);
			}
		}
		deps.auditSink?.("response_written", {
			questionId: gate.questionId,
			decision,
			written: res.written,
			retrySafe: res.retrySafe,
		});
		return {
			bound: [{ questionId: gate.questionId, decision }],
			deferred: [],
			retry: false,
		};
	}

	// Writer guard refusals (question_missing / not_approve_to_ship / stale
	// binding / status_* / conflicting_prior_response): nothing to write here —
	// WAKE-only fallback (cursor advances; these are not transient).
	deps.auditSink?.("write_refused", {
		questionId: gate.questionId,
		decision,
		written: res.written,
		retrySafe: res.retrySafe,
		...(res.reason !== undefined ? { reason: res.reason } : {}),
	});
	return null;
}
