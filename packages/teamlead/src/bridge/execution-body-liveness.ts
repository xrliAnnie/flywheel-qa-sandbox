import {
	type BodyObservation,
	captureExecutionProcessSample,
	type ExecutionAdapter,
	type ExecutionProcessObservationInput,
	isCurrentBodyObservation,
	observeExecutionProcesses,
} from "flywheel-claude-runner";
import type { StateStore } from "../StateStore.js";

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
	now?: () => number;
	sample?: typeof captureExecutionProcessSample;
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
	const inflight = new Map<string, Promise<BodyObservation>>();
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
	async function capture(initial: Snapshot): Promise<BodyObservation> {
		if (!enabled())
			return unknown(initial, "body_death_authorization_disabled");
		if (!initial.input.binding)
			return unknown(initial, "process_binding_unavailable");
		try {
			const sample = await (options.sample ?? captureExecutionProcessSample)(
				initial.input.binding,
				{ executionId: initial.input.identity.executionId, deadlineMs: 5_000 },
			);
			if (!enabled())
				return unknown(initial, "body_death_authorization_disabled");
			const current = snapshot(initial.input.identity.executionId);
			if (!current || current.key !== initial.key)
				return unknown(initial, "process_authority_changed");
			return observeExecutionProcesses({
				...current.input,
				sample,
				nowMs: now(),
			});
		} catch {
			return unknown(initial, "process_evidence_unavailable");
		}
	}
	return {
		observe(executionId: string): Promise<BodyObservation | undefined> {
			const initial = snapshot(executionId);
			if (!initial) return Promise.resolve(undefined);
			const existing = inflight.get(initial.key);
			if (existing) return existing;
			const pending = capture(initial).finally(() => {
				if (inflight.get(initial.key) === pending) inflight.delete(initial.key);
			});
			inflight.set(initial.key, pending);
			return pending;
		},
		isCurrent(observation: BodyObservation): boolean {
			if (!enabled() || observation.verdict === "unknown") return false;
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
