/**
 * BrainPort — FLY-1160 §3.3: the daemon's loopback brain endpoint (default
 * OFF). The /eleven shim forwards platform turns here by conversation_id;
 * the daemon stays the ONLY process that spawns/reaps resident brains (the
 * shim never gets spawn rights — binding keys is internal wiring only).
 *
 * Security contract (Codex R1 #5):
 *   - 127.0.0.1 bind only; starts ONLY when huddle.brain.port is configured
 *     AND FLYWHEEL_BRAIN_PORT_TOKEN has a value (cli.ts enforces).
 *   - EVERY /brain/* endpoint (health included) requires the Bearer token,
 *     compared constant-time. The secret never appears in URLs/argv/logs.
 *   - health answers {ok, active} — counts only, never keys/issues.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";

/** the manager face BrainPort needs (keys are bound by daemon wiring). */
export interface BrainPortBrain {
	respond(
		turn: { text: string; history: never[] },
		opts: { signal: AbortSignal },
	): AsyncIterable<string>;
	interrupt(): Promise<void>;
}

export interface BrainPortManager {
	get(key: string): BrainPortBrain | undefined;
	stats(): { active: number };
}

export interface BrainPortOptions {
	manager: BrainPortManager;
	port: number;
	token: string;
	log?: (msg: string) => void;
	/** body read deadline → 408. Default 5s. */
	bodyTimeoutMs?: number;
}

const KEY_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_TEXT_BYTES = 16 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;

interface KeyTurnState {
	/** completion chain — exactly ONE handler streams per key at a time. */
	chain: Promise<void>;
	/** last-wins token: the newest arrival owns the key (Codex #550 R1 HIGH —
	 * the check/await/set supersede was not atomic; two racers could both pass
	 * the barrier and the stale turn would still stream its full answer). */
	latest: object;
}

export class BrainPort {
	private server?: Server;
	private shuttingDown = false;
	private readonly turns = new Map<string, KeyTurnState>();

	constructor(private readonly opts: BrainPortOptions) {}

	async listen(): Promise<void> {
		const server = createServer((req, res) => {
			void this.handle(req, res);
		});
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.opts.port, "127.0.0.1", () => resolve());
		});
	}

	/** Phase 1 of the two-phase shutdown: refuse new work with 503. */
	beginShutdown(): void {
		this.shuttingDown = true;
	}

	async close(): Promise<void> {
		this.shuttingDown = true;
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		server.closeAllConnections?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	// ------------------------------------------------------------- handlers

	private async handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			if (!this.authorized(req)) {
				this.json(res, 401, { error: "unauthorized" });
				return;
			}
			if (this.shuttingDown) {
				this.json(res, 503, { error: "shutting_down" });
				return;
			}
			if (req.method === "GET" && req.url === "/brain/health") {
				// counts ONLY — keys/issues never leave the daemon
				this.json(res, 200, {
					ok: true,
					active: this.opts.manager.stats().active,
				});
				return;
			}
			if (req.method === "POST" && req.url === "/brain/turn") {
				await this.handleTurn(req, res);
				return;
			}
			if (req.method === "POST" && req.url === "/brain/interrupt") {
				await this.handleInterrupt(req, res);
				return;
			}
			this.json(res, 404, { error: "not_found" });
		} catch (err) {
			if (!res.headersSent) {
				this.json(res, 500, { error: "internal" });
			} else {
				res.destroy();
			}
			this.opts.log?.(
				`brain-port error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async handleTurn(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const parsed = await this.readJsonBody(req, res);
		if (!parsed) return;
		const key = this.validateKey(parsed, res);
		if (!key) return;
		const text = (parsed as Record<string, unknown>).text;
		if (typeof text !== "string" || text.length === 0) {
			this.json(res, 400, { error: "text must be a non-empty string" });
			return;
		}
		if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
			this.json(res, 413, { error: "text exceeds 16KB" });
			return;
		}
		const brain = this.opts.manager.get(key);
		if (!brain) {
			this.json(res, 404, { error: "unknown key" });
			return;
		}

		// voice barge-in semantics, LAST WINS: claim the key synchronously
		// (token + chain slot) BEFORE any await, so concurrent racers cannot
		// interleave through the barrier.
		let st = this.turns.get(key);
		if (!st) {
			st = { chain: Promise.resolve(), latest: {} };
			this.turns.set(key, st);
		}
		const token = {};
		st.latest = token;
		const prev = st.chain;
		let release!: () => void;
		st.chain = new Promise<void>((r) => {
			release = r;
		});

		// register the disconnect listener BEFORE any await: a client that
		// vanishes while this turn is QUEUED must not reach the brain at all
		// (Codex #550 R2 MEDIUM). streaming=true narrows the interrupt to the
		// turn actually in flight; the token guard keeps a newer owner safe.
		let clientGone = false;
		let streaming = false;
		let finished = false;
		res.on("close", () => {
			clientGone = true;
			if (streaming && !finished && st.latest === token)
				void brain.interrupt().catch(() => {});
		});

		try {
			// interrupt whatever turn is in flight (barrier; immediate when idle)
			try {
				await brain.interrupt();
			} catch {
				this.json(res, 503, { error: "interrupt barrier failed" });
				return;
			}
			await prev; // the previous handler's stream has fully closed
			if (st.latest !== token || clientGone) {
				// superseded while queued, or the client hung up before the turn
				// started — end as an interrupted-before-speech turn (empty
				// stream); the brain never sees it.
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				res.end();
				return;
			}

			const ctrl = new AbortController();
			streaming = true;

			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			try {
				for await (const chunk of brain.respond(
					{ text, history: [] },
					{ signal: ctrl.signal },
				)) {
					res.write(chunk);
				}
				finished = true;
				res.end();
			} catch {
				// mid-stream failure: abort the socket — the client must not read
				// a truncated stream as a clean end (fail-loud, no silent degrade)
				finished = true;
				res.destroy();
			}
		} finally {
			release();
			if (this.turns.get(key) === st && st.latest === token) {
				this.turns.delete(key);
			}
		}
	}

	private async handleInterrupt(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const parsed = await this.readJsonBody(req, res);
		if (!parsed) return;
		const key = this.validateKey(parsed, res);
		if (!key) return;
		const brain = this.opts.manager.get(key);
		if (!brain) {
			this.json(res, 404, { error: "unknown key" });
			return;
		}
		try {
			await brain.interrupt();
			this.json(res, 200, { ok: true });
		} catch {
			this.json(res, 500, { error: "interrupt failed" });
		}
	}

	// --------------------------------------------------------------- pieces

	private authorized(req: IncomingMessage): boolean {
		const header = req.headers.authorization ?? "";
		const expected = `Bearer ${this.opts.token}`;
		// hash both sides so the compare is constant-time regardless of length
		const a = createHash("sha256").update(header).digest();
		const b = createHash("sha256").update(expected).digest();
		return timingSafeEqual(a, b);
	}

	private validateKey(
		parsed: unknown,
		res: ServerResponse,
	): string | undefined {
		const key = (parsed as Record<string, unknown>).key;
		if (typeof key !== "string" || !KEY_RE.test(key)) {
			this.json(res, 400, {
				error: "key must match [A-Za-z0-9:_-]{1,128}",
			});
			return undefined;
		}
		return key;
	}

	private readJsonBody(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<unknown | undefined> {
		const contentType = req.headers["content-type"] ?? "";
		if (!contentType.includes("application/json")) {
			this.json(res, 415, { error: "content-type must be application/json" });
			return Promise.resolve(undefined);
		}
		return new Promise((resolve) => {
			let data = "";
			let settled = false;
			const finish = (value: unknown | undefined): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			};
			const timer = setTimeout(() => {
				this.json(res, 408, { error: "body read timeout" });
				finish(undefined);
			}, this.opts.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS);
			req.on("data", (c: Buffer) => {
				data += c.toString("utf8");
				if (data.length > MAX_TEXT_BYTES * 4) {
					this.json(res, 413, { error: "body too large" });
					finish(undefined);
					req.destroy();
				}
			});
			req.on("end", () => {
				if (settled) return;
				let obj: unknown;
				try {
					obj = JSON.parse(data);
				} catch {
					this.json(res, 400, { error: "invalid JSON body" });
					finish(undefined);
					return;
				}
				if (obj === null || typeof obj !== "object") {
					this.json(res, 400, { error: "body must be a JSON object" });
					finish(undefined);
					return;
				}
				finish(obj);
			});
			req.on("error", () => finish(undefined));
		});
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		if (res.headersSent) return;
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	}
}
