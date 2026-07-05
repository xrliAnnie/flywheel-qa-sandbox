/**
 * FLY-224 Phase 3 — LeadJournal: the durable, transactional state machine for a
 * Codex Lead's input/turn lifecycle (plan §6.2 + Phase 0A §3/§7).
 *
 * Why this exists: a Codex app-server thread can execute arbitrary shell/MCP
 * side-effects (gh merge, flywheel-comm). On a crash, naively replaying an input
 * could double-fire those side-effects. The journal makes recovery DECISIONS
 * provable instead of guessed:
 *
 *   accepted → dispatching(clientCorrelationId) → dispatched(turnId)
 *            → model_completed → output_pending → completed
 *                                              ↘ ambiguous | dead_letter
 *
 * Honest semantics (Codex R3/R4/R5): the journal does NOT make arbitrary tool
 * calls exactly-once. It guarantees:
 *   - idempotent intake (a duplicate idempotencyKey is never enqueued twice),
 *   - a `dispatching` marker persisted BEFORE turn/start so recovery can tell
 *     "may have started a turn" apart from "definitely not started",
 *   - conservative recovery: only an `accepted` entry is safe to auto-redispatch;
 *     any `dispatching`/`dispatched` state must be RECONCILED, never auto re-run.
 *
 * Concurrency (Codex Phase-3a review HIGH-2): every state change goes through the
 * store's ATOMIC compare-and-set `transition()` (apply only if current state is
 * in `expectedFrom`). Two racers cannot both move `accepted → dispatching`; the
 * loser throws `JournalTransitionError`. The better-sqlite3 adapter implements
 * this as `UPDATE … WHERE id=? AND state IN (…)` + a rowcount check.
 *
 * Boundary isolation (HIGH-1): the store deep-copies entries on every read AND
 * write, so a caller can never mutate internal state (or corrupt the dedupe
 * index) by writing to a returned object.
 */

import type { RoundtableReplyRoute } from "./roundtable-reply-route.js";

export type JournalState =
	| "accepted"
	| "dispatching"
	| "dispatched"
	| "model_completed"
	| "output_pending"
	| "completed"
	| "ambiguous"
	| "dead_letter";

const ALL_STATES: readonly JournalState[] = [
	"accepted",
	"dispatching",
	"dispatched",
	"model_completed",
	"output_pending",
	"completed",
	"ambiguous",
	"dead_letter",
];

export const TERMINAL_STATES: ReadonlySet<JournalState> = new Set([
	"completed",
	"ambiguous",
	"dead_letter",
]);

/** Allowed forward transitions. Escape states (ambiguous/dead_letter) are
 * reachable from any non-terminal state — handled in `statesAllowing`. */
const FORWARD: Readonly<Record<JournalState, ReadonlySet<JournalState>>> = {
	accepted: new Set(["dispatching"]),
	dispatching: new Set(["dispatched"]),
	dispatched: new Set(["model_completed"]),
	model_completed: new Set(["output_pending"]),
	output_pending: new Set(["completed"]),
	completed: new Set(),
	ambiguous: new Set(),
	dead_letter: new Set(),
};

const ESCAPE_STATES: ReadonlySet<JournalState> = new Set([
	"ambiguous",
	"dead_letter",
]);

/** The set of states from which a transition to `to` is legal. */
function statesAllowing(to: JournalState): JournalState[] {
	if (ESCAPE_STATES.has(to)) {
		return ALL_STATES.filter((s) => !TERMINAL_STATES.has(s));
	}
	return ALL_STATES.filter((s) => FORWARD[s].has(to));
}

export interface JournalEntry {
	/** Internal entry id (uuid). */
	id: string;
	/** Caller idempotency key (Discord msg id / mailbox envelope seq). */
	idempotencyKey: string;
	source: "discord" | "mailbox" | "founder-terminal";
	/** Opaque input content (text / serialized event). */
	payload: string;
	/** FLY-267 回: the Discord channel a reply must be routed to (the inbound
	 * message's source channel), set ONLY for cross-dept/shared-channel inputs.
	 * Absent → the outbound sender falls back to its default chat channel (byte-compat:
	 * chat/core inputs and mailbox inputs reply in chat as before). Persisted so crash
	 * recovery (model_completed resend) targets the right channel. */
	replyChannelId?: string;
	/** FLY-314 Phase 2: durable reply-in-thread route metadata. When set (kind
	 * `roundtable_thread_from_message`), delivery must ensure the topic thread exists
	 * BEFORE sending — the Bridge poller may not have created it yet, and
	 * `replyChannelId === sourceMessageId` is too weak a signal to infer this (Codex
	 * design review R2#1/R3#1). Persisted so crash recovery re-ensures the same thread. */
	replyRoute?: RoundtableReplyRoute;
	state: JournalState;
	/** Set at `dispatching` — becomes turn/start's clientUserMessageId. */
	clientCorrelationId?: string;
	/** Set at `dispatched` — the app-server turn id. */
	turnId?: string;
	/** Set at `model_completed` — the assistant output text, persisted BEFORE the
	 * outbox enqueue so a crash in that window can still resend (Phase-4a CR HIGH). */
	output?: string;
	/** Set at `output_pending` — the durable outbox id (canonical sender). */
	outboxId?: string;
	/** Reason for ambiguous / dead_letter. */
	reason?: string;
	createdAt: number;
	updatedAt: number;
}

export class JournalTransitionError extends Error {
	constructor(
		readonly from: JournalState | "missing",
		readonly to: JournalState,
		readonly entryId: string,
	) {
		super(`illegal journal transition ${from} → ${to} (entry ${entryId})`);
		this.name = "JournalTransitionError";
	}
}

export interface JournalStore {
	/**
	 * Insert a new `accepted` entry IFF `idempotencyKey` is not already present.
	 * Returns the existing entry (inserted=false) on a duplicate key. The stored
	 * and returned entries are COPIES (no shared reference).
	 */
	insertAccepted(entry: JournalEntry): {
		inserted: boolean;
		entry: JournalEntry;
	};
	/** Returns a COPY, or undefined. */
	getById(id: string): JournalEntry | undefined;
	/** Returns a COPY, or undefined. */
	getByIdempotencyKey(key: string): JournalEntry | undefined;
	/**
	 * ATOMIC guarded transition: apply `patch` + set `state=to` ONLY if the
	 * entry's current state is in `expectedFrom`. Throws `JournalTransitionError`
	 * on precondition miss (or missing entry). Returns a COPY of the updated row.
	 */
	transition(args: {
		id: string;
		expectedFrom: readonly JournalState[];
		to: JournalState;
		patch: Partial<JournalEntry>;
	}): JournalEntry;
	/** Non-terminal entries (crash recovery), oldest first — COPIES. */
	listUnfinished(): JournalEntry[];
}

/** Recommended recovery action for an entry found unfinished at startup. */
export type RecoveryAction =
	| "redispatch" // accepted: no turn created yet → safe to (re)start
	| "reconcile" // dispatching/dispatched: must check the thread before acting
	| "resend_output" // model_completed/output_pending: re-send output, never re-run model
	| "none"; // terminal

export interface LeadJournalOptions {
	store: JournalStore;
	/** Injectable id generator (tests) — must be unique per call. */
	idFactory?: () => string;
	/** Injectable clock (tests). */
	now?: () => number;
}

export class LeadJournal {
	private readonly store: JournalStore;
	private readonly idFactory: () => string;
	private readonly now: () => number;

	constructor(opts: LeadJournalOptions) {
		this.store = opts.store;
		this.idFactory = opts.idFactory ?? (() => globalThis.crypto.randomUUID());
		this.now = opts.now ?? (() => Date.now());
	}

	/**
	 * Idempotent intake. Returns `{ accepted: true }` only when a NEW entry was
	 * created — the caller must ack the upstream source ONLY after this returns
	 * (ack-after-durable-accept). A duplicate key returns the existing entry with
	 * `accepted: false`.
	 */
	accept(args: {
		idempotencyKey: string;
		source: "discord" | "mailbox" | "founder-terminal";
		payload: string;
		/** FLY-267 回: source channel to route the reply to (cross-dept inputs only). */
		replyChannelId?: string;
		/** FLY-314 Phase 2: durable reply-in-thread route metadata. */
		replyRoute?: RoundtableReplyRoute;
	}): { accepted: boolean; entry: JournalEntry } {
		if (!args.idempotencyKey)
			throw new Error("LeadJournal.accept: idempotencyKey is required");
		const ts = this.now();
		const candidate: JournalEntry = {
			id: this.idFactory(),
			idempotencyKey: args.idempotencyKey,
			source: args.source,
			payload: args.payload,
			...(args.replyChannelId ? { replyChannelId: args.replyChannelId } : {}),
			...(args.replyRoute ? { replyRoute: args.replyRoute } : {}),
			state: "accepted",
			createdAt: ts,
			updatedAt: ts,
		};
		const { inserted, entry } = this.store.insertAccepted(candidate);
		return { accepted: inserted, entry };
	}

	/** FLY-259 PR-D (plan D5): record a founder-terminal turn as an
	 * observe-only AUDIT row — TERMINAL state from birth (never appears in
	 * listUnfinished, never gates the queue, never triggers outbound).
	 * Idempotent via the turn-scoped key. */
	recordObservation(args: {
		idempotencyKey: string;
		payload: string;
		output?: string;
	}): void {
		const now = this.now();
		this.store.insertAccepted({
			id: `obs-${args.idempotencyKey}`,
			idempotencyKey: args.idempotencyKey,
			source: "founder-terminal",
			payload: args.payload,
			state: "completed",
			...(args.output !== undefined ? { output: args.output } : {}),
			createdAt: now,
			updatedAt: now,
		});
	}

	/** Persist `dispatching` BEFORE turn/start, carrying the correlation id. */
	toDispatching(id: string, clientCorrelationId: string): JournalEntry {
		if (!clientCorrelationId)
			throw new Error("toDispatching: clientCorrelationId is required");
		return this.transition(id, "dispatching", { clientCorrelationId });
	}

	/** Persist `dispatched` once turn/start returned a turnId. */
	toDispatched(id: string, turnId: string): JournalEntry {
		if (!turnId) throw new Error("toDispatched: turnId is required");
		return this.transition(id, "dispatched", { turnId });
	}

	/** Persist `model_completed` WITH the assistant output, so a crash before the
	 * outbox enqueue can still resend it on recovery (Phase-4a CR HIGH-1). */
	toModelCompleted(id: string, output?: string): JournalEntry {
		return this.transition(id, "model_completed", { output: output ?? "" });
	}

	toOutputPending(id: string, outboxId: string): JournalEntry {
		if (!outboxId) throw new Error("toOutputPending: outboxId is required");
		return this.transition(id, "output_pending", { outboxId });
	}

	toCompleted(id: string): JournalEntry {
		return this.transition(id, "completed", {});
	}

	/** Escape hatches — allowed from any non-terminal state. */
	toAmbiguous(id: string, reason: string): JournalEntry {
		if (!reason) throw new Error("toAmbiguous: reason is required");
		return this.transition(id, "ambiguous", { reason });
	}

	toDeadLetter(id: string, reason: string): JournalEntry {
		if (!reason) throw new Error("toDeadLetter: reason is required");
		return this.transition(id, "dead_letter", { reason });
	}

	listUnfinished(): JournalEntry[] {
		return this.store.listUnfinished();
	}

	/**
	 * Conservative recovery action for an unfinished entry (Phase 0A §7). Never
	 * returns an action that would auto-re-run the model from an unprovable state.
	 */
	recoveryAction(entry: JournalEntry): RecoveryAction {
		switch (entry.state) {
			case "accepted":
				return "redispatch";
			case "dispatching":
			case "dispatched":
				return "reconcile";
			case "model_completed":
			case "output_pending":
				return "resend_output";
			default:
				return "none";
		}
	}

	private transition(
		id: string,
		to: JournalState,
		patch: Partial<JournalEntry>,
	): JournalEntry {
		return this.store.transition({
			id,
			expectedFrom: statesAllowing(to),
			to,
			patch: { ...patch, updatedAt: this.now() },
		});
	}
}

/** Deep-ish copy of a flat JournalEntry (all fields are primitives). */
function copyEntry(e: JournalEntry): JournalEntry {
	return { ...e };
}

/** In-memory JournalStore (unit tests + reference impl). Single-threaded JS
 * makes its read-then-write inside `transition` atomic with respect to other
 * `transition` calls; copies guard external mutation. */
export class InMemoryJournalStore implements JournalStore {
	private readonly byId = new Map<string, JournalEntry>();
	private readonly byKey = new Map<string, string>(); // idempotencyKey → id
	private readonly seqOf = new Map<string, number>();
	private seq = 0;

	insertAccepted(entry: JournalEntry): {
		inserted: boolean;
		entry: JournalEntry;
	} {
		const existingId = this.byKey.get(entry.idempotencyKey);
		if (existingId) {
			const existing = this.byId.get(existingId);
			if (existing) return { inserted: false, entry: copyEntry(existing) };
		}
		const stored = copyEntry(entry);
		this.byId.set(stored.id, stored);
		this.byKey.set(stored.idempotencyKey, stored.id);
		this.seqOf.set(stored.id, this.seq++);
		return { inserted: true, entry: copyEntry(stored) };
	}

	getById(id: string): JournalEntry | undefined {
		const e = this.byId.get(id);
		return e ? copyEntry(e) : undefined;
	}

	getByIdempotencyKey(key: string): JournalEntry | undefined {
		const id = this.byKey.get(key);
		const e = id ? this.byId.get(id) : undefined;
		return e ? copyEntry(e) : undefined;
	}

	transition(args: {
		id: string;
		expectedFrom: readonly JournalState[];
		to: JournalState;
		patch: Partial<JournalEntry>;
	}): JournalEntry {
		const current = this.byId.get(args.id);
		if (!current) throw new JournalTransitionError("missing", args.to, args.id);
		if (!args.expectedFrom.includes(current.state)) {
			throw new JournalTransitionError(current.state, args.to, args.id);
		}
		// idempotencyKey is immutable — never let a patch corrupt the dedupe index.
		const {
			idempotencyKey: _ignored,
			id: _ignoredId,
			...safePatch
		} = args.patch;
		const updated: JournalEntry = {
			...current,
			...safePatch,
			state: args.to,
		};
		this.byId.set(updated.id, updated); // already a fresh object
		return copyEntry(updated);
	}

	listUnfinished(): JournalEntry[] {
		return [...this.byId.values()]
			.filter((e) => !TERMINAL_STATES.has(e.state))
			.sort((a, b) => (this.seqOf.get(a.id) ?? 0) - (this.seqOf.get(b.id) ?? 0))
			.map(copyEntry);
	}
}
