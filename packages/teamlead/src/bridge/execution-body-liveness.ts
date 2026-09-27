import {
	type BodyObservation,
	captureExecutionProcessSample,
	type ExecutionAdapter,
	type ExecutionProcessObservationInput,
	isCurrentBodyObservation,
	observeExecutionProcesses,
} from "flywheel-claude-runner";
import type { StateStore } from "../StateStore.js";
import {
	type FlagStoreRuntime,
	storeExecutionBodyDeathEnabled,
} from "./flag-store-runtime.js";

type BodyStore = Pick<
	StateStore,
	| "getSession"
	| "getWorkflowActor"
	| "getWorkflowActivation"
	| "getWorkflowExecutionProcessBody"
	| "executionProcessOwners"
>;
export interface ExecutionBodyObserverOptions {
	/** Read on every use, including after OS awaits and immediately before CAS. */
	isEnabled(): boolean;
	/** Existing reowner authority; an indeterminate recovery read must protect it. */
	isRecoveryActive(executionId: string): boolean;
	/** Remaining recovery budget vetoes death, but does not hide a live worker. */
	isRecoveryEligible?(executionId: string): boolean;
	/** Identity-only legacy backfill before the common OS observation. */
	prepareBinding?(
		executionId: string,
		control: ExecutionBodySampleControl,
	): Promise<void>;
	now?: () => number;
	sample?: typeof captureExecutionProcessSample;
}
export interface ExecutionBodySampleControl {
	signal?: AbortSignal;
	deadlineMs?: number;
}
type Snapshot = {
	input: ExecutionProcessObservationInput;
	key: string;
};
const adapters = new Set<string>([
	"codex-tmux",
	"claude-tmux",
	"kimi-tmux",
	"antigravity-tmux",
]);

/**
 * Joins the current accepted owner with independent OS evidence. No window,
 * heartbeat age or business wait status contributes to the physical verdict.
 * The caller must use isCurrent synchronously next to its mutation CAS.
 * Completion-marker reconciliation and death finalization remain separate.
 */
export function createExecutionBodyObserver(
	store: BodyStore,
	options: ExecutionBodyObserverOptions,
) {
	const now = options.now ?? Date.now;
	const inflight = new Map<
		string,
		{ pending: Promise<BodyObservation>; cancel: AbortController }
	>();
	function enabled(): boolean {
		try {
			return options.isEnabled() === true;
		} catch {
			return false;
		}
	}
	function recoveryActive(executionId: string): boolean {
		try {
			return options.isRecoveryActive(executionId) !== false;
		} catch {
			return true;
		}
	}
	function recoveryEligible(executionId: string): boolean {
		try {
			return options.isRecoveryEligible?.(executionId) === true;
		} catch {
			return true;
		}
	}

	function snapshot(executionId: string): Snapshot | undefined {
		try {
			const session = store.getSession(executionId);
			const row = store.executionProcessOwners.get(executionId);
			if (!session || !row || !adapters.has(session.adapter_type ?? ""))
				return undefined;
			const generation =
				store.getWorkflowExecutionProcessBody(executionId)?.generation ?? 1;
			if (row.generation !== generation) return undefined;
			if (
				row.activation_id === null
					? store.getWorkflowActor(executionId) !== undefined
					: store.getWorkflowActivation(row.activation_id)?.execution_id !==
						executionId
			)
				return undefined;
			const binding =
				row.binding_spawn_epoch === row.spawn_epoch
					? store.executionProcessOwners.getBinding(executionId)
					: undefined;
			const input: ExecutionProcessObservationInput = {
				identity: {
					executionId,
					activationId: row.activation_id,
					generation,
					lifecycleRevision: session.lifecycle_revision ?? 0,
					adapter: session.adapter_type as ExecutionAdapter,
				},
				ownerToken: row.owner_token,
				spawnEpoch: row.spawn_epoch,
				binding: binding ? structuredClone(binding) : null,
				bindingDigest: row.binding_digest ?? "",
				controller: {
					pid: row.controller_pid,
					startIdentity: row.controller_start,
					hostBootId: row.host_boot_id,
				},
				spawnInflight: Boolean(row.spawn_inflight),
				restartInProgress: Boolean(row.restart_in_progress),
				ownerDrained: Boolean(row.owner_drained_receipt),
				ownerClosed: Boolean(row.close_requested),
				recoveryActive: recoveryActive(executionId),
				sample: null,
				nowMs: now(),
			};
			// Only in-flight sharing, never a second liveness cache. Ownership and
			// recovery changes split requests even when the execution id is reused.
			const { nowMs: _clock, ...identity } = input;
			return { input, key: JSON.stringify(identity) };
		} catch {
			return undefined;
		}
	}
	function unknown(initial: Snapshot, reason: string): BodyObservation {
		return {
			...observeExecutionProcesses({
				...initial.input,
				sample: null,
				nowMs: now(),
			}),
			verdict: "unknown",
			reason,
		};
	}
	async function capture(
		initial: Snapshot,
		control: ExecutionBodySampleControl,
	): Promise<BodyObservation> {
		if (control.signal?.aborted)
			return unknown(initial, "process_sampling_cancelled");
		if (!enabled())
			return unknown(initial, "body_death_authorization_disabled");
		if (!initial.input.binding)
			return unknown(initial, "process_binding_unavailable");
		try {
			const sample = await (options.sample ?? captureExecutionProcessSample)(
				initial.input.binding,
				{ executionId: initial.input.identity.executionId, ...control },
			);
			if (control.signal?.aborted)
				return unknown(initial, "process_sampling_cancelled");
			if (!enabled())
				return unknown(initial, "body_death_authorization_disabled");
			const current = snapshot(initial.input.identity.executionId);
			if (!current || current.key !== initial.key)
				return unknown(initial, "process_authority_changed");
			const observation = observeExecutionProcesses({
				...current.input,
				sample,
				nowMs: now(),
			});
			return observation.verdict === "dead" &&
				recoveryEligible(initial.input.identity.executionId)
				? unknown(initial, "recovery_active")
				: observation;
		} catch {
			return unknown(
				initial,
				control.signal?.aborted
					? "process_sampling_cancelled"
					: "process_evidence_unavailable",
			);
		}
	}
	return {
		async observe(
			executionId: string,
			control: ExecutionBodySampleControl = {},
		): Promise<BodyObservation | undefined> {
			const startedAt = now();
			const requestedBudget = Math.min(5_000, control.deadlineMs ?? 5_000);
			if (
				!Number.isFinite(requestedBudget) ||
				requestedBudget <= 0 ||
				control.signal?.aborted
			) {
				const known = snapshot(executionId);
				return known ? unknown(known, "process_sampling_cancelled") : undefined;
			}
			if (!snapshot(executionId) && enabled() && options.prepareBinding) {
				try {
					await options.prepareBinding(executionId, {
						...control,
						deadlineMs: requestedBudget,
					});
				} catch {
					return undefined;
				}
			}
			const initial = snapshot(executionId);
			if (!initial) return undefined;
			const elapsed = now() - startedAt;
			const budget = elapsed < 0 ? 0 : requestedBudget - elapsed;
			if (control.signal?.aborted || !Number.isFinite(budget) || budget <= 0)
				return Promise.resolve(unknown(initial, "process_sampling_cancelled"));
			let entry = inflight.get(initial.key);
			if (!entry) {
				const cancel = new AbortController();
				const pending = capture(initial, {
					signal: cancel.signal,
					deadlineMs: budget,
				}).finally(() => {
					if (inflight.get(initial.key)?.pending === pending)
						inflight.delete(initial.key);
				});
				entry = { pending, cancel };
				inflight.set(initial.key, entry);
			}
			// A cancelled coalesced sample is unknown for every consumer. Never
			// return early: all subscribers wait for the shared OS children to drain.
			const cancel = () => entry.cancel.abort();
			control.signal?.addEventListener("abort", cancel, { once: true });
			const timeout = setTimeout(cancel, budget);
			if (control.signal?.aborted) cancel();
			return entry.pending.finally(() => {
				clearTimeout(timeout);
				control.signal?.removeEventListener("abort", cancel);
			});
		},
		isCurrent(observation: BodyObservation): boolean {
			if (!enabled() || observation.verdict === "unknown") return false;
			if (
				observation.verdict === "dead" &&
				recoveryEligible(observation.identity.executionId)
			)
				return false;
			const current = snapshot(observation.identity.executionId);
			return Boolean(
				current?.input.binding &&
					!current.input.spawnInflight &&
					!current.input.restartInProgress &&
					!current.input.recoveryActive &&
					isCurrentBodyObservation(observation, current.input),
			);
		},
	};
}

/** Production construction keeps the managed flag read inside each use. */
export function createStoredExecutionBodyObserver(
	store: BodyStore,
	flagStore: FlagStoreRuntime,
	options: Omit<ExecutionBodyObserverOptions, "isEnabled">,
) {
	return createExecutionBodyObserver(store, {
		...options,
		isEnabled: () => storeExecutionBodyDeathEnabled(flagStore),
	});
}
