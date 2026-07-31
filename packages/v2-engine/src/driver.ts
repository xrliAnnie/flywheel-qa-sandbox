import type { RunRecordedActionResult } from "flywheel-v2-actions";
import {
	FENCE,
	FenceViolation,
	type JsonValue,
	type Kernel,
} from "flywheel-v2-kernel";
import { readEngineConfigTx } from "./config.js";
import { pollOnce, refreshHeartbeat } from "./consume-loop.js";
import {
	captureConversionActionContext,
	runConversionAction,
	validateConversionActionSpec,
} from "./conversion-actions.js";
import {
	reattachAgent,
	registerAgentTx,
	type SessionEvidenceProbe,
} from "./registration.js";
import {
	serializeSessionBinding,
	sessionBindingsEqual,
} from "./session-binding.js";
import { reportConversionFailure, submitProposal } from "./settlement.js";
import { ENGINE_SQL } from "./sql.js";
import { settleFailureMailboxTx } from "./transitions.js";
import {
	type AttemptHandle,
	type ConversionActionSpec,
	type ConversionProposal,
	type ConversionResult,
	type Converter,
	type EngineRuntime,
	type LeadIdentityDraft,
	type PollResult,
	PollTransientError,
	type ProposalAuthorization,
	type RegisteredAgent,
} from "./types.js";

interface AgentState {
	agent: RegisteredAgent;
	converter?: Converter;
	founderStreak: number;
	currentAttemptUid?: string;
	handler?: Promise<void>;
	heartbeatTimer?: ReturnType<typeof setInterval>;
	lastError?: unknown;
	stopped: boolean;
	inFlightActions: Set<Promise<RunRecordedActionResult>>;
	attemptActions: Set<Promise<RunRecordedActionResult>>;
}

interface RunningRow {
	attempt_uid: string;
	message_uid: string;
	instance_id: string;
	generation: number;
	activation_id: string | null;
}

export interface EngineDriverOptions {
	requireProposalCapability?: boolean;
	/**
	 * FLY-1547 §2.2: who pulls a LEAD's mailbox. "driver" (default) keeps the
	 * historical prefetch loop; "host" retires it so the host's `next_delivery`
	 * is the claim boundary (claim-at-next — the processing attempt IS the read
	 * receipt and must be created by the recipient's own pull).
	 */
	leadMailboxPull?: "driver" | "host";
}

function sameAgent(left: RegisteredAgent, right: RegisteredAgent): boolean {
	const bindingsMatch =
		left.kind === "lead" && right.kind === "lead"
			? sessionBindingsEqual(left.sessionBinding, right.sessionBinding)
			: (left.sessionBinding === undefined) ===
					(right.sessionBinding === undefined) &&
				(left.sessionBinding === undefined ||
					right.sessionBinding === undefined ||
					sessionBindingsEqual(left.sessionBinding, right.sessionBinding));
	return (
		left.kind === right.kind &&
		left.agentId === right.agentId &&
		left.instanceId === right.instanceId &&
		left.generation === right.generation &&
		bindingsMatch &&
		(left.kind === "lead" ||
			(right.kind === "runner" && left.activationId === right.activationId))
	);
}

function sqliteCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

function wrapPollError(error: unknown): never {
	const code = sqliteCode(error);
	if (code?.startsWith("SQLITE_BUSY")) {
		throw new PollTransientError("SQLITE_BUSY", error);
	}
	if (code?.startsWith("SQLITE_LOCKED")) {
		throw new PollTransientError("SQLITE_LOCKED", error);
	}
	throw error;
}

export class EngineDriver {
	readonly #kernel: Kernel;
	readonly #runtime: EngineRuntime;
	readonly #states = new Map<string, AgentState>();
	readonly #locks = new Map<string, Promise<unknown>>();
	readonly #requireProposalCapability: boolean;
	#stopped = false;
	readonly #leadMailboxPull: "driver" | "host";

	constructor(
		kernel: Kernel,
		runtime: EngineRuntime,
		options: EngineDriverOptions = {},
	) {
		this.#kernel = kernel;
		this.#runtime = runtime;
		this.#requireProposalCapability =
			options.requireProposalCapability ?? false;
		this.#leadMailboxPull = options.leadMailboxPull ?? "driver";
	}

	registerLead(
		agentId: string,
		draft: LeadIdentityDraft,
		converter: Converter,
	): Promise<RegisteredAgent> {
		return this.#serialize(agentId, () => {
			this.#assertRunning();
			if (draft.kind !== "lead") {
				throw new FenceViolation("registerLead requires a lead identity");
			}
			const previous = this.#states.get(agentId);
			if (previous) {
				this.#assertNoInFlightActions(previous, "replace lead registration");
			}
			const agent = this.#kernel.write("consumer.register.lead", (tx) =>
				registerAgentTx(tx, this.#runtime, agentId, draft),
			);
			const founderStreak = this.#kernel.read(
				(tx) => readEngineConfigTx(tx).vipBurst,
			);
			if (previous) this.#stopState(previous);
			const state: AgentState = {
				agent,
				converter,
				founderStreak,
				stopped: false,
				inFlightActions: new Set(),
				attemptActions: new Set(),
			};
			this.#states.set(agentId, state);
			this.#startHeartbeat(state);
			// FLY-1547 §2.2: in host-pull mode the lead mailbox is claimed at
			// `next` by the host, never prefetched here — the read receipt must be
			// created by the recipient's own authenticated pull.
			if (this.#leadMailboxPull === "driver") this.#ensureLeadHandler(state);
			return agent;
		});
	}

	reattachLead(
		agentId: string,
		expected: RegisteredAgent,
		converter: Converter,
		hostEpoch: string,
		probe: SessionEvidenceProbe,
	): Promise<RegisteredAgent> {
		return this.#serialize(agentId, () => {
			this.#assertRunning();
			if (expected.kind !== "lead" || expected.agentId !== agentId) {
				throw new FenceViolation(
					"reattachLead requires a matching lead identity",
				);
			}
			const previous = this.#states.get(agentId);
			if (previous) {
				this.#assertNoInFlightActions(previous, "replace lead reattach");
			}
			const agent = reattachAgent({
				kernel: this.#kernel,
				runtime: this.#runtime,
				expected,
				hostEpoch,
				probe,
			});
			const founderStreak = this.#kernel.read(
				(tx) => readEngineConfigTx(tx).vipBurst,
			);
			if (previous) this.#stopState(previous);
			const state: AgentState = {
				agent,
				converter,
				founderStreak,
				stopped: false,
				inFlightActions: new Set(),
				attemptActions: new Set(),
			};
			this.#states.set(agentId, state);
			this.#startHeartbeat(state);
			if (this.#leadMailboxPull === "driver") this.#ensureLeadHandler(state);
			return agent;
		});
	}

	poll(agentId: string, currentAttemptUid?: string): PollResult {
		this.#assertRunning();
		const state = this.#requireState(agentId);
		let attemptHint = currentAttemptUid ?? state.currentAttemptUid;
		// FLY-1503 item 8: driver.stop() and a generation takeover both settle a
		// running processing attempt as 'crashed'. The in-memory hint kept pointing
		// at that settled attempt, so pollOnce never handed out the next message
		// and the executor stayed wedged. A hint whose attempt is no longer running
		// is stale by definition, so ignore it for this poll.
		//
		// Only the local hint is dropped: state.currentAttemptUid is deliberately
		// left alone so the generation fences that read it (#requireHandleState,
		// and through it submitProposal) keep reporting the precise reason a stale
		// driver was refused. It is overwritten below if a new message arrives.
		if (attemptHint !== undefined && !this.#attemptIsRunning(attemptHint)) {
			attemptHint = undefined;
		}
		if (state.lastError instanceof PollTransientError) {
			state.lastError = undefined;
			state.currentAttemptUid = undefined;
			attemptHint = undefined;
		} else if (state.lastError !== undefined) {
			throw state.lastError;
		}
		const result = this.#pollState(state, attemptHint);
		if (result.status === "available") {
			state.currentAttemptUid = result.handle.attemptUid;
			if (state.converter) {
				this.#ensureLeadHandler(state, result);
			}
		}
		return result;
	}

	async drain(agentId: string): Promise<void> {
		const state = this.#requireState(agentId);
		if (!state.converter) {
			throw new TypeError("drain is available for lead agents only");
		}
		this.#ensureLeadHandler(state);
		await state.handler;
		if (state.lastError) throw state.lastError;
	}

	submitProposal(
		proposal: ConversionProposal,
		authorization?: ProposalAuthorization,
	): string {
		const state = this.#requireHandleState(proposal.handle);
		this.#assertNoInFlightActions(state, "submit proposal");
		if (this.#requireProposalCapability && !authorization) {
			throw new FenceViolation("proposal capability is required");
		}
		const digest = submitProposal(
			this.#kernel,
			this.#runtime,
			proposal,
			authorization,
		);
		state.attemptActions.clear();
		state.currentAttemptUid = undefined;
		return digest;
	}

	reportConversionFailure(handle: AttemptHandle, error: string): void {
		const state = this.#requireHandleState(handle);
		this.#assertNoInFlightActions(state, "report conversion failure");
		reportConversionFailure(this.#kernel, this.#runtime, handle, error);
		state.attemptActions.clear();
		state.currentAttemptUid = undefined;
	}

	performConversionAction<Result extends JsonValue>(
		handle: AttemptHandle,
		action: ConversionActionSpec,
		perform: () => Result | Promise<Result>,
	): Promise<RunRecordedActionResult> {
		this.#assertRunning();
		validateConversionActionSpec(action);
		const state = this.#requireHandleState(handle);
		let captured: ReturnType<typeof captureConversionActionContext>;
		try {
			captured = captureConversionActionContext(this.#kernel, handle);
		} catch (error) {
			return Promise.reject(error);
		}
		let resolve!: (result: RunRecordedActionResult) => void;
		let reject!: (error: unknown) => void;
		const pending = new Promise<RunRecordedActionResult>(
			(resolvePromise, rejectPromise) => {
				resolve = resolvePromise;
				reject = rejectPromise;
			},
		);
		state.inFlightActions.add(pending);
		state.attemptActions.add(pending);
		void pending.catch(() => undefined);
		void pending.then(
			() => state.inFlightActions.delete(pending),
			() => state.inFlightActions.delete(pending),
		);
		queueMicrotask(() => {
			void runConversionAction(
				this.#kernel,
				this.#runtime,
				captured,
				action,
				perform,
			).then(resolve, reject);
		});
		return pending;
	}

	stop(): void {
		if (this.#stopped) return;
		for (const state of this.#states.values()) {
			this.#assertNoInFlightActions(state, "stop engine");
		}
		this.#stopped = true;
		const errors: unknown[] = [];
		try {
			for (const state of this.#states.values()) {
				this.#stopState(state);
				// FLY-1543 ⑤: runners never attach to the driver any more; their
				// processing attempts survive a host restart on purpose (the tmux
				// session outlives the host and settles by pull + submit).
				if (state.agent.kind !== "lead") continue;
				const leadAgent = state.agent;
				try {
					this.#kernel.write("consumer.stop", (tx) => {
						const current = tx.get<{
							kind: string;
							generation: number;
							instance_id: string | null;
							session_binding: string | null;
						}>(ENGINE_SQL.readAgent, { agentId: leadAgent.agentId });
						if (
							!current ||
							current.kind !== leadAgent.kind ||
							current.generation !== leadAgent.generation ||
							current.instance_id !== leadAgent.instanceId ||
							current.session_binding !==
								serializeSessionBinding(leadAgent.sessionBinding)
						) {
							return;
						}
						const running = tx.all<RunningRow>(
							ENGINE_SQL.readRecipientRunning,
							{ agent: leadAgent.agentId },
						);
						for (const row of running) {
							if (
								row.generation !== leadAgent.generation ||
								row.instance_id !== leadAgent.instanceId ||
								row.activation_id !== null
							) {
								throw new FenceViolation(
									`stop found foreign running attempt ${row.attempt_uid}`,
								);
							}
							tx.cas(FENCE.processingAttemptCasRunningSettled, {
								attemptUid: row.attempt_uid,
								outcome: "crashed",
								settledAt: this.#runtime.clock.nowIso(),
								proposalDigest: null,
							});
							settleFailureMailboxTx(tx, this.#runtime, {
								agentId: leadAgent.agentId,
								messageUid: row.message_uid,
								attemptUid: row.attempt_uid,
								generation: leadAgent.generation,
							});
						}
						tx.cas(ENGINE_SQL.casOffline, {
							agentId: leadAgent.agentId,
							kind: leadAgent.kind,
							generation: leadAgent.generation,
						});
					});
				} catch (error) {
					errors.push(error);
				}
			}
		} finally {
			this.#states.clear();
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, "one or more agents failed to stop");
		}
	}

	#startHeartbeat(state: AgentState): void {
		const intervalMs = this.#kernel.read(
			(tx) => readEngineConfigTx(tx).heartbeatWriteIntervalMs,
		);
		state.heartbeatTimer = setInterval(() => {
			if (state.stopped) return;
			try {
				refreshHeartbeat(this.#kernel, this.#runtime, state.agent);
			} catch (error) {
				// Preserve the failure for the driver's normal error surface while
				// allowing the fenced timer to retry on the next cadence.
				state.lastError ??= error;
			}
		}, intervalMs);
		(
			state.heartbeatTimer as ReturnType<typeof setInterval> & {
				unref?: () => void;
			}
		).unref?.();
	}

	#stopState(state: AgentState): void {
		state.stopped = true;
		if (state.heartbeatTimer) {
			clearInterval(state.heartbeatTimer);
			state.heartbeatTimer = undefined;
		}
	}

	#ensureLeadHandler(
		state: AgentState,
		seed?: Extract<PollResult, { status: "available" }>,
	): void {
		if (state.handler || state.stopped) return;
		state.lastError = undefined;
		state.handler = this.#runLead(state, seed)
			.catch((error: unknown) => {
				try {
					wrapPollError(error);
				} catch (wrapped) {
					state.lastError = wrapped;
					throw wrapped;
				}
			})
			.finally(() => {
				state.handler = undefined;
			});
		void state.handler.catch(() => undefined);
	}

	async #runLead(
		state: AgentState,
		seed?: Extract<PollResult, { status: "available" }>,
	): Promise<void> {
		let next = seed;
		while (!state.stopped) {
			if (!next) {
				const result = this.#pollState(state, state.currentAttemptUid);
				if (result.status === "empty") return;
				if (result.status === "busy") return;
				next = result;
			}
			const handle = next.handle;
			state.currentAttemptUid = handle.attemptUid;
			let contextClosed = false;
			const context = {
				handle,
				performAction: <Result extends JsonValue>(
					action: ConversionActionSpec,
					perform: () => Result | Promise<Result>,
				): Promise<RunRecordedActionResult> => {
					if (contextClosed) {
						const rejected = Promise.reject<RunRecordedActionResult>(
							new FenceViolation(
								`conversion context is closed for ${handle.attemptUid}`,
							),
						);
						void rejected.catch(() => undefined);
						return rejected;
					}
					return this.performConversionAction(handle, action, perform);
				},
			};
			let converted: ConversionResult;
			try {
				converted = await (state.converter as Converter)(
					{
						messageUid: next.handle.messageUid,
						payload: next.payload,
						kind: next.kind,
						sourceKind: next.sourceKind,
						seq: next.seq,
					},
					context,
				);
			} catch (error) {
				converted = {
					ok: false as const,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			contextClosed = true;
			const actionOutcomes = await this.#drainAttemptActions(state);
			const actionFailure = actionOutcomes.find(
				(outcome): outcome is PromiseRejectedResult =>
					outcome.status === "rejected",
			);
			if (actionFailure) {
				const error = actionFailure.reason;
				converted = {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			if (state.stopped) return;
			if (converted.ok) {
				this.submitProposal(
					{
						handle,
						effects: converted.effects,
					},
					converted.authorization,
				);
			} else {
				this.reportConversionFailure(handle, converted.error);
			}
			next = undefined;
		}
	}

	async #drainAttemptActions(
		state: AgentState,
	): Promise<PromiseSettledResult<RunRecordedActionResult>[]> {
		let snapshot = [...state.attemptActions];
		let outcomes = await Promise.allSettled(snapshot);
		while (snapshot.length !== state.attemptActions.size) {
			snapshot = [...state.attemptActions];
			outcomes = await Promise.allSettled(snapshot);
		}
		return outcomes;
	}

	#pollState(state: AgentState, currentAttemptUid?: string): PollResult {
		try {
			const polled = pollOnce(
				this.#kernel,
				this.#runtime,
				state.agent,
				state.founderStreak,
				currentAttemptUid,
			);
			state.founderStreak = polled.nextFounderStreak;
			return polled.result;
		} catch (error) {
			return wrapPollError(error);
		}
	}

	/** FLY-1503 item 8: is this processing attempt still the live one? */
	#attemptIsRunning(attemptUid: string): boolean {
		return (
			this.#kernel.read(
				(tx) =>
					tx.get<{ outcome: string }>(
						"SELECT outcome FROM processing_attempts WHERE attempt_uid=@attemptUid",
						{ attemptUid },
					)?.outcome,
			) === "running"
		);
	}

	#requireHandleState(handle: AttemptHandle): AgentState {
		const state = this.#requireState(handle.agent.agentId);
		if (
			!sameAgent(state.agent, handle.agent) ||
			state.currentAttemptUid !== handle.attemptUid
		) {
			throw new FenceViolation(`no current handler for ${handle.attemptUid}`);
		}
		return state;
	}

	#requireState(agentId: string): AgentState {
		const state = this.#states.get(agentId);
		if (!state || state.stopped) {
			throw new FenceViolation(`no attached agent ${agentId}`);
		}
		return state;
	}

	#assertNoInFlightActions(state: AgentState, operation: string): void {
		if (state.inFlightActions.size > 0) {
			throw new FenceViolation(
				`${operation} cannot run while conversion actions are in flight`,
			);
		}
	}

	#assertRunning(): void {
		if (this.#stopped) throw new Error("engine driver is stopped");
	}

	#serialize<T>(agentId: string, fn: () => T | Promise<T>): Promise<T> {
		const prior = this.#locks.get(agentId) ?? Promise.resolve();
		const current = prior.then(fn, fn);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.#locks.set(agentId, tail);
		void tail.finally(() => {
			if (this.#locks.get(agentId) === tail) this.#locks.delete(agentId);
		});
		return current;
	}
}
