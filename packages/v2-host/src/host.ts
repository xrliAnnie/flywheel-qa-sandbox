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
import type { DagPorts } from "flywheel-v2-dag";
import {
	type AttemptHandle,
	type ConversionResult,
	classifySessionProcess,
	type DeathEvidence,
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

/**
 * FLY-1503 item 1: the delivery contract, carried in every envelope.
 *
 * A runner or lead must be able to learn the rules from the envelope itself
 * rather than from pretrained knowledge of this repo. Reverse-engineering them
 * from the CLI source is how the settle/one-shot semantics were previously
 * discovered, which is not a contract.
 */
const DELIVERY_PROTOCOL = {
	v: 1,
	settlement: "one delivery is settled by exactly one submitted proposal",
	submit: {
		cli: "the flywheel-v2 CLI named by FLYWHEEL_V2_CLIENT_CLI",
		verb: "submit",
		flags: [
			"--socket <FLYWHEEL_V2_SOCKET>",
			"--secret <FLYWHEEL_V2_SECRET_PATH>",
			"--agent <handle.agent.agentId>",
			"--attempt <handle.attemptUid>",
			"--message <handle.messageUid>",
			"--capability-id <authorization.capabilityId>",
			"--token <authorization.token>",
			"--effects-file <absolute path to a JSON array of effects>",
		],
		// Codex R1 MEDIUM-6: the previous wording claimed both "a second submit is
		// refused" and "identical effects replay the receipt", which contradict.
		// State the actual rule: the first *distinct* proposal wins; an identical
		// re-submit is safe; a different one conflicts.
		oneShot:
			"exactly one distinct proposal settles this attemptUid. Re-submitting the byte-identical effects is safe and replays the stored receipt; submitting different effects is a digest conflict and is refused",
		// Codex R2 MEDIUM-6: the previous wording asserted that "no converter is
		// waiting" means the delivery was consumed. That is not guaranteed: the host
		// consumes the pending delivery BEFORE durable settlement, so if the engine
		// transaction then fails the attempt is still running while the retry is
		// refused. Do not state a guarantee the host does not provide -- say what is
		// actually knowable and make the ambiguity reportable.
		retryCaveat:
			"if a submit fails after the host accepted it but before durable settlement, retry the byte-identical effects. If a retry reports that no converter is waiting, the outcome is AMBIGUOUS -- the proposal may have settled or the delivery may have been consumed without settling. Do not change the effects and do not assume success: report the ambiguity",
		// Codex R4 HIGH-3: state it to the executor too, since the envelope is the
		// contract. This is operationally useful regardless of the threat model: an
		// executor holding an envelope it cannot settle should say so.
		noAcknowledgement:
			"there is no acknowledgement step. The host records a delivery as sent once the response frame leaves it, which does not prove you read it -- so a crash right after receiving an envelope can leave that delivery recorded with no proposal until the attempt is crash-settled and the message is rescheduled. If you hold an envelope you cannot settle, report it as an event effect rather than assuming the host knows",
	},
	effects: {
		allowedKinds: ["event", "task"],
		event: {
			kind: "event",
			eventKind: "<string>",
			payload: "<string>",
		},
		task: {
			kind: "task",
			taskKind: "<string>",
			state: "draft | ready",
			payload: "<string>",
			projectId: "<string>",
			lineageRootTaskId: "<optional string>",
		},
		note: "verdicts and node completion are not proposable: they are recorded by the operator-side direct kernel verbs, not by an executor",
	},
	reporting:
		"there is no side channel. To report progress, ask a question, or escalate a blocker, include an `event` effect in the single proposal; anything not submitted is not durable",
	// Codex R3: the same message CAN be delivered again on a new processing
	// attempt after a crash, so an executor must not treat a repeat as proof that
	// it already settled. The attemptUid is what distinguishes them.
	redelivery:
		"a delivery is scoped to (messageUid, attemptUid). If a crash settles the processing attempt before your proposal, the same messageUid is delivered again with a NEW attemptUid and a new capability -- settle the attemptUid you were given, and do not reuse a capability from an earlier attemptUid",
	// Codex R3 HIGH-2: pull delivery now needs the credential minted for this
	// registration. Say so in the envelope, since the envelope is the contract.
	pull: {
		verb: "next",
		credential:
			"pass --delivery-credential-file <path written by register-lead --delivery-credential-out>. The host secret alone no longer authorises a pull, and the token is never accepted as a flag value because argv is readable by every process sharing this uid",
		supersession:
			"a credential dies with its registration: after a generation takeover it is revoked, and a pull with it is refused rather than served a stale envelope",
	},
} as const;

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
	protocol: typeof DELIVERY_PROTOCOL;
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

/** Prefix of every mailbox delivery action id; the suffix is the attempt uid. */
/**
 * Codex R4 MEDIUM-5: the prefix carries the logical scope, so an action written
 * before the scope changed and one written after can never share an id.
 *
 * Re-scoping the logical effect to the processing attempt (see #prepareDelivery)
 * changed the effect key, but the id was still `mailbox-delivery:<attemptUid>`.
 * recordActionIntent looks up a replay by effect key ONLY, so on a durable row
 * written by an older host it found nothing and inserted with the same id:
 * `UNIQUE constraint failed: actions.id`, retried forever. The concrete case is
 * an old host that delivered and then died with the processing attempt still
 * running -- exactly the crash this PR set out to make recoverable.
 *
 * Versioning the id fixes the whole upgrade path with no migration: the old row
 * keeps its id and its old logical key, the new row gets a distinct id and the
 * new key, and neither unique index is touched. Both records are true -- the old
 * host really did hand over bytes, and so did this one.
 */
const DELIVERY_ACTION_PREFIX = "mailbox-delivery:pa1:";

/**
 * The two identity derivations for a mailbox delivery action, exported so a test
 * cannot restate them.
 *
 * Codex R5 LOW-1: the upgrade-compatibility suite hardcoded both the id prefix and
 * the logical scope, so it would have passed a production regression back to the
 * message-only scope or the un-versioned id -- it was asserting its own constants.
 * One source of truth removes that.
 */
export function deliveryActionId(attemptUid: string): string {
	return `${DELIVERY_ACTION_PREFIX}${attemptUid}`;
}

export function deliveryLogicalEffectId(
	messageUid: string,
	attemptUid: string,
): string {
	return `deliver:${messageUid}:${attemptUid}`;
}

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

/**
 * FLY-1503 item 2: registerAgentTx has always accepted DeathEvidence and
 * driver.registerLead has always forwarded it, but the host never parsed any, so
 * a lead whose session was confirmed dead could not be replaced -- register_lead
 * just kept reporting "existing lead identity requires evidenced generation
 * takeover" with no way to supply that evidence.
 */
function parseDeathEvidence(value: unknown): DeathEvidence {
	const input = requireRecord(value, "deathEvidence");
	if (
		Object.keys(input).sort().join(",") !==
		"agentId,confirmedAbsentAt,generation"
	) {
		throw new TypeError("deathEvidence has an invalid shape");
	}
	return {
		agentId: requireString(input.agentId, "deathEvidence.agentId"),
		generation: requireInteger(input.generation, "deathEvidence.generation"),
		confirmedAbsentAt: requireString(
			input.confirmedAbsentAt,
			"deathEvidence.confirmedAbsentAt",
		),
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
	 * FLY-1503 item 9: this must NOT filter on `agents.state='online'`. Shutdown
	 * runs driver.stop(), which casOffline's every agent, so on restart a still
	 * live runner has an offline row. Filtering on it left casReattachAgent
	 * unreachable and orphaned the runner. Liveness is established below by
	 * #bindingHasLiveEvidence (host epoch + pid start + session owner) together
	 * with the active-activation join, not by that cached flag; casReattachAgent
	 * does not filter on state either and restores it to online.
	 */
	async #syncCurrentRunners(): Promise<void> {
		const rows = this.#kernel.read((tx) =>
			tx.all<CurrentRunnerRow>(
				`SELECT ag.agent_id,ag.generation,ag.instance_id,
				        ag.session_binding,act.id AS activation_id
				   FROM agents ag
				   JOIN activations act
				     ON act.session_ref=ag.instance_id AND act.state='active'
				  WHERE ag.kind='runner'
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
				await this.#driver.attachRunner(
					row.agent_id,
					agent,
					this.#options.hostEpoch,
					this.#options.sessionProbe,
				);
				this.#registered.set(row.agent_id, agent);
			}
			await this.#options.coordinator?.activateSession?.(binding.sessionId);
			this.#primeRunnerDelivery(row.agent_id);
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

	async #registerLead(payload: unknown): Promise<
		RegisteredAgent & {
			deliveryCredential: { credentialId: string; token: string };
		}
	> {
		const input = requireRecord(payload, "register_lead payload");
		const agentId = requireString(input.agentId, "agentId");
		const instanceId = requireString(input.instanceId, "instanceId");
		const sessionBinding = parseSessionBinding(input.sessionBinding);
		const deathEvidence =
			input.deathEvidence === undefined
				? undefined
				: parseDeathEvidence(input.deathEvidence);
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
		} else if (deathEvidence !== undefined) {
			// FLY-1503 item 2: an evidenced takeover replaces a confirmed-dead
			// session. registerAgentTx validates the evidence against the current
			// row (agent id + exact generation + ISO timestamp), settles the dead
			// generation's running attempts, and bumps to generation + 1.
			if (current.kind !== "lead") {
				throw new FenceViolation(`agent kind collision for ${agentId}`);
			}
			// Codex R1 HIGH-1: deathEvidence is client-asserted and every runner is
			// handed FLYWHEEL_V2_SECRET_PATH (tmux-runner-launcher.ts), so any runner
			// can authenticate to this socket. registerAgentTx only checks that the
			// evidence *names* the current agent and generation with a canonical
			// timestamp -- it never proves the old session died. Trusting it let a
			// runner displace a LIVE lead, settle its running attempts and inherit
			// its mailbox. The host must therefore establish absence itself.
			if (instanceId !== sessionBinding.sessionId) {
				throw new FenceViolation(
					"takeover instance id must equal the live session id",
				);
			}
			if (current.instance_id === instanceId) {
				throw new FenceViolation(
					"takeover requires a session distinct from the current one",
				);
			}
			if (!current.session_binding) {
				throw new FenceViolation(
					"takeover requires a recorded prior session binding",
				);
			}
			const priorBinding = parseStoredBinding(current.session_binding);
			// Fail closed rather than fail open: a binding from another host epoch
			// cannot be probed by this host, so its death cannot be established.
			if (priorBinding.hostEpoch !== this.#options.hostEpoch) {
				throw new FenceViolation(
					"takeover cannot verify a session bound to another host epoch",
				);
			}
			// Codex R2 HIGH-1: #bindingHasLiveEvidence must NOT be the absence gate.
			// It returns false whenever the session proof is missing, unreadable or
			// mis-moded, and that proof is a 0600 file under the same uid as every
			// runner -- so a runner could simply delete it to forge death while the
			// lead is alive. Absence must rest on positive process identity, which is
			// OS state a runner cannot fake.
			//
			// Codex R3 HIGH-1: adjudicate on the probe's four explicit states rather
			// than on a nullable identity plus a canary. The canary read "the probe
			// answered for some other pid" as "so its silence about THIS pid means
			// death", which a probe that failed only for the target pid defeats. Now
			// only positive evidence -- a different process on that pid, or no process
			// at all -- permits a takeover; `probe_unavailable` fails closed.
			const priorProcessState = classifySessionProcess(
				this.#options.sessionProbe.processStart(priorBinding.pid),
				priorBinding.pidStart,
			);
			if (priorProcessState === "same_process") {
				throw new FenceViolation(
					"takeover refused: the prior lead process is still live",
				);
			}
			if (priorProcessState === "probe_unavailable") {
				throw new FenceViolation(
					"takeover refused: the process probe is unavailable",
				);
			}
			// Codex R3 HIGH-2: revoke the superseded generation's pull access BEFORE
			// driver.registerLead, because it starts the new generation's handler
			// before it returns -- an old waiter that is still eligible at that moment
			// can take the new generation's first envelope, and an old credential can
			// still authorise a pull.
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
				// Codex R2 HIGH-1: the absence timestamp is host-observed. The client
				// supplied value is only shape-checked by validateEvidence, so letting
				// it through would record an attacker-chosen provenance for a takeover.
				{
					...deathEvidence,
					confirmedAbsentAt: this.#runtime.clock.nowIso(),
				},
			);
			// Codex R1 MEDIUM-3: the takeover settles the dead generation's running
			// attempts, but item 8's sweep only ran for runners via
			// #primeRunnerDelivery. Any pending promise or queued envelope still held
			// for this lead belongs to the superseded generation and carries a dead
			// capability, so the new generation would otherwise be handed it by
			// next_delivery -- and each takeover would leak another pending entry.
			this.#discardSupersededDeliveries(agentId, current.generation);
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

	/**
	 * Codex R3: the logical scope of a delivery is (message, PROCESSING ATTEMPT).
	 *
	 * It used to be (message, DAG attempt generation). `actions.logical_key` digests
	 * {attemptGeneration, attemptId, cutoverEpoch, kind, logicalEffectId, taskId,
	 * unboundActorAgentId} and `actions_one_root_per_logical` is UNIQUE on it where
	 * supersedes_action_id IS NULL, so redelivering one message inside the same DAG
	 * attempt generation was a duplicate root and failed forever with
	 * `UNIQUE constraint failed: actions.logical_key`.
	 *
	 * That mattered because R3 correctly refuted the claim that reap/redispatch
	 * recovers it: driver.stop() crash-settles the processing attempt, but a
	 * still-live runner is ADOPTED on restart rather than reaped, so the DAG attempt
	 * generation never changes; and a lead delivery has no DAG attempt scope at all,
	 * so there is no generation to change. The executor really was stuck.
	 *
	 * R3 offered two remedies -- declare a successor action, or redefine the logical
	 * scope so a legitimate redelivery is distinguishable. This takes the second,
	 * because the first is not available here and would not have worked:
	 * `actions_supersedes_insert` requires the superseded intent to be `intended` or
	 * `failed`, while a delivery action is recorded `succeeded` the moment the bytes
	 * are handed over, and NOTHING in this repo ever records a delivery action as
	 * failed (host.ts is the only writer of a mailbox.deliver outcome and it only
	 * ever writes succeeded). A post-crash redelivery therefore always faces a
	 * `succeeded` tip, which cannot be superseded.
	 *
	 * The second remedy is also the more accurate model. Handing message X to
	 * processing attempt #1 and handing it to attempt #2 are two DIFFERENT external
	 * effects: two injections, two capability issuances, two sets of bytes crossing
	 * the boundary. Both really happened and both must be recorded. Collapsing them
	 * into one logical effect asserted that only one of them may ever occur, which
	 * contradicts the at-least-once mailbox the engine implements.
	 *
	 * What is still enforced: `effect_key` is UNIQUE and derives from
	 * invocationUid + logicalKey, so two deliveries of one message on the SAME
	 * processing attempt remain refused (they replay instead). Preventing two
	 * CONCURRENT attempts for one message is the job of processing_attempts and the
	 * generation fences, not of this index.
	 */
	#prepareDelivery(
		message: DeliveryEnvelope["message"],
		handle: AttemptHandle,
	): PreparedDelivery {
		const actionId = deliveryActionId(handle.attemptUid);
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
			const scope = runnerScope
				? {
						taskId: runnerScope.task_id,
						attemptId: runnerScope.attempt_id,
						attemptGeneration: runnerScope.attempt_generation,
					}
				: {};
			return recordActionIntent(
				tx,
				{
					id: actionId,
					...scope,
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
					// Codex R3: scoped to the PROCESSING ATTEMPT, not just the message.
					logicalEffectId: deliveryLogicalEffectId(
						message.messageUid,
						handle.attemptUid,
					),
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
			return { handle, deliveryActionId: actionId };
		}
		if (intent.outcome === "replayed" && intent.action.state !== "intended") {
			throw new FenceViolation(
				`delivery ${actionId} already escaped the host; manual evidence is required`,
			);
		}
		const authorization = issueProposalCapability(
			this.#kernel,
			this.#runtime,
			handle,
			actionId,
		);
		return {
			handle,
			deliveryActionId: actionId,
			envelope: {
				v: 1,
				message,
				handle,
				authorization,
				deliveryActionId: actionId,
				protocol: DELIVERY_PROTOCOL,
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
				// #dropSettledPending used to run only for runners, via
				// #primeRunnerDelivery. A lead's stale entry was unreachable in practice
				// because a redelivery could never be prepared at all -- it collided on
				// UNIQUE(actions.logical_key). Now that a redelivery succeeds, each crash
				// leaves the superseded attempt's entry behind until the next takeover or
				// host close, so sweep it here on the lead's own delivery trigger. Same
				// no-new-timer argument as the runner side.
				this.#dropSettledPending(toAgent);
				void this.#driver.drain(toAgent).catch(() => undefined);
			}
		}
		return result;
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

	#primeRunnerDelivery(agentId: string): void {
		this.#dropSettledPending(agentId);
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
		if (agent.kind === "runner") {
			throw new FenceViolation(
				"runner delivery is push-only through the v2 injection shim",
			);
		}
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

	async #nextDelivery(
		payload: unknown,
		socket: Socket,
	): Promise<DispatchOutcome> {
		const input = requireRecord(payload, "next_delivery payload");
		const { credential, agent } = this.#authorizeDeliveryCredential(input);
		const agentId = credential.agentId;
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
