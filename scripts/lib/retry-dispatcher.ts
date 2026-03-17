/**
 * GEO-168: RetryDispatcher implementation — dispatches Blueprint re-execution
 * for retry actions. Single-flight per issue (Node.js single-threaded guard).
 */

import { randomUUID } from "node:crypto";
import type { IRetryDispatcher, RetryRequest, RetryResult } from "../../packages/teamlead/dist/bridge/retry-dispatcher.js";
import type { Blueprint, BlueprintContext } from "../../packages/edge-worker/dist/Blueprint.js";

interface ProjectRuntime {
	blueprint: Blueprint;
	projectRoot: string;
}

export class RetryDispatcher implements IRetryDispatcher {
	private inflight = new Map<string, { executionId: string; promise: Promise<void> }>();
	private accepting = true;

	constructor(
		private blueprintsByProject: Map<string, ProjectRuntime>,
		private cleanupHandles: Array<() => Promise<void>>,
	) {}

	async dispatch(req: RetryRequest): Promise<RetryResult> {
		if (!this.accepting) {
			throw new Error("RetryDispatcher is shutting down");
		}

		// Single-flight guard (synchronous — Node.js single-threaded)
		if (this.inflight.has(req.issueId)) {
			throw new Error(`Retry already in progress for issue ${req.issueId}`);
		}

		const runtime = this.blueprintsByProject.get(req.projectName);
		if (!runtime) {
			throw new Error(`No runtime for project: ${req.projectName}`);
		}

		const newExecutionId = randomUUID();

		// Reserve the slot before any async work
		const entry = { executionId: newExecutionId, promise: null! as Promise<void> };
		this.inflight.set(req.issueId, entry);

		const ctx: BlueprintContext = {
			teamName: "eng",
			runnerName: "claude",
			projectName: req.projectName,
			executionId: newExecutionId,
			retryContext: {
				predecessorExecutionId: req.oldExecutionId,
				previousError: req.previousError,
				previousDecisionRoute: req.previousDecisionRoute,
				previousReasoning: req.previousReasoning,
				attempt: req.runAttempt,
				reason: req.reason,
			},
		};

		// Fire-and-forget — Blueprint.run() is long-running
		entry.promise = runtime.blueprint
			.run(
				{ id: req.issueId, blockedBy: [] },
				runtime.projectRoot,
				ctx,
			)
			.then(() => {
				console.log(`[RetryDispatcher] ${newExecutionId} completed for issue ${req.issueIdentifier ?? req.issueId}`);
			})
			.catch((err) => {
				console.error(`[RetryDispatcher] ${newExecutionId} failed:`, err instanceof Error ? err.message : err);
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
