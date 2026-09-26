import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	CommDB,
	type PhaseWakeInput,
	type RunnerPhaseWake,
} from "flywheel-comm/db";

export type CodexPhaseRole = "design" | "implement" | "qa";

export interface CodexWakeMessage extends PhaseWakeInput {}

export interface CodexWakeWatcher {
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): Promise<{ ok: boolean; lastEventTs?: number }>;
	onDelivered?: (message: CodexWakeMessage) => void | Promise<void>;
}

export interface PhaseHoldState {
	schemaVersion: 1;
	role: CodexPhaseRole;
	state: "entering" | "paused" | "reactivating";
	enteredAt: string;
	deadlineRemainingMs: number;
	hardDeadlineRemainingMs: number;
}

export type PhaseLifecycleObservation =
	| { kind: "active" }
	| { kind: "parked"; reason?: string }
	| {
			kind: "wake";
			message: {
				id: string;
				content: string;
				metadata?: Record<string, unknown>;
			};
	  }
	| { kind: "shutdown"; requestId: string }
	| { kind: "unknown"; error: string };

type SessionState = Record<string, unknown>;

function isPlainObject(value: unknown): value is SessionState {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertValidPhaseHold(value: unknown): asserts value is PhaseHoldState {
	if (!isPlainObject(value)) throw new Error("invalid phaseHold object");
	if (value.schemaVersion !== 1)
		throw new Error("invalid phaseHold schemaVersion");
	if (!(["design", "implement", "qa"] as unknown[]).includes(value.role)) {
		throw new Error("invalid phaseHold role");
	}
	if (
		!(["entering", "paused", "reactivating"] as unknown[]).includes(value.state)
	) {
		throw new Error("invalid phaseHold state");
	}
	if (typeof value.enteredAt !== "string" || !value.enteredAt) {
		throw new Error("invalid phaseHold enteredAt");
	}
	if (!isFiniteNonNegative(value.deadlineRemainingMs)) {
		throw new Error("invalid phaseHold deadlineRemainingMs");
	}
	if (!isFiniteNonNegative(value.hardDeadlineRemainingMs)) {
		throw new Error("invalid phaseHold hardDeadlineRemainingMs");
	}
}

function readSessionState(path: string): SessionState {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isPlainObject(parsed))
		throw new Error("invalid Codex session state object");
	if (parsed.phaseHold !== undefined) assertValidPhaseHold(parsed.phaseHold);
	return parsed;
}

/**
 * Merge one writer's fields into the shared Codex session state and publish via
 * fsync + atomic rename. An `undefined` patch value removes that field. Invalid
 * existing state is never overwritten: parse/validation happens before the
 * temp file is created.
 */
export function atomicMergeCodexSessionState(
	path: string,
	patch: SessionState,
): SessionState {
	if (!isPlainObject(patch))
		throw new Error("invalid Codex session state patch");
	const current = readSessionState(path);
	const merged: SessionState = { ...current, ...patch };
	for (const [key, value] of Object.entries(merged)) {
		if (value === undefined) delete merged[key];
	}
	if (merged.phaseHold !== undefined) assertValidPhaseHold(merged.phaseHold);

	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeSync(fd, `${JSON.stringify(merged, null, 2)}\n`, undefined, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
		return merged;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		rmSync(temp, { force: true });
		throw error;
	}
}

interface PhaseLifecycleDb {
	getRunnerShutdown(executionId: string): {
		request_id: string;
		state: "requested" | "acked" | "failed";
	} | null;
	listRunnerPhaseWakes(executionId: string): RunnerPhaseWake[];
	getEffectiveDeclaredState(
		executionId: string,
		nowMs: number,
	): { kind: "parked" | "long_task"; reason: string | null } | null;
	enqueueRunnerPhaseWake(
		executionId: string,
		message: PhaseWakeInput,
		nowMs: number,
	): unknown;
	markRunnerPhaseWakeStarted(
		executionId: string,
		messageId: string,
		nowMs: number,
	): boolean;
	finishRunnerPhaseWake(
		executionId: string,
		messageId: string,
		nowMs: number,
	): boolean;
	finishRunnerShutdown(
		executionId: string,
		requestId: string,
		result: { ok: true } | { ok: false; error: string },
		nowMs: number,
	): boolean;
	clearDeclaredState(executionId: string): void;
	close?(): void;
}

export interface CodexPhaseLifecycleControllerOptions {
	executionId: string;
	role: CodexPhaseRole;
	commDbPath: string;
	sessionStatePath: string;
	mailboxAgentName?: string;
	watcher?: CodexWakeWatcher | null;
	shutdownPollIntervalMs?: number;
	now?: () => number;
	db?: PhaseLifecycleDb;
}

export interface CodexPhaseLifecycle {
	start(): Promise<void>;
	stop(): Promise<void>;
	stopIntake(): Promise<void>;
	waitForShutdown(): Promise<{ requestId: string }>;
	observe(): PhaseLifecycleObservation;
	getPhaseHold(): PhaseHoldState | null;
	enterHold(budget: {
		deadlineRemainingMs: number;
		hardDeadlineRemainingMs: number;
	}): Promise<void>;
	confirmHoldPaused(): Promise<void>;
	waitForActivity(timeoutMs: number): Promise<void>;
	leaveHold(): Promise<void>;
	markWakeStarted(messageId: string): void;
	finishWake(messageId: string): void;
	ackShutdown(
		requestId: string,
		result: { ok: true } | { ok: false; error: string },
	): void;
}

export class CodexPhaseLifecycleController implements CodexPhaseLifecycle {
	private readonly db: PhaseLifecycleDb;
	private readonly ownsDb: boolean;
	private readonly now: () => number;
	private readonly shutdownPollIntervalMs: number;
	private shutdownTimer: ReturnType<typeof setInterval> | undefined;
	private shutdownResolve:
		| ((shutdown: { requestId: string }) => void)
		| undefined;
	private readonly shutdownPromise: Promise<{ requestId: string }>;
	private started = false;
	private stopped = false;
	private watcherStarted = false;
	private readonly activityWaiters = new Set<() => void>();

	constructor(private readonly options: CodexPhaseLifecycleControllerOptions) {
		this.db = options.db ?? new CommDB(options.commDbPath);
		this.ownsDb = options.db === undefined;
		this.now = options.now ?? Date.now;
		this.shutdownPollIntervalMs = Math.min(
			1_000,
			Math.max(1, options.shutdownPollIntervalMs ?? 250),
		);
		this.shutdownPromise = new Promise((resolve) => {
			this.shutdownResolve = resolve;
		});
	}

	async start(): Promise<void> {
		if (this.started) return;
		if (this.stopped)
			throw new Error("phase lifecycle controller already stopped");
		this.started = true;
		this.pollShutdown();
		this.shutdownTimer = setInterval(
			() => this.pollShutdown(),
			this.shutdownPollIntervalMs,
		);
		(this.shutdownTimer as { unref?: () => void }).unref?.();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.shutdownTimer) clearInterval(this.shutdownTimer);
		this.shutdownTimer = undefined;
		try {
			await this.stopIntake();
		} finally {
			this.signalActivity();
			if (this.ownsDb) this.db.close?.();
		}
	}

	async stopIntake(): Promise<void> {
		if (!this.watcherStarted) return;
		try {
			await this.options.watcher?.stop();
		} finally {
			this.watcherStarted = false;
		}
	}

	waitForShutdown(): Promise<{ requestId: string }> {
		this.pollShutdown();
		return this.shutdownPromise;
	}

	observe(): PhaseLifecycleObservation {
		try {
			const shutdown = this.db.getRunnerShutdown(this.options.executionId);
			if (shutdown?.state === "requested") {
				return { kind: "shutdown", requestId: shutdown.request_id };
			}
			const wake = this.db
				.listRunnerPhaseWakes(this.options.executionId)
				.find((candidate) => candidate.state !== "finished");
			if (wake) {
				const metadata = wake.metadata_json
					? (JSON.parse(wake.metadata_json) as Record<string, unknown>)
					: undefined;
				return {
					kind: "wake",
					message: {
						id: wake.message_id,
						content: wake.content,
						...(metadata ? { metadata } : {}),
					},
				};
			}
			const declared = this.db.getEffectiveDeclaredState(
				this.options.executionId,
				this.now(),
			);
			if (declared?.kind === "parked") {
				return {
					kind: "parked",
					...(declared.reason ? { reason: declared.reason } : {}),
				};
			}
			return { kind: "active" };
		} catch (error) {
			return {
				kind: "unknown",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	getPhaseHold(): PhaseHoldState | null {
		const state = readSessionState(this.options.sessionStatePath);
		if (state.phaseHold === undefined) return null;
		assertValidPhaseHold(state.phaseHold);
		return state.phaseHold;
	}

	async enterHold(budget: {
		deadlineRemainingMs: number;
		hardDeadlineRemainingMs: number;
	}): Promise<void> {
		if (!isFiniteNonNegative(budget.deadlineRemainingMs)) {
			throw new Error("invalid active deadline remainder");
		}
		if (!isFiniteNonNegative(budget.hardDeadlineRemainingMs)) {
			throw new Error("invalid hard deadline remainder");
		}
		const enteredAt = new Date(this.now()).toISOString();
		const base: Omit<PhaseHoldState, "state"> = {
			schemaVersion: 1,
			role: this.options.role,
			enteredAt,
			deadlineRemainingMs: budget.deadlineRemainingMs,
			hardDeadlineRemainingMs: budget.hardDeadlineRemainingMs,
		};
		atomicMergeCodexSessionState(this.options.sessionStatePath, {
			phaseHold: { ...base, state: "entering" },
		});
	}

	async confirmHoldPaused(): Promise<void> {
		const hold = this.getPhaseHold();
		if (!hold) throw new Error("cannot confirm a missing phaseHold");
		atomicMergeCodexSessionState(this.options.sessionStatePath, {
			phaseHold: { ...hold, state: "paused" },
		});
		if (this.options.watcher && !this.watcherStarted) {
			this.options.watcher.onDelivered = async (message) => {
				if (
					this.options.mailboxAgentName &&
					message.to !== this.options.mailboxAgentName
				) {
					throw new Error(
						`phase wake recipient mismatch: expected ${this.options.mailboxAgentName}, got ${message.to}`,
					);
				}
				this.db.enqueueRunnerPhaseWake(
					this.options.executionId,
					message,
					this.now(),
				);
				this.signalActivity();
			};
			this.watcherStarted = true;
			try {
				await this.options.watcher.start();
			} catch (error) {
				try {
					await this.options.watcher.stop();
				} finally {
					this.watcherStarted = false;
				}
				throw error;
			}
		}
	}

	waitForActivity(timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.activityWaiters.delete(done);
				resolve();
			};
			this.activityWaiters.add(done);
			const timer = setTimeout(done, Math.max(0, timeoutMs));
		});
	}

	async leaveHold(): Promise<void> {
		const current = readSessionState(this.options.sessionStatePath);
		if (current.phaseHold !== undefined) {
			assertValidPhaseHold(current.phaseHold);
			atomicMergeCodexSessionState(this.options.sessionStatePath, {
				phaseHold: { ...current.phaseHold, state: "reactivating" },
			});
		}
		if (this.watcherStarted) {
			await this.options.watcher?.stop();
			this.watcherStarted = false;
		}
		this.db.clearDeclaredState(this.options.executionId);
		atomicMergeCodexSessionState(this.options.sessionStatePath, {
			phaseHold: undefined,
		});
	}

	markWakeStarted(messageId: string): void {
		if (
			this.db.markRunnerPhaseWakeStarted(
				this.options.executionId,
				messageId,
				this.now(),
			)
		) {
			return;
		}
		const existing = this.db
			.listRunnerPhaseWakes(this.options.executionId)
			.find((wake) => wake.message_id === messageId);
		if (existing?.state === "started" || existing?.state === "finished") return;
		throw new Error(`phase wake ${messageId} could not transition to started`);
	}

	finishWake(messageId: string): void {
		if (
			this.db.finishRunnerPhaseWake(
				this.options.executionId,
				messageId,
				this.now(),
			)
		) {
			return;
		}
		const existing = this.db
			.listRunnerPhaseWakes(this.options.executionId)
			.find((wake) => wake.message_id === messageId);
		if (existing?.state === "finished") return;
		throw new Error(`phase wake ${messageId} could not transition to finished`);
	}

	ackShutdown(
		requestId: string,
		result: { ok: true } | { ok: false; error: string },
	): void {
		if (
			!this.db.finishRunnerShutdown(
				this.options.executionId,
				requestId,
				result,
				this.now(),
			)
		) {
			throw new Error(
				`shutdown acknowledgement refused for ${this.options.executionId}/${requestId}`,
			);
		}
	}

	private pollShutdown(): void {
		if (this.stopped || !this.shutdownResolve) return;
		try {
			const shutdown = this.db.getRunnerShutdown(this.options.executionId);
			if (shutdown?.state === "requested") {
				const resolve = this.shutdownResolve;
				this.shutdownResolve = undefined;
				resolve({ requestId: shutdown.request_id });
				this.signalActivity();
			}
		} catch {
			// Fail closed: retain the live controller and retry on the next local tick.
		}
	}

	private signalActivity(): void {
		for (const resolve of [...this.activityWaiters]) resolve();
	}
}
