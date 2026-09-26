/**
 * FLY-605 Part B (inbound founder→runner): when the founder answers in the
 * per-issue Discord thread but the Lead never relays it back, the Bridge
 * auto-delivers the reply to the parked runner — so it never waits for days.
 *
 * Checkpoint split (🔴 FLY-175 hard boundary, Tadashi-confirmed):
 *  - brainstorm / runner_question (non-gated) → reuse `respond()`'s non-gated
 *    path (writes the response + the marker-aware wake helpers). Unblocks the
 *    runner with the founder's answer.
 *  - approve_to_ship → WAKE-only: wake the parked runner with the reply as
 *    NON-authoritative context. NEVER `insertResponse`, NEVER `respond()` — a
 *    ship approval is authorized exclusively through verify-approval/consent.
 *
 * Reliability: a PROCESSED-THROUGH (at-least-once) thread cursor. The cursor
 * advances past a founder message ONLY after the response is written / the ship
 * wake marker is durable / the ambiguous Lead-handoff is delivered / the message
 * is proven irrelevant. An immature (pre-grace) or transiently-failed message
 * stops the scan so the next sub-cadence re-reads it (Codex R2 #1).
 */

import { randomUUID } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import { respond as defaultRespond } from "flywheel-comm/respond";
import { wakeRunnerMailbox as defaultWake } from "flywheel-comm/wake";
import type { InboundCursorStore } from "../lead-backends/codex/InboundCursorStore.js";
import type { StateStore } from "../StateStore.js";
import { reactToFounderMessage as defaultReactToFounderMessage } from "./approval-signal/founder-ack.js";
import type { GateMessageBinding } from "./approval-signal/gate-message-binding.js";
import {
	msToSnowflakeLowerBound,
	snowflakeToMs,
	truncate,
} from "./founder-notify-utils.js";

const DISCORD_API = "https://discord.com/api/v10";
const GET_TIMEOUT_MS = 5_000;
const GET_LIMIT = 50;
const SUMMARY_MAX = 1_000;
const FOUNDER_AGENT = "founder-bridge-auto";
/** Discord message type 19 = REPLY (the only shape reply-to-card accepts). */
const DISCORD_MESSAGE_TYPE_REPLY = 19;

interface RawDiscordMessage {
	id: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
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
	wakeImpl?: typeof defaultWake;
	respondImpl?: typeof defaultRespond;
	commDbFactory?: (path: string) => CommDB;
	/** FLY-1099 §7.1: bounded retry + dead-letter (absent → legacy behavior). */
	retryLedger?: FounderReplyRetryLedger;
	/**
	 * Durable ambiguous-message handoff to the Lead (appendLeadEvent +
	 * runtime.deliver via the same path GatePoller uses). Returns true only when
	 * the handoff was durably accepted + delivered (Codex R3 #2). Absent → an
	 * ambiguous message cannot be handed off → treat as a transient failure
	 * (stop the cursor before it) rather than silently drop the manual relay.
	 */
	deliverAmbiguousToLead?: (
		eventId: string,
		payload: Record<string, unknown>,
	) => Promise<boolean>;
	/**
	 * FLY-799: attempt to attribute a founder approval for the thread's ship
	 * gate(s) from THIS founder message (text source → shared gate-write
	 * helper). Runs BEFORE the WAKE-only fallback.
	 *
	 * FLY-1099 §3.2: returns the explicit `ShipApprovalOutcome` disposition —
	 * `bound` ∪ `deferred` skip WAKE; `deferred` non-empty → 🕒 receipt;
	 * `retry` → pin the cursor (bounded by the retry ledger). null =
	 * unattributable (non-founder / narrow miss / unclear) → byte-compatible
	 * WAKE-only. Absent (feature off / default) → WAKE-only.
	 */
	tryFounderShipApproval?: (args: {
		msg: { id: string; content?: string; authorId?: string };
		shipGates: PendingQuestionForThread[];
		ctx: FounderReplyThreadCtx;
		db: CommDB;
		/** FLY-1041 Chunk 7: verified reply to shipGates[0]'s ship card. */
		replyToCard?: boolean;
	}) => Promise<ShipApprovalOutcome | null>;
	/**
	 * FLY-1041 Chunk 7: read the ONE current durable
	 * `(questionId, prHeadSha) → gateMessageId` binding (same reader the
	 * ✅-reaction path uses, fail-closed via selectCurrentBinding). When a
	 * founder message is a true Discord REPLY whose reference resolves to a
	 * gate's bound card message, attribution is narrowed to THAT gate —
	 * a short "okk" on the card binds deterministically regardless of how many
	 * other questions the thread has accumulated. Absent → replies are treated
	 * exactly like any other founder message (byte-compat).
	 */
	readCurrentBinding?: (
		executionId: string,
		questionId: string,
		prHeadSha: string,
	) => GateMessageBinding | null;
	/** FLY-1041 Chunk 8: test seam for the receipt-reaction PUT. */
	reactToFounderMessageImpl?: typeof defaultReactToFounderMessage;
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

const SHIP_WAKE_TEXT = (summary: string): string =>
	`Annie 在 thread 回复了你的 ship gate：${summary}\n` +
	"这条不是授权——ship 前必须跑 verify-approval。";

export async function emitFounderReplyDeliveryForThread(
	ctx: FounderReplyThreadCtx,
	questions: PendingQuestionForThread[],
	deps: FounderReplyDeliverDeps,
): Promise<ThreadScanOutcome> {
	const {
		store,
		fetchImpl = fetch,
		cursorStore,
		wakeImpl = defaultWake,
		respondImpl = defaultRespond,
		commDbFactory = (p) => new CommDB(p, false),
	} = deps;
	if (questions.length === 0) {
		return { threadId: ctx.threadId, result: "noop" };
	}

	// ── (A) READ THE THREAD ONCE ──
	const cursor = cursorStore?.load(ctx.threadId);
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

			if (matching.length === 0) {
				// irrelevant / already answered → safe to pass (unless pinned earlier)
				if (!cursorPinned) advanceableUpTo = msg.id;
				continue;
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
			const applicableGraceMs = Math.min(
				...matching.map((q) => q.checkpointGraceMs ?? ctx.graceMs),
			);
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
				outcome = await processFounderMessage(
					msg,
					matching,
					ctx,
					{
						store,
						db,
						wakeImpl,
						respondImpl,
						deliverAmbiguousToLead: deps.deliverAmbiguousToLead,
						tryFounderShipApproval: deps.tryFounderShipApproval,
						readCurrentBinding: deps.readCurrentBinding,
						fetchImpl,
						reactToFounderMessageImpl: deps.reactToFounderMessageImpl,
						retryLedger: deps.retryLedger,
					},
					pendingNow,
				);
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
		wakeImpl: typeof defaultWake;
		respondImpl: typeof defaultRespond;
		deliverAmbiguousToLead?: FounderReplyDeliverDeps["deliverAmbiguousToLead"];
		tryFounderShipApproval?: FounderReplyDeliverDeps["tryFounderShipApproval"];
		readCurrentBinding?: FounderReplyDeliverDeps["readCurrentBinding"];
		fetchImpl?: typeof fetch;
		reactToFounderMessageImpl?: FounderReplyDeliverDeps["reactToFounderMessageImpl"];
		retryLedger?: FounderReplyRetryLedger;
	},
	pendingNow: Set<string>,
): Promise<ProcessOutcome> {
	const { store, db, wakeImpl, respondImpl } = deps;
	const answer = truncate(msg.content ?? "", SUMMARY_MAX);
	const ship = matching.filter((q) => q.checkpoint === "approve_to_ship");
	const nonShip = matching.filter((q) => q.checkpoint !== "approve_to_ship");
	let failure: { stage: string; reason: string } | undefined;
	const fail = (stage: string, reason: string): void => {
		failure ??= { stage, reason };
	};

	// ── FLY-1041 Chunk 7: reply-to-card deterministic binding. A founder
	// message qualifies ONLY as a true Discord REPLY (type 19) whose reference
	// is a DEFAULT reference (type 0/absent — pin/forward/crosspost carry other
	// reference types, Codex R1 #3) inside THIS thread; the referenced message
	// id must then equal a gate's durably-bound card message id (the same
	// fail-closed reader the ✅-reaction path uses). A hit narrows attribution
	// to THAT gate — a short "okk" on the card binds regardless of how many
	// other questions the thread accumulated. Any miss → the byte-compatible
	// full-set path below. Kill-switch FLYWHEEL_REPLY_TO_CARD=0.
	let cardGate: PendingQuestionForThread | undefined;
	if (
		process.env.FLYWHEEL_REPLY_TO_CARD !== "0" &&
		deps.readCurrentBinding &&
		ship.length > 0 &&
		msg.type === DISCORD_MESSAGE_TYPE_REPLY &&
		(msg.message_reference?.type === undefined ||
			msg.message_reference.type === 0) &&
		msg.message_reference?.channel_id === ctx.threadId &&
		msg.message_reference.message_id
	) {
		const refMsgId = msg.message_reference.message_id;
		for (const g of ship) {
			const gateSession = store.getSession(g.executionId);
			const head = gateSession?.pr_head_sha;
			if (!head) continue;
			const binding = deps.readCurrentBinding(
				g.executionId,
				g.questionId,
				head,
			);
			if (binding?.gateMessageId === refMsgId) {
				cardGate = g;
				break;
			}
		}
	}

	// ── FLY-799: attribute a founder approval BEFORE WAKE-only. When enabled, a
	// clear founder approval/rejection writes the gate response (the post-write
	// hook flips status + wakes the runner). FLY-1099 §3.2: the outcome is an
	// explicit disposition — bound ∪ deferred skip the WAKE-only below (both are
	// proper disposals); retry pins the cursor. Absent / null → byte-compatible
	// WAKE-only.
	const handled = new Set<string>();
	let boundCount = 0;
	let deferredCount = 0;
	let suppressedCount = 0;
	if (deps.tryFounderShipApproval && ship.length > 0) {
		const res = await deps.tryFounderShipApproval({
			msg: { id: msg.id, content: msg.content, authorId: msg.author?.id },
			// FLY-1041 Chunk 7: a verified card reply narrows the candidate set to
			// exactly that gate (the handler's A-2 exactly-one narrowing then
			// passes naturally even in a multi-gate thread).
			shipGates: cardGate ? [cardGate] : ship,
			ctx,
			db,
			replyToCard: !!cardGate,
		});
		if (res) {
			for (const b of res.bound) handled.add(b.questionId);
			for (const d of res.deferred) handled.add(d.questionId);
			for (const s of res.suppressed ?? []) handled.add(s.questionId);
			boundCount = res.bound.length;
			deferredCount = res.deferred.length;
			suppressedCount = res.suppressed?.length ?? 0;
			if (res.retry) {
				fail(
					res.stage ?? "ship_attribution_retry",
					res.reason ?? "transient ship-attribution failure",
				);
			}
			// Codex code R3 HIGH: durable response + every convergence anchor
			// failed → the ONLY honest terminal is an immediate dead-letter
			// (durable audit + must-deliver alert); a pending-gate-rematch retry
			// can never run again. Dead-lettered → disposed (skip WAKE, cursor may
			// pass). If even the dead-letter write fails (store broken), pin the
			// cursor — the pass-level watchdog is the last resort.
			if (res.deadLetter) {
				const dlExec =
					ship.find((q) => q.questionId === res.deadLetter?.questionId)
						?.executionId ??
					matching[0]?.executionId ??
					"";
				const dl = deps.retryLedger?.deadLetterNow({
					ctx,
					msgId: msg.id,
					executionId: dlExec,
					stage: res.deadLetter.stage,
					reason: res.deadLetter.reason,
					contentExcerpt: truncate(msg.content ?? "", 200),
				});
				if (dl?.deadLettered) {
					handled.add(res.deadLetter.questionId);
				} else {
					fail(res.deadLetter.stage, res.deadLetter.reason);
				}
			}
		}
	}

	// ── ship gates: WAKE-only fallback, deduped by founder message id (Codex R1 #3) ──
	for (const q of ship) {
		if (handled.has(q.questionId)) continue; // FLY-799/1099: bound or deferred above
		const marker = `founder-ship-wake-${q.questionId}-${msg.id}`;
		if (
			store
				.getEventsByExecution(q.executionId)
				.some((e) => e.event_id === marker)
		) {
			continue; // already waked for THIS founder message
		}
		try {
			const wake = await wakeImpl({
				db,
				execId: q.executionId,
				fromAgent: FOUNDER_AGENT,
				content: SHIP_WAKE_TEXT(answer),
				metadata: {
					kind: "ship_thread_reply",
					questionId: q.questionId,
					msgId: msg.id,
				},
			});
			if (!wake.ok) {
				// FLY-605 (Codex ship-gate #2): NO wake was delivered. This covers
				// both a transient transport error (wake.error) AND the skip cases
				// wakeRunnerMailbox returns with NO error — backend_commdb (rollback
				// mode) / no_session_lead. Ship inbound is WAKE-only, so this wake is
				// the ONLY delivery action: we must NOT write the durable marker and
				// must NOT let the processed-through cursor advance past this founder
				// reply, or the reply is permanently dropped. Audit the reason, stop
				// → re-tried next sub-cadence (bounded by the FLY-1099 retry ledger);
				// the still-pending recheck drops it once the gate resolves another way.
				const reason = wake.error ?? wake.skippedReason ?? "unknown";
				audit(store, ctx, q.executionId, "founder_ship_reply_wake_skipped", {
					reason,
					msgId: msg.id,
				});
				fail(`wake_${wake.skippedReason ?? "failed"}`, reason);
				continue;
			}
			store.insertEvent({
				event_id: marker,
				execution_id: q.executionId,
				issue_id: ctx.issueId,
				project_name: ctx.projectName,
				event_type: "founder_ship_reply_waked",
				source: "bridge.founder-reply-deliverer",
				payload: { questionId: q.questionId, msgId: msg.id },
			});
		} catch (err) {
			audit(store, ctx, q.executionId, "founder_ship_reply_wake_failed", {
				error: (err as Error).message,
				msgId: msg.id,
			});
			fail("wake_failed", (err as Error).message);
		}
	}

	// ── FLY-1041 Chunk 8: founder receipt reaction — the ship branch's SINGLE
	// decision spot (at most one receipt per founder message PER OUTCOME).
	// ✅ = her decision bound (a response was written, approve OR reject);
	// ❓ = ship gates matched but nothing bound (unclear / classifier failure /
	// held / narrow-multi / auto-approve off). No ship gates matched → no
	// receipt (chatter stays untouched). The durable marker is keyed on
	// (msgId, outcome) — Codex R1 MEDIUM: a transiently-failed message is
	// re-scanned (cursor pinned), and if the retry BINDS after an initial ❓,
	// the ✅ must still fire (one-way ❓→✅ upgrade; a bound gate leaves
	// pending, so the reverse can never happen). Same-outcome re-scans stay
	// deduped. Marker is inserted BEFORE the PUT so a re-scan can never
	// double-react; a PUT failure is audited and NOT retried (best-effort,
	// never blocks delivery). Kill-switch FLYWHEEL_FOUNDER_APPROVAL_ACK=0.
	if (
		ship.length > suppressedCount &&
		process.env.FLYWHEEL_FOUNDER_APPROVAL_ACK !== "0"
	) {
		// FLY-1099 §3.2: three receipt outcomes — ✅ = her decision is BOUND
		// (approve OR reject, FLY-1041 Chunk 8 semantics preserved); 🕒 = durably
		// deferred (will auto-bind when the hold clears; the rebind pass upgrades
		// to ✅); ❓ = nothing bound. One-way upgrades only: a later re-scan /
		// rebind with a stronger outcome writes a NEW (msgId, outcome) marker.
		const emoji: "✅" | "🕒" | "❓" =
			boundCount > 0 ? "✅" : deferredCount > 0 ? "🕒" : "❓";
		const outcome =
			boundCount > 0 ? "bound" : deferredCount > 0 ? "deferred" : "unbound";
		const markerFresh = store.insertEvent({
			event_id: `founder-ack-${msg.id}-${outcome}`,
			execution_id: ship[0]?.executionId ?? "",
			issue_id: ctx.issueId,
			project_name: ctx.projectName,
			event_type: "founder_ack_marker",
			source: "bridge.founder-reply-deliverer",
			payload: { msgId: msg.id, emoji, outcome },
		});
		if (markerFresh) {
			const react =
				deps.reactToFounderMessageImpl ?? defaultReactToFounderMessage;
			const r = await react({
				botToken: ctx.botToken,
				channelId: ctx.threadId,
				messageId: msg.id,
				emoji,
				fetchImpl: deps.fetchImpl,
			});
			if (r.ok) {
				audit(store, ctx, ship[0]?.executionId ?? "", "founder_ack_reacted", {
					msgId: msg.id,
					emoji,
					outcome,
				});
			} else {
				audit(store, ctx, ship[0]?.executionId ?? "", "founder_ack_failed", {
					msgId: msg.id,
					emoji,
					outcome,
					...(r.status !== undefined ? { status: r.status } : {}),
				});
			}
		}
	}

	// ── non-ship: deliver, unless ambiguous ──
	if (nonShip.length > 0) {
		// Ambiguous when this founder message could answer more than one pending
		// question in the thread (non-ship + any other, incl. ship) — Codex R2 #2 / R3 #3.
		const ambiguous = matching.length >= 2;
		if (ambiguous) {
			const eventId = `founder-reply-ambiguous-${ctx.threadId}-${msg.id}`;
			if (!deps.deliverAmbiguousToLead) {
				// no durable handoff path → stop before this message
				fail("handoff_failed", "no ambiguous-handoff path wired");
			} else {
				const delivered = await deps.deliverAmbiguousToLead(eventId, {
					issueId: ctx.issueId,
					threadId: ctx.threadId,
					msgId: msg.id,
					answer,
					questionIds: nonShip.map((q) => q.questionId),
				});
				if (!delivered) {
					fail("handoff_failed", "ambiguous handoff not delivered");
				}
			}
		} else {
			const q = nonShip[0];
			if (!q) return failure ? { ok: false, ...failure } : { ok: true };
			try {
				await respondImpl({
					questionId: q.questionId,
					fromAgent: FOUNDER_AGENT,
					answer,
					dbPath: ctx.commDbPath,
					// NO bridgeUrl: the non-gated path only writes the response +
					// marker-aware wake helpers; ship never reaches here.
				});
				pendingNow.delete(q.questionId);
				audit(store, ctx, q.executionId, "founder_reply_delivered", {
					questionId: q.questionId,
					msgId: msg.id,
				});
			} catch (err) {
				const m = (err as Error).message;
				if (m.includes("UNIQUE")) {
					// Lead already responded between the snapshot and now — treat as
					// answered (advance, don't retry).
					pendingNow.delete(q.questionId);
				} else {
					audit(store, ctx, q.executionId, "founder_reply_deliver_failed", {
						error: m,
						msgId: msg.id,
					});
					fail("respond_failed", m);
				}
			}
		}
	}

	return failure ? { ok: false, ...failure } : { ok: true };
}
