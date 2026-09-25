import {
	type LeadRuntimeReadback,
	validLeadTurnObservation,
} from "./lead-turn-evidence.js";
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
import {
	canonicalVoiceSelfFilterRequest,
	signVoiceSelfFilterResponse,
	VOICE_SELF_FILTER_MAX_BYTES,
	type VoiceSelfFilterObservation,
	validVoiceSelfFilterRequestFields,
} from "../../voice-self-filter-contract.js";
import type { LeadInputBatch, LeadInputRouter } from "./LeadInputRouter.js";
import type { BatchAcceptStatus } from "./LeadJournal.js";
import type {
	LeadRuntimeConfigIdentity,
	LeadRuntimeConfigResult,
	LeadRuntimeConfigTarget,
} from "./LeadRuntimeConfigCoordinator.js";
import type { TurnStateSnapshot } from "./LeadTurnStateTracker.js";
import type { SubscriptionEntry } from "./RoundtableThreadRegistry.js";

interface VoiceSelfFilterRequest {
	version: 2;
	contractVersion: 1;
	method: "probeVoiceSelfFilter";
	leadId: string;
	expectedBotUserId: string;
	nonce: string;
	auth: string;
}

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

interface ListSubscriptionsRequest {
	version: 2;
	method: "listSubscriptions";
	leadId: string;
	auth: string;
}

/** FLY-2882: read-only turn-state snapshot; no business fields. */
interface ReadTurnStateRequest {
	version: 2;
	method: "readTurnState";
	leadId: string;
	auth: string;
}

interface UnsubscribeThreadRequest {
	version: 2;
	method: "unsubscribeThread";
	leadId: string;
	threadId: string;
	reason: string;
	auth: string;
}

export interface ProactiveTopicReceipt {
	socketOwnerId: string;
	parentChannelId: string;
	messageId: string;
	eventId: string;
	payloadHash: string;
}
interface EngageProactiveTopicRequest extends ProactiveTopicReceipt {
	version: 2;
	method: "engageProactiveTopic";
	leadId: string;
	auth: string;
}

interface RuntimeConfigRequest extends LeadRuntimeConfigTarget {
	version: 2;
	method: "applyRuntimeConfig" | "readRuntimeConfig";
	leadId: string;
	socketOwnerId: string;
	auth: string;
}

function runtimeConfigTarget(
	value: LeadRuntimeConfigTarget,
): LeadRuntimeConfigTarget {
	return {
		projectName: value.projectName,
		leadKey: value.leadKey,
		identityDigest: value.identityDigest,
		carrierId: value.carrierId,
		ownerEpoch: value.ownerEpoch,
		runtimeGeneration: value.runtimeGeneration,
		threadId: value.threadId,
		operationId: value.operationId,
		configGeneration: value.configGeneration,
		configDigest: value.configDigest,
		modelRegistryRevision: value.modelRegistryRevision,
		model: value.model,
		effort: value.effort,
	};
}

type InboxRequest =
	| RuntimeConfigRequest
	| VoiceSelfFilterRequest
	| EngageProactiveTopicRequest
	| SubmitBatchRequest
	| CapabilitiesRequest
	| ReadTurnStateRequest
	| ListSubscriptionsRequest
	| UnsubscribeThreadRequest;

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
	features: (
		| "discord_route_v2"
		| "roundtable_proactive_engage_v1"
		| "lead_runtime_config_v1"
		| "registry_tuning_v1"
		| "voice_self_filter_v1"
		| "turn_state_v1"
	)[];
	socketOwnerId: string;
	runtimeIdentity?: LeadRuntimeConfigIdentity;
	voiceMirrorIgnoredAuthorIds?: readonly string[];
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
	/** Must be the same startup projection passed to this process's gateway. */
	ignoredAuthorIds?: readonly string[];
	voiceSelfFilter?: () => VoiceSelfFilterObservation;
	/**
	 * FLY-2882: read-only turn-state provider. Only a runtime that tracks turn
	 * lifecycle passes it; without it `turn_state_v1` is not advertised and
	 * `readTurnState` is rejected as an unsupported method.
	 */
	turnState?: { snapshot(): TurnStateSnapshot };
	subscriptions?: {
		list(): SubscriptionEntry[];
		remove(threadId: string, reason: string, actor: string): Promise<boolean>;
	};
	proactiveTopic?: {
		parentChannelId: string;
		/** Synchronous runtime lease check; must stay false after handoff. */
		isCurrentOwner(): boolean;
		/** Recheck the supplied guard after each await, before writes or activation. */
		engage(
			receipt: ProactiveTopicReceipt,
			assertCurrentOwner: () => void,
		): Promise<"pending" | "ready">;
	};
	runtimeConfig?: {
		/** True only after the runtime has verified native protocol and bootstrap artifact compatibility. */
		isSupported(): boolean;
		identity(): LeadRuntimeConfigIdentity;
		assertCurrent(target: LeadRuntimeConfigTarget): void;
		apply(
			target: LeadRuntimeConfigTarget,
			assertCurrentOwner: () => void,
		): Promise<LeadRuntimeConfigResult>;
		read(
			target: LeadRuntimeConfigTarget,
			assertCurrentOwner: () => void,
		): Promise<LeadRuntimeReadback>;
	};

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
		const connectedAt = Date.now();
		let probePrefix = Buffer.alloc(0);
		let probeFrame = false;
		let probeDeadline: ReturnType<typeof setTimeout> | undefined;
		socket.once("close", () => clearTimeout(probeDeadline));
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
			if (!probeFrame && probePrefix.length < VOICE_SELF_FILTER_MAX_BYTES) {
				probePrefix = Buffer.concat([
					probePrefix,
					chunk.subarray(0, VOICE_SELF_FILTER_MAX_BYTES - probePrefix.length),
				]);
				probeFrame = probePrefix.includes('"probeVoiceSelfFilter"');
			}
			if (probeFrame) {
				if (
					size > VOICE_SELF_FILTER_MAX_BYTES ||
					Date.now() - connectedAt >= 2000
				) {
					rejected = true;
					socket.destroy();
					return;
				}
				probeDeadline ??= setTimeout(
					() => socket.destroy(),
					2000 - (Date.now() - connectedAt),
				);
			}
		});
		socket.once("end", () => {
			if (rejected) return;
			void this.process(socket, Buffer.concat(chunks).toString("utf8"));
		});
	}

	private proactiveOwnerCurrent(): boolean {
		if (
			!this.accepting ||
			!this.boundIdentity ||
			!this.opts.proactiveTopic?.isCurrentOwner()
		)
			return false;
		try {
			const stat = lstatSync(this.opts.socketPath);
			return (
				stat.isSocket() &&
				stat.dev === this.boundIdentity.dev &&
				stat.ino === this.boundIdentity.ino
			);
		} catch {
			return false;
		}
	}

	private runtimeConfigSocketIdentity(): LeadRuntimeConfigIdentity | undefined {
		try {
			if (!this.accepting || !this.boundIdentity || !this.opts.runtimeConfig)
				return undefined;
			const source = this.opts.runtimeConfig.identity();
			const fields = [
				"projectName",
				"leadKey",
				"identityDigest",
				"carrierId",
				"ownerEpoch",
				"runtimeGeneration",
				"threadId",
				"artifactBuildSha",
				"bootstrapBuildSha",
			] as const;
			if (
				fields.some(
					(key) =>
						typeof source[key] !== "string" ||
						!source[key] ||
						source[key].length > 512,
				) ||
				source.carrierId !== this.socketOwnerId ||
				!/^[a-f0-9]{40}$/i.test(source.artifactBuildSha) ||
				source.artifactBuildSha !== source.bootstrapBuildSha
			)
				return undefined;
			const stat = lstatSync(this.opts.socketPath);
			if (
				!stat.isSocket() ||
				stat.dev !== this.boundIdentity.dev ||
				stat.ino !== this.boundIdentity.ino
			)
				return undefined;
			return Object.fromEntries(
				fields.map((key) => [key, source[key]]),
			) as unknown as LeadRuntimeConfigIdentity;
		} catch {
			return undefined;
		}
	}

	private runtimeConfigIdentity(): LeadRuntimeConfigIdentity | undefined {
		try {
			if (!this.opts.runtimeConfig?.isSupported()) return undefined;
			return this.runtimeConfigSocketIdentity();
		} catch {
			return undefined;
		}
	}
	runtimeConfigOwnerCurrent(): boolean {
		return this.runtimeConfigSocketIdentity() !== undefined;
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
			if (request.method === "probeVoiceSelfFilter") {
				if (
					Buffer.byteLength(raw) > VOICE_SELF_FILTER_MAX_BYTES ||
					!this.opts.voiceSelfFilter
				)
					throw new Error("self_filter_unavailable");
				const response = signVoiceSelfFilterResponse(
					{
						version: 1,
						leadId: this.opts.leadId,
						runtimeId: this.socketOwnerId,
						nonce: request.nonce,
						...this.opts.voiceSelfFilter(),
					},
					this.opts.authSecret,
				);
				socket.end(`${JSON.stringify(response)}\n`);
				return;
			}
			if (request.method === "capabilities") {
				const runtimeIdentity = this.runtimeConfigIdentity();
				const capabilities: CodexLeadInboxCapabilities = {
					protocolVersions: [1, 2],
					features: [
						"discord_route_v2",
						...(runtimeIdentity
							? [
									"lead_runtime_config_v1" as const,
									"registry_tuning_v1" as const,
								]
							: []),
						...(this.opts.voiceSelfFilter
							? ["voice_self_filter_v1" as const]
							: []),
						...(this.opts.turnState ? ["turn_state_v1" as const] : []),
						...(this.proactiveOwnerCurrent()
							? ["roundtable_proactive_engage_v1" as const]
							: []),
					],
					socketOwnerId: this.socketOwnerId,
					...(runtimeIdentity ? { runtimeIdentity } : {}),
					...(this.opts.ignoredAuthorIds === undefined
						? {}
						: {
								voiceMirrorIgnoredAuthorIds: [...this.opts.ignoredAuthorIds],
							}),
				};
				socket.end(`${JSON.stringify({ ok: true, capabilities })}\n`);
				return;
			}
			if (request.method === "readTurnState") {
				if (!this.opts.turnState) throw new Error("unsupported inbox method");
				socket.end(
					`${JSON.stringify({ ok: true, turnState: this.opts.turnState.snapshot() })}\n`,
				);
				return;
			}
			if (
				request.method === "applyRuntimeConfig" ||
				request.method === "readRuntimeConfig"
			) {
				const hook = this.opts.runtimeConfig;
				// Coordinator may wait up to 10s for application; keep transport alive
				// long enough to return its pending receipt instead of racing that bound.
				socket.setTimeout(12_000, () => socket.destroy());
				if (!hook || !this.runtimeConfigIdentity())
					throw new Error("runtime_hot_config_unsupported");
				const target = runtimeConfigTarget(request);
				const assertCurrentOwner = () => {
					if (
						request.socketOwnerId !== this.socketOwnerId ||
						target.carrierId !== this.socketOwnerId ||
						!this.runtimeConfigIdentity()
					)
						throw new Error("runtime_config_owner_mismatch");
					hook.assertCurrent(target);
				};
				assertCurrentOwner();
				const result =
					request.method === "applyRuntimeConfig"
						? await hook.apply(target, assertCurrentOwner)
						: await hook.read(target, assertCurrentOwner);
				assertCurrentOwner();
				socket.end(`${JSON.stringify({ ok: true, result })}\n`);
				return;
			}

			if (request.method === "engageProactiveTopic") {
				const hook = this.opts.proactiveTopic;
				if (!hook) throw new Error("proactive topic unavailable");
				if (request.parentChannelId !== hook.parentChannelId)
					throw new Error("proactive parent mismatch");
				const assertCurrentOwner = () => {
					if (
						request.socketOwnerId !== this.socketOwnerId ||
						!this.proactiveOwnerCurrent()
					)
						throw new Error("proactive owner mismatch");
				};
				assertCurrentOwner();
				const receipt: ProactiveTopicReceipt = {
					socketOwnerId: request.socketOwnerId,
					parentChannelId: request.parentChannelId,
					messageId: request.messageId,
					eventId: request.eventId,
					payloadHash: request.payloadHash,
				};
				const engagement = await hook.engage(receipt, assertCurrentOwner);
				assertCurrentOwner();
				if (engagement !== "pending" && engagement !== "ready")
					throw new Error("invalid engagement result");
				socket.end(
					`${JSON.stringify({ ok: true, engagement, threadId: request.messageId })}\n`,
				);
				return;
			}
			if (
				request.method === "listSubscriptions" ||
				request.method === "unsubscribeThread"
			) {
				if (!this.opts.subscriptions)
					throw new Error("subscriptions unavailable");
				const result =
					request.method === "listSubscriptions"
						? { entries: this.opts.subscriptions.list() }
						: {
								removed: await this.opts.subscriptions.remove(
									request.threadId,
									request.reason,
									"cli",
								),
							};
				socket.end(`${JSON.stringify({ ok: true, ...result })}\n`);
				return;
			}
			if (request.method !== "submitBatch")
				throw new Error("unsupported inbox method");
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

export class CodexLeadInboxRejectedError extends Error {
	constructor(readonly reason: string) {
		super(`Codex Lead inbox rejected: ${reason}`);
		this.name = "CodexLeadInboxRejectedError";
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
	if (!response.ok) throw new CodexLeadInboxRejectedError(response.error);
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
	if (!response.ok) throw new CodexLeadInboxRejectedError(response.error);
	return response.capabilities;
}

interface SubscriptionClientArgs {
	socketPath: string;
	leadId: string;
	authSecret: string;
	timeoutMs?: number;
}

/**
 * FLY-2882: fetch the sidecar's turn-state snapshot. Returned UNVALIDATED —
 * the Bridge caller owns the strict schema check (a malformed reply must map
 * to "unknown", never default to idle).
 */
export async function readCodexLeadTurnState(
	args: SubscriptionClientArgs,
): Promise<unknown> {
	const unsigned = {
		version: PROTOCOL_VERSION,
		method: "readTurnState",
		leadId: args.leadId,
	} as const;
	const request: ReadTurnStateRequest = {
		...unsigned,
		auth: signRequest(unsigned, args.authSecret),
	};
	const response = JSON.parse(
		await requestResponse(
			args.socketPath,
			`${JSON.stringify(request)}\n`,
			args.timeoutMs ?? 3_000,
		),
	) as { ok: true; turnState: unknown } | ErrorResponse;
	if (!response.ok) throw new CodexLeadInboxRejectedError(response.error);
	return response.turnState;
}

export async function listCodexLeadSubscriptions(
	args: SubscriptionClientArgs,
): Promise<SubscriptionEntry[]> {
	const request = {
		version: 2,
		method: "listSubscriptions",
		leadId: args.leadId,
	} as const;
	const response = (await subscriptionRequest(args, request)) as {
		entries: SubscriptionEntry[];
	};
	return response.entries;
}

export async function unsubscribeCodexLeadThread(
	args: SubscriptionClientArgs & { threadId: string; reason: string },
): Promise<boolean> {
	const request = {
		version: 2,
		method: "unsubscribeThread",
		leadId: args.leadId,
		threadId: args.threadId,
		reason: args.reason,
	} as const;
	const response = (await subscriptionRequest(args, request)) as {
		removed: boolean;
	};
	return response.removed;
}

export async function engageCodexLeadProactiveTopic(
	args: SubscriptionClientArgs & ProactiveTopicReceipt,
): Promise<{ engagement: "pending" | "ready"; threadId: string }> {
	const request = {
		version: 2,
		method: "engageProactiveTopic",
		leadId: args.leadId,
		socketOwnerId: args.socketOwnerId,
		parentChannelId: args.parentChannelId,
		messageId: args.messageId,
		eventId: args.eventId,
		payloadHash: args.payloadHash,
	} as const;
	const response = (await subscriptionRequest(args, request)) as {
		engagement: unknown;
		threadId: unknown;
	};
	if (
		(response.engagement !== "pending" && response.engagement !== "ready") ||
		response.threadId !== args.messageId
	)
		throw new Error("invalid proactive receipt response");
	return { engagement: response.engagement, threadId: args.messageId };
}

export async function applyCodexLeadRuntimeConfig(
	args: SubscriptionClientArgs & { target: LeadRuntimeConfigTarget },
): Promise<LeadRuntimeConfigResult> {
	const response = await runtimeConfigRequest(args, "applyRuntimeConfig");
	if (
		!response ||
		typeof response !== "object" ||
		!["applied", "pending_runtime", "drifted"].includes(
			String((response as { status?: unknown }).status),
		)
	)
		throw new Error("invalid runtime configuration response");
	const result = response as LeadRuntimeConfigResult;
	if (
		result.operationId !== args.target.operationId ||
		(result.status === "applied" &&
			(JSON.stringify(runtimeConfigTarget(result)) !==
				JSON.stringify(runtimeConfigTarget(args.target)) ||
				!Number.isFinite(Date.parse(result.appliedAt))))
	)
		throw new Error("runtime configuration receipt binding mismatch");
	return result;
}
export async function readCodexLeadRuntimeConfig(
	args: SubscriptionClientArgs & { target: LeadRuntimeConfigTarget },
): Promise<LeadRuntimeReadback> {
	const response = (await runtimeConfigRequest(args, "readRuntimeConfig")) as {
		drifted?: unknown;
		observation?: unknown;
		model?: unknown;
		effort?: unknown;
	};
	if (
		!response ||
		typeof response.model !== "string" ||
		!response.model ||
		typeof response.effort !== "string" ||
		!response.effort ||
		(response.drifted !== undefined && typeof response.drifted !== "boolean")
	)
		throw new Error("invalid runtime settings response");
	if (
		response.observation !== undefined &&
		!validLeadTurnObservation(response.observation, args.target)
	)
		throw new Error("invalid runtime observation response");
	return {
		...(response.observation
			? {
					observation:
						response.observation as LeadRuntimeReadback["observation"],
				}
			: {}),
		model: response.model,
		effort: response.effort,
		...(response.drifted === undefined ? {} : { drifted: response.drifted }),
	};
}
async function runtimeConfigRequest(
	args: SubscriptionClientArgs & { target: LeadRuntimeConfigTarget },
	method: RuntimeConfigRequest["method"],
): Promise<unknown> {
	const request: Omit<RuntimeConfigRequest, "auth"> = {
		version: 2,
		method,
		leadId: args.leadId,
		socketOwnerId: args.target.carrierId,
		...runtimeConfigTarget(args.target),
	};
	const signed = { ...request, auth: signRequest(request, args.authSecret) };
	const body = JSON.stringify(signed);
	if (Buffer.byteLength(body) > 16 * 1024)
		throw new Error("runtime configuration request too large");
	const response = JSON.parse(
		await requestResponse(
			args.socketPath,
			`${body}\n`,
			args.timeoutMs ?? 15_000,
		),
	);
	if (!response.ok) throw new CodexLeadInboxRejectedError(response.error);
	return response.result;
}

async function subscriptionRequest(
	args: SubscriptionClientArgs,
	request:
		| Omit<ListSubscriptionsRequest, "auth">
		| Omit<UnsubscribeThreadRequest, "auth">
		| Omit<EngageProactiveTopicRequest, "auth">,
): Promise<unknown> {
	const signed = { ...request, auth: signRequest(request, args.authSecret) };
	const response = JSON.parse(
		await requestResponse(
			args.socketPath,
			`${JSON.stringify(signed)}\n`,
			args.timeoutMs ?? 5_000,
		),
	);
	if (!response.ok) throw new CodexLeadInboxRejectedError(response.error);
	return response;
}

function parseRequest(raw: string): InboxRequest {
	const value = JSON.parse(raw.trim()) as Partial<InboxRequest>;
	if (
		value?.method === "applyRuntimeConfig" ||
		value?.method === "readRuntimeConfig"
	) {
		const fields = [
			"projectName",
			"leadKey",
			"identityDigest",
			"carrierId",
			"ownerEpoch",
			"runtimeGeneration",
			"threadId",
			"operationId",
			"configDigest",
			"modelRegistryRevision",
			"model",
			"effort",
		] as const;
		const allowed = [
			"version",
			"method",
			"leadId",
			"socketOwnerId",
			"auth",
			"configGeneration",
			...fields,
		];
		if (
			Buffer.byteLength(raw) > 16 * 1024 ||
			value.version !== 2 ||
			["leadId", "socketOwnerId", "auth", ...fields].some((field) => {
				const item = (value as Record<string, unknown>)[field];
				return typeof item !== "string" || !item.trim() || item.length > 512;
			}) ||
			!Number.isSafeInteger(value.configGeneration) ||
			Number(value.configGeneration) < 1 ||
			Object.keys(value).some((field) => !allowed.includes(field))
		)
			throw new Error("malformed runtime configuration request");
		return value as RuntimeConfigRequest;
	}

	if (value?.method === "probeVoiceSelfFilter") {
		const { contractVersion, ...request } = value;
		if (
			Buffer.byteLength(raw) > VOICE_SELF_FILTER_MAX_BYTES ||
			value.version !== 2 ||
			contractVersion !== 1 ||
			!validVoiceSelfFilterRequestFields({ ...request, version: 1 })
		)
			throw new Error("self_filter_invalid_request");
		return value as VoiceSelfFilterRequest;
	}
	if (value?.method === "engageProactiveTopic") {
		const keys = [
			"version",
			"method",
			"leadId",
			"auth",
			"socketOwnerId",
			"parentChannelId",
			"messageId",
			"eventId",
			"payloadHash",
		];
		if (
			value.version !== 2 ||
			typeof value.leadId !== "string" ||
			!value.leadId.trim() ||
			typeof value.auth !== "string" ||
			typeof value.socketOwnerId !== "string" ||
			!value.socketOwnerId.trim() ||
			typeof value.eventId !== "string" ||
			!value.eventId.trim() ||
			value.eventId.length > 512 ||
			typeof value.payloadHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.payloadHash) ||
			typeof value.parentChannelId !== "string" ||
			!/^\d{17,20}$/.test(value.parentChannelId) ||
			typeof value.messageId !== "string" ||
			!/^\d{17,20}$/.test(value.messageId) ||
			Object.keys(value).some((k) => !keys.includes(k))
		)
			throw new Error("malformed proactive topic request");
		return value as EngageProactiveTopicRequest;
	}
	if (
		value?.method === "listSubscriptions" ||
		value?.method === "unsubscribeThread"
	) {
		const keys =
			value.method === "listSubscriptions"
				? ["version", "method", "leadId", "auth"]
				: ["version", "method", "leadId", "auth", "threadId", "reason"];
		if (
			value.version !== 2 ||
			typeof value.leadId !== "string" ||
			!value.leadId.trim() ||
			typeof value.auth !== "string" ||
			Object.keys(value).some((key) => !keys.includes(key)) ||
			(value.method === "unsubscribeThread" &&
				(typeof value.threadId !== "string" ||
					!/^\d{17,20}$/.test(value.threadId) ||
					typeof value.reason !== "string" ||
					!value.reason.trim()))
		)
			throw new Error("malformed subscription request");
		return value as ListSubscriptionsRequest | UnsubscribeThreadRequest;
	}
	if (value?.method === "readTurnState") {
		const keys = ["version", "method", "leadId", "auth"];
		if (
			value.version !== 2 ||
			typeof value.leadId !== "string" ||
			!value.leadId.trim() ||
			typeof value.auth !== "string" ||
			Object.keys(value).some((key) => !keys.includes(key))
		)
			throw new Error("malformed turn state request");
		return value as ReadTurnStateRequest;
	}
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
	| Omit<RuntimeConfigRequest, "auth">
	| Omit<VoiceSelfFilterRequest, "auth">
	| Omit<SubmitBatchRequest, "auth">
	| Omit<CapabilitiesRequest, "auth">
	| Omit<ReadTurnStateRequest, "auth">
	| Omit<ListSubscriptionsRequest, "auth">
	| Omit<UnsubscribeThreadRequest, "auth">
	| Omit<EngageProactiveTopicRequest, "auth">;

function canonicalRequest(request: UnsignedInboxRequest): string {
	if (
		request.method === "applyRuntimeConfig" ||
		request.method === "readRuntimeConfig"
	) {
		return JSON.stringify({
			version: request.version,
			method: request.method,
			leadId: request.leadId,
			socketOwnerId: request.socketOwnerId,
			...runtimeConfigTarget(request),
		});
	}

	if (request.method === "probeVoiceSelfFilter")
		return canonicalVoiceSelfFilterRequest(request);
	if (request.method === "engageProactiveTopic")
		return JSON.stringify({
			version: request.version,
			method: request.method,
			leadId: request.leadId,
			socketOwnerId: request.socketOwnerId,
			parentChannelId: request.parentChannelId,
			messageId: request.messageId,
			eventId: request.eventId,
			payloadHash: request.payloadHash,
		});
	if (request.method === "unsubscribeThread")
		return JSON.stringify({
			version: request.version,
			method: request.method,
			leadId: request.leadId,
			threadId: request.threadId,
			reason: request.reason,
		});
	if (
		request.method === "capabilities" ||
		request.method === "readTurnState" ||
		request.method === "listSubscriptions"
	)
		return JSON.stringify({
			version: request.version,
			method: request.method,
			leadId: request.leadId,
		});
	if (request.method !== "submitBatch")
		throw new Error("unsupported inbox method");
	return JSON.stringify({
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
	const expected = Buffer.from(signRequest(request, authSecret), "hex");
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
