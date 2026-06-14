/**
 * FLY-224 Phase 1 — CodexLeadProcess: the app-server stdio JSON-RPC client for a
 * Codex Lead.
 *
 * This is the protocol client only (plan §6.1). It owns one `codex app-server`
 * child over stdio (newline-delimited JSON-RPC), the initialize/initialized
 * handshake, the thread/turn lifecycle (thread/start|resume, turn/start|steer),
 * and the robustness contract frozen in Phase 0A §1/§5:
 *   - per-request timeout (reject, never hang),
 *   - malformed stdout line → log + skip (never crash the loop),
 *   - server-initiated request handling: unknown method → bounded JSON-RPC error
 *     (never silent hang); known methods are dispatched to an injectable handler,
 *   - stderr captured (bounded) for diagnostics,
 *   - graceful shutdown (stdin end → SIGTERM after a kill timeout),
 *   - child exit rejects all pending requests (no stranded promises).
 *
 * The actual argv (`codex app-server --strict-config -c …`) and the sanitized
 * child env / executable resolution are built by the canonical
 * `buildCodexLeadMcpArgv` (plan §6.7a, Phase 5) and injected here via
 * `spawnChild`. Phase 1 keeps `spawnChild` injectable so unit tests drive a fake
 * child and integration tests use the real binary.
 *
 * NOT in Phase 1: the durable journal (§6.2, Phase 3), the Discord gateway
 * (§6.3, Phase 4), health probe/supervisor (§6.8, Phase 6).
 */

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** Bounded JSON-RPC error codes we emit for server-initiated requests. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;

/**
 * Minimal child-process transport. The real factory spawns `codex app-server`;
 * tests inject a fake. CodexLeadProcess does its own line buffering on raw
 * stdout chunks (so partial/garbled chunks are handled here, not in the spawn).
 */
export interface ChildTransport {
	/** Write a raw string to the child's stdin. */
	writeStdin(data: string): void;
	/** End stdin (graceful shutdown step 1). */
	endStdin(): void;
	/** Force-terminate the child. */
	kill(signal?: NodeJS.Signals): void;
	/** Subscribe to raw stdout chunks (NOT line-split). */
	onStdout(cb: (chunk: string) => void): void;
	/** Subscribe to raw stderr chunks. */
	onStderr(cb: (chunk: string) => void): void;
	/** Subscribe to process exit. */
	onExit(
		cb: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
}

export interface ServerRequest {
	id: number;
	method: string;
	params?: unknown;
}

/**
 * Handles a server-initiated request and returns the `result` to send back, or
 * throws to send a bounded error. Phase 5 wires the real per-method matrix; in
 * Phase 1 the default rejects everything (fail-closed) and unknown methods get a
 * method-not-found error regardless.
 */
export type ServerRequestHandler = (
	req: ServerRequest,
) => Promise<unknown> | unknown;

export interface CodexLeadProcessEvents {
	/** Streaming agent message / reasoning deltas (method + params, opaque). */
	notification: (method: string, params: unknown) => void;
	/** A turn finished (turn/completed). */
	turnCompleted: (params: unknown) => void;
	/** stderr line (bounded buffer also retained on the instance). */
	stderr: (chunk: string) => void;
	/** Child exited. */
	exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface CodexLeadProcessOptions {
	/** Factory that spawns the child. Injected for tests. */
	spawnChild: () => ChildTransport;
	/** Per-request timeout (ms). Default 60_000. */
	requestTimeoutMs?: number;
	/** Grace period between stdin end and SIGTERM on stop() (ms). Default 50. */
	shutdownGraceMs?: number;
	/** Max stderr bytes retained for diagnostics. Default 64 KiB. */
	maxStderrBytes?: number;
	/** clientInfo for initialize. */
	clientInfo?: { name: string; version: string };
	/**
	 * Optional handler for server-initiated requests. Only invoked for methods
	 * in `knownServerMethods`; any method NOT in that set gets an immediate
	 * bounded method-not-found error (the handler is never given a chance to
	 * hang on an unknown method — CR HIGH-2). Phase 5 wires the real matrix.
	 */
	onServerRequest?: ServerRequestHandler;
	/**
	 * Allowlist of server-request methods the handler is permitted to handle.
	 * Default empty → every server request is "unknown" → bounded
	 * method-not-found (fail-closed). Phase 5 supplies the real set.
	 */
	knownServerMethods?: Iterable<string>;
	/** Injected logger (default: console). */
	logger?: {
		warn: (msg: string, ctx?: unknown) => void;
		error: (msg: string, ctx?: unknown) => void;
	};
	/** Injected setTimeout/clearTimeout for deterministic tests. */
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

interface PendingRequest {
	resolve: (res: JsonRpcResponse) => void;
	reject: (err: Error) => void;
	method: string;
	timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 50;
const DEFAULT_MAX_STDERR = 64 * 1024;

/**
 * Error thrown when a request times out or the process dies before responding.
 */
export class CodexLeadProcessError extends Error {
	constructor(
		message: string,
		readonly kind: "timeout" | "exited" | "protocol" | "closed",
		/**
		 * The JSON-RPC error code when `kind === "protocol"` (undefined otherwise).
		 * Preserved structurally so callers can branch on the exact code rather
		 * than substring-matching the message (FLY-259 PR-D review HIGH-3: the
		 * turnless self-heal must gate on `-32600`, not on a fragile message
		 * substring, or an unrelated resume failure would silently drop a thread).
		 */
		readonly rpcCode?: number,
	) {
		super(message);
		this.name = "CodexLeadProcessError";
	}
}

export class CodexLeadProcess {
	private child: ChildTransport | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private stdoutBuffer = "";
	// Stored as a Buffer so the cap is byte-true (CR R2 LOW): re-encoding a
	// string truncated mid-multibyte char would grow via replacement chars and
	// exceed the cap. The getter does the read-only toString.
	private stderrBuffer = Buffer.alloc(0);
	private started = false;
	private closed = false;
	private exitInfo: {
		code: number | null;
		signal: NodeJS.Signals | null;
	} | null = null;
	// Loosely-typed internal store (public on/off/emit keep the typed surface).
	private readonly listeners = new Map<
		keyof CodexLeadProcessEvents,
		Set<(...args: unknown[]) => void>
	>();

	private readonly opts: Required<
		Omit<
			CodexLeadProcessOptions,
			"onServerRequest" | "clientInfo" | "knownServerMethods"
		>
	> & {
		onServerRequest?: ServerRequestHandler;
		clientInfo: { name: string; version: string };
	};

	/** Allowlist of server-request methods the handler may handle (CR HIGH-2). */
	private readonly knownServerMethods: ReadonlySet<string>;

	constructor(options: CodexLeadProcessOptions) {
		this.opts = {
			spawnChild: options.spawnChild,
			requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
			shutdownGraceMs: options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
			maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR,
			clientInfo: options.clientInfo ?? {
				name: "flywheel-codex-lead",
				version: "0.0.1",
			},
			onServerRequest: options.onServerRequest,
			logger: options.logger ?? {
				warn: (m, c) => console.warn(`[CodexLeadProcess] ${m}`, c ?? ""),
				error: (m, c) => console.error(`[CodexLeadProcess] ${m}`, c ?? ""),
			},
			setTimeoutFn: options.setTimeoutFn ?? setTimeout,
			clearTimeoutFn: options.clearTimeoutFn ?? clearTimeout,
		};
		this.knownServerMethods = new Set(options.knownServerMethods ?? []);
	}

	// ── event emitter (typed, minimal) ──────────────────────────────────────

	on<K extends keyof CodexLeadProcessEvents>(
		event: K,
		cb: CodexLeadProcessEvents[K],
	): void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(cb as (...args: unknown[]) => void);
	}

	off<K extends keyof CodexLeadProcessEvents>(
		event: K,
		cb: CodexLeadProcessEvents[K],
	): void {
		this.listeners.get(event)?.delete(cb as (...args: unknown[]) => void);
	}

	private emit<K extends keyof CodexLeadProcessEvents>(
		event: K,
		...args: Parameters<CodexLeadProcessEvents[K]>
	): void {
		for (const cb of this.listeners.get(event) ?? []) {
			try {
				cb(...args);
			} catch (err) {
				// Listener failures must not break the protocol loop.
				this.opts.logger.error("listener threw", {
					event,
					err: (err as Error).message,
				});
			}
		}
	}

	/** Bounded stderr captured so far (diagnostics). */
	get stderr(): string {
		return this.stderrBuffer.toString("utf8");
	}

	/** Retained stderr byte length (≤ maxStderrBytes) — for byte-cap assertions. */
	get stderrByteLength(): number {
		return this.stderrBuffer.length;
	}

	get hasExited(): boolean {
		return this.exitInfo !== null;
	}

	// ── lifecycle ───────────────────────────────────────────────────────────

	/** Spawn the child, wire streams, run the initialize/initialized handshake. */
	async start(): Promise<void> {
		if (this.started) throw new Error("CodexLeadProcess already started");
		this.started = true;
		const child = this.opts.spawnChild();
		this.child = child;
		child.onStdout((chunk) => this.onStdoutChunk(chunk));
		child.onStderr((chunk) => this.onStderrChunk(chunk));
		child.onExit((code, signal) => this.onChildExit(code, signal));

		const initRes = await this.request("initialize", {
			clientInfo: this.opts.clientInfo,
			capabilities: {},
		});
		// CR HIGH-1: an initialize ERROR must NOT be treated as a successful
		// handshake — do not send `initialized`, surface the failure.
		this.throwOnError(initRes, "initialize");
		this.notify("initialized", {});
	}

	/** Graceful shutdown: end stdin, then SIGTERM after the grace period. */
	async stop(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const child = this.child;
		if (!child) return;
		try {
			child.endStdin();
		} catch {
			// already gone
		}
		if (!this.exitInfo) {
			const t = this.opts.setTimeoutFn(() => {
				try {
					child.kill("SIGTERM");
				} catch {
					// already gone
				}
			}, this.opts.shutdownGraceMs);
			// Do not keep the event loop alive for this timer.
			(t as unknown as { unref?: () => void }).unref?.();
		}
		// Reject anything still pending — caller must not hang on shutdown.
		this.rejectAllPending(
			new CodexLeadProcessError("process stopping", "closed"),
		);
	}

	// ── request / notify ─────────────────────────────────────────────────────

	/** Send a JSON-RPC request; resolves with the response (result or error). */
	request(method: string, params?: unknown): Promise<JsonRpcResponse> {
		if (this.closed || this.exitInfo) {
			return Promise.reject(
				new CodexLeadProcessError(
					`cannot request "${method}": process ${this.exitInfo ? "exited" : "closed"}`,
					this.exitInfo ? "exited" : "closed",
				),
			);
		}
		const id = this.nextId++;
		const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		return new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer = this.opts.setTimeoutFn(() => {
				this.pending.delete(id);
				reject(
					new CodexLeadProcessError(`request "${method}" timed out`, "timeout"),
				);
			}, this.opts.requestTimeoutMs);
			(timer as unknown as { unref?: () => void }).unref?.();
			this.pending.set(id, { resolve, reject, method, timer });
			// CR MED-4: if the write itself throws, drop the pending entry + timer
			// immediately and reject — do not leave it stranded until timeout.
			try {
				this.writeMessage(payload);
			} catch (err) {
				this.pending.delete(id);
				this.opts.clearTimeoutFn(timer);
				reject(
					new CodexLeadProcessError(
						`failed to write request "${method}": ${(err as Error).message}`,
						this.exitInfo ? "exited" : "closed",
					),
				);
			}
		});
	}

	/** Send a JSON-RPC notification (no id, no response expected). */
	notify(method: string, params?: unknown): void {
		if (this.closed || this.exitInfo) return;
		this.writeMessage({ jsonrpc: "2.0", method, params });
	}

	// ── thread / turn convenience (typed-lite wrappers) ──────────────────────

	async startThread(params?: Record<string, unknown>): Promise<string> {
		const res = await this.request("thread/start", params ?? {});
		return this.extractThreadId(res);
	}

	async resumeThread(
		threadId: string,
		params?: Record<string, unknown>,
	): Promise<string> {
		const res = await this.request("thread/resume", { threadId, ...params });
		return this.extractThreadId(res) || threadId;
	}

	/**
	 * FLY-245 Phase B: like `startThread`/`resumeThread` but also surfaces the raw
	 * result so the runtime can extract + HARD-ASSERT the policy echo (sandbox /
	 * cwd / runtimeWorkspaceRoots / approvalPolicy / cliVersion) for a write-capable
	 * Lead (plan §3.4). `extractThreadId` still throws on a protocol error / missing
	 * id, so a failed start never returns a result here.
	 */
	async startThreadWithResult(
		params?: Record<string, unknown>,
	): Promise<{ id: string; result: unknown }> {
		const res = await this.request("thread/start", params ?? {});
		const id = this.extractThreadId(res);
		return { id, result: res.result };
	}

	async resumeThreadWithResult(
		threadId: string,
		params?: Record<string, unknown>,
	): Promise<{ id: string; result: unknown }> {
		const res = await this.request("thread/resume", { threadId, ...params });
		this.throwOnError(res, "thread/resume");
		const id = this.extractThreadId(res) || threadId;
		return { id, result: res.result };
	}

	/** Start a turn. Returns the active turnId (for later turn/steer). */
	async startTurn(args: {
		threadId: string;
		input: unknown[];
		clientUserMessageId?: string;
	}): Promise<string | undefined> {
		const res = await this.request("turn/start", args);
		this.throwOnError(res, "turn/start");
		return this.extractTurnId(res);
	}

	/** Steer an in-flight turn (mid-execution injection). */
	async steerTurn(args: {
		threadId: string;
		expectedTurnId: string;
		input: unknown[];
		clientUserMessageId?: string;
	}): Promise<void> {
		const res = await this.request("turn/steer", args);
		this.throwOnError(res, "turn/steer");
	}

	// ── internals ─────────────────────────────────────────────────────────────

	private writeMessage(msg: JsonRpcRequest | JsonRpcNotification): void {
		if (!this.child) throw new Error("child not started");
		this.child.writeStdin(`${JSON.stringify(msg)}\n`);
	}

	private onStdoutChunk(chunk: string): void {
		this.stdoutBuffer += chunk;
		let idx = this.stdoutBuffer.indexOf("\n");
		while (idx !== -1) {
			const line = this.stdoutBuffer.slice(0, idx);
			this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
			if (line.trim().length > 0) this.handleLine(line);
			idx = this.stdoutBuffer.indexOf("\n");
		}
	}

	private onStderrChunk(chunk: string): void {
		// CR R2 LOW: byte-true cap. Keep the store as a Buffer; truncate by bytes
		// and NEVER re-encode back to a string for storage (that would grow the
		// retained bytes via replacement chars at a split boundary). The stored
		// buffer is always ≤ maxStderrBytes.
		const combined = Buffer.concat([
			this.stderrBuffer,
			Buffer.from(chunk, "utf8"),
		]);
		this.stderrBuffer =
			combined.length > this.opts.maxStderrBytes
				? combined.subarray(combined.length - this.opts.maxStderrBytes)
				: combined;
		this.emit("stderr", chunk);
	}

	private handleLine(line: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch (err) {
			// Malformed line must NOT crash the loop (Phase 0A robustness).
			this.opts.logger.warn("malformed JSON line skipped", {
				err: (err as Error).message,
				preview: line.slice(0, 120),
			});
			return;
		}

		// CR MED-3: valid JSON that is not a plain object (null / array / scalar)
		// must be skipped — indexing it below would throw and crash the loop.
		if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
			this.opts.logger.warn("non-object JSON frame skipped", {
				preview: line.slice(0, 120),
			});
			return;
		}

		// Response to one of our requests (has id + result/error, no method).
		const maybe = msg as JsonRpcResponse & { method?: string };
		if (
			maybe.id !== undefined &&
			maybe.method === undefined &&
			(maybe.result !== undefined || maybe.error !== undefined)
		) {
			const pending = this.pending.get(maybe.id);
			if (pending) {
				this.pending.delete(maybe.id);
				this.opts.clearTimeoutFn(pending.timer);
				pending.resolve(maybe);
			} else {
				this.opts.logger.warn("response for unknown request id", {
					id: maybe.id,
				});
			}
			return;
		}

		const method = (msg as JsonRpcNotification).method;
		if (typeof method !== "string") {
			this.opts.logger.warn("frame without method or id", {
				preview: line.slice(0, 120),
			});
			return;
		}

		// Server-initiated REQUEST (has both method and id) → must respond.
		if ((msg as JsonRpcRequest).id !== undefined) {
			void this.handleServerRequest(msg as JsonRpcRequest);
			return;
		}

		// Notification (method, no id).
		this.dispatchNotification(method, (msg as JsonRpcNotification).params);
	}

	private dispatchNotification(method: string, params: unknown): void {
		this.emit("notification", method, params);
		if (/turn\/completed/i.test(method) || /TurnCompleted/.test(method)) {
			this.emit("turnCompleted", params);
		}
	}

	private async handleServerRequest(req: JsonRpcRequest): Promise<void> {
		const handler = this.opts.onServerRequest;
		// CR HIGH-2: an UNKNOWN method (no handler, or not in the allowlist) MUST
		// get an immediate bounded method-not-found — it never reaches the handler,
		// so a hanging/misbehaving handler can never strand an unknown request.
		if (!handler || !this.knownServerMethods.has(req.method)) {
			this.respondError(
				req.id,
				JSONRPC_METHOD_NOT_FOUND,
				`server request "${req.method}" not handled`,
			);
			return;
		}
		try {
			const result = await handler({
				id: req.id,
				method: req.method,
				params: req.params,
			});
			this.respondResult(req.id, result);
		} catch (err) {
			this.respondError(
				req.id,
				JSONRPC_METHOD_NOT_FOUND,
				`server request "${req.method}" rejected: ${(err as Error).message}`,
			);
		}
	}

	/**
	 * CR MED-5: never write after close/exit (the handler may resolve late), and
	 * never let a transport write failure become an unhandled rejection — log it.
	 */
	private safeWriteResponse(
		response: Omit<JsonRpcResponse, "jsonrpc"> & { id: number },
	): void {
		if (this.closed || this.exitInfo) return;
		try {
			this.writeMessage({
				jsonrpc: "2.0",
				...response,
			} as unknown as JsonRpcNotification);
		} catch (err) {
			this.opts.logger.error("failed to write server-request response", {
				id: response.id,
				err: (err as Error).message,
			});
		}
	}

	private respondResult(id: number, result: unknown): void {
		this.safeWriteResponse({ id, result });
	}

	private respondError(id: number, code: number, message: string): void {
		this.safeWriteResponse({ id, error: { code, message } });
	}

	private onChildExit(
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		this.exitInfo = { code, signal };
		this.rejectAllPending(
			new CodexLeadProcessError(
				`codex app-server exited (code=${code}, signal=${signal})`,
				"exited",
			),
		);
		this.emit("exit", code, signal);
	}

	private rejectAllPending(err: Error): void {
		for (const [, p] of this.pending) {
			this.opts.clearTimeoutFn(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	private extractThreadId(res: JsonRpcResponse): string {
		this.throwOnError(res, "thread");
		const r = res.result as
			| { thread?: { id?: string }; threadId?: string; id?: string }
			| undefined;
		const id = r?.thread?.id ?? r?.threadId ?? r?.id;
		if (!id)
			throw new CodexLeadProcessError(
				"thread response missing thread id",
				"protocol",
			);
		return id;
	}

	private extractTurnId(res: JsonRpcResponse): string | undefined {
		const r = res.result as
			| { turnId?: string; turn?: { id?: string } }
			| undefined;
		return r?.turnId ?? r?.turn?.id;
	}

	private throwOnError(res: JsonRpcResponse, ctx: string): void {
		if (res.error) {
			throw new CodexLeadProcessError(
				`${ctx} failed: ${res.error.message} (code ${res.error.code})`,
				"protocol",
				res.error.code,
			);
		}
	}
}
