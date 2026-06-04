/**
 * FLY-22: RunDispatcher — IStartDispatcher + IRetryDispatcher implementation.
 *
 * Moved from scripts/lib/retry-dispatcher.ts into the package so that
 * startBridge can create it internally (fixes /api/runs 404 when Bridge
 * is started via index.ts instead of scripts/run-bridge.ts).
 */

import { randomUUID } from "node:crypto";
import { deriveRunnerMailboxIdentity } from "flywheel-agent-team-transport";
import { CommDB } from "flywheel-comm/db";
import { openTmuxViewer } from "flywheel-core";
import type { AgentDispatcher } from "flywheel-edge-worker";
import type {
	Blueprint,
	BlueprintContext,
} from "flywheel-edge-worker/dist/Blueprint.js";
import { resolveCommBackend } from "./plugin.js";
import type {
	IRetryDispatcher,
	IStartDispatcher,
	RetryRequest,
	RetryResult,
	StartRequest,
	StartResult,
} from "./retry-dispatcher.js";
import { defaultGetCommDbPath } from "./session-capture.js";

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
function buildAgentTeamIdentity(
	executionId: string,
	leadId: string | undefined,
): Pick<BlueprintContext, "runnerAgentName" | "agentTeamName" | "vendor"> {
	// FLY-142 PR #186 Codex Round 1 MEDIUM: share the single
	// `resolveCommBackend` parser with `plugin.ts:createLeadRuntime` so
	// unknown / typo'd env values fall back to mailbox consistently across
	// the Bridge runtime selection AND Runner spawn identity. Previously
	// run-dispatcher used a strict `!== "mailbox"` check while plugin.ts
	// was lenient (typo → fallback to mailbox), so a typo silently broke
	// the Runner side while the Bridge side carried on writing mailbox.
	if (resolveCommBackend() !== "mailbox") {
		// Rollback path — CommDB hook flow, no Agent Team identity needed.
		return {};
	}
	if (!leadId) {
		// No Lead → no Agent Team to join. Runner spawns without transport
		// wiring (same as pre-FLY-142). This shouldn't happen on the
		// production path (req.leadId is required when dispatched from
		// LeadEventRouter), but guard anyway.
		return {};
	}
	// FLY-168: share the single identity derivation with `flywheel-comm send`
	// mailbox dual-write so the spawn side and the send side can never diverge.
	const { agentName, teamName } = deriveRunnerMailboxIdentity(
		executionId,
		leadId,
	);
	return {
		runnerAgentName: agentName,
		agentTeamName: teamName,
		vendor: "claude-code",
	};
}

export class RetryDispatcher implements IRetryDispatcher {
	protected inflight = new Map<
		string,
		{ executionId: string; promise: Promise<void> }
	>();
	protected accepting = true;

	constructor(
		protected blueprintsByProject: Map<string, ProjectRuntime>,
		private cleanupHandles: Array<() => Promise<void>>,
	) {}

	/** FLY-59: Composite inflight key for per-role dedup */
	protected inflightKey(issueId: string, role: string): string {
		// FLY-95: Normalize role to match Blueprint worktree naming —
		// prevents "qa", "QA", "q/a" from being treated as different lanes
		// while mapping to the same worktree on disk.
		const normalized =
			role.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() || "main";
		return `${issueId}:${normalized}`;
	}

	async dispatch(req: RetryRequest): Promise<RetryResult> {
		if (!this.accepting) {
			throw new Error("RetryDispatcher is shutting down");
		}

		const role = req.sessionRole ?? "main";
		const key = this.inflightKey(req.issueId, role);

		if (this.inflight.has(key)) {
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

		const newExecutionId = randomUUID();
		const entry = {
			executionId: newExecutionId,
			promise: null! as Promise<void>,
		};
		this.inflight.set(key, entry);

		// FLY-80: Pre-register in CommDB before blueprint starts
		this.preRegisterCommDb(
			newExecutionId,
			runtime.tmuxSessionName,
			req.projectName,
			req.issueId,
			req.leadId,
		);

		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "claude",
			projectName: req.projectName,
			executionId: newExecutionId,
			leadId: req.leadId,
			sessionRole: req.sessionRole,
			// Forward pre-fetched metadata so EventEnvelope retains title/identifier
			issueTitle: req.issueTitle,
			issueIdentifier: req.issueIdentifier,
			// FLY-137 v1.27.2: thread Lead override + dispatch context
			agentName: req.agentName,
			issueLabels: req.issueLabels,
			owningDept: req.owningDept,
			// FLY-205: predecessor's tier + URL — retry NEVER re-defaults the tier
			docTier: req.docTier,
			issueUrl: req.issueUrl,
			// FLY-142 PR 1.4: Agent Team identity so Runner spawn flips
			// claude-code into teammate mode and `useInboxPoller` reads
			// MailboxLeadRuntime's writes. No-op on rollback path.
			// Uses runnerAgentName/agentTeamName/vendor — distinct from
			// FLY-137's agentName (dispatcher key) above.
			...buildAgentTeamIdentity(newExecutionId, req.leadId),
			retryContext: {
				predecessorExecutionId: req.oldExecutionId,
				previousError: req.previousError,
				previousDecisionRoute: req.previousDecisionRoute,
				previousReasoning: req.previousReasoning,
				attempt: req.runAttempt,
				reason: req.reason,
			},
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

		entry.promise = runtime.blueprint
			.run({ id: req.issueId, blockedBy: [] }, runtime.projectRoot, ctx)
			.then((result) => {
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
				console.error(
					`[RetryDispatcher] ${newExecutionId} failed:`,
					err instanceof Error ? err.message : err,
				);
				// FLY-80: Clean up orphan pre-registration on failed start
				this.cleanupPreRegistration(newExecutionId, req.projectName);
			})
			.finally(() => {
				this.inflight.delete(key);
			});

		return { newExecutionId, oldExecutionId: req.oldExecutionId };
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

	/** FLY-59: Returns unique issueIds from composite keys (backward compat) */
	getInflightIssues(): Set<string> {
		const issueIds = new Set<string>();
		for (const key of this.inflight.keys()) {
			const issueId = key.split(":")[0];
			if (issueId) issueIds.add(issueId);
		}
		return issueIds;
	}

	/** FLY-59: Check if a specific issue+role combo is currently inflight */
	hasInflightForRole(issueId: string, role: string): boolean {
		return this.inflight.has(this.inflightKey(issueId, role));
	}

	stopAccepting(): void {
		this.accepting = false;
	}

	async drain(): Promise<void> {
		const promises = [...this.inflight.values()].map((v) => v.promise);
		await Promise.allSettled(promises);
	}

	async teardownRuntimes(): Promise<void> {
		await Promise.allSettled(this.cleanupHandles.map((fn) => fn()));
	}
}

/**
 * RunDispatcher — extends RetryDispatcher with start() for new executions.
 * Adds maxConcurrentRunners concurrency control.
 */
export class RunDispatcher extends RetryDispatcher implements IStartDispatcher {
	constructor(
		blueprintsByProject: Map<string, ProjectRuntime>,
		cleanupHandles: Array<() => Promise<void>>,
		private maxConcurrentRunners: number = 3,
	) {
		super(blueprintsByProject, cleanupHandles);
	}

	/** FLY-59: Count all inflight entries (each issue+role combo counts separately) */
	getInflightCount(): number {
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
		if (!this.accepting) {
			throw new Error("RunDispatcher is shutting down");
		}

		if (this.getInflightCount() >= this.maxConcurrentRunners) {
			throw new Error(
				`Max concurrent runners reached (${this.maxConcurrentRunners}). Currently inflight: ${this.getInflightCount()}`,
			);
		}

		const role = req.sessionRole ?? "main";
		const key = this.inflightKey(req.issueId, role);

		if (this.inflight.has(key)) {
			throw new Error(
				`Run already in progress for issue ${req.issueId} role ${role}`,
			);
		}

		const runtime = this.blueprintsByProject.get(req.projectName);
		if (!runtime) {
			throw new Error(`No runtime for project: ${req.projectName}`);
		}

		// FLY-116: opener moved into BlueprintContext callback below.

		const executionId = randomUUID();
		const entry = {
			executionId,
			promise: null! as Promise<void>,
		};
		this.inflight.set(key, entry);

		// FLY-80: Pre-register in CommDB before blueprint starts
		this.preRegisterCommDb(
			executionId,
			runtime.tmuxSessionName,
			req.projectName,
			req.issueId,
			req.leadId,
		);

		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "claude",
			projectName: req.projectName,
			executionId,
			leadId: req.leadId,
			sessionRole: req.sessionRole,
			// FLY-24: Pass pre-fetched metadata so Blueprint/EventEnvelope uses real title
			issueTitle: req.issueTitle,
			issueIdentifier: req.issueIdentifier,
			// FLY-137 v1.27.2: thread Lead override + dispatch context (runs-route resolves)
			agentName: req.agentName,
			issueLabels: req.issueLabels,
			owningDept: req.owningDept,
			// FLY-205: doc-flow tier + issue URL (runs-route validates/persists)
			docTier: req.docTier,
			issueUrl: req.issueUrl,
			// FLY-142 PR 1.4: same as start() path — wire Agent Team identity
			// so Runner reads Lead's mailbox via stock useInboxPoller.
			...buildAgentTeamIdentity(executionId, req.leadId),
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

		entry.promise = runtime.blueprint
			.run({ id: req.issueId, blockedBy: [] }, runtime.projectRoot, ctx)
			.then((result) => {
				if (result.worktreePath) {
					console.log(
						`[RunDispatcher] ${executionId} ran in worktree: ${result.worktreePath}`,
					);
				}
				if (result.success) {
					console.log(
						`[RunDispatcher] ${executionId} completed for issue ${req.issueId}`,
					);
				} else {
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
				console.error(
					`[RunDispatcher] ${executionId} failed:`,
					err instanceof Error ? err.message : err,
				);
				// FLY-80: Clean up orphan pre-registration on failed start
				this.cleanupPreRegistration(executionId, req.projectName);
			})
			.finally(() => {
				this.inflight.delete(key);
			});

		return { executionId, issueId: req.issueId };
	}
}
