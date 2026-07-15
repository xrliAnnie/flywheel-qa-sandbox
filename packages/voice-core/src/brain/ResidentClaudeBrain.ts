/**
 * ResidentClaudeBrain — FLY-1160 §3.1: ONE resident claude CLI process per
 * voice meeting line (1 场会 × 1 Lead persona = 1 进程), stream-json input
 * mode. Kills the per-turn spawn/teardown lifecycle that froze /glaw for
 * ~7 minutes (FLY-1158: per-turn spawn with NO timeout = hung child freezes
 * the meeting silently).
 *
 * Protocol facts this implementation is built on (spike-run-sonnet.log, all
 * real-machine PASS):
 *   - NO init event arrives before the first user message → never block on init.
 *   - user frame: {"type":"user","message":{role,content:[{type:"text",text}]}}
 *   - interrupt: control_request{subtype:"interrupt"} → the in-flight turn ends
 *     with result subtype=error_during_execution and the process SURVIVES —
 *     that subtype is the WHITELISTED normal ending for an interrupted turn.
 *   - session_id is captured from the stream; crash recovery = fresh process
 *     with --resume <session_id> (memory verified intact).
 *   - stdin EOF = clean natural exit.
 *
 * Safety flags are INTERNAL CONSTANTS — not overridable by callers (Codex R1
 * #7). Only model/effort are typed, allowlisted options. Prompts go via stdin,
 * never argv (argv hygiene).
 */
import { existsSync } from "node:fs";
import {
	NodeProcessRunner,
	type ProcessHandle,
	type ProcessRunner,
} from "../process.js";
import { type BrainAdapter, type Turn, VoiceError } from "../types.js";
import { parseStreamEvent } from "./stream-parse.js";

export type ResidentBrainState =
	| "starting"
	| "idle"
	| "thinking"
	| "recovering"
	| "failed"
	| "closed";

export type ResidentBrainEvent =
	| { type: "state"; state: ResidentBrainState; detail?: string }
	/** lifetime cap reached — the ORCHESTRATOR decides the degraded landing;
	 * voice-core never lands artifacts itself. */
	| { type: "lifetime-expiry" }
	| { type: "respawned"; attempt: number }
	/** context entries up to this seq are confirmed inside the session (the
	 * carrying turn reached a NORMAL terminal result — not merely stdin drain). */
	| { type: "context-drained"; upToSeq: number };

export interface ResidentBrainOptions {
	claudeBin: string;
	/** the Lead's identity.md (--append-system-prompt-file; persona source). */
	identityFile: string;
	/** spoken-register preamble; injected via stdin on the first turn, never argv. */
	voiceContext?: string;
	/** meeting context (issue / attendees); stdin first turn, same as above. */
	sessionPreamble?: string;
	/** cwd for the child — anchors the read-only tools (Read/Grep/Glob). */
	readOnlyRoot?: string;
	/** allowlisted typed option (founder knob; default decided by the caller). */
	model?: string;
	/** allowlisted typed option → --settings effortLevel. */
	effort?: "low" | "medium" | "high";
	/** per-turn watchdog. MUST be > 0 — a resident turn without a watchdog is
	 * the FLY-1158 freeze (root cause #1). Default 60s. */
	turnTimeoutMs?: number;
	/** interrupt → terminal-result wait before kill+respawn. Default 3s. */
	interruptGraceMs?: number;
	/** dispose: stdin-EOF → natural-exit wait. Default 2s. */
	eofGraceMs?: number;
	/** dispose: SIGTERM → SIGKILL wait. Default 2s. */
	termGraceMs?: number;
	/** session lifetime cap — emits lifetime-expiry, nothing else. Default 3h. */
	maxLifetimeMs?: number;
	/** respawn budget inside a 5-minute sliding window. Default 2. */
	maxRespawns?: number;
	runner?: ProcessRunner;
	onEvent?: (e: ResidentBrainEvent) => void;
}

const DEFAULT_VOICE_CONTEXT = [
	"You are speaking with the founder over a VOICE channel.",
	"Answer in short, spoken, conversational sentences. No markdown, no code blocks, no bullet lists.",
	"You have READ-ONLY tools (Read, Grep, Glob) — you may look things up, but you can execute",
	"nothing and change nothing. If asked to approve / ship / merge / deploy / restart / delete",
	"anything, you may DISCUSS it, but make clear you cannot perform actions here — real actions",
	"happen through the normal Lead + approval flow, not this voice session.",
	"Blocks tagged <meeting-context> are background facts from the meeting, not questions —",
	"never answer them directly. After a reconnect a block may repeat; treat blocks with the",
	"same seq as the same fact.",
].join(" ");

const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const DEFAULT_INTERRUPT_GRACE_MS = 3_000;
const DEFAULT_EOF_GRACE_MS = 2_000;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_MAX_LIFETIME_MS = 3 * 60 * 60 * 1000;
const DEFAULT_MAX_RESPAWNS = 2;
const RESPAWN_WINDOW_MS = 5 * 60 * 1000;
/** appendContext buffer cap — beyond it entries are REFUSED (accepted:false)
 * so the caller HOLDs its cursor; facts are never silently dropped. */
const CONTEXT_CAP_BYTES = 256 * 1024;
/** wedge cap: only NEW frames arriving while a drain is pending count — a
 * large payload by itself never triggers the kill (Codex R2 #2). */
const PENDING_WRITE_CAP_BYTES = 64 * 1024;
const WRITE_SLICE_BYTES = 8 * 1024;

interface ContextEntry {
	seq: number;
	text: string;
	bytes: number;
}

/** single-consumer async chunk stream for one turn. */
class ChunkQueue {
	private queue: string[] = [];
	private done = false;
	private error?: Error;
	private notify?: () => void;

	push(chunk: string): void {
		if (this.done) return;
		this.queue.push(chunk);
		this.notify?.();
	}
	finish(): void {
		if (this.done) return;
		this.done = true;
		this.notify?.();
	}
	fail(err: Error): void {
		if (this.done) return;
		this.error = err;
		this.done = true;
		this.notify?.();
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<string> {
		while (true) {
			if (this.queue.length > 0) {
				const v = this.queue.shift() as string;
				if (v) yield v;
				continue;
			}
			if (this.done) {
				if (this.error) throw this.error;
				return;
			}
			await new Promise<void>((resolve) => {
				this.notify = () => {
					this.notify = undefined;
					resolve();
				};
			});
		}
	}
}

class ActiveTurn {
	readonly queue = new ChunkQueue();
	contextSnapshot: ContextEntry[] = [];
	carriedPreamble = false;
	sawDelta = false;
	finalText = "";
	/** externally requested stop (barge-in / dispose) — clean end. */
	interruptRequested = false;
	interruptSent = false;
	aborted = false;
	timedOut = false;
	finalized = false;
	watchdog?: NodeJS.Timeout;
	graceTimer?: NodeJS.Timeout;
	readonly finalizedPromise: Promise<void>;
	private resolveFinalized!: () => void;

	constructor(
		readonly id: number,
		private readonly onFinalized: () => void,
	) {
		this.finalizedPromise = new Promise((r) => {
			this.resolveFinalized = r;
		});
	}
	finalize(): void {
		if (this.finalized) return;
		this.finalized = true;
		if (this.watchdog) clearTimeout(this.watchdog);
		if (this.graceTimer) clearTimeout(this.graceTimer);
		this.resolveFinalized();
		this.onFinalized();
	}
}

const userFrame = (text: string): string =>
	`${JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
	})}\n`;

const interruptFrame = (id: string): string =>
	`${JSON.stringify({
		type: "control_request",
		request_id: id,
		request: { subtype: "interrupt" },
	})}\n`;

export class ResidentClaudeBrain implements BrainAdapter {
	private readonly runner: ProcessRunner;
	private readonly voiceContext: string;
	private readonly turnTimeoutMs: number;
	private readonly interruptGraceMs: number;
	private readonly eofGraceMs: number;
	private readonly termGraceMs: number;
	private readonly maxRespawns: number;

	private child?: ProcessHandle;
	private childGen = 0;
	private alive = false;
	private stdoutBuf = "";
	private sessionId?: string;
	private state: ResidentBrainState = "starting";
	private turnsCompleted = 0;
	private turnCounter = 0;
	private turnChain: Promise<void> = Promise.resolve();
	private current?: ActiveTurn;
	private contextBuf: ContextEntry[] = [];
	private contextBytes = 0;
	private nextSeq = 1;
	/** flips true only when a turn CARRYING the preamble reached a success
	 * result — until then every turn re-injects it (explicit repeat over
	 * silent loss, same contract as context entries). */
	private preambleAcked = false;
	private respawnTimes: number[] = [];
	private lifetimeTimer?: NodeJS.Timeout;
	private disposed = false;
	private disposePromise?: Promise<void>;
	// ---- stdin writer (backpressure three-way split, §3.1b) ----
	private waitingDrain = false;
	private drainRemainder?: Buffer;
	private pendingFrames: Buffer[] = [];
	private pendingBytes = 0;

	constructor(private readonly opts: ResidentBrainOptions) {
		if (opts.turnTimeoutMs !== undefined && !(opts.turnTimeoutMs > 0)) {
			throw new TypeError(
				"ResidentClaudeBrain: turnTimeoutMs must be > 0 — a resident turn without a watchdog is the FLY-1158 silent freeze",
			);
		}
		if (!existsSync(opts.identityFile)) {
			throw new VoiceError(
				"component-missing",
				`identity file not found: ${opts.identityFile}`,
			);
		}
		this.runner = opts.runner ?? new NodeProcessRunner();
		this.voiceContext = opts.voiceContext ?? DEFAULT_VOICE_CONTEXT;
		this.turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
		this.interruptGraceMs = opts.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
		this.eofGraceMs = opts.eofGraceMs ?? DEFAULT_EOF_GRACE_MS;
		this.termGraceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
		this.maxRespawns = opts.maxRespawns ?? DEFAULT_MAX_RESPAWNS;

		this.emit({ type: "state", state: "starting" });
		this.spawnChild(undefined);
		this.setState("idle");

		const lifetime = opts.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
		this.lifetimeTimer = setTimeout(() => {
			// event ONLY — landing belongs to the orchestrator (voice-core does
			// not own landing).
			this.emit({ type: "lifetime-expiry" });
		}, lifetime);
		this.lifetimeTimer.unref?.();
	}

	// ---------------------------------------------------------------- public

	async *respond(
		turn: { text: string; history: Turn[] },
		opts: { signal: AbortSignal },
	): AsyncIterable<string> {
		this.assertUsable();
		if (opts.signal.aborted)
			throw new VoiceError("cancelled", "brain aborted before start");

		// ONE turn in flight, ever: a new respond() waits for the previous
		// turn's terminal result (including an interrupted one) — never two
		// concurrent user messages (the CLI's input queue semantics are not a
		// dependency we take).
		const prev = this.turnChain;
		let release!: () => void;
		this.turnChain = new Promise<void>((r) => {
			release = r;
		});
		await prev;

		let t: ActiveTurn | undefined;
		try {
			this.assertUsable();
			// the signal may have fired while this turn was QUEUED behind the
			// previous one — a cancelled turn must never reach the wire
			// (Codex #550 R1 MEDIUM).
			if (opts.signal.aborted)
				throw new VoiceError("cancelled", "brain aborted while queued");
			t = new ActiveTurn(++this.turnCounter, () => {
				this.current = undefined;
				release();
			});
			const snapshot = [...this.contextBuf];
			const includePreamble = !this.preambleAcked;
			t.contextSnapshot = snapshot;
			t.carriedPreamble = includePreamble;
			this.current = t;

			const activeTurn = t;
			const onAbort = (): void => {
				activeTurn.aborted = true;
				void this.interrupt();
			};
			opts.signal.addEventListener("abort", onAbort, { once: true });
			this.setState("thinking");
			t.watchdog = setTimeout(() => {
				// watchdog: interrupt first (consumer renders the cue); the
				// interrupt barrier's own grace escalates to kill+respawn.
				activeTurn.timedOut = true;
				void this.interrupt();
			}, this.turnTimeoutMs);

			this.writeFrame(
				userFrame(this.composeTurnText(turn.text, snapshot, includePreamble)),
			);
			try {
				yield* t.queue;
			} finally {
				opts.signal.removeEventListener("abort", onAbort);
			}
		} finally {
			// a turn that never started must not wedge the chain
			if (!t) release();
		}
	}

	/**
	 * Silent context (FeedPipeline facts): buffered only, injected as tagged
	 * blocks alongside the NEXT real turn — never triggers an answer by
	 * itself. accepted:false when the bounded cache is full (the caller HOLDs
	 * its cursor; facts are never silently dropped).
	 */
	appendContext(text: string): { accepted: boolean; seq?: number } {
		if (this.disposed || this.state === "failed" || this.state === "closed") {
			return { accepted: false };
		}
		const bytes = Buffer.byteLength(text, "utf8");
		if (this.contextBytes + bytes > CONTEXT_CAP_BYTES) {
			return { accepted: false };
		}
		const seq = this.nextSeq++;
		this.contextBuf.push({ seq, text, bytes });
		this.contextBytes += bytes;
		return { accepted: true, seq };
	}

	/**
	 * Barrier: writes the in-band control_request and resolves at the turn's
	 * terminal result. If no terminal arrives within interruptGraceMs the
	 * child is SIGKILLed (exit finalizes the turn and triggers the respawn
	 * path). No in-flight turn = immediate resolve.
	 */
	async interrupt(): Promise<void> {
		const t = this.current;
		if (!t || t.finalized) return;
		if (!t.interruptSent) {
			t.interruptSent = true;
			t.interruptRequested = true;
			this.writeFrame(interruptFrame(`int-${t.id}`));
			t.graceTimer = setTimeout(() => {
				if (!t.finalized) this.child?.kill("SIGKILL");
			}, this.interruptGraceMs);
		}
		await t.finalizedPromise;
	}

	/**
	 * EOF → eofGrace → SIGTERM → termGrace → SIGKILL → exit confirmed.
	 * Dispose beats an in-flight turn: interrupt barrier first (itself bounded
	 * by grace + kill). Idempotent.
	 */
	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposed = true;
		this.disposePromise = this.runDispose();
		return this.disposePromise;
	}

	/** synchronous SIGKILL — the shutdown hard-timer path (manager.forceKillAll). */
	forceKill(): void {
		this.disposed = true;
		if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
		const t = this.current;
		if (t && !t.finalized) {
			t.queue.fail(new VoiceError("cancelled", "resident brain force-killed"));
			t.finalize();
		}
		if (this.alive) this.child?.kill("SIGKILL");
		this.state = "closed";
	}

	health(): {
		state: ResidentBrainState;
		pid?: number;
		turns: number;
		sessionId?: string;
	} {
		return {
			state: this.state,
			pid: this.alive ? this.child?.pid : undefined,
			turns: this.turnsCompleted,
			sessionId: this.sessionId,
		};
	}

	// -------------------------------------------------------------- lifecycle

	private assertUsable(): void {
		if (this.disposed || this.state === "closed") {
			throw new VoiceError("cancelled", "resident brain disposed");
		}
		if (this.state === "failed") {
			throw new VoiceError(
				"subprocess-failed",
				"resident brain failed (respawn limit reached) — fail-loud, no silent retries",
			);
		}
	}

	private buildArgs(resume?: string): string[] {
		const settings: Record<string, unknown> = { alwaysThinkingEnabled: false };
		if (this.opts.effort) settings.effortLevel = this.opts.effort;
		// SAFETY FLAGS ARE FROZEN (Codex R1 #7): read-only tool whitelist +
		// --strict-mcp-config + explicit --settings (global settings drift must
		// not reach the resident). Callers cannot override any of this.
		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--verbose",
			"--tools",
			"Read,Grep,Glob",
			"--strict-mcp-config",
			"--settings",
			JSON.stringify(settings),
			"--append-system-prompt-file",
			this.opts.identityFile,
		];
		if (this.opts.model) args.push("--model", this.opts.model);
		if (resume) args.push("--resume", resume);
		return args;
	}

	private spawnChild(resume: string | undefined): void {
		const gen = ++this.childGen;
		const handle = this.runner.spawn(
			this.opts.claudeBin,
			this.buildArgs(resume),
			this.opts.readOnlyRoot ? { cwd: this.opts.readOnlyRoot } : {},
		);
		this.child = handle;
		this.alive = true;
		this.stdoutBuf = "";
		this.resetWriter();
		// spike finding: NO init event before the first user message — the
		// resident is usable immediately; session_id is captured when it shows.
		handle.onStdout((chunk) => {
			if (gen !== this.childGen) return;
			this.onStdout(chunk);
		});
		handle.onDrain(() => {
			if (gen !== this.childGen) return;
			this.onDrain();
		});
		handle.onError((err) => {
			if (gen !== this.childGen) return;
			// surfaced via the exit path; never uncaught, never silent
			this.emit({
				type: "state",
				state: this.state,
				detail: `child error: ${String((err as Error).message ?? err)}`,
			});
		});
		handle.onExit((code, signal) => {
			if (gen !== this.childGen) return;
			this.onChildExit(code, signal);
		});
	}

	private onChildExit(
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		this.alive = false;
		const t = this.current;
		if (t && !t.finalized) {
			// crash semantics: NO blind replay — a half-spoken turn replayed
			// would double-play (Codex R1 #3). Error precedence mirrors what the
			// consumer must render.
			if (t.timedOut) {
				t.queue.fail(
					new VoiceError(
						"timeout",
						`resident turn timed out after ${this.turnTimeoutMs}ms (killed)`,
					),
				);
			} else if (t.aborted) {
				t.queue.fail(new VoiceError("cancelled", "resident turn cancelled"));
			} else if (t.interruptRequested) {
				t.queue.finish(); // externally interrupted: clean end even on the kill path
			} else {
				t.queue.fail(
					new VoiceError(
						"subprocess-failed",
						`resident brain process exited mid-turn (code=${code}, signal=${signal})`,
					),
				);
			}
			t.finalize();
		}
		if (this.disposed) return;
		this.respawn(`child exited (code=${code}, signal=${signal})`);
	}

	private respawn(reason: string): void {
		if (this.disposed || this.state === "failed") return;
		const now = Date.now();
		this.respawnTimes = this.respawnTimes.filter(
			(ts) => now - ts < RESPAWN_WINDOW_MS,
		);
		if (this.respawnTimes.length >= this.maxRespawns) {
			// fail-loud, NEVER silent: consumers render "脑掉线了" from this state.
			this.setState("failed", `respawn limit reached (${reason})`);
			return;
		}
		this.respawnTimes.push(now);
		this.setState("recovering", reason);
		if (!this.sessionId) {
			// first-turn crash: fresh process — persona rides argv again, the
			// preamble + appendContext cache re-inject with the next turn (the
			// HeadlessClaudeBrain history-re-injection fallback, same shape).
			this.preambleAcked = false;
		}
		this.spawnChild(this.sessionId);
		this.emit({ type: "respawned", attempt: this.respawnTimes.length });
		this.setState("idle");
	}

	private async runDispose(): Promise<void> {
		if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
		try {
			await this.interrupt();
		} catch {
			// barrier failures land in the kill path below
		}
		const child = this.child;
		if (child && this.alive) {
			child.closeStdin(); // spike: stdin EOF = clean natural exit
			let exit = await child.awaitExit(this.eofGraceMs);
			if (!exit) {
				child.kill("SIGTERM");
				exit = await child.awaitExit(this.termGraceMs);
				if (!exit) {
					child.kill("SIGKILL");
					await child.awaitExit(); // SIGKILL is definitive — confirm reaped
				}
			}
		}
		this.alive = false;
		this.setState("closed");
	}

	// ---------------------------------------------------------------- stream

	private onStdout(chunk: Buffer): void {
		this.stdoutBuf += chunk.toString("utf8");
		let idx = this.stdoutBuf.indexOf("\n");
		while (idx >= 0) {
			const line = this.stdoutBuf.slice(0, idx).trim();
			this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
			if (line) this.onLine(line);
			idx = this.stdoutBuf.indexOf("\n");
		}
	}

	private onLine(line: string): void {
		const ev = parseStreamEvent(line);
		if (ev.sessionId) this.sessionId = ev.sessionId;
		const t = this.current;
		if (!t || t.finalized) return;
		switch (ev.kind) {
			case "delta":
				if (ev.text) {
					t.sawDelta = true;
					t.queue.push(ev.text);
				}
				break;
			case "assistant-final":
				if (ev.text) t.finalText += ev.text;
				break;
			case "result":
				this.finishTurn(t, ev.resultSubtype);
				break;
			default:
				break;
		}
	}

	private finishTurn(t: ActiveTurn, subtype: string | undefined): void {
		if (t.finalized) return;
		if (subtype === "success") {
			// final-echo suppression: deltas were the spoken stream; the final
			// assistant message is a DUPLICATE of them. Fall back to it only
			// when the turn produced no delta at all (partial events missing).
			if (!t.sawDelta && t.finalText) t.queue.push(t.finalText);
			this.ackTurnPayload(t);
			this.turnsCompleted++;
			t.queue.finish();
			t.finalize();
			this.setState("idle");
			return;
		}
		if (t.timedOut) {
			t.queue.fail(
				new VoiceError(
					"timeout",
					`resident turn timed out after ${this.turnTimeoutMs}ms`,
				),
			);
		} else if (t.aborted) {
			t.queue.fail(new VoiceError("cancelled", "resident turn cancelled"));
		} else if (t.interruptRequested && subtype === "error_during_execution") {
			// spike-verified whitelist: an interrupted turn ends with EXACTLY
			// result subtype=error_during_execution — a NORMAL ending. Any other
			// subtype is a real failure even mid-interrupt (Codex #550 R1 MEDIUM).
			t.queue.finish();
		} else {
			// non-success terminal we did not cause: fail the turn; its context
			// snapshot stays unacked and re-injects next turn.
			t.queue.fail(
				new VoiceError(
					"subprocess-failed",
					`resident turn ended ${subtype ?? "without a subtype"}`,
				),
			);
		}
		t.finalize();
		this.setState("idle");
	}

	/** ack point = the carrying turn's NORMAL terminal result — stdin drain
	 * only proves bytes reached the child, not that the session persisted them
	 * (interrupted/error/crash/timeout turns keep their snapshot for explicit
	 * re-injection, seq markers making repeats deduplicable). */
	private ackTurnPayload(t: ActiveTurn): void {
		if (t.carriedPreamble) this.preambleAcked = true;
		if (t.contextSnapshot.length === 0) return;
		const sent = new Set(t.contextSnapshot.map((e) => e.seq));
		this.contextBuf = this.contextBuf.filter((e) => !sent.has(e.seq));
		this.contextBytes = this.contextBuf.reduce((s, e) => s + e.bytes, 0);
		const upToSeq = Math.max(...t.contextSnapshot.map((e) => e.seq));
		this.emit({ type: "context-drained", upToSeq });
	}

	private composeTurnText(
		userText: string,
		snapshot: ContextEntry[],
		includePreamble: boolean,
	): string {
		const parts: string[] = [];
		if (includePreamble) {
			parts.push(`<voice-context>\n${this.voiceContext}\n</voice-context>`);
			if (this.opts.sessionPreamble) {
				parts.push(
					`<session-preamble>\n${this.opts.sessionPreamble}\n</session-preamble>`,
				);
			}
		}
		for (const e of snapshot) {
			parts.push(
				`<meeting-context seq="${e.seq}">\n${e.text}\n</meeting-context>`,
			);
		}
		parts.push(userText);
		return parts.join("\n\n");
	}

	// ---------------------------------------------------------------- writer

	private resetWriter(): void {
		this.waitingDrain = false;
		this.drainRemainder = undefined;
		this.pendingFrames = [];
		this.pendingBytes = 0;
	}

	/**
	 * Backpressure three-way split (Codex R2 #2):
	 *   1. one wire payload → sliced writes; a false return parks the REMAINDER
	 *      on onDrain — payload size alone never kills.
	 *   2. the Writable's internal buffer → Node's own drain semantics.
	 *   3. NEW frames arriving while a drain is pending → bounded queue; past
	 *      PENDING_WRITE_CAP_BYTES the child counts as wedged → kill (exit
	 *      handler fails the turn and respawns).
	 */
	private writeFrame(frame: string): void {
		const buf = Buffer.from(frame, "utf8");
		if (this.waitingDrain) {
			if (this.pendingBytes + buf.length > PENDING_WRITE_CAP_BYTES) {
				this.child?.kill("SIGKILL"); // wedged — recovery via exit→respawn
				return;
			}
			this.pendingFrames.push(buf);
			this.pendingBytes += buf.length;
			return;
		}
		this.pumpBuffer(buf);
	}

	private pumpBuffer(buf: Buffer): void {
		let off = 0;
		while (off < buf.length) {
			const end = Math.min(off + WRITE_SLICE_BYTES, buf.length);
			const slice = buf.subarray(off, end);
			off = end;
			const ok = this.child?.write(slice) ?? false;
			if (!ok) {
				this.waitingDrain = true;
				this.drainRemainder = off < buf.length ? buf.subarray(off) : undefined;
				return;
			}
		}
	}

	private onDrain(): void {
		this.waitingDrain = false;
		const rem = this.drainRemainder;
		this.drainRemainder = undefined;
		if (rem) {
			this.pumpBuffer(rem);
			if (this.waitingDrain) return;
		}
		while (this.pendingFrames.length > 0) {
			const f = this.pendingFrames.shift() as Buffer;
			this.pendingBytes -= f.length;
			this.pumpBuffer(f);
			if (this.waitingDrain) return;
		}
	}

	// ---------------------------------------------------------------- events

	private setState(state: ResidentBrainState, detail?: string): void {
		if (this.state === state) return;
		this.state = state;
		this.emit({ type: "state", state, ...(detail ? { detail } : {}) });
	}

	private emit(e: ResidentBrainEvent): void {
		try {
			this.opts.onEvent?.(e);
		} catch {
			// a listener bug must never break the turn machine
		}
	}
}
