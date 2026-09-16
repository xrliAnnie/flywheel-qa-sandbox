import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";

const text = z.string().max(512);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const lead = z
	.object({
		projectName: id,
		leadId: id,
		displayName: text,
		backend: z.enum(["codex-app-server", "claude-code"]),
		status: text,
	})
	.strict();
const snapshotSchema = z
	.object({ observedAt: z.string().datetime(), leads: z.array(lead).max(500) })
	.strict();
const runSchema = z
	.object({
		observedAt: z.string().datetime(),
		runId: id,
		issueId: id,
		projectName: id,
		leadId: id,
		status: text,
	})
	.strict();
export type QaSnapshotDto = z.infer<typeof snapshotSchema>;
export type QaRunDto = z.infer<typeof runSchema>;
export interface QaViewOptions {
	activationId: string;
	/** Parent-owned live activation/registry predicate; no browser credential required or returned. */
	assertCurrent(activationId: string): void;
	snapshot(context: { signal: AbortSignal }): Promise<QaSnapshotDto>;
	run(runId: string, context: { signal: AbortSignal }): Promise<QaRunDto>;
	allowedRunIds(): ReadonlySet<string>;
}
const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			]!,
	);
export class QaViewServer {
	private server?: Server;
	private readonly sockets = new Set<Socket>();
	private closing?: Promise<void>;
	private readonly active = new Set<AbortController>();
	constructor(private readonly options: QaViewOptions) {
		id.parse(options.activationId);
	}
	async listen(): Promise<{ origin: string }> {
		if (this.server) throw new Error("qa_view_already_started");
		const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
			void this.handle(req, res);
		});
		server.maxConnections = 64;
		server.headersTimeout = 10_000;
		server.requestTimeout = 30_000;
		server.setTimeout(30_000, (socket) => socket.destroy());
		this.server = server;
		server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.once("close", () => this.sockets.delete(socket));
		});
		server.on("upgrade", (_req, socket) => {
			socket.end(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
			);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const failed = () => reject(new Error("qa_view_listen_failed"));
				server.once("error", failed);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", failed);
					resolve();
				});
			});
		} catch {
			await this.close();
			throw new Error("qa_view_listen_failed");
		}

		return {
			origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
		};
	}
	private async handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		);
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			res.end();
			return;
		}
		if (
			[
				"x-http-method-override",
				"x-method-override",
				"x-http-method",
				"upgrade",
			].some((name) => req.headers[name] !== undefined) ||
			req.headers.accept?.includes("text/event-stream")
		) {
			res.writeHead(403);
			res.end();
			return;
		}
		const address = this.server?.address();
		const host =
			address && typeof address !== "string"
				? `127.0.0.1:${address.port}`
				: undefined;
		if (
			req.headers.host !== host ||
			(req.headers.origin !== undefined &&
				req.headers.origin !== `http://${host}`)
		) {
			res.writeHead(403);
			res.end();
			return;
		}
		const path = req.url ?? "",
			match = /^\/api\/runs\/([A-Za-z0-9_-]{1,128})$/.exec(path),
			runId = match?.[1];
		if (path !== "/" && path !== "/api/fleet/snapshot" && !runId) {
			res.writeHead(403);
			res.end();
			return;
		}
		const controller = new AbortController();
		this.active.add(controller);
		const disconnected = () => {
			if (!res.writableEnded) controller.abort();
		};
		req.once("aborted", disconnected);
		res.once("close", disconnected);
		const timer = setTimeout(() => controller.abort(), 15000);
		let onAbort = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new Error("qa_read_aborted"));
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});

		try {
			this.options.assertCurrent(this.options.activationId);
			if (runId && !this.options.allowedRunIds().has(runId)) throw new Error();
			const raw = await Promise.race([
				Promise.resolve().then<QaRunDto | QaSnapshotDto>(() =>
					runId
						? this.options.run(runId, { signal: controller.signal })
						: this.options.snapshot({ signal: controller.signal }),
				),
				aborted,
			]);
			controller.signal.throwIfAborted();
			const dto = runId ? runSchema.parse(raw) : snapshotSchema.parse(raw);
			this.options.assertCurrent(this.options.activationId);
			if (
				runId &&
				(!this.options.allowedRunIds().has(runId) ||
					!("runId" in dto) ||
					dto.runId !== runId)
			)
				throw new Error();
			const body =
				path === "/"
					? `<!doctype html><html lang="zh"><meta charset="utf-8"><title>只读验收视图</title><h1>只读验收视图</h1><p>${escapeHtml(dto.observedAt)}</p><table><thead><tr><th>Project</th><th>Lead</th><th>Backend</th><th>Status</th></tr></thead><tbody>${("leads" in dto ? dto.leads : []).map((row) => `<tr><td>${escapeHtml(row.projectName)}</td><td>${escapeHtml(row.displayName)} (${escapeHtml(row.leadId)})</td><td>${escapeHtml(row.backend)}</td><td>${escapeHtml(row.status)}</td></tr>`).join("")}</tbody></table></html>`
					: JSON.stringify(dto);
			if (Buffer.byteLength(body) > 262144) throw new Error();
			res.setHeader(
				"Content-Type",
				path === "/"
					? "text/html; charset=utf-8"
					: "application/json; charset=utf-8",
			);
			res.writeHead(200);
			res.end(req.method === "HEAD" ? undefined : body);
		} catch {
			if (!res.destroyed) {
				res.writeHead(403);
				res.end();
			}
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort);
			req.off("aborted", disconnected);
			res.off("close", disconnected);
			this.active.delete(controller);
		}
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		for (const controller of this.active) controller.abort();
		const server = this.server;
		if (!server) return Promise.resolve();
		this.closing = new Promise<void>((resolve) => {
			server.close(() => resolve());
			for (const socket of this.sockets) socket.destroy();
		}).finally(() => {
			if (this.server === server) this.server = undefined;
			this.closing = undefined;
		});
		return this.closing;
	}
}
