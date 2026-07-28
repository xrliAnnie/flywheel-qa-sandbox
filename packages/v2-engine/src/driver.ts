import { FENCE, FenceViolation, type Kernel } from "flywheel-v2-kernel";
import { readEngineConfigTx } from "./config.js";
import { pollOnce, refreshHeartbeat } from "./consume-loop.js";
import { registerAgentTx } from "./registration.js";
import { reportConversionFailure, submitProposal } from "./settlement.js";
import { ENGINE_SQL } from "./sql.js";
import { settleFailureMailboxTx } from "./transitions.js";
import {
	type AttemptHandle,
	type ConversionProposal,
	type ConversionResult,
	type Converter,
	type DeathEvidence,
	type EngineRuntime,
	type LeadIdentityDraft,
	type PollResult,
	PollTransientError,
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
}

interface RunningRow {
	attempt_uid: string;
	message_uid: string;
	instance_id: string;
	generation: number;
	activation_id: string | null;
}

function sameAgent(left: RegisteredAgent, right: RegisteredAgent): boolean {
	return (
		left.kind === right.kind &&
		left.agentId === right.agentId &&
		left.instanceId === right.instanceId &&
		left.generation === right.generation &&
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
	#stopped = false;

	constructor(kernel: Kernel, runtime: EngineRuntime) {
		this.#kernel = kernel;
		this.#runtime = runtime;
	}

	registerLead(
		agentId: string,
		draft: LeadIdentityDraft,
		converter: Converter,
		evidence?: DeathEvidence,
	): Promise<RegisteredAgent> {
		return this.#serialize(agentId, () => {
			this.#assertRunning();
			if (draft.kind !== "lead") {
				throw new FenceViolation("registerLead requires a lead identity");
			}
			const agent = this.#kernel.write("consumer.register.lead", (tx) =>
				registerAgentTx(tx, this.#runtime, agentId, draft, evidence),
			);
			const founderStreak = this.#kernel.read(
				(tx) => readEngineConfigTx(tx).vipBurst,
			);
			const previous = this.#states.get(agentId);
			if (previous) this.#stopState(previous);
			const state: AgentState = {
				agent,
				converter,
				founderStreak,
				stopped: false,
			};
			this.#states.set(agentId, state);
			this.#startHeartbeat(state);
			this.#ensureLeadHandler(state);
			return agent;
		});
	}

	attachRunner(agentId: string, agent: RegisteredAgent): Promise<void> {
		return this.#serialize(agentId, () => {
			this.#assertRunning();
			if (agent.kind !== "runner" || agent.agentId !== agentId) {
				throw new FenceViolation("attachRunner requires matching runner agent");
			}
			this.#kernel.read((tx) => {
				const row = tx.get<{
					kind: string;
					generation: number;
				}>(ENGINE_SQL.readAgent, { agentId });
				if (
					!row ||
					row.kind !== agent.kind ||
					row.generation !== agent.generation
				) {
					throw new FenceViolation(`runner ${agentId} is not current`);
				}
			});
			const founderStreak = this.#kernel.read(
				(tx) => readEngineConfigTx(tx).vipBurst,
			);
			const previous = this.#states.get(agentId);
			if (previous) this.#stopState(previous);
			this.#states.set(agentId, {
				agent,
				founderStreak,
				stopped: false,
			});
		});
	}

	poll(agentId: string, currentAttemptUid?: string): PollResult {
		this.#assertRunning();
		const state = this.#requireState(agentId);
		let attemptHint = currentAttemptUid ?? state.currentAttemptUid;
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

	submitProposal(proposal: ConversionProposal): void {
		const state = this.#requireHandleState(proposal.handle);
		submitProposal(this.#kernel, this.#runtime, proposal);
		state.currentAttemptUid = undefined;
	}

	reportConversionFailure(handle: AttemptHandle, error: string): void {
		const state = this.#requireHandleState(handle);
		reportConversionFailure(this.#kernel, this.#runtime, handle, error);
		state.currentAttemptUid = undefined;
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		const errors: unknown[] = [];
		try {
			for (const state of this.#states.values()) {
				this.#stopState(state);
				try {
					this.#kernel.write("consumer.stop", (tx) => {
						const current = tx.get<{
							kind: string;
							generation: number;
						}>(ENGINE_SQL.readAgent, { agentId: state.agent.agentId });
						if (
							!current ||
							current.kind !== state.agent.kind ||
							current.generation !== state.agent.generation
						) {
							return;
						}
						const running = tx.all<RunningRow>(
							ENGINE_SQL.readRecipientRunning,
							{ agent: state.agent.agentId },
						);
						for (const row of running) {
							const activationId =
								state.agent.kind === "runner" ? state.agent.activationId : null;
							if (
								row.generation !== state.agent.generation ||
								row.instance_id !== state.agent.instanceId ||
								row.activation_id !== activationId
							) {
								throw new FenceViolation(
									`stop found foreign running attempt ${row.attempt_uid}`,
								);
							}
							tx.cas(FENCE.processingAttemptCasRunningSettled, {
								attemptUid: row.attempt_uid,
								outcome: "crashed",
								settledAt: this.#runtime.clock.nowIso(),
							});
							settleFailureMailboxTx(tx, this.#runtime, {
								agentId: state.agent.agentId,
								messageUid: row.message_uid,
								attemptUid: row.attempt_uid,
								generation: state.agent.generation,
							});
						}
						tx.cas(ENGINE_SQL.casOffline, {
							agentId: state.agent.agentId,
							kind: state.agent.kind,
							generation: state.agent.generation,
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
			state.currentAttemptUid = next.handle.attemptUid;
			let converted: ConversionResult;
			try {
				converted = await (state.converter as Converter)({
					messageUid: next.handle.messageUid,
					payload: next.payload,
					kind: next.kind,
					sourceKind: next.sourceKind,
					seq: next.seq,
				});
			} catch (error) {
				converted = {
					ok: false as const,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			if (state.stopped) return;
			if (converted.ok) {
				submitProposal(this.#kernel, this.#runtime, {
					handle: next.handle,
					effects: converted.effects,
				});
			} else {
				reportConversionFailure(
					this.#kernel,
					this.#runtime,
					next.handle,
					converted.error,
				);
			}
			state.currentAttemptUid = undefined;
			next = undefined;
		}
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
