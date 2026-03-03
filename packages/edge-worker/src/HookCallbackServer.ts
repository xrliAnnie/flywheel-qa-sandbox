import { EventEmitter } from "node:events";
import http from "node:http";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HookEvent {
	token: string;
	sessionId: string;
	issueId: string;
	eventType: string;
	timestamp: number;
}

/**
 * Lightweight HTTP server that receives session-end callbacks from Claude Code hooks.
 * Binds to 127.0.0.1 only (loopback — no external access).
 */
export class HookCallbackServer extends EventEmitter {
	private readonly server: http.Server;
	private readonly requestedPort: number;
	private assignedPort = 0;

	constructor(port = 0) {
		super();
		this.requestedPort = port;
		this.server = http.createServer((req, res) => this.handleRequest(req, res));
	}

	async start(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.requestedPort, "127.0.0.1", () => {
				const addr = this.server.address();
				if (addr && typeof addr === "object") {
					this.assignedPort = addr.port;
				}
				resolve(this.assignedPort);
			});
		});
	}

	async stop(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.close((err) => (err ? reject(err) : resolve()));
		});
	}

	getPort(): number {
		return this.assignedPort;
	}

	waitForEvent(
		token: string,
		eventType: string,
		timeoutMs: number,
	): Promise<HookEvent | null> {
		return new Promise((resolve) => {
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.removeListener("hook", onHook);
				resolve(null);
			}, timeoutMs);

			const onHook = (event: HookEvent) => {
				if (event.token === token && event.eventType === eventType) {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					this.removeListener("hook", onHook);
					resolve(event);
				}
			};

			this.on("hook", onHook);
		});
	}

	waitForCompletion(
		callbackToken: string,
		timeoutMs: number,
	): Promise<HookEvent | null> {
		return this.waitForEvent(callbackToken, "SessionEnd", timeoutMs);
	}

	// ─── Private ─────────────────────────────────────

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end("method not allowed");
			return;
		}

		const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.assignedPort}`);

		if (url.pathname !== "/hook/complete") {
			res.writeHead(404);
			res.end("not found");
			return;
		}

		const token = url.searchParams.get("token") ?? "";
		const sessionId = url.searchParams.get("sessionId") ?? "";
		const issueId = url.searchParams.get("issueId") ?? "";
		const eventType = url.searchParams.get("eventType") ?? "";

		if (!token || !UUID_RE.test(token)) {
			res.writeHead(400);
			res.end("missing or invalid token");
			return;
		}
		if (!sessionId) {
			res.writeHead(400);
			res.end("missing sessionId");
			return;
		}
		if (!issueId) {
			res.writeHead(400);
			res.end("missing issueId");
			return;
		}
		if (!eventType) {
			res.writeHead(400);
			res.end("missing eventType");
			return;
		}

		const event: HookEvent = {
			token,
			sessionId,
			issueId,
			eventType,
			timestamp: Date.now(),
		};

		this.emit("hook", event);

		res.writeHead(200);
		res.end("ok");
	}
}
