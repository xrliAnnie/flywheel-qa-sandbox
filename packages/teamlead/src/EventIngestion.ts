import http from "node:http";
import type { StateStore, SessionEvent } from "./StateStore.js";

const MAX_BODY_BYTES = 512 * 1024; // 512KB

export interface IngestEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	payload?: Record<string, unknown>;
	source?: string;
}

export class EventIngestion {
	private server: http.Server;
	private assignedPort = 0;

	constructor(
		private store: StateStore,
		private onEvent?: (event: IngestEvent) => void,
		private authToken?: string,
	) {
		this.server = http.createServer((req, res) => this.handleRequest(req, res));
	}

	async start(port: number, host = "127.0.0.1"): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, host, () => {
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

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end("method not allowed");
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

		const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.assignedPort}`);
		if (url.pathname !== "/events") {
			res.writeHead(404);
			res.end("not found");
			return;
		}

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
			this.processEvent(body, res);
		});
	}

	private processEvent(body: string, res: http.ServerResponse): void {
		let event: IngestEvent;
		try {
			const parsed = JSON.parse(body);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				res.writeHead(400);
				res.end("expected JSON object");
				return;
			}
			event = parsed;
		} catch {
			res.writeHead(400);
			res.end("invalid JSON");
			return;
		}

		// Validate required fields — strict type checks at system boundary
		const required = ["event_id", "execution_id", "issue_id", "project_name", "event_type"] as const;
		for (const field of required) {
			if (typeof event[field] !== "string" || event[field].length === 0) {
				res.writeHead(400);
				res.end(`missing or invalid field: ${field}`);
				return;
			}
		}

		// Store event (idempotent) — skip side effects for duplicates
		const sessionEvent: SessionEvent = {
			event_id: event.event_id,
			execution_id: event.execution_id,
			issue_id: event.issue_id,
			project_name: event.project_name,
			event_type: event.event_type,
			payload: event.payload,
			source: typeof event.source === "string" ? event.source : "orchestrator",
		};
		const isNew = this.store.insertEvent(sessionEvent);
		if (!isNew) {
			// Duplicate event_id — return 200 but skip all side effects
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, duplicate: true }));
			return;
		}

		// Update session read model
		const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

		if (event.event_type === "session_started") {
			this.store.upsertSession({
				execution_id: event.execution_id,
				issue_id: event.issue_id,
				project_name: event.project_name,
				status: "running",
				started_at: now,
				last_activity_at: now,
				issue_identifier: event.payload?.issueIdentifier as string | undefined,
				issue_title: event.payload?.issueTitle as string | undefined,
			});
		} else if (event.event_type === "session_completed") {
			const payload = event.payload ?? {};
			const decision = payload.decision as Record<string, unknown> | undefined;
			const evidence = payload.evidence as Record<string, unknown> | undefined;
			const route = decision?.route as string | undefined;

			let status: string;
			if (route === "needs_review") status = "awaiting_review";
			else if (route === "auto_approve") status = "approved";
			else if (route === "blocked") status = "blocked";
			else status = "completed";

			this.store.upsertSession({
				execution_id: event.execution_id,
				issue_id: event.issue_id,
				project_name: event.project_name,
				status,
				last_activity_at: now,
				decision_route: route,
				decision_reasoning: decision?.reasoning as string | undefined,
				commit_count: evidence?.commitCount as number | undefined,
				files_changed: evidence?.filesChangedCount as number | undefined,
				lines_added: evidence?.linesAdded as number | undefined,
				lines_removed: evidence?.linesRemoved as number | undefined,
				summary: payload.summary as string | undefined,
				diff_summary: evidence?.diffSummary as string | undefined,
				commit_messages: Array.isArray(evidence?.commitMessages)
					? (evidence.commitMessages as string[]).join("\n")
					: undefined,
				changed_file_paths: Array.isArray(evidence?.changedFilePaths)
					? (evidence.changedFilePaths as string[]).join("\n")
					: undefined,
				issue_identifier: event.payload?.issueIdentifier as string | undefined,
				issue_title: event.payload?.issueTitle as string | undefined,
			});
		} else if (event.event_type === "session_failed") {
			const payload = event.payload ?? {};
			this.store.upsertSession({
				execution_id: event.execution_id,
				issue_id: event.issue_id,
				project_name: event.project_name,
				status: "failed",
				last_activity_at: now,
				last_error: payload.error as string | undefined,
			});
		}

		// Callback for notifications
		if (this.onEvent) {
			try {
				this.onEvent(event);
			} catch (err) {
				console.error("[EventIngestion] onEvent callback error:", err);
			}
		}

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}
}
