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
import type { DagPorts } from "flywheel-v2-dag";
import {
	type AttemptHandle,
	type ConversionResult,
	type Effect,
	EngineDriver,
	type EngineRuntime,
	enqueue,
	issueProposalCapability,
	type ProposalAuthorization,
	provisionAgentRecipient,
	type RegisteredAgent,
	readProposalReceipt,
	type SessionBinding,
	type SessionEvidenceProbe,
} from "flywheel-v2-engine";
import {
	type ExistingDatabaseOptions,
	FenceViolation,
	type Kernel,
	openExistingKernel,
	readCutoverAuthority,
	recordActionIntent,
	recordActionOutcome,
	recordExternalEffectIntentTx,
} from "flywheel-v2-kernel";
import {
	type CoordinatorTickResult,
	V2RuntimeCoordinator,
} from "./coordinator.js";
import {
	HOST_PROTOCOL_VERSION,
	type HostRequest,
	type HostResponse,
	MAX_HOST_FRAME_BYTES,
	verifyHostRequest,
} from "./protocol.js";

interface PendingDelivery {
	handle: AttemptHandle;
	resolve(result: ConversionResult): void;
	reject(error: unknown): void;
	envelope?: DeliveryEnvelope;
}

interface PreparedDelivery {
	handle: AttemptHandle;
	deliveryActionId: string;
	envelope?: DeliveryEnvelope;
}

export interface DeliveryEnvelope {
	v: 1;
	message: {
		messageUid: string;
		payload: string;
		kind: string;
		sourceKind: string;
		seq: number;
	};
	handle: AttemptHandle;
	authorization: ProposalAuthorization;
	deliveryActionId: string;
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
		deliverRunner?(
			sessionRef: string,
			injectionRef: string,
			message: {
				messageUid: string;
				attemptUid: string;
				payload: string;
			},
		): Promise<void>;
	};
}

interface AgentRow {
	kind: string;
	generation: number;
	instance_id: string | null;
	session_binding: string | null;
}

interface CurrentRunnerRow {
	agent_id: string;
	generation: number;
	instance_id: string;
	session_binding: string;
	activation_id: string;
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
	if (probe.processStart(binding.pid) !== binding.pidStart) {
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

function writeResponse(socket: Socket, response: HostResponse): void {
	socket.end(`${JSON.stringify(response)}\n`);
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
	readonly #deliveryWaiters = new Map<
		string,
		Array<(delivery: DeliveryEnvelope) => void>
	>();
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
		}
	}

	async close(): Promise<void> {
		if (this.#coordinatorTimer) {
			clearInterval(this.#coordinatorTimer);
			this.#coordinatorTimer = undefined;
		}
		const server = this.#server;
		this.#server = undefined;
		if (server) {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
		for (const pending of this.#pending.values()) {
			pending.reject(new Error("v2 host is closing"));
		}
		this.#pending.clear();
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
			this.#options.sessionProbe.processStart(binding.pid) !== binding.pidStart
		) {
			return false;
		}
		const owner = this.#options.sessionProbe.sessionOwner(binding.sessionId);
		return owner?.pid === binding.pid && owner.pidStart === binding.pidStart;
	}

	async #syncCurrentRunners(): Promise<void> {
		const rows = this.#kernel.read((tx) =>
			tx.all<CurrentRunnerRow>(
				`SELECT ag.agent_id,ag.generation,ag.instance_id,
				        ag.session_binding,act.id AS activation_id
				   FROM agents ag
				   JOIN activations act
				     ON act.session_ref=ag.instance_id AND act.state='active'
				  WHERE ag.kind='runner' AND ag.state='online'
				    AND ag.generation >= 1
				    AND ag.instance_id IS NOT NULL
				    AND ag.session_binding IS NOT NULL
				  ORDER BY ag.agent_id`,
			),
		);
		for (const row of rows) {
			const binding = parseStoredBinding(row.session_binding);
			if (
				binding.sessionId !== row.instance_id ||
				!this.#bindingHasLiveEvidence(binding)
			) {
				continue;
			}
			const prior = this.#registered.get(row.agent_id);
			const alreadyAttached =
				prior?.kind === "runner" &&
				prior.instanceId === row.instance_id &&
				prior.generation === row.generation &&
				prior.activationId === row.activation_id;
			if (!alreadyAttached) {
				const agent: RegisteredAgent = {
					kind: "runner",
					agentId: row.agent_id,
					instanceId: row.instance_id,
					generation: row.generation,
					activationId: row.activation_id,
					sessionBinding: binding,
				};
				await this.#driver.attachRunner(row.agent_id, agent);
				this.#registered.set(row.agent_id, agent);
			}
			await this.#options.coordinator?.activateSession?.(binding.sessionId);
			this.#primeRunnerDelivery(row.agent_id);
		}
	}

	#accept(socket: Socket): void {
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
			const result = await this.#dispatch(request.action, request.payload);
			writeResponse(socket, {
				v: HOST_PROTOCOL_VERSION,
				id: request.id,
				ok: true,
				result,
			});
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

	async #dispatch(action: string, payload: unknown): Promise<unknown> {
		const databaseAuthorityState = this.#authorityState();
		switch (action) {
			case "health":
				return {
					status: databaseAuthorityState === "live" ? "ok" : "held",
					hostEpoch: this.#options.hostEpoch,
					windowId: this.#options.database.expectedWindowId,
					epoch: this.#options.database.expectedEpoch,
				};
			default:
				if (databaseAuthorityState !== "live") {
					throw new FenceViolation("v2 host is held until founder final GO");
				}
		}
		switch (action) {
			case "register_lead":
				return this.#registerLead(payload);
			case "enqueue":
				return this.#enqueue(payload);
			case "next_delivery":
				return this.#nextDelivery(payload);
			case "submit_proposal":
				return this.#submitProposal(payload);
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

	async #registerLead(payload: unknown): Promise<RegisteredAgent> {
		const input = requireRecord(payload, "register_lead payload");
		const agentId = requireString(input.agentId, "agentId");
		const instanceId = requireString(input.instanceId, "instanceId");
		const sessionBinding = parseSessionBinding(input.sessionBinding);
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
		} else {
			if (
				current.kind !== "lead" ||
				current.instance_id !== instanceId ||
				current.session_binding !== storedBinding(sessionBinding)
			) {
				throw new FenceViolation(
					"existing lead identity requires evidenced generation takeover",
				);
			}
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
		}
		this.#registered.set(agentId, agent);
		return agent;
	}

	#prepareDelivery(
		message: DeliveryEnvelope["message"],
		handle: AttemptHandle,
	): PreparedDelivery {
		const deliveryActionId = `mailbox-delivery:${handle.attemptUid}`;
		const intent = this.#kernel.write("host.delivery-intent", (tx) => {
			const runnerScope =
				handle.agent.kind === "runner"
					? tx.get<{
							task_id: string;
							attempt_id: string;
							attempt_generation: number;
						}>(
							`SELECT a.task_id,a.id AS attempt_id,
							        a.generation AS attempt_generation
							   FROM activations act
							   JOIN attempts a ON a.id=act.attempt_id
							  WHERE act.id=@activationId
							    AND act.session_ref=@sessionRef
							    AND act.state='active'`,
							{
								activationId: handle.agent.activationId,
								sessionRef: handle.agent.instanceId,
							},
						)
					: undefined;
			if (handle.agent.kind === "runner" && !runnerScope) {
				throw new FenceViolation(
					"runner delivery activation scope is missing or stale",
				);
			}
			return recordActionIntent(
				tx,
				{
					id: deliveryActionId,
					...(runnerScope
						? {
								taskId: runnerScope.task_id,
								attemptId: runnerScope.attempt_id,
								attemptGeneration: runnerScope.attempt_generation,
							}
						: {}),
					actor:
						handle.agent.kind === "runner"
							? {
									kind: "runner",
									agentId: handle.agent.agentId,
									instanceId: handle.agent.instanceId,
									generation: handle.agent.generation,
									activationId: handle.agent.activationId,
								}
							: {
									kind: "lead",
									agentId: handle.agent.agentId,
									instanceId: handle.agent.instanceId,
									generation: handle.agent.generation,
								},
					kind: "mailbox.deliver",
					payload: {
						message_uid: message.messageUid,
						attempt_uid: handle.attemptUid,
					},
					logicalEffectId: `deliver:${message.messageUid}`,
					invocationUid: `mailbox:${handle.attemptUid}`,
					cutoverEpoch: this.#options.database.expectedEpoch,
				},
				{
					prepare: (writeTx) => {
						recordExternalEffectIntentTx(writeTx, {
							effectKey: `deliver:${handle.attemptUid}`,
							family: "deliver",
							nowIso: this.#runtime.clock.nowIso(),
						});
					},
				},
			);
		});
		if (intent.outcome === "replayed" && intent.action.state === "succeeded") {
			return { handle, deliveryActionId };
		}
		if (intent.outcome === "replayed" && intent.action.state !== "intended") {
			throw new FenceViolation(
				`delivery ${deliveryActionId} already escaped the host; manual evidence is required`,
			);
		}
		const authorization = issueProposalCapability(
			this.#kernel,
			this.#runtime,
			handle,
			deliveryActionId,
		);
		return {
			handle,
			deliveryActionId,
			envelope: {
				v: 1,
				message,
				handle,
				authorization,
				deliveryActionId,
			},
		};
	}

	#recordDeliverySucceeded(delivery: DeliveryEnvelope): void {
		this.#kernel.write("host.delivery-outcome", (tx) => {
			recordActionOutcome(tx, {
				id: delivery.deliveryActionId,
				actor:
					delivery.handle.agent.kind === "runner"
						? {
								kind: "runner",
								agentId: delivery.handle.agent.agentId,
								instanceId: delivery.handle.agent.instanceId,
								generation: delivery.handle.agent.generation,
								activationId: delivery.handle.agent.activationId,
							}
						: {
								kind: "lead",
								agentId: delivery.handle.agent.agentId,
								instanceId: delivery.handle.agent.instanceId,
								generation: delivery.handle.agent.generation,
							},
				state: "succeeded",
				result: { delivered: true },
			});
		});
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
				const waiter = this.#deliveryWaiters.get(agentId)?.shift();
				if (waiter) {
					waiter(envelope);
				} else {
					const queue = this.#deliveries.get(agentId) ?? [];
					queue.push(envelope);
					this.#deliveries.set(agentId, queue);
				}
			});
		};
	}

	#runnerConverter(agentId: string) {
		return async (
			message: DeliveryEnvelope["message"],
			context: { handle: AttemptHandle },
		): Promise<ConversionResult> => {
			const deliver = this.#options.coordinator?.deliverRunner;
			if (!deliver || context.handle.agent.kind !== "runner") {
				throw new FenceViolation(
					"runner delivery requires the configured v2 injection launcher",
				);
			}
			const runner = context.handle.agent;
			if (runner.agentId !== agentId) {
				throw new FenceViolation("runner delivery agent identity mismatch");
			}
			const injectionRef = this.#kernel.read(
				(tx) =>
					tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
						key: `injection_ref:${runner.activationId}`,
					})?.value,
			);
			if (!injectionRef) {
				throw new FenceViolation("runner injection reference is missing");
			}
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
				void deliver(runner.instanceId, injectionRef, {
					messageUid: message.messageUid,
					attemptUid: context.handle.attemptUid,
					payload: JSON.stringify(envelope),
				})
					.then(() => {
						this.#recordDeliverySucceeded(envelope);
					})
					.catch((error) => {
						if (this.#pending.get(context.handle.attemptUid) === pending) {
							this.#pending.delete(context.handle.attemptUid);
						}
						reject(error);
					});
			});
		};
	}

	#enqueue(payload: unknown): unknown {
		const input = requireRecord(payload, "enqueue payload");
		const toAgent = requireString(input.toAgent, "toAgent");
		const sourceKind = requireString(input.sourceKind, "sourceKind");
		if (sourceKind === "discord") {
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
		const registered = this.#registered.get(toAgent);
		if (result.status === "enqueued" && registered) {
			if (registered.kind === "runner") {
				this.#primeRunnerDelivery(toAgent);
			} else {
				void this.#driver.drain(toAgent).catch(() => undefined);
			}
		}
		return result;
	}

	#primeRunnerDelivery(agentId: string): void {
		const registered = this.#registered.get(agentId);
		if (
			registered?.kind !== "runner" ||
			[...this.#pending.values()].some(
				(entry) => entry.handle.agent.agentId === agentId,
			)
		) {
			return;
		}
		const polled = this.#driver.poll(agentId);
		if (polled.status !== "available") return;
		const pending = this.#runnerConverter(agentId)(
			{
				messageUid: polled.handle.messageUid,
				payload: polled.payload,
				kind: polled.kind,
				sourceKind: polled.sourceKind,
				seq: polled.seq,
			},
			{ handle: polled.handle },
		);
		void pending
			.then((converted) => {
				if (converted.ok) {
					this.#driver.submitProposal(
						{ handle: polled.handle, effects: converted.effects },
						converted.authorization,
					);
				} else {
					this.#driver.reportConversionFailure(polled.handle, converted.error);
				}
				this.#primeRunnerDelivery(agentId);
			})
			.catch((error) => {
				this.#options.coordinator?.onError?.(error);
			});
	}

	async #nextDelivery(payload: unknown): Promise<DeliveryEnvelope> {
		const input = requireRecord(payload, "next_delivery payload");
		const agentId = requireString(input.agentId, "agentId");
		if (!this.#registered.has(agentId)) {
			throw new FenceViolation(`agent ${agentId} is not registered`);
		}
		if (this.#registered.get(agentId)?.kind === "runner") {
			throw new FenceViolation(
				"runner delivery is push-only through the v2 injection shim",
			);
		}
		const queued = this.#deliveries.get(agentId)?.shift();
		const delivery =
			queued ??
			(await new Promise<DeliveryEnvelope>((resolve, reject) => {
				const waiters = this.#deliveryWaiters.get(agentId) ?? [];
				const wrapped = (value: DeliveryEnvelope) => {
					clearTimeout(timeout);
					resolve(value);
				};
				waiters.push(wrapped);
				this.#deliveryWaiters.set(agentId, waiters);
				const timeout = setTimeout(() => {
					const index = waiters.indexOf(wrapped);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error("no delivery became available before timeout"));
				}, 10_000);
			}));
		this.#recordDeliverySucceeded(delivery);
		return delivery;
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
}
