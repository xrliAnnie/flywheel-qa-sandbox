import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	buildNonLeadClaudeSettings,
	PONYTAIL_PLUGIN,
	resolveAllowedCanonicalModel,
	resolveAllowedEffort,
	resolveCommBackend,
} from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
	IHookCallbackServer,
	LaunchPrecommitFailure,
} from "flywheel-core";
import { FLYWHEEL_MARKER_DIR, sanitizeTmuxName } from "flywheel-core";
import { pretrustClaudeWorkspace } from "./workspace-trust.js";

/**
 * FLY-494: optional per-call exec options.
 * - `timeoutMs` bounds a single exec so a hanging external CLI (e.g. a slow
 *   `kimi --version` whose ~18s cold start could otherwise wedge dispatch)
 *   FAILS CLOSED instead of blocking the caller forever.
 * - `env` is MERGED over the parent `process.env` for that one call (used to
 *   force `NODE_OPTIONS=--dns-result-order=ipv4first` for kimi's IPv6-stall
 *   prone startup). Merged — NOT replaced — so PATH etc. survive.
 * Backward-compatible: every existing caller and mock omits both (so behavior is
 * byte-identical — no timeout, inherited env).
 */
export interface ExecFileOpts {
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
}

export type ExecFileFn = (
	cmd: string,
	args: string[],
	opts?: ExecFileOpts,
) => { stdout: string };

export type AsyncExecFileFn = (
	cmd: string,
	args: string[],
	opts?: ExecFileOpts,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * FLY-1715: values a runner must never inherit from the long-lived tmux server.
 * The allow-by-default boundary is intentionally narrow: these are the six
 * identity/credential names implicated in the incident. Registry-derived
 * runner identity continues under the explicit FLYWHEEL_* names.
 */
export const AMBIENT_IDENTITY_DENYLIST = [
	"LEAD_ID", // legacy Lead identity reader
	"DISCORD_STATE_DIR", // Discord plugin credential-directory selector
	"DISCORD_BOT_TOKEN", // Discord gateway credential
	"TEAMLEAD_API_TOKEN", // Bridge master credential
	"BRIDGE_URL", // legacy Bridge endpoint
	"PROJECT_NAME", // legacy project identity; conditionally restored from ctx
] as const;

export interface AmbientSafeWindowCommandOptions {
	binaryName: string;
	binaryArgs: string[];
	projectName?: string;
	gateFile?: string;
	launchToken?: string;
	cleanup?: "keep" | "unlink";
	promptFile?: string;
}

export interface BuiltCliArgs {
	args: string[];
	windowPromptFile?: string;
}

// FLY-1869: keep the complete tmux command below its observed 16–20KB parser
// ceiling, and keep the eventual single prompt argv below Linux MAX_ARG_STRLEN.
export const TMUX_COMMAND_BUDGET_BYTES = 12_288;
export const WINDOW_PROMPT_BUDGET_BYTES = 120_000;

export type LaunchCommandOversizeReason =
	| "tmux_command_budget"
	| "prompt_size_budget";

export class LaunchCommandOversizeError extends Error {
	readonly name = "LaunchCommandOversizeError";
	readonly code = "LAUNCH_COMMAND_OVERSIZE";

	constructor(
		readonly reason: LaunchCommandOversizeReason,
		readonly actualBytes: number,
		readonly budgetBytes: number,
		message: string,
	) {
		super(message);
	}
}

function tmuxCommandBytes(args: string[]): number {
	return ["tmux", ...args].reduce(
		(total, arg) => total + Buffer.byteLength(arg, "utf8") + 1,
		0,
	);
}

function largestArgSummary(args: string[]): string {
	return args
		.map((arg, index) => ({
			index,
			bytes: Buffer.byteLength(arg, "utf8"),
			label:
				index > 0 && args[index - 1]?.startsWith("-")
					? `${args[index - 1]} value`
					: `argv[${index}]`,
		}))
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, 3)
		.map(({ label, bytes }) => `${label}=${bytes}B`)
		.join(", ");
}

export function assertLaunchCommandBudgets(
	tmuxArgs: string[],
	windowPromptFile?: string,
): void {
	if (windowPromptFile) {
		const promptBytes = readFileSync(windowPromptFile).byteLength;
		if (promptBytes > WINDOW_PROMPT_BUDGET_BYTES) {
			throw new LaunchCommandOversizeError(
				"prompt_size_budget",
				promptBytes,
				WINDOW_PROMPT_BUDGET_BYTES,
				`[TmuxAdapter] LAUNCH_COMMAND_OVERSIZE prompt_size_budget: prompt file is ${promptBytes} bytes; budget is ${WINDOW_PROMPT_BUDGET_BYTES} bytes (${windowPromptFile})`,
			);
		}
	}

	const commandBytes = tmuxCommandBytes(tmuxArgs);
	if (commandBytes > TMUX_COMMAND_BUDGET_BYTES) {
		throw new LaunchCommandOversizeError(
			"tmux_command_budget",
			commandBytes,
			TMUX_COMMAND_BUDGET_BYTES,
			`[TmuxAdapter] LAUNCH_COMMAND_OVERSIZE tmux_command_budget: tmux command is ${commandBytes} bytes; budget is ${TMUX_COMMAND_BUDGET_BYTES} bytes; largest args: ${largestArgSummary(tmuxArgs)}`,
		);
	}
}

/**
 * Build the final pane command. Both direct adapters and the generation-gated
 * Claude path cross the same `env -u` boundary. PROJECT_NAME is first removed,
 * then restored only when the registry-derived context supplied it.
 */
export function buildAmbientSafeWindowCommand(
	opts: AmbientSafeWindowCommandOptions,
): string[] {
	const safeRunnerCommand = [
		"env",
		...AMBIENT_IDENTITY_DENYLIST.flatMap((name) => ["-u", name]),
		...(opts.projectName !== undefined
			? [`PROJECT_NAME=${opts.projectName}`]
			: []),
		opts.binaryName,
		...opts.binaryArgs,
	];

	const hasGate = opts.gateFile !== undefined || opts.launchToken !== undefined;
	if (opts.promptFile && !hasGate) {
		throw new Error("ambient-safe prompt file requires a gated launch");
	}
	if (!hasGate) return safeRunnerCommand;
	if (!opts.gateFile || !opts.launchToken) {
		throw new Error(
			"ambient-safe gated launch requires gateFile and launchToken",
		);
	}

	return [
		"sh",
		"-c",
		// $0 = commit file; $1 = this launch token; $2 = cleanup policy;
		// $3 = optional prompt file;
		// after shift, "$@" is the complete ambient-safe argv. Neither project
		// identity nor the binary name is interpolated into shell source.
		'cf="$0"; tok="$1"; cleanup="$2"; pf="$3"; shift 3; n=0; while ! grep -qF "$tok" "$cf" 2>/dev/null; do [ "$n" -ge 1500 ] && exit 1; sleep 0.02; n=$((n+1)); done; [ "$cleanup" = "unlink" ] && rm -f -- "$cf"; if [ -n "$pf" ]; then p="$(cat -- "$pf")" || { printf "FLYWHEEL_PROMPT_FILE_UNREADABLE %s\\n" "$pf" >&2; exit 78; }; [ -n "$p" ] || { printf "FLYWHEEL_PROMPT_FILE_UNREADABLE %s\\n" "$pf" >&2; exit 78; }; exec "$@" "$p"; else exec "$@"; fi',
		opts.gateFile,
		opts.launchToken,
		opts.cleanup ?? "keep",
		opts.promptFile ?? "",
		...safeRunnerCommand,
	];
}

export interface EnsureRunnerSessionOptions {
	asyncExecFileFn?: AsyncExecFileFn;
	attemptCapMs?: number;
	deadlineMs?: number;
	retryDelayMs?: number;
	rescueCliPath?: string;
	socketPath?: string;
}

export type TmuxHoldKind =
	| "saturated"
	| "split_brain"
	| "ambiguous"
	| "unknown"
	| "rescue_failed"
	| "lock_unavailable";

export class TmuxSessionHoldError extends Error {
	constructor(
		readonly kind: TmuxHoldKind,
		readonly evidence: Record<string, unknown>,
		message = `tmux session ensure held: ${kind}`,
	) {
		super(message);
		this.name = "TmuxSessionHoldError";
	}
}

export class LaunchPrecommitError extends Error {
	readonly name = "LaunchPrecommitError";

	constructor(
		readonly launchFailure: LaunchPrecommitFailure,
		message: string,
	) {
		super(message);
	}
}

/**
 * TmuxAdapter — launches Claude Code in an interactive tmux window.
 *
 * Implements IAdapter (supportsStreaming: false). Replaces TmuxRunner (GEO-157).
 *
 * Two completion modes:
 * - v0.2 mode (hookServer present): HTTP callback (primary) + pane_dead poller (fallback)
 * - v0.1.1 mode (hookServer absent): marker file watcher + pane_dead poller
 *
 * Heartbeat: calls ctx.onHeartbeat(executionId) immediately on start and
 * during each poll cycle, so HeartbeatService can detect orphaned sessions.
 */
/**
 * Minimal IAgentTeamTransport-shaped surface needed by TmuxAdapter.
 *
 * We don't import `IAgentTeamTransport` directly to avoid creating a
 * dependency from claude-runner → agent-team-transport (which would couple
 * a generic runner package to a vendor-specific transport). Callers pass an
 * adapter instance produced by `AgentTeamTransportFactory.fromEnv()`.
 *
 * FLY-142 Phase 0 PR 1.2.
 */
export interface RunnerSpawnTransport {
	buildRunnerSpawnConfig(ctx: {
		leadName: string;
		runnerName: string;
		teamName: string;
		parentSessionId?: string;
		color?: string;
		sessionId?: string;
		permissionMode?: string;
		[key: string]: unknown;
	}): { args: string[]; env: Record<string, string> };
}

export class TmuxAdapter implements IAdapter {
	// FLY-493: overridable seam — AntigravityTmuxAdapter sets "antigravity-tmux".
	// The claude default is unchanged, so claude behavior is byte-identical.
	readonly type: string = "claude-tmux";
	readonly supportsStreaming = false;
	private preflightDone = false;
	/**
	 * FLY-493: the agentic-CLI binary this adapter launches. Overridable seam —
	 * AntigravityTmuxAdapter sets "agy". Used by preflight, checkEnvironment, and
	 * the tmux launch command. Default "claude" keeps the production path
	 * byte-identical.
	 */
	protected readonly binaryName: string = "claude";
	/**
	 * FLY-1188: transport vendor recorded on the CommDB session row — routes
	 * `flywheel-comm send` wakes to the right mailbox. Overridable seam: the
	 * no-transport subclasses (AntigravityTmuxAdapter/KimiTmuxAdapter) set
	 * "none" so a Lead `send` fails LOUD instead of writing a claude-code
	 * mailbox nobody reads and stamping a false delivered_at.
	 */
	protected readonly registrationVendor: string = "claude-code";

	constructor(
		private sessionName: string = "flywheel",
		// FLY-493: protected so AntigravityTmuxAdapter's preflight can run agy
		// probes through the same injectable (test-mockable) seam.
		protected execFileFn: ExecFileFn = defaultExecFile,
		private pollIntervalMs: number = 5000,
		private defaultTimeoutMs: number = 86_400_000, // 24h safety net (FLY-97; FLY-92 idle detection retired in FLY-1560)
		private hookServer?: IHookCallbackServer,
		/**
		 * FLY-142 PR 1.2: optional vendor-neutral transport adapter. When
		 * provided AND `ctx.agentName + ctx.teamName + ctx.vendor` are all
		 * set, TmuxAdapter calls `transport.buildRunnerSpawnConfig(ctx)` and
		 * merges the resulting CLI args + env into the spawn invocation.
		 *
		 * When undefined OR ctx is missing fields, no transport wiring →
		 * backward-compatible with all existing call sites.
		 */
		private transport?: RunnerSpawnTransport,
		/**
		 * FLY-766: this Bridge's actual opened StateStore db path (= store.getDbPath()),
		 * threaded from `setupRunInfrastructure`. Written into each claude-tmux
		 * runner's `.flywheel-owner.json` owner marker so the Chrome-session reaper
		 * can prove which Bridge owns a leaked `agent-browser` Chrome (defends
		 * against mis-killing a same-machine QA-slot's live Chrome). TMPDIR + marker
		 * injection is gated on `type === "claude-tmux"` (not on this field); when
		 * this is undefined (legacy call sites) the marker's `stateDbPath` is written
		 * as `null`, which the reaper treats as unowned → foreign → never reaped.
		 */
		private ownerStateDbPath?: string,
		private ensureSessionOptions?: EnsureRunnerSessionOptions,
	) {}

	/**
	 * FLY-159 Codex r1 R1 HIGH (test-visible): determine whether the current
	 * waiting period has exceeded the per-wait hard cap. Pure function — no
	 * Date.now, no DB, easy to unit test. See `checkDynamicTimeout` for the
	 * wait-period vs session-total rationale.
	 */
	static _isWaitingPeriodExpired(
		lastWaitStart: number | null,
		now: number,
		hardCap: number,
	): boolean {
		if (lastWaitStart === null) return false;
		return now - lastWaitStart > hardCap;
	}

	/**
	 * FLY-159 Codex r2+r3 (test-visible): outer `setTimeout` ultra-safety
	 * net duration. The inner per-wait + per-active budgets are enforced
	 * by `checkDynamicTimeout`'s polling loop; this outer timer is a
	 * last-resort kill switch ONLY if the inner polling stalls (DB closed,
	 * etc.).
	 *
	 * It must be generous enough that the inner cap always fires first
	 * across any plausible session — otherwise the outer timer preempts
	 * `resolveGate(0)` + `gate_timed_out` and silently bypasses Annie's
	 * approval. Per Codex r3 MEDIUM, a fixed `* 3` multiplier breaks for
	 * Runners with 4+ sequential gates (brainstorm + N questions +
	 * approve_to_ship).
	 *
	 * Formula: `max(timeoutMs, waitingBudget * 7)` ≈ 7 sequential 49h
	 * waits ≈ 14.3 days. Well beyond any plausible Runner session while
	 * still finite enough to function as a stall-detection safety net.
	 * (setTimeout max delay is 2^31-1 ms ≈ 24.85 days, so 14.3 days fits.
	 * Multiplier bumped down from 14 → 7 because waitingBudget doubled
	 * 25h → 49h with the 24h → 48h gate timeout shift; product remains
	 * ≈ 14 days.)
	 */
	static _computeOuterHardTimeoutMs(
		timeoutMs: number,
		waitingBudgetMs: number,
	): number {
		return Math.max(timeoutMs, waitingBudgetMs * 7);
	}

	async checkEnvironment(): Promise<AdapterHealthCheck> {
		try {
			const tmuxResult = this.execFileFn("tmux", ["-V"]);
			const cliResult = this.execFileFn(this.binaryName, ["--version"]);
			return {
				healthy: true,
				message: `tmux and ${this.binaryName} CLI available`,
				details: {
					tmux: tmuxResult.stdout.trim(),
					[this.binaryName]: cliResult.stdout.trim(),
				},
			};
		} catch (err) {
			return {
				healthy: false,
				message: `Environment check failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	/**
	 * FLY-493: lazy one-time preflight, extracted as an overridable seam.
	 * Default: tmux + `<binaryName> --version`. AntigravityTmuxAdapter overrides
	 * to add a FAIL-CLOSED `agy` auth probe before declaring the session ready.
	 */
	protected runPreflight(): void {
		this.execFileFn("tmux", ["-V"]);
		this.execFileFn(this.binaryName, ["--version"]);
	}

	/**
	 * FLY-494: extra env vars injected into the runner's tmux pane (as `-e KEY=VAL`).
	 * Overridable seam — the default returns `{}` so claude/codex/agy panes are
	 * byte-identical. KimiTmuxAdapter overrides it to force IPv4-first DNS.
	 */
	protected extraPaneEnv(): Record<string, string> {
		return {};
	}

	async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
		// Lazy preflight: check tmux AND the agentic CLI on first run
		if (!this.preflightDone) {
			this.runPreflight();
			this.preflightDone = true;
		}
		if (this.type === "claude-tmux" && ctx.pretrustWorkspace === true) {
			await pretrustClaudeWorkspace(realpathSync(ctx.cwd));
		}

		let windowName = this.sanitizeWindowName(
			ctx.label ?? `issue-${Date.now()}`,
		);
		const claudeSessionId = randomUUID();
		const start = Date.now();
		const effectiveTimeoutMs = ctx.timeoutMs ?? this.defaultTimeoutMs;

		// Generate per-run callback token if hookServer available
		const callbackToken = this.hookServer ? randomUUID() : undefined;

		// FLY-1638: a completed generation can leave a same-name window behind.
		// Resolve those exact identities before the capacity guard runs; otherwise
		// ensureSession reports saturation and a fresh launch never gets a chance.
		windowName = this.purgeTerminalSameNameWorkflowWindows(ctx, windowName);

		// Ensure session exists (idempotent)
		await this.ensureSession();

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

		// GEO-269: allow-rename ON so Claude CLI's --name can set the tmux window title.
		// Previously OFF to prevent random title overwrites, but now we pass a meaningful
		// --name (issueId + title) so Claude's title is exactly what we want to display.

		// FLY-142 PR 1.2: vendor-neutral Agent Team transport spawn config.
		// Computed once and reused for both env injection (envArgs below) and
		// CLI args (prepended to claudeArgs). Returns null when transport
		// isn't wired OR ctx lacks agentName/teamName/vendor → backward-
		// compatible spawn (skipped wiring).
		const transportSpawnConfig = this.tryBuildTransportSpawnConfig(ctx);
		const commitFile = ctx.launchCommitPath;
		const generationGated = this.type === "claude-tmux";
		const launchToken =
			generationGated || commitFile
				? (ctx.launchGateToken ?? randomUUID())
				: undefined;
		const directGateFile =
			generationGated && !commitFile && launchToken
				? join(tmpdir(), "flywheel-launch-gates", `launch-${launchToken}`)
				: undefined;
		const gateFile = commitFile ?? directGateFile;

		// Build CLI args (interactive mode — NO --print, NO --output-format).
		// FLY-493: `buildCliArgs` is an overridable seam; the Claude default
		// delegates to `buildClaudeArgs` and may return a file-backed task prompt.
		const { args: claudeArgs, windowPromptFile } = this.buildCliArgs(
			ctx,
			claudeSessionId,
			launchToken,
		);

		// Prepend transport-supplied identity flags before the standard CLI args.
		// The gated shell appends a file-backed task prompt only at exec time.
		if (transportSpawnConfig) {
			claudeArgs.unshift(...transportSpawnConfig.args);
		}

		// Build per-window env args for v0.2 HTTP callback
		const envArgs =
			this.hookServer && callbackToken
				? [
						"-e",
						`FLYWHEEL_CALLBACK_PORT=${this.hookServer.getPort()}`,
						"-e",
						`FLYWHEEL_CALLBACK_TOKEN=${callbackToken}`,
						"-e",
						`FLYWHEEL_ISSUE_ID=${ctx.issueId ?? "unknown"}`,
					]
				: [];

		// GEO-206: Inject comm DB path for flywheel-comm CLI
		if (ctx.commDbPath) {
			envArgs.push("-e", `FLYWHEEL_COMM_DB=${ctx.commDbPath}`);
		}

		// GEO-266: Inject execution ID for inbox PostToolUse hook
		envArgs.push("-e", `FLYWHEEL_EXEC_ID=${ctx.executionId}`);

		// FLY-142 PR 1.4: Mailbox sentinel — when present, ~/.flywheel/hooks/inbox-check.sh
		// short-circuits to a no-op. Lead → Runner delivery uses claude-code's
		// stock useInboxPoller (vendor-neutral mailbox), bypassing the buggy
		// CommDB hook filter (only reads type='instruction', drops 'response').
		//
		// Codex r1 PR 1.4 HIGH: sentinel must be GATED on the backend selector
		// — if FLYWHEEL_COMM_BACKEND=commdb (rollback), do NOT write the
		// sentinel AND propagate FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1 to the
		// Runner env so even a stale on-disk sentinel from a prior mailbox-mode
		// session is ignored. Without this gate, rollback is broken: every new
		// Runner spawn re-creates the sentinel, hook keeps no-op'ing, legacy
		// CommDB Lead → Runner messages are never injected.
		//
		// Default (env unset / "mailbox"): write sentinel + don't disable.
		// Rollback ("commdb"): skip sentinel write + force disable in Runner env.
		// FLY-168: use the shared flywheel-config parser (adds .trim() — the
		// prior inline copy didn't trim, so `FLYWHEEL_COMM_BACKEND=" commdb "`
		// silently routed as mailbox here while the shell launcher treated it
		// as rollback). Single source of truth now.
		const backend = resolveCommBackend();

		if (backend === "mailbox") {
			try {
				const sentinelDir = join(
					homedir(),
					".flywheel",
					"runner-state",
					ctx.executionId,
				);
				mkdirSync(sentinelDir, { recursive: true });
				const sentinelPath = join(sentinelDir, "mailbox-active");
				writeFileSync(
					sentinelPath,
					JSON.stringify(
						{
							execution_id: ctx.executionId,
							created_at: new Date().toISOString(),
							note: "FLY-142 PR 1.4 — mailbox cutover sentinel; presence tells inbox-check.sh hook to noop.",
						},
						null,
						2,
					),
					"utf-8",
				);
				envArgs.push("-e", `FLYWHEEL_RUNNER_STATE_DIR=${sentinelDir}`);
			} catch (err) {
				// Non-fatal: hook will fall back to old behavior (and thus the wake
				// bug). Log loudly so this gets caught in QA.
				console.error(
					`[TmuxAdapter] FLY-142 sentinel write FAILED for ${ctx.executionId}: ${(err as Error).message}. Runner will be subject to FLY-142 wake bug if Lead writes via flywheel-comm respond.`,
				);
			}
		} else {
			// Rollback: defense-in-depth — even if a stale sentinel exists from a
			// previous mailbox-mode spawn, force the hook to ignore it via env.
			envArgs.push("-e", "FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1");
			console.warn(
				`[TmuxAdapter] FLY-142 PR 1.4 — FLYWHEEL_COMM_BACKEND=commdb (rollback): skipping mailbox sentinel for ${ctx.executionId} + forcing FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1 in Runner env. Hook will run legacy CommDB polling path.`,
			);
		}

		// FLY-766: per-runner browser temp dir + owner marker (claude-tmux only).
		// Point this runner's TMPDIR at a per-execId dir so `agent-browser`'s
		// ephemeral Chrome profiles land under
		// `~/.flywheel/runner-state/<execId>/browser-tmp/agent-browser-chrome-<uuid>`
		// (deterministic attribution). The `.flywheel-owner.json` marker records
		// THIS Bridge's actual StateStore db path so the Chrome-session reaper can
		// prove ownership before killing (never touches a same-machine QA slot's
		// live Chrome). Gated on `type === "claude-tmux"` so the shared base
		// `execute()` does not inject for agy/kimi subclasses (v1 scope). Best-effort:
		// a failure logs + falls back to the system TMPDIR (that runner's Chrome
		// becomes unattributed → handled log-only by the reaper), never blocks spawn.
		if (this.type === "claude-tmux") {
			try {
				const browserTmp = join(
					homedir(),
					".flywheel",
					"runner-state",
					ctx.executionId,
					"browser-tmp",
				);
				mkdirSync(browserTmp, { recursive: true });
				chmodSync(browserTmp, 0o700);
				const markerPath = join(browserTmp, ".flywheel-owner.json");
				writeFileSync(
					markerPath,
					JSON.stringify({
						execId: ctx.executionId,
						stateDbPath: this.ownerStateDbPath ?? null,
					}),
					{ mode: 0o600 },
				);
				chmodSync(markerPath, 0o600);
				envArgs.push("-e", `TMPDIR=${browserTmp}`);
			} catch (err) {
				console.warn(
					`[TmuxAdapter] FLY-766 browser-tmp/owner-marker setup FAILED for ${ctx.executionId}: ${(err as Error).message}. Runner falls back to system TMPDIR; its agent-browser Chrome will be unattributed (reaper log-only).`,
				);
			}
		}

		// GEO-292: Bridge connection for stage reporting
		if (ctx.bridgeUrl) {
			envArgs.push("-e", `FLYWHEEL_BRIDGE_URL=${ctx.bridgeUrl}`);
		}
		if (ctx.bridgeIngestToken) {
			envArgs.push("-e", `FLYWHEEL_INGEST_TOKEN=${ctx.bridgeIngestToken}`);
		}
		if (ctx.workflowSubmissionCredential) {
			envArgs.push(
				"-e",
				`FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL=${ctx.workflowSubmissionCredential}`,
			);
		}
		if (ctx.workflowSubmissionExpected) {
			envArgs.push("-e", "FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1");
		}
		if (ctx.workflowOutputCredential) {
			envArgs.push(
				"-e",
				`FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL=${ctx.workflowOutputCredential}`,
			);
		}
		if (ctx.founderReviewRequired) {
			envArgs.push("-e", "FLYWHEEL_FOUNDER_REVIEW_REQUIRED=1");
		}
		// FLY-191 Phase 2: verify-approval must read the SAME StateStore the
		// Bridge writes (QA-caught: custom TEAMLEAD_DB_PATH deployments left
		// the Runner on the default-path DB → fail-closed forever).
		if (ctx.stateDbPath) {
			envArgs.push("-e", `FLYWHEEL_STATE_DB_PATH=${ctx.stateDbPath}`);
		}
		// FLY-1608: the runner is the complete-failed marker writer. A tmux
		// window does not inherit the slot Bridge's live env, so pass the isolated
		// directory explicitly; unset keeps the legacy HOME default.
		const completeMarkerDir = process.env.FLYWHEEL_COMPLETE_MARKER_DIR?.trim();
		if (completeMarkerDir) {
			envArgs.push("-e", `FLYWHEEL_COMPLETE_MARKER_DIR=${completeMarkerDir}`);
		}
		// FLY-795: where a resumed runner writes its progress cursor back.
		if (ctx.progressPath) {
			envArgs.push("-e", `FLYWHEEL_PROGRESS_PATH=${ctx.progressPath}`);
		}
		if (ctx.projectName) {
			envArgs.push("-e", `FLYWHEEL_PROJECT_NAME=${ctx.projectName}`);
		}
		// FLY-1726: tmux inherits its server-global environment unless each key is
		// explicitly replaced. A Runner owns a Lead lane (FLYWHEEL_LEAD_ID) but is
		// not the Lead Discord identity itself, so clear the bare Lead/Discord
		// coordinates and project only the canonical runner project name.
		envArgs.push("-e", `PROJECT_NAME=${ctx.projectName ?? ""}`);
		envArgs.push("-e", "LEAD_ID=");
		envArgs.push("-e", "DISCORD_STATE_DIR=");
		envArgs.push("-e", "DISCORD_IDENTITY_MODE=");
		envArgs.push("-e", "DISCORD_BOT_TOKEN=");

		// FLY-80: Inject Lead ID + comm CLI path so Runner's /spin approve gate works.
		// Without these, the gate's `if [ -n "$FLYWHEEL_COMM_CLI" ]` check fails
		// and the Runner completes without waiting for Annie's approval.
		if (ctx.leadId) {
			envArgs.push("-e", `FLYWHEEL_LEAD_ID=${ctx.leadId}`);
		}
		if (ctx.commDbPath) {
			try {
				const req = createRequire(import.meta.url);
				const commCliPath = req.resolve("flywheel-comm");
				envArgs.push("-e", `FLYWHEEL_COMM_CLI=${commCliPath}`);
			} catch {
				// flywheel-comm not resolvable — gate will fall back to manual mode
			}
		}

		// FLY-60 W2: inject the landing-signal sentinel path so the
		// `flywheel-comm stage set completed` CLI can read landing-status.json
		// and attach the parsed `landing_status` object to its stage_changed
		// event payload. Bridge's event-route uses that payload to fire
		// `runPostShipFinalization` on the post-merge re-finalize path
		// (codex-approved §12.3 of the FLY-60 plan). Other code paths that
		// don't pass `sentinelPath` are unaffected (env var simply absent).
		if (ctx.sentinelPath) {
			envArgs.push("-e", `FLYWHEEL_LAND_STATUS_PATH=${ctx.sentinelPath}`);
		}

		// FLY-102 / FLY-159: Override Claude Code's Bash tool max timeout.
		// Default is 600,000ms (10 min) which kills gate commands that wait for
		// human decisions. Set to 49h = 48h gate timeout + 1h buffer so the
		// gate CLI can fire its own fail-close path and emit gate_timed_out
		// before the Bash tool kills it.
		envArgs.push("-e", "BASH_MAX_TIMEOUT_MS=176400000");

		// FLY-142 PR 1.2: merge transport-supplied env vars into envArgs.
		// (`transportSpawnConfig` was computed earlier — reused here.)
		if (transportSpawnConfig) {
			for (const [key, value] of Object.entries(transportSpawnConfig.env)) {
				envArgs.push("-e", `${key}=${value}`);
			}
		}

		// FLY-494: per-adapter extra pane env (overridable seam). Default {} keeps
		// every other adapter byte-identical. KimiTmuxAdapter injects
		// NODE_OPTIONS=--dns-result-order=ipv4first so each kimi model call in the
		// pane skips kimi 0.18.0's IPv6-resolution startup stall (~6s, FLY-494 F0).
		for (const [key, value] of Object.entries(this.extraPaneEnv())) {
			envArgs.push("-e", `${key}=${value}`);
		}

		// FLY-245 / FLY-1628: every claude-tmux launch is two-phase gated. The
		// durable workflow path keeps its deterministic commit marker; the direct
		// path uses a private, per-physical-launch token file that the shell removes
		// immediately before exec. In both cases the runner cannot start until the
		// Bridge has synchronously persisted the tmux generation credential.
		// This adapter normally starts Claude AS PART of `tmux new-window`,
		// so a recorded-but-never-started window could be mis-adopted on replay.
		// Instead, the gateway path opens a tiny shell that BLOCKS on the durable
		// COMMIT file and only `exec`s Claude once the adapter writes it.
		//
		// R6 HIGH: the commit file path is execId-DETERMINISTIC (so a replay finds
		// it), hence SHARED across every attempt of the same execId. A bare
		// existence gate would let a replay's write release BOTH a stale pre-crash
		// gated shell AND the new one → two Runners. So the GATE is bound to a
		// PER-LAUNCH unique token: each shell waits until the commit file CONTAINS
		// ITS OWN token; the adapter writes its token (overwriting). A replay writes
		// a DIFFERENT token, so the stale shell's `grep` never matches and it times
		// out — only the matching shell `exec`s Claude. The file's mere EXISTENCE
		// (any token) remains the dispatcher's execId-deterministic adopt record.
		//   - crash before the commit write → no file → gated shell self-reaps;
		//     replay sees no commit → re-drives (writes a fresh token);
		//   - commit written → only THIS launch's shell `exec`s Claude; a replay
		//     sees the file exists → adopts → exactly one started Runner.
		const windowCommand = buildAmbientSafeWindowCommand({
			binaryName: this.binaryName,
			binaryArgs: claudeArgs,
			projectName: ctx.projectName,
			...(windowPromptFile ? { promptFile: windowPromptFile } : {}),
			...(gateFile && launchToken
				? {
						gateFile,
						launchToken,
						cleanup: directGateFile ? ("unlink" as const) : ("keep" as const),
					}
				: {}),
		});

		// Launch the tmux window WITH cwd (Claude directly on the fleet path; the
		// gated waiting shell on the gateway-retry path).
		const tmuxLaunchArgs = [
			"new-window",
			"-P",
			"-F",
			"#{window_id}|#{socket_path}|#{start_time}",
			"-t",
			`=${this.sessionName}`,
			...envArgs,
			"-n",
			windowName,
			"-c",
			ctx.cwd,
			...windowCommand,
		];
		try {
			assertLaunchCommandBudgets(tmuxLaunchArgs, windowPromptFile);
		} catch (error) {
			if (
				error instanceof LaunchCommandOversizeError &&
				ctx.commitWorkflowLaunch
			) {
				throw new LaunchPrecommitError(
					{
						code: "LAUNCH_COMMAND_OVERSIZE",
						reason: error.reason,
						physicalEvidence: "absent",
					},
					error.message,
				);
			}
			throw error;
		}
		const launchResult = this.execFileFn("tmux", tmuxLaunchArgs);
		// Both capture and later probe use tmux's raw `#{start_time}` decimal
		// POSIX epoch seconds. Do not format it through Date/local timezone.
		const launchFields = launchResult.stdout.trim().split("|");
		const [windowId = "", socketPath = "", serverStartTime = ""] = launchFields;
		if (
			generationGated &&
			(launchFields.length !== 3 ||
				!/^@\d+$/.test(windowId) ||
				!socketPath ||
				!/^[0-9]+$/.test(serverStartTime))
		) {
			if (/^@\d+$/.test(windowId)) {
				try {
					this.execFileFn("tmux", [
						"kill-window",
						"-t",
						`=${this.sessionName}:${windowId}`,
					]);
				} catch {
					// best-effort cleanup
				}
			}
			throw new Error(
				`[TmuxAdapter] launch aborted: malformed tmux generation output for ${ctx.executionId}`,
			);
		}
		const exactWindowTarget = `=${this.sessionName}:${windowId}`;

		// FLY-1374: publish the execution identity on the exact window. If its
		// CommDB row is later lost, the event-driven WAKE path can rediscover this
		// one live holder without guessing from StateStore metadata.
		try {
			const identityOptions: Array<[string, string]> = [
				["@flywheel_exec_id", ctx.executionId],
			];
			if (ctx.commitWorkflowLaunch) {
				if (ctx.launchGeneration === undefined || !ctx.launchFingerprint) {
					throw new Error("workflow launch generation identity is missing");
				}
				identityOptions.push(
					["@flywheel_launch_generation", String(ctx.launchGeneration)],
					["@flywheel_launch_fingerprint", ctx.launchFingerprint],
				);
			}
			for (const [option, value] of identityOptions) {
				this.execFileFn("tmux", [
					"set-option",
					"-w",
					"-t",
					exactWindowTarget,
					option,
					value,
				]);
			}
		} catch (err) {
			if (ctx.commitWorkflowLaunch) {
				const physicalEvidence = this.cleanupExactWindow(exactWindowTarget);
				throw new LaunchPrecommitError(
					{
						code: "LAUNCH_WINDOW_IDENTITY_FAILED",
						reason: "identity_publish_failed",
						physicalEvidence,
					},
					`[TmuxAdapter] workflow identity publish failed for ${exactWindowTarget}: ${(err as Error).message}`,
				);
			}
			console.warn(
				`[TmuxAdapter] execution identity publish failed for ${exactWindowTarget}: ${(err as Error).message}`,
			);
		}

		// FLY-1272: remain-on-exit is a window option. The former pre-spawn
		// `=<session>:` target changed whichever window happened to be current,
		// not the runner window created above. Scope the option to the exact new
		// Claude window before releasing a gated launch or pruning the scaffold.
		// Kimi/Antigravity inherit this execute() path but intentionally retain
		// their existing exit semantics.
		if (this.type === "claude-tmux") {
			try {
				this.execFileFn("tmux", [
					"set-option",
					"-w",
					"-t",
					exactWindowTarget,
					"remain-on-exit",
					"on",
				]);
			} catch (err) {
				try {
					this.execFileFn("tmux", ["kill-window", "-t", exactWindowTarget]);
				} catch {
					// Best-effort cleanup; the launch still fails closed below.
				}
				throw new Error(
					`[TmuxAdapter] remain-on-exit setup failed for ${exactWindowTarget}: ${(err as Error).message}`,
				);
			}
		}

		// FLY-1628: this is the crash-atomic generation fence. Nothing below may
		// release the waiting shell until the Bridge confirms the exact tuple is
		// durable. A missing/throwing callback kills the still-gated window.
		if (generationGated) {
			try {
				if (!ctx.onTmuxWindowOpened) {
					throw new Error("generation credential callback is required");
				}
				ctx.onTmuxWindowOpened({
					baseSessionName: this.sessionName,
					windowId,
					socketPath,
					serverStartTime,
					executionId: ctx.executionId,
					launchGeneration: ctx.launchGeneration,
					launchFingerprint: ctx.launchFingerprint,
				});
			} catch (err) {
				const physicalEvidence = this.cleanupExactWindow(exactWindowTarget);
				if (directGateFile) {
					try {
						unlinkSync(directGateFile);
					} catch {
						// file normally does not exist yet
					}
				}
				throw new LaunchPrecommitError(
					{
						code: "LAUNCH_WINDOW_IDENTITY_FAILED",
						reason: "generation_record_failed",
						physicalEvidence,
					},
					`[TmuxAdapter] launch aborted before generation commit for ${ctx.executionId}: ${(err as Error).message}`,
				);
			}
		}

		// FLY-245 R5/R6 HIGH-3: write THIS launch's token to the durable COMMIT file
		// = release ONLY this launch's gated shell. The file's existence is the
		// dispatcher's execId-deterministic adopt record; the token content is the
		// per-launch gate so a replay can't release a stale pre-crash shell. Single
		// commit point: before it, Claude can't start (gated) and a replay re-drives
		// (no file); after it, only this shell starts and a replay adopts (file
		// present). On a write failure the gated shell never matches its token and
		// self-reaps — a replay re-drives cleanly; no kill is required for safety.
		if (gateFile && launchToken) {
			try {
				if (commitFile && ctx.commitWorkflowLaunch) {
					const committed = ctx.commitWorkflowLaunch();
					if (!committed.ok) {
						throw new Error(committed.reason ?? "Bridge launch fence rejected");
					}
				} else {
					mkdirSync(dirname(gateFile), { recursive: true, mode: 0o700 });
					if (directGateFile) chmodSync(dirname(gateFile), 0o700);
					writeFileSync(gateFile, launchToken, { mode: 0o600 });
					chmodSync(gateFile, 0o600);
				}
			} catch (err) {
				const physicalEvidence = this.cleanupExactWindow(exactWindowTarget);
				if (directGateFile) {
					try {
						unlinkSync(directGateFile);
					} catch {
						// best-effort; the killed gated shell cannot start.
					}
				}
				throw new LaunchPrecommitError(
					{
						code: "LAUNCH_PRECOMMIT_FAILED",
						reason: `launch_commit_failed:${(err as Error).message}`,
						physicalEvidence,
					},
					`[TmuxAdapter] launch aborted: could not write durable commit for ${ctx.executionId} ` +
						`(Claude never started; gated shell self-reaps): ${(err as Error).message}`,
				);
			}
		}

		// FLY-758: drop the never-used default-shell scaffold window (win0) so cmux
		// can't pin an empty workspace at it. Safe now that this runner's window
		// exists (see pruneScaffoldWindow). Best-effort — never blocks the spawn.
		pruneScaffoldWindow(this.execFileFn, this.sessionName, windowId);

		// GEO-206 Phase 2: Register session in comm.db
		// Store full tmux target (session:window) so capture works with any session name
		let registeredSession = false;
		if (ctx.commDbPath) {
			try {
				const commDb = new CommDB(ctx.commDbPath);
				commDb.registerSession(
					ctx.executionId,
					`${this.sessionName}:${windowId}`,
					ctx.projectName ?? "unknown",
					ctx.issueId,
					ctx.leadId,
					// FLY-1188: vendor routes `flywheel-comm send` wakes by the
					// runner's REAL transport ("claude-code" here; "none" for the
					// no-transport subclasses; NULL = legacy env path).
					this.registrationVendor,
				);
				commDb.close();
				registeredSession = true;
			} catch {
				// Registration failure is non-fatal
			}
		}

		// Send immediate first heartbeat (before first poll cycle)
		ctx.onHeartbeat?.(ctx.executionId);

		// FLY-116: fire onTmuxWindowCreated callback BEFORE waitForCompletion,
		// so the macOS Terminal viewer opens while the runner is still running.
		if (ctx.onTmuxWindowCreated) {
			try {
				ctx.onTmuxWindowCreated({
					baseSessionName: this.sessionName,
					windowId,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(
					`[TmuxAdapter] onTmuxWindowCreated callback failed: ${msg}`,
				);
			}
		}

		// Wait for completion: mode depends on hookServer presence
		let timedOut: boolean;
		let sessionStatus: "completed" | "timeout" = "completed";
		try {
			timedOut = await this.waitForCompletion(
				ctx,
				claudeSessionId,
				windowId,
				effectiveTimeoutMs,
				callbackToken,
				ctx.sentinelPath,
			);
			sessionStatus = timedOut ? "timeout" : "completed";
		} catch (err) {
			// waitForCompletion failure — session may still exist
			sessionStatus = "timeout";
			throw err;
		} finally {
			// GEO-206 Phase 2: Update session status
			if (registeredSession && ctx.commDbPath) {
				try {
					const commDb = new CommDB(ctx.commDbPath);
					commDb.updateSessionStatusIfRunning(ctx.executionId, sessionStatus);
					commDb.close();
				} catch {
					// Update failure is non-fatal
				}
			}
			// FLY-86: Kill zombie tmux window after timeout
			if (sessionStatus === "timeout") {
				try {
					this.execFileFn("tmux", ["kill-window", "-t", windowId]);
				} catch {
					// Window may already be gone — non-fatal
				}
			}
		}

		return {
			success: true, // runner-level: process completed. Task-level success via GitResultChecker
			sessionId: claudeSessionId,
			tmuxWindow: `${this.sessionName}:${windowId}`,
			durationMs: Date.now() - start,
			timedOut,
		};
	}

	/**
	 * FLY-142 PR 1.2: build vendor-neutral Agent Team spawn config for this
	 * Runner. Returns null if transport isn't wired OR ctx lacks the required
	 * identity fields — preserves backward compat with all pre-FLY-142
	 * spawn flows that don't yet pass agentName/teamName/vendor.
	 */
	private tryBuildTransportSpawnConfig(
		ctx: AdapterExecutionContext,
	): { args: string[]; env: Record<string, string> } | null {
		if (!this.transport) return null;
		if (!ctx.agentName || !ctx.teamName || !ctx.vendor) return null;

		try {
			return this.transport.buildRunnerSpawnConfig({
				leadName: ctx.leadId ?? ctx.teamName,
				runnerName: ctx.agentName,
				teamName: ctx.teamName,
				...(ctx.leadSessionId !== undefined && {
					parentSessionId: ctx.leadSessionId,
				}),
				...(ctx.agentColor !== undefined && { color: ctx.agentColor }),
				...(ctx.permissionMode !== undefined && {
					permissionMode: ctx.permissionMode,
				}),
				// Pass executionId-derived sessionId so claude-code's
				// `--session-id` flag (also added by buildClaudeArgs) and
				// transport's flag refer to the same session.
				// (Transport's --session-id is purely informational here;
				// buildClaudeArgs appends the canonical --session-id.)
			});
		} catch {
			// Transport spawn-config failure is non-fatal — Runner spawns
			// without Agent Team identity flags (degrades to pre-FLY-142
			// behavior rather than blocking the spawn).
			return null;
		}
	}

	/**
	 * FLY-493: overridable CLI-arg seam. The claude default delegates to
	 * `buildClaudeArgs`. AntigravityTmuxAdapter overrides this
	 * to emit `agy` flags (which lack `--session-id`, `--permission-mode`,
	 * `--append-system-prompt-file`, `--allowed-tools`, `--name`).
	 */
	protected buildCliArgs(
		ctx: AdapterExecutionContext,
		sessionId: string,
		launchToken?: string,
	): BuiltCliArgs {
		return this.buildClaudeArgs(ctx, sessionId, launchToken);
	}

	private buildClaudeArgs(
		ctx: AdapterExecutionContext,
		sessionId: string,
		launchToken?: string,
	): BuiltCliArgs {
		// CLI syntax: claude [options] [prompt] — options MUST come before prompt
		const args: string[] = [];
		args.push("--session-id", sessionId);
		if (ctx.permissionMode) args.push("--permission-mode", ctx.permissionMode);
		if (ctx.appendSystemPrompt) {
			// FLY-154 hotfix: tmux `new-window` parser has an internal command
			// buffer that rejects very long argv lists with `command too long`
			// (qa-fly-372 hybrid swap test caught this — designer/agent prompts
			// are 6KB+ and combined with --append-system-prompt + issue body
			// + env -e args the parser overflows). claude supports the file
			// variant `--append-system-prompt-file <path>`, which keeps the
			// argv small. Write to a deterministic per-execution path under
			// the system tmpdir so /Users/.flywheel/runs/<id>/ cleanup also
			// works without colliding across runs.
			const promptDir = join(
				tmpdir(),
				"flywheel-runner-prompts",
				ctx.executionId,
			);
			// Codex R3 LOW: shared tmpdir → restrict perms so other local users
			// can't read the prompt contents (designer / issue-body text). 0o700
			// on the dir prevents listing the per-execution subdir, 0o600 on
			// the file prevents reading by anyone but the Runner owner.
			mkdirSync(promptDir, { recursive: true, mode: 0o700 });
			const promptPath = join(promptDir, "append-system-prompt.md");
			writeFileSync(promptPath, ctx.appendSystemPrompt, {
				encoding: "utf-8",
				mode: 0o600,
			});
			args.push("--append-system-prompt-file", promptPath);
		}
		// FLY-1496 final Claude spawn seam: a bare alias must never reach the CLI,
		// or the CLI's own alias table — not our registry — picks the version.
		// Absent stays absent: no model means inherit the account default, which
		// is what FLYWHEEL_RUNNER_DEFAULT_MODEL=off asks for.
		let canonicalModel: string | undefined;
		if (ctx.model) {
			canonicalModel = resolveAllowedCanonicalModel(ctx.model, {
				surface: "runner",
				runtimeVendor: "claude",
			});
			args.push("--model", canonicalModel);
		}
		// FLY-671: reasoning-effort override (roles.runner.effort). Absent ⇒ no
		// flag (byte-compat). claude-tmux only; codex/agy/kimi adapters ignore it.
		// FLY-1650: the model and the effort come from different config keys, so
		// this is the first point that sees the resolved pair. A model that does
		// not support the requested effort (Opus 4.6 has no `xhigh`) would
		// otherwise carry a flag the CLI passes straight upstream for a 400.
		// Narrowing only — an unknown model keeps its effort verbatim.
		const effort = resolveAllowedEffort(canonicalModel, ctx.effort, {
			surface: "runner",
		});
		if (effort) args.push("--effort", effort);
		if (ctx.allowedTools?.length)
			args.push("--allowed-tools", ...ctx.allowedTools);
		// FLY-615 + FLY-751 + FLY-1715: per-launch inline settings (highest non-managed
		// precedence; per-plugin merge — does not disturb other enabled plugins).
		// BOTH sources write the same `enabledPlugins` map, so they MUST merge
		// into a single --settings flag: ponytail enables its plugin (true) and
		// the FLY-751 slim profile disables heavy per-session MCP plugins
		// (false). Real-machine spike (2026-07-01) confirmed a `false` entry
		// prevents that plugin's MCP server subprocess from spawning. FLY-1715
		// writes the non-Lead Discord deny contract LAST, independent
		// of the optional slim profile, so caller opt-ins cannot turn it back on.
		const enabledPlugins: Record<string, boolean> = {
			...(ctx.enablePonytail && { [PONYTAIL_PLUGIN]: true }),
		};
		for (const plugin of ctx.disabledPlugins ?? []) {
			enabledPlugins[plugin] = false;
		}
		// FLY-1185 §2.7: positive opt-ins applied AFTER the disable list — an
		// explicit enable (QA / `playwright` label / `full-mcp`) always wins,
		// and it is what overrides the machine-level default-off in
		// ~/.claude/settings.json (per-launch settings are the highest
		// non-managed precedence — FLY-615/751 measured).
		for (const plugin of ctx.enabledPluginsExtra ?? []) {
			enabledPlugins[plugin] = true;
		}
		args.push(
			"--settings",
			JSON.stringify(buildNonLeadClaudeSettings({ enabledPlugins })),
		);
		// FLY-751: Claude-in-Chrome off for slimmed (non-QA) runners.
		if (ctx.disableChrome) {
			args.push("--no-chrome");
		}
		if (ctx.sessionDisplayName) args.push("--name", ctx.sessionDisplayName);
		// NOTE: --max-turns does NOT exist in Claude CLI v2.1.63
		// NOTE: previousSession intentionally ignored — no resume in interactive tmux mode
		// Blank prompts must stay inline: shell command substitution strips trailing
		// newlines, so externalizing whitespace-only input would turn it into an
		// empty file-backed prompt and fail the launch gate.
		if (ctx.prompt.trim() === "") {
			args.push(ctx.prompt);
			return { args };
		}
		if (!launchToken) {
			throw new Error("claude prompt externalization requires a launch token");
		}
		// FLY-1869: tmux carries only this owner-readable path. The gated pane
		// shell reads it after the generation fence and appends the content to the
		// Claude argv, keeping issue-description size out of `tmux new-window`.
		const promptDir = join(
			tmpdir(),
			"flywheel-runner-prompts",
			ctx.executionId,
		);
		mkdirSync(promptDir, { recursive: true, mode: 0o700 });
		chmodSync(promptDir, 0o700);
		const windowPromptFile = join(promptDir, `prompt-${launchToken}.md`);
		writeFileSync(windowPromptFile, ctx.prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
		chmodSync(windowPromptFile, 0o600);
		return { args, windowPromptFile };
	}

	/**
	 * Wait for session completion via dual-path detection.
	 * Returns true if the wait was terminated by timeout (not normal completion).
	 *
	 * During the poll loop, calls ctx.onHeartbeat to report liveness.
	 */
	/**
	 * GEO-206 Phase 2: Check comm.db for pending questions and manage dynamic timeout.
	 * Returns true if the session should be timed out.
	 */
	/**
	 * GEO-206 Phase 2: Check comm.db for pending questions and manage dynamic timeout.
	 *
	 * Timeout logic: When Runner is waiting for Lead, time spent waiting does NOT
	 * count against the normal active-work timeout. This prevents the scenario
	 * where Lead responds after a long delay but Runner immediately times out.
	 *
	 * We track `totalWaitingMs` — accumulated time spent in waiting state.
	 * Normal timeout checks: (elapsed - totalWaitingMs) > normalTimeoutMs
	 * Waiting hard cap: per-wait-period budget (NOT session-total) —
	 *   (now - lastWaitStart) > waitingTimeoutMs (49h, FLY-159 = 48h gate +
	 *   1h buffer). Codex r1 R1 HIGH: a session-total cap would let active
	 *   work eat the wait budget, killing a gate before its own 48h timer
	 *   fires and skipping resolveGate(0) + gate_timed_out notification.
	 *   Each wait period gets its own 49h budget; entering a new wait resets
	 *   the clock.
	 */
	private checkDynamicTimeout(
		ctx: AdapterExecutionContext,
		start: number,
		normalTimeoutMs: number,
		commDbHandle: { db: CommDB | null },
		waitState: { totalWaitingMs: number; lastWaitStart: number | null },
	): { shouldTimeout: boolean; isWaiting: boolean } {
		let isWaiting = false;

		// Lazy open: try to open DB if not yet opened
		if (!commDbHandle.db && ctx.commDbPath && existsSync(ctx.commDbPath)) {
			try {
				commDbHandle.db = CommDB.openReadonly(ctx.commDbPath);
			} catch {
				// DB not ready — will retry next cycle
			}
		}

		// Query pending questions for THIS execution
		if (commDbHandle.db) {
			try {
				isWaiting = commDbHandle.db.hasPendingQuestionsFrom(ctx.executionId);
			} catch {
				// Query failed — fall back to normal timeout
				isWaiting = false;
			}
		}

		const now = Date.now();

		// Track waiting time transitions
		if (isWaiting && waitState.lastWaitStart === null) {
			// Entered waiting state
			waitState.lastWaitStart = now;
		} else if (!isWaiting && waitState.lastWaitStart !== null) {
			// Left waiting state — accumulate time spent waiting
			waitState.totalWaitingMs += now - waitState.lastWaitStart;
			waitState.lastWaitStart = null;
		}

		const elapsed = now - start;
		if (isWaiting) {
			const hardCap = ctx.waitingTimeoutMs ?? 176_400_000; // 49h
			return {
				shouldTimeout: TmuxAdapter._isWaitingPeriodExpired(
					waitState.lastWaitStart,
					now,
					hardCap,
				),
				isWaiting,
			};
		}

		// Not waiting: subtract accumulated waiting time from elapsed
		const currentWaiting = waitState.lastWaitStart
			? now - waitState.lastWaitStart
			: 0;
		const activeTime = elapsed - waitState.totalWaitingMs - currentWaiting;
		return { shouldTimeout: activeTime > normalTimeoutMs, isWaiting };
	}

	private async waitForCompletion(
		ctx: AdapterExecutionContext,
		claudeSessionId: string,
		windowId: string,
		timeoutMs: number,
		callbackToken?: string,
		sentinelPath?: string,
	): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let watcher: ReturnType<typeof watch> | null = null;
			let poller: ReturnType<typeof setInterval> | null = null;
			let gracePollerRef: ReturnType<typeof setInterval> | null = null;
			const start = Date.now();

			// GEO-206 Phase 2: Lazy-opened readonly DB handle for dynamic timeout
			const commDbHandle: { db: CommDB | null } = { db: null };
			const waitState = {
				totalWaitingMs: 0,
				lastWaitStart: null as number | null,
			};

			const settle = (timedOut: boolean) => {
				if (settled) return;
				settled = true;
				watcher?.close();
				if (poller) clearInterval(poller);
				if (gracePollerRef) clearInterval(gracePollerRef);
				clearTimeout(timer);
				// GEO-206 Phase 2: Close readonly DB handle
				if (commDbHandle.db) {
					try {
						commDbHandle.db.close();
					} catch {
						/* ignore */
					}
					commDbHandle.db = null;
				}
				if (this.hookServer && callbackToken) {
					this.hookServer.cancelWait(callbackToken);
				}
				resolve(timedOut);
			};

			// FLY-159 Codex r2 HIGH: when ctx.waitingTimeoutMs is set (production
			// usage with dynamic gate timeout via CommDB), the outer ultra-safety
			// net must be generous enough that the inner per-wait cap
			// (checkDynamicTimeout) always fires first — otherwise a long active
			// phase + 48h gate would be killed by this timer at 49h
			// session-total, skipping `resolveGate(0)` + `gate_timed_out`.
			// When unset (tests / non-waiting usage), there's no gate semantics
			// so the outer timer keeps its legacy meaning of "absolute active
			// budget."
			const hardTimeoutMs = ctx.waitingTimeoutMs
				? TmuxAdapter._computeOuterHardTimeoutMs(
						timeoutMs,
						ctx.waitingTimeoutMs,
					)
				: timeoutMs;
			const timer = setTimeout(() => {
				console.warn(
					`[TmuxAdapter] Session ${claudeSessionId} hard timeout after ${hardTimeoutMs}ms. Window ${windowId} will be cleaned up.`,
				);
				settle(true);
			}, hardTimeoutMs);

			if (this.hookServer && callbackToken) {
				// ── v0.2 mode: HTTP callback (primary) + pane_dead poller + sentinel (fallback) ──

				// Path 1: HTTP callback (use hard upper bound to match dynamic timeout)
				// FLY-921: pass our own session id — nested sessions inherit the
				// callback token via env, so token alone cannot identify the runner.
				this.hookServer
					.waitForCompletion(callbackToken, hardTimeoutMs, claudeSessionId)
					.then((event) => {
						if (event) settle(false);
					});

				// Path 2: pane_dead poller + sentinel check (fallback — races with callback)
				poller = setInterval(() => {
					if (settled) return;

					// Heartbeat: report liveness each poll cycle
					ctx.onHeartbeat?.(ctx.executionId);

					// GEO-206 Phase 2: Dynamic timeout check (query DB first, then check elapsed)
					if (ctx.commDbPath) {
						const { shouldTimeout } = this.checkDynamicTimeout(
							ctx,
							start,
							timeoutMs,
							commDbHandle,
							waitState,
						);
						if (shouldTimeout) {
							console.warn(
								`[TmuxAdapter] Dynamic timeout for ${claudeSessionId}. Window ${windowId} will be cleaned up.`,
							);
							settle(true);
							return;
						}
					}

					// Sentinel check: land-status.json terminal state
					if (sentinelPath) {
						try {
							if (existsSync(sentinelPath)) {
								const raw = readFileSync(sentinelPath, "utf-8");
								const signal = JSON.parse(raw);
								if (
									signal.status === "merged" ||
									signal.status === "failed" ||
									signal.status === "ready_to_merge"
								) {
									clearTimeout(timer);
									let graceChecks = 0;
									gracePollerRef = setInterval(() => {
										graceChecks++;
										// Continue heartbeats during grace period
										ctx.onHeartbeat?.(ctx.executionId);
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
										} catch {
											settle(false);
										}
										if (graceChecks >= 6) {
											settle(false);
										}
									}, this.pollIntervalMs);
									if (poller) clearInterval(poller);
									poller = null;
									return;
								}
							}
						} catch (err) {
							console.warn(
								`[TmuxAdapter] Sentinel check failed for ${sentinelPath}: ${err instanceof Error ? err.message : String(err)}. Falling back to pane_dead detection.`,
							);
						}
					}

					try {
						const result = this.execFileFn("tmux", [
							"list-panes",
							"-t",
							windowId,
							"-F",
							"#{pane_dead}|#{pane_dead_status}",
						]);
						const [dead, exitStatus] = result.stdout.trim().split("|");
						if (dead === "1") {
							// FLY-102: Log exit code for crash diagnostics
							const elapsed = Date.now() - start;
							console.log(
								`[TmuxAdapter] Runner pane died: window=${windowId} exit=${exitStatus} elapsed=${Math.round(elapsed / 1000)}s session=${claudeSessionId}`,
							);
							settle(false);
						}
					} catch {
						settle(false);
					}
				}, this.pollIntervalMs);
			} else {
				// ── v0.1.1 mode: marker file watcher + pane_dead poller ──

				// Path 1: Watch for any hook-written .done marker file
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

					// Heartbeat: report liveness each poll cycle
					ctx.onHeartbeat?.(ctx.executionId);

					// GEO-206 Phase 2: Dynamic timeout check (query DB first, then check elapsed)
					if (ctx.commDbPath) {
						const { shouldTimeout } = this.checkDynamicTimeout(
							ctx,
							start,
							timeoutMs,
							commDbHandle,
							waitState,
						);
						if (shouldTimeout) {
							console.warn(
								`[TmuxAdapter] Dynamic timeout for ${claudeSessionId}. Window ${windowId} will be cleaned up.`,
							);
							settle(true);
							return;
						}
					}

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
							"#{pane_dead}|#{pane_dead_status}",
						]);
						const [dead, exitStatus] = result.stdout.trim().split("|");
						if (dead === "1") {
							// FLY-102: Log exit code for crash diagnostics
							const elapsed = Date.now() - start;
							console.log(
								`[TmuxAdapter] Runner pane died: window=${windowId} exit=${exitStatus} elapsed=${Math.round(elapsed / 1000)}s session=${claudeSessionId}`,
							);
							settle(false);
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						console.warn(
							`[TmuxAdapter] tmux list-panes failed for ${windowId}: ${msg}. Treating as session ended.`,
						);
						settle(false);
					}
				}, this.pollIntervalMs);
			}
		});
	}

	private cleanupExactWindow(exactWindowTarget: string): "cleaned" | "unknown" {
		try {
			this.execFileFn("tmux", ["kill-window", "-t", exactWindowTarget]);
		} catch {
			// Verification below is authoritative; the window may already be absent.
		}
		try {
			this.execFileFn("tmux", [
				"display-message",
				"-p",
				"-t",
				exactWindowTarget,
				"#{window_id}",
			]);
			return "unknown";
		} catch {
			return "cleaned";
		}
	}

	private purgeTerminalSameNameWorkflowWindows(
		ctx: AdapterExecutionContext,
		windowName: string,
	): string {
		if (!ctx.workflowTmuxWindowAuthority) return windowName;
		let listed: string;
		try {
			listed = this.execFileFn("tmux", [
				"list-windows",
				"-t",
				`=${this.sessionName}`,
				"-F",
				"#{window_id}|#{window_name}|#{@flywheel_exec_id}|#{@flywheel_launch_generation}|#{@flywheel_launch_fingerprint}",
			]).stdout;
		} catch {
			// A missing base session is the normal first-launch shape; ensureSession
			// below creates it. Other lookup failures stay fail-closed there.
			return windowName;
		}
		let collisionRemains = false;
		const occupiedNames = new Set<string>();
		for (const line of listed.split("\n")) {
			if (!line.trim()) continue;
			const [windowId, candidateName, executionId, rawGeneration, fingerprint] =
				line.split("|");
			if (candidateName) occupiedNames.add(candidateName);
			if (candidateName !== windowName) continue;
			if (!windowId || !/^@\d+$/.test(windowId)) {
				collisionRemains = true;
				continue;
			}
			const launchGeneration = /^\d+$/.test(rawGeneration ?? "")
				? Number(rawGeneration)
				: undefined;
			const authority = ctx.workflowTmuxWindowAuthority({
				windowId,
				windowName: candidateName,
				...(executionId && { executionId }),
				...(launchGeneration !== undefined && { launchGeneration }),
				...(fingerprint && { launchFingerprint: fingerprint }),
			});
			if (authority !== "prune") {
				collisionRemains = true;
				continue;
			}
			if (
				this.cleanupExactWindow(`=${this.sessionName}:${windowId}`) !==
				"cleaned"
			) {
				collisionRemains = true;
			}
		}
		if (!collisionRemains) return windowName;
		const identitySuffix = `-${ctx.executionId.slice(0, 8)}${
			ctx.launchGeneration === undefined ? "" : `-g${ctx.launchGeneration}`
		}`;
		// tmux permits duplicate display names, so the fallback must itself be
		// preflighted. A session cannot hold this many windows under our admission
		// cap; the bound still makes a corrupt inventory fail closed.
		for (let retry = 0; retry <= 100; retry += 1) {
			const suffix = `${identitySuffix}${retry === 0 ? "" : `-r${retry}`}`;
			const availableBaseLength = Math.max(1, 50 - suffix.length);
			const selected = this.sanitizeWindowName(
				`${windowName.slice(0, availableBaseLength)}${suffix}`,
			);
			if (!occupiedNames.has(selected)) return selected;
		}
		throw new TmuxSessionHoldError(
			"ambiguous",
			{ windowName, executionId: ctx.executionId },
			"tmux session ensure held: no unique workflow window name",
		);
	}

	private async ensureSession(): Promise<void> {
		let options = this.ensureSessionOptions;
		if (!options && this.execFileFn !== defaultExecFile) {
			// Existing unit/integration seams inject a synchronous tmux fake. Keep
			// those hermetic without weakening the default production path: real
			// adapters always use the deployed async guard below.
			options = {
				asyncExecFileFn: legacyInjectedEnsureAdapter(this.execFileFn),
			};
		}
		await ensureRunnerSession(this.execFileFn, this.sessionName, options);
	}

	sanitizeWindowName(name: string): string {
		return sanitizeTmuxName(name);
	}
}

/**
 * FLY-758: ensure the runner base tmux session exists AND its scaffold window is
 * deterministically named `zsh`.
 *
 * `tmux new-session -d` forces a default window (the never-used scaffold, win0).
 * On a FRESH session its automatic-rename is ASYNC: the window is named `tmux`
 * until the shell finishes loading its rc and prints a prompt — measured at
 * ~8 s on production (tmux 3.5a). But `ensureSession → new-window → prune` runs
 * in milliseconds, so a name-only prune ({zsh,bash}) would miss the scaffold on
 * the FIRST spawn into a fresh base session — exactly the GEO-436 scenario (base
 * session freshly created, hit after every reboot / tmux-server restart for each
 * project's first runner). QA (FLY-758) caught this: the unit-test mock fed
 * `@0|zsh` and hid the race.
 *
 * Fix: when we CREATE the session, capture the scaffold window id and immediately
 * `rename-window <id> zsh`. A manual rename sets the name now AND disables
 * automatic-rename for that window (verified on tmux 3.5a — it stays `zsh`), so
 * `pruneScaffoldWindow`'s existing name predicate reliably matches it at
 * millisecond time. Renaming to `zsh` (not a custom sentinel) also keeps the
 * later `kill-window` → `window-unlinked` event a name cmux-sync already treats
 * as a default shell (scripts/flywheel-cmux-sync.sh:2293-2301) → no unmanaged
 * cmux cleanup, no cmux-sync change needed.
 *
 * Scoped/best-effort: the rename only runs for `runner-` sessions (mirrors
 * pruneScaffoldWindow's scope) and is best-effort — a failure degrades to the
 * pre-fix behavior (scaffold cleaned once auto-rename settles on a later spawn),
 * never blocks the spawn.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function tmuxDefaultSocketPath(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const root = process.env.TMUX_TMPDIR?.trim() || "/tmp";
	return join(root, `tmux-${uid}`, "default");
}

const TMUX_ENSURE_SUCCESS_ACTIONS = new Set([
	"verified",
	"created",
	"rescued_then_verified",
	"rescued_then_created",
]);

function parseHold(error: unknown): TmuxSessionHoldError {
	const candidate = error as {
		code?: string | number;
		stdout?: string | Buffer;
		message?: string;
	};
	const stdout = candidate?.stdout
		? Buffer.isBuffer(candidate.stdout)
			? candidate.stdout.toString("utf8")
			: String(candidate.stdout)
		: "";
	let parsed: { action?: string; evidence?: Record<string, unknown> } = {};
	try {
		parsed = JSON.parse(stdout);
	} catch {
		// A missing/corrupt helper response is unknown evidence, never permission
		// to fall back to an unguarded tmux create.
	}
	const action = parsed.action ?? "hold_unknown";
	const rawKind = action.startsWith("hold_") ? action.slice(5) : "unknown";
	const allowed: TmuxHoldKind[] = [
		"saturated",
		"split_brain",
		"ambiguous",
		"unknown",
		"rescue_failed",
		"lock_unavailable",
	];
	const kind = allowed.includes(rawKind as TmuxHoldKind)
		? (rawKind as TmuxHoldKind)
		: candidate?.code === "ENOENT"
			? "lock_unavailable"
			: "unknown";
	return new TmuxSessionHoldError(
		kind,
		parsed.evidence ?? {
			reason:
				candidate?.code === "ENOENT"
					? "helper_missing"
					: "invalid_helper_output",
		},
		candidate?.message,
	);
}

function deadlineRace<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new TmuxSessionHoldError("unknown", {
					reason: "command_timeout",
				}),
			);
		}, timeoutMs);
		(timer as { unref?: () => void }).unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function asyncDelay(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		(timer as { unref?: () => void }).unref?.();
	});
}

function legacyInjectedEnsureAdapter(execFileFn: ExecFileFn): AsyncExecFileFn {
	return async (cmd, args) => {
		if (!cmd.includes("tmux-server-rescue")) {
			return { ...execFileFn(cmd, args), stderr: "" };
		}
		const verifyIndex = args.indexOf("--verify");
		const createIndex = args.indexOf("--create");
		const verifyArgs = args.slice(verifyIndex + 1, createIndex);
		const createArgs = args.slice(createIndex + 1);
		const withoutSocket = (argv: string[]) =>
			argv[1] === "-S" ? [argv[0]!, ...argv.slice(3)] : argv;
		const legacyVerify = withoutSocket(verifyArgs);
		const legacyCreate = withoutSocket(createArgs);
		try {
			execFileFn(legacyVerify[0]!, legacyVerify.slice(1));
			return {
				stdout: JSON.stringify({
					action: "verified",
					createStdout: "",
					reachablePid: 1,
				}),
				stderr: "",
			};
		} catch {
			const created = execFileFn(legacyCreate[0]!, legacyCreate.slice(1));
			return {
				stdout: JSON.stringify({
					action: "created",
					createStdout: created.stdout,
					reachablePid: 1,
				}),
				stderr: "",
			};
		}
	};
}

export async function ensureRunnerSession(
	_execFileFn: ExecFileFn,
	sessionName: string,
	options: EnsureRunnerSessionOptions = {},
): Promise<void> {
	const asyncExecFileFn = options.asyncExecFileFn ?? defaultAsyncExecFile;
	const deadlineMs =
		options.deadlineMs ??
		positiveInt(process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS, 210_000);
	const attemptCapMs =
		options.attemptCapMs ??
		positiveInt(process.env.FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS, 90_000);
	const retryDelayMs = options.retryDelayMs ?? 1_000;
	const rescueCliPath =
		options.rescueCliPath ??
		(process.env.FLYWHEEL_TMUX_RESCUE_CLI?.trim() ||
			join(homedir(), ".flywheel", "bin", "tmux-server-rescue"));
	const socketPath =
		options.socketPath ??
		(process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE?.trim() ||
			tmuxDefaultSocketPath());
	const startedAt = Date.now();
	const args = [
		"ensure",
		socketPath,
		"--verify",
		"tmux",
		"-S",
		socketPath,
		"has-session",
		"-t",
		`=${sessionName}`,
		"--create",
		"tmux",
		"-S",
		socketPath,
		"new-session",
		"-d",
		"-P",
		"-F",
		"#{window_id}",
		"-s",
		sessionName,
	];

	let lastHold = new TmuxSessionHoldError("unknown", {
		reason: "deadline_exhausted",
	});
	while (Date.now() - startedAt < deadlineMs) {
		const remaining = Math.max(1, deadlineMs - (Date.now() - startedAt));
		const attemptTimeoutMs = Math.min(attemptCapMs, remaining);
		try {
			const result = await deadlineRace(
				asyncExecFileFn(rescueCliPath, args, {
					timeoutMs: attemptTimeoutMs,
				}),
				attemptTimeoutMs,
			);
			const parsed = JSON.parse(result.stdout) as {
				action?: string;
				createStdout?: string;
				reachablePid?: number;
			};
			if (
				!parsed.action ||
				!TMUX_ENSURE_SUCCESS_ACTIONS.has(parsed.action) ||
				!Number.isSafeInteger(parsed.reachablePid) ||
				(parsed.reachablePid ?? 0) <= 0
			) {
				throw new TmuxSessionHoldError("unknown", {
					reason: "invalid_helper_output",
				});
			}
			const scaffoldWindowId = parsed.createStdout?.trim() ?? "";
			if (scaffoldWindowId && sessionName.startsWith("runner-")) {
				try {
					await deadlineRace(
						asyncExecFileFn(
							"tmux",
							[
								"-S",
								socketPath,
								"rename-window",
								"-t",
								scaffoldWindowId,
								"zsh",
							],
							{ timeoutMs: Math.min(5_000, remaining) },
						),
						Math.min(5_000, remaining),
					);
				} catch {
					// Cosmetic only. The guarded session creation has already succeeded;
					// pruneScaffoldWindow still catches the aged shell later.
				}
			}
			return;
		} catch (error) {
			lastHold =
				error instanceof TmuxSessionHoldError ? error : parseHold(error);
			if (
				(error as { code?: string })?.code === "ENOENT" ||
				Date.now() - startedAt >= deadlineMs ||
				deadlineMs <= 1
			) {
				throw lastHold;
			}
			await asyncDelay(Math.min(retryDelayMs, remaining));
		}
	}
	throw lastHold;
}

/**
 * FLY-758: shell names that identify the never-used default scaffold window
 * tmux forces onto a `new-session`-created base session. Runner windows are
 * created with `-n <issueId>-claude-…` (→ tmux disables automatic-rename for
 * them), so they never match. Fresh scaffolds are normalized to `zsh` at create
 * time by `ensureRunnerSession` (tmux otherwise leaves them named `tmux` for
 * several seconds — the FLY-758 QA race), so this name predicate is reliable at
 * millisecond spawn time.
 *
 * EXACTLY `zsh` + `bash` — the same set cmux-sync's inventory + window-unlinked
 * cleanup paths already treat as default scaffolds
 * (scripts/flywheel-cmux-sync.sh:316-317, :2293-2301). Kept in lockstep so this
 * `kill-window` source can never fire a window-unlinked event for a name
 * cmux-sync doesn't recognize as a shell (which would let it enqueue cleanup for
 * an unmanaged title — Codex design review R2). A non-zsh/bash login shell simply
 * no-ops (no regression).
 */
const SCAFFOLD_SHELL_NAMES = new Set(["zsh", "bash"]);

/**
 * FLY-758: remove the never-used default-shell scaffold window (win0) from a
 * runner base session so cmux can never pin an empty workspace at it.
 *
 * `ensureSession()` creates the base session with `tmux new-session -d`, which
 * tmux forces to contain one default window running a bare login shell. No
 * runner ever uses it — every runner launches in its OWN window via
 * `new-window`. cmux-sync builds a grouped linked session per runner window and
 * can end up pinning a cmux workspace at that shared, never-used win0 (FLY-758:
 * empty pane that reopens empty). Removing the scaffold once a real runner
 * window exists makes that failure structurally impossible.
 *
 * Shared by TmuxAdapter (claude/agy/kimi) and the independent CodexTmuxAdapter —
 * both create the same scaffold via `new-session -d` and both launch runners in
 * separate windows. Call AFTER the caller's runner `new-window` has succeeded.
 *
 * Safety invariants:
 *  - runner-session scoped: no-op unless `sessionName` starts with "runner-"
 *    (the Lead `flywheel` session + legacy `TmuxRunner`/E2E sessions untouched);
 *  - never kills `keepWindowId` (the runner window we just created);
 *  - only kills a window named a bare default shell (`zsh`/`bash`); runner
 *    windows are `<issueId>-claude-…` and can NEVER match — even a dead
 *    (remain-on-exit) one keeps its runner name;
 *  - ≥2 windows required → never kills the session's last window;
 *  - idempotent: once the scaffold is gone, no bare-shell window is found;
 *  - best-effort: any failure is swallowed. Pruning is a display nicety and must
 *    NEVER block or fail a spawn.
 */
export function pruneScaffoldWindow(
	execFileFn: ExecFileFn,
	sessionName: string,
	keepWindowId: string,
): void {
	if (!sessionName.startsWith("runner-")) return;
	try {
		const result = execFileFn("tmux", [
			"list-windows",
			"-t",
			`=${sessionName}`,
			"-F",
			"#{window_id}|#{window_name}",
		]);
		const lines = result.stdout.trim().split("\n").filter(Boolean);
		// Never kill the session's last window (would kill the session).
		if (lines.length < 2) return;
		for (const line of lines) {
			const sep = line.indexOf("|");
			if (sep < 0) continue;
			const windowId = line.slice(0, sep);
			const windowName = line.slice(sep + 1);
			if (windowId === keepWindowId) continue; // never the just-created runner window
			if (!SCAFFOLD_SHELL_NAMES.has(windowName)) continue;
			execFileFn("tmux", ["kill-window", "-t", windowId]);
			return; // at most one scaffold
		}
	} catch {
		// best-effort — never block or fail a spawn on scaffold pruning.
	}
}

/**
 * FLY-154 hotfix: exported for direct unit testing of the stderr-capture
 * wrapping. Production callers should still use the default constructor
 * which wires this in automatically.
 */
export function defaultExecFile(
	cmd: string,
	args: string[],
	opts?: ExecFileOpts,
): { stdout: string } {
	try {
		const result = execFileSync(cmd, args, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			// FLY-494: undefined → Node's default (0 = no timeout) = byte-identical
			// for every existing call site that omits opts. A positive value kills
			// the child on timeout so a bounded probe can fail closed.
			timeout: opts?.timeoutMs,
			// FLY-494: MERGE over process.env (never replace — PATH etc. must
			// survive) so a caller can force e.g. NODE_OPTIONS for one exec.
			// undefined → execFileSync inherits process.env = byte-identical.
			env: opts?.env ? { ...process.env, ...opts.env } : undefined,
		});
		return { stdout: result };
	} catch (err) {
		// FLY-154 hotfix: execFileSync's default error.message is just
		// `Command failed: <cmd>` — it does NOT include stderr, even though
		// `error.stderr` is populated. qa-fly-372 spent a full Bridge restart
		// cycle guessing the cause of a "tmux command too long" failure
		// because Bridge logs only saw the truncated cmd line. Wrap to surface
		// stderr (+ stdout if non-empty) in the thrown message so future
		// failures are observable without re-running. Preserves all other
		// fields (.stderr, .stdout, .status, .signal) for callers that read
		// them programmatically.
		if (err instanceof Error) {
			const e = err as Error & {
				stderr?: string | Buffer;
				stdout?: string | Buffer;
				status?: number;
				signal?: string | null;
			};
			const stderrStr = e.stderr
				? Buffer.isBuffer(e.stderr)
					? e.stderr.toString("utf-8")
					: String(e.stderr)
				: "";
			const stdoutStr = e.stdout
				? Buffer.isBuffer(e.stdout)
					? e.stdout.toString("utf-8")
					: String(e.stdout)
				: "";
			const detail = [
				stderrStr.trim() ? `stderr: ${stderrStr.trim()}` : "",
				stdoutStr.trim() ? `stdout: ${stdoutStr.trim()}` : "",
				e.status != null ? `status: ${e.status}` : "",
				e.signal ? `signal: ${e.signal}` : "",
			]
				.filter(Boolean)
				.join(" | ");
			if (detail) {
				e.message = `${e.message} (${detail})`;
			}
		}
		throw err;
	}
}

export function defaultAsyncExecFile(
	cmd: string,
	args: string[],
	opts?: ExecFileOpts,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFileCallback(
			cmd,
			args,
			{
				encoding: "utf8",
				timeout: opts?.timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
				env: opts?.env ? { ...process.env, ...opts.env } : undefined,
			},
			(error, stdout, stderr) => {
				if (error) {
					const enriched = error as Error & {
						stdout?: string;
						stderr?: string;
					};
					enriched.stdout = stdout;
					enriched.stderr = stderr;
					reject(enriched);
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}
