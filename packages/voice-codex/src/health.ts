import { type ChildProcess, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MAX_INPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_AGGREGATE_WINDOW_MS = 20_000;
const DEFAULT_SUCCESS_LOG_HEARTBEAT_MS = 60_000;
const DEFAULT_WATCHDOG_MS = 60_000;
const DEFAULT_MAINTENANCE_MS = 5 * 60_000;
const DEFAULT_MAX_QUEUE = 64;
const MAX_SPOOL_BYTES = 1024 * 1024;
const MAX_SPOOL_FILES = 128;

export type VoiceHealthReasonClass =
	| "bridge_connect_failed"
	| "bridge_timeout_headers"
	| "bridge_timeout_body"
	| "bridge_auth_rejected"
	| "bridge_http_error"
	| "bridge_protocol_invalid"
	| "startup_config_invalid"
	| "startup_lock_unavailable"
	| "startup_not_ready"
	| "session_create_failed"
	| "session_runtime_failed"
	| "lease_lost"
	| "heartbeat_stale"
	| "health_observation_unavailable"
	| "demand_source_unavailable"
	| "unknown_failure";

export type VoiceHealthOperation =
	| "desired"
	| "claim"
	| "renew"
	| "state"
	| "outbound"
	| "receipt"
	| "session_create"
	| "session_runtime"
	| "startup"
	| "health_store"
	| "demand_snapshot";

export type VoiceHealthObservation =
	| {
			kind: "idle_success" | "progress";
			observedAt: string;
			durationMs?: number;
			countDelta?: number;
	  }
	| {
			kind: "daemon_stopped";
			observedAt: string;
			durationMs?: number;
	  }
	| {
			kind: "poll_failed";
			observedAt: string;
			durationMs?: number;
			reasonClass: VoiceHealthReasonClass;
			operation: VoiceHealthOperation;
	  }
	| {
			kind: "session_failed";
			observedAt: string;
			durationMs?: number;
			reasonClass: VoiceHealthReasonClass;
			operation: VoiceHealthOperation;
			demandId: string;
			attemptId: string;
	  }
	| {
			kind: "session_recovered" | "session_ended";
			observedAt: string;
			demandId: string;
			successorAttemptId: string;
			liveAt: string;
			renewAt: string;
	  };

export interface VoiceHealthObserver {
	observe(observation: VoiceHealthObservation): void;
}

export type VoiceHealthCommand =
	| "register-boot"
	| "record-result"
	| "evaluate"
	| "maintenance"
	| "record-demand"
	| "export";

export interface VoiceHealthCommandClient {
	invoke(
		command: VoiceHealthCommand,
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
}

interface VoiceHealthExecOptions {
	encoding: "utf8";
	maxBuffer: number;
	shell: false;
	timeout: number;
	windowsHide: true;
}

export type VoiceHealthExecFile = (
	file: string,
	args: string[],
	options: VoiceHealthExecOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => ChildProcess;

function defaultExecFile(
	file: string,
	args: string[],
	options: VoiceHealthExecOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
): ChildProcess {
	return execFile(file, args, options, callback);
}

export class VoiceHealthUnavailableError extends Error {
	constructor() {
		super("health_observation_unavailable");
		this.name = "VoiceHealthUnavailableError";
	}
}

export interface VoiceHealthHelperClientOptions {
	helperPath: string;
	stateRoot: string;
	execFile?: VoiceHealthExecFile;
}

export class VoiceHealthHelperClient implements VoiceHealthCommandClient {
	private readonly run: VoiceHealthExecFile;

	constructor(private readonly options: VoiceHealthHelperClientOptions) {
		this.run = options.execFile ?? defaultExecFile;
	}

	invoke(
		command: VoiceHealthCommand,
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		let input: string;
		try {
			input = JSON.stringify(payload);
		} catch {
			return Promise.reject(new VoiceHealthUnavailableError());
		}
		if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES)
			return Promise.reject(new VoiceHealthUnavailableError());

		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = () => {
				if (settled) return;
				settled = true;
				reject(new VoiceHealthUnavailableError());
			};
			let child: ChildProcess;
			try {
				child = this.run(
					"python3",
					[
						this.options.helperPath,
						"--state-root",
						this.options.stateRoot,
						command,
					],
					{
						encoding: "utf8",
						maxBuffer: 65_536,
						shell: false,
						timeout: DEFAULT_TIMEOUT_MS,
						windowsHide: true,
					},
					(error, stdout) => {
						if (error) {
							fail();
							return;
						}
						try {
							const parsed = JSON.parse(stdout) as unknown;
							if (
								typeof parsed !== "object" ||
								parsed === null ||
								Array.isArray(parsed)
							)
								throw new VoiceHealthUnavailableError();
							if (!settled) {
								settled = true;
								resolve(parsed as Record<string, unknown>);
							}
						} catch {
							fail();
						}
					},
				);
			} catch {
				fail();
				return;
			}
			if (!child.stdin) {
				fail();
				return;
			}
			child.stdin.once("error", fail);
			child.stdin.end(input, "utf8");
		});
	}
}

interface SpoolEvent {
	producerEventSeq: number;
	observation: VoiceHealthObservation;
}

interface SpoolDocument {
	schemaVersion: 1;
	bootId: string;
	bootAt: string;
	generation?: number;
	events: SpoolEvent[];
}

type QueueItem =
	| {
			kind: "register";
			document: SpoolDocument;
			current: boolean;
	  }
	| {
			kind: "result";
			document: SpoolDocument;
			event: SpoolEvent;
	  }
	| { kind: "evaluate"; observedAt: string }
	| { kind: "maintenance"; requestedAt: string };

type NormalKind = "idle_success" | "progress";

interface NormalAggregate {
	observation: Extract<VoiceHealthObservation, { kind: NormalKind }>;
	countDelta: number;
}

export type VoiceHealthSuccessLogEvent =
	| "initial_idle_success"
	| "recovered"
	| "heartbeat";

export interface VoiceHealthSuccessLog {
	event: VoiceHealthSuccessLogEvent;
	timestamp: string;
	bootId: string;
	generation: number;
	producerEventSeq: number;
	observationSeq: number;
	mode: "idle";
	lastIterationSuccessAt: string;
	successCount: number;
	failureCount: number;
	failureStreak: number;
	durationMs?: number;
}

export function logVoiceHealthSuccess(entry: VoiceHealthSuccessLog): void {
	const duration =
		entry.durationMs === undefined ? "" : ` durationMs=${entry.durationMs}`;
	console.log(
		`[voice] daemon iteration succeeded event=${entry.event} timestamp=${entry.timestamp} bootId=${entry.bootId} generation=${entry.generation} producerEventSeq=${entry.producerEventSeq} observationSeq=${entry.observationSeq} mode=${entry.mode} lastIterationSuccessAt=${entry.lastIterationSuccessAt} successCount=${entry.successCount} failureCount=${entry.failureCount} failureStreak=${entry.failureStreak}${duration}`,
	);
}

export interface VoiceHealthReporterOptions {
	client: VoiceHealthCommandClient;
	bootId: string;
	stateRoot: string;
	now?: () => Date;
	monotonicNow?: () => number;
	onUnavailable?: (signal: {
		reasonClass: "health_observation_unavailable";
		operation: "health_store";
	}) => void;
	onNotification?: (intentId: string) => void;
	onSuccessLog?: (entry: VoiceHealthSuccessLog) => void;
	aggregateWindowMs?: number;
	watchdogMs?: number;
	maxQueue?: number;
}

export class VoiceHealthReporter implements VoiceHealthObserver {
	private readonly queue: QueueItem[] = [];
	private readonly documents = new Map<string, SpoolDocument>();
	private readonly queuedEvents = new Set<string>();
	private readonly queuedRegisters = new Set<string>();
	private readonly aggregate = new Map<NormalKind, NormalAggregate>();
	private readonly aggregateOrder: NormalKind[] = [];
	private readonly aggregateTimers = new Map<
		NormalKind,
		ReturnType<typeof setTimeout>
	>();
	private readonly lastNormalEnqueuedAt = new Map<NormalKind, number>();
	private generation?: number;
	private nextProducerEventSeq = 1;
	private draining = false;
	private retryRequested = false;
	private settlers: Array<() => void> = [];
	private registerQueued = false;
	private replayLoaded = false;
	private filesystemBlocked = false;
	private currentDocument?: SpoolDocument;
	private persistenceTail: Promise<void> = Promise.resolve();
	private pendingPersistence = 0;
	private unavailable = false;
	private sawPollFailure = false;
	private readonly successLogEvents = new Map<
		SpoolEvent,
		VoiceHealthSuccessLogEvent
	>();
	private hasScheduledSuccessLog = false;
	private lastSuccessLogScheduledAt?: number;
	private watchdog?: ReturnType<typeof setInterval>;
	private maintenanceWatchdog?: ReturnType<typeof setInterval>;
	private unavailableEvidenceStarted = false;

	constructor(private readonly options: VoiceHealthReporterOptions) {}

	async registerBoot(): Promise<boolean> {
		if (!this.replayLoaded) {
			this.replayLoaded = true;
			this.filesystemBlocked = !(await this.loadPendingSpools());
		}
		if (this.filesystemBlocked) {
			await this.whenSettled();
			return false;
		}
		if (!this.registerQueued && this.generation === undefined) {
			this.registerQueued = true;
			this.currentDocument = {
				schemaVersion: 1,
				bootId: this.options.bootId,
				bootAt: this.now().toISOString(),
				events: [],
			};
			this.documents.set(this.options.bootId, this.currentDocument);
			this.queueAvailable();
		}
		this.startWatchdog();
		await this.whenSettled();
		return this.generation !== undefined;
	}

	observe(observation: VoiceHealthObservation): void {
		if (observation.kind === "poll_failed") {
			this.flushAllAggregates();
			this.sawPollFailure = true;
			this.enqueueResult(observation);
			return;
		}
		if (
			observation.kind === "idle_success" ||
			observation.kind === "progress"
		) {
			this.flushAggregatesExcept(observation.kind);
			this.observeNormal(observation);
			return;
		}
		this.flushAllAggregates();
		this.enqueueResult(observation);
	}

	evaluate(): void {
		if (this.queue.some(({ kind }) => kind === "evaluate")) return;
		this.enqueue({ kind: "evaluate", observedAt: this.now().toISOString() });
	}

	maintenanceCheckpoint(): void {
		if (this.queue.some(({ kind }) => kind === "maintenance")) return;
		this.enqueue({
			kind: "maintenance",
			requestedAt: this.now().toISOString(),
		});
	}

	whenSettled(): Promise<void> {
		if (!this.draining && this.pendingPersistence === 0)
			return Promise.resolve();
		return new Promise((resolve) => this.settlers.push(resolve));
	}

	stop(): void {
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = undefined;
		if (this.maintenanceWatchdog) clearInterval(this.maintenanceWatchdog);
		this.maintenanceWatchdog = undefined;
		this.flushAllAggregates();
		for (const timer of this.aggregateTimers.values()) clearTimeout(timer);
		this.aggregateTimers.clear();
		if (this.queue.length > 0) this.kick();
	}

	private now(): Date {
		return this.options.now?.() ?? new Date();
	}

	private monotonicNow(): number {
		return this.options.monotonicNow?.() ?? performance.now();
	}

	private startWatchdog(): void {
		if (this.watchdog) return;
		const watchdogMs = Math.min(
			this.options.watchdogMs ?? DEFAULT_WATCHDOG_MS,
			DEFAULT_WATCHDOG_MS,
		);
		this.watchdog = setInterval(() => this.evaluate(), watchdogMs);
		this.watchdog.unref?.();
		this.maintenanceWatchdog = setInterval(
			() => this.maintenanceCheckpoint(),
			DEFAULT_MAINTENANCE_MS,
		);
		this.maintenanceWatchdog.unref?.();
	}

	private observeNormal(
		observation: Extract<VoiceHealthObservation, { kind: NormalKind }>,
	): void {
		const kind = observation.kind;
		const current = this.monotonicNow();
		const last = this.lastNormalEnqueuedAt.get(kind);
		const windowMs = Math.min(
			this.options.aggregateWindowMs ?? DEFAULT_AGGREGATE_WINDOW_MS,
			DEFAULT_AGGREGATE_WINDOW_MS,
		);
		const recovery = kind === "idle_success" && this.sawPollFailure;
		if (last === undefined || current - last >= windowMs || recovery) {
			this.flushAggregate(kind);
			const successLogEvent =
				kind === "idle_success"
					? this.successLogEvent(current, recovery)
					: undefined;
			this.enqueueResult(
				{
					...observation,
					countDelta: observation.countDelta ?? 1,
				},
				successLogEvent,
			);
			this.lastNormalEnqueuedAt.set(kind, current);
			if (recovery) this.sawPollFailure = false;
			return;
		}

		const prior = this.aggregate.get(kind);
		if (!prior) this.aggregateOrder.push(kind);
		this.aggregate.set(kind, {
			observation,
			countDelta: (prior?.countDelta ?? 0) + (observation.countDelta ?? 1),
		});
		if (!this.aggregateTimers.has(kind)) {
			const timer = setTimeout(
				() => {
					this.aggregateTimers.delete(kind);
					this.flushAggregate(kind);
				},
				Math.max(0, windowMs - (current - last)),
			);
			timer.unref?.();
			this.aggregateTimers.set(kind, timer);
		}
		this.kick();
	}

	private successLogEvent(
		current: number,
		recovery: boolean,
	): VoiceHealthSuccessLogEvent | undefined {
		if (!this.options.onSuccessLog) return undefined;
		let event: VoiceHealthSuccessLogEvent | undefined;
		if (recovery) event = "recovered";
		else if (!this.hasScheduledSuccessLog) event = "initial_idle_success";
		else if (
			this.lastSuccessLogScheduledAt !== undefined &&
			current - this.lastSuccessLogScheduledAt >=
				DEFAULT_SUCCESS_LOG_HEARTBEAT_MS
		)
			event = "heartbeat";
		if (event) {
			this.hasScheduledSuccessLog = true;
			this.lastSuccessLogScheduledAt = current;
		}
		return event;
	}

	private flushAggregate(kind: NormalKind): void {
		const aggregate = this.aggregate.get(kind);
		if (!aggregate) return;
		this.aggregate.delete(kind);
		const orderIndex = this.aggregateOrder.indexOf(kind);
		if (orderIndex >= 0) this.aggregateOrder.splice(orderIndex, 1);
		const timer = this.aggregateTimers.get(kind);
		if (timer) clearTimeout(timer);
		this.aggregateTimers.delete(kind);
		// FLY-2693 R3: at the production 5 s poll cadence every success after
		// the first reaches the ledger through this flush, never through the
		// direct branch in observeNormal, so the flush must carry the 60 s
		// heartbeat too. The flushed observation is the latest aggregated
		// success and the counters still come from the committed receipt.
		const current = this.monotonicNow();
		const successLogEvent =
			kind === "idle_success"
				? this.successLogEvent(current, false)
				: undefined;
		this.enqueueResult(
			{
				...aggregate.observation,
				countDelta: aggregate.countDelta,
			},
			successLogEvent,
		);
		this.lastNormalEnqueuedAt.set(kind, current);
	}

	private flushAllAggregates(): void {
		for (const kind of [...this.aggregateOrder]) this.flushAggregate(kind);
	}

	private flushAggregatesExcept(kindToKeep: NormalKind): void {
		for (const kind of [...this.aggregateOrder])
			if (kind !== kindToKeep) this.flushAggregate(kind);
	}

	private enqueueResult(
		observation: VoiceHealthObservation,
		successLogEvent?: VoiceHealthSuccessLogEvent,
	): void {
		const document = this.currentSpoolDocument();
		const event: SpoolEvent = {
			producerEventSeq: this.nextProducerEventSeq,
			observation,
		};
		if (successLogEvent) this.successLogEvents.set(event, successLogEvent);
		this.nextProducerEventSeq += 1;
		document.events.push(event);
		void this.persistDocument(document)
			.then(() => {
				this.queueAvailable();
				this.kick();
			})
			.catch(() => this.signalUnavailable())
			.finally(() => this.settleIfIdle());
	}

	private enqueue(item: QueueItem): void {
		if (this.queue.length >= this.maxQueue()) {
			this.signalUnavailable();
			this.kick();
			return;
		}
		this.queue.push(item);
		this.kick();
	}

	private kick(): void {
		if (this.draining) {
			this.retryRequested = true;
			return;
		}
		this.draining = true;
		void this.drain();
	}

	private async drain(): Promise<void> {
		try {
			for (;;) {
				this.retryRequested = false;
				let failed = false;
				while (this.queue.length > 0) {
					const item = this.queue[0]!;
					try {
						await this.invokeItem(item);
						this.queue.shift();
						this.releaseQueuedItem(item);
						this.queueAvailable();
						this.unavailable = false;
					} catch {
						this.signalUnavailable();
						failed = true;
						break;
					}
				}
				if (!(failed && this.retryRequested)) break;
			}
		} finally {
			this.draining = false;
			this.settleIfIdle();
		}
	}

	private async invokeItem(item: QueueItem): Promise<void> {
		if (item.kind === "register") {
			const receipt = await this.options.client.invoke("register-boot", {
				bootId: item.document.bootId,
				bootAt: item.document.bootAt,
			});
			const generation = receipt.generation;
			if (
				typeof generation !== "number" ||
				!Number.isSafeInteger(generation) ||
				generation <= 0
			)
				throw new VoiceHealthUnavailableError();
			item.document.generation = generation;
			if (item.current) this.generation = generation;
			if (item.document.events.length > 0)
				await this.persistDocument(item.document);
			return;
		}
		if (item.kind === "evaluate") {
			const receipt = await this.options.client.invoke("evaluate", {
				observedAt: item.observedAt,
			});
			this.notifyFromReceipt(receipt);
			return;
		}
		if (item.kind === "maintenance") {
			await this.options.client.invoke("maintenance", {
				requestedAt: item.requestedAt,
			});
			return;
		}
		if (item.document.generation === undefined)
			throw new VoiceHealthUnavailableError();
		const observation = item.event.observation;
		const fields = observation as unknown as Record<string, unknown>;
		const payload: Record<string, unknown> = {
			generation: item.document.generation,
			producerEventSeq: item.event.producerEventSeq,
			resultKind: observation.kind,
			observedAt: observation.observedAt,
		};
		for (const field of [
			"durationMs",
			"reasonClass",
			"operation",
			"demandId",
			"attemptId",
			"successorAttemptId",
			"liveAt",
			"renewAt",
			"countDelta",
		] as const) {
			if (fields[field] !== undefined) payload[field] = fields[field];
		}
		const receipt = await this.options.client.invoke("record-result", payload);
		if (
			!(["recorded", "duplicate", "no_action"] as const).includes(
				receipt.status as "recorded" | "duplicate" | "no_action",
			) ||
			receipt.generation !== item.document.generation ||
			receipt.producerEventSeq !== item.event.producerEventSeq
		)
			throw new VoiceHealthUnavailableError();
		this.notifyFromReceipt(receipt);
		this.emitSuccessLog(item.event, receipt, item.document.generation);
		const eventIndex = item.document.events.indexOf(item.event);
		if (eventIndex < 0) throw new VoiceHealthUnavailableError();
		item.document.events.splice(eventIndex, 1);
		try {
			await this.persistDocument(item.document);
			if (
				item.document.events.length === 0 &&
				item.document !== this.currentDocument
			)
				this.documents.delete(item.document.bootId);
		} catch (error) {
			item.document.events.splice(eventIndex, 0, item.event);
			throw error;
		}
	}

	private emitSuccessLog(
		event: SpoolEvent,
		receipt: Record<string, unknown>,
		generation: number,
	): void {
		const logEvent = this.successLogEvents.get(event);
		if (!logEvent || event.observation.kind !== "idle_success") return;
		this.successLogEvents.delete(event);
		const { observationSeq, successCount, failureCount, failureStreak } =
			receipt;
		if (
			![observationSeq, successCount, failureCount, failureStreak].every(
				(value) =>
					typeof value === "number" &&
					Number.isSafeInteger(value) &&
					value >= 0,
			) ||
			observationSeq === 0
		)
			return;
		try {
			this.options.onSuccessLog?.({
				event: logEvent,
				timestamp: this.now().toISOString(),
				bootId: this.options.bootId,
				generation,
				producerEventSeq: event.producerEventSeq,
				observationSeq: observationSeq as number,
				mode: "idle",
				lastIterationSuccessAt: event.observation.observedAt,
				successCount: successCount as number,
				failureCount: failureCount as number,
				failureStreak: failureStreak as number,
				durationMs: event.observation.durationMs,
			});
		} catch {
			// Logging must never make a committed health observation retry forever.
		}
	}

	private notifyFromReceipt(receipt: Record<string, unknown>): void {
		const notification = receipt.notification;
		if (
			typeof notification !== "object" ||
			notification === null ||
			Array.isArray(notification)
		)
			return;
		const candidate = notification as Record<string, unknown>;
		if (
			typeof candidate.intentId !== "string" ||
			!/^[0-9a-f]{64}$/.test(candidate.intentId) ||
			!(["pending", "queued_transient", "config_error"] as const).includes(
				candidate.state as "pending" | "queued_transient" | "config_error",
			)
		)
			return;
		try {
			this.options.onNotification?.(candidate.intentId);
		} catch {
			this.signalUnavailable();
		}
	}

	private maxQueue(): number {
		return Math.max(
			1,
			Math.min(this.options.maxQueue ?? DEFAULT_MAX_QUEUE, DEFAULT_MAX_QUEUE),
		);
	}

	private currentSpoolDocument(): SpoolDocument {
		if (this.currentDocument) return this.currentDocument;
		this.currentDocument = {
			schemaVersion: 1,
			bootId: this.options.bootId,
			bootAt: this.now().toISOString(),
			events: [],
			...(this.generation === undefined ? {} : { generation: this.generation }),
		};
		this.documents.set(this.options.bootId, this.currentDocument);
		return this.currentDocument;
	}

	private queueAvailable(): void {
		if (this.filesystemBlocked) return;
		let saturated = false;
		const document = this.documents.values().next().value as
			| SpoolDocument
			| undefined;
		if (!document) return;
		if (document.generation === undefined) {
			if (
				this.queue.length < this.maxQueue() &&
				!this.queuedRegisters.has(document.bootId)
			) {
				this.queuedRegisters.add(document.bootId);
				this.queue.push({
					kind: "register",
					document,
					current: document === this.currentDocument,
				});
			} else if (!this.queuedRegisters.has(document.bootId)) {
				saturated = true;
			}
		} else {
			for (const event of document.events) {
				const key = this.eventKey(document, event);
				if (this.queuedEvents.has(key)) continue;
				if (this.queue.length >= this.maxQueue()) {
					saturated = true;
					break;
				}
				this.queuedEvents.add(key);
				this.queue.push({ kind: "result", document, event });
			}
		}
		if (saturated) this.signalUnavailable();
		if (this.queue.length > 0) this.kick();
	}

	private releaseQueuedItem(item: QueueItem): void {
		if (item.kind === "register") {
			this.queuedRegisters.delete(item.document.bootId);
			return;
		}
		if (item.kind === "result")
			this.queuedEvents.delete(this.eventKey(item.document, item.event));
	}

	private eventKey(document: SpoolDocument, event: SpoolEvent): string {
		return `${document.bootId}:${event.producerEventSeq}`;
	}

	private async loadPendingSpools(): Promise<boolean> {
		try {
			const pendingDir = await this.ensureSafeDirectory("pending");
			const census = await this.censusSafeFiles(pendingDir);
			const documents: SpoolDocument[] = [];
			for (const entry of census.entries) {
				const document = this.parseSpoolDocument(
					await this.readSafeFile(join(pendingDir, entry)),
				);
				if (!document || entry !== `${this.spoolDigest(document.bootId)}.json`)
					throw new VoiceHealthUnavailableError();
				documents.push(document);
			}
			documents.sort(
				(left, right) =>
					left.bootAt.localeCompare(right.bootAt) ||
					left.bootId.localeCompare(right.bootId),
			);
			for (const document of documents)
				this.documents.set(document.bootId, document);
			return true;
		} catch {
			this.signalUnavailable();
			return false;
		}
	}

	private parseSpoolDocument(value: string): SpoolDocument | undefined {
		try {
			const parsed = JSON.parse(value) as Partial<SpoolDocument>;
			const parsedBootAt =
				typeof parsed.bootAt === "string" ? new Date(parsed.bootAt) : undefined;
			if (
				parsed.schemaVersion !== 1 ||
				typeof parsed.bootId !== "string" ||
				parsed.bootId.length === 0 ||
				!parsedBootAt ||
				Number.isNaN(parsedBootAt.valueOf()) ||
				parsedBootAt.toISOString() !== parsed.bootAt ||
				(parsed.generation !== undefined &&
					(!Number.isSafeInteger(parsed.generation) ||
						parsed.generation <= 0)) ||
				!Array.isArray(parsed.events) ||
				parsed.events.length === 0
			)
				return undefined;
			for (const event of parsed.events) {
				if (
					typeof event !== "object" ||
					event === null ||
					!Number.isSafeInteger(event.producerEventSeq) ||
					event.producerEventSeq <= 0 ||
					typeof event.observation !== "object" ||
					event.observation === null ||
					typeof event.observation.kind !== "string" ||
					typeof event.observation.observedAt !== "string"
				)
					return undefined;
			}
			parsed.events.sort(
				(left, right) => left.producerEventSeq - right.producerEventSeq,
			);
			for (let index = 1; index < parsed.events.length; index += 1)
				if (
					parsed.events[index - 1]?.producerEventSeq ===
					parsed.events[index]?.producerEventSeq
				)
					return undefined;
			return parsed as SpoolDocument;
		} catch {
			return undefined;
		}
	}

	private persistDocument(document: SpoolDocument): Promise<void> {
		return this.schedulePersistence(async () => {
			const pendingDir = await this.ensureSafeDirectory("pending");
			const path = join(
				pendingDir,
				`${this.spoolDigest(document.bootId)}.json`,
			);
			if (document.events.length === 0) {
				const census = await this.censusSafeFiles(pendingDir);
				if (census.files.has(path)) {
					await rm(path);
					await this.syncDirectory(pendingDir);
				}
				return;
			}
			const encoded = JSON.stringify(document);
			await this.writeAtomic("pending", path, encoded);
		});
	}

	private schedulePersistence(operation: () => Promise<void>): Promise<void> {
		this.pendingPersistence += 1;
		const scheduled = this.persistenceTail.then(operation, operation);
		this.persistenceTail = scheduled.catch(() => undefined);
		return scheduled.finally(() => {
			this.pendingPersistence -= 1;
		});
	}

	private spoolDigest(bootId: string): string {
		return createHash("sha256").update(bootId).digest("hex");
	}

	private settleIfIdle(): void {
		if (this.draining || this.pendingPersistence > 0) return;
		const settlers = this.settlers.splice(0);
		for (const settle of settlers) settle();
	}

	private signalUnavailable(): void {
		if (!this.unavailableEvidenceStarted) {
			this.unavailableEvidenceStarted = true;
			void this.persistUnavailableEvidence()
				.catch(() => undefined)
				.finally(() => this.settleIfIdle());
		}
		if (this.unavailable) return;
		this.unavailable = true;
		try {
			this.options.onUnavailable?.({
				reasonClass: "health_observation_unavailable",
				operation: "health_store",
			});
		} catch {
			// Health diagnostics cannot block the daemon's lease or session work.
		}
	}

	private persistUnavailableEvidence(): Promise<void> {
		return this.schedulePersistence(async () => {
			const directory = await this.ensureSafeDirectory("unavailable");
			const digest = createHash("sha256")
				.update(this.options.bootId)
				.digest("hex");
			const path = join(directory, `${digest}.json`);
			const evidence = JSON.stringify({
				schemaVersion: 1,
				bootId: this.options.bootId,
				observedAt: this.now().toISOString(),
				reasonClass: "health_observation_unavailable",
				operation: "health_store",
			});
			await this.writeAtomic("unavailable", path, evidence);
		});
	}

	private async writeAtomic(
		kind: "pending" | "unavailable",
		path: string,
		content: string,
	): Promise<void> {
		const directory = await this.ensureSafeDirectory(kind);
		if (
			dirname(path) !== directory ||
			!/^[a-f0-9]{64}\.json$/.test(basename(path))
		)
			throw new VoiceHealthUnavailableError();
		const census = await this.censusSafeFiles(directory);
		const contentBytes = Buffer.byteLength(content, "utf8");
		const priorBytes = census.files.get(path)?.size ?? 0;
		if (
			contentBytes > MAX_SPOOL_BYTES ||
			census.usedBytes - priorBytes + contentBytes > MAX_SPOOL_BYTES ||
			(!census.files.has(path) && census.entries.length >= MAX_SPOOL_FILES)
		)
			throw new VoiceHealthUnavailableError();
		const temporary = join(directory, `.${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				this.assertSafeFile(await handle.stat());
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			this.assertSafeFile(await lstat(path));
			await this.syncDirectory(directory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async syncDirectory(directory: string): Promise<void> {
		const handle = await open(
			directory,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			this.assertSafeDirectory(await handle.stat(), true);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async ensureSafeDirectory(
		kind: "pending" | "unavailable",
	): Promise<string> {
		const stateRoot = resolve(this.options.stateRoot);
		const components = [
			stateRoot,
			join(stateRoot, "state"),
			join(stateRoot, "state", "voice-health"),
			join(stateRoot, "state", "voice-health", kind),
		];
		for (const [index, component] of components.entries()) {
			let existing: Stats;
			try {
				existing = await lstat(component);
			} catch (error) {
				if (!this.isMissing(error)) throw new VoiceHealthUnavailableError();
				if (index === 0) throw new VoiceHealthUnavailableError();
				try {
					await mkdir(component, { mode: 0o700 });
					existing = await lstat(component);
				} catch {
					throw new VoiceHealthUnavailableError();
				}
			}
			this.assertSafeDirectory(existing, index >= 2);
		}
		return components.at(-1)!;
	}

	private assertSafeDirectory(info: Stats, exactMode: boolean): void {
		const mode = info.mode & 0o777;
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			!this.ownedByEffectiveUser(info) ||
			(exactMode ? mode !== 0o700 : (mode & 0o022) !== 0)
		)
			throw new VoiceHealthUnavailableError();
	}

	private assertSafeFile(info: Stats): void {
		if (
			!info.isFile() ||
			info.isSymbolicLink() ||
			!this.ownedByEffectiveUser(info) ||
			(info.mode & 0o777) !== 0o600
		)
			throw new VoiceHealthUnavailableError();
	}

	private ownedByEffectiveUser(info: Stats): boolean {
		const effectiveUser = process.geteuid?.();
		return effectiveUser === undefined || info.uid === effectiveUser;
	}

	private async censusSafeFiles(directory: string): Promise<{
		entries: string[];
		files: Map<string, Stats>;
		usedBytes: number;
	}> {
		const entries = (await readdir(directory)).sort();
		if (entries.length > MAX_SPOOL_FILES)
			throw new VoiceHealthUnavailableError();
		const files = new Map<string, Stats>();
		let usedBytes = 0;
		for (const entry of entries) {
			if (!/^[a-f0-9]{64}\.json$/.test(entry))
				throw new VoiceHealthUnavailableError();
			const path = join(directory, entry);
			const info = await lstat(path);
			this.assertSafeFile(info);
			usedBytes += info.size;
			if (usedBytes > MAX_SPOOL_BYTES) throw new VoiceHealthUnavailableError();
			files.set(path, info);
		}
		return { entries, files, usedBytes };
	}

	private async readSafeFile(path: string): Promise<string> {
		const before = await lstat(path);
		this.assertSafeFile(before);
		if (before.size > MAX_SPOOL_BYTES) throw new VoiceHealthUnavailableError();
		const handle = await open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			const after = await handle.stat();
			this.assertSafeFile(after);
			if (
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.size !== before.size
			)
				throw new VoiceHealthUnavailableError();
			const content = Buffer.alloc(after.size + 1);
			let offset = 0;
			for (;;) {
				const { bytesRead } = await handle.read(
					content,
					offset,
					content.length - offset,
					offset,
				);
				if (bytesRead === 0) break;
				offset += bytesRead;
				if (offset > MAX_SPOOL_BYTES) throw new VoiceHealthUnavailableError();
			}
			if (offset !== after.size) throw new VoiceHealthUnavailableError();
			return content.subarray(0, offset).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	private isMissing(error: unknown): boolean {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT"
		);
	}
}
