/**
 * FLY-799 Part A — founder ship-approval handler.
 *
 * The assembly the deliverer's ship branch calls (`tryFounderShipApproval`).
 * Composes the tested primitives:
 *   identity (canonical founder) → A-2 narrow to EXACTLY ONE current ship gate
 *   (session awaiting_review && review_question_id === questionId) → TextSource
 *   (v1; ImageSource behind its own default-off flag, wired later) → shared
 *   `writeGateResponseAndRunPostWrite`.
 *
 * Returns `{ handled, retrySafe }` for the resolved gate (approve → wrote
 * `{approved:true}`; reject → wrote feedback; the post-write hook flips status +
 * wakes). Returns null when it cannot safely attribute (non-founder / not
 * exactly one current gate / unclear) so the deliverer falls back to WAKE-only.
 */

import type { ImageAttachment } from "./image-approval-source.js";
import { evaluateTextSource } from "./text-approval-source.js";
import type {
	ApprovalAttributionEvidence,
	ApprovalSignal,
	GateBinding,
} from "./types.js";
import {
	type GateResponseDb,
	writeGateResponseAndRunPostWrite,
} from "./write-gate-response.js";

interface HandlerSession {
	status?: string;
	review_question_id?: string | null;
	pr_head_sha?: string | null;
	pr_number?: number | null;
	issue_identifier?: string | null;
}

export interface ShipApprovalHandlerDeps {
	canonicalFounderId: string;
	store: { getSession(executionId: string): HandlerSession | undefined };
	db: GateResponseDb;
	evaluateTextImpl?: typeof evaluateTextSource;
	writeGateResponseImpl?: typeof writeGateResponseAndRunPostWrite;
	onResponseWritten?: Parameters<
		typeof writeGateResponseAndRunPostWrite
	>[0]["onResponseWritten"];
	/**
	 * FLY-799 (image approval, default-OFF fast-follow): when true AND an image
	 * evaluator is injected AND the founder message carries image attachments, a
	 * mirrored-image confirmation is evaluated BEFORE the text path (an image
	 * approve/reject is authoritative; unclear/null falls through to text). The
	 * production image evaluator (download + sha256 + multimodal classify) is the
	 * flip-on step; absent here → text-only (v1 default).
	 */
	imageApproval?: boolean;
	evaluateImageImpl?: (args: {
		gate: Omit<GateBinding, "targetMessageId">;
		message: {
			id: string;
			authorId: string;
			imageAttachments: ImageAttachment[];
		};
	}) => Promise<ApprovalSignal | null>;
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
	 * founder text is NEVER written — neither approve NOR reject/feedback —
	 * deliberately conservative: everything stays WAKE-only until the hold
	 * clears (Codex R2 note 3). Absent → no hold check (byte-compat).
	 */
	isHeld?: (executionId: string) => boolean;
}

export interface ShipApprovalHandlerArgs {
	msg: {
		id: string;
		content?: string;
		authorId?: string;
		/** FLY-799 image approval (fast-follow): populated only once the deliverer
		 * downloads + hashes attachments; absent in the v1 default (text-only). */
		imageAttachments?: ImageAttachment[];
	};
	shipGates: {
		questionId: string;
		checkpoint: string | null;
		executionId: string;
		createdAtMs: number;
	}[];
	ctx: { issueId: string; threadId: string };
	/**
	 * FLY-1041 Chunk 7: this founder message is a VERIFIED Discord reply
	 * (type 19 + reference in this thread) to THIS gate's ship card — the
	 * deliverer already narrowed shipGates to that one gate. Threaded into the
	 * Tier-3 prompt so short affirmations on the card bind deterministically.
	 */
	replyToCard?: boolean;
}

export async function tryFounderShipApproval(
	args: ShipApprovalHandlerArgs,
	deps: ShipApprovalHandlerDeps,
): Promise<{ handled: string[]; retrySafe: boolean } | null> {
	// Identity: only the canonical founder's own message can attribute approval.
	if (args.msg.authorId !== deps.canonicalFounderId) return null;

	// A-2: narrow to gates whose session is awaiting_review AND whose current
	// review question is exactly this gate. Require EXACTLY ONE (Codex R1 #2).
	const current = args.shipGates.filter((g) => {
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
	const session = deps.store.getSession(gate.executionId);
	if (!session?.pr_head_sha) {
		deps.auditSink?.("narrow_no_head", { questionId: gate.questionId });
		return null;
	}

	// FLY-1041 Chunk 5: held (codex not green / QA running / merge_block) →
	// decline EVERY founder text decision — approve AND reject alike stay
	// unwritten (WAKE-only) until the hold clears. The founder gets the ❓
	// receipt (Chunk 8) instead of a silent write that verify-approval would
	// refuse anyway (the FLY-910 05:47 confusion).
	if (deps.isHeld?.(gate.executionId)) {
		deps.auditSink?.("held_declined", {
			questionId: gate.questionId,
			executionId: gate.executionId,
		});
		return null;
	}

	if (args.replyToCard) {
		deps.auditSink?.("reply_to_card_hit", { questionId: gate.questionId });
	}

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

	// FLY-799 image approval (default-OFF fast-follow): an image approve/reject is
	// authoritative; unclear/null falls through to the text path below. Only
	// active when the flag is on, an evaluator is injected, AND attachments are
	// present — so v1 (no evaluator wired) is byte-compatibly text-only.
	let signal: ApprovalSignal | null = null;
	if (
		deps.imageApproval &&
		deps.evaluateImageImpl &&
		args.msg.imageAttachments &&
		args.msg.imageAttachments.length > 0
	) {
		const imageSignal = await deps.evaluateImageImpl({
			gate: binding,
			message: {
				id: args.msg.id,
				authorId: args.msg.authorId ?? "",
				imageAttachments: args.msg.imageAttachments,
			},
		});
		if (imageSignal && imageSignal.kind !== "unclear") signal = imageSignal;
	}

	if (!signal) {
		const evaluateText = deps.evaluateTextImpl ?? evaluateTextSource;
		signal = await evaluateText({
			gate: binding,
			message: {
				id: args.msg.id,
				content: args.msg.content ?? "",
				authorId: args.msg.authorId ?? "",
			},
			replyToCard: args.replyToCard,
		});
	}
	if (!signal) return null;

	// FLY-1041 Chunk 4: audit the evaluation outcome — the evidence stage when
	// the source provided one (text), else the bare signal kind (image).
	const evidence = (signal as { evidence?: ApprovalAttributionEvidence })
		.evidence;
	deps.auditSink?.(evidence?.stage ?? `signal_${signal.kind}`, {
		questionId: gate.questionId,
		kind: signal.kind,
		...(evidence?.reason !== undefined ? { reason: evidence.reason } : {}),
	});
	if (signal.kind === "unclear") return null; // WAKE-only fallback

	const write = deps.writeGateResponseImpl ?? writeGateResponseAndRunPostWrite;
	const answer =
		signal.kind === "approve"
			? '{"approved": true}'
			: JSON.stringify({ approved: false, feedback: args.msg.content ?? "" });

	const res = await write({
		db: deps.db,
		store: { getSession: (e) => deps.store.getSession(e) },
		questionId: gate.questionId,
		executionId: gate.executionId,
		actor: deps.canonicalFounderId,
		answer,
		expectedCurrentReviewQuestionId: session.review_question_id ?? undefined,
		onResponseWritten: deps.onResponseWritten,
	});
	deps.auditSink?.(res.written ? "response_written" : "write_refused", {
		questionId: gate.questionId,
		decision: signal.kind,
		written: res.written,
		retrySafe: res.retrySafe,
		...(res.reason !== undefined ? { reason: res.reason } : {}),
	});

	if (!res.written && !res.retrySafe) return { handled: [], retrySafe: false };
	return { handled: [gate.questionId], retrySafe: res.retrySafe };
}
