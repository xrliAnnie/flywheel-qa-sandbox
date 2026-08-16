/**
 * FLY-22: RunDispatcher — IStartDispatcher + IRetryDispatcher implementation.
 *
 * Moved from scripts/lib/retry-dispatcher.ts into the package so that
 * startBridge can create it internally (fixes /api/runs 404 when Bridge
 * is started via index.ts instead of scripts/run-bridge.ts).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveRunnerMailboxIdentity } from "flywheel-agent-team-transport";
import { CommDB } from "flywheel-comm/db";
import type {
	RoleBackendMap,
	RoleEffort,
	RunnerModelDisplay,
	SkillFrameworkMode,
	WorkflowDispatchVendor,
} from "flywheel-config";
import {
	adapterTypeToFamily,
	isWorkflowPhaseRole,
	renderRunnerModelDisplay,
	resolveRunnerMcpProfile,
	SKILL_FRAMEWORK_MODE_ENV,
	SKILL_FRAMEWORK_SPLIT,
} from "flywheel-config";
import {
	type LaunchPrecommitFailure,
	type LaunchPrecommitOutcome,
	openTmuxViewer,
} from "flywheel-core";
import type { AgentDispatcher } from "flywheel-edge-worker";
import type {
	Blueprint,
	BlueprintContext,
	BlueprintResult,
} from "flywheel-edge-worker/dist/Blueprint.js";
import type { LaunchClaimStore } from "./launch-claim-store.js";
import { resolveCommBackend } from "./plugin.js";
import type { ProgressResumeInfo } from "./progress-resume.js";
import type {
	IRetryDispatcher,
	IStartDispatcher,
	RetryRequest,
	RetryResult,
	StartRequest,
	StartResult,
} from "./retry-dispatcher.js";
import {
	type ResolvedRoleAdapter,
	resolveRoleAdapter,
} from "./role-adapter-resolver.js";
import { grantPrelaunchWorkflowTurn } from "./workflow-turn-bundle.js";

export type TmuxGenerationRecorder = (
	executionId: string,
	info: {
		baseSessionName: string;
		windowId: string;
		socketPath: string;
		serverStartTime: string;
		executionId: string;
		launchGeneration?: number;
		launchFingerprint?: string;
	},
) => void;

export type TmuxWorkflowWindowAuthority = (
	launchExecutionId: string,
	candidate: {
		windowId: string;
		windowName: string;
		executionId?: string;
		launchGeneration?: number;
		launchFingerprint?: string;
	},
) => "prune" | "keep";

export type InflightSessionTerminalProbe = (executionId: string) => boolean;

interface InflightEntry {
	executionId: string;
	promise: Promise<void>;
	launchOutcome?: Promise<LaunchPrecommitOutcome>;
}

interface LaunchOutcomeDeferred {
	promise: Promise<LaunchPrecommitOutcome>;
	commit: (() => { ok: boolean; reason?: string }) | undefined;
	observeResult(result: BlueprintResult): void;
	observeError(error: unknown): void;
}

function createLaunchOutcomeDeferred(
	commit: (() => { ok: boolean; reason?: string }) | undefined,
): LaunchOutcomeDeferred {
	let settled = false;
	let resolve!: (outcome: LaunchPrecommitOutcome) => void;
	const promise = new Promise<LaunchPrecommitOutcome>((done) => {
		resolve = done;
	});
	const settle = (outcome: LaunchPrecommitOutcome) => {
		if (settled) return;
		settled = true;
		resolve(outcome);
	};
	const genericFailure = (error: unknown): LaunchPrecommitFailure => ({
		code: "LAUNCH_PRECOMMIT_FAILED",
		reason: error instanceof Error ? error.message : String(error),
		physicalEvidence: "unknown",
	});
	return {
		promise,
		commit: commit
			? () => {
					const result = commit();
					if (result.ok) settle({ status: "committed" });
					return result;
				}
			: undefined,
		observeResult(result) {
			if (result.success) {
				settle({
					status: "precommit_failed",
					failure: genericFailure(
						"Blueprint completed without committing its workflow launch fence",
					),
				});
				return;
			}
			settle({
				status: "precommit_failed",
				failure:
					result.launchFailure ??
					genericFailure(result.error ?? "Blueprint launch failed"),
			});
		},
		observeError(error) {
			settle({ status: "precommit_failed", failure: genericFailure(error) });
		},
	};
}

/**
 * FLY-795: compute the restart-resilient resume decision for a (re-)dispatch.
 * Returns a ProgressResumeInfo when a prior execution + committed progress.md on
 * branch B are found; null ⇒ start fresh. Injected into RunDispatcher so the
 * live git/StateStore lookups stay out of the generic dispatcher.
 */
export type ResumeComputer = (
	issueId: string,
	role: string,
	projectName: string,
) => ProgressResumeInfo | null | Promise<ProgressResumeInfo | null>;

/** FLY-1718 P1: explanatory metadata for a structurally inherited branch. */
export interface ContinuityInherit {
	branch: string;
	sha: string;
	prNumber?: number;
	prUrl?: string;
}

/** FLY-1718 P1: origin-backed decision for an otherwise-fresh dispatch. */
export type ContinuityStartPoint =
	| ({ kind: "found" } & ContinuityInherit)
	| { kind: "missing"; branch?: string }
	| { kind: "indeterminate"; error: string };

export type ContinuityComputer = (input: {
	issueId: string;
	role: string;
	projectName: string;
	shareParentBranch?: boolean;
}) => Promise<ContinuityStartPoint>;

/** FLY-1257 M3: machine-readable branch-tip probe result for phase retries. */
export type PhaseRetryStartPoint =
	| { kind: "found"; sha: string }
	| { kind: "missing" }
	| { kind: "indeterminate"; error: string };

export type PhaseRetryStartPointComputer = (
	issueId: string,
	role: string,
	projectName: string,
) => PhaseRetryStartPoint;

import {
	AdmissionDeferredError,
	RunnerAdmissionController,
} from "./runner-admission.js";
import { defaultGetCommDbPath } from "./session-capture.js";

/**
 * FLY-245 R5 HIGH — the durable "Runner committed to start" record for a
 * gateway-bound execId. Deterministic path so a replay (new Bridge process)
 * computes the SAME path. The adapter gates the Runner on this file and writes
 * it at the commit point; the dispatcher adopts a replay ONLY if it exists (a
 * window recorded but never committed → re-drive, never adopt). Keyed by execId
 * (validated `[A-Za-z0-9-]{8,64}` at the route boundary — safe as a filename).
 */
export function launchCommitPath(executionId: string): string {
	return join(homedir(), ".flywheel", "state", "launch-commits", executionId);
}

/**
 * FLY-793 follow-up (cmux phase visibility): the display name that goes into the
 * cmux/tmux window label (`{issueId}-{runner}-{title}`). A DAG workflow
 * runner shows its phase (`design` / `implement` / `qa`) so the founder can see
 * which phase is live in cmux at a glance — instead of every phase showing the
 * generic `claude`. FLY-1255 adds the resolved executor family/model while
 * keeping that phase prefix authoritative for shared-branch runs.
 *
 * Gated on `shareParentBranch` (the DAG workflow marker), NOT `sessionRole` alone:
 * the FLY-579 Auto-QA session also carries `sessionRole: "qa"` but is a standalone
 * QA runner (no `shareParentBranch`), so keying on the role alone would flip its
 * window from `-claude-` to `-qa-` and break byte-compat. Mirrors Blueprint's
 * DAG workflow discriminator (`ctx.shareParentBranch && ctx.sessionRole`). When
 * no model is resolved, every non-DAG workflow run (main + Auto-QA) stays
 * `claude` → byte-compatible. With a resolved model, non-phase runs use the
 * narrow `runner-<family>-<model>` namespace consumed by cmux cleanup.
 *
 * SCOPE (FLY-840 → resolved by FLY-1224): the RETRY path (actions.ts
 * `handleRetry`) now propagates `shareParentBranch` for PHASE rows
 * (chat_thread_role ∈ design/implement/qa), so a retried DAG workflow
 * shows its phase name here too — the FLY-840 label debt is settled as a
 * deliberate side effect of the phase-row retry keeping its shared-branch
 * identity (a codex implement retry MUST stay on branch B). Non-phase retries
 * still pass no marker and stay `claude` (byte-compatible).
 */
export function runnerDisplayName(
	sessionRole: string | undefined,
	shareParentBranch: boolean | undefined,
	modelDisplay?: RunnerModelDisplay,
): string {
	const phase =
		shareParentBranch && isWorkflowPhaseRole(sessionRole)
			? sessionRole
			: undefined;
	if (modelDisplay) {
		return phase
			? `${phase}-${modelDisplay.windowLabel}`
			: `runner-${modelDisplay.windowLabel}`;
	}
	return phase ?? "claude";
}

export interface ProjectRuntime {
	blueprint: Blueprint;
	projectRoot: string;
	tmuxSessionName: string;
	/**
	 * FLY-137 v1.27.2 (Codex Track A #2): expose the AgentDispatcher so runs-route
	 * can validate `agentName` body field SYNCHRONOUSLY before kicking off the
	 * async Blueprint.run() promise. Without this, `InvalidAgentNameError` thrown
	 * deep inside Blueprint after the .catch handler swallows it — never reaches
	 * the runs-route catch block for a proper 400 INVALID_AGENT_NAME response.
	 */
	agentDispatcher: AgentDispatcher;
	/**
	 * FLY-123: project `.flywheel/config.yaml` `roles:` block — the
	 * project-config layer of RoleAdapterResolver precedence.
	 */
	rolesConfig?: RoleBackendMap;
}

/**
 * FLY-142 PR 1.4 — Build Agent Team transport identity fields for a Runner
 * spawn. Returns fields only when `FLYWHEEL_COMM_BACKEND=mailbox` (default).
 * Empty object → Runner spawn skips transport wiring (same as pre-FLY-142).
 *
 * `runnerAgentName` is derived from `executionId` (first 8 hex chars) so
 * each Runner gets a unique, stable identity in claude-code's Agent Team.
 * Named `runnerAgentName` (not `agentName`) to disambiguate from FLY-137's
 * `BlueprintContext.agentName` which is the dispatcher key
 * (AgentDispatcher.dispatchByName); these serve different purposes.
 *
 * `agentTeamName` equals `leadId` so the Lead's mailbox writes (via
 * `MailboxLeadRuntime.deliver()`) and the Runner's stock `useInboxPoller`
 * reads land on the same vendor path (resolved by ClaudeCodeAdapter from
 * the CLAUDE_CONFIG_DIR teams subtree — kept vendor-opaque here per the
 * grep-gate rule).
 *
 * **Important**: QA E1 verify (2026-05-12) caught that without this, the
 * FLY-142 wake bug "fix" was architecturally dead — TmuxAdapter has the
 * transport branch, but spawn flows weren't passing the required identity
 * fields. Result: mailbox written by Lead, never read by Runner.
 */
export function buildRunnerSpawnFields(
	executionId: string,
	leadId: string | undefined,
	issueLabels: string[] | undefined,
	rolesConfig: RoleBackendMap | undefined,
	/**
	 * FLY-643: when true, omit `issueLabels` from executor-backend resolution so
	 * the issue's vendor labels can't pick the backend (falls to project roles
	 * config > env > built-in claude-tmux). Labels are still used for Lead/thread
	 * routing elsewhere — only the backend label layer is bypassed. Auto-QA sets
	 * this so a QA runner can't inherit the parent's vendor backend. Default
	 * false → existing label-driven resolution (byte-compatible).
	 */
	ignoreRunnerLabelSelection?: boolean,
	/**
	 * FLY-728 Part C: the per-run `/api/runs/start` `model` param (already
	 * normalized to a canonical tier id at the Bridge boundary) — the
	 * difficulty-sorter's output. Applied by resolveRoleAdapter below a manual
	 * model/vendor label and above the project default. On retry it is the
	 * predecessor's persisted `dispatch_model` (actions.ts) — never
	 * `runner_model`, which is display/audit output only (FLY-751 Codex R1
	 * #2). The label layer re-resolves a manual label first, so this only
	 * re-applies a genuinely dispatch-chosen model. Absent → no dispatch
	 * override.
	 */
	dispatchModel?: string,
	/**
	 * FLY-752: require a MAILBOX-CAPABLE backend. When the resolved backend would be
	 * no-transport (antigravity/kimi → transport:"none", which project roles / env
	 * default can still select even under `ignoreRunnerLabelSelection`), FORCE the
	 * transported `claude-tmux` lane and DROP the (possibly Claude-incompatible)
	 * model/effort from the no-transport source (→ Claude account defaults). Auto-QA
	 * sets this so its QA runner can always receive a `retest_wake`. Default false →
	 * byte-compatible (no forcing).
	 */
	requireMailboxTransport?: boolean,
	/**
	 * FLY-1224: the phase table's explicit vendor for this dispatch — resolves
	 * the executor backend on the 1b dispatch layer via the ONE existing
	 * VENDOR_TO_EXECUTOR map. Only ever set for DAG workflow dispatches
	 * (Bridge-internal); absent → FLY-728 claude-tmux status quo.
	 */
	dispatchVendor?: WorkflowDispatchVendor,
	/** FLY-1224: the phase table's reasoning effort (outranks project roles). */
	dispatchEffort?: RoleEffort,
): Pick<
	BlueprintContext,
	| "runnerAgentName"
	| "agentTeamName"
	| "vendor"
	| "runnerBackend"
	| "runnerModel"
	| "runnerEffort"
	| "runnerTransportMode"
> {
	// FLY-123: resolve the executor backend for the runner role —
	// task(label) > FLY-728 dispatch model > project roles config >
	// FLYWHEEL_RUNNER_BACKEND env > built-in claude-tmux. With nothing configured
	// this resolves to claude-tmux + vendor claude-code, making the returned
	// fields byte-identical to the pre-FLY-123 buildAgentTeamIdentity output
	// (plus runnerBackend="claude-tmux", which is also Blueprint's default).
	// FLY-643: a QA runner (ignoreRunnerLabelSelection) skips the label layer so
	// the parent's vendor labels can't select its backend.
	const resolvedRaw = resolveRoleAdapter({
		role: "runner",
		...(!ignoreRunnerLabelSelection && issueLabels && { issueLabels }),
		...(dispatchModel && { dispatchModel }),
		// FLY-1224: phase table vendor + effort ride the same dispatch layer.
		...(dispatchVendor && { dispatchVendor }),
		...(dispatchEffort && { dispatchEffort }),
		...(rolesConfig && { projectRoles: rolesConfig }),
	});
	// FLY-752: force a mailbox-capable lane when required. A no-transport backend
	// (antigravity/kimi) has no mailbox → a QA runner on it could never receive its
	// retest_wake. Rewrite to claude-tmux + drop the source model/effort so the
	// forced Claude lane uses account defaults (the no-transport role's model may be
	// Claude-incompatible; Blueprint forwards runnerModel to the adapter).
	const resolved: ResolvedRoleAdapter =
		requireMailboxTransport && resolvedRaw.transport === "none"
			? {
					backend: "claude-tmux",
					transport: "claude-code",
					vendor: "claude-code",
				}
			: resolvedRaw;
	// FLY-493: a no-transport backend (antigravity, transport === "none") carries
	// an EXPLICIT marker so the absence of vendor/Agent-Team identity below is an
	// intentional contract, not the legacy/rollback "default claude" absence.
	const backendFields: Pick<
		BlueprintContext,
		"runnerBackend" | "runnerModel" | "runnerEffort" | "runnerTransportMode"
	> = {
		runnerBackend: resolved.backend,
		...(resolved.model && { runnerModel: resolved.model }),
		...(resolved.effort && { runnerEffort: resolved.effort }), // FLY-671
		...(resolved.transport === "none" && { runnerTransportMode: "none" }),
	};
	// A no-transport backend NEVER wires Agent Team identity — even on the
	// mailbox-default path with a leadId. Return the backend (+ transport marker)
	// only; there is no mailbox for the Lead to wake.
	if (resolved.transport === "none") {
		return backendFields;
	}

	// FLY-142 PR #186 Codex Round 1 MEDIUM: share the single
	// `resolveCommBackend` parser with `plugin.ts:createLeadRuntime` so
	// unknown / typo'd env values fall back to mailbox consistently across
	// the Bridge runtime selection AND Runner spawn identity. Previously
	// run-dispatcher used a strict `!== "mailbox"` check while plugin.ts
	// was lenient (typo → fallback to mailbox), so a typo silently broke
	// the Runner side while the Bridge side carried on writing mailbox.
	if (resolveCommBackend() !== "mailbox") {
		// Rollback path — CommDB hook flow, no Agent Team identity needed.
		return backendFields;
	}
	if (!leadId) {
		// No Lead → no Agent Team to join. Runner spawns without transport
		// wiring (same as pre-FLY-142). This shouldn't happen on the
		// production path (req.leadId is required when dispatched from
		// LeadEventRouter), but guard anyway.
		return backendFields;
	}
	// FLY-168: share the single identity derivation with `flywheel-comm send`
	// mailbox dual-write so the spawn side and the send side can never diverge.
	// FLY-123: same identity for codex — the codex mailbox watcher and the
	// respond wake both derive from it (deriveRunnerMailboxIdentity is the
	// single source of truth across vendors).
	const { agentName, teamName } = deriveRunnerMailboxIdentity(
		executionId,
		leadId,
	);
	return {
		...backendFields,
		runnerAgentName: agentName,
		agentTeamName: teamName,
		vendor: resolved.vendor,
	};
}

/**
 * FLY-1185 §2.12 (R9#2): a founder-parked (tombstoned) issue refused a spawn.
 * Routes map this to a 409 with the reason — never a silent respawn of a
 * just-zeroed issue.
 */
/**
 * FLY-1185 (Codex R1#5 + R2#2 + R4#1) — the dispatcher side of the
 * park-vs-start arbitration, per plan.md:145: the claim stays `starting`
 * until the session row + worktree binding are DURABLE, and only then
 * advances to `active` at the emitStarted point (under the same canonical
 * issue mutex). `commitLaunch` is therefore a mutex-guarded VERIFY (claim
 * must still be `starting`/`active` — a park that cancelled it wins and the
 * spawn aborts); `activateLaunch` is the ONE atomic CAS starting→active
 * executed by DirectEventSink.emitStarted once the row is durable. A park
 * landing between the verify and activation cancels the claim → activation
 * refuses → the park-intent replay owns the newborn runner next tick.
 * `onSpawnFailed` closes the claim so it never lingers.
 */
export interface LifecycleLaunchGuard {
	/** R3#6: async — the production impl holds the SAME per-issue mutex as
	 * the executor/apply snapshot guard, so a launch verify can never slide
	 * between an apply's compare and its execution. R4#1: VERIFY-only (no
	 * state change) — activation happens at emitStarted. */
	commitLaunch: (executionId: string) => Promise<{
		ok: boolean;
		reason?: string;
	}>;
	/** R4#1 (plan.md:145): CAS starting→active under the issue mutex, called
	 * from the emitStarted path AFTER the session row is durable. Refusal
	 * (claim cancelled by a park mid-spawn) is audited by the caller; the
	 * park-intent replay tears the newborn runner down. */
	activateLaunch?: (executionId: string) => Promise<{
		ok: boolean;
		reason?: string;
	}>;
	onSpawnFailed: (executionId: string) => void;
}

export class LifecycleParkedError extends Error {
	constructor(public readonly reason: string) {
		super(`lifecycle admission denied: ${reason}`);
		this.name = "LifecycleParkedError";
	}
}

export class ContinuityIndeterminateError extends Error {
	readonly code = "CONTINUITY_INDETERMINATE";
	readonly retryable = true;

	constructor(public readonly detail: string) {
		super(`branch continuity is indeterminate: ${detail}`);
		this.name = "ContinuityIndeterminateError";
	}
}

export class DoaBackoffError extends Error {
	readonly code = "DOA_BACKOFF";

	constructor(
		public readonly reason: string,
		public readonly retryAfterSeconds?: number,
	) {
		super(`DOA re-dispatch admission denied: ${reason}`);
		this.name = "DoaBackoffError";
	}
}

export class FreshStartAuditError extends Error {
	readonly code = "FRESH_START_AUDIT_FAILED";

	constructor(detail: string) {
		super(`fresh-start override refused: ${detail}`);
		this.name = "FreshStartAuditError";
	}
}

export type FreshStartAuditRecorder = (record: {
	executionId: string;
	projectName: string;
	issueId: string;
	role: string;
	actor: string;
	reason: string;
	branch: string;
	skippedOriginTip?: string;
}) => boolean;

/** FLY-1185: the admission decorator seam (single dispatcher chokepoint). */
export type LifecycleAdmissionFn = (input: {
	issueKey: string;
	issueIdentifier?: string;
	projectName: string;
	executionId: string;
	role?: string;
}) => Promise<{ admitted: boolean; reason?: string }>;

/** FLY-1718 P4: canonical predecessor reconciliation before branch/network IO. */
export type DoaBackoffAdmissionFn = (input: {
	issueKey: string;
	issueIdentifier?: string;
	projectName: string;
	executionId: string;
	role: string;
	leadId?: string;
}) => Promise<{
	admitted: boolean;
	reason?: string;
	status?: "allow" | "reserved" | "backoff" | "needs_lead";
	retryAfterSeconds?: number;
}>;

/**
 * FLY-1188: transport vendor for the CommDB pre-registration row. The
 * adapter's self-registration overwrites it, but `flywheel-comm send`
 * consults the row from the moment `start()` returns — a NULL vendor in
 * that window falls back to the process-wide env transport (claude-code)
 * and a codex runner's instruction lands in a mailbox it never reads.
 * A no-transport backend (antigravity/kimi) is marked "none" so `send`
 * fails loud instead of faking delivery into a claude inbox.
 */
export function preRegistrationVendor(
	runnerSpawn: Pick<BlueprintContext, "vendor" | "runnerTransportMode">,
): string | undefined {
	if (runnerSpawn.runnerTransportMode === "none") return "none";
	return runnerSpawn.vendor;
}

/** Fail closed before any dispatch side effect for a design-node completion. */
export function assertDesignDispatchContract(
	req: Pick<
		StartRequest | RetryRequest,
		"sessionRole" | "shareParentBranch" | "leadId" | "generalizedExecution"
	>,
): void {
	const generalizedRoute =
		req.generalizedExecution?.capabilities?.completion_route;
	const isDesignNode =
		(req.shareParentBranch === true && req.sessionRole === "design") ||
		generalizedRoute === "phase_design_complete";
	if (!isDesignNode) return;
	if (
		generalizedRoute === "phase_design_complete" &&
		req.generalizedExecution?.capabilities.shared_branch_writer !== true
	) {
		throw new Error(
			"design-node completion requires a shared branch writer for its committed founder HTML",
		);
	}
	if (typeof req.leadId !== "string" || !req.leadId.trim()) {
		throw new Error(
			"design-node completion requires a resolved Lead for founder HTML delivery",
		);
	}
}

export class RetryDispatcher implements IRetryDispatcher {
	protected inflight = new Map<string, InflightEntry>();
	protected accepting = true;

	constructor(
		protected blueprintsByProject: Map<string, ProjectRuntime>,
		private cleanupHandles: Array<() => Promise<void>>,
		/** FLY-245 D2 / R1 HIGH-3: durable cross-restart launch claim keyed by
		 * execId (gateway pre-bound retry path only). Undefined → legacy behavior. */
		protected launchClaims?: LaunchClaimStore,
		/** FLY-245 R5: test seam for the durable commit-record existence check
		 * (default: real `existsSync`). The adopt decision is `claim exists +
		 * committed → adopt; else re-drive`. */
		protected isCommitted: (execId: string) => boolean = (execId) =>
			existsSync(launchCommitPath(execId)),
		/**
		 * FLY-1185 (R11#1): lifecycle admission — fresh founder-park tombstone
		 * check + durable `starting` launch claim, executed INSIDE the per-root
		 * issue mutex at THIS single chokepoint (every spawn surface — HTTP
		 * start / retry / phase handoff / auto-QA / rescue — flows through
		 * start() or dispatch()). Undefined → legacy behavior (byte-compat).
		 */
		protected lifecycleAdmission?: LifecycleAdmissionFn,
		/** FLY-1185 (Codex R1#5): pre-launch recheck + claim CAS hooks. */
		protected lifecycleLaunchGuard?: LifecycleLaunchGuard,
		/** FLY-1257 M3: recover the shared branch tip before a phase retry. */
		protected phaseRetryStartPointComputer?: PhaseRetryStartPointComputer,
		/**
		 * FLY-1356 (R1#4): sticky-stamp lookup (production: store.
		 * getSkillFrameworkStamp). The hash only fires on an issue's FIRST
		 * admission; later dispatches carry the prior arm so identifier-source
		 * instability can never split one issue across arms. Undefined ⇒ no
		 * stamp threaded (byte-compatible; resolver falls through normally).
		 */
		protected skillFrameworkStampLookup?: (
			issueId: string,
		) => SkillFrameworkMode | undefined,
		protected tmuxGenerationRecorder?: TmuxGenerationRecorder,
		/** FLY-1638: one admission controller shared by fresh and retry lanes. */
		protected runnerAdmission: RunnerAdmissionController = RunnerAdmissionController.alwaysAdmit(),
		protected tmuxWindowAuthority?: TmuxWorkflowWindowAuthority,
		protected doaBackoffAdmission?: DoaBackoffAdmissionFn,
		/**
		 * FLY-1775: StateStore-authoritative irreversible-terminal probe. A
		 * Blueprint promise may outlive the runner session it launched; a terminal
		 * session must not leave this process-local dedup lane poisoned forever.
		 */
		protected inflightSessionTerminal?: InflightSessionTerminalProbe,
	) {}

	/** Typed fleet admission check, deliberately before shutdown semantics. */
	protected assertRunnerAdmission(): void {
		const decision = this.runnerAdmission.tryAdmit();
		if (!decision.admit) {
			throw new AdmissionDeferredError(
				decision.reason,
				decision.detail,
				decision.retryAfterSeconds,
			);
		}
	}

	/**
	 * FLY-1356 (Bar-Raiser MED-1 + Codex R1 HIGH-2): sticky-stamp read,
	 * consulted ONLY under `split` — the default path stays zero-IO (no
	 * per-dispatch table scan). A store throw must never fail the dispatch,
	 * but it must equally never be swallowed into "no stamp": the resolver
	 * would hash the issue into an experimental arm on a broken read. It
	 * surfaces as `readFailed` and the resolver fails closed to superpowers.
	 */
	protected skillFrameworkPrior(
		issueId: string,
	): { stamp: SkillFrameworkMode } | { readFailed: true } | undefined {
		if (process.env[SKILL_FRAMEWORK_MODE_ENV] !== SKILL_FRAMEWORK_SPLIT) {
			return undefined;
		}
		try {
			const stamp = this.skillFrameworkStampLookup?.(issueId);
			return stamp ? { stamp } : undefined;
		} catch (err) {
			console.warn(
				`[dispatcher] skill-framework stamp lookup failed for ${issueId} — failing closed to superpowers (resolver pins A, never the hash): ${(err as Error).message}`,
			);
			return { readFailed: true };
		}
	}

	/** Spread-shape helper for the two ctx build sites (start / retry). */
	protected skillFrameworkPriorCtx(
		issueId: string,
	):
		| { skillFrameworkModePrior: SkillFrameworkMode }
		| { skillFrameworkModeStampReadFailed: true }
		| Record<string, never> {
		const prior = this.skillFrameworkPrior(issueId);
		if (!prior) return {};
		return "stamp" in prior
			? { skillFrameworkModePrior: prior.stamp }
			: { skillFrameworkModeStampReadFailed: true };
	}

	/** Shared admission gate — throws LifecycleParkedError on refusal. */
	protected async admitLifecycle(input: {
		issueKey: string;
		issueIdentifier?: string;
		projectName: string;
		executionId: string;
		role?: string;
	}): Promise<void> {
		if (!this.lifecycleAdmission) return;
		const res = await this.lifecycleAdmission(input);
		if (!res.admitted) {
			throw new LifecycleParkedError(res.reason ?? "denied");
		}
	}

	/** FLY-1718 P4: run before branch continuity, CommDB, TURN, or worktree IO. */
	protected async admitDoaBackoff(input: {
		issueKey: string;
		issueIdentifier?: string;
		projectName: string;
		executionId: string;
		role: string;
		leadId?: string;
	}): Promise<void> {
		if (!this.doaBackoffAdmission) {
			return;
		}
		const result = await this.doaBackoffAdmission(input);
		if (!result.admitted) {
			throw new DoaBackoffError(
				result.reason ?? "denied",
				result.retryAfterSeconds,
			);
		}
	}

	/** FLY-59: Composite inflight key for per-role dedup */
	protected inflightKey(issueId: string, role: string): string {
		// FLY-95: Normalize role to match Blueprint worktree naming —
		// prevents "qa", "QA", "q/a" from being treated as different lanes
		// while mapping to the same worktree on disk.
		const normalized =
			role.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() || "main";
		return `${issueId}:${normalized}`;
	}

	/**
	 * Return only a live inflight owner. StateStore is the durable lifecycle
	 * authority; this Map is merely a process-local launch dedup. Probe failures
	 * fail closed (keep the exclusion record) so an unreadable store cannot admit
	 * a duplicate runner.
	 */
	protected currentInflightEntry(key: string): InflightEntry | undefined {
		const entry = this.inflight.get(key);
		if (!entry || !this.inflightSessionTerminal) return entry;
		let terminal = false;
		try {
			terminal = this.inflightSessionTerminal(entry.executionId);
		} catch (error) {
			console.warn(
				`[RunDispatcher] terminal inflight probe failed for ${entry.executionId}; keeping lane occupied: ${error instanceof Error ? error.message : String(error)}`,
			);
			return entry;
		}
		if (!terminal) return entry;
		this.clearInflightEntry(key, entry);
		return this.inflight.get(key);
	}

	/** Identity-guard cleanup so a late old promise cannot erase a replacement. */
	protected clearInflightEntry(key: string, entry: InflightEntry): void {
		if (this.inflight.get(key) === entry) {
			this.inflight.delete(key);
		}
	}

	protected pruneTerminalInflightEntries(): void {
		for (const key of [...this.inflight.keys()]) {
			this.currentInflightEntry(key);
		}
	}

	async dispatch(req: RetryRequest): Promise<RetryResult> {
		this.assertRunnerAdmission();
		if (!this.accepting) {
			throw new Error("RetryDispatcher is shutting down");
		}
		assertDesignDispatchContract(req);

		const role = req.sessionRole ?? "main";
		const key = this.inflightKey(req.issueId, role);

		const inflightEntry = this.currentInflightEntry(key);
		if (inflightEntry) {
			// FLY-245 D2: a replay of the IDENTICAL gateway-bound dispatch (same
			// pre-bound successor id) converges on the in-flight execution instead
			// of erroring — exactly-one-started, never a silent second runner.
			// Anything else (different/absent pre-bound id) keeps the legacy throw.
			if (
				(req.successorExecutionId || req.generalizedExecution) &&
				inflightEntry.executionId ===
					(req.generalizedExecution?.executionId ?? req.successorExecutionId)
			) {
				return {
					newExecutionId: inflightEntry.executionId,
					oldExecutionId: req.oldExecutionId,
				};
			}
			throw new Error(
				`Retry already in progress for issue ${req.issueId} role ${role}`,
			);
		}

		const runtime = this.blueprintsByProject.get(req.projectName);
		if (!runtime) {
			throw new Error(`No runtime for project: ${req.projectName}`);
		}

		// FLY-116: opener moved into BlueprintContext callback below
		// (was: openTmuxViewer(runtime.tmuxSessionName) — fired too early without windowId).

		// FLY-245 D2 (plan §5.2.1): honor a gateway PRE-BOUND successor id so
		// recovery can reconcile/re-drive by a durably-bound key; legacy callers
		// (no pre-bound id) keep the self-generated UUID byte-for-byte.
		const newExecutionId =
			req.generalizedExecution?.executionId ??
			req.successorExecutionId ??
			randomUUID();
		if (
			req.generalizedExecution &&
			req.successorExecutionId &&
			req.successorExecutionId !== req.generalizedExecution.executionId
		) {
			throw new Error("generalized retry execution id mismatch");
		}

		await this.admitDoaBackoff({
			issueKey: req.issueId,
			issueIdentifier: req.issueIdentifier,
			projectName: req.projectName,
			executionId: newExecutionId,
			role,
			leadId: req.leadId,
		});

		// FLY-1185 (R11#1): lifecycle admission — a founder-parked issue must not
		// grow a retry runner. Fresh tombstone check + durable starting claim
		// inside the issue mutex; throws LifecycleParkedError on refusal.
		try {
			await this.admitLifecycle({
				issueKey: req.issueId,
				issueIdentifier: req.issueIdentifier,
				projectName: req.projectName,
				executionId: newExecutionId,
				role,
			});
		} catch (error) {
			this.abortPreLaunch(key, newExecutionId, req.projectName);
			throw error;
		}

		// FLY-245 R1/R2/R5 HIGH-3: durable cross-restart find-or-create. The
		// in-flight map above only dedups within THIS process; after a Bridge crash
		// the gateway replays the same pre-bound execId with an empty inflight map.
		// A durable claim keyed by execId, checked BEFORE worktree/tmux creation,
		// converges to EXACTLY ONE started Runner. The ADOPT signal is a durable
		// COMMIT file (R5 HIGH): the adapter GATES the Runner on it — Claude/Codex
		// cannot start until the adapter writes it at the single commit point — so
		// "committed file exists" ⟺ "this execId's Runner was committed to start".
		//   - first claim → proceed (the adapter will write the commit when it
		//     reaches the commit point);
		//   - already claimed + COMMITTED → adopt, NEVER start a second (the
		//     committed Runner is starting / started / started-and-exited = one
		//     started execution);
		//   - already claimed + NOT committed → the prior attempt crashed BEFORE the
		//     Runner was committed (e.g. between window-open and commit) → its gated
		//     waiting shell self-reaps and was NEVER a live Runner, so re-drive the
		//     SAME execId (FLY-99 converges). A recorded-but-never-committed window
		//     is never mistaken for a started Runner (the R5 zero-convergence bug).
		const committedDir = launchCommitPath(newExecutionId);
		if (
			(req.successorExecutionId || req.generalizedExecution) &&
			this.launchClaims
		) {
			const claimResult = this.launchClaims.claim(newExecutionId, Date.now());
			if (claimResult === "exists" && this.isCommitted(newExecutionId)) {
				return {
					newExecutionId,
					oldExecutionId: req.oldExecutionId,
				};
			}
			// not committed (or first claim) → proceed to (re-)drive. Ensure the
			// commit dir exists so the adapter's commit write can't fail on mkdir.
			try {
				mkdirSync(join(committedDir, ".."), { recursive: true });
			} catch {
				// best-effort; the adapter also mkdir's defensively
			}
		}

		const entry = {
			executionId: newExecutionId,
			promise: null! as Promise<void>,
		};
		this.inflight.set(key, entry);
		try {
			// FLY-142 PR 1.4 + FLY-123: Agent Team identity + executor backend
			// resolution. No-op on rollback path (backend fields still set).
			// Uses runnerAgentName/agentTeamName/vendor — distinct from
			// FLY-137's agentName (dispatcher key) above.
			// FLY-1188: resolved BEFORE the CommDB pre-registration so the pending
			// row already carries the runner's transport vendor (pure function —
			// no ordering dependency).
			const runnerSpawn = buildRunnerSpawnFields(
				newExecutionId,
				req.leadId,
				req.issueLabels,
				runtime.rolesConfig,
				// FLY-887 R2 (Codex R1 #2): now carried on the retry path — actions.ts
				// sets it for PHASE rows so a refreshed label cannot bypass the phase
				// table on retry. Undefined for non-phase retries (byte-compatible with
				// the previous hardcoded undefined). The FLY-728 dispatch model is
				// carried as before (`runner_model` is display/audit output only,
				// FLY-751 Codex R1 #2).
				req.generalizedExecution ? true : req.ignoreRunnerLabelSelection,
				req.generalizedExecution?.dispatch.model ?? req.dispatchModel,
				// FLY-1224: retry has no requireMailboxTransport source (positional gap);
				// phase-row retries re-derive vendor/effort from the table (actions.ts).
				undefined,
				req.generalizedExecution?.dispatch.vendor ?? req.dispatchVendor,
				req.generalizedExecution?.dispatch.effort ?? req.dispatchEffort,
			);
			const modelDisplay = renderRunnerModelDisplay({
				vendor: runnerSpawn.runnerBackend
					? adapterTypeToFamily(runnerSpawn.runnerBackend)
					: undefined,
				model: runnerSpawn.runnerModel,
			});

			// FLY-80: Pre-register in CommDB before blueprint starts.
			// FLY-1188: carry the resolved vendor — the adapter's self-registration
			// overwrites this row later, but a Lead `send` inside that window would
			// otherwise fall to the process-wide env default (claude mailbox) and a
			// codex runner would never see the instruction.
			this.preRegisterCommDb(
				newExecutionId,
				runtime.tmuxSessionName,
				req.projectName,
				req.issueId,
				req.leadId,
				preRegistrationVendor(runnerSpawn),
			);

			// FLY-1257 M3: every phase retry (independent of keep-alive) recovers
			// branch B's current tip before either granting TURN or touching Blueprint.
			// Only a confirmed missing branch may use WorktreeManager's fresh fallback;
			// an indeterminate git/IO failure must never reset branch B to origin/main.
			const isPhaseRetry =
				req.shareParentBranch === true && isWorkflowPhaseRole(role);
			let retryStartPoint: string | undefined;
			const computeRetryStartPoint = (): string | undefined => {
				const computed = this.phaseRetryStartPointComputer?.(
					req.issueId,
					role,
					req.projectName,
				) ?? {
					kind: "indeterminate" as const,
					error: "phase retry startPoint computer unavailable",
				};
				if (computed.kind === "indeterminate") {
					throw new Error(
						`phase retry startPoint is indeterminate for ${role} on ${req.issueId}: ${computed.error}`,
					);
				}
				if (computed.kind === "missing") return undefined;
				const sha = computed.sha.trim();
				if (!sha) {
					throw new Error(
						`phase retry startPoint is indeterminate for ${role} on ${req.issueId}: found probe returned an empty sha`,
					);
				}
				return sha;
			};
			if (isPhaseRetry) {
				try {
					retryStartPoint = computeRetryStartPoint();
				} catch (error) {
					this.abortPreLaunch(key, newExecutionId, req.projectName);
					throw error;
				}
			}

			// FLY-1257 M2: retry is a real DAG workflow launch, so it must receive
			// the shared-worktree TURN before Blueprint can start the runner's first
			// self-check. grantTurn's upsert increments the epoch atomically, moving
			// ownership from the predecessor to this successor.
			if (isPhaseRetry) {
				try {
					const db = new CommDB(defaultGetCommDbPath(req.projectName));
					try {
						grantPrelaunchWorkflowTurn({
							db,
							issueId: req.issueId,
							projectName: req.projectName,
							executionId: newExecutionId,
							phase: role,
							grantedAtMs: Date.now(),
							generalizedExecution: req.generalizedExecution,
						});
					} finally {
						db.close();
					}
				} catch (err) {
					this.abortPreLaunch(key, newExecutionId, req.projectName);
					throw new Error(
						`pre-launch TURN grant failed for ${role} phase retry on ${req.issueId}: ${(err as Error).message}`,
					);
				}
			}
			// Re-probe after TURN transfer. The first read prevents an ambiguous probe
			// from moving ownership; this second read is the authoritative branch tip
			// under the single-writer fence. A failure leaves TURN on the successor for
			// the normal dead-holder reconciler and never launches with a stale SHA.
			if (isPhaseRetry) {
				try {
					retryStartPoint = computeRetryStartPoint();
				} catch (error) {
					this.abortPreLaunch(key, newExecutionId, req.projectName);
					throw error;
				}
			}
			const ctx: BlueprintContext = {
				teamName: "eng",
				// FLY-1255: phase/model identity is composed once from the resolved spawn.
				runnerName: runnerDisplayName(
					req.sessionRole,
					req.shareParentBranch,
					modelDisplay,
				),
				projectName: req.projectName,
				executionId: newExecutionId,
				leadId: req.leadId,
				sessionRole: req.sessionRole,
				...(req.designBackend && { designBackend: req.designBackend }),
				// FLY-1356: forced-arm continuation + sticky stamp (see StartRequest
				// docs; the resolver owns precedence and kill semantics).
				...(req.skillFrameworkMode && {
					skillFrameworkModeOverride: req.skillFrameworkMode,
				}),
				...this.skillFrameworkPriorCtx(req.issueId),
				// FLY-793: DAG workflows share one branch B (Bridge-internal).
				shareParentBranch: req.shareParentBranch,
				// FLY-1257 M3: found branch B tip; absent only when branch absence was
				// confirmed (or no computer was injected on a legacy external dispatcher).
				...(retryStartPoint && { startPoint: retryStartPoint }),
				// Forward pre-fetched metadata so EventEnvelope retains title/identifier
				issueTitle: req.issueTitle,
				issueIdentifier: req.issueIdentifier,
				// FLY-137 v1.27.2: thread Lead override + dispatch context
				agentName: req.agentName,
				issueLabels: req.issueLabels,
				owningDept: req.owningDept,
				// FLY-1609: Blueprint validates frozen arm intent against the final mode.
				ponytailRetry: req.ponytailRetry,
				// FLY-205: predecessor's tier + URL — retry NEVER re-defaults the tier
				docTier: req.docTier,
				issueUrl: req.issueUrl,
				// FLY-1372 §2.5 (Codex code R1 #3): behavior snapshots ride the retry
				// context too, so the retry session row is created WITH them.
				codexSkip: req.codexSkip,
				founderFacingUx: req.founderFacingUx,
				...(req.generalizedExecution && {
					generalizedExecutionContext: {
						runId: req.generalizedExecution.runId,
						nodeId: req.generalizedExecution.nodeId,
						attempt: req.generalizedExecution.attempt,
						snapshotDigest: req.generalizedExecution.snapshotDigest,
						gateCarrierEpoch: req.generalizedExecution.gateCarrierEpoch,
					},
					workflowCapabilities: req.generalizedExecution.capabilities,
					workflowAgentContent: req.generalizedExecution.agentContent,
					workflowOutputCredential: req.generalizedExecution.outputCredential,
					workflowSubmissionCredential:
						req.generalizedExecution.submissionCredential,
					workflowSubmissionExpected: true,
				}),
				...runnerSpawn,
				// FLY-751: recompute the MCP slim profile on retry from the persisted
				// session fields (sessionRole + issue labels flow through the retry
				// request) — a QA retry keeps its browser exemption.
				...(runnerSpawn.runnerBackend === "claude-tmux" && {
					runnerMcpProfile: resolveRunnerMcpProfile({
						sessionRole: req.sessionRole,
						issueLabels: req.issueLabels,
					}),
				}),
				retryContext: {
					predecessorExecutionId: req.oldExecutionId,
					previousError: req.previousError,
					previousDecisionRoute: req.previousDecisionRoute,
					previousReasoning: req.previousReasoning,
					attempt: req.runAttempt,
					reason: req.reason,
				},
				// R5 HIGH-3: durable COMMIT record for the gateway pre-bound path only.
				// The adapter GATES the Runner on this file (Claude/Codex cannot start
				// until the adapter writes it at the commit point) so a post-crash
				// replay adopts ONLY a committed Runner, never a recorded-but-never-
				// started gated shell. Deterministic path → a new Bridge computes the
				// same path on replay.
				launchCommitPath:
					req.successorExecutionId || req.generalizedExecution
						? committedDir
						: undefined,
				launchGateToken: req.generalizedExecution?.launchGateToken,
				launchGeneration: req.generalizedExecution?.launchGeneration,
				launchFingerprint:
					req.generalizedExecution?.launchGeneration !== undefined
						? createHash("sha256")
								.update(
									`${newExecutionId}:${req.generalizedExecution.launchGeneration}:${req.generalizedExecution.launchGateToken ?? ""}`,
								)
								.digest("hex")
						: undefined,
				commitWorkflowLaunch: req.generalizedExecution?.commitWorkflowLaunch,
				prepareWorkflowIssueDelivery:
					req.generalizedExecution?.prepareWorkflowIssueDelivery,
				workflowTmuxWindowAuthority: (candidate) =>
					this.tmuxWindowAuthority?.(newExecutionId, candidate) ?? "keep",
				...(runnerSpawn.runnerBackend === "claude-tmux" &&
					this.tmuxGenerationRecorder && {
						onTmuxWindowOpened: (info) =>
							this.tmuxGenerationRecorder?.(newExecutionId, info),
					}),
				// FLY-116: spawn macOS Terminal viewer once tmux window exists
				onTmuxWindowCreated: ({ baseSessionName, windowId }) => {
					openTmuxViewer({
						baseSessionName,
						windowId,
						executionId: newExecutionId,
						projectName: req.projectName,
						sessionRole: req.sessionRole,
					});
				},
			};

			// FLY-1185 (Codex R3#2 + R4#1): the retry path verifies its launch
			// through the SAME mutex-guarded gate as start() — a park cancelling
			// the claim between the retry admission and here wins and the spawn
			// aborts. R4#1: refusal cleans up SYMMETRICALLY (inflight + CommDB
			// pre-registration) so a later retry never converges on a ghost entry.
			if (this.lifecycleLaunchGuard) {
				const commit =
					await this.lifecycleLaunchGuard.commitLaunch(newExecutionId);
				if (!commit.ok) {
					this.abortPreLaunch(key, newExecutionId, req.projectName, false);
					throw new LifecycleParkedError(
						commit.reason ?? "cancelled_between_admission_and_launch",
					);
				}
			}

			entry.promise = runtime.blueprint
				.run({ id: req.issueId, blockedBy: [] }, runtime.projectRoot, ctx)
				.then((result) => {
					// Publish no failure signal while the lane still points at this
					// failed launch: an immediate retry must see it clear. Successful
					// launches retain the existing finally()-ordered convergence.
					if (!result.success) this.clearInflightEntry(key, entry);
					if (result.worktreePath) {
						console.log(
							`[RetryDispatcher] ${newExecutionId} ran in worktree: ${result.worktreePath}`,
						);
					}
					if (result.success) {
						console.log(
							`[RetryDispatcher] ${newExecutionId} completed for issue ${req.issueIdentifier ?? req.issueId}`,
						);
					} else {
						// R4#1: close the launch claim on spawn failure (mirror start()).
						try {
							this.lifecycleLaunchGuard?.onSpawnFailed(newExecutionId);
						} catch {
							/* guard must never break the launch pipeline */
						}
						console.warn(
							`[RetryDispatcher] ${newExecutionId} resolved with failure for issue ${req.issueIdentifier ?? req.issueId}: ${result.error ?? "unknown"}`,
						);
						// FLY-95: Clean up orphan pre-registration when Runner never self-registered
						if (!result.sessionId) {
							this.cleanupPreRegistration(newExecutionId, req.projectName);
						}
					}
				})
				.catch((err: unknown) => {
					this.clearInflightEntry(key, entry);
					console.error(
						`[RetryDispatcher] ${newExecutionId} failed:`,
						err instanceof Error ? err.message : err,
					);
					// R4#1: symmetric claim cleanup on thrown spawn failure.
					try {
						this.lifecycleLaunchGuard?.onSpawnFailed(newExecutionId);
					} catch {
						/* guard must never break the launch pipeline */
					}
					// FLY-80: Clean up orphan pre-registration on failed start
					this.cleanupPreRegistration(newExecutionId, req.projectName);
				})
				.finally(() => {
					this.clearInflightEntry(key, entry);
				});

			return { newExecutionId, oldExecutionId: req.oldExecutionId };
		} catch (err) {
			if (this.inflight.get(key) === entry) {
				this.abortPreLaunch(
					key,
					newExecutionId,
					req.projectName,
					!(err instanceof LifecycleParkedError),
				);
			}
			throw err;
		}
	}

	/**
	 * FLY-80: Pre-register session in CommDB so Lead can interact immediately
	 * (capture tmux, check pending questions) without waiting for Runner self-registration.
	 * Non-fatal — if this fails, Runner will self-register later.
	 */
	protected preRegisterCommDb(
		executionId: string,
		tmuxSession: string,
		projectName: string,
		issueId: string,
		leadId?: string,
		/** FLY-1188: resolved transport vendor (see preRegistrationVendor). */
		vendor?: string,
	): void {
		try {
			const dbPath = defaultGetCommDbPath(projectName);
			const db = new CommDB(dbPath);
			try {
				db.registerSession(
					executionId,
					`${tmuxSession}:pending`,
					projectName,
					issueId,
					leadId,
					vendor,
				);
			} finally {
				db.close();
			}
		} catch (err) {
			console.warn(
				`[RunDispatcher] CommDB pre-register failed for ${executionId}:`,
				(err as Error).message,
			);
		}
	}

	/** FLY-80: Remove orphan pre-registration when blueprint fails before Runner self-registers. */
	protected cleanupPreRegistration(
		executionId: string,
		projectName: string,
	): void {
		try {
			const dbPath = defaultGetCommDbPath(projectName);
			const db = new CommDB(dbPath);
			try {
				db.unregisterPendingSession(executionId);
			} finally {
				db.close();
			}
		} catch {
			// Best-effort — CommDB may not be reachable
		}
	}

	/**
	 * FLY-1257 M2: one symmetric pre-launch abort for fresh and retry paths.
	 * Every cleanup is best-effort and independent so a broken CommDB cannot
	 * leave the inflight entry or durable lifecycle claim stuck at `starting`.
	 */
	protected abortPreLaunch(
		key: string,
		executionId: string,
		projectName: string,
		notifySpawnFailed = true,
	): void {
		try {
			// Several failures happen before this execution installs its own entry.
			// A concurrent launch may already own the same lane by then; never let the
			// older abort erase that newer execution's in-memory exclusion record.
			const entry = this.inflight.get(key);
			if (entry?.executionId === executionId)
				this.clearInflightEntry(key, entry);
		} catch {
			/* Map.delete is expected not to throw; keep the remaining cleanup alive. */
		}
		try {
			this.cleanupPreRegistration(executionId, projectName);
		} catch {
			/* best-effort; cleanupPreRegistration already contains its own guard */
		}
		if (notifySpawnFailed) {
			try {
				this.lifecycleLaunchGuard?.onSpawnFailed(executionId);
			} catch {
				/* lifecycle cleanup must never mask the original launch failure */
			}
		}
	}

	/** FLY-59: Returns unique issueIds from composite keys (backward compat) */
	getInflightIssues(): Set<string> {
		this.pruneTerminalInflightEntries();
		const issueIds = new Set<string>();
		for (const key of this.inflight.keys()) {
			const issueId = key.split(":")[0];
			if (issueId) issueIds.add(issueId);
		}
		return issueIds;
	}

	/** FLY-59: Check if a specific issue+role combo is currently inflight */
	hasInflightForRole(issueId: string, role: string): boolean {
		return Boolean(this.currentInflightEntry(this.inflightKey(issueId, role)));
	}

	stopAccepting(): void {
		this.accepting = false;
	}

	async drain(): Promise<void> {
		this.pruneTerminalInflightEntries();
		const promises = [...this.inflight.values()].map((v) => v.promise);
		await Promise.allSettled(promises);
	}

	async teardownRuntimes(): Promise<void> {
		await Promise.allSettled(this.cleanupHandles.map((fn) => fn()));
	}
}

/**
 * RunDispatcher — extends RetryDispatcher with start() for new executions.
 * FLY-123 WS-D (P4): admission is resource-based (load + memory), not a
 * hardcoded N — uncapped runner count.
 */
export class RunDispatcher extends RetryDispatcher implements IStartDispatcher {
	constructor(
		blueprintsByProject: Map<string, ProjectRuntime>,
		cleanupHandles: Array<() => Promise<void>>,
		runnerAdmission: RunnerAdmissionController = RunnerAdmissionController.alwaysAdmit(),
		/** FLY-245 R1 HIGH-3: durable launch claim (gateway pre-bound retry path). */
		launchClaims?: LaunchClaimStore,
		/** FLY-245 R5: test seam for the commit-record existence check. */
		isCommitted?: (execId: string) => boolean,
		/**
		 * FLY-795: compute restart-resilient resume for a (re-)dispatch. Returns a
		 * ProgressResumeInfo when a prior execution + committed progress.md on
		 * branch B are found, else null. Undefined ⇒ always fresh (byte-compatible).
		 */
		private resumeComputer?: ResumeComputer,
		/** FLY-1185 (R11#1): lifecycle admission seam (see base class). */
		lifecycleAdmission?: LifecycleAdmissionFn,
		/** FLY-1185 (Codex R1#5): launch guard seam (see base class). */
		lifecycleLaunchGuard?: LifecycleLaunchGuard,
		/** FLY-1257 M3: retry branch-tip recovery seam (production: run-infra). */
		phaseRetryStartPointComputer?: PhaseRetryStartPointComputer,
		/** FLY-1356 (R1#4): sticky-stamp lookup (see the base-class field docs). */
		skillFrameworkStampLookup?: (
			issueId: string,
		) => SkillFrameworkMode | undefined,
		tmuxGenerationRecorder?: TmuxGenerationRecorder,
		tmuxWindowAuthority?: TmuxWorkflowWindowAuthority,
		/** FLY-1718 P1: origin continuity check for true fresh starts. */
		private continuityComputer?: ContinuityComputer,
		/** FLY-1718 P1: always-on durable receipt for explicit fresh overrides. */
		private freshStartAudit?: FreshStartAuditRecorder,
		/** FLY-1718 P4: predecessor reconciliation (base fresh + retry seam). */
		doaBackoffAdmission?: DoaBackoffAdmissionFn,
		/** FLY-1775: durable session terminality for process-local inflight repair. */
		inflightSessionTerminal?: InflightSessionTerminalProbe,
	) {
		super(
			blueprintsByProject,
			cleanupHandles,
			launchClaims,
			isCommitted,
			lifecycleAdmission,
			lifecycleLaunchGuard,
			phaseRetryStartPointComputer,
			skillFrameworkStampLookup,
			tmuxGenerationRecorder,
			runnerAdmission,
			tmuxWindowAuthority,
			doaBackoffAdmission,
			inflightSessionTerminal,
		);
	}

	/** FLY-59: Count all inflight entries (each issue+role combo counts separately) */
	getInflightCount(): number {
		this.pruneTerminalInflightEntries();
		return this.inflight.size;
	}

	/**
	 * FLY-137 v1.27.2 (Codex Track A #2): synchronous agentName validation.
	 * Routes through `AgentDispatcher.dispatchByName(name)` which throws
	 * `InvalidAgentNameError` on unknown names. runs-route calls this BEFORE
	 * `start()` so the 400 INVALID_AGENT_NAME response can fire before any
	 * Blueprint.run() promise is kicked off (which would swallow the error).
	 */
	validateAgentName(
		projectName: string,
		agentName: string | undefined,
	):
		| { ok: true }
		| { ok: false; reason: "unknown_agent"; available: string[] }
		| { ok: false; reason: "project_unknown" } {
		if (!agentName) {
			// undefined / null / empty → no override, no validation needed
			return { ok: true };
		}
		const runtime = this.blueprintsByProject.get(projectName);
		if (!runtime) {
			return { ok: false, reason: "project_unknown" };
		}
		try {
			runtime.agentDispatcher.dispatchByName(agentName);
			return { ok: true };
		} catch (err) {
			// AgentDispatcher.dispatchByName throws InvalidAgentNameError on unknown
			if (err instanceof Error && err.name === "InvalidAgentNameError") {
				const e = err as Error & { available?: string[] };
				return {
					ok: false,
					reason: "unknown_agent",
					available: e.available ?? [],
				};
			}
			throw err; // unexpected — rethrow for top-level error handler
		}
	}

	async start(req: StartRequest): Promise<StartResult> {
		this.assertRunnerAdmission();
		if (!this.accepting) {
			throw new Error("RunDispatcher is shutting down");
		}
		assertDesignDispatchContract(req);

		// FLY-123 WS-D (P4): resource-based admission — defer only under real
		// load/memory pressure, never a count cap. Typed error → route maps to
		// 429 with the reason (R1 MED #4), never a 500 string-match miss.
		const role = req.sessionRole ?? "main";
		const key = this.inflightKey(req.issueId, role);

		const inflightEntry = this.currentInflightEntry(key);
		if (
			inflightEntry &&
			req.generalizedExecution &&
			inflightEntry.executionId === req.generalizedExecution.executionId
		) {
			return {
				executionId: inflightEntry.executionId,
				issueId: req.issueId,
				...(inflightEntry.launchOutcome && {
					launchOutcome: inflightEntry.launchOutcome,
				}),
			};
		}
		if (inflightEntry) {
			throw new Error(
				`Run already in progress for issue ${req.issueId} role ${role}`,
			);
		}

		const runtime = this.blueprintsByProject.get(req.projectName);
		if (!runtime) {
			throw new Error(`No runtime for project: ${req.projectName}`);
		}

		// FLY-116: opener moved into BlueprintContext callback below.

		const executionId =
			req.generalizedExecution?.executionId ??
			req.successorExecutionId ??
			randomUUID();

		// Auto-QA owns a separate bounded retry loop. Every other re-dispatch must
		// reconcile its canonical predecessor before branch continuity or network IO.
		if (!req.qaContext) {
			await this.admitDoaBackoff({
				issueKey: req.issueId,
				issueIdentifier: req.issueIdentifier,
				projectName: req.projectName,
				executionId,
				role,
				leadId: req.leadId,
			});
		}

		// FLY-1718 P1: reconcile branch state BEFORE lifecycle admission, CommDB
		// pre-registration, TURN, or worktree mutation. Progress resume remains the
		// richer first choice; only a true fresh start consults origin continuity.
		// A caller-pinned startPoint and Auto-QA already carry explicit head
		// authority and must not be rewritten here.
		if (req.freshStart && (req.startPoint || req.qaContext)) {
			this.abortPreLaunch(key, executionId, req.projectName);
			throw new FreshStartAuditError(
				"freshStart cannot be combined with a caller-pinned or Auto-QA start",
			);
		}
		let computedResume: ProgressResumeInfo | null;
		try {
			computedResume = req.qaContext
				? null
				: ((await this.resumeComputer?.(req.issueId, role, req.projectName)) ??
					null);
		} catch (error) {
			this.abortPreLaunch(key, executionId, req.projectName);
			throw error;
		}
		const resume = req.freshStart ? null : computedResume;
		let continuityInherit: ContinuityInherit | undefined;
		let continuityBranch: string | undefined;
		let skippedOriginTip: string | undefined;
		if (
			!req.startPoint &&
			!req.qaContext &&
			!resume &&
			this.continuityComputer
		) {
			let continuity: ContinuityStartPoint;
			try {
				continuity = await this.continuityComputer({
					issueId: req.issueId,
					role,
					projectName: req.projectName,
					shareParentBranch: req.shareParentBranch,
				});
			} catch (error) {
				this.abortPreLaunch(key, executionId, req.projectName);
				throw error;
			}
			if (continuity.kind === "indeterminate") {
				this.abortPreLaunch(key, executionId, req.projectName);
				throw new ContinuityIndeterminateError(continuity.error);
			}
			continuityBranch = continuity.branch;
			if (continuity.kind === "found") {
				skippedOriginTip = continuity.sha;
				if (!req.freshStart) {
					continuityInherit = {
						branch: continuity.branch,
						sha: continuity.sha,
						...(continuity.prNumber !== undefined && {
							prNumber: continuity.prNumber,
						}),
						...(continuity.prUrl && { prUrl: continuity.prUrl }),
					};
				}
			}
		}
		if (req.freshStart) {
			if (!this.continuityComputer || !continuityBranch) {
				this.abortPreLaunch(key, executionId, req.projectName);
				throw new FreshStartAuditError(
					"managed branch authority is unavailable",
				);
			}
			if (
				!this.freshStartAudit?.({
					executionId,
					projectName: req.projectName,
					issueId: req.issueId,
					role,
					actor: req.freshStart.actor,
					reason: req.freshStart.reason,
					branch: continuityBranch,
					...(skippedOriginTip && { skippedOriginTip }),
				})
			) {
				this.abortPreLaunch(key, executionId, req.projectName);
				throw new FreshStartAuditError("durable audit write failed");
			}
		}
		// FLY-1185 (R11#1): lifecycle admission at the single spawn chokepoint —
		// every surface (HTTP start / phase handoff / auto-QA / rescue) flows
		// through here. Fresh founder-park tombstone check + durable `starting`
		// launch claim inside the issue mutex; throws LifecycleParkedError on
		// refusal (routes map to 409, never a silent respawn of a zeroed issue).
		try {
			await this.admitLifecycle({
				issueKey: req.issueId,
				issueIdentifier: req.issueIdentifier,
				projectName: req.projectName,
				executionId,
				role,
			});
		} catch (error) {
			this.abortPreLaunch(key, executionId, req.projectName);
			throw error;
		}

		const launchOutcome = req.generalizedExecution
			? createLaunchOutcomeDeferred(
					req.generalizedExecution.commitWorkflowLaunch,
				)
			: undefined;
		const entry = {
			executionId,
			promise: null! as Promise<void>,
			...(launchOutcome && { launchOutcome: launchOutcome.promise }),
		};
		this.inflight.set(key, entry);
		try {
			// FLY-142 PR 1.4 + FLY-123: Agent Team identity + executor backend
			// resolution (labels > roles config > env > claude).
			// FLY-643: a QA start passes ignoreRunnerLabelSelection so the parent's
			// vendor labels can't pick the QA backend (issueLabels still flow below
			// for Lead/thread routing).
			// FLY-1188: resolved BEFORE the CommDB pre-registration so the pending
			// row already carries the runner's transport vendor (pure function —
			// no ordering dependency on the TURN grant / resume computation below).
			const runnerSpawn = buildRunnerSpawnFields(
				executionId,
				req.leadId,
				req.issueLabels,
				runtime.rolesConfig,
				req.generalizedExecution ? true : req.ignoreRunnerLabelSelection,
				req.generalizedExecution?.dispatch.model ?? req.dispatchModel, // FLY-728 Part C
				req.requireMailboxTransport, // FLY-752
				req.generalizedExecution?.dispatch.vendor ?? req.dispatchVendor, // FLY-1224/1281
				req.generalizedExecution?.dispatch.effort ?? req.dispatchEffort,
			);
			const modelDisplay = renderRunnerModelDisplay({
				vendor: runnerSpawn.runnerBackend
					? adapterTypeToFamily(runnerSpawn.runnerBackend)
					: undefined,
				model: runnerSpawn.runnerModel,
			});

			// Generalized runs require a durable launch marker for their commit gate.
			const workflowLaunchCommitPath = req.generalizedExecution
				? launchCommitPath(executionId)
				: undefined;
			if (workflowLaunchCommitPath) {
				try {
					mkdirSync(join(workflowLaunchCommitPath, ".."), { recursive: true });
				} catch {
					// best-effort; the adapter also mkdir's defensively
				}
			}
			const launchFingerprint =
				req.generalizedExecution?.launchGeneration !== undefined
					? createHash("sha256")
							.update(
								`${executionId}:${req.generalizedExecution.launchGeneration}:${req.generalizedExecution.launchGateToken ?? ""}`,
							)
							.digest("hex")
					: undefined;

			// FLY-80: Pre-register in CommDB before blueprint starts.
			// FLY-1188: see the retry path — the pending row carries the resolved
			// vendor so a Lead `send` in the pre-self-registration window routes to
			// the right mailbox.
			this.preRegisterCommDb(
				executionId,
				runtime.tmuxSessionName,
				req.projectName,
				req.issueId,
				req.leadId,
				preRegistrationVendor(runnerSpawn),
			);

			// FLY-887: pre-launch TURN grant seam. A DAG workflow SPAWN must have
			// its shared-worktree TURN recorded in CommDB BEFORE the runner's first
			// `turn` self-check — a caller-side grant (after start() returns) would race
			// the launch and leave the runner seeing `no-turn`. This ONE seam covers
			// every spawn path (all route through start()): the fresh Design entry
			// (runs-route), the handoff spawn-fallback, the QA-FAIL spawn-fallback, and
			// the reconcile spawn. Already-alive WAKE targets grant their TURN before the
			// wake instead (orchestrator). Fail-closed: a grant failure fails the
			// dispatch (never launch a phase that cannot establish single-writer
			// ownership). Gated on keep-alive (=0 → the legacy path needs no TURN).
			if (req.shareParentBranch === true && isWorkflowPhaseRole(role)) {
				try {
					const dbPath = defaultGetCommDbPath(req.projectName);
					const db = new CommDB(dbPath);
					try {
						grantPrelaunchWorkflowTurn({
							db,
							issueId: req.issueId,
							projectName: req.projectName,
							executionId,
							phase: role,
							grantedAtMs: Date.now(),
							generalizedExecution: req.generalizedExecution,
						});
					} finally {
						db.close();
					}
				} catch (err) {
					this.abortPreLaunch(key, executionId, req.projectName);
					throw new Error(
						`pre-launch TURN grant failed for ${role} phase on ${req.issueId}: ${(err as Error).message}`,
					);
				}
			}

			const ctx: BlueprintContext = {
				teamName: "eng",
				// FLY-1255: fresh starts use the same phase/model composition as retries.
				runnerName: runnerDisplayName(
					req.sessionRole,
					req.shareParentBranch,
					modelDisplay,
				),
				projectName: req.projectName,
				executionId,
				leadId: req.leadId,
				sessionRole: req.sessionRole,
				...(req.designBackend && { designBackend: req.designBackend }),
				// FLY-1356: explicit per-dispatch arm (529) + auto-QA parent inherit
				// + sticky stamp. The resolver owns precedence and kill semantics.
				...(req.skillFrameworkMode && {
					skillFrameworkModeOverride: req.skillFrameworkMode,
				}),
				...(req.skillFrameworkModeParent && {
					skillFrameworkModeParent: req.skillFrameworkModeParent,
				}),
				...this.skillFrameworkPriorCtx(req.issueId),
				// FLY-793: DAG workflows share one branch B (Bridge-internal).
				// FLY-795: a resume also shares branch B (reuse the same mechanism).
				shareParentBranch: req.shareParentBranch ?? (resume ? true : undefined),
				// FLY-859: Implement-fix round context after a QA FAIL (Bridge-internal).
				phaseFixContext: req.phaseFixContext,
				// FLY-24: Pass pre-fetched metadata so Blueprint/EventEnvelope uses real title
				issueTitle: req.issueTitle,
				issueIdentifier: req.issueIdentifier,
				routeSummary: req.routeSummary,
				// FLY-137 v1.27.2: thread Lead override + dispatch context (runs-route resolves)
				agentName: req.agentName,
				issueLabels: req.issueLabels,
				owningDept: req.owningDept,
				// FLY-615: per-run + per-issue ponytail signal (Blueprint resolves it)
				ponytailInput: req.ponytailInput,
				// FLY-205: doc-flow tier + issue URL (runs-route validates/persists)
				docTier: req.docTier,
				issueUrl: req.issueUrl,
				// FLY-1372 §2.5: Bridge-trusted behavior snapshots for the durable
				// emitStarted seam (pipeline.dag entry / engine successor only).
				codexSkip: req.codexSkip,
				founderFacingUx: req.founderFacingUx,
				// FLY-579: worktree start point (QA pins to parent pr_head_sha) + QA context.
				// FLY-795: a resume pins startPoint = branch B tip so `worktree add -B`
				// rebuilds WITH the committed progress.md (never override a caller's own).
				startPoint:
					req.startPoint ?? resume?.startPoint ?? continuityInherit?.sha,
				...(req.workflowResume && { workflowResume: req.workflowResume }),
				...(continuityInherit && { continuityInherit }),
				qaContext: req.qaContext,
				...(req.generalizedExecution && {
					generalizedExecutionContext: {
						runId: req.generalizedExecution.runId,
						nodeId: req.generalizedExecution.nodeId,
						attempt: req.generalizedExecution.attempt,
						snapshotDigest: req.generalizedExecution.snapshotDigest,
						gateCarrierEpoch: req.generalizedExecution.gateCarrierEpoch,
					},
					workflowCapabilities: req.generalizedExecution.capabilities,
					workflowAgentContent: req.generalizedExecution.agentContent,
					workflowOutputCredential: req.generalizedExecution.outputCredential,
					workflowSubmissionCredential:
						req.generalizedExecution.submissionCredential,
					workflowSubmissionExpected: true,
				}),
				launchCommitPath: workflowLaunchCommitPath,
				launchGateToken: req.generalizedExecution?.launchGateToken,
				launchGeneration: req.generalizedExecution?.launchGeneration,
				launchFingerprint,
				workflowTmuxWindowAuthority: (candidate) =>
					this.tmuxWindowAuthority?.(executionId, candidate) ?? "keep",
				commitWorkflowLaunch:
					launchOutcome?.commit ??
					req.generalizedExecution?.commitWorkflowLaunch,
				prepareWorkflowIssueDelivery:
					req.generalizedExecution?.prepareWorkflowIssueDelivery,
				...(runnerSpawn.runnerBackend === "claude-tmux" &&
					this.tmuxGenerationRecorder && {
						onTmuxWindowOpened: (info) =>
							this.tmuxGenerationRecorder?.(executionId, info),
					}),
				// FLY-795: restart-resilient resume context (Blueprint renders resume mode).
				...(resume && {
					progressResume: {
						progressPath: resume.progressPath,
						priorExecutionId: resume.priorExecutionId,
						resumeKind: resume.resumeKind,
						...(resume.effectiveStage && {
							effectiveStage: resume.effectiveStage,
						}),
					},
				}),
				...runnerSpawn,
				// FLY-751: per-runner MCP slim profile — claude-tmux only, gated on
				// the FINAL resolved backend (runnerSpawn.runnerBackend reflects the
				// FLY-752 mailbox-forcing rewrite, not the raw label/role pick); QA
				// keeps the browser (sessionRole="qa"); full-mcp label / env
				// kill-switch resolve to null inside (→ byte-compatible spawn).
				...(runnerSpawn.runnerBackend === "claude-tmux" && {
					runnerMcpProfile: resolveRunnerMcpProfile({
						sessionRole: req.sessionRole,
						issueLabels: req.issueLabels,
					}),
				}),
				// FLY-116: spawn macOS Terminal viewer once tmux window exists
				onTmuxWindowCreated: ({ baseSessionName, windowId }) => {
					openTmuxViewer({
						baseSessionName,
						windowId,
						executionId,
						projectName: req.projectName,
						sessionRole: req.sessionRole,
					});
				},
			};

			// FLY-1185 (Codex R1#5 + R4#1): LAST pre-launch admission recheck — a
			// founder park that ran between admission and here CASed our claim
			// starting→cancelled; the spawn must abort instead of launching a
			// runner on a zeroed issue. VERIFY-only: the claim stays `starting`
			// until emitStarted persists the session row (plan.md:145).
			if (this.lifecycleLaunchGuard) {
				const commit =
					await this.lifecycleLaunchGuard.commitLaunch(executionId);
				if (!commit.ok) {
					this.abortPreLaunch(key, executionId, req.projectName, false);
					throw new LifecycleParkedError(
						commit.reason ?? "cancelled_between_admission_and_launch",
					);
				}
			}

			entry.promise = runtime.blueprint
				.run({ id: req.issueId, blockedBy: [] }, runtime.projectRoot, ctx)
				.then((result) => {
					// A failed launchOutcome wakes the workflow engine. Clear first so
					// that wake cannot race finally() and poison the retry with itself.
					if (!result.success) this.clearInflightEntry(key, entry);
					launchOutcome?.observeResult(result);
					if (result.worktreePath) {
						console.log(
							`[RunDispatcher] ${executionId} ran in worktree: ${result.worktreePath}`,
						);
					}
					if (result.success) {
						// (R4#1: the claim advanced starting→active at emitStarted, once
						// the session row was durable — not at the pre-run verify.)
						console.log(
							`[RunDispatcher] ${executionId} completed for issue ${req.issueId}`,
						);
					} else {
						try {
							this.lifecycleLaunchGuard?.onSpawnFailed(executionId);
						} catch {
							/* guard must never break the launch pipeline */
						}
						console.warn(
							`[RunDispatcher] ${executionId} resolved with failure for issue ${req.issueId}: ${result.error ?? "unknown"}`,
						);
						// FLY-95: Clean up orphan pre-registration when Runner never self-registered
						if (!result.sessionId) {
							this.cleanupPreRegistration(executionId, req.projectName);
						}
					}
				})
				.catch((err: unknown) => {
					this.clearInflightEntry(key, entry);
					launchOutcome?.observeError(err);
					console.error(
						`[RunDispatcher] ${executionId} failed:`,
						err instanceof Error ? err.message : err,
					);
					// R4#1: symmetric claim cleanup on thrown spawn failure.
					try {
						this.lifecycleLaunchGuard?.onSpawnFailed(executionId);
					} catch {
						/* guard must never break the launch pipeline */
					}
					// FLY-80: Clean up orphan pre-registration on failed start
					this.cleanupPreRegistration(executionId, req.projectName);
				})
				.finally(() => {
					this.clearInflightEntry(key, entry);
				});

			return {
				executionId,
				issueId: req.issueId,
				...(launchOutcome && { launchOutcome: launchOutcome.promise }),
			};
		} catch (err) {
			if (this.inflight.get(key) === entry) {
				this.abortPreLaunch(
					key,
					executionId,
					req.projectName,
					!(err instanceof LifecycleParkedError),
				);
			}
			throw err;
		}
	}
}
