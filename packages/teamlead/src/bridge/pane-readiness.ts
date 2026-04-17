/**
 * FLY-109 — Bridge pane readiness hardening.
 *
 * Polls a tmux pane for a marker substring ("Listening for channel messages from:")
 * that Claude prints once it has both connected to the flywheel-inbox MCP server
 * AND registered the `notifications/claude/channel` handler. If the marker is not
 * observed within the timeout, we downgrade to lease-only readiness instead of
 * blocking registration — correctness is owned by the ack/retry state machine in
 * inbox-mcp (see plan §3.0).
 *
 * This module is only called from createLeadRuntime (Bridge startup / late-register).
 * It is NOT wired into the Lead restart path — per §3.0 RuntimeRegistry is durable,
 * so createLeadRuntime does not re-run on Lead resume, and push delivery through the
 * ack/retry window handles that scenario.
 */
import { execFileSync } from "node:child_process";

export interface PaneReadinessResult {
	seen: boolean;
	elapsedMs: number;
}

export interface PaneReadinessOptions {
	/**
	 * Pane capture function. Defaults to `tmux capture-pane -pt <windowId>`. Injected
	 * in tests so we can drive the polling loop deterministically without a real tmux.
	 */
	captureFn?: (windowId: string) => string;
	pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 250;

function defaultCapture(windowId: string): string {
	// execFileSync (not exec) — no shell, windowId is passed as a single argv element
	// so tmux metacharacters in the ID cannot escape into the shell.
	return execFileSync("tmux", ["capture-pane", "-pt", windowId], {
		encoding: "utf8",
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Wait for `marker` to appear in the tmux pane output for `windowId`.
 *
 * Non-throwing: capture errors (e.g., window not yet created) are treated as
 * "not seen yet" so transient races during Claude boot don't kill the poll loop.
 * Timeout also non-throwing — returns `{seen: false}` so the caller can proceed
 * with lease-only readiness (ack/retry recovers any dropped pushes).
 */
export async function waitForPaneMarker(
	windowId: string,
	marker: string,
	timeoutMs: number,
	opts: PaneReadinessOptions = {},
): Promise<PaneReadinessResult> {
	const capture = opts.captureFn ?? defaultCapture;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const start = Date.now();

	while (true) {
		let snapshot = "";
		try {
			snapshot = capture(windowId);
		} catch {
			// Transient — window may not exist yet, or tmux may be momentarily busy.
			// Treat as "not yet seen" and keep polling until the deadline.
		}

		if (snapshot.includes(marker)) {
			return { seen: true, elapsedMs: Date.now() - start };
		}

		const elapsed = Date.now() - start;
		if (elapsed >= timeoutMs) {
			return { seen: false, elapsedMs: elapsed };
		}

		await sleep(pollIntervalMs);
	}
}
