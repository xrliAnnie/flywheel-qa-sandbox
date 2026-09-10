/**
 * FLY-1185 §2.5 — reap-only runner teardown primitive.
 *
 * `reapRunnerMcp(tmuxWindow)` resolves the pane pid of a STILL-ALIVE tmux
 * window and reaps its MCP-family descendant processes. It deliberately
 * does NOT touch the cmux linked session, the tmux window, or the terminal
 * view — every one of the six call sites (post-merge / close-runner /
 * crash-reaper / actions retry / plugin close-tmux / stale-blocker-guard)
 * keeps its OWN battle-tested kill sequence unchanged (plan non-goal:
 * "不动各 call site 的 cmux 失败序列"); this primitive is inserted strictly
 * BEFORE their kills, while the pane pid is still resolvable.
 *
 * Never throws; a failure is an audit line, not a blocked teardown.
 */

import { execFile } from "node:child_process";
import {
	type McpReapDeps,
	type McpReapResult,
	reapMcpDescendants,
} from "./mcp-descendant-reaper.js";

export interface PaneIdentity {
	pid: number;
	socketPath: string;
}

export type PanePidResolver = (
	tmuxWindow: string,
) => Promise<PaneIdentity | undefined>;

export async function defaultResolvePanePid(
	tmuxWindow: string,
): Promise<PaneIdentity | undefined> {
	return new Promise((resolve) => {
		execFile(
			"tmux",
			["display", "-p", "-t", tmuxWindow, "#{pane_pid}\t#{socket_path}"],
			{ timeout: 10_000 },
			(err, stdout) => {
				if (err) {
					resolve(undefined);
					return;
				}
				const [rawPid, socketPath] = stdout.trim().split("\t");
				const pid = Number(rawPid);
				resolve(
					Number.isInteger(pid) && pid > 0 && socketPath
						? { pid, socketPath }
						: undefined,
				);
			},
		);
	});
}

export interface ReapRunnerMcpDeps extends McpReapDeps {
	resolvePanePid?: PanePidResolver;
}

export interface ReapRunnerMcpResult extends McpReapResult {
	panePid?: number;
	skippedReason?: "no_pane_pid";
}

/**
 * Reap MCP descendants of the runner window's pane. Call BEFORE any kill of
 * that window. A missing/unresolvable pane pid is a silent skip (the window
 * is already gone — the periodic orphan reap is the backstop).
 */
export async function reapRunnerMcp(
	tmuxWindow: string,
	deps: ReapRunnerMcpDeps = {},
): Promise<ReapRunnerMcpResult> {
	try {
		if (tmuxWindow.endsWith(":pending")) {
			return {
				matched: 0,
				terminated: 0,
				killSent: 0,
				confirmedGone: 0,
				survivors: 0,
				identityMismatchSkipped: 0,
				classifierBlocked: 0,
				probeUnknown: 0,
				skippedReason: "no_pane_pid",
			};
		}
		const resolvePanePid = deps.resolvePanePid ?? defaultResolvePanePid;
		const pane = await resolvePanePid(tmuxWindow);
		if (!pane) {
			return {
				matched: 0,
				terminated: 0,
				killSent: 0,
				confirmedGone: 0,
				survivors: 0,
				identityMismatchSkipped: 0,
				classifierBlocked: 0,
				probeUnknown: 0,
				skippedReason: "no_pane_pid",
			};
		}
		const res = await reapMcpDescendants(pane.pid, {
			...deps,
			boundary: { tmuxSocketPath: pane.socketPath },
		});
		return { ...res, panePid: pane.pid };
	} catch (err) {
		deps.audit?.("runner_mcp_reap_failed", {
			tmuxWindow,
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			matched: 0,
			terminated: 0,
			killSent: 0,
			confirmedGone: 0,
			survivors: 0,
			identityMismatchSkipped: 0,
			classifierBlocked: 0,
			probeUnknown: 1,
			incompleteReason: "process_probe_unknown",
		};
	}
}
