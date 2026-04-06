/**
 * FLY-22: RunDispatcher — IStartDispatcher + IRetryDispatcher implementation.
 *
 * Moved from scripts/lib/retry-dispatcher.ts into the package so that
 * startBridge can create it internally (fixes /api/runs 404 when Bridge
 * is started via index.ts instead of scripts/run-bridge.ts).
 */

import { randomUUID } from "node:crypto";
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

	async dispatch(req: RetryRequest): Promise<RetryResult> {
		if (!this.accepting) {
			throw new Error("RetryDispatcher is shutting down");
		}

		if (this.inflight.has(req.issueId)) {
			throw new Error(`Retry already in progress for issue ${req.issueId}`);
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
		this.inflight.set(req.issueId, entry);

		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "claude",
			projectName: req.projectName,
			executionId: newExecutionId,
			leadId: req.leadId,
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
			})
			.finally(() => {
				this.inflight.delete(req.issueId);
			});

		return { newExecutionId, oldExecutionId: req.oldExecutionId };
	}

	getInflightIssues(): Set<string> {
		return new Set(this.inflight.keys());
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

	getInflightCount(): number {
		return this.getInflightIssues().size;
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

		if (this.inflight.has(req.issueId)) {
			throw new Error(`Run already in progress for issue ${req.issueId}`);
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
		this.inflight.set(req.issueId, entry);

		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "claude",
			projectName: req.projectName,
			executionId,
			leadId: req.leadId,
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
			})
			.finally(() => {
				this.inflight.delete(req.issueId);
			});

		return { executionId, issueId: req.issueId };
	}
}
