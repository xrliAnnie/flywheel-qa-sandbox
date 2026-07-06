/**
 * CodexTmuxAdapter — FLY-123 Phase 1: launches a Codex runner in a tmux
 * window using the Option A gate model validated by Spike-δ
 * (doc/engineer/research/new/FLY-123-spike-delta-gate-semantics.md):
 * **process boundary = gate**. `codex exec` runs to a pause point and
 * exits; the Lead's reply triggers `codex exec resume <threadId>`.
 *
 * ARCHITECTURE (plan §5.6, Codex design review R1 #1): `execute()` OWNS the
 * gate loop and resolves only at a true terminal state. Blueprint stays
 * untouched — it awaits one `execute()` exactly like the Claude path.
 *
 *   spawning → running → (exit + unanswered marker) awaiting_gate
 *                      → (exit + no marker)          terminal
 *   awaiting_gate → (wake → idle-gate → inject helper) resuming → running
 *   awaiting_gate → (deadline)                         terminal (fail-close)
 *
 * Mechanics (uniform across cycles — the spike's empirical shape):
 * - the tmux window hosts a BARE SHELL (long-lived; pane death = crash);
 * - every codex cycle is launched by injecting the FIXED-SHAPE command
 *   `node <flywheel-comm> codex-resume --state <file> [--message <key>]`
 *   into the idle shell. ALL variable content (prompt / Lead reply) rides
 *   0600 state+prompt files → codex stdin (R2 #2 zero-interpolation);
 * - cycle completion is signalled by the helper's done-marker file (NOT
 *   pane death);
 * - injection requires the 3-gate idle check (Spike-δ reproduced the
 *   hazard: bytes typed into a busy pane execute in the shell after codex
 *   exits — §5.4 timing gate);
 * - `awaiting_gate` deadline is OWNED HERE (R2 #1 — the FLY-159 timeout
 *   loop lives inside the blocking gate process, which a Codex runner
 *   never runs): on expiry we expire the CommDB question, clear the
 *   marker, emit a `gate_timed_out` payload isomorphic to FLY-159's, and
 *   resolve fail-close.
 */

import { randomUUID } from "node:crypto";
import {
	accessSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	defaultGateMarkerDir,
	type GateMarker,
	listGateMarkersForExecution,
	removeGateMarker,
} from "flywheel-comm/gate-marker";
import { PONYTAIL_RULESET } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	AdapterHealthCheck,
	IAdapter,
	IHookCallbackServer,
} from "flywheel-core";
import { sanitizeTmuxName } from "flywheel-core";
import {
	flywheelCodexBin,
	provisionCodexHome,
	removeCodexHome,
	SECRET_ENV_VARS,
	scrubCodexHomeCredential,
} from "./codex-home.js";
import type { ExecFileFn } from "./TmuxAdapter.js";
import {
	defaultExecFile,
	ensureRunnerSession,
	pruneScaffoldWindow,
} from "./TmuxAdapter.js";

/**
 * Structural surface of the codex transport this executor needs. Kept
 * structural (no agent-team-transport import) for the same reason as
 * TmuxAdapter's RunnerSpawnTransport — claude-runner must not couple to a
 * vendor transport package.
 */
export interface CodexRunnerTransport {
	buildRunnerSpawnConfig(ctx: {
		leadName: string;
		runnerName: string;
		teamName: string;
		[key: string]: unknown;
	}): { args: string[]; env: Record<string, string> };
	createReceiver(ctx: {
		leadName: string;
		runnerName: string;
		teamName: string;
		[key: string]: unknown;
	}): CodexWakeWatcher | null;
}

export interface CodexWakeWatcher {
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): Promise<{ ok: boolean; lastEventTs?: number }>;
	onDelivered?: (msg: {
		id: string;
		content: string;
		metadata?: Record<string, unknown>;
	}) => void;
}

interface CycleOutcome {
	exitCode: number;
	threadId?: string;
	lastMessage?: string;
}

interface DoneMarker {
	exitCode: number;
	ts: string;
	mode: string;
	threadId?: string;
}

/** Shell-prompt sigils for the bare-shell idle gate (zsh `%`, bash `$`). */
const PROMPT_SIGILS = ["%", "$"];
const SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "-zsh", "-bash"]);
const IDLE_GATE_ATTEMPTS = 10;
const IDLE_GATE_RETRY_MS = 3000;
/** Charset for values embedded in the injected command line (paths/keys). */
const SAFE_INJECTION_TOKEN = /^[a-zA-Z0-9/_.:@-]+$/;

export function codexSessionStateDir(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const base =
		env.FLYWHEEL_CODEX_SESSION_DIR?.trim() ||
		join(homedir(), ".flywheel", "state", "codex-sessions");
	return join(base, executionId);
}

export class CodexTmuxAdapter implements IAdapter {
	readonly type = "codex-tmux";
	readonly supportsStreaming = false;
	private preflightDone = false;
	/** Window name we created — injection gate 0 (managed identity, MEDIUM-3). */
	private managedWindowName?: string;

	constructor(
		private sessionName: string = "flywheel",
		private execFileFn: ExecFileFn = defaultExecFile,
		private pollIntervalMs: number = 5000,
		private defaultTimeoutMs: number = 86_400_000, // 24h active budget per cycle (mirrors TmuxAdapter)
		// hookServer accepted for constructor-position parity with TmuxAdapter
		// (run-infra registers both via the same factory shape) — unused: cycle
		// completion is done-marker based, not HTTP-callback based.
		_hookServer?: IHookCallbackServer,
		private transport?: CodexRunnerTransport,
	) {}

	async checkEnvironment(): Promise<AdapterHealthCheck> {
		// PRECONDITION (QA Finding 2): `codex exec` hard-refuses a non-git cwd
		// ("Not inside a trusted directory") unless --skip-git-repo-check is
		// passed — which we deliberately do NOT pass. Production always runs
		// in a git worktree (WorktreeManager) or the project root (git repo),
		// so this holds; any future non-git execution path must address it.
		try {
			const tmux = this.execFileFn("tmux", ["-V"]).stdout.trim();
			const codex = this.execFileFn("codex", ["--version"]).stdout.trim();
			// FLY-123 WS-B (R1 LOW #6): runners use the repo-owned, CODEX_HOME-
			// aware rotation shim (via FLYWHEEL_CODEX_BIN), NOT Annie's global
			// codex-with-fallback. Health-check the actual shim is executable —
			// a clean host without the global wrapper must still be healthy.
			const shim = flywheelCodexBin();
			accessSync(shim, fsConstants.X_OK);
			return {
				healthy: true,
				message: "tmux, codex CLI and repo rotation shim available",
				details: { tmux, codex, shim },
			};
		} catch (err) {
			return {
				healthy: false,
				message: `Environment check failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	/**
	 * FLY-209: extract the host gh token + wire the worktree to use gh's git
	 * credential helper. Returns the token (for the per-cycle GH_TOKEN env
	 * injection) or undefined if gh isn't authenticated — in which case the
	 * runner simply can't push (it will fail closed at the push step, same as
	 * the pre-FLY-209 behavior), which is non-fatal to the rest of the run.
	 *
	 * Token validation: gh tokens are `[A-Za-z0-9_-]`; reject anything else so
	 * a corrupted value never reaches the codex `-c` TOML string (the helper
	 * re-validates with the same charset, defense in depth).
	 */
	private provisionGitHubCredential(
		ctx: AdapterExecutionContext,
	): string | undefined {
		let token: string;
		try {
			token = this.execFileFn("gh", ["auth", "token"]).stdout.trim();
		} catch {
			console.warn(
				`[CodexTmuxAdapter] gh auth token unavailable for ${ctx.executionId} — Codex runner will not be able to push/open PRs (fail-closed at push).`,
			);
			return undefined;
		}
		if (!/^[A-Za-z0-9_-]{1,255}$/.test(token)) {
			console.warn(
				`[CodexTmuxAdapter] gh auth token has unexpected format for ${ctx.executionId} — skipping credential injection.`,
			);
			return undefined;
		}
		// Configure the worktree's git: (1) resolve https pushes via gh (reads
		// GH_TOKEN from the per-cycle sandbox env); (2) rewrite ssh→https for
		// github so the push uses the token path even if the project's origin
		// is an ssh remote — the ssh agent socket is sandbox-blocked, so ssh
		// can never work for a Codex runner. Scoped to github.com; best-effort.
		try {
			this.execFileFn("git", [
				"-C",
				ctx.cwd,
				"config",
				"credential.https://github.com.helper",
				"!gh auth git-credential",
			]);
			this.execFileFn("git", [
				"-C",
				ctx.cwd,
				"config",
				"url.https://github.com/.insteadOf",
				"git@github.com:",
			]);
		} catch (err) {
			console.warn(
				`[CodexTmuxAdapter] failed to set git credential config for ${ctx.executionId}: ${(err as Error).message}`,
			);
		}
		return token;
	}

	async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
		if (!this.preflightDone) {
			this.execFileFn("tmux", ["-V"]);
			this.execFileFn("codex", ["--version"]);
			this.preflightDone = true;
		}

		const start = Date.now();
		const stateDir = codexSessionStateDir(ctx.executionId);
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const gateMarkerDir = defaultGateMarkerDir();

		// FLY-209 (credentials): the Codex runner is sandboxed (Seatbelt blocks
		// the keychain) so it cannot reach the host's gh/git auth the way the
		// unsandboxed Claude runner does. Extract the host gh token once (the
		// Bridge runs as the user, with keychain access) and (a) inject it into
		// the sandbox shell env as GH_TOKEN per cycle (gh + git push), (b)
		// configure the worktree to use gh's git credential helper so https
		// push resolves the token. Posture A (Annie-approved): forward the
		// existing gh token, minimal surface — no whole-keychain dump, no ssh
		// (the agent socket is sandbox-blocked; we route push over https).
		const ghToken = this.provisionGitHubCredential(ctx);

		// FLY-123 WS-A + WS-C: provision a per-runner CODEX_HOME (isolated
		// auth.json + config.toml) so concurrent Codex runners don't corrupt
		// each other's account state, and so GH_TOKEN rides the 0600
		// config.toml — NOT the codex argv (ps-visible) or the cycle state
		// file. CODEX_HOME is injected into the tmux window env below so the
		// injected helper AND every resume cycle inherit the same isolated home.
		const codexHome = provisionCodexHome({
			executionId: ctx.executionId,
			ghToken,
		});

		// ── Window setup: bare shell, env injected at window level ──
		this.ensureSession();
		this.execFileFn("tmux", [
			"set-option",
			"-t",
			`=${this.sessionName}:`,
			"remain-on-exit",
			"on",
		]);

		const envArgs = this.buildWindowEnvArgs(
			ctx,
			stateDir,
			gateMarkerDir,
			codexHome,
		);
		const windowName = sanitizeTmuxName(ctx.label ?? `codex-${Date.now()}`);
		this.managedWindowName = windowName;
		const launch = this.execFileFn("tmux", [
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
			ctx.cwd,
			// no trailing command → default shell (the long-lived injection host)
		]);
		const windowId = launch.stdout.trim();

		// FLY-245 R5 HIGH-3: the durable COMMIT for a Codex Runner is written at the
		// injection point (right before the FIRST `send-keys` that launches codex,
		// in `injectAtIdlePrompt`) — NOT here. Until then the window is just a bare
		// shell with no codex; a crash before that injection leaves NO commit file,
		// so the dispatcher re-drives (never adopts the idle bare shell as a started
		// Runner). `ctx.launchCommitPath` (gateway path only) is threaded to the
		// injection.

		// FLY-758: same win0 scaffold prune as TmuxAdapter (codex has its own
		// execute()). The codex runner window is created with `-n windowName`, so
		// it never matches the bare-shell scaffold predicate; keepWindowId adds a
		// second guard. Best-effort — never blocks the spawn.
		pruneScaffoldWindow(this.execFileFn, this.sessionName, windowId);

		// CommDB session registration (parity with TmuxAdapter)
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
				);
				commDb.close();
				registeredSession = true;
			} catch {
				// non-fatal (same as TmuxAdapter)
			}
		}

		ctx.onHeartbeat?.(ctx.executionId);
		if (ctx.onTmuxWindowCreated) {
			try {
				ctx.onTmuxWindowCreated({
					baseSessionName: this.sessionName,
					windowId,
				});
			} catch (err) {
				console.warn(
					`[CodexTmuxAdapter] onTmuxWindowCreated failed: ${(err as Error).message}`,
				);
			}
		}

		// ── Wake watcher (lifecycle owner = this execute(), R1 #2) ──
		// Any delivered mailbox message short-circuits the awaiting_gate wait
		// tick; the loop then re-checks CommDB for answered questions. The
		// message content itself carries NO authority (wake = hint).
		let wakeNotify: (() => void) | null = null;
		let watcher: CodexWakeWatcher | null = null;
		if (this.transport && ctx.agentName && ctx.teamName) {
			watcher = this.transport.createReceiver({
				leadName: ctx.leadId ?? ctx.teamName,
				runnerName: ctx.agentName,
				teamName: ctx.teamName,
				executionId: ctx.executionId,
				tmuxTarget: `${this.sessionName}:${windowId}`,
				cwd: ctx.cwd,
			});
			if (watcher) {
				watcher.onDelivered = () => {
					wakeNotify?.();
				};
				await watcher.start();
			}
		}

		const waitForWakeOrTick = (ms: number): Promise<void> =>
			new Promise((resolve) => {
				const timer = setTimeout(() => {
					wakeNotify = null;
					resolve();
				}, ms);
				wakeNotify = () => {
					clearTimeout(timer);
					wakeNotify = null;
					resolve();
				};
			});

		// ── Gate loop (§5.6) ──
		let cycle = 0;
		let threadId: string | undefined =
			typeof ctx.previousSession?.threadId === "string"
				? (ctx.previousSession.threadId as string)
				: undefined;
		let timedOut = false;
		let lastExitCode = 1;
		let lastMessage: string | undefined;
		let failureReason: string | undefined;

		// Codex has no --append-system-prompt-file: fold the system prompt
		// into the dynamic prompt text (plan §5.5 — AGENTS.md handles the
		// persistent layer; the dynamic layer is per-execution).
		// FLY-615: Codex can't load the real ponytail plugin (headless, no
		// interactive hook-trust), so when ponytail is enabled for this run we
		// inject the portable ponytail-style ruleset into the instruction layer.
		// Equivalent ruleset, not the plugin's per-turn hooks (caveat for 616).
		const systemLayer = ctx.enablePonytail
			? ctx.appendSystemPrompt
				? `${PONYTAIL_RULESET}\n\n---\n\n${ctx.appendSystemPrompt}`
				: PONYTAIL_RULESET
			: ctx.appendSystemPrompt;
		let nextPrompt = systemLayer
			? `${systemLayer}\n\n---\n\n${ctx.prompt}`
			: ctx.prompt;

		try {
			runLoop: while (true) {
				// 1. Launch a cycle (fresh first time, resume afterwards).
				const outcome = await this.runCycle(
					ctx,
					windowId,
					stateDir,
					cycle,
					threadId,
					nextPrompt,
					start,
				);
				if (outcome === "active_timeout" || outcome === "pane_died") {
					timedOut = outcome === "active_timeout";
					failureReason =
						outcome === "active_timeout"
							? "codex cycle exceeded active timeout"
							: "runner shell pane died";
					break;
				}
				cycle++;
				lastExitCode = outcome.exitCode;
				if (outcome.threadId) threadId = outcome.threadId;
				if (outcome.lastMessage !== undefined)
					lastMessage = outcome.lastMessage;
				this.persistSessionState(stateDir, ctx, windowId, threadId);

				if (outcome.exitCode !== 0) {
					failureReason = `codex exited ${outcome.exitCode}`;
					break;
				}

				// 2. Classify (code review R1 HIGH-1): ANY marker for this
				// execution — answered or not — means the runner paused at a
				// gate. A fast Lead response (respond marks the marker answered
				// before we classify) must still be consumed and resumed, never
				// misread as terminal. Terminal ONLY when no marker exists.
				const executionMarkers = listGateMarkersForExecution(
					gateMarkerDir,
					ctx.executionId,
				);
				if (executionMarkers.length === 0) {
					break; // terminal success
				}

				// 3. awaiting_gate — adapter-owned, MARKER-CONFIGURED deadline
				// (R2 #1 + code review R1 HIGH-2): each marker carries its
				// checkpoint's --timeout/--timeout-behavior; honor them exactly
				// as the blocking gate would (FLY-159 parity). Config-less
				// markers fall back to ctx.waitingTimeoutMs (49h per-wait).
				const fallbackTimeoutMs = ctx.waitingTimeoutMs ?? 176_400_000;
				const waitStart = Date.now();
				let resumed = false;
				while (true) {
					ctx.onHeartbeat?.(ctx.executionId);

					// (a) Answered? Checked FIRST — a response that landed
					// before/while we classified is consumed immediately
					// (HIGH-1 regression case). Primary signal is the watcher
					// wake (event-driven); this CommDB read is the defense-in-
					// depth belt at the SAME cadence the Claude path already
					// polls CommDB (checkDynamicTimeout precedent).
					const answered = this.findAnsweredMarker(ctx, gateMarkerDir);
					if (answered) {
						removeGateMarkerSafely(gateMarkerDir, answered.marker.questionId);
						nextPrompt = `LEAD RESPONSE to your ${answered.marker.checkpoint} gate question:\n\n${answered.reply}`;
						resumed = true;
						break;
					}

					// (b) Per-marker deadlines.
					const now = Date.now();
					const currentMarkers = listGateMarkersForExecution(
						gateMarkerDir,
						ctx.executionId,
					);
					if (currentMarkers.length === 0) {
						// Markers vanished without an answer (external cleanup) —
						// nothing left to wait on.
						break;
					}
					const isExpired = (m: GateMarker): boolean => {
						const createdAt = Date.parse(m.createdAt);
						const anchor = Number.isFinite(createdAt) ? createdAt : waitStart;
						return now - anchor > (m.timeoutMs ?? fallbackTimeoutMs);
					};
					const behaviorOf = (m: GateMarker) =>
						m.timeoutBehavior ?? "fail-close";
					const expired = currentMarkers.filter(isExpired);
					if (expired.some((m) => behaviorOf(m) === "fail-close")) {
						// fail-close (default): expire questions, emit
						// gate_timed_out for the fail-close ones (FLY-159 parity
						// — fail-open never emits), terminal failure.
						timedOut = true;
						failureReason = "gate deadline expired (fail-close)";
						for (const marker of expired) {
							this.expireQuestionSafely(ctx, marker.questionId);
							if (behaviorOf(marker) === "fail-close") {
								await this.emitGateTimedOut(ctx, marker, now - waitStart);
							}
							removeGateMarkerSafely(gateMarkerDir, marker.questionId);
						}
						break runLoop;
					}
					if (expired.length > 0) {
						// fail-open: expire + clear, NO event (FLY-159 fail-open
						// is silent by design); resume the runner with an
						// explicit timeout/continue prompt.
						for (const marker of expired) {
							this.expireQuestionSafely(ctx, marker.questionId);
							removeGateMarkerSafely(gateMarkerDir, marker.questionId);
						}
						const cp = expired[0]?.checkpoint ?? "gate";
						nextPrompt =
							`GATE TIMEOUT (fail-open) on your ${cp} checkpoint: no Lead response arrived within the configured timeout. ` +
							"Per fail-open semantics, CONTINUE using your best judgment.";
						resumed = true;
						break;
					}

					if (this.isPaneDead(windowId)) {
						failureReason = "runner shell pane died while awaiting gate";
						break runLoop;
					}
					await waitForWakeOrTick(this.pollIntervalMs);
				}

				if (!resumed) {
					// markers vanished without an answer — nothing to resume
					break;
				}
				// loop → resuming → running (next cycle injects the reply)
			}
		} finally {
			await watcher?.stop().catch(() => {});
			if (registeredSession && ctx.commDbPath) {
				try {
					const commDb = new CommDB(ctx.commDbPath);
					commDb.updateSessionStatus(
						ctx.executionId,
						timedOut ? "timeout" : "completed",
					);
					commDb.close();
				} catch {
					// non-fatal
				}
			}
			if (timedOut || failureReason === "runner shell pane died") {
				try {
					this.execFileFn("tmux", ["kill-window", "-t", windowId]);
				} catch {
					// window may already be gone
				}
			}
			// FLY-123 P5 (credential-residue invariant): we are TERMINAL here —
			// the whole gate loop (incl. every awaiting_gate wait) lives inside
			// this execute(), so reaching finally means no further resume of this
			// execution. Scrub the live GH_TOKEN from the retained home's
			// config.toml so a long-lived home never hoards a credential. The
			// home dir itself (auth shell + sessions) is removed at explicit
			// retirement (removeCodexSessionState → removeCodexHome).
			scrubCodexHomeCredential(ctx.executionId);
		}

		const success = lastExitCode === 0 && !timedOut && !failureReason;
		const result: AdapterExecutionResult = {
			success,
			sessionId: threadId ?? ctx.executionId,
			tmuxWindow: `${this.sessionName}:${windowId}`,
			durationMs: Date.now() - start,
			timedOut,
			sessionParams: {
				vendor: "codex",
				...(threadId && { threadId }),
			},
		};
		if (lastMessage !== undefined) result.resultText = lastMessage;
		if (!success && failureReason) {
			console.error(
				`[CodexTmuxAdapter] ${ctx.executionId} failed: ${failureReason}`,
			);
		}
		return result;
	}

	// ── Cycle mechanics ─────────────────────────────────────────────────

	/**
	 * Launch one codex cycle via the helper and wait for its done marker.
	 * Returns the parsed outcome, or "active_timeout" / "pane_died".
	 */
	private async runCycle(
		ctx: AdapterExecutionContext,
		windowId: string,
		stateDir: string,
		cycle: number,
		threadId: string | undefined,
		prompt: string,
		_executeStart: number,
	): Promise<CycleOutcome | "active_timeout" | "pane_died"> {
		const promptPath = join(stateDir, `prompt-${cycle}.txt`);
		const statePath = join(stateDir, `state-${cycle}.json`);
		const jsonlPath = join(stateDir, `out-${cycle}.jsonl`);
		const lastMessagePath = join(stateDir, `last-${cycle}.txt`);
		const doneMarkerPath = join(stateDir, `done-${cycle}.json`);

		writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });
		const mode = threadId ? "resume" : "fresh";
		const state: Record<string, unknown> = {
			version: 1,
			mode,
			promptPath,
			cwd: ctx.cwd,
			sandbox: "workspace-write",
			// QA Finding 1 (HIGH): bare workspace-write denies ~/.flywheel +
			// ALL network → flywheel-comm gate/stage/complete fail inside the
			// runner ("unable to open database file"), no marker is written,
			// the adapter misreads the exit as terminal success, and git
			// push / gh / Bridge POST are impossible. Grant the flywheel state
			// roots (incl. env-redirected QA dirs) + network. Posture: still
			// strictly tighter than the Claude runner (bypassPermissions, no
			// OS sandbox). Sandbox params persist across exec resume —
			// fresh-mode only.
			writableRoots: [
				...new Set([
					join(homedir(), ".flywheel"),
					defaultGateMarkerDir(),
					...(ctx.commDbPath ? [dirname(ctx.commDbPath)] : []),
				]),
			],
			networkAccess: true,
			jsonlPath,
			lastMessagePath,
			doneMarkerPath,
		};
		// FLY-123 WS-C: GH_TOKEN is NO LONGER carried in the cycle state file or
		// the codex argv. It lives only in the per-runner 0600
		// $CODEX_HOME/config.toml ([shell_environment_policy.set]); codex picks
		// it up via CODEX_HOME (window env). The state file carries paths/
		// metadata only — never a credential.
		if (threadId) state.threadId = threadId;
		if (ctx.model) state.model = ctx.model;
		writeFileSync(statePath, JSON.stringify(state, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});

		await this.injectAtIdlePrompt(
			windowId,
			statePath,
			undefined,
			ctx.launchCommitPath,
		);

		// Wait for the done marker (heartbeats + active timeout + pane probe).
		const activeBudget = ctx.timeoutMs ?? this.defaultTimeoutMs;
		const cycleStart = Date.now();
		while (!existsSync(doneMarkerPath)) {
			ctx.onHeartbeat?.(ctx.executionId);
			if (Date.now() - cycleStart > activeBudget) return "active_timeout";
			if (this.isPaneDead(windowId)) return "pane_died";
			await sleep(this.pollIntervalMs);
		}

		const marker = JSON.parse(
			readFileSync(doneMarkerPath, "utf-8"),
		) as DoneMarker;
		const outcome: CycleOutcome = { exitCode: marker.exitCode };

		const parsedThreadId = this.parseThreadId(jsonlPath);
		if (parsedThreadId) outcome.threadId = parsedThreadId;
		else if (marker.threadId) outcome.threadId = marker.threadId;

		if (existsSync(lastMessagePath)) {
			outcome.lastMessage = readFileSync(lastMessagePath, "utf-8").trim();
		}
		return outcome;
	}

	/**
	 * §5.4 injection safety — timing gate (3 checks) + content gate (fixed
	 * shape, validated tokens). Throws after bounded retries: a blind
	 * injection is a shell-command-injection hazard (Spike-δ reproduced).
	 */
	private async injectAtIdlePrompt(
		windowId: string,
		statePath: string,
		dedupeKey?: string,
		/** FLY-245 R5: gateway-retry durable commit path. Written the INSTANT
		 * before the codex `send-keys` (the commit point), so the dispatcher's
		 * adopt sees a committed Runner only once codex is actually injected. */
		commitPath?: string,
	): Promise<void> {
		const commCli = this.resolveCommCli();
		for (const token of [commCli, statePath]) {
			if (!SAFE_INJECTION_TOKEN.test(token)) {
				throw new Error(
					`[CodexTmuxAdapter] refusing to inject unsafe token "${token}"`,
				);
			}
		}
		if (dedupeKey && !SAFE_INJECTION_TOKEN.test(dedupeKey)) {
			throw new Error(
				`[CodexTmuxAdapter] refusing to inject unsafe dedupe key`,
			);
		}

		for (let attempt = 0; attempt < IDLE_GATE_ATTEMPTS; attempt++) {
			if (this.isPaneIdleShell(windowId)) {
				const cmd = [
					"node",
					commCli,
					"codex-resume",
					"--state",
					statePath,
					...(dedupeKey ? ["--message", dedupeKey] : []),
				].join(" ");
				// R5 HIGH-3: write the durable commit IMMEDIATELY before send-keys (the
				// single codex commit point). Idempotent across resume cycles. A failure
				// here aborts before injection → no commit → the dispatcher re-drives.
				if (commitPath) {
					mkdirSync(dirname(commitPath), { recursive: true });
					writeFileSync(commitPath, "");
				}
				this.execFileFn("tmux", ["send-keys", "-t", windowId, cmd, "Enter"]);
				return;
			}
			// retry cadence follows pollIntervalMs when it's faster (tests);
			// production default stays 3s
			await sleep(Math.min(IDLE_GATE_RETRY_MS, this.pollIntervalMs));
		}
		throw new Error(
			`[CodexTmuxAdapter] pane ${windowId} never reached idle shell prompt after ${IDLE_GATE_ATTEMPTS} attempts — refusing blind injection (FLY-169 gate)`,
		);
	}

	/**
	 * FLY-169-fidelity injection gates (code review R1 MEDIUM-3):
	 * (0) MANAGED — the window is still the one we created (name matches);
	 * (1) UNATTACHED — zero clients on the base runner session (a human
	 *     attached directly could be mid-keystroke; FLY-116 Terminal viewers
	 *     attach to grouped `viewer-*` sessions and are NOT counted here);
	 * (2) ALIVE+SHELL — pane alive and foreground is a bare shell;
	 * (3) PROMPT — visible tail line ends with a shell prompt sigil.
	 */
	private isPaneIdleShell(windowId: string): boolean {
		try {
			// Gate 0: managed window identity.
			if (this.managedWindowName) {
				const name = this.execFileFn("tmux", [
					"display-message",
					"-p",
					"-t",
					windowId,
					"#{window_name}",
				]).stdout.trim();
				if (name !== this.managedWindowName) return false;
			}

			// Gate 1: no clients attached to the base session.
			const clients = this.execFileFn("tmux", [
				"list-clients",
				"-t",
				`=${this.sessionName}`,
			]).stdout.trim();
			if (clients.length > 0) return false;

			// Gate 2: pane alive + bare shell foreground.
			const info = this.execFileFn("tmux", [
				"list-panes",
				"-t",
				windowId,
				"-F",
				"#{pane_dead}|#{pane_current_command}",
			]).stdout.trim();
			const [dead, cmd] = info.split("|");
			if (dead !== "0") return false;
			if (!cmd || !SHELL_COMMANDS.has(cmd)) return false;

			// Gate 3: prompt sigil on the visible tail.
			const tail = this.execFileFn("tmux", [
				"capture-pane",
				"-t",
				windowId,
				"-p",
			])
				.stdout.split("\n")
				.map((l) => l.trimEnd())
				.filter((l) => l.length > 0)
				.pop();
			if (!tail) return false;
			return PROMPT_SIGILS.some((sigil) => tail.trimEnd().endsWith(sigil));
		} catch {
			return false;
		}
	}

	private isPaneDead(windowId: string): boolean {
		try {
			const out = this.execFileFn("tmux", [
				"list-panes",
				"-t",
				windowId,
				"-F",
				"#{pane_dead}",
			]).stdout.trim();
			return out === "1";
		} catch {
			return true; // window gone
		}
	}

	/** First `thread.started` event in the cycle JSONL → resume handle. */
	private parseThreadId(jsonlPath: string): string | undefined {
		if (!existsSync(jsonlPath)) return undefined;
		try {
			for (const line of readFileSync(jsonlPath, "utf-8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const evt = JSON.parse(line);
					if (
						evt.type === "thread.started" &&
						typeof evt.thread_id === "string"
					) {
						return evt.thread_id;
					}
				} catch {
					// tolerate non-JSON lines (wrapper banners)
				}
			}
		} catch {
			// unreadable — resume handle unavailable this cycle
		}
		return undefined;
	}

	// ── awaiting_gate helpers ───────────────────────────────────────────

	/** First pending marker whose question now has a response (+ the reply). */
	private findAnsweredMarker(
		ctx: AdapterExecutionContext,
		gateMarkerDir: string,
	): { marker: GateMarker; reply: string } | undefined {
		if (!ctx.commDbPath || !existsSync(ctx.commDbPath)) return undefined;
		const markers = listGateMarkersForExecution(gateMarkerDir, ctx.executionId);
		if (markers.length === 0) return undefined;
		try {
			const db = CommDB.openReadonly(ctx.commDbPath);
			try {
				for (const marker of markers) {
					const response = db.getResponse(marker.questionId);
					if (response) return { marker, reply: response.content };
				}
			} finally {
				db.close();
			}
		} catch {
			// DB unavailable this tick — retry next tick
		}
		return undefined;
	}

	private expireQuestionSafely(
		ctx: AdapterExecutionContext,
		questionId: string,
	): void {
		if (!ctx.commDbPath) return;
		try {
			const db = new CommDB(ctx.commDbPath);
			try {
				db.resolveGate(questionId, 0); // expire NOW (FLY-159 cleanup shape)
			} finally {
				db.close();
			}
		} catch {
			// best-effort — TTL reaps eventually
		}
	}

	/** FLY-159-isomorphic gate_timed_out payload via the Bridge /events route. */
	private async emitGateTimedOut(
		ctx: AdapterExecutionContext,
		marker: GateMarker,
		waitedMs: number,
	): Promise<void> {
		if (!ctx.bridgeUrl || !ctx.projectName) return;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (ctx.bridgeIngestToken)
			headers.Authorization = `Bearer ${ctx.bridgeIngestToken}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		try {
			await fetch(`${ctx.bridgeUrl}/events`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					event_id: randomUUID(),
					execution_id: ctx.executionId,
					issue_id: ctx.issueId,
					project_name: ctx.projectName,
					event_type: "gate_timed_out",
					source: "codex-tmux-adapter",
					payload: {
						checkpoint: marker.checkpoint,
						exec_id: ctx.executionId,
						lead_id: ctx.leadId ?? "unknown",
						waited_ms: waitedMs,
						// code review R1 HIGH-2: FLY-159 payload parity — carry
						// the marker's recorded gate config, not constants.
						original_message: marker.message ?? "(codex no-block gate)",
						timeout_behavior: marker.timeoutBehavior ?? "fail-close",
						timeout_behavior_source: marker.timeoutBehaviorSource ?? "default",
						question_id: marker.questionId,
					},
				}),
				signal: controller.signal,
			});
		} catch {
			// best-effort — we are already failing closed
		} finally {
			clearTimeout(timer);
		}
	}

	// ── Setup helpers ───────────────────────────────────────────────────

	private buildWindowEnvArgs(
		ctx: AdapterExecutionContext,
		_stateDir: string,
		gateMarkerDir: string,
		codexHome: string,
	): string[] {
		const envArgs: string[] = [];
		const push = (key: string, value: string) => {
			envArgs.push("-e", `${key}=${value}`);
		};

		// FLY-123 WS-A: isolate the runner's codex account state + config (incl.
		// the GH_TOKEN credential, WS-C). Set at the WINDOW level so the bare
		// shell, the injected codex-resume helper, and every resume cycle all
		// inherit the same per-runner home (codex reads $CODEX_HOME/{auth.json,
		// config.toml}).
		push("CODEX_HOME", codexHome);
		// FLY-123 WS-B (P1=4-C): point runner traffic at the repo-owned,
		// CODEX_HOME-aware rotation shim — Annie's global codex-with-fallback /
		// codex-profile are never selected for runners. The shim rotates each
		// home's OWN auth.json from the shared seed pool, so concurrent runners
		// don't clobber each other's account state.
		push("FLYWHEEL_CODEX_BIN", flywheelCodexBin());
		// Propagate an explicit shared-pool override (default = ~/.codex/profiles
		// resolves correctly inside the runner window, so only push when set).
		if (process.env.FLYWHEEL_CODEX_PROFILES_DIR) {
			push(
				"FLYWHEEL_CODEX_PROFILES_DIR",
				process.env.FLYWHEEL_CODEX_PROFILES_DIR,
			);
		}
		// FLY-123 WS-C (R1 HIGH #1): BLANK any inherited GitHub-token env in the
		// runner window so the token never reaches the node/shim/codex process
		// env (ps-visible). Its only surface is the 0600 config.toml; codex
		// injects it into the SANDBOX shell from there. tmux `-e KEY=` sets the
		// var empty in the window, overriding an inherited tmux-server value.
		for (const secret of SECRET_ENV_VARS) push(secret, "");

		// Codex gate protocol env (consumed by `flywheel-comm gate --no-block`)
		push("FLYWHEEL_GATE_MARKER_DIR", gateMarkerDir);
		push("FLYWHEEL_RUNNER_BACKEND_ID", "codex-tmux");
		push("FLYWHEEL_RUNNER_VENDOR_ID", "codex");

		// Comm plumbing (parity with TmuxAdapter)
		if (ctx.commDbPath) push("FLYWHEEL_COMM_DB", ctx.commDbPath);
		push("FLYWHEEL_EXEC_ID", ctx.executionId);
		push("FLYWHEEL_ISSUE_ID", ctx.issueId ?? "unknown");
		if (ctx.bridgeUrl) push("FLYWHEEL_BRIDGE_URL", ctx.bridgeUrl);
		if (ctx.bridgeIngestToken)
			push("FLYWHEEL_INGEST_TOKEN", ctx.bridgeIngestToken);
		if (ctx.stateDbPath) push("FLYWHEEL_STATE_DB_PATH", ctx.stateDbPath);
		if (ctx.progressPath) push("FLYWHEEL_PROGRESS_PATH", ctx.progressPath); // FLY-795
		if (ctx.projectName) push("FLYWHEEL_PROJECT_NAME", ctx.projectName);
		if (ctx.leadId) push("FLYWHEEL_LEAD_ID", ctx.leadId);
		if (ctx.sentinelPath) push("FLYWHEEL_LAND_STATUS_PATH", ctx.sentinelPath);
		try {
			push("FLYWHEEL_COMM_CLI", this.resolveCommCli());
		} catch {
			// gate instructions fall back to manual mode
		}

		// Transport identity env (no claude flags — R1 #9; codex argv is
		// owned by the helper, not the transport).
		if (this.transport && ctx.agentName && ctx.teamName) {
			try {
				const spawnConfig = this.transport.buildRunnerSpawnConfig({
					leadName: ctx.leadId ?? ctx.teamName,
					runnerName: ctx.agentName,
					teamName: ctx.teamName,
				});
				for (const [key, value] of Object.entries(spawnConfig.env)) {
					push(key, value);
				}
			} catch {
				// degrade to identity-less spawn (mirrors TmuxAdapter behavior)
			}
		}
		return envArgs;
	}

	private persistSessionState(
		stateDir: string,
		ctx: AdapterExecutionContext,
		windowId: string,
		threadId: string | undefined,
	): void {
		// Crash-recovery state file (FLY-172 marker pattern): thread id is
		// persisted at discovery, NOT only at terminal completion (R1 #3/#4).
		try {
			writeFileSync(
				join(stateDir, "session.json"),
				JSON.stringify(
					{
						executionId: ctx.executionId,
						issueId: ctx.issueId,
						tmuxWindow: `${this.sessionName}:${windowId}`,
						cwd: ctx.cwd,
						vendor: "codex",
						...(threadId && { threadId }),
						updatedAt: new Date().toISOString(),
					},
					null,
					2,
				),
				{ encoding: "utf-8", mode: 0o600 },
			);
		} catch (err) {
			console.warn(
				`[CodexTmuxAdapter] session state persist failed: ${(err as Error).message}`,
			);
		}
	}

	private resolveCommCli(): string {
		const req = createRequire(import.meta.url);
		return req.resolve("flywheel-comm");
	}

	private ensureSession(): void {
		// FLY-758: shared helper names the fresh scaffold `zsh` so pruneScaffoldWindow
		// reliably matches it at millisecond spawn time (defeats the async rename race).
		ensureRunnerSession(this.execFileFn, this.sessionName);
	}
}

function removeGateMarkerSafely(dir: string, questionId: string): void {
	try {
		removeGateMarker(dir, questionId);
	} catch {
		// best-effort
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// re-exported for tests that need to clean state dirs
export function removeCodexSessionState(executionId: string): void {
	try {
		rmSync(codexSessionStateDir(executionId), { recursive: true, force: true });
	} catch {
		// best-effort
	}
	// FLY-123 P5: full retirement also removes the per-runner CODEX_HOME
	// (auth shell + sessions). Credential was already scrubbed at terminal;
	// this reclaims the whole dir.
	removeCodexHome(executionId);
}
