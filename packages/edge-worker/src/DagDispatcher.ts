import { existsSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { FLYWHEEL_MARKER_DIR } from "flywheel-core";
import { DagResolver } from "flywheel-dag-resolver";
import type { DagNode } from "flywheel-dag-resolver";
import type {
	Blueprint,
	BlueprintContext,
	BlueprintResult,
} from "./Blueprint.js";

/** Result of a full DAG dispatch run */
export interface DispatchResult {
	completed: string[];
	shelved: string[];
	halted: boolean;
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
 * Phase 1: sequential execution (one node at a time).
 * Halts on first failure to prevent shared-repo conflicts.
 */
export class DagDispatcher {
	/** Callback for per-node completion events */
	onNodeComplete?: OnNodeComplete;

	constructor(
		private resolver: DagResolver,
		private blueprint: Blueprint,
		private projectRoot: string,
		private buildContext: (node: DagNode) => BlueprintContext,
		private tmuxSessionName: string = "flywheel",
	) {}

	async dispatch(): Promise<DispatchResult> {
		const completed: string[] = [];
		const shelved: string[] = [];
		let halted = false;

		// Create marker directory for SessionEnd hook
		mkdirSync(FLYWHEEL_MARKER_DIR, { recursive: true });

		// Auto-open a Terminal window attached to the tmux session
		// so the user can watch Claude Code work in real time
		this.openTmuxViewer();

		try {
			while (this.resolver.remaining() > 0) {
				const ready = this.resolver.getReady();
				if (ready.length === 0) {
					break;
				}

				const node = ready[0]!;
				const ctx = this.buildContext(node);
				const result = await this.blueprint.run(
					node,
					this.projectRoot,
					ctx,
				);

				if (result.success) {
					this.resolver.markDone(node.id);
					completed.push(node.id);
				} else {
					this.resolver.shelve(node.id);
					shelved.push(node.id);
					halted = true;
				}

				if (this.onNodeComplete) {
					await this.onNodeComplete(node.id, result);
				}

				// Halt on first failure
				if (halted) break;
			}
		} finally {
			// Clean up marker directory
			this.cleanupMarkerDir();
		}

		return { completed, shelved, halted };
	}

	/**
	 * Open a Terminal window attached to the tmux session.
	 * Best-effort — failure is non-fatal (user can always attach manually).
	 */
	private openTmuxViewer(): void {
		const s = this.tmuxSessionName;
		// macOS: open a new Terminal.app window that attaches to the tmux session
		// Use exact-match "=" prefix to prevent tmux prefix matching
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
