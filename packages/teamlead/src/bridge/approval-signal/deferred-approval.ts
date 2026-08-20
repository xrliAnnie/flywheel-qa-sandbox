/**
 * FLY-1099 §4 — deferred founder approvals: capture support + the rebind pass.
 *
 * While a ship gate is founder-held on a SELF-CLEARING reason (codex_pending /
 * qa_not_green), a clear founder approve/reject is durably parked
 * (StateStore.founder_deferred_approval) instead of silently declined; when
 * the hold clears, `runDeferredApprovalRebindPass` re-runs EVERY guard the
 * live path runs (TTL / founder identity / gate validity / head / hold) and
 * writes through the SAME `writeGateResponseAndRunPostWrite` + guarded
 * `onResponseWritten` wrapper — a deferral can never take a shortcut around
 * the live authorization chain (safety invariant §1).
 *
 * All founder-facing texts live here (capture notice / TTL / head-drift /
 * rebound) so wording is testable and consistent.
 */

import { resolveFounderTimezone } from "flywheel-config";
import type {
	FounderActionIntent,
	FounderDeferredApproval,
	SessionEvent,
} from "../../StateStore.js";
import type { FounderReworkHint } from "../../workflow-rework-hint.js";
import type { ReviewHoldReason } from "../auto-qa-held.js";
import {
	parseSqliteUtcMs,
	snowflakeToMs,
	truncate,
} from "../founder-notify-utils.js";
import type { MergedGateGuard } from "../merged-gate-guard.js";
import { reactToFounderMessage } from "./founder-ack.js";
import type { DeferralSupport } from "./founder-ship-approval-handler.js";
import type { GateAuthorityView } from "./gate-authority-view.js";
import {
	isApprovalContent,
	makeGuardedOnResponseWritten,
	type ResponseGuardDb,
} from "./response-guard.js";
import {
	type GateResponseDb,
	writeGateResponseAndRunPostWrite,
} from "./write-gate-response.js";

const DEFAULT_TTL_MS = 45 * 60_000; // §8: FLYWHEEL_DEFERRED_APPROVAL_TTL_MS

export function deferredApprovalTtlMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const n = Number.parseInt(env.FLYWHEEL_DEFERRED_APPROVAL_TTL_MS ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

// ── founder-facing texts (人话; exported for tests) ─────────────────────────

const HOLD_LABELS: Record<"codex_pending" | "qa_not_green", string> = {
	codex_pending: "codex review 还没过",
	qa_not_green: "QA 还没绿",
};

const NON_DEFERRABLE_HOLD_LABELS: Partial<Record<ReviewHoldReason, string>> = {
	merge_block: "合并被挡",
	qa_evidence_missing: "独立 QA 证据缺失",
	qa_evidence_unknown: "PR / head 或 QA 证据无法确认",
	no_qualified_reviewer: "没有合格的独立 reviewer",
};

export function heldReplyText(
	decision: "approve" | "reject",
	holdReason: "codex_pending" | "qa_not_green",
	ttlMinutes: number,
): string {
	const label = HOLD_LABELS[holdReason];
	if (decision === "approve") {
		return (
			`收到你的批准 🕒 —— 这个 gate 现在卡在「${label}」,暂时绑不上。` +
			`你的批准我先存着(${ttlMinutes} 分钟内有效):卡点一清会自动生效;` +
			"要是过期了或代码更新了,我会再来找你重新确认。"
		);
	}
	return (
		`收到你的意见 🕒 —— 现在卡在「${label}」,` +
		`卡点清了之后会作为你的反馈生效(${ttlMinutes} 分钟内有效)。`
	);
}

export function mergeBlockPointerText(): string {
	return (
		"这个 PR 之前被合并挡下了(merge block),走的是另一条恢复流程——" +
		"需要你对当前 head 重新批准(恢复流程会把新的确认发给你),这条消息我没法直接绑。"
	);
}

export function readinessHoldPointerText(
	holdReason: "qa_evidence_missing" | "qa_evidence_unknown",
): string {
	const label = NON_DEFERRABLE_HOLD_LABELS[holdReason];
	return (
		`这个 PR 现在还不能批准(${label})——这条批准没有被暂存。` +
		"等当前 head 的独立 QA 证据确认通过后,请在新的批准卡上重新确认。"
	);
}

export function deferredOffExplainerText(holdReason: ReviewHoldReason): string {
	const label =
		NON_DEFERRABLE_HOLD_LABELS[holdReason] ??
		HOLD_LABELS[holdReason as "codex_pending" | "qa_not_green"];
	return `你的批准现在绑不上(${label}),暂存功能当前关闭——卡点清了之后请再说一次。`;
}

/** HH:MM (founder's timezone) of the founder message, from its snowflake. */
export function founderMsgClock(
	msgId: string,
	timezone = resolveFounderTimezone(),
): string {
	const ms = snowflakeToMs(msgId);
	if (ms === null) return "";
	try {
		return new Date(ms).toLocaleTimeString("en-US", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			timeZone: timezone,
		});
	} catch {
		return "";
	}
}

const decisionLabel = (d: "approve" | "reject"): string =>
	d === "approve" ? "批准" : "反馈";

export function ttlExpiredText(row: {
	msg_id: string;
	decision: "approve" | "reject";
}): string {
	const clock = founderMsgClock(row.msg_id);
	return `你${clock ? ` ${clock}` : ""} 的${decisionLabel(row.decision)}已过期(卡点一直没清)——需要的话请再说一次。`;
}

export function headDriftText(row: {
	msg_id: string;
	decision: "approve" | "reject";
}): string {
	const clock = founderMsgClock(row.msg_id);
	return `代码更新过(PR head 变了),你${clock ? ` ${clock}` : ""} 的${decisionLabel(row.decision)}作废——请对新版本重新确认。`;
}

export function reboundNoticeText(row: {
	msg_id: string;
	decision: "approve" | "reject";
}): string {
	const clock = founderMsgClock(row.msg_id);
	// R4 #1: the reject wording is honest about (b') — the wake INTENT is
	// committed; delivery is at-least-once in flight, so "已记录,正在通知",
	// never "已送达".
	return row.decision === "approve"
		? `你${clock ? ` ${clock}` : ""} 的批准已自动生效 ✅(卡点已清,gate 已绑定)。`
		: `你${clock ? ` ${clock}` : ""} 的反馈已记录,正在通知 runner。`;
}

// ── action-key contracts (shared with StateStore's supersede LIKE prefix) ──

export const heldReplyActionKey = (qid: string, msgId: string): string =>
	`held-reply-${qid}-${msgId}`;
export const ttlNoticeActionKey = (qid: string, msgId: string): string =>
	`ttl-notice-${qid}-${msgId}`;
export const headDriftNoticeActionKey = (qid: string, msgId: string): string =>
	`head-drift-notice-${qid}-${msgId}`;
export const reboundNoticeActionKey = (qid: string, msgId: string): string =>
	`rebound-notice-${qid}-${msgId}`;
export const feedbackWakeActionKey = (qid: string, msgId: string): string =>
	`feedback-wake-${qid}-${msgId}`;

// ── capture support (the handler's DeferralSupport, built per thread ctx) ──

/** Structural StateStore subset the deferral capture needs. */
export interface DeferralCaptureStore {
	deferFounderApproval(input: {
		questionId: string;
		msgId: string;
		executionId: string;
		issueId: string;
		projectName: string;
		prHeadSha: string;
		threadId: string;
		decision: "approve" | "reject";
		content: string;
		authorUserId: string;
		founderIdAtCapture: string;
		founderRework?: FounderReworkHint;
		ttlSeconds: number;
		heldReplyAction?: FounderActionIntent;
		audit?: SessionEvent;
	}): "inserted" | "noop_existing";
	insertFounderAction(intent: FounderActionIntent): boolean;
}

export function makeDeferralSupport(args: {
	store: DeferralCaptureStore;
	holdReasonFor(executionId: string): ReviewHoldReason | null;
	ctx: { issueId: string; threadId: string; projectName: string };
	env?: Record<string, string | undefined>;
}): DeferralSupport {
	const env = args.env ?? process.env;
	const { store, ctx } = args;
	return {
		holdReason: (executionId) => args.holdReasonFor(executionId),
		defer: (a) => {
			const ttlMs = deferredApprovalTtlMs(env);
			const ttlMinutes = Math.max(1, Math.round(ttlMs / 60_000));
			return store.deferFounderApproval({
				questionId: a.questionId,
				msgId: a.msgId,
				executionId: a.executionId,
				issueId: ctx.issueId,
				projectName: ctx.projectName,
				prHeadSha: a.prHeadSha,
				threadId: ctx.threadId,
				decision: a.decision,
				content: a.content,
				authorUserId: a.authorUserId,
				founderIdAtCapture: a.founderIdAtCapture,
				founderRework: a.founderRework,
				ttlSeconds: Math.floor(ttlMs / 1000),
				// The "已存着" notice intent lands in the same durable transaction as
				// the deferral row (truth-in-time).
				heldReplyAction: {
					actionKey: heldReplyActionKey(a.questionId, a.msgId),
					kind: "held_reply",
					executionId: a.executionId,
					issueId: ctx.issueId,
					projectName: ctx.projectName,
					threadId: ctx.threadId,
					payload: {
						text: heldReplyText(a.decision, a.holdReason, ttlMinutes),
						questionId: a.questionId,
						msgId: a.msgId,
						decision: a.decision,
					},
				},
				audit: {
					event_id: `founder-approval-deferred-${a.questionId}-${a.msgId}`,
					execution_id: a.executionId,
					issue_id: ctx.issueId,
					project_name: ctx.projectName,
					event_type: "founder_approval_deferred",
					source: "bridge.deferred-approval",
					payload: {
						questionId: a.questionId,
						msgId: a.msgId,
						decision: a.decision,
						holdReason: a.holdReason,
						prHeadSha: a.prHeadSha,
						excerpt: truncate(a.content, 200),
					},
				},
			});
		},
		queueHeldNotice: (a) => {
			// Best-effort — an explainer must never break attribution.
			try {
				const text =
					a.kind === "merge_block"
						? mergeBlockPointerText()
						: a.kind === "readiness_hold" &&
								(a.holdReason === "qa_evidence_missing" ||
									a.holdReason === "qa_evidence_unknown")
							? readinessHoldPointerText(a.holdReason)
							: deferredOffExplainerText(a.holdReason);
				store.insertFounderAction({
					actionKey: heldReplyActionKey(a.questionId, a.msgId),
					kind: "held_reply",
					executionId: a.executionId,
					issueId: ctx.issueId,
					projectName: ctx.projectName,
					threadId: ctx.threadId,
					payload: {
						text,
						questionId: a.questionId,
						msgId: a.msgId,
						explainer: a.kind,
					},
				});
			} catch (err) {
				console.warn(
					`[deferred-approval] queueHeldNotice failed for ${a.questionId}: ${(err as Error).message}`,
				);
			}
		},
		// FLY-1099 (Codex code R1 HIGH-1): convergence park — the decision's
		// response is already durable; only the postcondition is pending. Same
		// durable row as defer but NO "已存着" thread notice (that would lie —
		// nothing is waiting on a hold). The rebind pass owns convergence.
		parkForConvergence: (a) => {
			store.deferFounderApproval({
				questionId: a.questionId,
				msgId: a.msgId,
				executionId: a.executionId,
				issueId: ctx.issueId,
				projectName: ctx.projectName,
				prHeadSha: a.prHeadSha,
				threadId: ctx.threadId,
				decision: a.decision,
				content: a.content,
				authorUserId: a.authorUserId,
				founderIdAtCapture: a.founderIdAtCapture,
				founderRework: a.founderRework,
				ttlSeconds: Math.floor(deferredApprovalTtlMs(env) / 1000),
				audit: {
					event_id: `founder-approval-parked-${a.questionId}-${a.msgId}`,
					execution_id: a.executionId,
					issue_id: ctx.issueId,
					project_name: ctx.projectName,
					event_type: "founder_approval_parked_convergence",
					source: "bridge.deferred-approval",
					payload: {
						questionId: a.questionId,
						msgId: a.msgId,
						decision: a.decision,
						reason: a.reason,
					},
				},
			});
		},
		// FLY-1099 (Codex code R1 HIGH-2): the LIVE reject's (b') — a durable
		// feedback_wake intent (at-least-once drain delivery); the void
		// fire-and-forget hook is never trusted as a delivery receipt.
		queueFeedbackWake: (a) => {
			store.insertFounderAction({
				actionKey: feedbackWakeActionKey(a.questionId, a.msgId),
				kind: "feedback_wake",
				executionId: a.executionId,
				issueId: ctx.issueId,
				projectName: ctx.projectName,
				threadId: ctx.threadId,
				payload: {
					questionId: a.questionId,
					msgId: a.msgId,
					feedback: a.feedback,
				},
			});
		},
	};
}

// ── the rebind pass (GatePoller founder-reply sub-cadence, zero new timer) ──

/** Structural StateStore subset the rebind pass needs. */
export interface DeferredRebindStore {
	listActiveDeferredApprovals(): FounderDeferredApproval[];
	getSession(executionId: string):
		| {
				status?: string;
				review_question_id?: string | null;
				pr_head_sha?: string | null;
				pr_number?: number | null;
		  }
		| undefined;
	consumeDeferredApproval(input: {
		questionId: string;
		msgId: string;
		notice?: FounderActionIntent;
		feedbackWake?: FounderActionIntent;
		audit?: SessionEvent;
	}): boolean;
	invalidateDeferredApproval(input: {
		questionId: string;
		msgId: string;
		reason: string;
		notice?: FounderActionIntent;
		audit?: SessionEvent;
	}): boolean;
	insertEvent(event: SessionEvent): boolean;
}

/** Writable CommDB face the rebind write needs (real CommDB satisfies it). */
export type RebindCommDb = GateResponseDb &
	ResponseGuardDb & {
		isQuestionPending(questionId: string): boolean;
		close(): void;
	};

export interface DeferredRebindDeps {
	store: DeferredRebindStore;
	/** Current canonical founder id (fail-closed: undefined → skip writes). */
	canonicalFounderId(): string | undefined;
	/** The SAME hold predicate the capture used (reviewHoldReason bound). */
	holdReasonFor(executionId: string): ReviewHoldReason | null;
	/** Writable CommDB for the row's project (caller-owned path convention). */
	openCommDb(projectName: string): RebindCommDb | null;
	/** The production post-write hook (flip + wake); wrapped by the guard. */
	onResponseWritten?: Parameters<
		typeof writeGateResponseAndRunPostWrite
	>[0]["onResponseWritten"];
	writeImpl?: typeof writeGateResponseAndRunPostWrite;
	cardAuthority?: Parameters<
		typeof writeGateResponseAndRunPostWrite
	>[0]["cardAuthority"];
	gateAuthorityView?: GateAuthorityView;
	/** Bot token for the ✅ receipt upgrade on the founder's original message. */
	resolveBotToken(row: FounderDeferredApproval): string | undefined;
	reactImpl?: typeof reactToFounderMessage;
	fetchImpl?: typeof fetch;
	nowMs?: () => number;
	env?: Record<string, string | undefined>;
	/** FLY-1238: shared last-mile guard + canonical project root. */
	mergedGateGuard?: MergedGateGuard;
	resolveProjectRoot?: (projectName: string) => string | undefined;
}

function rebindAudit(
	row: FounderDeferredApproval,
	suffix: string,
	eventType: string,
	payload: Record<string, unknown>,
): SessionEvent {
	return {
		event_id: `founder-deferred-${suffix}-${row.question_id}-${row.msg_id}`,
		execution_id: row.execution_id,
		issue_id: row.issue_id,
		project_name: row.project_name,
		event_type: eventType,
		source: "bridge.deferred-approval",
		payload: { questionId: row.question_id, msgId: row.msg_id, ...payload },
	};
}

function noticeIntent(
	row: FounderDeferredApproval,
	actionKey: string,
	text: string,
): FounderActionIntent {
	return {
		actionKey,
		kind: actionKey.startsWith("ttl-notice-")
			? "ttl_expired_notice"
			: actionKey.startsWith("head-drift-notice-")
				? "head_drift_notice"
				: "rebound_notice",
		executionId: row.execution_id,
		issueId: row.issue_id,
		projectName: row.project_name,
		threadId: row.thread_id,
		payload: {
			text,
			questionId: row.question_id,
			msgId: row.msg_id,
			decision: row.decision,
		},
	};
}

/**
 * FLY-1099 §4.3 (b) evidence: the production hook flips approve to
 * approved_to_ship, and drives an already-merged parked session to completed
 * (FLY-869 B-3, plugin.ts buildGateResponsePostWriteHook).
 */
const APPROVE_FLIPPED_STATUSES = new Set(["approved_to_ship", "completed"]);

export async function runDeferredApprovalRebindPass(
	deps: DeferredRebindDeps,
): Promise<void> {
	const now = deps.nowMs?.() ?? Date.now();
	const rows = deps.store.listActiveDeferredApprovals();
	if (rows.length === 0) return;

	for (const row of rows) {
		try {
			await rebindOne(row, deps, now);
		} catch (err) {
			// Keep active; converges by TTL. Idempotent one-shot audit per row.
			deps.store.insertEvent(
				rebindAudit(row, "error", "founder_deferral_rebind_error", {
					error: (err as Error).message,
				}),
			);
		}
	}
}

async function rebindOne(
	row: FounderDeferredApproval,
	deps: DeferredRebindDeps,
	now: number,
): Promise<void> {
	const session = deps.store.getSession(row.execution_id);
	const initialEngineAuthority = deps.gateAuthorityView?.resolve(
		row.question_id,
		row.execution_id,
	);
	const authoritySession = initialEngineAuthority
		? {
				status: initialEngineAuthority.state,
				review_question_id: initialEngineAuthority.questionId,
				pr_head_sha: initialEngineAuthority.headSha,
				pr_number: initialEngineAuthority.prNumber,
			}
		: session;
	// 1. TTL (§4.3 step 1).
	const expiresMs = parseSqliteUtcMs(row.expires_at);
	if (expiresMs !== null && expiresMs <= now) {
		if (!(await guardRebindSideEffect(row, authoritySession, deps))) return;
		deps.store.invalidateDeferredApproval({
			questionId: row.question_id,
			msgId: row.msg_id,
			reason: "ttl_expired",
			notice: noticeIntent(
				row,
				ttlNoticeActionKey(row.question_id, row.msg_id),
				ttlExpiredText(row),
			),
			audit: rebindAudit(row, "ttl", "founder_deferral_expired", {
				expiresAt: row.expires_at,
			}),
		});
		return;
	}

	// 2. Founder identity (§4.3 step 2 — audit only, never a thread ping).
	const founderId = deps.canonicalFounderId();
	if (!founderId) return; // unresolvable identity → fail-closed skip this pass
	if (founderId !== row.founder_id_at_capture) {
		deps.store.invalidateDeferredApproval({
			questionId: row.question_id,
			msgId: row.msg_id,
			reason: "founder_identity_changed",
			audit: rebindAudit(row, "identity", "founder_deferral_invalidated", {
				reason: "founder_identity_changed",
			}),
		});
		return;
	}

	// 3. Gate validity (§4.3 step 3 — gate answered/moved elsewhere → silent).
	// Codex code R1 HIGH-1: an ANSWERED question drops out of the pending
	// predicate, but "answered by the founder while the session binding is
	// intact" is exactly the convergence-pending shape (FSM unflipped / hook
	// unsafe / UNIQUE race) whose ONLY re-drive is this pass — so an existing
	// response keeps the gate alive here; the writer's already_answered path +
	// the guarded hook classify it (exact retry → re-run hook; conflict /
	// foreign actor → invalidate below).
	const db = deps.openCommDb(row.project_name);
	if (!db) return; // CommDB unavailable → transient, retry next pass
	try {
		const bindingIntact = initialEngineAuthority
			? (initialEngineAuthority.state === "awaiting_review" ||
					initialEngineAuthority.state === "approved") &&
				initialEngineAuthority.questionId === row.question_id
			: session?.status === "awaiting_review" &&
				session.review_question_id === row.question_id;
		const priorResponse = db.getResponse(row.question_id);
		const gateAlive =
			bindingIntact &&
			(db.isQuestionPending(row.question_id) || priorResponse !== undefined);
		if (!gateAlive) {
			// A parked APPROVE whose flip already landed (crash between flip and
			// consume): postcondition is met — consume + notice instead of a
			// misleading gate_gone.
			if (
				row.decision === "approve" &&
				session?.review_question_id === row.question_id &&
				APPROVE_FLIPPED_STATUSES.has(session.status ?? "") &&
				priorResponse &&
				priorResponse.from_agent === founderId &&
				isApprovalContent(priorResponse.content)
			) {
				await finalizeConsume(row, deps);
				return;
			}
			deps.store.invalidateDeferredApproval({
				questionId: row.question_id,
				msgId: row.msg_id,
				reason: "gate_gone",
				audit: rebindAudit(row, "gategone", "founder_deferral_invalidated", {
					reason: "gate_gone",
					sessionStatus: session?.status,
					reviewQuestionId: session?.review_question_id,
				}),
			});
			return;
		}

		// 4. Head guardrail (§4.3 step 4 — founder must re-confirm a new head).
		const liveHead = authoritySession?.pr_head_sha?.toLowerCase();
		if (liveHead !== row.pr_head_sha.toLowerCase()) {
			if (!(await guardRebindSideEffect(row, authoritySession, deps))) return;
			deps.store.invalidateDeferredApproval({
				questionId: row.question_id,
				msgId: row.msg_id,
				reason: "head_drift",
				notice: noticeIntent(
					row,
					headDriftNoticeActionKey(row.question_id, row.msg_id),
					headDriftText(row),
				),
				audit: rebindAudit(row, "headdrift", "founder_deferral_invalidated", {
					reason: "head_drift",
					capturedHead: row.pr_head_sha,
					liveHead,
				}),
			});
			return;
		}

		// 5. Hold recheck (§4.3 step 5 — still held → wait; TTL bounds it).
		if (deps.holdReasonFor(row.execution_id) !== null) return;
		if (!(await guardRebindSideEffect(row, authoritySession, deps))) return;

		// 6. Write — the SAME writer + guarded wrapper as the live path.
		const answer =
			row.decision === "approve"
				? '{"approved": true}'
				: JSON.stringify({ approved: false, feedback: row.content });
		const guard = makeGuardedOnResponseWritten<
			Parameters<
				NonNullable<
					Parameters<
						typeof writeGateResponseAndRunPostWrite
					>[0]["onResponseWritten"]
				>
			>[0]
		>({
			db,
			canonicalFounderId: founderId,
			decision: row.decision,
			expectedAnswer: answer,
			original: deps.onResponseWritten,
		});
		const write = deps.writeImpl ?? writeGateResponseAndRunPostWrite;
		const res = await write({
			db,
			store: {
				getSession: (e) =>
					deps.store.getSession(e) as
						| { status?: string; review_question_id?: string | null }
						| undefined,
			},
			questionId: row.question_id,
			executionId: row.execution_id,
			source: "deferred",
			cardAuthority: deps.cardAuthority,
			gateAuthorityView: deps.gateAuthorityView,
			actor: founderId,
			founderId,
			founderRework: row.founder_rework,
			...(row.decision === "reject" ? { intent: "kickback" as const } : {}),
			answer,
			expectedCurrentReviewQuestionId: row.question_id,
			holdReasonFor: deps.holdReasonFor,
			onResponseWritten: guard.hook,
		});

		// ── outcome state machine (§4.3, per reason) ──
		const refusal = guard.state.refusal;
		if (refusal === "content_mismatch") {
			// R4 #2: same-direction reject, DIFFERENT feedback — terminal
			// conflicting_prior_feedback: invalidate + double-excerpt audit; the
			// stored response stays authoritative; zero hook / zero wake happened.
			deps.store.invalidateDeferredApproval({
				questionId: row.question_id,
				msgId: row.msg_id,
				reason: "conflicting_prior_feedback",
				audit: rebindAudit(row, "conflict", "conflicting_prior_feedback", {
					stored: truncate(guard.state.priorContent ?? "", 200),
					requested: truncate(answer, 200),
				}),
			});
			return;
		}
		if (refusal) {
			// actor/direction mismatch — someone else answered the gate.
			deps.store.invalidateDeferredApproval({
				questionId: row.question_id,
				msgId: row.msg_id,
				reason: "gate_gone",
				audit: rebindAudit(row, "prior", "founder_deferral_invalidated", {
					reason: "gate_gone",
					refusal,
					priorActor: guard.state.priorActor,
				}),
			});
			return;
		}
		if (res.reason === "conflicting_prior_response") {
			// Writer-level direction conflict (prior response the other way).
			deps.store.invalidateDeferredApproval({
				questionId: row.question_id,
				msgId: row.msg_id,
				reason: "gate_gone",
				audit: rebindAudit(row, "priordir", "founder_deferral_invalidated", {
					reason: "gate_gone",
					writerReason: res.reason,
				}),
			});
			return;
		}
		if (!res.written && res.reason !== "already_answered") {
			// Other writer guard refusals (stale binding / status moved / question
			// missing between checks): keep active — next pass re-classifies via
			// steps 3-5; TTL bounds it (§4.3 "guard 拒绝 → 保持活跃").
			return;
		}
		if (!res.retrySafe) {
			// Response durable but the hook did not reach a safe state — keep
			// active; the writer's already_answered path re-runs the idempotent
			// hook next pass until the postcondition lands (R2 #1).
			return;
		}
		if (row.decision === "approve") {
			const projectedAuthority = deps.gateAuthorityView?.resolve(
				row.question_id,
				row.execution_id,
			);
			if (projectedAuthority?.state === "approved") {
				await finalizeConsume(row, deps);
				return;
			}
			const after = deps.store.getSession(row.execution_id);
			if (!after || !APPROVE_FLIPPED_STATUSES.has(after.status ?? "")) {
				// (a) holds but (b) not yet — hook silently failed to flip. Keep
				// active; re-run next pass (already_answered re-runs the hook).
				return;
			}
		}

		// Postcondition reached → consume + receipt upgrade.
		await finalizeConsume(row, deps);
	} finally {
		db.close();
	}
}

/**
 * Consume an ACTIVE deferral whose postcondition was reached: ONE transaction
 * (consume + rebound notice + reject's full-feedback wake intent — R3 #1 (b')),
 * then the 🕒→✅ receipt upgrade on the founder's ORIGINAL message (one-way;
 * same (msgId, outcome) marker convention as the deliverer — Chunk 8).
 */
async function finalizeConsume(
	row: FounderDeferredApproval,
	deps: DeferredRebindDeps,
): Promise<void> {
	const liveSession = deps.store.getSession(row.execution_id);
	const engineAuthority = deps.gateAuthorityView?.resolve(
		row.question_id,
		row.execution_id,
	);
	if (
		!(await guardRebindSideEffect(
			row,
			engineAuthority
				? {
						status: engineAuthority.state,
						review_question_id: engineAuthority.questionId,
						pr_head_sha: engineAuthority.headSha,
						pr_number: engineAuthority.prNumber,
					}
				: liveSession,
			deps,
		))
	) {
		return;
	}
	const consumed = deps.store.consumeDeferredApproval({
		questionId: row.question_id,
		msgId: row.msg_id,
		notice: noticeIntent(
			row,
			reboundNoticeActionKey(row.question_id, row.msg_id),
			reboundNoticeText(row),
		),
		feedbackWake:
			row.decision === "reject"
				? {
						actionKey: feedbackWakeActionKey(row.question_id, row.msg_id),
						kind: "feedback_wake",
						executionId: row.execution_id,
						issueId: row.issue_id,
						projectName: row.project_name,
						threadId: row.thread_id,
						payload: {
							questionId: row.question_id,
							msgId: row.msg_id,
							// FULL original text (Codex R3 #1) — the runner gets the
							// complete revision request, never an excerpt.
							feedback: row.content,
						},
					}
				: undefined,
		audit: rebindAudit(row, "rebound", "founder_approval_rebound", {
			decision: row.decision,
			prHeadSha: row.pr_head_sha,
		}),
	});
	if (!consumed) return;

	const botToken = deps.resolveBotToken(row);
	if (
		botToken &&
		(deps.env ?? process.env).FLYWHEEL_FOUNDER_APPROVAL_ACK !== "0"
	) {
		const markerFresh = deps.store.insertEvent({
			event_id: `founder-ack-${row.msg_id}-bound`,
			execution_id: row.execution_id,
			issue_id: row.issue_id,
			project_name: row.project_name,
			event_type: "founder_ack_marker",
			source: "bridge.deferred-approval",
			payload: { msgId: row.msg_id, emoji: "✅", outcome: "bound" },
		});
		if (markerFresh) {
			const react = deps.reactImpl ?? reactToFounderMessage;
			const r = await react({
				botToken,
				channelId: row.thread_id,
				messageId: row.msg_id,
				emoji: "✅",
				fetchImpl: deps.fetchImpl,
			});
			deps.store.insertEvent(
				rebindAudit(
					row,
					r.ok ? "ackok" : "ackfail",
					r.ok ? "founder_ack_reacted" : "founder_ack_failed",
					{
						emoji: "✅",
						outcome: "bound",
						...(r.status ? { status: r.status } : {}),
					},
				),
			);
		}
	}
}

/** Guard only at a would-be founder side effect or response write. */
async function guardRebindSideEffect(
	row: FounderDeferredApproval,
	session:
		| {
				status?: string;
				review_question_id?: string | null;
				pr_head_sha?: string | null;
				pr_number?: number | null;
		  }
		| undefined,
	deps: DeferredRebindDeps,
): Promise<boolean> {
	if (!deps.mergedGateGuard) return true;
	const guarded = await deps.mergedGateGuard({
		executionId: row.execution_id,
		issueId: row.issue_id,
		questionId: row.question_id,
		projectName: row.project_name,
		projectRoot: deps.resolveProjectRoot?.(row.project_name),
		prNumber: session?.pr_number ?? undefined,
		source: "deferred_rebind",
	});
	if (guarded.kind === "continue") return true;
	if (guarded.kind === "terminal_unavailable") {
		deps.store.invalidateDeferredApproval({
			questionId: row.question_id,
			msgId: row.msg_id,
			reason: "merged_guard_terminal",
			audit: rebindAudit(
				row,
				"guardterminal",
				"founder_deferral_guard_terminal",
				{ reason: guarded.reason },
			),
		});
	}
	// retry_later remains active; suppress_merged cleanup is owned by the guard.
	return false;
}
