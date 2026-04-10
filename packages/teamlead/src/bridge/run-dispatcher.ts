/**
 * FLY-22: RunDispatcher — IStartDispatcher + IRetryDispatcher implementation.
 *
 * Moved from scripts/lib/retry-dispatcher.ts into the package so that
 * startBridge can create it internally (fixes /api/runs 404 when Bridge
 * is started via index.ts instead of scripts/run-bridge.ts).
 */

import { randomUUID } from "node:crypto";
import { CommDB } from "flywheel-comm/db";
import { openTmuxViewer } from "flywheel-core";
import type {
	Blueprint,
	BlueprintContext,
} from "flywheel-edge-worker/dist/Blueprint.js";
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
		return `${issueId}:${role}`;
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

		openTmuxViewer(runtime.tmuxSessionName);

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
			retryContext: {
				predecessorExecutionId: req.oldExecutionId,
				previousError: req.previousError,
				previousDecisionRoute: req.previousDecisionRoute,
				previousReasoning: req.previousReasoning,
				attempt: req.runAttempt,
				reason: req.reason,
			},
		};

		entry.promise = runtime.blueprint
			.run({ id: req.issueId, blockedBy: [] }, runtime.projectRoot, ctx)
			.then(() => {
				console.log(
					`[RetryDispatcher] ${newExecutionId} completed for issue ${req.issueIdentifier ?? req.issueId}`,
				);
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

		openTmuxViewer(runtime.tmuxSessionName);

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
		};

		entry.promise = runtime.blueprint
			.run({ id: req.issueId, blockedBy: [] }, runtime.projectRoot, ctx)
			.then(() => {
				console.log(
					`[RunDispatcher] ${executionId} completed for issue ${req.issueId}`,
				);
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
