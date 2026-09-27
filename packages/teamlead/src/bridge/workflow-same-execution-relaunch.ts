/**
 * FLY-2808 / FLY-2900 — relaunch the SAME workflow execution in a new
 * process on its original vendor session.
 *
 * Extracted from the FLY-2808 standby-resume effect so the rework standby
 * resume and the Codex quota standby resume share one identity discipline:
 * runtime + current activation, the persisted session manifest (thread /
 * session id, model, cwd), worktree realpath, HEAD/dirty drift notice, the
 * Lead frozen at the original registration, then one StartRequest built by
 * `buildStandbyResumeStartRequest` and a bounded wait for the adapter's
 * identity verification (or a proven pre-commit launch failure).
 */

import type {
	AdapterExecutionContext,
	LaunchPrecommitOutcome,
} from "flywheel-core";
import type { StartRequest } from "./retry-dispatcher.js";
import type { WorkflowActorSession } from "./workflow-actor-session.js";
import {
	buildStandbyResumeStartRequest,
	observeWorkflowResumeLaunchFailure,
} from "./workflow-resume-identity.js";
import type { WorkflowResumeFailureEvidence } from "./workflow-rework-coordinator.js";

type ProcessLifecycle = NonNullable<
	AdapterExecutionContext["processLifecycle"]
>;

/** The lifecycle fields the caller owns; identity plumbing is added here. */
export type SameExecutionLifecycle = Omit<
	ProcessLifecycle,
	| "mode"
	| "nodeId"
	| "expectedSessionId"
	| "expectedModel"
	| "expectedCwd"
	| "headDriftNotice"
>;

export interface SameExecutionRelaunchIdentity {
	expectedSessionId: string;
	expectedModel: string;
	expectedCwd: string;
	currentHead: string;
	dirty: boolean;
}

export type SameExecutionRelaunchResult =
	| {
			ok: true;
			expectedSessionId: string;
			observedSessionId: string;
			expectedModel: string;
			observedModel: string;
			expectedCwd: string;
			observedCwd: string;
			queueMs: number;
			startupMs: number;
			totalMs: number;
	  }
	| {
			ok: false;
			error: string;
			cleanupRequired: boolean;
			/** Dispatcher refused before launch; retry without spending failure budget. */
			admissionBrake?: true;
			retryAfterSeconds?: number;
			evidence?: WorkflowResumeFailureEvidence;
	  };

export interface SameExecutionRelaunchDeps {
	startDispatcher:
		| {
				start(
					req: StartRequest,
				): Promise<{ launchOutcome?: Promise<LaunchPrecommitOutcome> }>;
		  }
		| undefined;
	getRuntime(executionId: string):
		| {
				vendor: string;
				model: string;
				effort: string | null;
				node_id: string;
		  }
		| undefined;
	resolveCurrentActivation(
		executionId: string,
	): { kind: "current"; run: { project_name: string } } | { kind: string };
	manifestPath(vendor: string, executionId: string): string;
	readManifest(path: string): Record<string, unknown>;
	realpath(path: string): string;
	gitIdentity(cwd: string): Promise<{ head: string; dirty: boolean }>;
	/** The Lead frozen at the original registration; throws when unreadable. */
	frozenLeadId(
		session: WorkflowActorSession,
		projectName: string,
	): string | undefined;
	now?: () => number;
	identityTimeoutMs?: number;
}

const DEFAULT_IDENTITY_TIMEOUT_MS = 180_000;

export async function relaunchSameWorkflowExecution(
	deps: SameExecutionRelaunchDeps,
	input: {
		session: WorkflowActorSession;
		expectedHeadSha: string;
		/** Builds the caller-owned lifecycle once the identity is known. */
		lifecycle: (
			identity: SameExecutionRelaunchIdentity,
		) => SameExecutionLifecycle;
		/** Extra StartRequest fields layered on top (e.g. nothing for rework). */
		extendRequest?: (request: StartRequest) => StartRequest;
	},
): Promise<SameExecutionRelaunchResult> {
	const now = deps.now ?? Date.now;
	const { session } = input;
	const launchIdentity: {
		current?: {
			expectedSessionId: string;
			expectedModel: string;
			expectedCwd: string;
			requestedAt: number;
		};
	} = {};
	const failed = (
		error: string,
		cleanupRequired = false,
	): SameExecutionRelaunchResult => {
		const known = launchIdentity.current;
		const evidence: WorkflowResumeFailureEvidence | undefined = known && {
			expectedSessionId: known.expectedSessionId,
			expectedModel: known.expectedModel,
			expectedCwd: known.expectedCwd,
			totalMs: Math.max(0, now() - known.requestedAt),
		};
		return {
			ok: false as const,
			error,
			cleanupRequired,
			...(evidence ? { evidence } : {}),
		};
	};
	if (!deps.startDispatcher) return failed("start_dispatcher_unavailable");
	const runtime = deps.getRuntime(session.execution_id);
	const binding = deps.resolveCurrentActivation(session.execution_id);
	if (!runtime || binding.kind !== "current" || !("run" in binding))
		return failed("resume_runtime_unavailable");
	let manifest: Record<string, unknown>;
	try {
		manifest = deps.readManifest(
			deps.manifestPath(runtime.vendor, session.execution_id),
		);
	} catch {
		return failed("resume_manifest_unavailable");
	}
	const expectedSessionId =
		runtime.vendor === "codex" ? manifest.threadId : manifest.sessionId;
	const manifestModel = manifest.resolvedModel;
	const manifestCwd = manifest.cwd;
	if (typeof expectedSessionId !== "string" || !expectedSessionId.trim())
		return failed("resume_session_identity_missing");
	if (manifestModel !== runtime.model) return failed("resume_model_mismatch");
	if (typeof manifestCwd !== "string" || !manifestCwd.trim())
		return failed("resume_cwd_missing");
	let expectedCwd: string;
	try {
		expectedCwd = deps.realpath(manifestCwd);
	} catch {
		return failed("resume_cwd_unavailable");
	}
	let observedWorktree: string | undefined;
	try {
		observedWorktree = session.worktree_path
			? deps.realpath(session.worktree_path)
			: undefined;
	} catch {
		observedWorktree = undefined;
	}
	if (observedWorktree !== expectedCwd)
		return failed("resume_worktree_mismatch");
	let currentHead = input.expectedHeadSha;
	let dirty = false;
	try {
		const git = await deps.gitIdentity(expectedCwd);
		currentHead = git.head;
		dirty = git.dirty;
	} catch {
		return failed("resume_git_identity_unavailable");
	}
	const priorHead =
		typeof manifest.lastObservedHead === "string"
			? manifest.lastObservedHead
			: undefined;
	const headDriftNotice =
		priorHead && (priorHead !== currentHead || dirty)
			? `Workflow resume context: the shared worktree moved from ${priorHead} to ${currentHead}${dirty ? " and currently has uncommitted changes" : ""}. Re-read the current files before acting; TURN remains the only write authority.`
			: undefined;
	let leadId: string | undefined;
	try {
		leadId = deps.frozenLeadId(
			session,
			session.project_name ?? binding.run.project_name,
		);
	} catch {
		return failed("resume_lead_identity_unavailable");
	}
	const requestedAt = now();
	launchIdentity.current = {
		expectedSessionId,
		expectedModel: runtime.model,
		expectedCwd,
		requestedAt,
	};
	const callerLifecycle = input.lifecycle({
		expectedSessionId,
		expectedModel: runtime.model,
		expectedCwd,
		currentHead,
		dirty,
	});
	let resolveIdentity!: (value: {
		sessionId: string;
		model: string | null;
		cwd: string;
	}) => void;
	let rejectIdentity!: (reason: Error) => void;
	const identity = new Promise<{
		sessionId: string;
		model: string | null;
		cwd: string;
	}>((resolveIdentityPromise, rejectIdentityPromise) => {
		resolveIdentity = resolveIdentityPromise;
		rejectIdentity = rejectIdentityPromise;
	});
	let identityTimeout: ReturnType<typeof setTimeout> | undefined;
	let cleanupRequired = false;
	try {
		let request = buildStandbyResumeStartRequest({
			session,
			runProjectName: binding.run.project_name,
			runtime,
			leadId,
			expectedSessionId,
			expectedCwd,
			currentHead,
			lifecycle: {
				...callerLifecycle,
				...(headDriftNotice ? { headDriftNotice } : {}),
				// The caller's hook runs first so its durable CAS lands before the
				// adapter polls resumeVerificationStatus.
				onIdentityVerified: (evidence) => {
					callerLifecycle.onIdentityVerified?.(evidence);
					resolveIdentity(evidence);
				},
				onIdentityVerificationFailed: (reasonCode) => {
					callerLifecycle.onIdentityVerificationFailed?.(reasonCode);
					rejectIdentity(new Error(reasonCode));
				},
			},
		});
		if (input.extendRequest) request = input.extendRequest(request);
		const startResult = await deps.startDispatcher
			.start(request)
			.catch((error: unknown) => {
				// Only classify start() refusals, never an identity/continue failure.
				// Names match the HTTP admission lane across module boundaries.
				if (
					error instanceof Error &&
					(error.name === "AdmissionDeferredError" ||
						error.name === "DoaBackoffError" ||
						error.name === "CodexQuotaQueuedError" ||
						error.message === "RunDispatcher is shutting down" ||
						(error as { admissionBrake?: unknown }).admissionBrake === true)
				) {
					const retryAfterSeconds = (error as { retryAfterSeconds?: unknown })
						.retryAfterSeconds;
					return {
						admissionBrake: true as const,
						error: error.message,
						...(typeof retryAfterSeconds === "number" &&
						Number.isFinite(retryAfterSeconds) &&
						retryAfterSeconds > 0
							? { retryAfterSeconds }
							: {}),
					};
				}
				throw error;
			});
		if ("admissionBrake" in startResult) {
			return {
				...failed(startResult.error),
				...startResult,
				ok: false,
				cleanupRequired: false,
			};
		}
		cleanupRequired = true;
		const launchFailure = observeWorkflowResumeLaunchFailure(
			startResult.launchOutcome,
		);
		const observed = await Promise.race([
			identity.then((value) => ({ kind: "identity" as const, value })),
			new Promise<never>((_, reject) => {
				identityTimeout = setTimeout(
					() => reject(new Error("resume_identity_timeout")),
					deps.identityTimeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS,
				);
			}),
			...(launchFailure ? [launchFailure] : []),
		]);
		if (observed.kind === "launch") {
			return failed(
				observed.outcome.failure.reason,
				observed.outcome.failure.physicalEvidence === "unknown",
			);
		}
		const totalMs = Math.max(0, now() - requestedAt);
		if (observed.value.model === null)
			return failed("resume_observed_model_missing", true);
		return {
			ok: true,
			expectedSessionId,
			observedSessionId: observed.value.sessionId,
			expectedModel: runtime.model,
			observedModel: observed.value.model,
			expectedCwd,
			observedCwd: observed.value.cwd,
			queueMs: 0,
			startupMs: totalMs,
			totalMs,
		};
	} catch (error) {
		return failed(
			error instanceof Error ? error.message : String(error),
			cleanupRequired,
		);
	} finally {
		if (identityTimeout) clearTimeout(identityTimeout);
	}
}
