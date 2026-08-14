/**
 * Founder issue-thread ingress. Bridge records one canonical Lead receipt and
 * forwards the original message to Lead without classifying, answering, or
 * routing it. Only a later Lead action may reach a runner and close the handled
 * receipt. This topology is unconditional: the receipt flag pauses chasing
 * only and never restores Bridge auto-processing.
 *
 * Reliability is processed-through (at least once): the cursor advances past a
 * founder message only after its canonical receipt and durable Lead handoff
 * succeed, or after the message is proven irrelevant. A transient failure pins
 * the cursor so the next cadence retries the same message.
 */

import { randomUUID } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import type { InboundCursorStore } from "../lead-backends/codex/InboundCursorStore.js";
import type { StateStore } from "../StateStore.js";
import type { GateMessageBinding } from "./approval-signal/gate-message-binding.js";
import {
	msToSnowflakeLowerBound,
	snowflakeToMs,
	truncate,
} from "./founder-notify-utils.js";
import {
	classifyFounderReviewReply,
	writeTrustedFounderReviewResponse,
} from "./founder-review-response.js";

const DISCORD_API = "https://discord.com/api/v10";
const GET_TIMEOUT_MS = 5_000;
const GET_LIMIT = 50;
const DEFAULT_FOUNDER_DECISION_DEADLINE_MS = 3 * 60_000;

/** Discord message type 19 = REPLY (the only shape reply-to-card accepts). */
const DISCORD_MESSAGE_TYPE_REPLY = 19;
interface RawDiscordMessage {
	id: string;
	content?: string;
	timestamp?: string;
	author?: {
		id?: string;
		bot?: boolean;
		username?: string;
		global_name?: string | null;
	};
	attachments?: Array<{
		filename?: string;
		content_type?: string;
		size?: number;
	}>;
	/**
	 * FLY-1041 Chunk 7: already present in the batch GET response — a REPLY
	 * message (type 19) carries `message_reference.message_id`. No extra API
	 * call needed; `referenced_message` (full object) is NOT relied on.
	 */
	type?: number;
	message_reference?: {
		/** 0/absent = DEFAULT reference; 1 = forward — only DEFAULT qualifies. */
		type?: number;
		message_id?: string;
		channel_id?: string;
	};
}

export interface FounderReplyThreadCtx {
	issueId: string;
	projectName: string;
	threadId: string;
	botToken: string;
	ownerUserId: string;
	graceMs: number;
	commDbPath: string;
	/** Lead id — for the still-pending recheck (getPendingQuestions). */
	leadId: string;
}

export interface PendingQuestionForThread {
	questionId: string;
	/** null = runner_question (non-gated). */
	checkpoint: string | null;
	/** Runner execution id (= question.from_agent). */
	executionId: string;
	createdAtMs: number;
	/**
	 * FLY-945 Fix A: per-checkpoint grace for founder messages matching THIS
	 * question (approve_to_ship → FLYWHEEL_SHIP_GATE_GRACE_MS, default 15s;
	 * everything else → the 10min FLY-605 grace). A message's applicable grace
	 * is the MINIMUM across its matching questions. Absent → ctx.graceMs
	 * (byte-compatible with pre-FLY-945 callers).
	 */
	checkpointGraceMs?: number;
}

/**
 * FLY-1099 §3.2 (Codex R1 #1): the ship-attribution handler's EXPLICIT
 * disposition contract. `bound` = the decision's postcondition was reached
 * (approve: response + FSM flip; reject: response + wake intent). `deferred` =
 * durably parked (held gate) — the message is properly disposed, skip WAKE,
 * the cursor may advance. `retry` = transient infra failure — pin the cursor.
 * null (whole result) = unattributable → byte-compatible WAKE-only.
 */
export interface ShipApprovalOutcome {
	bound: Array<{ questionId: string; decision: "approve" | "reject" }>;
	deferred: Array<{ questionId: string; decision: "approve" | "reject" }>;
	/** Gates retired because their bound PR is already merged. They are handled
	 * without a wake or founder-facing receipt reaction. */
	suppressed?: Array<{ questionId: string }>;
	retry: boolean;
	stage?: string;
	reason?: string;
	/**
	 * Codex code R3 HIGH: the response reached a durable state but EVERY
	 * durable convergence anchor failed (park + wake intent) — once a gate is
	 * answered it never re-enters `getPendingQuestions`, so no retry that
	 * depends on a pending-gate rematch can ever run. The deliverer must
	 * IMMEDIATELY dead-letter the founder message (durable audit + must-deliver
	 * alert) instead of pinning an unreachable retry.
	 */
	deadLetter?: { questionId: string; stage: string; reason: string };
}

/**
 * FLY-1099 §3.4 (Codex R1 #5): structured per-thread scan outcome — the
 * watchdog's health input. A Discord GET failure is an OUTCOME, not just an
 * audit row (consecutive read_failed must be able to alert).
 */
export interface ThreadScanOutcome {
	threadId: string;
	result: "advanced" | "pinned" | "read_failed" | "process_failed" | "noop";
	pinnedMsgId?: string;
	stage?: string;
	reason?: string;
}

/**
 * FLY-1099 §7.1: the bounded-retry / dead-letter ledger face the deliverer
 * drives (backed by StateStore.founder_reply_retry + the action ledger's
 * emit_alert intent; GatePoller wires the policy). Absent → legacy unbounded
 * pin-forever behavior (test fakes stay valid).
 */
export interface FounderReplyRetryLedger {
	/**
	 * Record one transient failure for (thread, msg). The implementation owns
	 * the bounded-retry policy: when attempts/age cross the dead-letter
	 * threshold it atomically dead-letters (mark + audit + durable alert
	 * intent) and returns `deadLettered: true` — the message counts as
	 * DISPOSED (cursor may advance past it under the waterline rule).
	 */
	recordFailure(args: {
		ctx: FounderReplyThreadCtx;
		msgId: string;
		executionId: string;
		stage: string;
		reason: string;
		contentExcerpt: string;
	}): { deadLettered: boolean };
	/**
	 * Codex code R3 HIGH: IMMEDIATE dead-letter (no bounded-retry lap) for a
	 * message whose retry can never re-run (answered gate — no pending
	 * rematch). Same atomic mark + audit + must-deliver alert intent.
	 */
	deadLetterNow(args: {
		ctx: FounderReplyThreadCtx;
		msgId: string;
		executionId: string;
		stage: string;
		reason: string;
		contentExcerpt: string;
	}): { deadLettered: boolean };
	/** Already dead-lettered? (re-scan → skip, treated as non-matching). */
	isDeadLettered(threadId: string, msgId: string): boolean;
	/** Success-path cleanup for one message. */
	clear(threadId: string, msgId: string): void;
	/** Waterline crossed (cursor saved past msgId) — Codex R2 #6 cleanup. */
	clearUpTo(threadId: string, msgIdInclusive: string): void;
}

export interface FounderReplyDeliverDeps {
	store: StateStore;
	fetchImpl?: typeof fetch;
	cursorStore?: InboundCursorStore;
	commDbFactory?: (path: string) => CommDB;
	/** FLY-1099 §7.1: bounded retry + dead-letter (absent → legacy behavior). */
	retryLedger?: FounderReplyRetryLedger;
	/**
	 * Durable founder-message handoff to Lead. GatePoller mirrors the ingress in
	 * its StateStore audit ledger, flushes it, and nudges the canonical inbox row
	 * already recorded by this deliverer. The historical property name remains
	 * for compatibility. Returns true only after durable acceptance and nudge.
	 */
	deliverAmbiguousToLead?: (
		eventId: string,
		payload: Record<string, unknown>,
	) => Promise<boolean>;
	/**
	 * Restore the FLY-945 founder text/card decision path. The canonical
	 * founder receipt is enqueued before this callback runs, so the shared gate
	 * writer can atomically bind the response, source event, receipt, and wake.
	 * Absent keeps the category-agnostic Lead handoff byte-compatible.
	 */
	tryFounderShipApproval?: (args: {
		msg: { id: string; content?: string; authorId?: string };
		shipGates: PendingQuestionForThread[];
		ctx: FounderReplyThreadCtx;
		db: CommDB;
		replyToCard?: boolean;
		founderMessage: {
			msgId: string;
			now: string;
		};
		recordDecisionClassification?: (decision: "approve" | "reject") => void;
	}) => Promise<ShipApprovalOutcome | null>;
	/** Current exact card binding, shared with the reaction approval path. */
	readCurrentBinding?: (
		executionId: string,
		questionId: string,
		prHeadSha: string,
	) => GateMessageBinding | null;
	/**
	 * FLY-1448 C: production StateStore seams. Optional so legacy/test
	 * assemblies retain their exact transport-only behavior.
	 */
	ensureDecisionConvergence?: (
		input: Parameters<StateStore["ensureFounderDecisionConvergence"]>[0],
	) => void;
	classifyDecisionConvergence?: (
		input: Parameters<StateStore["classifyFounderDecisionConvergence"]>[0],
	) => void;
}

function audit(
	store: StateStore,
	ctx: FounderReplyThreadCtx,
	executionId: string,
	eventType: string,
	payload: Record<string, unknown>,
): void {
	store.insertEvent({
		event_id: `${eventType}-${randomUUID()}`,
		execution_id: executionId,
		issue_id: ctx.issueId,
		project_name: ctx.projectName,
		event_type: eventType,
		source: "bridge.founder-reply-deliverer",
		payload,
	});
}

export async function emitFounderReplyDeliveryForThread(
	ctx: FounderReplyThreadCtx,
	questions: PendingQuestionForThread[],
	deps: FounderReplyDeliverDeps,
): Promise<ThreadScanOutcome> {
	const {
		store,
		fetchImpl = fetch,
		cursorStore,
		commDbFactory = (p) => new CommDB(p, false),
	} = deps;
	// ── (A) READ THE THREAD ONCE ──
	const cursor = cursorStore?.load(ctx.threadId);
	if (cursor === undefined) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
		try {
			const res = await fetchImpl(
				`${DISCORD_API}/channels/${ctx.threadId}/messages?limit=1`,
				{
					headers: { Authorization: `Bot ${ctx.botToken}` },
					signal: controller.signal,
				},
			);
			if (!res.ok) {
				return {
					threadId: ctx.threadId,
					result: "read_failed",
					stage: "bootstrap_read_failed",
					reason: `status_${res.status}`,
				};
			}
			const head = ((await res.json()) as RawDiscordMessage[])[0]?.id;
			cursorStore?.save(
				ctx.threadId,
				head ?? msToSnowflakeLowerBound(Date.now()),
			);
			return { threadId: ctx.threadId, result: "noop" };
		} catch (err) {
			return {
				threadId: ctx.threadId,
				result: "read_failed",
				stage: "bootstrap_read_failed",
				reason: (err as Error).message,
			};
		} finally {
			clearTimeout(timer);
		}
	}
	const after =
		cursor ??
		msToSnowflakeLowerBound(Math.min(...questions.map((q) => q.createdAtMs)));
	let messages: RawDiscordMessage[];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
	try {
		const res = await fetchImpl(
			`${DISCORD_API}/channels/${ctx.threadId}/messages?limit=${GET_LIMIT}&after=${after}`,
			{
				headers: { Authorization: `Bot ${ctx.botToken}` },
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			audit(
				store,
				ctx,
				questions[0]?.executionId ?? "",
				"founder_reply_read_failed",
				{
					status: res.status,
				},
			);
			// leave cursor untouched → retry next sub-cadence
			return {
				threadId: ctx.threadId,
				result: "read_failed",
				stage: "read_failed",
				reason: `status_${res.status}`,
			};
		}
		messages = (await res.json()) as RawDiscordMessage[];
	} catch (err) {
		audit(
			store,
			ctx,
			questions[0]?.executionId ?? "",
			"founder_reply_read_failed",
			{
				error: (err as Error).message,
			},
		);
		return {
			threadId: ctx.threadId,
			result: "read_failed",
			stage: "read_failed",
			reason: (err as Error).message,
		};
	} finally {
		clearTimeout(timer);
	}

	// Discord returns newest-first; process oldest-first.
	messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

	const db = commDbFactory(ctx.commDbPath);
	try {
		// Snapshot of still-pending qids (catch a Lead that just relayed).
		const pendingNow = new Set(
			db.getPendingQuestions(ctx.leadId).map((m) => m.id),
		);
		const now = Date.now();
		let advanceableUpTo: string | undefined = cursor;
		// FLY-945 Fix A: once a message with matching questions is immature (its
		// applicable grace has not elapsed), the cursor is PINNED before it — but
		// the scan continues so a later, already-mature ship message is still
		// processed this pass instead of queueing behind the 10min grace.
		let cursorPinned = false;
		let firstPinnedMsgId: string | undefined;
		let brokeOn: { msgId: string; stage: string; reason: string } | undefined;

		for (const msg of messages) {
			const msgMs = snowflakeToMs(msg.id);
			const isFounder =
				msg.author?.id === ctx.ownerUserId && msg.author?.bot !== true;
			const matching =
				isFounder && msgMs !== null
					? questions.filter(
							(q) => q.createdAtMs < msgMs && pendingNow.has(q.questionId),
						)
					: [];

			if (!isFounder) {
				// irrelevant / already answered → safe to pass (unless pinned earlier)
				if (!cursorPinned) advanceableUpTo = msg.id;
				continue;
			}
			try {
				db.ingestDiscordChat({
					leadId: ctx.leadId,
					chatId: ctx.threadId,
					originChannelId: ctx.threadId,
					messageId: msg.id,
					authorId: msg.author?.id ?? ctx.ownerUserId,
					authorName:
						msg.author?.global_name ??
						msg.author?.username ??
						msg.author?.id ??
						"founder",
					ts: new Date(
						msg.timestamp ?? snowflakeToMs(msg.id) ?? Date.now(),
					).toISOString(),
					msgKind: "guild",
					attachments: (msg.attachments ?? []).map((attachment) => ({
						name: attachment.filename ?? "attachment",
						type: attachment.content_type ?? "application/octet-stream",
						sizeKb: Math.max(0, (attachment.size ?? 0) / 1024),
					})),
					text: msg.content ?? "",
					founderId: ctx.ownerUserId,
				});
			} catch (error) {
				brokeOn = {
					msgId: msg.id,
					stage: "chat_ingest_failed",
					reason: error instanceof Error ? error.message : String(error),
				};
				break;
			}
			// FLY-1099 §7.1: an already dead-lettered message is DISPOSED — skip it
			// exactly like a non-matching one (its loss is on the durable record;
			// re-processing would just re-fail forever).
			if (deps.retryLedger?.isDeadLettered(ctx.threadId, msg.id)) {
				if (!cursorPinned) advanceableUpTo = msg.id;
				continue;
			}
			// FLY-945 Fix A: applicable grace = min across matching questions'
			// per-checkpoint graces (fallback ctx.graceMs = pre-FLY-945 behavior).
			const applicableGraceMs = 0;
			if (now - (msgMs as number) < applicableGraceMs) {
				cursorPinned = true; // not mature → re-read next sub-cadence
				firstPinnedMsgId ??= msg.id;
				continue;
			}

			// Codex code R1 HIGH-3: a THROW from message processing must flow into
			// the SAME bounded-retry ledger as a returned failure — otherwise the
			// exception bypasses the retry row / pin alert / dead-letter and the
			// message can spin forever with zero durable trail (账本诚实性).
			let outcome: ProcessOutcome;
			try {
				outcome = await processFounderMessage(msg, matching, ctx, {
					store,
					db,
					deliverAmbiguousToLead: deps.deliverAmbiguousToLead,
					tryFounderShipApproval: deps.tryFounderShipApproval,
					retryLedger: deps.retryLedger,
					readCurrentBinding: deps.readCurrentBinding,
					ensureDecisionConvergence: deps.ensureDecisionConvergence,
					classifyDecisionConvergence: deps.classifyDecisionConvergence,
				});
			} catch (err) {
				outcome = {
					ok: false,
					stage: "process_exception",
					reason: (err as Error).message,
				};
			}
			if (!outcome.ok) {
				// FLY-1099 §7.1: bounded retry. Record the transient failure; the
				// ledger owns the dead-letter policy. Dead-lettered → the message is
				// DISPOSED (audit + durable alert intent landed atomically): continue
				// the scan and let the cursor pass it under the waterline rule.
				const recorded = deps.retryLedger?.recordFailure({
					ctx,
					msgId: msg.id,
					executionId: matching[0]?.executionId ?? "",
					stage: outcome.stage,
					reason: outcome.reason,
					contentExcerpt: truncate(msg.content ?? "", 200),
				});
				if (recorded?.deadLettered) {
					if (!cursorPinned) advanceableUpTo = msg.id;
					continue;
				}
				// Transient failure → STOP the scan entirely (as before FLY-945): a
				// later message could otherwise answer the SAME question out of order.
				brokeOn = {
					msgId: msg.id,
					stage: outcome.stage,
					reason: outcome.reason,
				};
				break;
			}
			deps.retryLedger?.clear(ctx.threadId, msg.id);
			if (!cursorPinned) advanceableUpTo = msg.id;
		}

		if (advanceableUpTo !== undefined) {
			cursorStore?.save(ctx.threadId, advanceableUpTo);
			// FLY-1099 §7.2 (Codex R2 #6): the waterline safely crossed everything
			// up to the cursor — clear their retry rows (answered by another path /
			// proven irrelevant) so the pin watchdog never false-alarms.
			deps.retryLedger?.clearUpTo(ctx.threadId, advanceableUpTo);
		}

		if (brokeOn) {
			return {
				threadId: ctx.threadId,
				result: "process_failed",
				pinnedMsgId: brokeOn.msgId,
				stage: brokeOn.stage,
				reason: brokeOn.reason,
			};
		}
		if (cursorPinned) {
			return {
				threadId: ctx.threadId,
				result: "pinned",
				pinnedMsgId: firstPinnedMsgId,
				stage: "immature",
			};
		}
		return {
			threadId: ctx.threadId,
			result:
				advanceableUpTo !== undefined && advanceableUpTo !== cursor
					? "advanced"
					: "noop",
		};
	} finally {
		db.close();
	}
}

/** FLY-1099 §3.4: per-message disposition — a failure names its stage. */
type ProcessOutcome =
	| { ok: true }
	| { ok: false; stage: string; reason: string };

async function processFounderMessage(
	msg: RawDiscordMessage,
	matching: PendingQuestionForThread[],
	ctx: FounderReplyThreadCtx,
	deps: {
		store: StateStore;
		db: CommDB;
		deliverAmbiguousToLead?: FounderReplyDeliverDeps["deliverAmbiguousToLead"];
		tryFounderShipApproval?: FounderReplyDeliverDeps["tryFounderShipApproval"];
		retryLedger?: FounderReplyRetryLedger;
		readCurrentBinding?: FounderReplyDeliverDeps["readCurrentBinding"];
		ensureDecisionConvergence?: FounderReplyDeliverDeps["ensureDecisionConvergence"];
		classifyDecisionConvergence?: FounderReplyDeliverDeps["classifyDecisionConvergence"];
	},
): Promise<ProcessOutcome> {
	const { db } = deps;
	const rawAnswer = msg.content ?? "";
	const nowDate = new Date();
	const now = nowDate.toISOString();
	const shipGates = matching.filter(
		(question) => question.checkpoint === "approve_to_ship",
	);
	const founderReviewGates = matching.filter(
		(question) => question.checkpoint === "founder_review",
	);
	const isCardReply =
		msg.type === DISCORD_MESSAGE_TYPE_REPLY &&
		(msg.message_reference?.type === undefined ||
			msg.message_reference.type === 0) &&
		msg.message_reference?.channel_id === ctx.threadId &&
		Boolean(msg.message_reference.message_id);
	let founderReviewGate: PendingQuestionForThread | undefined;
	if (isCardReply) {
		const binding = deps.store.getFounderReviewCardBindingByMessage(
			msg.message_reference!.message_id!,
		);
		founderReviewGate = founderReviewGates.find(
			(gate) => gate.questionId === binding?.question_id,
		);
	} else if (founderReviewGates.length === 1) {
		// The review page's one-click summary is pasted as a plain thread message.
		// It may target the sole current review round, but ambiguity stays with Lead.
		founderReviewGate = founderReviewGates[0];
	}
	if (founderReviewGate) {
		const decision = classifyFounderReviewReply(rawAnswer);
		const written = writeTrustedFounderReviewResponse({
			store: deps.store,
			db,
			questionId: founderReviewGate.questionId,
			executionId: founderReviewGate.executionId,
			fromAgent: "bridge",
			founderId: ctx.ownerUserId,
			passed: decision.passed,
			...(decision.feedback !== undefined
				? { feedback: decision.feedback }
				: {}),
		});
		if (written.written) return { ok: true };
	}
	for (const gate of shipGates) {
		deps.ensureDecisionConvergence?.({
			threadId: ctx.threadId,
			msgId: msg.id,
			questionId: gate.questionId,
			projectName: ctx.projectName,
			leadId: ctx.leadId,
			executionId: gate.executionId,
			disposedAtMs: nowDate.getTime(),
			deadlineAtMs: nowDate.getTime() + DEFAULT_FOUNDER_DECISION_DEADLINE_MS,
		});
	}
	let cardGate: PendingQuestionForThread | undefined;
	if (
		deps.readCurrentBinding &&
		shipGates.length > 0 &&
		isCardReply &&
		msg.message_reference?.message_id
	) {
		for (const gate of shipGates) {
			const head = deps.store.getSession(gate.executionId)?.pr_head_sha;
			if (!head) continue;
			const binding = deps.readCurrentBinding(
				gate.executionId,
				gate.questionId,
				head,
			);
			if (binding?.gateMessageId === msg.message_reference.message_id) {
				cardGate = gate;
				break;
			}
		}
	}
	const messageGate =
		cardGate ?? (shipGates.length === 1 ? shipGates[0] : undefined);
	if (deps.tryFounderShipApproval && messageGate) {
		const handled = await deps.tryFounderShipApproval({
			msg: { id: msg.id, content: msg.content, authorId: msg.author?.id },
			shipGates: cardGate ? [cardGate] : shipGates,
			ctx,
			db,
			replyToCard: cardGate !== undefined,
			founderMessage: {
				msgId: msg.id,
				now,
			},
			recordDecisionClassification: deps.classifyDecisionConvergence
				? (decision) =>
						deps.classifyDecisionConvergence?.({
							threadId: ctx.threadId,
							msgId: msg.id,
							questionId: messageGate.questionId,
							classification: decision,
							cardReferenceValid: cardGate !== undefined,
						})
				: undefined,
		});
		if (handled?.deadLetter) {
			const deadLettered = deps.retryLedger?.deadLetterNow({
				ctx,
				msgId: msg.id,
				executionId: messageGate.executionId,
				stage: handled.deadLetter.stage,
				reason: handled.deadLetter.reason,
				contentExcerpt: truncate(msg.content ?? "", 200),
			});
			if (!deadLettered?.deadLettered) {
				return {
					ok: false,
					stage: handled.deadLetter.stage,
					reason: handled.deadLetter.reason,
				};
			}
		}
		if (
			handled &&
			(handled.bound.length > 0 ||
				handled.deferred.length > 0 ||
				(handled.suppressed?.length ?? 0) > 0 ||
				handled.deadLetter !== undefined)
		) {
			return { ok: true };
		}
		if (handled?.retry) {
			return {
				ok: false,
				stage: handled.stage ?? "ship_attribution_retry",
				reason: handled.reason ?? "transient ship-attribution failure",
			};
		}
	}
	// Founder control-plane messages follow the Claude agent-team topology:
	// Bridge is a transport only. It records delivery, forwards the original
	// message to Lead, and stops. Lead's later guarded response is the sole
	// action allowed to write a runner response.
	if (!deps.deliverAmbiguousToLead) {
		return {
			ok: false,
			stage: "lead_handoff_missing",
			reason: "no founder-to-lead handoff path is wired",
		};
	}
	const delivered = await deps.deliverAmbiguousToLead(
		`founder-reply-${ctx.threadId}-${msg.id}`,
		{
			issueId: ctx.issueId,
			threadId: ctx.threadId,
			msgId: msg.id,
			answer: rawAnswer,
			commDbPath: ctx.commDbPath,
		},
	);
	if (!delivered) {
		return {
			ok: false,
			stage: "lead_handoff_failed",
			reason: "founder reply was not delivered to Lead",
		};
	}
	return { ok: true };
}
