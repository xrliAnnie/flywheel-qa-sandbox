import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
	bindSpawnedExecutionProcessGroup,
	captureExecutionProcessSample,
	type ExecutionProcessOwnerFactory,
	observeExecutionProcesses,
	rawCodexBin,
	readExecutionProcessIdentity,
} from "flywheel-claude-runner";
import type { StateStore } from "../StateStore.js";
import type { ProcessRecoveryAdmission } from "./execution-process-owner.js";

export interface ExecutionProcessControllerOptions {
	now?: () => number;
	nonce?: () => string;
	sleep?: (ms: number) => Promise<void>;
	readController?: typeof readExecutionProcessIdentity;
	resolveCwd?: (cwd: string) => Promise<string>;
	resolveExecutable?: () => Promise<string>;
	bindSpawn?: typeof bindSpawnedExecutionProcessGroup;
	sample?: typeof captureExecutionProcessSample;
}
type MutationResult = { ok: true } | { ok: false; reason: string };
const RETRY_DELAYS = [25, 50, 100, 200] as const;

/** All OS awaits happen outside the owner's short synchronous mutation lease. */
export function createExecutionProcessOwnerFactory(
	store: Pick<
		StateStore,
		| "executionProcessOwners"
		| "getSession"
		| "getWorkflowExecutionProcessBody"
		| "getCodexRecoveryEpisode"
	>,
	options: ExecutionProcessControllerOptions = {},
): ExecutionProcessOwnerFactory {
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const owners = store.executionProcessOwners;
	async function mutate<T extends MutationResult>(
		operation: () => T,
	): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const result = operation();
			if (
				result.ok ||
				result.reason !== "lease_held" ||
				attempt === RETRY_DELAYS.length
			)
				return result;
			await sleep(RETRY_DELAYS[attempt]!);
		}
	}
	function requireAccepted(result: MutationResult): void {
		if (!result.ok) throw new Error(`process_owner_refused:${result.reason}`);
	}
	return async (ctx, ownerToken, kind = "dispatch") => {
		const inspectedController = await (
			options.readController ?? readExecutionProcessIdentity
		)();
		if (!inspectedController)
			throw new Error("process_controller_identity_unavailable");
		const controller = {
			pid: inspectedController.pid,
			startIdentity: inspectedController.startIdentity,
			hostBootId: inspectedController.hostBootId,
		};
		const cwd = await (options.resolveCwd ?? realpath)(ctx.cwd);
		const executable = await (
			options.resolveExecutable ??
			(() =>
				realpath(
					rawCodexBin({ ...process.env, FLYWHEEL_CODEX_TUI_BIN: undefined }),
				))
		)();
		const identity = {
			executionId: ctx.executionId,
			activationId: ctx.workflowActivationId ?? null,
			generation:
				ctx.processLifecycle?.generation ??
				store.getWorkflowExecutionProcessBody(ctx.executionId)?.generation ??
				1,
			ownerToken,
		};
		const recoveryReservation =
			kind === "rescue"
				? store.getCodexRecoveryEpisode(ctx.executionId)
				: undefined;
		if (
			kind === "rescue" &&
			(!recoveryReservation?.claimToken ||
				recoveryReservation.episodeState !== "open")
		)
			throw new Error("process_recovery_authority_unavailable");
		let recoveryCommitted = false;
		const current = () => {
			const session = store.getSession(ctx.executionId);
			if (!session) throw new Error("process_owner_session_missing");
			const lifecycleRevision = session.lifecycle_revision ?? 0;
			if (recoveryReservation && !recoveryCommitted) {
				const live = store.getCodexRecoveryEpisode(ctx.executionId);
				recoveryCommitted = Boolean(
					live &&
						live.episodeId === recoveryReservation.episodeId &&
						live.episodeState === "closed" &&
						live.claimToken === null &&
						lifecycleRevision >
							(recoveryReservation.expectedLifecycleRevision ??
								lifecycleRevision),
				);
				if (
					!recoveryCommitted &&
					(!live ||
						live.claimToken !== recoveryReservation.claimToken ||
						live.expiresAtMs === null ||
						live.expiresAtMs <= now() ||
						live.expectedLifecycleRevision !== lifecycleRevision)
				)
					throw new Error("process_recovery_authority_changed");
			}
			return {
				...identity,
				lifecycleRevision,
				nowMs: now(),
				...(recoveryReservation && !recoveryCommitted
					? { recoveryClaimToken: recoveryReservation.claimToken! }
					: {}),
			};
		};
		let recovery: ProcessRecoveryAdmission | undefined;
		const prior = owners.get(ctx.executionId);
		if (
			prior &&
			prior.owner_token !== ownerToken &&
			prior.generation === identity.generation
		) {
			const claim = store.getCodexRecoveryEpisode(ctx.executionId);
			const initial = current();
			if (
				kind !== "rescue" ||
				!claim?.claimToken ||
				claim.episodeState !== "open" ||
				claim.expiresAtMs === null ||
				claim.expiresAtMs <= initial.nowMs ||
				claim.expectedLifecycleRevision !== initial.lifecycleRevision
			)
				throw new Error("process_recovery_authority_unavailable");
			const binding = owners.getBinding(ctx.executionId);
			if (!binding) throw new Error("process_recovery_binding_unavailable");
			const previousController = {
				pid: prior.controller_pid,
				startIdentity: prior.controller_start,
				hostBootId: prior.host_boot_id,
			};
			const sample = await (options.sample ?? captureExecutionProcessSample)(
				binding,
				{ executionId: ctx.executionId },
			);
			const observation = observeExecutionProcesses({
				identity: {
					executionId: ctx.executionId,
					activationId: prior.activation_id,
					generation: prior.generation,
					lifecycleRevision: initial.lifecycleRevision,
					adapter: binding.adapter,
				},
				ownerToken: prior.owner_token,
				spawnEpoch: prior.spawn_epoch,
				binding,
				bindingDigest: prior.binding_digest!,
				controller: previousController,
				spawnInflight: Boolean(prior.spawn_inflight),
				restartInProgress: Boolean(prior.restart_in_progress),
				ownerDrained: Boolean(prior.owner_drained_receipt),
				ownerClosed: Boolean(prior.close_requested),
				recoveryActive: false,
				sample,
				nowMs: now(),
			});
			if (observation.verdict !== "dead")
				throw new Error("process_recovery_drain_unconfirmed");
			const old = () => ({
				executionId: ctx.executionId,
				activationId: prior.activation_id,
				generation: prior.generation,
				ownerToken: prior.owner_token,
				spawnEpoch: prior.spawn_epoch,
				lifecycleRevision: initial.lifecycleRevision,
				nowMs: now(),
				recoveryClaimToken: claim.claimToken!,
			});
			requireAccepted(await mutate(() => owners.requestClose(old())));
			const observedAtMs = Date.parse(observation.observedAt);
			requireAccepted(
				await mutate(() =>
					owners.recordDrained({
						...old(),
						reason: "recovery_controller_gone",
						evidence: {
							...old(),
							controller: previousController,
							bindingDigest: prior.binding_digest,
							controllerState: prior.owner_drained_receipt
								? "stopped"
								: "absent",
							groupState: "absent",
							writersState: "absent",
							observedAtMs,
							expiresAtMs: observedAtMs + 10_000,
						},
					}),
				),
			);
			recovery = {
				claimToken: claim.claimToken,
				priorOwnerToken: prior.owner_token,
				priorSpawnEpoch: prior.spawn_epoch,
				priorBindingDigest: prior.binding_digest,
			};
		}
		requireAccepted(
			await mutate(() =>
				owners.claim({
					...current(),
					controller,
					...(recovery ? { recovery } : {}),
				}),
			),
		);
		let spawnEpoch = owners.get(ctx.executionId)!.spawn_epoch;
		let spawnPrepared = false;
		let closed = false;
		const nonce = (options.nonce ?? randomUUID)();
		const mutation = () => ({ ...current(), spawnEpoch });
		const close = async () => {
			// A synchronous local fence precedes even a temporary lease-contention await.
			closed = true;
			requireAccepted(await mutate(() => owners.requestClose(mutation())));
		};
		return {
			nonce,
			prepareSpawn: async () => {
				if (closed) throw new Error("process_owner_closed");
				const result = await mutate(() =>
					closed
						? { ok: false as const, reason: "close_requested" }
						: owners.beginSpawn(mutation()),
				);
				requireAccepted(result);
				if (result.ok) {
					spawnEpoch = result.permit.spawnEpoch;
					spawnPrepared = true;
				}
			},
			authorizeSpawn: () => {
				try {
					return (
						!closed &&
						owners.authorizeSpawn(
							{ ...identity, spawnEpoch },
							current().lifecycleRevision,
						)
					);
				} catch {
					return false;
				}
			},
			beginRestart: async () => {
				if (closed) return false;
				const result = await mutate(() =>
					closed
						? { ok: false as const, reason: "close_requested" }
						: owners.beginRestart(mutation()),
				);
				return result.ok && !closed;
			},
			acceptSpawn: async (pgid) => {
				const deadline = now() + 5000;
				let binding: Awaited<
					ReturnType<typeof bindSpawnedExecutionProcessGroup>
				> = null;
				for (let attempt = 0; attempt < 50 && now() < deadline; attempt++) {
					binding = await (
						options.bindSpawn ?? bindSpawnedExecutionProcessGroup
					)(
						{
							adapter: "codex-tmux",
							pgid,
							executable,
							cwd,
							nonce,
							nativeSessionId: null,
						},
						{ executionId: ctx.executionId, deadlineMs: deadline - now() },
					);
					if (binding) break;
					if (now() >= deadline) break;
					await sleep(Math.min(100, deadline - now()));
				}
				if (
					!binding ||
					binding.adapter !== "codex-tmux" ||
					binding.pgid !== pgid ||
					binding.cwd !== cwd ||
					binding.executable !== executable ||
					binding.nonce !== nonce ||
					binding.hostBootId !== controller.hostBootId
				)
					throw new Error("process_spawn_identity_unavailable");
				// A close racing the OS await still needs this newborn recorded for cleanup.
				const acceptedBinding = binding;
				requireAccepted(
					await mutate(() =>
						owners.acceptSpawn({ ...mutation(), binding: acceptedBinding }),
					),
				);
			},
			close,
			finish: async () => {
				await close();
				const row = owners.get(ctx.executionId)!;
				if (row.owner_drained_receipt) return;
				if (row.spawn_inflight) throw new Error("process_spawn_unsettled");
				const binding = owners.getBinding(ctx.executionId);
				if (spawnPrepared && !binding)
					throw new Error("process_binding_unavailable");
				let observedAtMs = now();
				if (binding) {
					const sample = await (
						options.sample ?? captureExecutionProcessSample
					)(binding, { executionId: ctx.executionId });
					const observation = observeExecutionProcesses({
						identity: {
							executionId: ctx.executionId,
							activationId: identity.activationId,
							generation: identity.generation,
							lifecycleRevision: current().lifecycleRevision,
							adapter: "codex-tmux",
						},
						ownerToken,
						spawnEpoch,
						binding,
						bindingDigest: row.binding_digest!,
						controller,
						spawnInflight: false,
						restartInProgress: false,
						ownerDrained: false,
						ownerClosed: true,
						recoveryActive: false,
						sample,
						nowMs: now(),
					});
					if (observation.verdict !== "dead")
						throw new Error("process_drain_unconfirmed");
					observedAtMs = Date.parse(observation.observedAt);
				}
				requireAccepted(
					await mutate(() =>
						owners.recordDrained({
							...mutation(),
							reason: "runtime_drained",
							evidence: {
								...identity,
								spawnEpoch,
								controller,
								bindingDigest: row.binding_digest,
								controllerState: "stopped",
								groupState: "absent",
								writersState: "absent",
								observedAtMs,
								expiresAtMs: observedAtMs + 10_000,
							},
						}),
					),
				);
			},
		};
	};
}
