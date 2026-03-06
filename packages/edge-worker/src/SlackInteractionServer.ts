import { EventEmitter } from "node:events";
import http from "node:http";
import { parseActionId } from "./parseActionId.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MB

export interface SlackAction {
	actionId: string;
	issueId: string;
	action: string;
	userId: string;
	responseUrl: string;
	messageTs: string;
	executionId?: string;
}

/**
 * HTTP server that receives Slack interaction payloads (button clicks).
 * Binds to 0.0.0.0 — needs external access via Tailscale Funnel.
 */
export class SlackInteractionServer extends EventEmitter {
	private readonly server: http.Server;
	private readonly requestedPort: number;
	private readonly authToken?: string;
	private assignedPort = 0;

	constructor(port = 0, authToken?: string) {
		super();
		this.requestedPort = port;
		this.authToken = authToken;
		this.server = http.createServer((req, res) =>
			this.handleRequest(req, res),
		);
	}

	async start(): Promise<number> {
		if (!this.authToken) {
			console.warn(
				"[SlackInteractionServer] No auth token configured — requests will not be authenticated",
			);
		}
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.requestedPort, "0.0.0.0", () => {
				const addr = this.server.address();
				if (addr && typeof addr === "object") {
					this.assignedPort = addr.port;
				}
				resolve(this.assignedPort);
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server.listening) return;
		return new Promise((resolve, reject) => {
			this.server.close((err) => (err ? reject(err) : resolve()));
		});
	}

	getPort(): number {
		return this.assignedPort;
	}

	waitForAction(
		issueId: string,
		timeoutMs: number,
	): Promise<SlackAction | null> {
		return new Promise((resolve) => {
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.removeListener("action", onAction);
				resolve(null);
			}, timeoutMs);

			const onAction = (action: SlackAction) => {
				if (action.issueId === issueId) {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					this.removeListener("action", onAction);
					resolve(action);
				}
			};

			this.on("action", onAction);
		});
	}

	private handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): void {
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end("method not allowed");
			return;
		}

		const url = new URL(
			req.url ?? "/",
			`http://0.0.0.0:${this.assignedPort}`,
		);
		if (url.pathname !== "/slack/interaction") {
			res.writeHead(404);
			res.end("not found");
			return;
		}

		// Auth check (Bearer token)
		if (this.authToken) {
			const authHeader = req.headers.authorization ?? "";
			if (authHeader !== `Bearer ${this.authToken}`) {
				res.writeHead(401);
				res.end("unauthorized");
				return;
			}
		}

		// Collect body with size limit
		const chunks: Buffer[] = [];
		let totalSize = 0;
		let aborted = false;

		req.on("data", (chunk: Buffer) => {
			totalSize += chunk.length;
			if (totalSize > MAX_BODY_BYTES) {
				aborted = true;
				req.destroy();
				res.writeHead(413);
				res.end("payload too large");
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (aborted) return;
			const body = Buffer.concat(chunks).toString("utf-8");
			this.processBody(body, res);
		});
	}

	private processBody(body: string, res: http.ServerResponse): void {
		// Slack sends application/x-www-form-urlencoded with payload field
		const params = new URLSearchParams(body);
		const payloadStr = params.get("payload");

		if (!payloadStr) {
			res.writeHead(400);
			res.end("missing payload");
			return;
		}

		let payload: any;
		try {
			payload = JSON.parse(payloadStr);
		} catch (err) {
			console.warn(
				`[SlackInteractionServer] Invalid payload JSON: ${err instanceof Error ? err.message : String(err)}`,
			);
			res.writeHead(400);
			res.end("invalid payload JSON");
			return;
		}

		// Respond 200 immediately (Slack requires <3s)
		res.writeHead(200);
		res.end("ok");

		// Parse actions
		const actions = payload.actions;
		if (!Array.isArray(actions)) return;

		for (const rawAction of actions) {
			const actionId: string = rawAction.action_id ?? "";
			if (!actionId.startsWith("flywheel_")) continue;

			const parsed = parseActionId(actionId);
			if (!parsed) {
				console.warn(
					`[SlackInteractionServer] Could not parse flywheel action_id: ${actionId}`,
				);
				continue;
			}

			// Parse executionId from button value JSON (validate UUID format)
			let executionId: string | undefined;
			try {
				const val = typeof rawAction.value === "string" ? JSON.parse(rawAction.value) : undefined;
				const rawId = val?.executionId ?? val?.execution_id;
				if (typeof rawId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) {
					executionId = rawId;
				}
			} catch { /* ignore parse errors */ }

			const slackAction: SlackAction = {
				actionId,
				issueId: parsed.issueId,
				action: parsed.action,
				userId: payload.user?.id ?? "",
				responseUrl: payload.response_url ?? "",
				messageTs: payload.message?.ts ?? "",
				executionId,
			};

			this.emit("action", slackAction);
		}
	}
}
