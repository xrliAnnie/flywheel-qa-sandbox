import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { dirname, isAbsolute } from "node:path";
import { type DagPorts, DISCORD_MESSENGER_AGENT_ID } from "flywheel-v2-dag";
import {
	type AttemptHandle,
	type ConversionResult,
	classifySessionProcess,
	type Effect,
	EngineDriver,
	type EngineRuntime,
	enqueue,
	isSessionRecipient,
	type ProposalAuthorization,
	provisionAgentRecipient,
	type RegisteredAgent,
	readProposalReceipt,
	type SessionBinding,
	type SessionEvidenceProbe,
	submitProposal as settleProposal,
} from "flywheel-v2-engine";
import {
	type ExistingDatabaseOptions,
	FenceViolation,
	type Kernel,
	openExistingKernel,
	readCutoverAuthority,
} from "flywheel-v2-kernel";
import {
	type CoordinatorTickResult,
	V2RuntimeCoordinator,
} from "./coordinator.js";
import {
	type DeliveryEnvelope,
	pollRunnerDelivery,
	prepareDelivery,
	recordDeliverySucceeded,
	requireActiveRunnerAgent,
} from "./delivery.js";
import {
	HOST_PROTOCOL_VERSION,
	type HostRequest,
	type HostResponse,
	MAX_HOST_FRAME_BYTES,
	verifyHostRequest,
} from "./protocol.js";

export {
	DELIVERY_PROTOCOL,
	type DeliveryEnvelope,
	deliveryActionId,
	deliveryLogicalEffectId,
} from "./delivery.js";

interface PendingDelivery {
	handle: AttemptHandle;
	resolve(result: ConversionResult): void;
	reject(error: unknown): void;
	envelope?: DeliveryEnvelope;
}

/**
 * Codex R3 HIGH-2: a pull delivery is authorised by a credential minted for one
 * registration, not by the global host secret plus a self-declared agentId.
 *
 * Every runner is handed FLYWHEEL_V2_SECRET_PATH, so the secret alone proves
 * only "some v2 process"; naming a lead's agentId then let a runner pull that
 * lead's envelope -- along with the bearer proposal capability inside it -- and
 * submit effects as the lead. The credential is minted inside #registerLead,
 * which is the only path that proves live session identity, and it is returned
 * exactly once over the authenticated socket that asked for it.
 *
 * ACCEPTED DESIGN BOUNDARY -- founder ruling, 2026-07-29 (Codex R4 HIGH-1).
 *
 * Every runner is handed FLYWHEEL_V2_SECRET_PATH, so the global secret proves
 * only "some v2 process", not which agent. #registerLead therefore accepts any
 * agentId, and a co-resident process could register as a lead. That is accepted:
 * every runner is dispatched by us and runs on the founder's own machine, so a
 * hostile same-uid runner has no realistic source. Do not add a partial
 * authorization check here -- it would read as a boundary while changing nothing.
 *
 * What the credential below is actually for, and why it stays: binding a pull to
 * one registration. It stops a superseded generation from being served an envelope
 * after a takeover, and it makes a stale credential a loud fence violation rather
 * than a silent cross-generation delivery. Those are correctness properties, not
 * defences against a hostile co-resident process.
 */
interface DeliveryCredentialRecord {
	credentialId: string;
	token: Buffer;
	agentId: string;
	instanceId: string;
	generation: number;
}

/**
 * Codex R3 HIGH-2: waiters are bound to the exact identity that created them.
 * A waiter keyed on agentId alone outlived its session by up to the long-poll
 * timeout, so a superseded generation's waiter could take the new generation's
 * first envelope -- and, holding a dead capability, strand it.
 */
interface DeliveryWaiter {
	agentId: string;
	instanceId: string;
	generation: number;
	credentialId: string;
	accept(envelope: DeliveryEnvelope): void;
	cancel(error: Error): void;
}

/**
 * A response whose durable record waits until the frame has left this process.
 * #handleFrame calls afterWrite once the write is flushed, or with `false` if the
 * write failed, so a dead connection requeues instead of consuming the envelope.
 *
 * ACCEPTED DESIGN BOUNDARY -- founder ruling, 2026-07-29 (Codex R4 HIGH-3).
 *
 * A flushed write is NOT an application-level ACK: it proves the bytes reached the
 * kernel, not that the client read or persisted them. A client that dies after the
 * flush leaves a delivery recorded succeeded with no proposal; a socket error that
 * wins the race against a client which did read causes a requeue and a duplicate.
 *
 * Accepted because the failure is bounded rather than terminal. The processing
 * attempt stays `running`, so the next crash-settle -- driver.stop(), a generation
 * takeover, or the settled-pending sweep -- reschedules the message, and the
 * attempt-scoped delivery scope added in this PR means the redelivery now
 * succeeds instead of colliding. The cost is a delay until that settle, not a lost
 * message. An ACK protocol would narrow the window; it is not required for
 * correctness here. Do not describe the flush as equivalent to an ACK.
 */
interface DispatchOutcome {
	result: unknown;
	afterWrite?(flushed: boolean): void;
}

interface PreparedDelivery {
	handle: AttemptHandle;
	deliveryActionId: string;
	envelope?: DeliveryEnvelope;
}

export interface V2HostOptions {
	database: ExistingDatabaseOptions;
	socketPath: string;
	secretPath: string;
	hostEpoch: string;
	sessionProbe: SessionEvidenceProbe;
	coordinator?: {
		createPorts(kernel: Kernel): DagPorts;
		intervalMs: number;
		onError?(error: unknown): void;
		activateSession?(sessionRef: string): Promise<void>;
	};
}

interface AgentRow {
	kind: string;
	generation: number;
	instance_id: string | null;
	session_binding: string | null;
}

interface ActiveSessionRow {
	session_ref: string;
	session_binding: string;
}

interface SubmitPayload {
	agentId: string;
	attemptUid: string;
	messageUid: string;
	effects: Effect[];
	authorization: ProposalAuthorization;
}

const MAX_NONCES = 10_000;

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value;
}

function requireInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
	return value as number;
}

function parseSessionBinding(value: unknown): SessionBinding {
	const input = requireRecord(value, "sessionBinding");
	if (
		Object.keys(input).sort().join(",") !==
			"hostEpoch,pid,pidStart,sessionId,v" ||
		input.v !== 1
	) {
		throw new TypeError("sessionBinding has an invalid shape");
	}
	return {
		v: 1,
		hostEpoch: requireString(input.hostEpoch, "sessionBinding.hostEpoch"),
		sessionId: requireString(input.sessionId, "sessionBinding.sessionId"),
		pid: requireInteger(input.pid, "sessionBinding.pid"),
		pidStart: requireString(input.pidStart, "sessionBinding.pidStart"),
	};
}

function storedBinding(binding: SessionBinding): string {
	return JSON.stringify({
		v: 1,
		host_epoch: binding.hostEpoch,
		session_id: binding.sessionId,
		pid: binding.pid,
		pid_start: binding.pidStart,
	});
}

function parseStoredBinding(value: string): SessionBinding {
	const input = requireRecord(JSON.parse(value), "stored session binding");
	if (
		Object.keys(input).sort().join(",") !==
			"host_epoch,pid,pid_start,session_id,v" ||
		input.v !== 1
	) {
		throw new TypeError("stored session binding has an invalid shape");
	}
	return {
		v: 1,
		hostEpoch: requireString(input.host_epoch, "stored binding host_epoch"),
		sessionId: requireString(input.session_id, "stored binding session_id"),
		pid: requireInteger(input.pid, "stored binding pid"),
		pidStart: requireString(input.pid_start, "stored binding pid_start"),
	};
}

function parseEffects(value: unknown): Effect[] {
	if (!Array.isArray(value)) throw new TypeError("effects must be an array");
	return value.map((entry, index) => {
		const effect = requireRecord(entry, `effects[${index}]`);
		if (effect.kind === "event") {
			return {
				kind: "event",
				eventKind: requireString(
					effect.eventKind,
					`effects[${index}].eventKind`,
				),
				payload: requireString(effect.payload, `effects[${index}].payload`),
			};
		}
		if (effect.kind === "task") {
			const state = effect.state;
			if (state !== "draft" && state !== "ready") {
				throw new TypeError(`effects[${index}].state is invalid`);
			}
			return {
				kind: "task",
				taskKind: requireString(effect.taskKind, `effects[${index}].taskKind`),
				state,
				payload: requireString(effect.payload, `effects[${index}].payload`),
				projectId: requireString(
					effect.projectId,
					`effects[${index}].projectId`,
				),
				...(effect.lineageRootTaskId === undefined
					? {}
					: {
							lineageRootTaskId: requireString(
								effect.lineageRootTaskId,
								`effects[${index}].lineageRootTaskId`,
							),
						}),
			};
		}
		throw new TypeError(`effects[${index}].kind is invalid`);
	});
}

function assertLiveBinding(
	binding: SessionBinding,
	hostEpoch: string,
	probe: SessionEvidenceProbe,
): void {
	if (binding.hostEpoch !== hostEpoch) {
		throw new FenceViolation("session binding host epoch mismatch");
	}
	if (
		classifySessionProcess(
			probe.processStart(binding.pid),
			binding.pidStart,
		) !== "same_process"
	) {
		throw new FenceViolation("session binding process start identity mismatch");
	}
	const owner = probe.sessionOwner(binding.sessionId);
	if (
		!owner ||
		owner.pid !== binding.pid ||
		owner.pidStart !== binding.pidStart
	) {
		throw new FenceViolation("session binding owner mismatch");
	}
}

function nowRuntime(): EngineRuntime {
	return {
		clock: {
			nowMs: () => Date.now(),
			nowIso: () => new Date().toISOString(),
		},
	};
}

async function socketIsLive(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.end();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/**
 * Codex R3 HIGH-2: `afterWrite` runs only once the frame has actually left this
 * process, so a delivery is never recorded as consumed on a connection that
 * could not receive it. `socket.write`'s callback is the strongest confirmation
 * available without changing the client protocol; a failed or destroyed socket
 * reports `false` so the caller can requeue.
 */
export function writeResponse(
	socket: Socket,
	response: HostResponse,
	afterWrite?: (flushed: boolean) => void,
): void {
	const frame = `${JSON.stringify(response)}\n`;
	if (!afterWrite) {
		socket.end(frame);
		return;
	}
	let settled = false;
	const settle = (flushed: boolean) => {
		if (settled) return;
		settled = true;
		// This runs inside a socket write callback and inside 'error'/'close'
		// handlers, so a throwing callback would escape into the event loop as an
		// uncaught exception and take the host down. The caller reports its own
		// failures; here the only job is to never crash the process.
		try {
			afterWrite(flushed);
		} catch {
			// deliberately swallowed: see above
		}
	};
	socket.once("error", () => settle(false));
	socket.once("close", () => settle(false));
	if (socket.destroyed || socket.writableEnded) {
		settle(false);
		return;
	}
	socket.write(frame, (error) => {
		settle(!error);
		socket.end();
	});
}

export class V2Host {
	readonly #options: V2HostOptions;
	readonly #runtime = nowRuntime();
	readonly #kernel: Kernel;
	readonly #driver: EngineDriver;
	readonly #secret: Buffer;
	readonly #registered = new Map<string, RegisteredAgent>();
	readonly #pending = new Map<string, PendingDelivery>();
	readonly #deliveries = new Map<string, DeliveryEnvelope[]>();
	readonly #deliveryWaiters = new Map<string, DeliveryWaiter[]>();
	/** FLY-1543 ④: long-poll wakers for session recipients (`next --session`). */
	readonly #sessionWakers = new Map<string, Set<() => void>>();
	readonly #deliveryCredentials = new Map<string, DeliveryCredentialRecord>();
	readonly #sockets = new Set<Socket>();
	/** Codex R6 HIGH-1: whether the dispatch loop actually started. */
	#coordinatorArmed = false;
	readonly #nonces = new Set<string>();
	readonly #coordinator?: V2RuntimeCoordinator;
	#server?: Server;
	#coordinatorTimer?: ReturnType<typeof setInterval>;

	constructor(options: V2HostOptions) {
		this.#options = options;
		for (const [name, path] of [
			["socketPath", options.socketPath],
			["secretPath", options.secretPath],
		] as const) {
			if (!isAbsolute(path)) throw new TypeError(`${name} must be absolute`);
		}
		if (
			!options.database.allowedAuthorityStates.includes("cutover") &&
			!options.database.allowedAuthorityStates.includes("live")
		) {
			throw new TypeError("host requires cutover or live authority");
		}
		const secretMode = statSync(options.secretPath).mode & 0o777;
		if (secretMode !== 0o600) {
			throw new Error("host IPC secret must be mode 0600");
		}
		this.#secret = readFileSync(options.secretPath);
		if (this.#secret.length < 32) {
			throw new Error("host IPC secret must contain at least 32 bytes");
		}
		this.#kernel = openExistingKernel(options.database);
		this.#driver = new EngineDriver(this.#kernel, this.#runtime, {
			requireProposalCapability: true,
		});
		if (options.coordinator) {
			if (
				!Number.isSafeInteger(options.coordinator.intervalMs) ||
				options.coordinator.intervalMs < 100 ||
				options.coordinator.intervalMs > 60_000
			) {
				throw new TypeError(
					"coordinator interval must be an integer in 100..60000ms",
				);
			}
			this.#coordinator = new V2RuntimeCoordinator({
				kernel: this.#kernel,
				ports: options.coordinator.createPorts(this.#kernel),
				authorityState: () => this.#authorityState(),
			});
		}
	}

	async start(): Promise<void> {
		if (this.#server) throw new Error("v2 host is already started");
		const socketDir = dirname(this.#options.socketPath);
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });
		chmodSync(socketDir, 0o700);
		if ((statSync(socketDir).mode & 0o777) !== 0o700) {
			throw new Error("host socket directory must be mode 0700");
		}
		if (existsSync(this.#options.socketPath)) {
			if (await socketIsLive(this.#options.socketPath)) {
				throw new Error("a live v2 host already owns the socket");
			}
			unlinkSync(this.#options.socketPath);
		}
		const server = createServer((socket) => this.#accept(socket));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.#options.socketPath, resolve);
		});
		chmodSync(this.#options.socketPath, 0o600);
		this.#server = server;
		// Codex R6 HIGH-1: everything past the listen must be FATAL if it fails.
		//
		// The socket is already published here, so an exception thrown below used to
		// leave a process that answers requests but has no coordinator: nothing is
		// ever dispatched, no runner is ever served, and `health` still reports ok
		// because it only inspects authority. launchd KeepAlive sees a healthy process
		// and never restarts it, and the installer's health proof passes -- the engine
		// is silently dead with every signal green. The lead has seen this exact shape
		// in production: host alive, runner never serviced.
		//
		// Failing closed means tearing the listener down and propagating, so the
		// process exits non-zero and the supervisor restarts it.
		try {
			if (this.#coordinator && this.#authorityState() === "live") {
				await this.#syncCurrentRunners();
			}
			if (this.#coordinator && this.#options.coordinator) {
				const tick = () => {
					void this.#runCoordinatorTick().catch((error) => {
						if (this.#options.coordinator?.onError) {
							this.#options.coordinator.onError(error);
							return;
						}
						queueMicrotask(() => {
							throw error;
						});
					});
				};
				this.#coordinatorTimer = setInterval(
					tick,
					this.#options.coordinator.intervalMs,
				);
				tick();
				// Only now is the host actually able to do its job.
				this.#coordinatorArmed = true;
			}
		} catch (error) {
			await this.close().catch(() => undefined);
			throw error;
		}
	}

	get #coordinatorExpected(): boolean {
		return (
			this.#coordinator !== undefined && this.#options.coordinator !== undefined
		);
	}

	async close(): Promise<void> {
		this.#coordinatorArmed = false;
		if (this.#coordinatorTimer) {
			clearInterval(this.#coordinatorTimer);
			this.#coordinatorTimer = undefined;
		}
		const server = this.#server;
		this.#server = undefined;
		// Codex R4 MEDIUM-1: revoke and tear down BEFORE waiting on the server. The
		// old order awaited server.close() first, which waits for open connections to
		// end -- so a half-frame connection blocked every step below it indefinitely.
		for (const pending of this.#pending.values()) {
			pending.reject(new Error("v2 host is closing"));
		}
		this.#pending.clear();
		// A long poll must not survive the host that owns it, and a credential must
		// not outlive the registration state it was checked against.
		for (const waiters of [...this.#deliveryWaiters.values()]) {
			for (const waiter of [...waiters]) {
				waiter.cancel(new Error("v2 host is closing"));
			}
		}
		this.#deliveryWaiters.clear();
		// Session wakers resolve to "not woken"; their sockets are destroyed below
		// and each pending long-poll ends with the timeout error.
		this.#sessionWakers.clear();
		this.#deliveryCredentials.clear();
		if (server) {
			// Stop accepting, then destroy what is already connected so the wait below
			// is bounded by this process rather than by whatever a client chooses to do.
			const closed = new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			for (const socket of [...this.#sockets]) socket.destroy();
			this.#sockets.clear();
			await closed;
		}
		try {
			this.#driver.stop();
		} finally {
			this.#kernel.close();
			if (existsSync(this.#options.socketPath)) {
				unlinkSync(this.#options.socketPath);
			}
		}
	}

	runCoordinatorOnce(): Promise<CoordinatorTickResult> {
		if (!this.#coordinator) {
			throw new Error("v2 host coordinator is not configured");
		}
		return this.#runCoordinatorTick();
	}

	async #runCoordinatorTick(): Promise<CoordinatorTickResult> {
		if (!this.#coordinator) {
			throw new Error("v2 host coordinator is not configured");
		}
		const result = await this.#coordinator.tick();
		if (result.status === "ran") await this.#syncCurrentRunners();
		return result;
	}

	#bindingHasLiveEvidence(binding: SessionBinding): boolean {
		if (
			binding.hostEpoch !== this.#options.hostEpoch ||
			classifySessionProcess(
				this.#options.sessionProbe.processStart(binding.pid),
				binding.pidStart,
			) !== "same_process"
		) {
			return false;
		}
		const owner = this.#options.sessionProbe.sessionOwner(binding.sessionId);
		return owner?.pid === binding.pid && owner.pidStart === binding.pidStart;
	}

	/**
	 * FLY-1543 ④⑤: runners never attach to the driver. The only per-tick duty
	 * left is releasing the launch gate (and, for Codex, ensuring the thread) of
	 * every live bound session -- delivery is pull-only through `next --session`
	 * and needs no host-side pump.
	 */
	async #syncCurrentRunners(): Promise<void> {
		const rows = this.#kernel.read((tx) =>
			tx.all<ActiveSessionRow>(
				`SELECT session_ref,session_binding
				   FROM activations
				  WHERE state='active' AND session_binding IS NOT NULL
				  ORDER BY session_ref`,
			),
		);
		for (const row of rows) {
			const binding = parseStoredBinding(row.session_binding);
			if (
				binding.sessionId !== row.session_ref ||
				!this.#bindingHasLiveEvidence(binding)
			) {
				continue;
			}
			await this.#options.coordinator?.activateSession?.(row.session_ref);
		}
	}

	#accept(socket: Socket): void {
		// Codex R4 MEDIUM-1: every accepted socket is tracked so close() can destroy
		// it. server.close() only stops accepting and then waits for open connections
		// to end, so a same-uid process that connects and sends half a frame -- never
		// a newline -- kept the host alive forever: no waiter cancellation, no
		// credential revocation, no driver.stop(), no crash-settle, no db close.
		this.#sockets.add(socket);
		socket.once("close", () => this.#sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffered = "";
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			if (Buffer.byteLength(buffered, "utf8") > MAX_HOST_FRAME_BYTES) {
				socket.destroy(new Error("host request exceeds frame limit"));
				return;
			}
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			socket.pause();
			const raw = buffered.slice(0, newline);
			void this.#handleFrame(socket, raw);
		});
	}

	async #handleFrame(socket: Socket, raw: string): Promise<void> {
		let id = "unknown";
		try {
			const request = JSON.parse(raw) as HostRequest;
			id = typeof request.id === "string" ? request.id : id;
			verifyHostRequest(request, this.#secret);
			if (this.#nonces.has(request.nonce)) {
				throw new Error("host request nonce was already used");
			}
			this.#nonces.add(request.nonce);
			if (this.#nonces.size > MAX_NONCES) {
				const oldest = this.#nonces.values().next().value as string | undefined;
				if (oldest) this.#nonces.delete(oldest);
			}
			const outcome = await this.#dispatch(
				request.action,
				request.payload,
				socket,
			);
			const { afterWrite } = outcome;
			writeResponse(
				socket,
				{
					v: HOST_PROTOCOL_VERSION,
					id: request.id,
					ok: true,
					result: outcome.result,
				},
				afterWrite &&
					((flushed: boolean) => {
						// Recording the delivery outcome touches the kernel, so it can fail.
						// It runs from a socket callback, where an escaping exception is an
						// uncaught exception. Route it to the configured error sink instead:
						// the delivery escaped but is not recorded succeeded, which is
						// exactly the ambiguity the envelope's retryCaveat describes.
						try {
							afterWrite(flushed);
						} catch (error) {
							this.#options.coordinator?.onError?.(error);
						}
					}),
			);
		} catch (error) {
			writeResponse(socket, {
				v: HOST_PROTOCOL_VERSION,
				id,
				ok: false,
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	async #dispatch(
		action: string,
		payload: unknown,
		socket: Socket,
	): Promise<DispatchOutcome> {
		const databaseAuthorityState = this.#authorityState();
		switch (action) {
			case "health":
				return {
					result: {
						// Codex R6 HIGH-1: authority alone was not enough to call a host
						// healthy. A host whose coordinator never armed dispatches nothing,
						// so say so rather than reporting ok and letting a supervisor and an
						// installer both conclude the engine is fine.
						status:
							databaseAuthorityState !== "live"
								? "held"
								: this.#coordinatorExpected && !this.#coordinatorArmed
									? "degraded"
									: "ok",
						coordinator: this.#coordinatorExpected
							? this.#coordinatorArmed
								? "armed"
								: "not_armed"
							: "not_configured",
						hostEpoch: this.#options.hostEpoch,
						windowId: this.#options.database.expectedWindowId,
						epoch: this.#options.database.expectedEpoch,
					},
				};
			default:
				if (databaseAuthorityState !== "live") {
					throw new FenceViolation("v2 host is held until founder final GO");
				}
		}
		switch (action) {
			case "register_lead":
				return { result: await this.#registerLead(payload) };
			case "enqueue":
				return { result: this.#enqueue(payload) };
			case "ask":
				return { result: this.#ask(payload) };
			case "next_delivery":
				return this.#nextDelivery(payload, socket);
			case "submit_proposal":
				return { result: await this.#submitProposal(payload) };
			default:
				throw new TypeError(`unknown host action ${action}`);
		}
	}

	#authorityState(): "cutover" | "live" {
		const databaseAuthorityState = this.#kernel.read(
			(tx) =>
				tx.get<{ value: string }>(
					"SELECT value FROM meta WHERE key='cutover_authority_state'",
				)?.value,
		);
		if (
			databaseAuthorityState !== "cutover" &&
			databaseAuthorityState !== "live"
		) {
			throw new FenceViolation(
				"host database authority is missing or malformed",
			);
		}
		const machineAuthority = readCutoverAuthority({
			authorityPath: this.#options.database.authorityPath,
			armedPath: this.#options.database.armedPath,
			expectedWindowId: this.#options.database.expectedWindowId,
			expectedEpoch: this.#options.database.expectedEpoch,
		});
		if (
			machineAuthority.mode !== "armed" ||
			machineAuthority.authority.state !== databaseAuthorityState
		) {
			throw new FenceViolation(
				"host machine and database authority states disagree",
			);
		}
		return databaseAuthorityState;
	}

	/**
	 * FLY-1543 ①: registration IS the takeover. Three branches:
	 *
	 *   no current row / generation 0        -> fresh register
	 *   same session, byte-equal binding     -> reattach (generation unchanged)
	 *   anything else                        -> displace: register directly
	 *
	 * The death-evidence ceremony (client-asserted evidence, prior-binding
	 * probes, seven refusal paths) is deleted. Displacement itself is the safety
	 * mechanism: the superseded generation's delivery credential is revoked, its
	 * waiters are cancelled, its heartbeat CAS stops matching and its running
	 * attempts are crash-settled -- all through fences that already exist. A
	 * still-live old process is a shell that can no longer read mail or write
	 * the ledger. A same-uid impostor is an accepted design boundary (it already
	 * holds the host secret; founder ruling recorded on the FLY-1502 lane).
	 *
	 * assertLiveBinding stays: it validates the REGISTRANT's own live session,
	 * not the departed one's death.
	 */
	async #registerLead(payload: unknown): Promise<
		RegisteredAgent & {
			deliveryCredential: { credentialId: string; token: string };
		}
	> {
		const input = requireRecord(payload, "register_lead payload");
		const agentId = requireString(input.agentId, "agentId");
		const instanceId = requireString(input.instanceId, "instanceId");
		const sessionBinding = parseSessionBinding(input.sessionBinding);
		if (isSessionRecipient(agentId)) {
			throw new FenceViolation(
				"lead agent id must not use the v2dag: session namespace",
			);
		}
		assertLiveBinding(
			sessionBinding,
			this.#options.hostEpoch,
			this.#options.sessionProbe,
		);
		const converter = this.#converter(agentId);
		const current = this.#kernel.read((tx) =>
			tx.get<AgentRow>(
				`SELECT kind,generation,instance_id,session_binding
				 FROM agents WHERE agent_id=@agentId`,
				{ agentId },
			),
		);
		let agent: RegisteredAgent;
		if (!current || current.generation === 0) {
			provisionAgentRecipient(this.#kernel, agentId, "lead");
			agent = await this.#driver.registerLead(
				agentId,
				{
					kind: "lead",
					leadId: agentId,
					instanceId,
					sessionBinding,
				},
				converter,
			);
		} else if (
			current.kind === "lead" &&
			current.instance_id === instanceId &&
			current.session_binding === storedBinding(sessionBinding)
		) {
			// A reattach means this process is now the attachment of record, so any
			// credential or waiter left by a previous attachment of the same generation
			// is no longer the caller and must not keep pull access.
			this.#revokeSupersededAccess(agentId, current.generation);
			agent = await this.#driver.reattachLead(
				agentId,
				{
					kind: "lead",
					agentId,
					instanceId,
					generation: current.generation,
					sessionBinding,
				},
				converter,
				this.#options.hostEpoch,
				this.#options.sessionProbe,
			);
		} else {
			if (current.kind !== "lead") {
				throw new FenceViolation(`agent kind collision for ${agentId}`);
			}
			// Codex R3 HIGH-2 (FLY-1503, kept): revoke the superseded generation's
			// pull access BEFORE driver.registerLead, because it starts the new
			// generation's handler before it returns -- an old waiter still eligible
			// at that moment could take the new generation's first envelope.
			this.#revokeSupersededAccess(agentId, current.generation);
			agent = await this.#driver.registerLead(
				agentId,
				{
					kind: "lead",
					leadId: agentId,
					instanceId,
					sessionBinding,
				},
				converter,
			);
			// Any pending promise or queued envelope still held for this lead
			// belongs to the superseded generation and carries a dead capability.
			this.#discardSupersededDeliveries(agentId, current.generation);
		}
		this.#registered.set(agentId, agent);
		// Codex R3 HIGH-2: the credential is minted here, on the only path that
		// proves live session identity, and returned exactly once over the
		// authenticated connection that registered.
		return {
			...agent,
			deliveryCredential: this.#mintDeliveryCredential(agent),
		};
	}

	#prepareDelivery(
		message: DeliveryEnvelope["message"],
		handle: AttemptHandle,
	): PreparedDelivery {
		return prepareDelivery(
			this.#kernel,
			this.#runtime,
			this.#options.database.expectedEpoch,
			message,
			handle,
		);
	}

	#recordDeliverySucceeded(delivery: DeliveryEnvelope): void {
		recordDeliverySucceeded(this.#kernel, delivery);
	}

	#converter(agentId: string) {
		return async (
			message: DeliveryEnvelope["message"],
			context: { handle: AttemptHandle },
		): Promise<ConversionResult> => {
			const prepared = this.#prepareDelivery(message, context.handle);
			return new Promise<ConversionResult>((resolve, reject) => {
				const pending: PendingDelivery = {
					handle: context.handle,
					resolve,
					reject,
					...(prepared.envelope ? { envelope: prepared.envelope } : {}),
				};
				this.#pending.set(context.handle.attemptUid, pending);
				const envelope = prepared.envelope;
				if (!envelope) return;
				this.#handOffOrQueue(agentId, envelope);
			});
		};
	}

	/**
	 * Codex R3 HIGH-2: hand the envelope only to a waiter registered by the SAME
	 * instance and generation it was prepared for. The previous `.shift()` took
	 * whichever waiter happened to be first under this agentId, so a superseded
	 * generation's long poll -- holding a capability the kernel will refuse --
	 * could swallow the new generation's first delivery. Non-matching waiters are
	 * left in place to be cancelled or to time out on their own.
	 */
	#handOffOrQueue(agentId: string, envelope: DeliveryEnvelope): void {
		const waiters = this.#deliveryWaiters.get(agentId) ?? [];
		const match = waiters.find(
			(waiter) =>
				waiter.instanceId === envelope.handle.agent.instanceId &&
				waiter.generation === envelope.handle.agent.generation,
		);
		if (match) {
			match.accept(envelope);
			return;
		}
		const queue = this.#deliveries.get(agentId) ?? [];
		queue.push(envelope);
		this.#deliveries.set(agentId, queue);
	}

	#enqueue(payload: unknown): unknown {
		const input = requireRecord(payload, "enqueue payload");
		const toAgent = requireString(input.toAgent, "toAgent");
		const sourceKind = requireString(input.sourceKind, "sourceKind");
		if (sourceKind === "discord" && !isSessionRecipient(toAgent)) {
			provisionAgentRecipient(this.#kernel, toAgent, "lead");
		}
		const result = enqueue(this.#kernel, this.#runtime, {
			sourceKind,
			sourceId: requireString(input.sourceId, "sourceId"),
			payload: requireString(input.payload, "payload"),
			toAgent,
			kind: requireString(input.kind, "kind"),
			retentionClass:
				input.retentionClass === "notice" ||
				input.retentionClass === "business" ||
				input.retentionClass === "dlq"
					? input.retentionClass
					: (() => {
							throw new TypeError("retentionClass is invalid");
						})(),
			expectedCutoverEpoch: this.#options.database.expectedEpoch,
		});
		if (result.status === "enqueued") this.#wakeRecipient(toAgent);
		return result;
	}

	/**
	 * FLY-1543 ③④: one wake path for every enqueue. A session recipient's
	 * long-poll waiters are woken to re-poll; a lead recipient re-enters its
	 * driver drain loop (and gets the settled-pending sweep, same no-new-timer
	 * argument as before).
	 */
	#wakeRecipient(toAgent: string): void {
		if (isSessionRecipient(toAgent)) {
			const wakers = this.#sessionWakers.get(toAgent);
			if (!wakers) return;
			this.#sessionWakers.delete(toAgent);
			for (const wake of wakers) wake();
			return;
		}
		const registered = this.#registered.get(toAgent);
		if (!registered || registered.kind !== "lead") return;
		this.#dropSettledPending(toAgent);
		void this.#driver.drain(toAgent).catch(() => undefined);
	}

	/**
	 * FLY-1543 ③: the runner->lead upstream verb. The sender must be an ACTIVE
	 * session (terminal sessions are refused -- the upstream mirror of the
	 * anti-zombie delivery guard); the recipient is resolved SERVER-side from the
	 * session's issue (`dag_issue:<issueId>.notify_agent_id`), so a runner cannot
	 * address arbitrary recipients. The returned uid is the correlation key: the
	 * lead replies with `enqueue --to-agent <sessionRef> --kind ask_response` and
	 * a payload carrying the same uid.
	 */
	#ask(payload: unknown): unknown {
		const input = requireRecord(payload, "ask payload");
		const sessionRef = requireString(input.sessionRef, "sessionRef");
		const askKind = input.askKind;
		if (askKind !== "ask" && askKind !== "progress" && askKind !== "blocked") {
			throw new TypeError("askKind must be ask, progress or blocked");
		}
		const body = requireString(input.payload, "payload");
		const uid =
			input.uid === undefined ? randomUUID() : requireString(input.uid, "uid");
		const agent = requireActiveRunnerAgent(this.#kernel, sessionRef);
		const route = this.#kernel.read((tx) => {
			const row = tx.get<{ issue_id: string }>(
				`SELECT t.external_issue_id AS issue_id
				   FROM activations act
				   JOIN attempts a ON a.id=act.attempt_id
				   JOIN tasks t ON t.id=a.task_id
				  WHERE act.id=@activationId`,
				{ activationId: agent.activationId },
			);
			if (!row) {
				throw new FenceViolation("ask session has no task lineage");
			}
			const issue = tx.get<{ value: string }>(
				"SELECT value FROM meta WHERE key=@key",
				{ key: `dag_issue:${row.issue_id}` },
			);
			if (!issue) {
				throw new FenceViolation("ask session issue receipt is missing");
			}
			const envelope = requireRecord(
				JSON.parse(issue.value),
				"issue receipt envelope",
			);
			if (
				envelope.v !== 1 ||
				envelope.cutover_epoch !== this.#options.database.expectedEpoch
			) {
				throw new FenceViolation("ask session issue receipt is stale");
			}
			const data = requireRecord(envelope.data, "issue receipt data");
			return {
				issueId: row.issue_id,
				notifyAgentId: requireString(
					data.notify_agent_id,
					"issue notify_agent_id",
				),
			};
		});
		const result = enqueue(this.#kernel, this.#runtime, {
			sourceKind: "runner_upstream",
			sourceId: `${agent.activationId}:${uid}`,
			payload: JSON.stringify({
				v: 1,
				session_ref: sessionRef,
				issue_id: route.issueId,
				ask_kind: askKind,
				uid,
				body,
			}),
			toAgent: route.notifyAgentId,
			kind: "runner_ask",
			// A progress note is a notice (it rides the notice backpressure limit);
			// a question or a blocker is business traffic and must not be shed.
			retentionClass: askKind === "progress" ? "notice" : "business",
			expectedCutoverEpoch: this.#options.database.expectedEpoch,
		});
		if (result.status === "enqueued") this.#wakeRecipient(route.notifyAgentId);
		if (result.status === "rejected") {
			throw new FenceViolation(`ask was rejected: ${result.reason}`);
		}
		this.#relayAskToMessenger({
			sessionRef,
			issueId: route.issueId,
			askKind,
			uid,
			body,
			activationId: agent.activationId,
		});
		return { ...result, uid };
	}

	/**
	 * FLY-1544 ④: every runner ask/progress/blocked is mirrored into the
	 * Discord outbox so it lands in the issue's `[FLY-XXXX]` thread. The mirror
	 * never fails the ask itself: a notice-class shed (overload) is designed
	 * backpressure, and any other rejection is recorded as a visible event.
	 */
	#relayAskToMessenger(input: {
		sessionRef: string;
		issueId: string;
		askKind: "ask" | "progress" | "blocked";
		uid: string;
		body: string;
		activationId: string;
	}): void {
		provisionAgentRecipient(this.#kernel, DISCORD_MESSENGER_AGENT_ID, "lead");
		const relayed = enqueue(this.#kernel, this.#runtime, {
			sourceKind: "runner_upstream_relay",
			sourceId: `${input.activationId}:${input.uid}`,
			payload: JSON.stringify({
				v: 1,
				issue_id: input.issueId,
				session_ref: input.sessionRef,
				ask_kind: input.askKind,
				uid: input.uid,
				body: input.body,
			}),
			toAgent: DISCORD_MESSENGER_AGENT_ID,
			kind: "runner_ask",
			retentionClass: input.askKind === "progress" ? "notice" : "business",
			expectedCutoverEpoch: this.#options.database.expectedEpoch,
		});
		if (relayed.status === "enqueued") {
			this.#wakeRecipient(DISCORD_MESSENGER_AGENT_ID);
			return;
		}
		if (
			relayed.status === "rejected" &&
			!(relayed.reason === "overload" && input.askKind === "progress")
		) {
			this.#kernel.write("host.ask-relay-failed", (tx) => {
				tx.run(
					`INSERT OR IGNORE INTO events
					 (event_uid,task_id,attempt_id,kind,source_kind,source_id,payload,
					  cutover_epoch,created_at)
					 VALUES(@eventUid,NULL,NULL,'runner_ask_relay_failed','host',
					        @sourceId,@payload,@epoch,@now)`,
					{
						eventUid: `runner_ask_relay_failed:${input.activationId}:${input.uid}`,
						sourceId: `${input.activationId}:${input.uid}`,
						payload: JSON.stringify({
							issue_id: input.issueId,
							ask_kind: input.askKind,
							reason: relayed.reason,
						}),
						epoch: this.#options.database.expectedEpoch,
						now: this.#runtime.clock.nowIso(),
					},
				);
			});
		}
	}

	/**
	 * FLY-1503 item 8: drop #pending entries whose processing attempt has already
	 * been settled elsewhere (driver.stop() and a generation takeover both settle
	 * running attempts as 'crashed'). submit_proposal rejects a non-running
	 * attempt *before* reaching #pending.delete, so without this sweep the stale
	 * entry lived forever and #primeRunnerDelivery below early-returned for good,
	 * silently dropping every later delivery to that executor.
	 *
	 * Called from #primeRunnerDelivery, which #syncCurrentRunners already invokes
	 * for each live runner every coordinator tick, so this needs no new timer.
	 */
	#dropSettledPending(agentId: string): void {
		for (const [attemptUid, entry] of [...this.#pending.entries()]) {
			if (entry.handle.agent.agentId !== agentId) continue;
			const outcome = this.#kernel.read(
				(tx) =>
					tx.get<{ outcome: string }>(
						"SELECT outcome FROM processing_attempts WHERE attempt_uid=@attemptUid",
						{ attemptUid },
					)?.outcome,
			);
			if (outcome === undefined || outcome === "running") continue;
			this.#pending.delete(attemptUid);
			entry.reject(
				new Error(
					`delivery attempt ${attemptUid} was settled as ${outcome} outside this host`,
				),
			);
		}
	}

	/**
	 * Codex R1 MEDIUM-3: drop every in-memory delivery bound to a superseded
	 * generation of this agent, for any agent kind. Called on an evidenced
	 * takeover, where the durable attempts have just been settled as crashed.
	 */
	#discardSupersededDeliveries(
		agentId: string,
		supersededGeneration: number,
	): void {
		for (const [attemptUid, entry] of [...this.#pending.entries()]) {
			if (entry.handle.agent.agentId !== agentId) continue;
			// Codex R2 MEDIUM-2: driver.registerLead starts the NEW generation's lead
			// handler before returning, so by the time this runs a pending entry for
			// the new generation may already exist. Discarding by agent id alone
			// rejected that live delivery. Only generations at or below the superseded
			// one are dead.
			if (entry.handle.agent.generation > supersededGeneration) continue;
			this.#pending.delete(attemptUid);
			entry.reject(
				new Error(
					`delivery attempt ${attemptUid} was superseded by a generation takeover of ${agentId}`,
				),
			);
		}
		// Queued envelopes carry the dead generation's capability; the replacement
		// must not be handed them.
		const queued = this.#deliveries.get(agentId);
		if (queued) {
			const live = queued.filter(
				(envelope) => envelope.handle.agent.generation > supersededGeneration,
			);
			if (live.length > 0) this.#deliveries.set(agentId, live);
			else this.#deliveries.delete(agentId);
		}
	}

	/**
	 * Codex R3 HIGH-2: resolve the caller from its credential, never from the
	 * request body. The credential is the only thing here that a process which did
	 * not perform the registration cannot name.
	 */
	#authorizeDeliveryCredential(input: Record<string, unknown>): {
		credential: DeliveryCredentialRecord;
		agent: RegisteredAgent;
	} {
		const presented = requireRecord(
			input.deliveryCredential,
			"deliveryCredential",
		);
		const credentialId = requireString(
			presented.credentialId,
			"deliveryCredential.credentialId",
		);
		const token = requireString(presented.token, "deliveryCredential.token");
		const credential = this.#deliveryCredentials.get(credentialId);
		if (!credential) {
			throw new FenceViolation("delivery credential is unknown or revoked");
		}
		const presentedToken = Buffer.from(token, "hex");
		if (
			presentedToken.length !== credential.token.length ||
			!timingSafeEqual(presentedToken, credential.token)
		) {
			throw new FenceViolation("delivery credential token does not match");
		}
		// A caller may still name its agent; if it does, a disagreement is a fence
		// violation rather than a silently ignored field.
		if (
			input.agentId !== undefined &&
			requireString(input.agentId, "agentId") !== credential.agentId
		) {
			throw new FenceViolation(
				"delivery credential does not belong to the named agent",
			);
		}
		const agent = this.#registered.get(credential.agentId);
		if (
			!agent ||
			agent.instanceId !== credential.instanceId ||
			agent.generation !== credential.generation
		) {
			throw new FenceViolation(
				"delivery credential is bound to a superseded registration",
			);
		}
		// FLY-1543 ④: credentials are only ever minted for leads (registration is
		// lead-only); the old runner push-only guard died with the push channel.
		return { credential, agent };
	}

	#mintDeliveryCredential(agent: RegisteredAgent): {
		credentialId: string;
		token: string;
	} {
		const credentialId = randomUUID();
		const token = randomBytes(32);
		this.#deliveryCredentials.set(credentialId, {
			credentialId,
			token,
			agentId: agent.agentId,
			instanceId: agent.instanceId,
			generation: agent.generation,
		});
		return { credentialId, token: token.toString("hex") };
	}

	/**
	 * Codex R3 HIGH-2: revoking waiters and credentials must happen BEFORE the new
	 * generation's handler exists. driver.registerLead starts that handler before
	 * returning, so anything still registered under the old identity at that
	 * moment can take the new generation's first envelope.
	 */
	#revokeSupersededAccess(agentId: string, supersededGeneration: number): void {
		for (const [credentialId, credential] of [
			...this.#deliveryCredentials.entries(),
		]) {
			if (
				credential.agentId === agentId &&
				credential.generation <= supersededGeneration
			) {
				this.#deliveryCredentials.delete(credentialId);
			}
		}
		const waiters = this.#deliveryWaiters.get(agentId);
		if (!waiters) return;
		const live = waiters.filter(
			(waiter) => waiter.generation > supersededGeneration,
		);
		for (const waiter of waiters) {
			if (waiter.generation > supersededGeneration) continue;
			waiter.cancel(
				new FenceViolation(
					`delivery wait for ${agentId} was revoked by a generation takeover`,
				),
			);
		}
		if (live.length > 0) this.#deliveryWaiters.set(agentId, live);
		else this.#deliveryWaiters.delete(agentId);
	}

	#removeWaiter(waiter: DeliveryWaiter): void {
		const waiters = this.#deliveryWaiters.get(waiter.agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index >= 0) waiters.splice(index, 1);
		if (waiters.length === 0) this.#deliveryWaiters.delete(waiter.agentId);
	}

	/**
	 * FLY-1543 ④: session-addressed pull. Authorisation is host secret +
	 * self-declared sessionRef + the active-activation check -- the activation IS
	 * the registration, so a terminal or unknown session is refused, and a
	 * same-uid process lying about another live sessionRef is an accepted design
	 * boundary (settling the envelope still requires that delivery's own
	 * capability, so eavesdropping cannot move ledger ownership).
	 */
	async #nextSessionDelivery(
		sessionRef: string,
		socket: Socket,
	): Promise<DispatchOutcome> {
		requireActiveRunnerAgent(this.#kernel, sessionRef);
		const deadline = Date.now() + 10_000;
		for (;;) {
			const polled = pollRunnerDelivery(
				this.#kernel,
				this.#runtime,
				sessionRef,
			);
			if (polled.status === "available") {
				const prepared = this.#prepareDelivery(polled.message, polled.handle);
				const envelope = prepared.envelope;
				if (!envelope) {
					throw new FenceViolation(
						`delivery for attempt ${polled.handle.attemptUid} was already handed to this session; settle it before pulling again, or report the ambiguity`,
					);
				}
				return {
					result: envelope,
					afterWrite: (flushed) => {
						if (flushed) this.#recordDeliverySucceeded(envelope);
					},
				};
			}
			const remaining = deadline - Date.now();
			if (
				remaining <= 0 ||
				!(await this.#waitForSessionWake(sessionRef, remaining, socket))
			) {
				throw new Error("no delivery became available before timeout");
			}
		}
	}

	#waitForSessionWake(
		sessionRef: string,
		timeoutMs: number,
		socket: Socket,
	): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.off("close", onClose);
				const set = this.#sessionWakers.get(sessionRef);
				if (set) {
					set.delete(wake);
					if (set.size === 0) this.#sessionWakers.delete(sessionRef);
				}
				resolve(value);
			};
			const wake = () => finish(true);
			const onClose = () => finish(false);
			const timer = setTimeout(() => finish(false), timeoutMs);
			const wakers = this.#sessionWakers.get(sessionRef) ?? new Set();
			wakers.add(wake);
			this.#sessionWakers.set(sessionRef, wakers);
			socket.once("close", onClose);
		});
	}

	async #nextDelivery(
		payload: unknown,
		socket: Socket,
	): Promise<DispatchOutcome> {
		const input = requireRecord(payload, "next_delivery payload");
		if (input.sessionRef !== undefined) {
			if (
				input.deliveryCredential !== undefined ||
				input.agentId !== undefined
			) {
				throw new TypeError(
					"session pull does not take a credential or agent id",
				);
			}
			return this.#nextSessionDelivery(
				requireString(input.sessionRef, "sessionRef"),
				socket,
			);
		}
		const { credential, agent } = this.#authorizeDeliveryCredential(input);
		const agentId = credential.agentId;
		// FLY-1544 ③: a pull IS a poll. Mailbox rows appended out-of-band (the
		// operator CLI's admission/ship transactions write into the same kernel
		// from another process) never fire #wakeRecipient in THIS process, so a
		// lead pulling its mailbox must actively drain the kernel rather than
		// only waiting for an in-memory wake that may never come.
		this.#dropSettledPending(agentId);
		void this.#driver.drain(agentId).catch(() => undefined);
		const queued = this.#deliveries.get(agentId)?.shift();
		const delivery =
			queued ??
			(await new Promise<DeliveryEnvelope>((resolve, reject) => {
				const waiter: DeliveryWaiter = {
					agentId,
					instanceId: agent.instanceId,
					generation: agent.generation,
					credentialId: credential.credentialId,
					accept: (envelope) => {
						clearTimeout(timeout);
						socket.off("close", onClose);
						this.#removeWaiter(waiter);
						resolve(envelope);
					},
					cancel: (error) => {
						clearTimeout(timeout);
						socket.off("close", onClose);
						this.#removeWaiter(waiter);
						reject(error);
					},
				};
				// Codex R3 HIGH-2: a waiter must not outlive its connection. Without
				// this the long poll stayed eligible for up to the full timeout after
				// the client vanished, and #converter would hand it the envelope.
				const onClose = () =>
					waiter.cancel(
						new Error("delivery wait ended because the client disconnected"),
					);
				socket.once("close", onClose);
				const waiters = this.#deliveryWaiters.get(agentId) ?? [];
				waiters.push(waiter);
				this.#deliveryWaiters.set(agentId, waiters);
				const timeout = setTimeout(
					() =>
						waiter.cancel(
							new Error("no delivery became available before timeout"),
						),
					10_000,
				);
			}));
		return {
			result: delivery,
			// Codex R3 HIGH-2: the delivery action used to be recorded as succeeded
			// before the response was written, so a client that had already
			// disconnected consumed the envelope and lost it for good. Record it only
			// once the frame is flushed; otherwise put it back at the FRONT of the
			// queue so the next caller -- or the replacement generation -- gets it in
			// order.
			afterWrite: (flushed) => {
				if (flushed) {
					this.#recordDeliverySucceeded(delivery);
					return;
				}
				if (this.#pending.get(delivery.handle.attemptUid) === undefined) return;
				const queue = this.#deliveries.get(agentId) ?? [];
				queue.unshift(delivery);
				this.#deliveries.set(agentId, queue);
			},
		};
	}

	async #submitProposal(payload: unknown): Promise<unknown> {
		const input = requireRecord(payload, "submit_proposal payload");
		const authorizationInput = requireRecord(
			input.authorization,
			"authorization",
		);
		const parsed: SubmitPayload = {
			agentId: requireString(input.agentId, "agentId"),
			attemptUid: requireString(input.attemptUid, "attemptUid"),
			messageUid: requireString(input.messageUid, "messageUid"),
			effects: parseEffects(input.effects),
			authorization: {
				capabilityId: requireString(
					authorizationInput.capabilityId,
					"authorization.capabilityId",
				),
				token: requireString(authorizationInput.token, "authorization.token"),
			},
		};
		// FLY-1543 ④⑤: a session-addressed proposal settles against the durable
		// ledger, not against an in-memory converter -- the runner outlives host
		// restarts, so its settle path must too. The identity is rebuilt from the
		// activations row; a terminal activation surfaces through the receipt
		// checks below as crashed rather than as a dangling wait.
		if (isSessionRecipient(parsed.agentId)) {
			return this.#submitSessionProposal(parsed);
		}
		const pending = this.#pending.get(parsed.attemptUid);
		const agent = pending?.handle.agent ?? this.#registered.get(parsed.agentId);
		if (!agent || agent.agentId !== parsed.agentId) {
			throw new FenceViolation("proposal agent is not registered");
		}
		const proposal = {
			handle: pending?.handle ?? {
				attemptUid: parsed.attemptUid,
				messageUid: parsed.messageUid,
				agent,
			},
			effects: parsed.effects,
		};
		if (
			proposal.handle.messageUid !== parsed.messageUid ||
			proposal.handle.agent.agentId !== parsed.agentId
		) {
			throw new FenceViolation(
				"proposal request does not match pending attempt",
			);
		}
		const prior = readProposalReceipt(this.#kernel, proposal);
		if (prior.status === "succeeded") return prior;
		if (prior.status === "conflict") {
			throw new FenceViolation("settled proposal digest conflict");
		}
		if (prior.status !== "running") {
			throw new FenceViolation(`proposal attempt is ${prior.status}`);
		}
		if (!pending) {
			throw new FenceViolation("no host converter is waiting for this attempt");
		}
		this.#pending.delete(parsed.attemptUid);
		pending.resolve({
			ok: true,
			effects: parsed.effects,
			authorization: parsed.authorization,
		});
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const receipt = readProposalReceipt(this.#kernel, proposal);
			if (receipt.status === "succeeded") return receipt;
			if (receipt.status === "conflict") {
				throw new FenceViolation("settled proposal digest conflict");
			}
			if (receipt.status === "failed") {
				throw new FenceViolation(`proposal settlement ${receipt.outcome}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("proposal did not durably settle before response deadline");
	}

	#submitSessionProposal(parsed: SubmitPayload): unknown {
		const agent = requireActiveRunnerAgent(this.#kernel, parsed.agentId);
		const handle: AttemptHandle = {
			attemptUid: parsed.attemptUid,
			messageUid: parsed.messageUid,
			agent,
		};
		const proposal = { handle, effects: parsed.effects };
		const prior = readProposalReceipt(this.#kernel, proposal);
		if (prior.status === "succeeded") return prior;
		if (prior.status === "conflict") {
			throw new FenceViolation("settled proposal digest conflict");
		}
		if (prior.status !== "running") {
			throw new FenceViolation(`proposal attempt is ${prior.status}`);
		}
		// Durable settlement is synchronous here: effects + capability consume +
		// mailbox applied + attempt succeeded land in one kernel transaction.
		settleProposal(this.#kernel, this.#runtime, proposal, parsed.authorization);
		const receipt = readProposalReceipt(this.#kernel, proposal);
		if (receipt.status !== "succeeded") {
			throw new FenceViolation(
				`proposal settlement did not become durable (${receipt.status})`,
			);
		}
		return receipt;
	}
}
