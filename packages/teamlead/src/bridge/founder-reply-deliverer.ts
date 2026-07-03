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

interface RawDiscordMessage {
	id: string;
	content?: string;
	author?: { id?: string; bot?: boolean };
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
}

export interface FounderReplyDeliverDeps {
	store: StateStore;
	fetchImpl?: typeof fetch;
	cursorStore?: InboundCursorStore;
	wakeImpl?: typeof defaultWake;
	respondImpl?: typeof defaultRespond;
	commDbFactory?: (path: string) => CommDB;
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
	 * gate(s) from THIS founder message (text / image sources → shared gate-write
	 * helper). Runs BEFORE the WAKE-only fallback. Returns the question ids it
	 * resolved (approved or rejected → a response was written; the post-write hook
	 * flips status + wakes) plus `retrySafe`. Question ids NOT in `handled` fall
	 * through to WAKE-only (unclear / non-founder — non-authoritative context).
	 * Absent (feature off / default) → the ship branch is byte-compatible WAKE-only.
	 */
	tryFounderShipApproval?: (args: {
		msg: { id: string; content?: string; authorId?: string };
		shipGates: PendingQuestionForThread[];
		ctx: FounderReplyThreadCtx;
	}) => Promise<{ handled: string[]; retrySafe: boolean } | null>;
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
): Promise<void> {
	const {
		store,
		fetchImpl = fetch,
		cursorStore,
		wakeImpl = defaultWake,
		respondImpl = defaultRespond,
		commDbFactory = (p) => new CommDB(p, false),
	} = deps;
	if (questions.length === 0) return;

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
			return; // leave cursor untouched → retry next sub-cadence
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
		return;
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
				advanceableUpTo = msg.id; // irrelevant / already answered → safe to pass
				continue;
			}
			if (now - (msgMs as number) < ctx.graceMs) {
				break; // not mature → STOP (re-read next sub-cadence), do not advance
			}

			const ok = await processFounderMessage(
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
				},
				pendingNow,
			);
			if (!ok) break; // transient failure → STOP before this message
			advanceableUpTo = msg.id;
		}

		if (advanceableUpTo !== undefined) {
			cursorStore?.save(ctx.threadId, advanceableUpTo);
		}
	} finally {
		db.close();
	}
}

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
	},
	pendingNow: Set<string>,
): Promise<boolean> {
	const { store, db, wakeImpl, respondImpl } = deps;
	const answer = truncate(msg.content ?? "", SUMMARY_MAX);
	const ship = matching.filter((q) => q.checkpoint === "approve_to_ship");
	const nonShip = matching.filter((q) => q.checkpoint !== "approve_to_ship");
	let allOk = true;

	// ── FLY-799: attribute a founder approval BEFORE WAKE-only. When enabled, a
	// clear founder approval/rejection writes the gate response (the post-write
	// hook flips status + wakes the runner); those question ids are "handled" and
	// skip the WAKE-only below. Absent → handled is empty → byte-compatible.
	const handled = new Set<string>();
	if (deps.tryFounderShipApproval && ship.length > 0) {
		const res = await deps.tryFounderShipApproval({
			msg: { id: msg.id, content: msg.content, authorId: msg.author?.id },
			shipGates: ship,
			ctx,
		});
		if (res) {
			for (const id of res.handled) handled.add(id);
			if (!res.retrySafe) allOk = false;
		}
	}

	// ── ship gates: WAKE-only fallback, deduped by founder message id (Codex R1 #3) ──
	for (const q of ship) {
		if (handled.has(q.questionId)) continue; // FLY-799: resolved above (response written)
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
				// (allOk=false) → re-tried next sub-cadence; the still-pending recheck
				// drops it once the gate resolves another way.
				audit(store, ctx, q.executionId, "founder_ship_reply_wake_skipped", {
					reason: wake.error ?? wake.skippedReason ?? "unknown",
					msgId: msg.id,
				});
				allOk = false;
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
			allOk = false;
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
				allOk = false; // no durable handoff path → stop before this message
			} else {
				const delivered = await deps.deliverAmbiguousToLead(eventId, {
					issueId: ctx.issueId,
					threadId: ctx.threadId,
					msgId: msg.id,
					answer,
					questionIds: nonShip.map((q) => q.questionId),
				});
				if (!delivered) allOk = false;
			}
		} else {
			const q = nonShip[0];
			if (!q) return allOk;
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
					allOk = false;
				}
			}
		}
	}

	return allOk;
}
