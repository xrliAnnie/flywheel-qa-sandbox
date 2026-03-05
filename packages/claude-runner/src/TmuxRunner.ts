import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
	FlywheelRunRequest,
	FlywheelRunResult,
	IFlywheelRunner,
	IHookCallbackServer,
} from "flywheel-core";
import { FLYWHEEL_MARKER_DIR } from "flywheel-core";

export type ExecFileFn = (
	cmd: string,
	args: string[],
) => { stdout: string };

/**
 * TmuxRunner — launches Claude Code in an interactive tmux window.
 *
 * Two completion modes:
 * - v0.2 mode (hookServer present): HTTP callback (primary) + pane_dead poller (fallback)
 * - v0.1.1 mode (hookServer absent): marker file watcher + pane_dead poller
 */
export class TmuxRunner implements IFlywheelRunner {
	readonly name = "claude-tmux";
	private preflightDone = false;

	constructor(
		private sessionName: string = "flywheel",
		private execFileFn: ExecFileFn = defaultExecFile,
		private pollIntervalMs: number = 5000,
		private defaultTimeoutMs: number = 1800000, // 30 min
		private hookServer?: IHookCallbackServer,
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

		// Generate per-run callback token if hookServer available
		const callbackToken = this.hookServer ? randomUUID() : undefined;

		// Ensure session exists (idempotent)
		this.ensureSession();

		if (this.hookServer) {
			// v0.2 mode: no marker dir needed
		} else {
			// v0.1.1 mode: inject FLYWHEEL_MARKER_DIR into tmux session environment
			this.execFileFn("tmux", [
				"set-environment",
				"-t",
				`=${this.sessionName}`,
				"FLYWHEEL_MARKER_DIR",
				FLYWHEEL_MARKER_DIR,
			]);
		}

		// Unset CLAUDECODE to prevent nested Claude hang/refuse
		this.execFileFn("tmux", [
			"set-environment",
			"-t",
			`=${this.sessionName}`,
			"-u",
			"CLAUDECODE",
		]);

		// Enable remain-on-exit so dead panes stay visible.
		// remain-on-exit is a window option — use "session:" syntax to target
		// the current window in the session (bare session name fails in tmux 3.5+).
		this.execFileFn("tmux", [
			"set-option",
			"-t",
			`=${this.sessionName}:`,
			"remain-on-exit",
			"on",
		]);

		// Prevent Claude CLI from overwriting the pane title via escape sequences.
		// This lets our custom pane title (set after launch) persist.
		this.execFileFn("tmux", [
			"set-option",
			"-t",
			`=${this.sessionName}:`,
			"allow-rename",
			"off",
		]);

		// Build claude args (interactive mode — NO --print, NO --output-format)
		const claudeArgs = this.buildClaudeArgs(request, claudeSessionId);

		// Build per-window env args for v0.2 HTTP callback
		const envArgs =
			this.hookServer && callbackToken
				? [
						"-e",
						`FLYWHEEL_CALLBACK_PORT=${this.hookServer.getPort()}`,
						"-e",
						`FLYWHEEL_CALLBACK_TOKEN=${callbackToken}`,
						"-e",
						`FLYWHEEL_ISSUE_ID=${request.issueId ?? "unknown"}`,
					]
				: [];

		// Launch Claude in a new tmux window WITH cwd
		// Prompt is passed as CLI arg — Claude starts processing immediately.
		// Use -P -F to capture stable window_id (e.g., "@42")
		const launchResult = this.execFileFn("tmux", [
			"new-window",
			"-P",
			"-F",
			"#{window_id}",
			"-t",
			`=${this.sessionName}`,
			...envArgs,
			"-n",
			windowName,
			"-c",
			request.cwd,
			"claude",
			...claudeArgs,
		]);
		const windowId = launchResult.stdout.trim();

		// Wait for completion: mode depends on hookServer presence
		const timedOut = await this.waitForCompletion(
			claudeSessionId,
			windowId,
			effectiveTimeoutMs,
			callbackToken,
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
		// Prompt as last CLI arg — Claude starts processing immediately on launch
		args.push(req.prompt);
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
		callbackToken?: string,
	): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let watcher: ReturnType<typeof watch> | null = null;
			let poller: ReturnType<typeof setInterval> | null = null;

			const settle = (timedOut: boolean) => {
				if (settled) return;
				settled = true;
				watcher?.close();
				if (poller) clearInterval(poller);
				clearTimeout(timer);
				resolve(timedOut);
			};

			// Timeout
			const timer = setTimeout(() => {
				console.warn(
					`[TmuxRunner] Session ${claudeSessionId} timed out after ${timeoutMs}ms. Window ${windowId} preserved for inspection.`,
				);
				settle(true);
			}, timeoutMs);

			if (this.hookServer && callbackToken) {
				// ── v0.2 mode: HTTP callback (primary) + pane_dead poller (fallback) ──
				// NO marker file watcher — markers are not per-token safe for parallel

				// Path 1: HTTP callback
				this.hookServer
					.waitForCompletion(callbackToken, timeoutMs)
					.then((event) => {
						if (event) settle(false);
					});

				// Path 2: pane_dead poller (fallback — races with callback)
				poller = setInterval(() => {
					if (settled) return;
					try {
						const result = this.execFileFn("tmux", [
							"list-panes",
							"-t",
							windowId,
							"-F",
							"#{pane_dead}",
						]);
						if (result.stdout.trim() === "1") settle(false);
					} catch {
						// Window gone → pane is dead
						settle(false);
					}
				}, this.pollIntervalMs);
			} else {
				// ── v0.1.1 mode: marker file watcher + pane_dead poller ──

				// Path 1: Watch for any hook-written .done marker file (event-driven)
				watcher = existsSync(FLYWHEEL_MARKER_DIR)
					? watch(FLYWHEEL_MARKER_DIR, (_, filename) => {
							if (!settled && filename?.endsWith(".done")) {
								settle(false);
							}
						})
					: null;

				// Path 2: Poll pane_dead as fallback
				poller = setInterval(() => {
					if (settled) return;
					// Also check if any marker appeared (in case fs.watch missed it)
					try {
						const files = readdirSync(FLYWHEEL_MARKER_DIR);
						if (files.some((f: string) => f.endsWith(".done"))) {
							settle(false);
							return;
						}
					} catch {
						/* marker dir may not exist */
					}
					try {
						const result = this.execFileFn("tmux", [
							"list-panes",
							"-t",
							windowId,
							"-F",
							"#{pane_dead}",
						]);
						if (result.stdout.trim() === "1") {
							settle(false);
						}
					} catch (err) {
						const msg =
							err instanceof Error ? err.message : String(err);
						console.warn(
							`[TmuxRunner] tmux list-panes failed for ${windowId}: ${msg}. Treating as session ended.`,
						);
						settle(false);
					}
				}, this.pollIntervalMs);
			}
		});
	}

	private ensureSession(): void {
		try {
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
	const result = execFileSync(cmd, args, {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	return { stdout: result };
}
