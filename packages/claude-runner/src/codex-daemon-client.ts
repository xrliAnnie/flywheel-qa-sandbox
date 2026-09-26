/**
 * FLY-1188 M4 — codex remote-control daemon client (runner side).
 *
 * The resident /goal form: a runner drives a Codex `app-server
 * --remote-control` daemon over its unix-socket control channel, sets a
 * first-class Goal (thread/goal/set), kicks a turn, and lets the native Goal
 * machinery auto-continue across turns until it reaches a terminal status.
 * The founder watches the SAME thread via `codex resume --remote` in cmux.
 *
 * Dependency-direction note: claude-runner MUST NOT import teamlead's
 * lead-backends/codex components (teamlead depends on claude-runner, so that
 * would be a cycle). This module reimplements the minimal client the runner
 * needs, mirroring the verified precedent's wire details:
 *   - ws+unix scheme, permessage-deflate DISABLED (the daemon hangs up on the
 *     extension offer — real-daemon verified in daemon-ws.ts and V1 probe);
 *   - initialize → initialized handshake before any request;
 *   - the v2 Goal RPC surface (thread/goal/set|get + Goal*Notification), which
 *     the V1/V2/V3 isolated probes proved: goal/set + one kick turn →
 *     autonomous multi-turn continuation → real active→complete transition,
 *     goal state persisted with the thread (survives a daemon restart).
 *
 * The transport is injected (structural `DaemonTransport`) so the lifecycle
 * state machine is unit-testable without a live daemon.
 */

/** Native Goal status (app-server protocol v2 ThreadGoalStatus). */
export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "usageLimited"
	| "budgetLimited"
	| "complete";

/** Terminal statuses: the goal run is over (well, or needs intervention). */
const TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
	"complete",
	"blocked",
	"usageLimited",
	"budgetLimited",
]);

export function isTerminalGoalStatus(s: GoalStatus): boolean {
	return TERMINAL_STATUSES.has(s);
}

/**
 * FLY-1236: the daemon's `thread/goal/set` hard-rejects an objective longer than
 * this (observed RPC error -32600 "goal objective must be at most 4000
 * characters"). The durable `/goal` therefore carries only a bounded north-star
 * pointer; the full working instructions ride the kick turn (`turn/start`, which
 * is NOT subject to this cap). Lives here in the protocol layer so both the
 * adapter helper (graceful degrade) and `setGoal` (fail-closed guard) share one
 * source of truth without a reverse dependency (the helper already imports this
 * module).
 */
export const GOAL_OBJECTIVE_MAX_CHARS = 4000;

/**
 * Minimal duplex the client needs — one JSON message per send/receive. The
 * real transport is a ws+unix socket; tests inject a fake.
 */
export interface DaemonTransport {
	/** Send one JSON-RPC frame (already an object; the impl serializes). */
	send(frame: unknown): void;
	/** Register the single message handler (one JSON object per call). */
	onMessage(handler: (frame: unknown) => void): void;
	/** Register a close/error handler (fatal — pending requests reject). */
	onClose(handler: (reason: string) => void): void;
	close(): void;
}

interface JsonRpcResponse {
	id?: number;
	result?: unknown;
	error?: { code?: number; message?: string } | unknown;
}

export interface GoalNotification {
	threadId?: string;
	turnId?: string | null;
	goal?: {
		status?: GoalStatus;
		objective?: string;
		tokensUsed?: number;
		timeUsedSeconds?: number;
	} | null;
}

export interface CodexDaemonClientOptions {
	transport: DaemonTransport;
	clientName?: string;
	clientVersion?: string;
	/** Per-request timeout (default 30s). */
	requestTimeoutMs?: number;
	logger?: (msg: string) => void;
	/** Injected clock (default Date.now) — tests avoid the real clock. */
	now?: () => number;
	setTimeoutFn?: (fn: () => void, ms: number) => { unref?: () => void };
	clearTimeoutFn?: (h: unknown) => void;
}

export interface GoalRunResult {
	status: GoalStatus;
	tokensUsed: number;
	/** Distinct turnIds observed across the run. */
	turns: number;
	/** True only for a clean `complete`. */
	succeeded: boolean;
}

export interface GoalPhaseHold {
	schemaVersion: 1;
	role: "design" | "implement" | "qa";
	state: "entering" | "paused" | "reactivating";
	enteredAt: string;
	deadlineRemainingMs: number;
	hardDeadlineRemainingMs: number;
}

export type GoalPhaseObservation =
	| { kind: "active" }
	| { kind: "parked"; reason?: string }
	| {
			kind: "wake";
			message: {
				id: string;
				content: string;
				metadata?: Record<string, unknown>;
			};
	  }
	| { kind: "shutdown"; requestId: string }
	| { kind: "unknown"; error: string };

/** Structural phase controller seam; this protocol layer imports no CommDB. */
export interface GoalPhaseLifecycle {
	getPhaseHold(): GoalPhaseHold | null;
	enterHold(budget: {
		deadlineRemainingMs: number;
		hardDeadlineRemainingMs: number;
	}): Promise<void>;
	confirmHoldPaused(): Promise<void>;
	observe(): GoalPhaseObservation;
	waitForActivity(timeoutMs: number): Promise<void>;
	markWakeStarted(messageId: string): void;
	finishWake(messageId: string): void;
	leaveHold(): Promise<void>;
}

/** Streaming events surfaced to the caller (pane render, gate detection). */
export interface CodexDaemonEvents {
	/** Every raw server notification method (for pane rendering / diagnostics). */
	onNotification?: (method: string, params: unknown) => void;
	/** Each goal status update (dedup NOT applied — caller may throttle). */
	onGoalUpdate?: (n: GoalNotification) => void;
}

export class CodexDaemonError extends Error {
	constructor(
		message: string,
		readonly kind:
			| "closed"
			| "rpc_error"
			| "timeout"
			| "handshake"
			| "no_thread",
	) {
		super(message);
		this.name = "CodexDaemonError";
	}
}

export class CodexDaemonClient {
	private readonly t: DaemonTransport;
	private readonly log: (msg: string) => void;
	private readonly reqTimeoutMs: number;
	private readonly setTimeoutFn: NonNullable<
		CodexDaemonClientOptions["setTimeoutFn"]
	>;
	private readonly clearTimeoutFn: (h: unknown) => void;
	private readonly clientName: string;
	private readonly clientVersion: string;
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
	>();
	private closedReason: string | null = null;
	private events: CodexDaemonEvents = {};

	constructor(opts: CodexDaemonClientOptions) {
		this.t = opts.transport;
		this.log = opts.logger ?? (() => {});
		this.reqTimeoutMs = opts.requestTimeoutMs ?? 30_000;
		this.setTimeoutFn =
			opts.setTimeoutFn ??
			((fn, ms) => setTimeout(fn, ms) as unknown as { unref?: () => void });
		this.clearTimeoutFn =
			opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
		this.clientName = opts.clientName ?? "flywheel-codex-runner";
		this.clientVersion = opts.clientVersion ?? "1.0.0";
		this.t.onMessage((frame) => this.handleFrame(frame));
		this.t.onClose((reason) => this.handleClose(reason));
	}

	setEvents(events: CodexDaemonEvents): void {
		this.events = events;
	}

	// ── framing ──────────────────────────────────────────────────────────

	private handleFrame(frame: unknown): void {
		// R22 HIGH: once the transport is closed, drop EVERY late frame. A
		// notification arriving after close must never become lifecycle
		// authority — a post-close terminal would otherwise set terminalSeen and
		// fake a successful run. (A late response has no pending entry to resolve
		// anyway; a late server-request can't be answered on a dead socket.)
		if (this.closedReason !== null) return;
		if (typeof frame !== "object" || frame === null) return;
		const msg = frame as JsonRpcResponse & {
			method?: string;
			params?: unknown;
		};
		// R19 HIGH-2: a JSON-RPC RESPONSE has NO `method` and carries a
		// `result` or `error`. A server-initiated REQUEST/NOTIFICATION always
		// has a `method` — even if it reuses a numeric id — and must NOT be
		// mistaken for a reply to our pending request. (This client issues no
		// callable server-request handlers; a server request is treated as a
		// notification for observation and never resolves a pending entry.)
		const isResponse =
			msg.method === undefined &&
			typeof msg.id === "number" &&
			("result" in msg || "error" in msg);
		if (isResponse && this.pending.has(msg.id as number)) {
			const p = this.pending.get(msg.id as number);
			this.pending.delete(msg.id as number);
			p?.resolve(msg);
			return;
		}
		if (typeof msg.method === "string") {
			// R20 HIGH-2: a server-initiated REQUEST (has both id AND method)
			// expects a JSON-RPC response. This client implements no callable
			// server methods, so answer with a bounded `method not found` error
			// immediately — otherwise the daemon waits forever for our reply.
			if (typeof msg.id === "number") {
				try {
					this.t.send({
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: -32601, message: "method not found" },
					});
				} catch (err) {
					// R21 MEDIUM: a failed reply write is a dead transport — mark
					// closed so isClosed() flips (don't silently swallow it).
					this.handleClose(
						`send failed for server-request reply: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			this.events.onNotification?.(msg.method, msg.params);
			if (msg.method.includes("goal")) {
				this.events.onGoalUpdate?.(msg.params as GoalNotification);
			}
		}
	}

	/** True once the transport has closed (client- or peer-initiated). */
	isClosed(): boolean {
		return this.closedReason !== null;
	}

	private handleClose(reason: string): void {
		if (this.closedReason !== null) return;
		this.closedReason = reason;
		this.log(`codex daemon transport closed: ${reason}`);
		for (const [, p] of this.pending) {
			p.reject(new CodexDaemonError(`daemon closed: ${reason}`, "closed"));
		}
		this.pending.clear();
	}

	private request(
		method: string,
		params?: unknown,
		// R21 HIGH-1: an optional per-call budget that TIGHTENS (never loosens)
		// the default per-request timeout — runGoalToTerminal passes the goal
		// run's remaining budget so no single RPC can outlive the hard ceiling.
		timeoutMs?: number,
	): Promise<JsonRpcResponse> {
		if (this.closedReason !== null) {
			return Promise.reject(
				new CodexDaemonError(
					`cannot request "${method}": daemon closed (${this.closedReason})`,
					"closed",
				),
			);
		}
		const effTimeoutMs = Math.max(
			0,
			Math.min(this.reqTimeoutMs, timeoutMs ?? this.reqTimeoutMs),
		);
		// R22 MEDIUM: a zero/negative effective budget must fail-close BEFORE a
		// pending entry is created or a frame is sent — otherwise a 0ms timer
		// races a synchronous/microtask response and a reply can beat the
		// deadline, breaking the hard-ceiling guarantee.
		if (effTimeoutMs <= 0) {
			return Promise.reject(
				new CodexDaemonError(
					`request "${method}" has no remaining time budget`,
					"timeout",
				),
			);
		}
		const id = this.nextId++;
		return new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer = this.setTimeoutFn(() => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				reject(
					new CodexDaemonError(`request "${method}" timed out`, "timeout"),
				);
			}, effTimeoutMs);
			(timer as { unref?: () => void }).unref?.();
			this.pending.set(id, {
				resolve: (r) => {
					this.clearTimeoutFn(timer);
					if (r.error !== undefined) {
						reject(
							new CodexDaemonError(
								`rpc "${method}" error: ${JSON.stringify(r.error)}`,
								"rpc_error",
							),
						);
					} else {
						resolve(r);
					}
				},
				reject: (e) => {
					this.clearTimeoutFn(timer);
					reject(e);
				},
			});
			try {
				this.t.send({ jsonrpc: "2.0", id, method, params });
			} catch (err) {
				// R21 MEDIUM: a synchronous send failure is a FATAL transport
				// write error, not a per-request hiccup — mark the whole transport
				// closed so isClosed() flips (the goal loop then fails closed
				// instead of treating it as a transient retry). handleClose
				// rejects + clears every pending entry (including this id) and
				// clears its timer via the reject wrapper above. Guard the current
				// id in case the transport was already closed.
				this.clearTimeoutFn(timer);
				const reason = `send failed for "${method}": ${err instanceof Error ? err.message : String(err)}`;
				this.handleClose(reason);
				if (this.pending.delete(id)) {
					reject(new CodexDaemonError(reason, "closed"));
				}
			}
		});
	}

	private notify(method: string, params?: unknown): void {
		if (this.closedReason !== null) return;
		this.t.send({ jsonrpc: "2.0", method, params });
	}

	// ── protocol ─────────────────────────────────────────────────────────

	async initialize(): Promise<void> {
		const res = await this.request("initialize", {
			clientInfo: {
				name: this.clientName,
				title: "Flywheel Codex Runner",
				version: this.clientVersion,
			},
			capabilities: {},
		});
		if (res.error !== undefined) {
			throw new CodexDaemonError("initialize failed", "handshake");
		}
		// R2 HIGH-1 precedent: `initialized` only AFTER a successful initialize.
		this.notify("initialized", {});
	}

	/** thread/start → returns the new thread id. */
	async startThread(input: {
		cwd: string;
		sandbox?: "read-only" | "workspace-write" | "danger-full-access";
		approvalPolicy?: "never" | "on-request" | "on-failure" | "unless-trusted";
		model?: string;
		baseInstructions?: string;
	}): Promise<string> {
		const res = await this.request("thread/start", {
			cwd: input.cwd,
			...(input.sandbox ? { sandbox: input.sandbox } : {}),
			...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.baseInstructions
				? { baseInstructions: input.baseInstructions }
				: {}),
		});
		const id = extractThreadId(res.result);
		if (!id)
			throw new CodexDaemonError("thread/start returned no id", "no_thread");
		return id;
	}

	/** thread/resume — the daemon-restart / account-rotation recovery path. */
	async resumeThread(threadId: string): Promise<string> {
		const res = await this.request("thread/resume", { threadId });
		return extractThreadId(res.result) ?? threadId;
	}

	async setGoal(
		input: {
			threadId: string;
			objective: string;
			tokenBudget?: number;
			status?: GoalStatus;
		},
		timeoutMs?: number,
	): Promise<void> {
		// FLY-1236: fail closed at the final RPC boundary — never let an oversized
		// objective reach the daemon (it would reject with -32600 "goal objective
		// must be at most 4000 characters" → the cryptic setup_failed this fix
		// removes). The adapter degrades gracefully upstream; this guards any other
		// caller / future refactor that bypasses that path. The full working
		// instructions are delivered via the kick turn, never the objective.
		if (input.objective.length > GOAL_OBJECTIVE_MAX_CHARS) {
			throw new GoalRunError(
				`goal objective is ${input.objective.length} chars (> ${GOAL_OBJECTIVE_MAX_CHARS} limit); refusing thread/goal/set — the durable /goal must be a bounded pointer, not the task body`,
				"setup_failed",
			);
		}
		await this.request(
			"thread/goal/set",
			{
				threadId: input.threadId,
				objective: input.objective,
				status: input.status ?? "active",
				...(input.tokenBudget != null
					? { tokenBudget: input.tokenBudget }
					: {}),
			},
			timeoutMs,
		);
	}

	async getGoal(
		threadId: string,
		timeoutMs?: number,
	): Promise<GoalNotification["goal"] | null> {
		const res = await this.request("thread/goal/get", { threadId }, timeoutMs);
		const r = res.result as { goal?: GoalNotification["goal"] } | undefined;
		return r?.goal ?? null;
	}

	async clearGoal(threadId: string): Promise<void> {
		await this.request("thread/goal/clear", { threadId });
	}

	/**
	 * turn/start — submit one input turn (the kick, or a wake continuation).
	 * The RPC returns quickly; the turn itself runs asynchronously and its
	 * progress arrives as notifications.
	 */
	async startTurn(
		threadId: string,
		text: string,
		timeoutMs?: number,
	): Promise<void> {
		await this.request(
			"turn/start",
			{
				threadId,
				input: [{ type: "text", text }],
			},
			timeoutMs,
		);
	}

	close(): void {
		// R19 MEDIUM: mark closed + reject any in-flight requests BEFORE the
		// transport close, so a proactive close does not leave pending entries
		// dangling if the transport's own close handler is async or absent.
		this.handleClose("closed by client");
		this.t.close();
	}
}

/** R20: distinguishable failure of the whole goal run (not a goal STATUS). */
export class GoalRunError extends Error {
	constructor(
		message: string,
		// R21: `setup_failed` = setGoal/startTurn rejected for a reason that is
		// neither the overall deadline nor a transport death (e.g. the daemon
		// rpc-errored) — still a hard fail-close, but not mislabeled as a
		// transport death.
		// R24: `goal_replaced` = the thread's goal was overwritten by another
		// control end (the poll's objective no longer matches ours) — our run's
		// goal is gone, so fail closed rather than claim a foreign terminal.
		readonly kind:
			| "timeout"
			| "transport_closed"
			| "setup_failed"
			| "goal_replaced",
	) {
		super(message);
		this.name = "GoalRunError";
	}
}

/**
 * Drive a goal to a terminal status. Sets the goal, kicks the first turn, and
 * RESOLVES when a goal notification (or the getGoal poll fallback) reports a
 * terminal status. NEVER resolves with a non-terminal status — R20 HIGH-1:
 * the overall deadline is armed BEFORE the goal is set, and a deadline
 * expiry or a transport death REJECTS with a GoalRunError (never returns a
 * stale `active`). A terminal status that is not `complete`
 * (blocked/usageLimited/budgetLimited) still RESOLVES — the caller decides
 * what that means for the pipeline.
 */
export async function runGoalToTerminal(
	client: CodexDaemonClient,
	input: {
		threadId: string;
		objective: string;
		tokenBudget?: number;
		kickText?: string;
		/** The ACTIVE ceiling — the cap on a run that is NOT waiting on a gate
		 * (default 60min). FLY-1188 MED-7: this is the invariant that must hold for
		 * a task that never opens a gate. */
		overallTimeoutMs?: number;
		/** FLY-1188 MED-7: the EXTENDED ceiling used ONLY while a gate is open
		 * (`isWaiting()` true) — a runner genuinely blocked on a Lead answer may
		 * idle up to here. Absent → equals overallTimeoutMs (no extension;
		 * byte-compatible single-ceiling behavior). */
		waitingTimeoutMs?: number;
		/** FLY-1188 MED-7: is this run currently waiting on an OPEN gate? Polled to
		 * decide whether the extended ceiling applies. Absent → never (the run is
		 * always capped at the active ceiling). */
		isWaiting?: () => boolean;
		/**
		 * FLY-1188 MED-7 R2 (Codex full-PR review): the RUN's absolute start instant,
		 * so the ceilings are anchored to the run — not to THIS call. The daemon
		 * runtime restarts (account rotation) by calling this function again; without
		 * this, each restart re-armed a full fresh budget and N restarts multiplied
		 * the cap. Absent → `now()` (byte-compatible single-call behavior).
		 */
		startedAt?: number;
		/**
		 * FLY-1188 MED-7 R3 (Codex full-PR review): a FLOOR the deadline never drops
		 * below, so a gate-wait extension the PRIOR call accumulated survives a
		 * transport restart. Without it a restart rebuilds the deadline from
		 * `startedAt + activeCap` and a runner that legitimately waited past that (a
		 * long gate) is killed the instant the gate closes + the transport bounces.
		 * The runtime feeds back the max extended deadline via `onDeadlineExtended`.
		 */
		minDeadlineMs?: number;
		/** Phase-restored hard-deadline floor carried across daemon restarts. */
		minHardDeadlineMs?: number;
		/** FLY-1188 MED-7 R3: fired whenever the deadline is extended (monotonic),
		 * so the runtime can carry the extension across restarts. */
		onDeadlineExtended?: (deadlineMs: number) => void;
		/** Reports both deadlines after a phase hold restores frozen budgets. */
		onBudgetRestored?: (budget: {
			deadlineMs: number;
			hardDeadlineMs: number;
		}) => void;
		/** FLY-1269: explicit resident three-stage phase lifecycle. */
		phaseLifecycle?: GoalPhaseLifecycle;
		/** Slow, zero-token phase control poll (default 15s). */
		phaseControlPollIntervalMs?: number;
		/** Per local phase control RPC bound (default 30s). */
		phaseControlRpcTimeoutMs?: number;
		/** getGoal poll interval as a fallback to the notification stream. */
		pollIntervalMs?: number;
		/** FLY-1188 M4d: fired the INSTANT this run's goal is confirmed SET (right
		 * after `setGoal` resolves) — the safe FLY-245 launch-commit point (a crash
		 * before this must re-drive, not adopt a goal-less thread). A throwing
		 * handler is swallowed. */
		onGoalActive?: () => void;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	},
	events?: CodexDaemonEvents,
): Promise<GoalRunResult> {
	const now = input.now ?? Date.now;
	const sleep =
		input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const overallTimeoutMs = input.overallTimeoutMs ?? 60 * 60_000;
	const pollIntervalMs = input.pollIntervalMs ?? 15_000;

	// R20 HIGH-1: arm the deadline BEFORE any RPC, so setGoal/startTurn latency
	// counts against the ceiling. FLY-1188 MED-7: the ceiling is DYNAMIC — the
	// active cap normally, extended to the waiting cap ONLY while a gate is open.
	// MED-7 R2: anchor the ceilings to the RUN's start, not this call's — the
	// runtime passes the same `startedAt` across account-rotation restarts, so a
	// restart cannot re-arm a fresh budget (N restarts multiplied the cap).
	const startedAt = input.startedAt ?? now();
	const activeCapMs = overallTimeoutMs;
	const hardCeilingMs = Math.max(
		overallTimeoutMs,
		input.waitingTimeoutMs ?? overallTimeoutMs,
	);
	let hardDeadline = Math.max(
		startedAt + hardCeilingMs,
		input.minHardDeadlineMs ?? 0,
	);
	// Extend-only: while a gate is open keep the deadline ≥ now + active budget,
	// capped at the hard ceiling. It NEVER retracts, so a runner that waited long
	// on a gate and just got its answer is not cut off the instant the gate
	// closes — it keeps up to another active budget, bounded by the hard ceiling.
	// A run that never opens a gate keeps the plain active cap (MED-7 invariant).
	// MED-7 R3: never below the floor carried from a prior call's gate extension
	// (bounded by the hard ceiling), so a transport restart can't drop an
	// already-earned extension.
	let deadline = Math.min(
		hardDeadline,
		Math.max(startedAt + activeCapMs, input.minDeadlineMs ?? 0),
	);
	let phaseHold = input.phaseLifecycle?.getPhaseHold() ?? null;
	if (phaseHold) {
		const resumedAt = now();
		deadline = resumedAt + phaseHold.deadlineRemainingMs;
		hardDeadline = resumedAt + phaseHold.hardDeadlineRemainingMs;
		try {
			input.onBudgetRestored?.({
				deadlineMs: deadline,
				hardDeadlineMs: hardDeadline,
			});
		} catch {
			/* budget carry callback must not break the held goal */
		}
	}

	const turnIds = new Set<string>();
	let latestTokens = 0;
	let terminalSeen: GoalStatus | null = null;
	// R23 HIGH-2: lifecycle authority is armed only AFTER THIS run's setGoal is
	// confirmed. A late terminal from a PRIOR goal on the same thread (e.g. a
	// resumed thread) can arrive before our setGoal response — it must never
	// end the new run. Once armed, a notification that carries an objective must
	// also match ours (a second, generation-specific guard).
	let goalArmed = false;
	// R24: a goal object belongs to OUR goal generation when it carries no
	// objective (the daemon omitted it) or an objective equal to ours. Used by
	// both the notification guard and the poll fallback.
	const objectiveIsOurs = (
		goalObj: GoalNotification["goal"] | undefined,
	): boolean =>
		typeof goalObj?.objective !== "string" ||
		goalObj.objective === input.objective;
	const isThisGoal = (n: GoalNotification): boolean =>
		goalArmed && n.threadId === input.threadId && objectiveIsOurs(n.goal);

	client.setEvents({
		onNotification: (method, params) => {
			events?.onNotification?.(method, params);
			// R19 HIGH-1: only count turns for OUR thread (a daemon can host
			// multiple threads; a stray notification must not inflate the count).
			// R24 MEDIUM: and only AFTER our goal is armed — a prior goal's turn
			// emitted before our setGoal was confirmed must not inflate the count.
			if (
				goalArmed &&
				(method === "turn/started" || method === "turn/completed") &&
				notificationThreadId(params) === input.threadId
			) {
				const tid = extractTurnId(params);
				if (tid) turnIds.add(tid);
			}
		},
		onGoalUpdate: (n) => {
			events?.onGoalUpdate?.(n);
			// R19/R20/R23: a goal update is lifecycle AUTHORITY only when it
			// belongs to THIS run's goal generation — armed, our threadId, and
			// (when present) our objective. Another thread's update, an unscoped
			// one (no threadId), or a stale prior-goal terminal is diagnostics
			// only and must never set terminalSeen.
			if (!isThisGoal(n)) return;
			if (typeof n.goal?.tokensUsed === "number")
				latestTokens = n.goal.tokensUsed;
			const tid = extractTurnId(n);
			if (tid) turnIds.add(tid);
			if (n.goal?.status && isTerminalGoalStatus(n.goal.status)) {
				terminalSeen = n.goal.status;
			}
		},
	});

	// R21 HIGH-1: give every RPC only the run's REMAINING budget so no single
	// call can outlive the hard ceiling. `timedOut` and `failClose` both
	// fail-close with a GoalRunError — the run never returns a stale status.
	// MED-7: evaluated on EVERY budget read (setup + loop) so an open gate extends
	// the deadline uniformly. Single `now()` per call — the extend and the return
	// share the same instant.
	const remainingBudget = (): number => {
		const t = now();
		if (input.isWaiting?.()) {
			const extended = Math.min(hardDeadline, t + activeCapMs);
			if (extended > deadline) {
				deadline = extended;
				// MED-7 R3: report the monotonic extension so the runtime carries it
				// across a transport restart (a throwing handler must not break the run).
				try {
					input.onDeadlineExtended?.(deadline);
				} catch {
					/* best-effort */
				}
			}
		}
		return deadline - t;
	};
	const timedOut = (where: string): never => {
		throw new GoalRunError(
			`goal did not reach a terminal status within ${overallTimeoutMs}ms (${where})`,
			"timeout",
		);
	};
	const failClose = (msg: string): never => {
		throw new GoalRunError(msg, "transport_closed");
	};
	const phase = input.phaseLifecycle;
	const phaseControlPollIntervalMs = input.phaseControlPollIntervalMs ?? 15_000;
	const phaseControlRpcTimeoutMs = input.phaseControlRpcTimeoutMs ?? 30_000;
	let held = phaseHold !== null;
	const setGoalStatus = (status: "active" | "paused", timeoutMs: number) =>
		client.setGoal(
			{
				threadId: input.threadId,
				objective: input.objective,
				tokenBudget: input.tokenBudget,
				status,
			},
			timeoutMs,
		);
	const waitForPhaseActivity = async (): Promise<void> => {
		if (phase) {
			await phase.waitForActivity(phaseControlPollIntervalMs);
		} else {
			await sleep(phaseControlPollIntervalMs);
		}
	};
	const ensurePhasePaused = async (): Promise<void> => {
		if (!phase) throw new Error("phase lifecycle missing");
		while (true) {
			if (client.isClosed())
				failClose("daemon transport closed entering phase hold");
			try {
				await setGoalStatus("paused", phaseControlRpcTimeoutMs);
				goalArmed = true;
				const confirmed = await client.getGoal(
					input.threadId,
					phaseControlRpcTimeoutMs,
				);
				if (confirmed?.status === "paused" && objectiveIsOurs(confirmed)) {
					await phase.confirmHoldPaused();
					return;
				}
			} catch (error) {
				if (client.isClosed()) {
					failClose(
						`daemon transport closed entering phase hold: ${error instanceof Error ? error.message : error}`,
					);
				}
			}
			// Persistent pause rejection is fail-loud/held: the entering latch stays
			// durable and this zero-token local loop retries slowly.
			await waitForPhaseActivity();
		}
	};
	const enterPhaseHold = async (): Promise<void> => {
		if (!phase) throw new Error("phase lifecycle missing");
		if (!phaseHold) {
			const t = now();
			await phase.enterHold({
				deadlineRemainingMs: Math.max(0, deadline - t),
				hardDeadlineRemainingMs: Math.max(0, hardDeadline - t),
			});
			phaseHold = phase.getPhaseHold();
			if (!phaseHold) throw new Error("phase hold was not persisted");
		}
		await ensurePhasePaused();
		held = true;
		terminalSeen = null;
	};
	const reactivateWake = async (
		message: Extract<GoalPhaseObservation, { kind: "wake" }>["message"],
	): Promise<boolean> => {
		if (!phase || !phaseHold) return false;
		phase.markWakeStarted(message.id);
		try {
			await client.startTurn(
				input.threadId,
				`[phase-wake ${message.id}] ${message.content}`,
				phaseControlRpcTimeoutMs,
			);
			// Clear a complete emitted by the paused wake turn BEFORE active; a
			// notification emitted by the active transition remains authoritative.
			terminalSeen = null;
			await setGoalStatus("active", phaseControlRpcTimeoutMs);
			const restoredAt = now();
			deadline = restoredAt + phaseHold.deadlineRemainingMs;
			hardDeadline = restoredAt + phaseHold.hardDeadlineRemainingMs;
			try {
				input.onBudgetRestored?.({
					deadlineMs: deadline,
					hardDeadlineMs: hardDeadline,
				});
			} catch {
				/* budget carry callback must not break activation */
			}
		} catch (error) {
			if (client.isClosed()) {
				failClose(
					`daemon transport closed reactivating phase wake ${message.id}: ${error instanceof Error ? error.message : error}`,
				);
			}
			// Keep started queue row + latch. A retry carries the same stable id;
			// runner-side replay handling prevents duplicate external side effects.
			return false;
		}

		// The wake turn and active transition have already committed. From this
		// point forward, retry ONLY durable bookkeeping: replaying turn/start would
		// duplicate runner side effects for the same stable wake id. Both operations
		// are idempotent, so a partial success safely converges on the next local
		// control tick while the reactivated turn keeps running.
		for (;;) {
			try {
				phase.finishWake(message.id);
				await phase.leaveHold();
				break;
			} catch (error) {
				if (client.isClosed()) {
					failClose(
						`daemon transport closed finalizing phase wake ${message.id}: ${error instanceof Error ? error.message : error}`,
					);
				}
				await waitForPhaseActivity();
			}
		}
		phaseHold = null;
		held = false;
		return true;
	};

	try {
		// Setup RPCs count against the same deadline and are each bounded by the
		// remaining budget, so a hung setGoal/startTurn cannot blow the ceiling.
		try {
			if (held) {
				await ensurePhasePaused();
			} else {
				if (remainingBudget() <= 0) timedOut("before setGoal");
				await setGoalStatus("active", remainingBudget());
			}
			// R23 HIGH-2: only NOW is a terminal for this thread trustworthy as
			// OUR goal's terminal — the goal has been confirmed set.
			goalArmed = true;
			// FLY-1188 M4d: the goal is confirmed set → safe FLY-245 launch-commit
			// point. Swallow a throwing handler (it must never break the run).
			if (!held) {
				try {
					input.onGoalActive?.();
				} catch {
					/* launch-commit handler must not break the goal run */
				}
				if (remainingBudget() <= 0) timedOut("before startTurn");
				await client.startTurn(
					input.threadId,
					input.kickText ?? "Begin working toward the goal now.",
					remainingBudget(),
				);
			}
		} catch (err) {
			// R23 HIGH-1: a real terminal observed (via the notification stream)
			// BEFORE this setup RPC rejected — the daemon is allowed to stream a
			// terminal before the turn/start response — is a genuine terminal.
			// Honor it: fall through to the loop, which breaks on terminalSeen and
			// returns success, instead of failing the run.
			if (!terminalSeen) {
				if (err instanceof GoalRunError) throw err; // deadline already fired
				// R21 HIGH-1: classify the setup failure precisely instead of
				// always blaming the transport — transport death vs the overall
				// deadline vs a genuine RPC failure each get their own kind.
				if (client.isClosed())
					failClose(
						`daemon transport closed during goal setup: ${err instanceof Error ? err.message : err}`,
					);
				if (remainingBudget() <= 0) timedOut("during goal setup");
				throw new GoalRunError(
					`goal setup failed: ${err instanceof Error ? err.message : err}`,
					"setup_failed",
				);
			}
		}

		while (true) {
			if (held) {
				if (client.isClosed())
					failClose("daemon transport closed in phase hold");
				const observation = phase?.observe() ?? { kind: "unknown" as const };
				if (observation.kind === "wake") {
					if (await reactivateWake(observation.message)) continue;
				}
				await waitForPhaseActivity();
				continue;
			}
			// A terminal notification wins immediately, re-checked before every
			// blocking step so a real terminal is never masked by a later close.
			// (remainingBudget extends the deadline when a gate is open — MED-7.)
			if (terminalSeen) {
				if (phase && terminalSeen === "complete") {
					await enterPhaseHold();
					continue;
				}
				break;
			}
			if (client.isClosed()) failClose("daemon transport closed mid-run");
			if (remainingBudget() <= 0) timedOut("waiting for terminal status");

			await sleep(Math.min(pollIntervalMs, Math.max(0, remainingBudget())));

			// R21 HIGH-2: re-check terminalSeen the instant the sleep returns,
			// BEFORE getGoal. If a terminal notification arrived during the sleep
			// and the transport then closes in the same tick, skipping getGoal
			// keeps the real terminal status from being clobbered by a
			// transport_closed failure.
			if (terminalSeen) continue;
			// R22 HIGH: a close that landed during the sleep (with no terminal
			// seen before it) fails the run now — no need for a getGoal round-trip
			// to discover the dead socket.
			if (client.isClosed()) failClose("daemon transport closed mid-run");
			if (remainingBudget() <= 0) timedOut("waiting for terminal status");

			// Poll fallback: a missed terminal notification is still caught by
			// getGoal (goal state is authoritative + persisted). Bound the call by
			// the remaining budget; a reject on a CLOSED transport fails the run, a
			// transient reject on a still-open transport is tolerated.
			let goal: GoalNotification["goal"] | null = null;
			try {
				goal = await client.getGoal(input.threadId, remainingBudget());
			} catch (err) {
				// R21 HIGH-2: a terminal already observed takes precedence over any
				// getGoal failure — never fail-close over a real terminal status.
				if (terminalSeen) continue;
				if (client.isClosed())
					failClose(`getGoal failed on a closed transport: ${err}`);
				if (remainingBudget() <= 0) timedOut("polling goal status");
				// else: transient — loop and retry within the deadline
			}
			// R25 HIGH: a real terminal for OUR goal that arrived (via the
			// notification stream) while getGoal was in flight takes precedence
			// over the poll result — otherwise a poll that observed a
			// just-replaced goal would wrongly throw goal_replaced over a terminal
			// we already legitimately reached (R21 "first terminal wins").
			if (terminalSeen) continue;
			if (goal?.status) {
				// R24 HIGH: the poll reads the thread's CURRENT goal. If another
				// control end replaced our goal, its objective no longer matches
				// ours — our run's goal is gone, so fail closed rather than claim a
				// foreign goal's terminal. (No objective / a matching one is ours.)
				if (!objectiveIsOurs(goal)) {
					throw new GoalRunError(
						`goal on thread ${input.threadId} was replaced by another control end (objective no longer ours)`,
						"goal_replaced",
					);
				}
				if (typeof goal.tokensUsed === "number") latestTokens = goal.tokensUsed;
				if (isTerminalGoalStatus(goal.status)) {
					terminalSeen = goal.status;
				}
			}
		}

		return {
			// terminalSeen is guaranteed non-null here (the loop only breaks on it).
			status: terminalSeen as GoalStatus,
			tokensUsed: latestTokens,
			turns: turnIds.size,
			succeeded: terminalSeen === "complete",
		};
	} finally {
		// R21 MEDIUM: detach this run's listeners so late notifications can no
		// longer mutate a finished run's closure state.
		client.setEvents({});
	}
}

/** R19 HIGH-1: the thread a notification belongs to (top-level or nested). */
function notificationThreadId(params: unknown): string | undefined {
	if (typeof params !== "object" || params === null) return undefined;
	const p = params as { threadId?: unknown; thread?: { id?: unknown } };
	if (typeof p.threadId === "string") return p.threadId;
	if (p.thread && typeof p.thread.id === "string") return p.thread.id;
	return undefined;
}

/**
 * R19 MEDIUM: a turn id may arrive as top-level `turnId` OR nested
 * `turn.id` — accept both so multi-turn runs are not undercounted.
 */
function extractTurnId(params: unknown): string | undefined {
	if (typeof params !== "object" || params === null) return undefined;
	const p = params as { turnId?: unknown; turn?: { id?: unknown } };
	if (typeof p.turnId === "string") return p.turnId;
	if (p.turn && typeof p.turn.id === "string") return p.turn.id;
	return undefined;
}

/** Pull a thread id out of the various result shapes the daemon returns. */
function extractThreadId(result: unknown): string | null {
	if (typeof result !== "object" || result === null) return null;
	const r = result as {
		thread?: { id?: unknown };
		threadId?: unknown;
		id?: unknown;
	};
	if (r.thread && typeof r.thread.id === "string") return r.thread.id;
	if (typeof r.threadId === "string") return r.threadId;
	if (typeof r.id === "string") return r.id;
	return null;
}
