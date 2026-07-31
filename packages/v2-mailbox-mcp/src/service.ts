/**
 * FLY-1547: the mailbox service core — the five-tool contract over the v2
 * host socket, with the 读/办 two-chapter semantics enforced server-side
 * (this process), not by model diligence. Pure logic over an injected host
 * port so every crash-window behavior is unit-testable.
 *
 * Chapter mechanics (§2.2 of the plan):
 * - FYI: `next` returns the body WITHOUT settling; the ack (empty proposal)
 *   is executed at the START of the recipient's next mailbox tool call —
 *   deferred ack. A crash before that ack leaves the attempt running, and the
 *   §2.1 lost-handoff redelivery re-serves the same letter (at-least-once).
 * - ACTIONABLE: held as the single outstanding envelope until an explicit
 *   `settle`; `settle({reply})` enqueues the reply FIRST under a
 *   message-scoped idempotency key (`mailbox_reply:<messageUid>`), then
 *   settles — both steps replay-safe, so a crash between them is recoverable
 *   by simply calling settle again.
 */
import {
	MAILBOX_SEND_KINDS,
	type SettlementDisposition,
	settlementDisposition,
} from "flywheel-v2-dag";

export interface DeliveryEnvelopeLike {
	v: 1;
	message: {
		messageUid: string;
		payload: string;
		kind: string;
		sourceKind: string;
		seq: number;
	};
	handle: { attemptUid: string; messageUid: string; agent: unknown };
	authorization: { capabilityId: string; token: string };
	deliveryActionId: string;
	protocol: unknown;
}

/** Narrow host port — production wraps V2Client; tests inject a fake. */
export interface HostPort {
	next(): Promise<DeliveryEnvelopeLike | "empty">;
	submit(input: {
		agentId: string;
		attemptUid: string;
		messageUid: string;
		effects: unknown[];
		authorization: { capabilityId: string; token: string };
	}): Promise<unknown>;
	enqueue(input: {
		sourceKind: string;
		sourceId: string;
		payload: string;
		toAgent: string;
		kind: string;
		retentionClass: "notice" | "business" | "dlq";
	}): Promise<{ status: string; reason?: string }>;
	ask(input: {
		askKind: "ask" | "progress" | "blocked";
		payload: string;
	}): Promise<{ uid: string }>;
	mailboxStatus(): Promise<MailboxStatusShape>;
	/** The ledger identity this port acts as (session ref or lead agent id). */
	selfId(): string;
}

export interface MailboxStatusShape {
	v: 1;
	recipient: string;
	pendingTotal: number;
	inProgressTotal: number;
	maxPendingSeq: number | null;
	kinds: Array<{
		kind: string;
		askKind: string | null;
		count: number;
		oldestSeq: number;
		oldestCreatedAt: string;
	}>;
	pendingUids: string[];
	pendingUidsTruncated: boolean;
}

export interface NextResult {
	status: "letter" | "empty";
	chapter?: SettlementDisposition["chapter"];
	message?: DeliveryEnvelopeLike["message"];
	note?: string;
}

interface Outstanding {
	envelope: DeliveryEnvelopeLike;
	chapter: "fyi" | "actionable" | "unknown";
	/** R3-F2: set when a reply enqueue hit a byte-different canonical conflict —
	 * the conflict IS the durable proof that this ask already has exactly one
	 * committed reply, which is the only state allowing settle-without-reply. */
	replyConflictProven?: boolean;
}

export class MailboxService {
	readonly #host: HostPort;
	/** The single outstanding envelope (settle-before-next protocol). FYI
	 * entries are acked lazily; actionable/unknown entries wait for settle. */
	#outstanding: Outstanding | null = null;
	/** R3-F1: the serial-protocol lock. EVERY model-facing operation runs
	 * through this chain — concurrent tool calls cannot interleave their host
	 * requests, so a second `next` can never crash-settle an envelope that is
	 * still in flight to the first caller. */
	#chain: Promise<unknown> = Promise.resolve();

	constructor(host: HostPort) {
		this.#host = host;
	}

	#serial<T>(op: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(op, op);
		this.#chain = run.catch(() => undefined);
		return run;
	}

	/** Deferred FYI ack — runs at the START of every tool call. */
	async #flushFyiAck(): Promise<void> {
		if (this.#outstanding?.chapter !== "fyi") return;
		const { envelope } = this.#outstanding;
		await this.#host.submit({
			agentId: this.#host.selfId(),
			attemptUid: envelope.handle.attemptUid,
			messageUid: envelope.message.messageUid,
			effects: [],
			authorization: envelope.authorization,
		});
		this.#outstanding = null;
	}

	next(): Promise<NextResult> {
		return this.#serial(() => this.#next());
	}

	async #next(): Promise<NextResult> {
		await this.#flushFyiAck();
		if (this.#outstanding) {
			// Actionable letter still open: re-surface it rather than pulling past
			// it (pulling would be the §2.1 lost-handoff self-evidence and would
			// crash-settle a letter the model is actively holding).
			const { envelope, chapter } = this.#outstanding;
			return {
				status: "letter",
				chapter,
				message: envelope.message,
				note: "这封信仍未办结 — 先 settle(可带 reply)再取下一封。",
			};
		}
		const pulled = await this.#host.next();
		if (pulled === "empty") return { status: "empty" };
		const disposition = settlementDisposition(pulled.message);
		if (disposition.chapter === "unknown") {
			// Fail-loud: hold it as actionable-like (never auto-ack), surface why.
			this.#outstanding = { envelope: pulled, chapter: "unknown" };
			return {
				status: "letter",
				chapter: "unknown",
				message: pulled.message,
				note: `无法分章(${disposition.reason})——不会自动办结,也**不可**经 settle 结算;这封信留在账上作为可见欠账,由 operator 在账本侧处理(或分类器修复后重投自愈)。`,
			};
		}
		this.#outstanding = { envelope: pulled, chapter: disposition.chapter };
		return {
			status: "letter",
			chapter: disposition.chapter,
			message: pulled.message,
			note:
				disposition.chapter === "fyi"
					? "FYI:已读即办结(将在你的下一次 mailbox 调用时自动销账)。"
					: "办事章:办完必须 settle;要回信用 settle({reply})。",
		};
	}

	settle(input?: {
		reply?: { body: string };
		effects?: unknown[];
	}): Promise<{ settled: string; replyEnqueued?: boolean }> {
		return this.#serial(() => this.#settle(input));
	}

	async #settle(input?: {
		reply?: { body: string };
		effects?: unknown[];
	}): Promise<{ settled: string; replyEnqueued?: boolean }> {
		// A pending FYI ack flushes first so the ledger order matches reality.
		await this.#flushFyiAck();
		const outstanding = this.#outstanding;
		if (!outstanding) {
			throw new Error("no outstanding letter to settle — call next first");
		}
		const { envelope } = outstanding;
		// R3-F2: unknown/malformed protocol input never gets ordinary settlement.
		// It stays the visible debt until an operator clears it ledger-side (or a
		// classifier update makes it classifiable on redelivery).
		if (outstanding.chapter === "unknown") {
			throw new Error(
				`letter ${envelope.message.messageUid} (kind ${envelope.message.kind}) cannot be classified — refusing to settle unclassified protocol input; it stays pending as visible debt`,
			);
		}
		// R3-F2: an answer-requiring ask cannot be applied bare. Either this call
		// carries the reply (enqueued/duplicate both count — replay-safe), or a
		// prior conflict proved a canonical reply already durably exists.
		const answerRequired = (() => {
			if (envelope.message.kind !== "runner_ask") return false;
			try {
				const parsed: unknown = JSON.parse(envelope.message.payload);
				const askKind =
					typeof parsed === "object" && parsed !== null
						? (parsed as { ask_kind?: unknown }).ask_kind
						: undefined;
				return askKind === "ask" || askKind === "blocked";
			} catch {
				return false;
			}
		})();
		if (
			answerRequired &&
			!input?.reply &&
			outstanding.replyConflictProven !== true
		) {
			throw new Error(
				"this runner_ask requires an answer — settle({reply:{body}}) first; settle-without-reply is only allowed after a conflict proved a canonical reply already exists",
			);
		}
		let replyEnqueued: boolean | undefined;
		if (input?.reply) {
			// §2.4: route/kind/uid derived from the envelope being settled — the
			// model supplies ONLY the body. Idempotency key is message-scoped and
			// generation-free so a takeover replay dedups instead of double-answering.
			const parsed: unknown = JSON.parse(envelope.message.payload);
			if (
				envelope.message.kind !== "runner_ask" ||
				typeof parsed !== "object" ||
				parsed === null
			) {
				throw new Error(
					`settle(reply) is only valid for an answerable runner_ask (got ${envelope.message.kind})`,
				);
			}
			const ask = parsed as { session_ref?: string; uid?: string };
			if (!ask.session_ref || !ask.uid) {
				throw new Error(
					"the runner_ask payload carries no session_ref/uid to answer",
				);
			}
			let result: { status: string; reason?: string };
			try {
				result = await this.#host.enqueue({
					sourceKind: "mailbox_reply",
					sourceId: `mailbox_reply:${envelope.message.messageUid}`,
					payload: JSON.stringify({
						v: 1,
						uid: ask.uid,
						body: input.reply.body,
						answered_by: this.#host.selfId(),
					}),
					toAgent: ask.session_ref,
					kind: "ask_response",
					retentionClass: "business",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const name = error instanceof Error ? error.name : "";
				if (
					name === "CanonicalConflict" ||
					/canonical|conflict/i.test(message)
				) {
					// The durable ledger already holds a byte-DIFFERENT reply for this
					// exact ask — that conflict is itself the durable proof R3-F2 asks
					// for. Record it so a follow-up settle() may close the debt without
					// sending a second answer.
					outstanding.replyConflictProven = true;
					throw new Error(
						`a byte-different reply already durably exists for this ask (${message}) — do NOT change your answer; call settle() without reply to close the debt`,
					);
				}
				throw error;
			}
			if (result.status !== "enqueued" && result.status !== "duplicate") {
				throw new Error(
					`reply was rejected (${result.status}${result.reason ? `: ${result.reason}` : ""}) — ` +
						"a byte-different reply already exists for this ask; read it and settle without reply, or keep the identical bytes",
				);
			}
			replyEnqueued = true;
		}
		await this.#host.submit({
			agentId: this.#host.selfId(),
			attemptUid: envelope.handle.attemptUid,
			messageUid: envelope.message.messageUid,
			effects: input?.effects ?? [],
			authorization: envelope.authorization,
		});
		this.#outstanding = null;
		return {
			settled: envelope.message.messageUid,
			...(replyEnqueued !== undefined ? { replyEnqueued } : {}),
		};
	}

	send(input: {
		to: string;
		kind: string;
		body: string;
		dedupeKey: string;
	}): Promise<unknown> {
		return this.#serial(() => this.#send(input));
	}

	async #send(input: {
		to: string;
		kind: string;
		body: string;
		dedupeKey: string;
	}): Promise<unknown> {
		await this.#flushFyiAck();
		if (!input.dedupeKey.trim()) {
			throw new Error(
				"send requires a caller-chosen dedupe_key — retries must reuse the identical key",
			);
		}
		// R3-F7: the tool face cannot manufacture unclassified mailbox debt.
		if (!MAILBOX_SEND_KINDS.has(input.kind)) {
			throw new Error(
				`send kind ${JSON.stringify(input.kind)} is not in the mailbox send vocabulary (${[...MAILBOX_SEND_KINDS].join(", ")}) — free-form content rides the payload of a classified kind`,
			);
		}
		return this.#host.enqueue({
			sourceKind: "mcp_send",
			sourceId: `mcp_send:${this.#host.selfId()}:${input.dedupeKey}`,
			payload: input.body,
			toAgent: input.to,
			kind: input.kind,
			retentionClass: "business",
		});
	}

	ask(input: {
		askKind: "ask" | "progress" | "blocked";
		body: string;
	}): Promise<{ uid: string }> {
		return this.#serial(() => this.#ask(input));
	}

	async #ask(input: {
		askKind: "ask" | "progress" | "blocked";
		body: string;
	}): Promise<{ uid: string }> {
		await this.#flushFyiAck();
		return this.#host.ask({ askKind: input.askKind, payload: input.body });
	}

	status(): Promise<
		MailboxStatusShape & {
			chapters: { fyi: number; actionable: number; unknown: number };
		}
	> {
		return this.#serial(() => this.#status());
	}

	async #status(): Promise<
		MailboxStatusShape & {
			chapters: { fyi: number; actionable: number; unknown: number };
		}
	> {
		await this.#flushFyiAck();
		const status = await this.#host.mailboxStatus();
		let fyi = 0;
		let actionable = 0;
		let unknown = 0;
		for (const row of status.kinds) {
			const disposition = settlementDisposition({
				kind: row.kind,
				payload: JSON.stringify({ ask_kind: row.askKind }),
			});
			if (disposition.chapter === "fyi") fyi += row.count;
			else if (disposition.chapter === "actionable") actionable += row.count;
			else unknown += row.count;
		}
		if (unknown > 0) {
			process.stderr.write(
				`[mailbox] ${unknown} pending letter(s) carry an unclassified kind — visible debt requiring operator attention\n`,
			);
		}
		return { ...status, chapters: { fyi, actionable, unknown } };
	}

	/** Exposed for the channel bell: highest pending seq without side effects. */
	peekMaxPendingSeq(): Promise<number | null> {
		return this.#serial(async () => {
			const status = await this.#host.mailboxStatus();
			return status.maxPendingSeq;
		});
	}
}
