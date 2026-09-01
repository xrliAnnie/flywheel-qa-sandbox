/**
 * FLY-224 Phase 4b — CodexTurnExecutor: the real `TurnExecutor` (plan §6.1/§6.2)
 * that wraps a `CodexLeadProcess` (Phase 1) so the `LeadInputRouter` (Phase 4a)
 * drives real app-server turns.
 *
 * Responsibilities:
 *   - `startTurn` → `turn/start` (text input + correlation id as
 *     `clientUserMessageId`, Phase 0A §7); returns the real turnId.
 *   - accumulate ONLY this turn's ASSISTANT-message deltas (not tool/command/
 *     reasoning output) into the output buffer, filtered by thread + turn id;
 *     resolve `awaitCompletion` on `turn/completed` ONLY when its status is a
 *     success — `interrupted`/`failed` reject (router → ambiguous), never send a
 *     partial buffer as success (Codex Phase-4b review HIGH-2).
 *   - `reconcile` → `thread/read(includeTurns:true)` + defensive parse: report
 *     `completed` only with a real turnId + success status + real output.
 *
 * Per the Phase-4b guardrail: implemented + UNIT-TESTED ONLY (CodexLeadProcess
 * injected; tests drive a fake child). Never starts a real Codex Lead; real E2E
 * is Phase 7 (QA, isolated env).
 */

import type { TurnExecutor } from "./LeadInputRouter.js";

interface ActiveTurn {
	turnId?: string;
	buffer: string;
	resolve: (r: { output: string }) => void;
	reject: (e: Error) => void;
	settled: boolean;
	promise: Promise<{ output: string }>;
}

/** The structural process surface the executor needs (FLY-259 PR-D): the
 * concrete CodexLeadProcess satisfies it unchanged; the TUI runtime passes a
 * demux FACADE so foreign (founder-terminal) turn events never reach the
 * executor (TurnDemux is the first fence, belongsToTurn stays the second). */
export interface CodexProcessLike {
	on(
		event: "notification",
		cb: (method: string, params: unknown) => void,
	): void;
	on(event: "turnCompleted", cb: (params: unknown) => void): void;
	on(
		event: "exit",
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
	startTurn(args: {
		threadId: string;
		input: unknown[];
		clientUserMessageId?: string;
	}): Promise<string | undefined>;
	request(
		method: string,
		params?: unknown,
	): Promise<{
		result?: unknown;
		error?: { code: number; message: string; data?: unknown };
	}>;
}

export interface CodexTurnExecutorOptions {
	process: CodexProcessLike;
	threadId: string;
	logger?: { warn: (m: string, c?: unknown) => void };
	lifecycle?: CodexTurnLifecycleObserver;
}

export interface CodexTurnLifecycleObserver {
	turnStarted(turnId: string): void;
	turnFinished(
		turnId: string,
		status: "completed" | "failed" | "interrupted",
	): void;
}

export class CodexTurnExecutor implements TurnExecutor {
	private readonly proc: CodexProcessLike;
	private readonly threadId: string;
	private readonly logger: { warn: (m: string, c?: unknown) => void };
	private readonly lifecycle?: CodexTurnLifecycleObserver;
	private active: ActiveTurn | null = null;

	constructor(opts: CodexTurnExecutorOptions) {
		this.proc = opts.process;
		this.threadId = opts.threadId;
		this.logger = opts.logger ?? { warn: () => {} };
		this.lifecycle = opts.lifecycle;

		this.proc.on("notification", (method, params) => {
			const a = this.active;
			if (!a || a.settled) return;
			// Only the ASSISTANT message text delta — NOT tool/command/reasoning
			// output deltas (HIGH-1). Filtered by thread/turn id.
			if (isAssistantDelta(method) && this.belongsToTurn(a, params)) {
				a.buffer += extractDeltaText(params);
			}
		});

		this.proc.on("turnCompleted", (params) => {
			const a = this.active;
			if (!a || a.settled) return;
			if (!this.belongsToTurn(a, params)) return;
			// Real protocol: TurnCompletedNotification = { threadId, turn:{id,status} }
			// with status ∈ completed|interrupted|failed|inProgress. The schema
			// REQUIRES turn.status, so resolve as success ONLY on "completed";
			// anything else — interrupted/failed/inProgress AND a missing/unparseable
			// status — rejects, so the router goes ambiguous and never sends a partial
			// buffer as success (Codex Phase-4b review R3 HIGH).
			const status = completionStatus(params);
			if (status !== "completed") {
				this.settleReject(
					a,
					new Error(`turn status ${status ?? "missing"}`),
					status === "interrupted" ? "interrupted" : "failed",
				);
				return;
			}
			this.settleResolve(a, { output: a.buffer });
		});

		this.proc.on("exit", () => {
			const a = this.active;
			if (a && !a.settled) {
				this.settleReject(a, new Error("codex app-server exited mid-turn"));
			}
		});
	}

	async startTurn(args: {
		threadId: string;
		input: string;
		clientUserMessageId: string;
	}): Promise<string> {
		if (this.active && !this.active.settled) {
			throw new Error("CodexTurnExecutor: a turn is already active");
		}
		let resolve!: (r: { output: string }) => void;
		let reject!: (e: Error) => void;
		const promise = new Promise<{ output: string }>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		// Guard consumer: a rejection settled before awaitCompletion attaches must
		// NOT surface as an unhandled rejection (HIGH-3). awaitCompletion awaits
		// the same promise and still observes the rejection.
		promise.catch(() => {});
		const turn: ActiveTurn = {
			buffer: "",
			resolve,
			reject,
			settled: false,
			promise,
		};
		this.active = turn;
		try {
			const turnId = await this.proc.startTurn({
				threadId: args.threadId,
				input: [{ type: "text", text: args.input }],
				clientUserMessageId: args.clientUserMessageId,
			});
			if (!turnId) throw new Error("turn/start returned no turnId");
			turn.turnId = turnId;
			this.observe(() => this.lifecycle?.turnStarted(turnId));
			return turnId;
		} catch (err) {
			// Settle the (guarded) completion promise so nothing is left pending,
			// then clear the active turn.
			this.settleReject(
				turn,
				err instanceof Error ? err : new Error(String(err)),
			);
			if (this.active === turn) this.active = null;
			throw err;
		}
	}

	async awaitCompletion(turnId: string): Promise<{ output: string }> {
		const a = this.active;
		if (!a || a.turnId !== turnId) {
			throw new Error(`awaitCompletion: no active turn matching ${turnId}`);
		}
		try {
			return await a.promise;
		} finally {
			if (this.active === a) this.active = null;
		}
	}

	async reconcile(clientCorrelationId: string): Promise<{
		exists: boolean;
		completed: boolean;
		turnId?: string;
		output?: string;
	}> {
		const res = await this.proc.request("thread/read", {
			threadId: this.threadId,
			includeTurns: true,
		});
		if (res.error) {
			this.logger.warn("reconcile: thread/read error", res.error);
			return { exists: false, completed: false };
		}
		return parseReconcile(res.result, clientCorrelationId);
	}

	// ── internals ─────────────────────────────────────────────────────────────

	private belongsToTurn(a: ActiveTurn, params: unknown): boolean {
		const p = params as
			| { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } }
			| undefined;
		// If the notification names a different thread, it isn't ours.
		if (typeof p?.threadId === "string" && p.threadId !== this.threadId) {
			return false;
		}
		// turnId lives top-level on deltas (AgentMessageDeltaNotification.turnId)
		// but under `turn.id` on TurnCompletedNotification — accept either.
		const notifTurnId =
			typeof p?.turnId === "string"
				? p.turnId
				: typeof p?.turn?.id === "string"
					? p.turn.id
					: undefined;
		if (
			a.turnId !== undefined &&
			notifTurnId !== undefined &&
			notifTurnId !== a.turnId
		) {
			return false;
		}
		return true;
	}

	private settleResolve(a: ActiveTurn, r: { output: string }): void {
		if (a.settled) return;
		a.settled = true;
		if (a.turnId)
			this.observe(() => this.lifecycle?.turnFinished(a.turnId!, "completed"));
		a.resolve(r);
	}

	private settleReject(
		a: ActiveTurn,
		e: Error,
		status: "failed" | "interrupted" = "failed",
	): void {
		if (a.settled) return;
		a.settled = true;
		if (a.turnId)
			this.observe(() => this.lifecycle?.turnFinished(a.turnId!, status));
		a.reject(e);
	}

	private observe(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.logger.warn("Raya lifecycle observer failed (turn continues)", {
				err: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** True only for the assistant message text delta (not tool/command/reasoning). */
function isAssistantDelta(method: string): boolean {
	const m = method.toLowerCase();
	if (!m.includes("delta")) return false;
	// Exclude tool/command/reasoning/file/output deltas.
	if (
		m.includes("command") ||
		m.includes("exec") ||
		m.includes("reasoning") ||
		m.includes("file") ||
		m.includes("output") ||
		m.includes("plan") ||
		m.includes("diff")
	) {
		return false;
	}
	return m.includes("agentmessage") || m === "agentmessagedelta";
}

function extractDeltaText(params: unknown): string {
	const p = params as { delta?: unknown; text?: unknown } | undefined;
	if (typeof p?.delta === "string") return p.delta;
	if (typeof p?.text === "string") return p.text;
	return "";
}

function completionStatus(params: unknown): string | undefined {
	// Real protocol: status is ONLY at `params.turn.status` (a string enum). Read
	// strictly that path — no top-level fallback, so a malformed notification with
	// a misplaced top-level `status` can't spoof success (Codex Phase-4b R4).
	const p = params as { turn?: { status?: unknown } } | undefined;
	const s = p?.turn?.status;
	return typeof s === "string" ? s.toLowerCase() : undefined;
}

/**
 * Best-effort parse of a `thread/read` result to locate the turn whose user
 * message carries `clientId === clientCorrelationId`. Reports `completed: true`
 * ONLY when a real turnId, a success status, AND real output are all present
 * (Codex Phase-4b review HIGH-2/MED-5) — recovery must never re-send a partial
 * or claim completion it can't prove.
 */
export function parseReconcile(
	result: unknown,
	clientCorrelationId: string,
): { exists: boolean; completed: boolean; turnId?: string; output?: string } {
	const r = result as
		| { thread?: { turns?: unknown[] }; turns?: unknown[] }
		| undefined;
	const turns = r?.thread?.turns ?? r?.turns;
	if (!Array.isArray(turns)) return { exists: false, completed: false };
	for (const t of turns) {
		if (t === null || typeof t !== "object") continue;
		const turn = t as {
			id?: string;
			turnId?: string;
			status?: { type?: string } | string;
			items?: unknown[];
			input?: unknown[];
			output?: unknown;
		};
		const rawItems = [
			...(Array.isArray(turn.items) ? turn.items : []),
			...(Array.isArray(turn.input) ? turn.input : []),
		];
		const items = rawItems.filter(
			(it): it is Record<string, unknown> =>
				it !== null && typeof it === "object",
		);
		const matches = items.some(
			(it) =>
				it.clientId === clientCorrelationId ||
				it.clientUserMessageId === clientCorrelationId,
		);
		if (!matches) continue;
		const turnId = turn.turnId ?? turn.id;
		const statusType =
			typeof turn.status === "string" ? turn.status : turn.status?.type;
		const success =
			statusType === "completed" ||
			(statusType === "idle" && turnId !== undefined);
		const output = extractAssistantText(items, turn.output);
		// Completed requires ALL of: real turnId + success status + real output.
		const completed = Boolean(turnId) && success && output !== undefined;
		return {
			exists: true,
			completed,
			...(turnId ? { turnId } : {}),
			...(output !== undefined ? { output } : {}),
		};
	}
	return { exists: false, completed: false };
}

function extractAssistantText(
	items: Array<Record<string, unknown>>,
	fallback: unknown,
): string | undefined {
	const parts: string[] = [];
	for (const it of items) {
		if (
			it.role === "assistant" ||
			it.type === "agentMessage" ||
			it.type === "assistantMessage"
		) {
			if (typeof it.text === "string") parts.push(it.text);
			else if (typeof it.content === "string") parts.push(it.content);
		}
	}
	if (parts.length > 0) return parts.join("");
	if (typeof fallback === "string") return fallback;
	return undefined;
}
