import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
	FlywheelRunRequest,
	FlywheelRunResult,
	IFlywheelRunner,
} from "flywheel-core";
import { FLYWHEEL_MARKER_DIR } from "flywheel-core";

export type ExecFileFn = (
	cmd: string,
	args: string[],
) => { stdout: string };

/**
 * TmuxRunner — launches Claude Code in an interactive tmux window.
 *
 * Dual-path completion detection:
 * - Primary: SessionEnd hook writes marker file → fs.watch() resolves
 * - Fallback: pane_dead polling (works even if hooks are disabled)
 */
export class TmuxRunner implements IFlywheelRunner {
	readonly name = "claude-tmux";
	private preflightDone = false;

	constructor(
		private sessionName: string = "flywheel",
		private execFileFn: ExecFileFn = defaultExecFile,
		private pollIntervalMs: number = 5000,
		private defaultTimeoutMs: number = 1800000, // 30 min
	) {}

	async run(request: FlywheelRunRequest): Promise<FlywheelRunResult> {
		// Lazy preflight: check tmux AND claude on first run, not at construction time
		if (!this.preflightDone) {
			this.execFileFn("tmux", ["-V"]);
			this.execFileFn("claude", ["--version"]);
			this.preflightDone = true;
		}

		const windowName = this.sanitizeWindowName(
			request.label ?? `issue-${Date.now()}`,
		);
		const claudeSessionId = randomUUID();
		const start = Date.now();
		const effectiveTimeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;

		// Marker directory managed by DagDispatcher — TmuxRunner assumes it exists

		// Ensure session exists (idempotent)
		this.ensureSession();

		// Inject FLYWHEEL_MARKER_DIR into tmux session environment
		// so the SessionEnd hook shell script inherits it
		this.execFileFn("tmux", [
			"set-environment",
			"-t",
			`=${this.sessionName}`,
			"FLYWHEEL_MARKER_DIR",
			FLYWHEEL_MARKER_DIR,
		]);

		// Unset CLAUDECODE to prevent nested Claude hang/refuse
		// (inherited when Flywheel is launched from within a Claude Code session)
		this.execFileFn("tmux", [
			"set-environment",
			"-t",
			`=${this.sessionName}`,
			"-u",
			"CLAUDECODE",
		]);

		// Enable remain-on-exit so dead panes stay visible
		this.execFileFn("tmux", [
			"set-option",
			"-t",
			`=${this.sessionName}`,
			"remain-on-exit",
			"on",
		]);

		// Build claude args (interactive mode — NO --print, NO --output-format)
		const claudeArgs = this.buildClaudeArgs(request, claudeSessionId);

		// Launch Claude in a new tmux window WITH cwd
		// Use -P -F to capture stable window_id (e.g., "@42")
		// Use exact-match "=" prefix for session target
		const launchResult = this.execFileFn("tmux", [
			"new-window",
			"-P",
			"-F",
			"#{window_id}",
			"-t",
			`=${this.sessionName}`,
			"-n",
			windowName,
			"-c",
			request.cwd,
			"claude",
			...claudeArgs,
		]);
		const windowId = launchResult.stdout.trim();

		// Wait for completion: hook marker (primary) OR pane_dead (fallback)
		const timedOut = await this.waitForCompletion(
			claudeSessionId,
			windowId,
			effectiveTimeoutMs,
		);

		return {
			success: true, // runner-level: process completed. Task-level success via GitResultChecker
			sessionId: claudeSessionId,
			tmuxWindow: `${this.sessionName}:${windowId}`,
			durationMs: Date.now() - start,
			timedOut,
		};
	}

	private buildClaudeArgs(
		req: FlywheelRunRequest,
		sessionId: string,
	): string[] {
		// CLI syntax: claude [options] [prompt] — options MUST come before prompt
		const args: string[] = [];
		args.push("--session-id", sessionId);
		if (req.permissionMode)
			args.push("--permission-mode", req.permissionMode);
		if (req.appendSystemPrompt)
			args.push("--append-system-prompt", req.appendSystemPrompt);
		if (req.model) args.push("--model", req.model);
		if (req.allowedTools?.length)
			args.push("--allowed-tools", ...req.allowedTools);
		// NOTE: --max-turns does NOT exist in Claude CLI v2.1.63
		// NOTE: --max-budget-usd not supported in interactive mode (requires --print)
		// NOTE: request.sessionId intentionally ignored — no resume in interactive mode
		args.push(req.prompt); // prompt MUST be last positional argument
		return args;
	}

	/**
	 * Wait for session completion via dual-path detection.
	 * Returns true if the wait was terminated by timeout (not normal completion).
	 */
	private async waitForCompletion(
		claudeSessionId: string,
		windowId: string,
		timeoutMs: number,
	): Promise<boolean> {
		// NOTE: Claude's internal session_id differs from the --session-id we pass.
		// --session-id is for resume; Claude generates its own ID for hooks.
		// Phase 1 (sequential): match any .done file since only one session runs at a time.
		// TODO: Phase 2 (parallel): correlate via marker file content or tmux window metadata.

		return new Promise<boolean>((resolve) => {
			let resolved = false;
			const cleanup = () => {
				resolved = true;
				watcher?.close();
				clearInterval(poller);
				clearTimeout(timer);
			};

			// Path 1: Watch for any hook-written .done marker file (event-driven)
			const watcher = existsSync(FLYWHEEL_MARKER_DIR)
				? watch(FLYWHEEL_MARKER_DIR, (_, filename) => {
						if (!resolved && filename?.endsWith(".done")) {
							cleanup();
							resolve(false); // not timed out
						}
					})
				: null;

			// Path 2: Poll pane_dead as fallback
			const poller = setInterval(() => {
				if (resolved) return;
				// Also check if any marker appeared (in case fs.watch missed it)
				try {
					const files = require("node:fs").readdirSync(FLYWHEEL_MARKER_DIR) as string[];
					if (files.some((f: string) => f.endsWith(".done"))) {
						cleanup();
						resolve(false); // not timed out
						return;
					}
				} catch { /* marker dir may not exist */ }
				try {
					const result = this.execFileFn("tmux", [
						"list-panes",
						"-t",
						windowId,
						"-F",
						"#{pane_dead}",
					]);
					if (result.stdout.trim() === "1") {
						cleanup();
						resolve(false); // not timed out
					}
				} catch (err) {
					// Window gone entirely — treat as session ended
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[TmuxRunner] tmux list-panes failed for ${windowId}: ${msg}. Treating as session ended.`,
					);
					cleanup();
					resolve(false); // not timed out
				}
			}, this.pollIntervalMs);

			// Timeout — resolve (not reject) so caller gets tmuxWindow for inspection
			const timer = setTimeout(() => {
				if (resolved) return;
				console.warn(
					`[TmuxRunner] Session ${claudeSessionId} timed out after ${timeoutMs}ms. Window ${windowId} preserved for inspection.`,
				);
				cleanup();
				resolve(true); // timed out
			}, timeoutMs);
		});
	}

	private ensureSession(): void {
		try {
			// Use exact-match prefix "=" to prevent tmux prefix matching
			// (e.g., "flywheel" would otherwise match "flywheel-e2e")
			this.execFileFn("tmux", [
				"has-session",
				"-t",
				`=${this.sessionName}`,
			]);
		} catch {
			this.execFileFn("tmux", [
				"new-session",
				"-d",
				"-s",
				this.sessionName,
			]);
		}
	}

	sanitizeWindowName(name: string): string {
		return name.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 50);
	}
}

function defaultExecFile(
	cmd: string,
	args: string[],
): { stdout: string } {
	const result = execFileSync(cmd, args, { encoding: "utf-8" });
	return { stdout: result };
}
