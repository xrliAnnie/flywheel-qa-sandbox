import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
	type BodyObservation,
	bindSpawnedExecutionProcessGroup,
	captureExecutionProcessSample,
	capturePendingExecutionSpawnAbsence,
	type ExecutionAdapter,
	type ExecutionProcessIdentity,
	type ExecutionProcessLaunchCandidate,
	type ExecutionProcessOwnerFactory,
	observeExecutionProcesses,
	rawCodexBin,
	readExecutionProcessIdentity,
	resolveExecutionLaunchExecutable,
	type TmuxProcessLaunchDeps,
	verifyExecutionProcessLaunchCandidate,
} from "flywheel-claude-runner";
import type { StateStore } from "../StateStore.js";
import {
	completionBlocksDeath,
	hasUnresolvedCompleteMarker,
} from "./completion-before-death.js";
import { createStoredExecutionBodyObserver } from "./execution-body-liveness.js";
import type { ProcessRecoveryAdmission } from "./execution-process-owner.js";

export interface ExecutionProcessControllerOptions {
	adapter?: ExecutionAdapter;
	nativeSessionId?: string | null;
	expectedLeader?: () => ExecutionProcessIdentity | undefined;
	now?: () => number;
	nonce?: () => string;
	sleep?: (ms: number) => Promise<void>;
	readController?: typeof readExecutionProcessIdentity;
	resolveCwd?: (cwd: string) => Promise<string>;
	resolveExecutable?: () => Promise<string>;
	bindSpawn?: typeof bindSpawnedExecutionProcessGroup;
	sample?: typeof captureExecutionProcessSample;
	pendingAbsence?: typeof capturePendingExecutionSpawnAbsence;
}
type MutationResult = { ok: true } | { ok: false; reason: string };
const RETRY_DELAYS = [25, 50, 100, 200] as const;

type ProcessControllerStore = Pick<
	StateStore,
	| "executionProcessOwners"
	| "getSession"
	| "getWorkflowExecutionProcessBody"
	| "getCodexRecoveryEpisode"
	| "resolveCurrentWorkflowActivation"
>;

export interface TmuxProcessControllerOptions
	extends ExecutionProcessControllerOptions {
	ownerToken?: () => string;
	resolveLaunchExecutable?: typeof resolveExecutionLaunchExecutable;
}

/** Production Tmux carriers share the Codex durable owner and bounded OS verifier.
 * The pre-exec file only proposes an identity; this closure retains the authority. */
export function createTmuxProcessLaunchDeps(
	store: StateStore,
	options: TmuxProcessControllerOptions = {},
): TmuxProcessLaunchDeps {
	const observer = createStoredExecutionBodyObserver(
		store,
		{ mode: "ready", store },
		{
			now: options.now,
			sample: options.sample,
			// This factory only admits single-launch Tmux carriers, never a Codex
			// reowner. A misrouted Codex identity must remain recovery-protected.
			isRecoveryActive: (id) =>
				store.getSession(id)?.adapter_type === "codex-tmux",
		},
	);
	return {
		createLaunch: async (ctx, input) => {
			const executable = await (
				options.resolveLaunchExecutable ?? resolveExecutionLaunchExecutable
			)(input.binaryName);
			const cwd = await (options.resolveCwd ?? realpath)(ctx.cwd);
			const ownerToken = (options.ownerToken ?? randomUUID)();
			let candidate: ExecutionProcessLaunchCandidate | undefined;
			const owner = await createExecutionProcessOwnerFactory(store, {
				...options,
				adapter: input.adapter,
				nativeSessionId: input.nativeSessionId,
				resolveCwd: async () => cwd,
				resolveExecutable: async () => executable.executable,
				expectedLeader: () => candidate,
			})(ctx, ownerToken);
			const generation = store.executionProcessOwners.get(
				ctx.executionId,
			)!.generation;
			const expected = {
				version: 1 as const,
				executionId: ctx.executionId,
				generation,
				ownerToken,
				nonce: owner.nonce,
				adapter: input.adapter,
				binaryName: executable.launchPath,
				nativeSessionId: input.nativeSessionId,
				cwd,
			};
			const isCurrentBody = (observation: BodyObservation): boolean =>
				observation.identity.executionId === ctx.executionId &&
				observation.identity.generation === generation &&
				observation.identity.adapter === input.adapter &&
				observation.ownerToken === ownerToken &&
				observer.isCurrent(observation);
			return {
				generation,
				ownerToken,
				nonce: owner.nonce,
				launchPath: executable.launchPath,
				launchEnvPath: executable.launchEnvPath,
				observeBody: async () => {
					const observation = await observer.observe(ctx.executionId);
					return observation?.ownerToken === ownerToken &&
						observation.identity.generation === generation &&
						observation.identity.adapter === input.adapter
						? observation
						: undefined;
				},
				isCurrentBody,
				classifyBodyExit: async (observation) => {
					if (observation.verdict !== "dead" || !isCurrentBody(observation))
						return "pending";
					// The canonical marker reconciler owns replay. Until it has settled
					// pending completion, an adapter cannot publish an abnormal exit.
					if (await completionBlocksDeath(ctx.executionId, null))
						return "pending";
					if (
						!isCurrentBody(observation) ||
						hasUnresolvedCompleteMarker(ctx.executionId)
					)
						return "pending";
					const context = observation.identity.activationId
						? store.getGeneralizedWorkflowNodeForActivation(
								observation.identity.activationId,
							)
						: store.getGeneralizedWorkflowNodeForExecution(ctx.executionId);
					if (!context)
						return ctx.workflowActivationId ||
							ctx.workflowSubmissionExpected ||
							ctx.processLifecycle
							? "pending"
							: "completed";
					const binding = context.binding;
					if (binding.activation_id !== observation.identity.activationId)
						return "pending";
					const completion = store.getWorkflowNodeCompletion(
						binding.run_id,
						binding.node_id,
						binding.attempt,
					);
					if (
						completion?.execution_id === ctx.executionId &&
						completion.activation_id === binding.activation_id
					)
						return "completed";
					const body = store.getWorkflowExecutionProcessBody(ctx.executionId);
					if (
						body?.generation === generation &&
						(body.state === "retiring" || body.state === "standby")
					)
						return "completed";
					return "abnormal_process_exit";
				},
				prepareSpawn: owner.prepareSpawn,
				authorizeSpawn: owner.authorizeSpawn,
				acceptSpawn: async (untrusted) => {
					if (candidate) throw new Error("process_launch_already_submitted");
					candidate = verifyExecutionProcessLaunchCandidate(
						untrusted,
						expected,
					);
					await owner.acceptSpawn(candidate.pgid);
				},
				close: owner.close,
				finish: owner.finish,
			};
		},
	};
}

/** All OS awaits happen outside the owner's short synchronous mutation lease. */
export function createExecutionProcessOwnerFactory(
	store: ProcessControllerStore,
	options: ExecutionProcessControllerOptions = {},
): ExecutionProcessOwnerFactory {
	const adapter = options.adapter ?? "codex-tmux";
	const nativeSessionId = options.nativeSessionId ?? null;
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
		// Standby resumes retain their execution but the launch request need not
		// carry an activation. Only the unique current durable binding can supply it.
		const resumeActivation =
			ctx.processLifecycle?.mode === "resume"
				? store.resolveCurrentWorkflowActivation(ctx.executionId)
				: undefined;
		if (resumeActivation && resumeActivation.kind !== "current")
			throw new Error("process_resume_activation_unavailable");
		const activationId =
			resumeActivation?.kind === "current"
				? resumeActivation.binding.activation_id
				: (ctx.workflowActivationId ?? null);
		if (
			resumeActivation &&
			ctx.workflowActivationId &&
			ctx.workflowActivationId !== activationId
		)
			throw new Error("process_resume_activation_changed");
		const assertResumeActivation = () => {
			if (!resumeActivation) return;
			const live = store.resolveCurrentWorkflowActivation(ctx.executionId);
			if (
				live.kind !== "current" ||
				live.binding.activation_id !== activationId
			)
				throw new Error("process_resume_activation_changed");
		};
		const identity = {
			executionId: ctx.executionId,
			activationId,
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
		const current = (launch = false) => {
			if (launch) assertResumeActivation();
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
					...current(true),
					controller,
					...(recovery ? { recovery } : {}),
				}),
			),
		);
		let spawnEpoch = owners.get(ctx.executionId)!.spawn_epoch;
		let spawnPrepared = false;
		let closed = false;
		const nonce = (options.nonce ?? randomUUID)();
		const mutation = (launch = false) => ({ ...current(launch), spawnEpoch });
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
						: owners.beginSpawn({ ...mutation(true), nonce }),
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
							current(true).lifecycleRevision,
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
						: owners.beginRestart(mutation(true)),
				);
				return result.ok && !closed;
			},
			acceptSpawn: async (pgid) => {
				requireAccepted(
					await mutate(() => owners.noteSpawnGroup({ ...mutation(), pgid })),
				);
				const acceptIdentity = mutation();
				const leader = options.expectedLeader?.();
				const expectedLeader = leader ? { ...leader } : undefined;
				const deadline = now() + 5000;
				let binding: Awaited<
					ReturnType<typeof bindSpawnedExecutionProcessGroup>
				> = null;
				for (let attempt = 0; attempt < 50 && now() < deadline; attempt++) {
					binding = await (
						options.bindSpawn ?? bindSpawnedExecutionProcessGroup
					)(
						{
							adapter,
							pgid,
							executable,
							cwd,
							nonce,
							nativeSessionId,
							...(expectedLeader ? { expectedLeader } : {}),
						},
						{ executionId: ctx.executionId, deadlineMs: deadline - now() },
					);
					if (binding) break;
					if (now() >= deadline) break;
					await sleep(Math.min(100, deadline - now()));
				}
				if (
					!binding ||
					binding.adapter !== adapter ||
					binding.nativeSessionId !== nativeSessionId ||
					(expectedLeader &&
						(binding.pid !== expectedLeader.pid ||
							binding.startIdentity !== expectedLeader.startIdentity ||
							binding.hostBootId !== expectedLeader.hostBootId)) ||
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
						owners.acceptSpawn({
							...acceptIdentity,
							nowMs: now(),
							binding: acceptedBinding,
						}),
					),
				);
				// Preserve the newborn binding for cleanup even when admission was
				// superseded while the independent OS verifier awaited.
				assertResumeActivation();
			},
			close,
			finish: async () => {
				await close();
				const finishIdentity = mutation();
				const finishMutation = () => ({ ...finishIdentity, nowMs: now() });
				const row = owners.get(ctx.executionId)!;
				if (row.owner_drained_receipt) return;
				if (row.spawn_inflight) {
					const deadline = now() + 5000;
					let observedAtMs = now();
					const previous = owners.getPreviousBinding(ctx.executionId);
					if (row.binding_digest && !previous)
						throw new Error("process_binding_unavailable");
					if (previous) {
						const sample = await (
							options.sample ?? captureExecutionProcessSample
						)(previous, {
							executionId: ctx.executionId,
							deadlineMs: deadline - now(),
						});
						// This checks only the preceding accepted group. The unresolved newborn
						// is checked separately below; no body-death verdict escapes this method.
						const old = observeExecutionProcesses({
							identity: {
								executionId: ctx.executionId,
								activationId: identity.activationId,
								generation: identity.generation,
								lifecycleRevision: finishIdentity.lifecycleRevision,
								adapter,
							},
							ownerToken,
							spawnEpoch: row.binding_spawn_epoch!,
							binding: previous,
							bindingDigest: row.binding_digest!,
							controller,
							ownerClosed: true,
							ownerDrained: false,
							spawnInflight: false,
							restartInProgress: false,
							recoveryActive: false,
							sample,
							nowMs: now(),
						});
						if (old.verdict !== "dead")
							throw new Error("process_drain_unconfirmed");
						observedAtMs = Date.parse(old.observedAt);
					}
					if (!row.spawn_nonce || now() >= deadline)
						throw new Error("process_drain_unconfirmed");
					const absent = await (
						options.pendingAbsence ?? capturePendingExecutionSpawnAbsence
					)(
						{
							hostBootId: row.host_boot_id,
							nonce: row.spawn_nonce,
							pgid: row.pending_pgid,
						},
						{ executionId: ctx.executionId, deadlineMs: deadline - now() },
					);
					if (
						!absent ||
						absent.hostBootId !== row.host_boot_id ||
						absent.nonce !== row.spawn_nonce ||
						absent.pgid !== row.pending_pgid
					)
						throw new Error("process_drain_unconfirmed");
					observedAtMs = Math.min(observedAtMs, absent.observedAtMs);
					requireAccepted(
						await mutate(() =>
							owners.recordFailedSpawnDrained({
								...finishMutation(),
								reason: "failed_native_spawn_drained",
								evidence: {
									...identity,
									spawnEpoch,
									controller,
									bindingDigest: row.binding_digest,
									controllerState: "stopped",
									groupState: "absent",
									writersState: "absent",
									nonce: absent.nonce,
									pgid: absent.pgid,
									observedAtMs,
									expiresAtMs: Math.min(
										absent.expiresAtMs,
										observedAtMs + 10_000,
									),
								},
							}),
						),
					);
					return;
				}
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
							lifecycleRevision: finishIdentity.lifecycleRevision,
							adapter,
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
							...finishMutation(),
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
