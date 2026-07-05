/**
 * FLY-224 Phase 4a — LeadInputRouter: the durable, SERIAL turn-loop orchestrator
 * for a Codex Lead (plan §6.2/§6.3, Phase 0A §3/§7).
 *
 * Receives inputs from BOTH sources (Discord gateway + Bridge/mailbox events),
 * funnels them through the LeadJournal (idempotent intake, ack-after-durable-
 * accept), and processes them ONE AT A TIME per (project, lead) — the router IS
 * per-Lead — driving each entry through the journal lifecycle:
 *
 *   accept → dispatching(corrId) → [executor.startTurn] → dispatched(turnId)
 *          → [await turn/completed] → model_completed
 *          → [sender.enqueue → output_pending(outboxId) → sender.deliver]
 *          → completed
 *
 * On any failure mid-flight the entry goes to `ambiguous` (NOT auto-retried) so
 * a crash/error can never double-fire a tool side-effect. On startup, `recover()`
 * drains unfinished journal rows by their conservative `recoveryAction`.
 *
 * Dependencies are injected (executor, sender) so this is unit-tested with fakes;
 * the real executor (wraps CodexLeadProcess, Phase 4b) and sender (canonical
 * Bridge endpoint, Phase 4b) land next. Mid-turn `turn/steer` (decision #6) is a
 * gateway-driven interrupt wired in Phase 4b; Phase 4a is the serial baseline
 * (a new input arriving mid-turn is enqueued and processed next).
 */

import type {
	JournalEntry,
	LeadJournal,
	RecoveryAction,
} from "./LeadJournal.js";
import type { RoundtableReplyRoute } from "./roundtable-reply-route.js";

/** Abstracts the app-server turn mechanics (real impl wraps CodexLeadProcess). */
export interface TurnExecutor {
	/** Start a turn; returns the app-server turnId. `clientUserMessageId` is the
	 * journal correlation id (Phase 0A §7 reconcile chain). */
	startTurn(args: {
		threadId: string;
		input: string;
		clientUserMessageId: string;
	}): Promise<string>;
	/** Resolve when the given turn completes; returns the assistant output text. */
	awaitCompletion(turnId: string): Promise<{ output: string }>;
	/**
	 * Reconcile recovery: does the thread already contain a turn for this
	 * correlation id, and did it complete? Used for `dispatching`/`dispatched`
	 * entries on restart (Phase 0A §7). Returns null if no such turn exists.
	 */
	reconcile(clientCorrelationId: string): Promise<{
		exists: boolean;
		completed: boolean;
		/** The REAL app-server turn id (never a placeholder) when exists=true. */
		turnId?: string;
		output?: string;
	}>;
}

/** Abstracts the durable outbox + canonical Discord sender (Phase 4b). */
export interface OutboundSender {
	/** Durably enqueue the reply; returns an outboxId. Idempotent on idempotencyKey.
	 * FLY-267: `channelId` routes the reply to a specific channel (the inbound source
	 * channel for a cross-dept input); omitted → the sender's default chat channel. */
	enqueue(args: {
		leadId: string;
		text: string;
		idempotencyKey: string;
		channelId?: string;
	}): Promise<string>;
	/** Deliver a previously-enqueued reply (canonical sender + Discord nonce). */
	deliver(outboxId: string): Promise<void>;
	/** Release any held resource (e.g. the outbox SQLite handle). Optional — a
	 * stateless direct sender has nothing to close (FLY-259 PR-D review MED). */
	close?(): void;
}

/**
 * FLY-404 — the Discord "typing…" capability the router drives while a founder's
 * message is being processed (parity with the Claude Lead, whose Discord plugin
 * shows typing). `start`/`stop` are FIRE-AND-FORGET and MUST never throw — a
 * typing failure can never break a reply turn. `channelId` undefined → the
 * notifier's default chat channel (the channel the reply posts to). The concrete
 * impl (keepalive loop + REST) is `DiscordTypingNotifier`; the router only depends
 * on this narrow interface so it stays unit-testable with a fake.
 */
export interface TypingNotifier {
	/** Begin showing "typing…" in `channelId` and keep it refreshed until stop(). */
	start(channelId?: string): void;
	/** Stop showing "typing…" in `channelId`. Idempotent. */
	stop(channelId?: string): void;
	/** Clear ALL active typing loops (shutdown / generation rebuild). */
	close(): void;
}

export interface LeadInput {
	idempotencyKey: string;
	source: "discord" | "mailbox";
	payload: string;
	/** FLY-267 回: the Discord channel a reply must route to (the inbound source
	 * channel). Set by the gateway ONLY for cross-dept/shared-channel messages;
	 * omitted for chat/core/mailbox → reply falls back to the default chat channel. */
	replyChannelId?: string;
	/** FLY-314 Phase 2: durable reply-in-thread route (set by the gateway for a
	 * roundtable top-level message whose topic thread must be ensured before delivery). */
	replyRoute?: RoundtableReplyRoute;
}

export interface LeadInputRouterOptions {
	leadId: string;
	threadId: string;
	journal: LeadJournal;
	executor: TurnExecutor;
	sender: OutboundSender;
	correlationFactory?: () => string;
	/** FLY-404: optional Discord typing indicator. Absent → no typing (byte-compat
	 * with every existing caller/test). Driven across the whole model turn in
	 * `processEntry` so the founder sees "typing…" while the Lead works. */
	typing?: TypingNotifier;
	/** FLY-314 Phase 2: ensure a topic thread exists before delivery. Wired by the
	 * runtime (it has the bot token + roundtable parent). Absent → no-op (byte-compat). */
	ensureReplyRoute?: (route: RoundtableReplyRoute) => Promise<void>;
	/** FLY-314 Part(b): seed the anti-loop budget for a newly-engaged top-level topic.
	 * Invoked ONLY when journal.accept() returns accepted (Codex code review R2 — a
	 * budget reset must require a durably-accepted NEW topic, not an at-least-once
	 * re-delivery of an old top-level message). Absent → no-op (byte-compat). */
	onTopicEngaged?: (route: RoundtableReplyRoute) => void;
	logger?: {
		warn: (m: string, c?: unknown) => void;
		error: (m: string, c?: unknown) => void;
	};
}

export class LeadInputRouter {
	private readonly leadId: string;
	private readonly threadId: string;
	private readonly journal: LeadJournal;
	private readonly executor: TurnExecutor;
	private readonly sender: OutboundSender;
	private readonly typing?: TypingNotifier;
	private readonly ensureReplyRoute?: (
		route: RoundtableReplyRoute,
	) => Promise<void>;
	private readonly onTopicEngaged?: (route: RoundtableReplyRoute) => void;
	private readonly corr: () => string;
	private readonly logger: {
		warn: (m: string, c?: unknown) => void;
		error: (m: string, c?: unknown) => void;
	};

	private readonly queue: string[] = []; // entry ids awaiting processing
	private processing = false;
	/** Resolves when the queue drains — for tests/shutdown to await quiescence. */
	private idleWaiters: Array<() => void> = [];

	constructor(opts: LeadInputRouterOptions) {
		this.leadId = opts.leadId;
		this.threadId = opts.threadId;
		this.journal = opts.journal;
		this.executor = opts.executor;
		this.sender = opts.sender;
		this.typing = opts.typing;
		this.ensureReplyRoute = opts.ensureReplyRoute;
		this.onTopicEngaged = opts.onTopicEngaged;
		this.corr =
			opts.correlationFactory ?? (() => globalThis.crypto.randomUUID());
		this.logger = opts.logger ?? {
			warn: (m, c) => console.warn(`[LeadInputRouter] ${m}`, c ?? ""),
			error: (m, c) => console.error(`[LeadInputRouter] ${m}`, c ?? ""),
		};
	}

	/**
	 * Durably accept an input. Returns `accepted: true` only for a NEW entry —
	 * the caller (gateway/mailbox watcher) MUST ack upstream ONLY when accepted
	 * (ack-after-durable-accept). Duplicates are dropped. Kicks the serial loop.
	 */
	submit(input: LeadInput): { accepted: boolean; entryId: string } {
		const { accepted, entry } = this.journal.accept(input);
		if (accepted) {
			// FLY-314 Part(b) / Codex code review R2: a budget reset (seed) happens ONLY
			// for a durably-accepted NEW top-level topic — never on an at-least-once
			// re-delivery (which dedups to accepted=false here). entry.replyRoute is set
			// only for the top-level→thread route, so this fires exactly on topic engage.
			if (entry.replyRoute) this.onTopicEngaged?.(entry.replyRoute);
			this.queue.push(entry.id);
			void this.pump();
		}
		return { accepted, entryId: entry.id };
	}

	/** Await the queue draining (no in-flight + empty). Test/shutdown helper. */
	whenIdle(): Promise<void> {
		if (!this.processing && this.queue.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	/**
	 * Crash recovery: drain unfinished journal rows by their conservative
	 * recovery action. Call once at startup BEFORE accepting new input.
	 */
	async recover(): Promise<void> {
		for (const entry of this.journal.listUnfinished()) {
			const action = this.journal.recoveryAction(entry);
			try {
				await this.recoverEntry(entry, action);
			} catch (err) {
				this.logger.error("recover entry failed", {
					id: entry.id,
					err: (err as Error).message,
				});
				this.safeAmbiguous(
					entry.id,
					`recover failed: ${(err as Error).message}`,
				);
			}
		}
	}

	// ── serial processing loop ──────────────────────────────────────────────

	private async pump(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			while (this.queue.length > 0) {
				const id = this.queue.shift();
				if (id === undefined) break;
				await this.processEntry(id);
			}
		} finally {
			this.processing = false;
			if (this.queue.length === 0) {
				const waiters = this.idleWaiters;
				this.idleWaiters = [];
				for (const w of waiters) w();
			}
		}
	}

	/** Drive one entry accepted → completed; any failure → ambiguous (no retry). */
	private async processEntry(id: string): Promise<void> {
		try {
			const corrId = this.corr();
			// toDispatching returns the updated entry (carrying payload) — no need
			// to re-read the store.
			const entry = this.journal.toDispatching(id, corrId);
			// FLY-404: show "typing…" in the channel the founder will see the reply in
			// (cross-dept → source channel; chat/core/mailbox → notifier default chat)
			// for the WHOLE model turn, and ALWAYS stop it after (finally) so a mid-turn
			// failure can never leak the indicator. start/stop never throw (by contract).
			this.typing?.start(entry.replyChannelId);
			try {
				const turnId = await this.executor.startTurn({
					threadId: this.threadId,
					input: entry.payload,
					clientUserMessageId: corrId,
				});
				this.journal.toDispatched(id, turnId);
				const { output } = await this.executor.awaitCompletion(turnId);
				// Persist output AT model_completed (CR HIGH-1): if we crash before the
				// outbox enqueue, recovery can still resend from the journal.
				this.journal.toModelCompleted(id, output);
				// FLY-267 回: route the reply to the inbound source channel (cross-dept
				// inputs carry replyChannelId; chat/core/mailbox leave it undefined → chat).
				await this.deliverOutput(
					id,
					output,
					entry.replyChannelId,
					entry.replyRoute,
				);
				this.journal.toCompleted(id);
			} finally {
				this.typing?.stop(entry.replyChannelId);
			}
		} catch (err) {
			// A side-effect MAY have run — never auto-retry; flag for human review.
			this.logger.error("processEntry failed → ambiguous", {
				id,
				err: (err as Error).message,
			});
			this.safeAmbiguous(id, `process failed: ${(err as Error).message}`);
		}
	}

	private async deliverOutput(
		id: string,
		output: string,
		channelId?: string,
		replyRoute?: RoundtableReplyRoute,
	): Promise<void> {
		// FLY-314 Phase 2 (Codex R3#1): ensure the topic thread exists BEFORE enqueue,
		// for every path that re-enqueues (normal / reconcile / model_completed).
		await this.ensureReplyRouteIfNeeded(replyRoute);
		const outboxId = await this.sender.enqueue({
			leadId: this.leadId,
			text: output,
			idempotencyKey: `${id}:out`,
			// FLY-267: undefined → sender's default chat channel (byte-compat).
			...(channelId ? { channelId } : {}),
		});
		this.journal.toOutputPending(id, outboxId);
		await this.sender.deliver(outboxId);
	}

	/**
	 * FLY-314 Phase 2: ensure the reply's topic thread exists before delivery. A
	 * common pre-delivery hook (Codex R3#1) so `output_pending` recovery can ensure
	 * WITHOUT re-enqueueing (which would break direct-mode's ambiguous-after-restart
	 * boundary). No-op unless the entry carries a `roundtable_thread_from_message`
	 * route AND an `ensureReplyRoute` fn is wired (byte-compat). Best-effort: a failure
	 * is logged, not thrown — the subsequent send surfaces any real problem.
	 */
	private async ensureReplyRouteIfNeeded(
		route?: RoundtableReplyRoute,
	): Promise<void> {
		if (!route || !this.ensureReplyRoute) return;
		if (route.kind !== "roundtable_thread_from_message") return;
		try {
			await this.ensureReplyRoute(route);
		} catch (err) {
			this.logger.warn("ensureReplyRoute failed (delivery will proceed)", {
				err: (err as Error).message,
			});
		}
	}

	// ── recovery ────────────────────────────────────────────────────────────

	private async recoverEntry(
		entry: JournalEntry,
		action: RecoveryAction,
	): Promise<void> {
		switch (action) {
			case "redispatch":
				// accepted: no turn created yet → safe to (re)enqueue.
				this.queue.push(entry.id);
				void this.pump();
				return;
			case "reconcile": {
				// dispatching/dispatched: prove via the thread whether a turn ran.
				const corrId = entry.clientCorrelationId;
				if (!corrId) {
					this.safeAmbiguous(entry.id, "reconcile: missing correlation id");
					return;
				}
				const r = await this.executor.reconcile(corrId);
				if (!r.exists) {
					// Provably no turn was created → safe to redispatch (back to accepted-like).
					// We cannot move dispatching→accepted; re-drive from dispatched is unsafe,
					// so resume forward only if completed; otherwise ambiguous.
					this.safeAmbiguous(
						entry.id,
						"reconcile: no turn found — cannot prove side-effect-free replay",
					);
					return;
				}
				if (r.completed && r.output !== undefined) {
					// Turn finished before the crash → only re-send output, never re-run.
					// Use the REAL turn id from reconcile (CR MED-2: no placeholder).
					if (entry.state === "dispatching" || entry.state === "dispatched") {
						if (entry.state === "dispatching") {
							if (!r.turnId) {
								this.safeAmbiguous(
									entry.id,
									"reconcile: completed turn without a real turnId",
								);
								return;
							}
							this.journal.toDispatched(entry.id, r.turnId);
						}
						this.journal.toModelCompleted(entry.id, r.output);
					}
					// FLY-267: recovery resend must target the same source channel.
					await this.deliverOutput(
						entry.id,
						r.output,
						entry.replyChannelId,
						entry.replyRoute,
					);
					this.journal.toCompleted(entry.id);
					return;
				}
				// Turn exists but not provably complete → human review.
				this.safeAmbiguous(entry.id, "reconcile: turn in unknown/active state");
				return;
			}
			case "resend_output":
				// model_completed/output_pending: re-send output only, never re-run.
				if (entry.outboxId) {
					// output_pending: the outbox already has it → just deliver. FLY-314
					// Phase 2 (Codex R3#1): ensure the thread first, but do NOT re-enqueue
					// via deliverOutput — that would break direct-mode's anti-duplicate
					// "can't-prove → ambiguous" boundary for a stale output_pending row.
					await this.ensureReplyRouteIfNeeded(entry.replyRoute);
					await this.sender.deliver(entry.outboxId);
					this.journal.toCompleted(entry.id);
				} else if (entry.output !== undefined) {
					// model_completed: output was persisted in the journal (CR HIGH-1)
					// → re-enqueue with the deterministic key (idempotent) + deliver.
					// FLY-267: route to the persisted source channel (else default chat).
					await this.deliverOutput(
						entry.id,
						entry.output,
						entry.replyChannelId,
						entry.replyRoute,
					);
					this.journal.toCompleted(entry.id);
				} else {
					this.safeAmbiguous(
						entry.id,
						"resend_output: no outboxId and no persisted output",
					);
				}
				return;
			default:
				return;
		}
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	private safeAmbiguous(id: string, reason: string): void {
		try {
			this.journal.toAmbiguous(id, reason);
		} catch (err) {
			this.logger.error("failed to mark ambiguous", {
				id,
				err: (err as Error).message,
			});
		}
	}
}
