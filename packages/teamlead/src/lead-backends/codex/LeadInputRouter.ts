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
	/** Durably enqueue the reply; returns an outboxId. Idempotent on idempotencyKey. */
	enqueue(args: {
		leadId: string;
		text: string;
		idempotencyKey: string;
	}): Promise<string>;
	/** Deliver a previously-enqueued reply (canonical sender + Discord nonce). */
	deliver(outboxId: string): Promise<void>;
	/** Release any held resource (e.g. the outbox SQLite handle). Optional — a
	 * stateless direct sender has nothing to close (FLY-259 PR-D review MED). */
	close?(): void;
}

export interface LeadInput {
	idempotencyKey: string;
	source: "discord" | "mailbox";
	payload: string;
}

export interface LeadInputRouterOptions {
	leadId: string;
	threadId: string;
	journal: LeadJournal;
	executor: TurnExecutor;
	sender: OutboundSender;
	correlationFactory?: () => string;
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
			await this.deliverOutput(id, output);
			this.journal.toCompleted(id);
		} catch (err) {
			// A side-effect MAY have run — never auto-retry; flag for human review.
			this.logger.error("processEntry failed → ambiguous", {
				id,
				err: (err as Error).message,
			});
			this.safeAmbiguous(id, `process failed: ${(err as Error).message}`);
		}
	}

	private async deliverOutput(id: string, output: string): Promise<void> {
		const outboxId = await this.sender.enqueue({
			leadId: this.leadId,
			text: output,
			idempotencyKey: `${id}:out`,
		});
		this.journal.toOutputPending(id, outboxId);
		await this.sender.deliver(outboxId);
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
					await this.deliverOutput(entry.id, r.output);
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
					// output_pending: the outbox already has it → just deliver.
					await this.sender.deliver(entry.outboxId);
					this.journal.toCompleted(entry.id);
				} else if (entry.output !== undefined) {
					// model_completed: output was persisted in the journal (CR HIGH-1)
					// → re-enqueue with the deterministic key (idempotent) + deliver.
					await this.deliverOutput(entry.id, entry.output);
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
