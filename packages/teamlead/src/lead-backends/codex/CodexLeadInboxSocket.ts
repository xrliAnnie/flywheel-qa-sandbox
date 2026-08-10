/**
 * FLY-1373 — authenticated, process-local ingress for Bridge mailbox batches.
 *
 * The Codex Lead router lives in the windowed TUI sidecar process. The Bridge
 * therefore cannot mutate journal.db directly: doing so would durably accept a
 * row without waking the router's in-memory pump. This newline-delimited Unix
 * socket keeps durable accept + pump in that owning process.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { join } from "node:path";
import type { LeadInputBatch, LeadInputRouter } from "./LeadInputRouter.js";
import type { BatchAcceptStatus } from "./LeadJournal.js";

const PROTOCOL_VERSION = 2;
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

export interface CodexLeadInboxOwnerBinding {
	leadId: string;
	ownerEpoch: string;
}

interface SubmitBatchRequest extends CodexLeadInboxOwnerBinding {
	version: 1 | 2;
	method: "submitBatch";
	batch: LeadInputBatch;
	auth: string;
}

interface CapabilitiesRequest {
	version: 2;
	method: "capabilities";
	leadId: string;
	auth: string;
}

type InboxRequest = SubmitBatchRequest | CapabilitiesRequest;

interface SubmitBatchResponse {
	ok: true;
	status: BatchAcceptStatus;
	entryId: string;
}

interface ErrorResponse {
	ok: false;
	error: string;
}

export interface CodexLeadInboxCapabilities {
	protocolVersions: [1, 2];
	features: ["discord_route_v2"];
	socketOwnerId: string;
}

export function resolveCodexLeadInboxSocketPath(stateDir: string): string {
	return join(stateDir, "lead-inbox.sock");
}

export interface CodexLeadInboxServerOptions {
	socketPath: string;
	leadId: string;
	router: Pick<LeadInputRouter, "submitBatch">;
	/** Lead bot token shared only by Bridge and the owning TUI process. */
	authSecret: string;
	socketOwnerId?: string;
	/** Crash seam: throw after journal commit to simulate response loss. */
	afterCommit?: () => void | Promise<void>;
}

export class CodexLeadInboxServer {
	private server: Server | undefined;
	private readonly sockets = new Set<Socket>();
	private readonly socketOwnerId: string;
	private accepting = false;
	private boundIdentity?: { dev: number; ino: number };

	constructor(private readonly opts: CodexLeadInboxServerOptions) {
		if (!opts.socketPath || !opts.leadId.trim() || !opts.authSecret.trim()) {
			throw new Error(
				"CodexLeadInboxServer requires socketPath + leadId + authSecret",
			);
		}
		this.socketOwnerId = opts.socketOwnerId ?? randomUUID();
	}

	async listen(): Promise<void> {
		if (this.server) return;
		if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath);
		// Keep the writable half open after the client finishes its request so the
		// asynchronous journal commit can return a receipt on the same connection.
		const server = createServer({ allowHalfOpen: true }, (socket) => {
			if (!this.accepting) {
				socket.destroy();
				return;
			}
			this.sockets.add(socket);
			socket.once("close", () => this.sockets.delete(socket));
			this.handle(socket);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.opts.socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		chmodSync(this.opts.socketPath, 0o600);
		const stat = lstatSync(this.opts.socketPath);
		this.boundIdentity = { dev: stat.dev, ino: stat.ino };
		this.accepting = true;
		this.server = server;
	}

	pauseAccepting(): void {
		this.accepting = false;
		for (const socket of this.sockets) socket.destroy();
	}

	resumeIfBoundPathCurrent(): boolean {
		if (!this.server || !this.boundIdentity) return false;
		try {
			const stat = lstatSync(this.opts.socketPath);
			if (
				stat.dev !== this.boundIdentity.dev ||
				stat.ino !== this.boundIdentity.ino
			) {
				return false;
			}
			this.accepting = true;
			return true;
		} catch {
			return false;
		}
	}

	async close(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		this.accepting = false;
		this.boundIdentity = undefined;
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath);
		} catch {
			// best-effort stale socket cleanup
		}
	}

	private handle(socket: Socket): void {
		const chunks: Buffer[] = [];
		let size = 0;
		let rejected = false;
		socket.on("error", () => {
			// A peer can reset during response or be destroyed on an oversized frame.
			// Socket errors are request-local and must never crash the resident TUI.
		});
		socket.setTimeout(10_000, () => socket.destroy());
		socket.on("data", (chunk: Buffer) => {
			if (rejected) return;
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				rejected = true;
				socket.destroy();
				return;
			}
			chunks.push(chunk);
		});
		socket.once("end", () => {
			if (rejected) return;
			void this.process(socket, Buffer.concat(chunks).toString("utf8"));
		});
	}

	private async process(socket: Socket, raw: string): Promise<void> {
		try {
			const request = parseRequest(raw);
			if (request.leadId !== this.opts.leadId) {
				throw new Error("lead binding mismatch");
			}
			if (!authenticateRequest(request, this.opts.authSecret)) {
				throw new Error("authentication rejected");
			}
			if (request.method === "capabilities") {
				const capabilities: CodexLeadInboxCapabilities = {
					protocolVersions: [1, 2],
					features: ["discord_route_v2"],
					socketOwnerId: this.socketOwnerId,
				};
				socket.end(`${JSON.stringify({ ok: true, capabilities })}\n`);
				return;
			}
			const result = this.opts.router.submitBatch(request.batch);
			try {
				await this.opts.afterCommit?.();
			} catch {
				// Deliberately model a process dying after the journal commit but before
				// the receipt. The Bridge must retain the queue rows and retry.
				socket.destroy();
				return;
			}
			const response: SubmitBatchResponse = { ok: true, ...result };
			socket.end(`${JSON.stringify(response)}\n`);
		} catch (error) {
			const response: ErrorResponse = {
				ok: false,
				error: (error as Error).message,
			};
			socket.end(`${JSON.stringify(response)}\n`);
		}
	}
}

export async function submitCodexLeadInboxBatch(args: {
	socketPath: string;
	leadId: string;
	ownerEpoch: string;
	authSecret: string;
	batch: LeadInputBatch;
	protocolVersion?: 1 | 2;
	timeoutMs?: number;
}): Promise<{ status: BatchAcceptStatus; entryId: string }> {
	const unsigned = {
		version: args.protocolVersion ?? 1,
		method: "submitBatch",
		leadId: args.leadId,
		ownerEpoch: args.ownerEpoch,
		batch: args.batch,
	} as const;
	const request: SubmitBatchRequest = {
		...unsigned,
		auth: signRequest(unsigned, args.authSecret),
	};
	const raw = await requestResponse(
		args.socketPath,
		`${JSON.stringify(request)}\n`,
		args.timeoutMs ?? 5_000,
	);
	const response = JSON.parse(raw) as SubmitBatchResponse | ErrorResponse;
	if (!response.ok)
		throw new Error(`Codex Lead inbox rejected: ${response.error}`);
	return { status: response.status, entryId: response.entryId };
}

export async function probeCodexLeadInboxCapabilities(args: {
	socketPath: string;
	leadId: string;
	authSecret: string;
	timeoutMs?: number;
}): Promise<CodexLeadInboxCapabilities> {
	const unsigned = {
		version: PROTOCOL_VERSION,
		method: "capabilities",
		leadId: args.leadId,
	} as const;
	const request: CapabilitiesRequest = {
		...unsigned,
		auth: signRequest(unsigned, args.authSecret),
	};
	const raw = await requestResponse(
		args.socketPath,
		`${JSON.stringify(request)}\n`,
		args.timeoutMs ?? 5_000,
	);
	const response = JSON.parse(raw) as
		| { ok: true; capabilities: CodexLeadInboxCapabilities }
		| ErrorResponse;
	if (!response.ok)
		throw new Error(`Codex Lead inbox rejected: ${response.error}`);
	return response.capabilities;
}

function parseRequest(raw: string): InboxRequest {
	const value = JSON.parse(raw.trim()) as Partial<InboxRequest>;
	if (
		value.method === "capabilities" &&
		value.version === 2 &&
		typeof value.leadId === "string" &&
		typeof value.auth === "string"
	) {
		return value as CapabilitiesRequest;
	}
	if (
		(value.version !== 1 && value.version !== 2) ||
		value.method !== "submitBatch" ||
		typeof value.leadId !== "string" ||
		typeof value.ownerEpoch !== "string" ||
		typeof value.auth !== "string" ||
		!value.batch ||
		typeof value.batch.batchId !== "string" ||
		!Array.isArray(value.batch.memberIds) ||
		!value.batch.memberIds.every((id) => typeof id === "string") ||
		typeof value.batch.payload !== "string"
	) {
		throw new Error("malformed submitBatch request");
	}
	if (
		value.version === 1 &&
		(value.batch.replyChannelId !== undefined ||
			value.batch.replyRoute !== undefined)
	) {
		throw new Error("v1 submitBatch cannot carry Discord route metadata");
	}
	return value as SubmitBatchRequest;
}

type UnsignedInboxRequest =
	| Omit<SubmitBatchRequest, "auth">
	| Omit<CapabilitiesRequest, "auth">;

function canonicalRequest(request: UnsignedInboxRequest): string {
	return request.method === "capabilities"
		? JSON.stringify({
				version: request.version,
				method: request.method,
				leadId: request.leadId,
			})
		: JSON.stringify({
				version: request.version,
				method: request.method,
				leadId: request.leadId,
				ownerEpoch: request.ownerEpoch,
				batch: request.batch,
			});
}

function signRequest(
	request: UnsignedInboxRequest,
	authSecret: string,
): string {
	return createHmac("sha256", authSecret)
		.update(canonicalRequest(request))
		.digest("hex");
}

function authenticateRequest(
	request: InboxRequest,
	authSecret: string,
): boolean {
	if (!/^[0-9a-f]{64}$/i.test(request.auth)) return false;
	const expected = Buffer.from(
		signRequest(
			request.method === "capabilities"
				? {
						version: request.version,
						method: request.method,
						leadId: request.leadId,
					}
				: {
						version: request.version,
						method: request.method,
						leadId: request.leadId,
						ownerEpoch: request.ownerEpoch,
						batch: request.batch,
					},
			authSecret,
		),
		"hex",
	);
	const actual = Buffer.from(request.auth, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestResponse(
	socketPath: string,
	payload: string,
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const socket = createConnection(socketPath);
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		};
		const timer = setTimeout(() => {
			socket.destroy();
			fail(new Error(`Codex Lead inbox timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		socket.once("connect", () => socket.end(payload));
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.once("error", (error) => {
			fail(error);
		});
		socket.once("end", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (!raw) reject(new Error("Codex Lead inbox closed without a receipt"));
			else resolve(raw);
		});
	});
}
