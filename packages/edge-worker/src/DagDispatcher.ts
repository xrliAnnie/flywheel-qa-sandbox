import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { FLYWHEEL_MARKER_DIR } from "flywheel-core";
import { Semaphore } from "flywheel-core";
import { DagResolver } from "flywheel-dag-resolver";
import type { DagNode } from "flywheel-dag-resolver";
import type {
	Blueprint,
	BlueprintContext,
	BlueprintResult,
} from "./Blueprint.js";
import type { WorktreeManager } from "./WorktreeManager.js";

/** Result of a full DAG dispatch run */
export interface DispatchResult {
	completed: string[];
	shelved: string[];
	halted: boolean;
	// v0.2 Step 3 — optional parallel execution stats
	durationMs?: number;
	nodeResults?: Record<string, BlueprintResult>;
}

/** Callback for dispatch progress events */
export type OnNodeComplete = (
	nodeId: string,
	result: BlueprintResult,
) => Promise<void>;

/**
 * DagDispatcher: loops through ready nodes from DAG resolver,
 * executes Blueprint for each, marks done or shelves.
 *
 * Supports parallel execution via Semaphore (default: serial with Semaphore(1)).
 * Error isolation: one node failure shelves only that node + downstream,
 * other independent branches continue.
 */
export class DagDispatcher {
	/** Callback for per-node completion events */
	onNodeComplete?: OnNodeComplete;

	constructor(
		private resolver: DagResolver,
		private blueprint: Blueprint,
		private projectRoot: string,
		private buildContext: (node: DagNode) => BlueprintContext,
		private semaphore: Semaphore = new Semaphore(1),
		private tmuxSessionName: string = "flywheel",
		private worktreeManager?: WorktreeManager,
		private projectName?: string,
	) {}

	async dispatch(): Promise<DispatchResult> {
		const startTime = Date.now();
		const completed: string[] = [];
		const shelved: string[] = [];
		const scheduled = new Set<string>();
		const inflight = new Map<string, Promise<void>>();
		const nodeResults: Record<string, BlueprintResult> = {};

		// Pre-dispatch worktree cleanup
		await this.pruneOrphansQuiet();

		mkdirSync(FLYWHEEL_MARKER_DIR, { recursive: true });
		this.openTmuxViewer();

		try {
			while (this.resolver.remaining() > 0) {
				const ready = this.resolver.getReady()
					.filter(n => !scheduled.has(n.id));

				if (ready.length === 0 && inflight.size > 0) {
					// Wait for at least one in-flight to complete
					await Promise.race(inflight.values());
					continue;
				}

				if (ready.length === 0) break;

				for (const node of ready) {
					scheduled.add(node.id);
					const ctx = { ...this.buildContext(node), executionId: randomUUID() };
					const p = this.dispatchOne(node, ctx, completed, shelved, nodeResults)
						.finally(() => inflight.delete(node.id));
					inflight.set(node.id, p);
				}

				// Wait for any to complete — may unlock new downstream nodes
				if (inflight.size > 0) {
					await Promise.race(inflight.values());
				}
			}

			// Wait for all remaining in-flight
			if (inflight.size > 0) {
				await Promise.allSettled(inflight.values());
			}
		} finally {
			this.cleanupMarkerDir();
			// Post-dispatch worktree cleanup
			await this.pruneOrphansQuiet();
		}

		return {
			completed,
			shelved,
			halted: shelved.length > 0,
			durationMs: Date.now() - startTime,
			nodeResults,
		};
	}

	private async dispatchOne(
		node: DagNode,
		ctx: BlueprintContext,
		completed: string[],
		shelved: string[],
		nodeResults: Record<string, BlueprintResult>,
	): Promise<void> {
		await this.semaphore.acquire();

		let result: BlueprintResult;
		try {
			result = await this.blueprint.run(node, this.projectRoot, ctx);

			if (result.success) {
				this.resolver.markDone(node.id);
				completed.push(node.id);
			} else {
				this.resolver.shelve(node.id);
				shelved.push(node.id);
			}

			nodeResults[node.id] = result;
		} catch (err) {
			result = {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
			this.resolver.shelve(node.id);
			shelved.push(node.id);
			nodeResults[node.id] = result;
		} finally {
			this.semaphore.release();
		}

		// Callback AFTER release — fire-and-forget, NOT part of dispatchOne's promise.
		// Uses .then() chain to safely capture both sync throws and async rejections.
		if (this.onNodeComplete) {
			const nodeId = node.id;
			void Promise.resolve()
				.then(() => this.onNodeComplete!(nodeId, result))
				.catch(callbackErr => {
					console.warn(
						`[DagDispatcher] onNodeComplete error for ${nodeId} (non-fatal): ${
							callbackErr instanceof Error ? callbackErr.message : String(callbackErr)
						}`,
					);
				});
		}
	}

	private async pruneOrphansQuiet(): Promise<void> {
		if (!this.worktreeManager || !this.projectName) return;
		try {
			const pruned = await this.worktreeManager.pruneOrphans(
				this.projectRoot, this.projectName,
			);
			if (pruned.length > 0) {
				console.log(`[DagDispatcher] Pruned ${pruned.length} orphan worktrees`);
			}
		} catch (err) {
			console.warn(`[DagDispatcher] pruneOrphans failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`);
		}
	}

	/**
	 * Open a Terminal window attached to the tmux session.
	 * Best-effort — failure is non-fatal (user can always attach manually).
	 */
	private openTmuxViewer(): void {
		const s = this.tmuxSessionName;
		execFile("osascript", [
			"-e",
			`tell application "Terminal" to do script "tmux attach -t '=${s}' 2>/dev/null || (echo 'Waiting for tmux session ${s}...' && sleep 2 && tmux attach -t '=${s}')"`,
		], (err) => {
			if (err) {
				console.warn(
					`[DagDispatcher] Could not auto-open tmux viewer: ${err.message}`,
				);
			}
		});
	}

	private cleanupMarkerDir(): void {
		try {
			if (existsSync(FLYWHEEL_MARKER_DIR)) {
				rmSync(FLYWHEEL_MARKER_DIR, { recursive: true, force: true });
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[DagDispatcher] Failed to clean up marker dir ${FLYWHEEL_MARKER_DIR}: ${msg}`,
			);
		}
	}
}
