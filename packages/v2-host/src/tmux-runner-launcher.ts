import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { renderRunnerModelDisplay } from "flywheel-config";
import { buildWindowLabel, sanitizeTmuxName } from "flywheel-core";
import { leaseIsHealthy } from "flywheel-inbox-mcp/channel-lease";
import { requestCmuxPinClose } from "flywheel-teamlead/bridge/cmux-close-request";
import { v2RunnerTmuxSessionName } from "flywheel-teamlead/v2-issue-display";
import type { SessionBinding } from "flywheel-v2-engine";
import {
	type CodexDaemonState,
	prepareCodexRemote,
	sendCodexTurn,
	teardownCodexRemote,
} from "./codex-remote.js";
import type {
	RunnerLauncherPort,
	RuntimeLaunchRequest,
} from "./runtime-ports.js";
import {
	publishSessionProof,
	readProcessStartIdentity,
} from "./session-evidence.js";

const execFileAsync = promisify(execFile);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface TmuxCommandPort {
	run(
		file: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string }>;
}

export interface TmuxRunnerLauncherOptions {
	hostEpoch: string;
	tmuxBin: string;
	claudeBin: string;
	codexBin: string;
	clientCliPath: string;
	socketPath: string;
	secretPath: string;
	sessionProofRoot: string;
	releaseRoot: string;
	stateRoot: string;
	command?: TmuxCommandPort;
	now?: () => Date;
	processStart?: (pid: number) => string | null;
	/**
	 * FLY-1550: the v1 cmux-sync event channel (`EVENT_FILE` in
	 * scripts/flywheel-cmux-sync.sh). The launcher appends the same
	 * `create|session|window_id|window_name` line the tmux hooks write, so the
	 * resident v1 watcher builds the workspace through its own create path.
	 * Overridable for tests only; production keeps the shared default.
	 */
	cmuxEventFilePath?: string;
	/**
	 * FLY-1547: absolute path to the mailbox MCP server entry
	 * (flywheel-v2-mailbox-mcp dist/server-main.js). When set, Claude runners
	 * are spawned with the mailbox tool face + channel bell registered; absent
	 * keeps the spawn byte-identical (rollout is a config edit, not a flag).
	 */
	mailboxMcpPath?: string;
	/** FLY-1547 §2.6 test seam: injected daemon/transport ports for the codex
	 * remote form; production uses the real flywheel-claude-runner machinery. */
	codexRemotePorts?: import("./codex-remote.js").CodexRemotePorts;
}

/**
 * FLY-1550: byte contract with `EVENT_FILE` in scripts/flywheel-cmux-sync.sh.
 */
const CMUX_EVENT_FILE = "/tmp/flywheel-cmux-events";

/** FLY-1547: how long activate() watches the fresh pane for the dev-channels
 * consent dialog (documented constant, not a flag). */
const CONSENT_POLL_WINDOW_MS = 30_000;

/** FLY-1547 §2.6: the assignment turn is the whole task — give it a generous
 * completion window; timeout only bounds OUR wait, the turn itself keeps
 * running daemon-side and stays visible in the attached pane. */
const BOOTSTRAP_ASSIGNMENT_TIMEOUT_MS = 60_000;

/**
 * FLY-1550 (founder direct order ①): no `/usr/bin/env -i`, no allowlist. The
 * pane keeps the full tmux-provided environment (TERM included) exactly like a
 * Lead pane. Only NAMED legacy variables are blocked: every environment entry
 * whose name starts with `FLYWHEEL_BRIDGE_` (v1 control-plane pointer,
 * forbidden to v2 runners) and `CLAUDE_CONFIG_DIR` (order ② shares the
 * operator's ~/.claude; a stray inherited override would silently split the
 * config again).
 *
 * Codex R1 HIGH-2 hardening — the blacklist must hold under a hostile
 * environment, because the environment is exactly what is untrusted here:
 * - `/usr/bin/env` + `/usr/bin/sed` by absolute path: the inherited PATH must
 *   not be able to make the sweep silently no-op.
 * - `[^=]*` in the key pattern: an environment ENTRY name is any byte string,
 *   not a shell identifier — `FLYWHEEL_BRIDGE_X-Y` must be swept too. That is
 *   also why removal goes through `env -u` (which takes arbitrary names)
 *   rather than the shell builtin `unset` (identifiers only).
 * - Fail closed: if the enumeration pipeline itself fails, the gate exits 70
 *   instead of exec-ing the vendor with the blacklist unapplied; the
 *   deterministic launch probe then reports the runner absent, loudly.
 * - `set -f` + newline IFS: enumerated names must never glob or word-split.
 *
 * Exported for the launcher test, which runs this exact script as a real
 * /bin/sh child and inspects the resulting environment.
 */
export const RUNNER_GATE_SCRIPT =
	'gate="$0"; n=0; while [ ! -f "$gate" ]; do [ "$n" -ge 86400 ] && exit 75; sleep 1; n=$((n+1)); done; ' +
	'bl=$(/usr/bin/env | LC_ALL=C /usr/bin/sed -n "s/^\\\\(FLYWHEEL_BRIDGE_[^=]*\\\\)=.*/\\\\1/p") || exit 70; ' +
	'set -f; IFS="\n"; for v in $bl; do set -- -u "$v" "$@"; done; unset IFS; ' +
	'exec /usr/bin/env -u CLAUDE_CONFIG_DIR "$@"';

export class RunnerLaunchConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunnerLaunchConfigError";
	}
}

function absolute(path: string, label: string): string {
	if (!isAbsolute(path)) throw new TypeError(`${label} must be absolute`);
	return path;
}

function safeKey(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeName(value: string, fallback: string): string {
	const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return (safe || fallback).slice(0, 32);
}

function isAbsentTmuxError(error: unknown): boolean {
	const candidate = error as { stderr?: string; message?: string };
	const text = `${candidate.stderr ?? ""}\n${candidate.message ?? ""}`;
	return /can't find session|no server running|failed to connect to server/i.test(
		text,
	);
}

function atomicFile(path: string, content: string): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	const temporary = join(
		parent,
		`.${safeKey(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	chmodSync(path, 0o600);
	const parentFd = openSync(parent, "r");
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
}

function atomicRelease(path: string): void {
	atomicFile(path, "activate\n");
}

/**
 * FLY-1556: the pinned instruction CONTENT arrives in the launch request (read
 * from the immutable git blob at spawn); the launcher never reads the mutable
 * worktree file. This check only proves the request is internally consistent —
 * the content matches its own pin — so a corrupted request transport fails
 * closed with the expected/actual pair named.
 */
function instructionBytes(request: RuntimeLaunchRequest): Buffer {
	const instruction = request.context.instruction;
	const bytes = Buffer.from(instruction.content, "utf8");
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (
		bytes.length !== instruction.contentBytes ||
		digest !== instruction.contentDigest
	) {
		throw new RunnerLaunchConfigError(
			`role instruction content for ${request.sessionRef} does not match its pin: ` +
				`expected sha256 ${instruction.contentDigest} (${instruction.contentBytes} bytes), ` +
				`got ${digest} (${bytes.length} bytes)`,
		);
	}
	return bytes;
}

function vendorKind(value: string): "claude" | "codex" {
	const normalized = value.trim().toLowerCase();
	if (normalized === "claude" || normalized === "claude-code") return "claude";
	if (normalized === "codex") return "codex";
	throw new RunnerLaunchConfigError(
		`unsupported runner vendor ${value || "<empty>"}`,
	);
}

/**
 * FLY-1550: the founder-facing workspace name. The tmux window name IS the cmux
 * workspace title AND the tab title (the v1 watcher's core invariant), and it
 * follows the FLY-1255 Locked Display Contract verbatim
 * (engineering/doc/FLY-1255-vendor-neutral-model-display/plan.md §7/§8):
 *
 * - three-stage node kinds keep their phase prefix: `<phase>-<windowLabel>`
 *   (e.g. `design-claude-Fable`); every other node uses the FIXED `runner-`
 *   producer prefix (`runner-claude-Fable`) — the cmux reaper's proof that a
 *   window is Flywheel-produced, never an open vendor allowlist.
 * - `windowLabel` comes from the existing pure renderer
 *   `renderRunnerModelDisplay()` (flywheel-config) — reused, never re-derived.
 * - the label is composed by the v1 `buildWindowLabel()` and bounded by the v1
 *   `sanitizeTmuxName()` 50-char budget (flywheel-core); head-first truncation
 *   is what keeps the issue identifier + model identity ahead of a long title.
 *
 * The runner-segment branch mirrors `runnerDisplayName()`
 * (packages/teamlead/src/bridge/run-dispatcher.ts) for the v2 node kinds; that
 * module is not importable here without dragging the v1 Bridge graph in.
 * COUPLING: `is_managed_runner_title` in scripts/flywheel-cmux-sync.sh keys on
 * the same `runner|design|implement|qa` producer namespace.
 */
const THREE_STAGE_PHASE_KINDS = new Set(["design", "implement", "qa"]);

function v2RunnerSegment(
	taskKind: string,
	executor: RuntimeLaunchRequest["executor"],
): string {
	const display = renderRunnerModelDisplay({
		vendor: vendorKind(executor.vendor),
		model: executor.model,
	});
	const phase = THREE_STAGE_PHASE_KINDS.has(taskKind) ? taskKind : undefined;
	if (display) {
		return phase
			? `${phase}-${display.windowLabel}`
			: `runner-${display.windowLabel}`;
	}
	// Contract §7: display missing keeps the verbatim v1 fallback.
	return phase ?? "claude";
}

export function workspaceWindowName(request: RuntimeLaunchRequest): string {
	// The trailing slug is the FLY-1547 issue title when the admission carried
	// one, else the node kind — so the window still says what the node is.
	const slug = request.context.issueTitle ?? request.taskKind;
	return sanitizeTmuxName(
		buildWindowLabel(
			request.context.issueId,
			v2RunnerSegment(request.taskKind, request.executor),
			slug,
		),
	);
}

/** FLY-1547 (rebased onto FLY-1550): the per-activation Claude config dir is
 * gone, so the mailbox MCP registration + health lease live under the
 * launcher-owned stateRoot, keyed by sessionRef — derivable anywhere the
 * doorbell needs to probe, no extra state. */
export function mailboxLeasePath(
	stateRoot: string,
	sessionRef: string,
): string {
	return join(stateRoot, `${safeKey(sessionRef)}-mailbox-lease.json`);
}

export function mailboxMcpConfigPath(
	stateRoot: string,
	sessionRef: string,
): string {
	return join(stateRoot, `${safeKey(sessionRef)}-mailbox-mcp.json`);
}

export const MAILBOX_MCP_SERVER_NAME = "flywheel-v2-mailbox";

/**
 * Mirrors the vendor inbox ceiling the old push channel enforced: an oversized
 * bootstrap is refused at launch, never truncated.
 */
const MAX_BOOTSTRAP_PROMPT_BYTES = 1_000_000;

/**
 * FLY-1543 ④: the spawn prompt IS the first delivery. The runner opens its
 * eyes holding the assignment envelope, the settle capability and the written
 * protocol; later envelopes are pulled from the DB mailbox by session ref.
 */
function runnerPrompt(
	request: RuntimeLaunchRequest,
	pinnedPath: string,
): string {
	const instruction = request.context.instruction;
	const title = request.context.issueTitle?.trim();
	const prompt = [
		// FLY-1547: carry the human-readable title so the runner never has to
		// ask what the issue is called.
		`Flywheel v2 runner bootstrap for ${request.context.issueId}${title ? `: ${title}` : ""}.`,
		`The complete role authority is pinned at ${pinnedPath} with SHA-256 ${instruction.contentDigest}.`,
		"Do not use any legacy control-plane CLI, inbox, Bridge, adapter, or database.",
		"Your first work envelope is embedded below. It carries the durable issue context, the exact attempt/message identities, and the proposal authorization used to settle it; its `protocol` field is the authoritative contract.",
		"Submit effects only through the flywheel-v2 CLI named by FLYWHEEL_V2_CLIENT_CLI over the authenticated host socket in this session environment. Pull any later envelope with `next --session <FLYWHEEL_V2_SESSION_REF>`; reach your lead during the work with the `ask` verb. Vendor team tools do not reach anyone.",
		`Activation: ${request.activationId}. Session: ${request.sessionRef}.`,
		"FIRST ENVELOPE:",
		request.context.firstEnvelope,
	].join("\n");
	if (Buffer.byteLength(prompt, "utf8") > MAX_BOOTSTRAP_PROMPT_BYTES) {
		throw new RunnerLaunchConfigError(
			`runner bootstrap prompt exceeds ${MAX_BOOTSTRAP_PROMPT_BYTES} bytes`,
		);
	}
	return prompt;
}

function commandForVendor(
	request: RuntimeLaunchRequest,
	options: TmuxRunnerLauncherOptions,
	kind: "claude" | "codex",
	instruction: Buffer,
	pinnedPath: string,
	codexDaemon?: CodexDaemonState,
): { binary: string; args: string[] } {
	if (!EFFORTS.has(request.executor.effort)) {
		throw new RunnerLaunchConfigError(
			`unsupported runner effort ${request.executor.effort}`,
		);
	}
	if (kind === "claude") {
		// FLY-1543 ④: no --agent-id/--agent-name/--team-name and no agent-teams
		// experiment flag -- the vendor team machinery is not part of the design.
		//
		// FLY-1556: the system prompt file is the engine-owned content-addressed
		// materialization, NOT the worktree file — a task that edits its own node
		// instruction file cannot poison the authority its process was started
		// with.
		//
		// FLY-1547 (rebased onto the FLY-1550 launcher): the mailbox MCP
		// registration + its dev channel ride the spawn only when the server
		// path is configured; absent keeps the argv byte-identical. The config
		// file lives under the launcher-owned stateRoot (the per-activation
		// Claude config dir is gone — runners share the operator's ~/.claude).
		const mailboxArgs = options.mailboxMcpPath
			? [
					"--mcp-config",
					mailboxMcpConfigPath(options.stateRoot, request.sessionRef),
					"--dangerously-load-development-channels",
					`server:${MAILBOX_MCP_SERVER_NAME}`,
				]
			: [];
		return {
			binary: options.claudeBin,
			args: [
				"--session-id",
				randomUUID(),
				"--permission-mode",
				"bypassPermissions",
				...mailboxArgs,
				"--append-system-prompt-file",
				pinnedPath,
				"--model",
				request.executor.model,
				"--effort",
				request.executor.effort,
				"--name",
				safeName(
					`v2-${request.context.issueId}-${request.taskKind}`,
					"v2-runner",
				),
				runnerPrompt(request, pinnedPath),
			],
		};
	}
	if (codexDaemon) {
		// FLY-1547 §2.6 (ruling A): the founder-visible pane ATTACHES to the
		// session's own daemon thread — no prompt in argv; the assignment is
		// delivered as the first real turn at activation and renders here.
		return {
			binary: options.codexBin,
			args: [
				"resume",
				"--remote",
				`unix://${codexDaemon.socket_path}`,
				"-C",
				request.context.projectRoot,
				"-s",
				"workspace-write",
				"-c",
				'approval_policy="never"',
				codexDaemon.thread_id,
			],
		};
	}
	return {
		binary: options.codexBin,
		args: [
			"-C",
			request.context.projectRoot,
			"-m",
			request.executor.model,
			"-s",
			"workspace-write",
			"-a",
			"never",
			"-c",
			`model_reasoning_effort=${JSON.stringify(request.executor.effort)}`,
			`${instruction.toString("utf8")}\n\n---\n\n${runnerPrompt(request, pinnedPath)}`,
		],
	};
}

function defaultCommand(): TmuxCommandPort {
	return {
		async run(file, args) {
			const result = await execFileAsync(file, args, {
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
			});
			return { stdout: result.stdout, stderr: result.stderr };
		},
	};
}

export class TmuxRunnerLauncher implements RunnerLauncherPort {
	readonly #options: TmuxRunnerLauncherOptions;
	readonly #command: TmuxCommandPort;
	/** FLY-1547 §2.6: live daemon handles for sessions launched by THIS
	 * process; restart-safe teardown falls back to the persisted state. */
	/** R4-F5: per-session serialization + once-per-process latch for daemon
	 * turn sends — every coordinator tick calls activate() for every live
	 * binding, and overlapping reconcile-then-start is a TOCTOU duplicate. */
	readonly #turnChains = new Map<string, Promise<unknown>>();
	/** R5-B1: 'done' ONLY after sendCodexTurn resolved (reconcile-first makes
	 * retries single-effect); any failure leaves the state absent so the next
	 * coordinator tick retries — a first-send failure is never terminal. */
	readonly #assignmentDone = new Set<string>();
	readonly #daemonHandles = new Map<
		string,
		{ stop(signal?: NodeJS.Signals): void; ensureDead(): Promise<boolean> }
	>();
	readonly #now: () => Date;
	readonly #processStart: (pid: number) => string | null;

	constructor(options: TmuxRunnerLauncherOptions) {
		for (const [label, path] of [
			["tmuxBin", options.tmuxBin],
			["claudeBin", options.claudeBin],
			["codexBin", options.codexBin],
			["clientCliPath", options.clientCliPath],
			["socketPath", options.socketPath],
			["secretPath", options.secretPath],
			["sessionProofRoot", options.sessionProofRoot],
			["releaseRoot", options.releaseRoot],
			["stateRoot", options.stateRoot],
		] as const) {
			absolute(path, label);
		}
		if (options.hostEpoch.trim().length === 0) {
			throw new TypeError("hostEpoch must not be empty");
		}
		this.#options = options;
		this.#command = options.command ?? defaultCommand();
		this.#now = options.now ?? (() => new Date());
		this.#processStart = options.processStart ?? readProcessStartIdentity;
		for (const root of [options.releaseRoot, options.stateRoot]) {
			mkdirSync(root, { recursive: true, mode: 0o700 });
			chmodSync(root, 0o700);
		}
	}

	#sessionName(sessionRef: string): string {
		// FLY-1549: single source with the display's attach-command derivation —
		// drift here would render dead tmux links in the pinned issue header.
		return v2RunnerTmuxSessionName(sessionRef);
	}

	#releasePath(sessionRef: string): string {
		return join(this.#options.releaseRoot, `${safeKey(sessionRef)}.release`);
	}

	/**
	 * FLY-1556: the engine-owned, content-addressed materialization of the
	 * pinned instruction. The name IS the sha256 of the content, the directory
	 * is 0700 engine state, and the write is atomic — immutable by construction,
	 * shared by every attempt whose pin resolves to the same content. This file
	 * (not the mutable worktree file) is what the vendor process reads and what
	 * the bootstrap prompt names.
	 *
	 * The per-session runner-state JSON that used to live beside it is GONE:
	 * it duplicated facts whose single source of truth is the kernel
	 * (`attempt_instruction:*`, attempts, the assignment mailbox row), and two
	 * copies of one fact is exactly the drift that let a database fix change
	 * nothing while activate kept reading the stale disk copy.
	 */
	#instructionPath(digest: string): string {
		return join(this.#options.stateRoot, "instructions", `${digest}.md`);
	}

	#materializeInstruction(
		request: RuntimeLaunchRequest,
		bytes: Buffer,
	): string {
		const digest = request.context.instruction.contentDigest;
		const path = this.#instructionPath(digest);
		if (existsSync(path)) {
			const observed = createHash("sha256")
				.update(readFileSync(path))
				.digest("hex");
			if (observed !== digest) {
				throw new RunnerLaunchConfigError(
					`materialized role instruction at ${path} does not match its content address: ` +
						`expected sha256 ${digest}, got ${observed}`,
				);
			}
			return path;
		}
		atomicFile(path, bytes.toString("utf8"));
		return path;
	}

	// FLY-1550 (founder direct order): NO per-activation CLAUDE_CONFIG_DIR and NO
	// environment washing. The runner shares the operator's `~/.claude` exactly
	// like a Lead does -- statusline, theme, plugins and credentials are the same
	// because they are the same files. The whole isolation apparatus that used to
	// live here (config-dir derivation, credential symlink, onboarding preseed +
	// lock) existed for the per-activation credential copy, which FLY-1543
	// already abolished.

	async #hasSession(sessionName: string): Promise<boolean> {
		try {
			await this.#command.run(this.#options.tmuxBin, [
				"has-session",
				"-t",
				`=${sessionName}`,
			]);
			return true;
		} catch (error) {
			if (isAbsentTmuxError(error)) return false;
			throw error;
		}
	}

	async launch(request: RuntimeLaunchRequest): Promise<SessionBinding> {
		const instruction = instructionBytes(request);
		const vendor = vendorKind(request.executor.vendor);
		// R5-B3: validate everything commandForVendor would reject BEFORE any
		// daemon is spawned — no post-spawn rejection path may exist outside the
		// cleanup owner.
		if (!EFFORTS.has(request.executor.effort)) {
			throw new RunnerLaunchConfigError(
				`unsupported runner effort ${request.executor.effort}`,
			);
		}
		const pinnedPath = this.#materializeInstruction(request, instruction);
		if (vendor === "claude" && this.#options.mailboxMcpPath) {
			this.#materializeMailboxMcpConfig(request);
		}
		// FLY-1547 §2.6 (ruling A, rebased onto the FLY-1550 launcher): with the
		// mailbox service wired, a codex runner is the remote-attached form —
		// daemon + thread FIRST (persisted in the launcher-owned codex state
		// file before the TUI exists), then the pane attaches with resume
		// --remote. The bootstrap prompt is persisted alongside so activation
		// can deliver it as the first real turn.
		let codexDaemon: CodexDaemonState | undefined;
		if (vendor === "codex" && this.#options.mailboxMcpPath) {
			const priorState = this.#readCodexRemoteState(request.sessionRef);
			if (priorState?.codex_daemon.thread_id) {
				codexDaemon = priorState.codex_daemon;
			} else {
				if (priorState?.codex_daemon) {
					// R3-F5: a recorded daemon WITHOUT a thread is a crash orphan from
					// a previous launch phase — tear it down before starting fresh
					// (never adopt a threadless daemon, never leave it resident).
					const dead = await teardownCodexRemote(
						priorState.codex_daemon,
						this.#options.codexRemotePorts ?? {},
					);
					if (!dead) {
						throw new RunnerLaunchConfigError(
							`orphaned codex daemon for ${request.sessionRef} could not be proven dead — refusing to spawn a second one`,
						);
					}
				}
				const socketPath = join(
					this.#options.stateRoot,
					`cdx-${safeKey(request.sessionRef).slice(0, 12)}.sock`,
				);
				// R5-B3: durable PRE-SPAWN intent — if we die between spawnDaemon
				// resolving and onDaemonUp persisting, the next launch still finds a
				// recorded socket path to probe/reap instead of an unrecorded
				// resident.
				this.#writeCodexRemoteState(request.sessionRef, {
					v: 1,
					codex_daemon: {
						socket_path: socketPath,
						daemon_pid: -1,
						daemon_pgid: null,
						thread_id: "",
					},
					bootstrap: runnerPrompt(request, pinnedPath),
				});
				const prepared = await prepareCodexRemote(
					{
						codexBin: this.#options.codexBin,
						codexHome:
							process.env.CODEX_HOME ?? join(process.env.HOME ?? "/", ".codex"),
						socketPath,
						cwd: request.context.projectRoot,
						model: request.executor.model,
						effort: request.executor.effort,
						// R3-F5 crash phase: the daemon is on the books before the thread
						// exists — a crash here leaves a recorded orphan, not a resident.
						onDaemonUp: (partial) => {
							this.#writeCodexRemoteState(request.sessionRef, {
								v: 1,
								codex_daemon: { ...partial, thread_id: "" },
								bootstrap: runnerPrompt(request, pinnedPath),
							});
						},
					},
					this.#options.codexRemotePorts ?? {},
				);
				codexDaemon = prepared.state;
				this.#daemonHandles.set(request.sessionRef, prepared.handle);
				this.#writeCodexRemoteState(request.sessionRef, {
					v: 1,
					codex_daemon: prepared.state,
					bootstrap: runnerPrompt(request, pinnedPath),
				});
			}
		}
		// R5-B3: from here to registration, ONE cleanup owner — any failure
		// tears down the daemon this launch owns (see catch below + tmux catch).
		const vendorCommand = commandForVendor(
			request,
			this.#options,
			vendor,
			instruction,
			pinnedPath,
			codexDaemon,
		);
		const prior = await this.probe(request.sessionRef);
		if (prior.state === "present") {
			// R5-B3: Codex-remote liveness requires BOTH facts. A live tmux over a
			// dead daemon is a broken session — refuse silent adoption.
			if (codexDaemon?.thread_id) {
				const { connectDaemonTransport } = await import(
					"flywheel-claude-runner"
				);
				const connect =
					this.#options.codexRemotePorts?.connect ?? connectDaemonTransport;
				let alive = false;
				try {
					const transport = await connect({
						socketPath: codexDaemon.socket_path,
						connectTimeoutMs: 2_000,
					});
					(transport as { close?: () => void }).close?.();
					alive = true;
				} catch {
					alive = false;
				}
				if (!alive) {
					throw new RunnerLaunchConfigError(
						`codex session ${request.sessionRef} has a live tmux pane but a dead daemon — stop() the session before relaunching`,
					);
				}
			}
			return prior.sessionBinding;
		}

		const sessionName = this.#sessionName(request.sessionRef);
		const releasePath = this.#releasePath(request.sessionRef);
		if (existsSync(releasePath)) unlinkSync(releasePath);
		// FLY-1550: the window name is the founder-facing cmux workspace title.
		// FLY-1549's cross-wire guard (v2WindowMatchesIssue) keys on the
		// `${issueId}-` prefix that buildWindowLabel() structurally guarantees.
		const windowName = workspaceWindowName(request);
		const gateScript = RUNNER_GATE_SCRIPT;
		const environment = [
			`FLYWHEEL_V2_SESSION_REF=${request.sessionRef}`,
			`FLYWHEEL_V2_AGENT_ID=${request.taskKind}`,
			// FLY-1544 ②: the node's executing vendor, so the instruction book's
			// cross-vendor review rule ("claude writes -> codex reviews and vice
			// versa") can name the OTHER vendor without any system-side validation.
			`FLYWHEEL_V2_VENDOR=${vendor}`,
			`FLYWHEEL_V2_ACTIVATION_ID=${request.activationId}`,
			`FLYWHEEL_V2_SOCKET=${this.#options.socketPath}`,
			`FLYWHEEL_V2_SECRET_PATH=${this.#options.secretPath}`,
			`FLYWHEEL_V2_CLIENT_CLI=${this.#options.clientCliPath}`,
		];
		let createdWindowId: string | undefined;
		try {
			const created = await this.#command.run(this.#options.tmuxBin, [
				"new-session",
				"-d",
				"-P",
				"-F",
				"#{session_name}:#{window_id}",
				"-s",
				sessionName,
				"-n",
				windowName,
				"-c",
				request.context.projectRoot,
				...environment.flatMap((entry) => ["-e", entry]),
				"/bin/sh",
				"-c",
				gateScript,
				releasePath,
				vendorCommand.binary,
				...vendorCommand.args,
			]);
			createdWindowId = /:(@\d+)\s*$/.exec(created.stdout)?.[1];
			for (const [key, value] of [
				["@flywheel_v2_session_ref", request.sessionRef],
				["@flywheel_v2_activation_id", request.activationId],
				["@flywheel_v2_owner_token", request.ownerToken],
				[
					"@flywheel_v2_instruction_digest",
					request.context.instruction.contentDigest,
				],
			] as const) {
				await this.#command.run(this.#options.tmuxBin, [
					"set-option",
					"-t",
					// FLY-1503 item 6: tmux 3.5a rejects `set-option -t =name` with
					// "no such session" even though `has-session -t =name` resolves the
					// very same session; a session option needs a session target, which
					// the trailing colon makes explicit. This matches the idiom already
					// used in scripts/flywheel-cmux-sync.sh.
					//
					// Exact-match `=` is deliberately kept. The operator shim at
					// ~/.flywheel/v2/bin/tmux-eq-shim.sh worked around this by stripping
					// `=`, which silently downgrades to prefix matching.
					`=${sessionName}:`,
					key,
					value,
				]);
			}
		} catch (error) {
			try {
				await this.#command.run(this.#options.tmuxBin, [
					"kill-session",
					"-t",
					`=${sessionName}`,
				]);
			} catch {
				// Best effort: the deterministic probe will fail closed if it survives.
			}
			// R4-F6: the session's daemon dies with the failed launch too — a tmux
			// failure must not orphan a live daemon this launch just spawned.
			const handle = this.#daemonHandles.get(request.sessionRef);
			if (handle) {
				this.#daemonHandles.delete(request.sessionRef);
				let provenDead = false;
				try {
					handle.stop();
					provenDead = await handle.ensureDead();
				} catch {
					provenDead = false;
				}
				if (!provenDead) {
					// R5-B3: an unproven-dead daemon is a first-class failure — the
					// recorded state lets the next launch reap it, but the caller must
					// hear BOTH facts, not just the tmux error.
					throw new Error(
						`launch failed AND the session daemon could not be proven dead: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			throw error;
		}
		this.#announceCmuxCreate(sessionName, createdWindowId, windowName);
		const launched = await this.probe(request.sessionRef);
		if (launched.state !== "present") {
			throw new Error("tmux runner disappeared before registration");
		}
		return launched.sessionBinding;
	}

	/**
	 * FLY-1550 ③: make the runner visible in cmux by feeding the v1 watcher's own
	 * event channel. `after-new-window` cannot fire for a session's initial
	 * window, so the launcher writes the byte-identical hook line itself; the
	 * resident `flywheel-cmux-sync.sh --watch` drains it within ~15s and runs its
	 * full v1 create path (workspace + rename-workspace + rename-tab, ledgered).
	 * Best-effort by contract: a runner must never fail to launch because cmux
	 * bookkeeping did -- the watcher's 60s additive sweep is the fallback.
	 */
	#announceCmuxCreate(
		sessionName: string,
		windowId: string | undefined,
		windowName: string,
	): void {
		if (!windowId) {
			console.warn(
				`[v2-launcher] cmux create event skipped for ${sessionName}: window id unresolved`,
			);
			return;
		}
		const eventFile = this.#options.cmuxEventFilePath ?? CMUX_EVENT_FILE;
		try {
			appendFileSync(
				eventFile,
				`create|${sessionName}|${windowId}|${windowName}\n`,
			);
		} catch (error) {
			console.warn(
				`[v2-launcher] cmux create event write failed for ${windowName}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/**
	 * FLY-1556: activation is presence + gate release, nothing else. The old
	 * re-verification of the instruction digest is gone with the thing it
	 * verified: the vendor process reads the engine-owned content-addressed
	 * materialization, which cannot drift, and the pin's single source of truth
	 * is the kernel's `attempt_instruction:*` row. Re-checking the MUTABLE
	 * worktree file here is what made a task that edits its own instruction
	 * book (FLY-1547/1548) poison every later activation of its session.
	 */
	async activate(sessionRef: string): Promise<void> {
		const probe = await this.probe(sessionRef);
		if (probe.state !== "present") {
			throw new Error("cannot activate an absent tmux runner");
		}
		atomicRelease(this.#releasePath(sessionRef));
		const codexRemote = this.#readCodexRemoteState(sessionRef);
		if (
			codexRemote?.codex_daemon.thread_id &&
			!this.#assignmentDone.has(sessionRef)
		) {
			// FLY-1547 §2.6 / R5-B1: the assignment is the first REAL turn on the
			// thread. activate() fires every coordinator tick; sends are serialized
			// per session, and the done-latch is set ONLY after sendCodexTurn
			// resolves ('started' or 'already_present' — its thread/read reconcile
			// makes every retry single-effect, including after an ambiguous
			// timeout). A failure leaves the latch clear: the NEXT tick retries.
			const daemon = codexRemote.codex_daemon;
			void this.#sendTurnSerial(sessionRef, () =>
				sendCodexTurn(
					daemon,
					codexRemote.bootstrap,
					`assignment:${sessionRef}`,
					this.#options.codexRemotePorts ?? {},
					BOOTSTRAP_ASSIGNMENT_TIMEOUT_MS,
				),
			)
				.then((outcome) => {
					this.#assignmentDone.add(sessionRef);
					if (outcome === "already_present") {
						process.stderr.write(
							`[tmux-launcher] codex assignment for ${sessionRef} was already on the thread (reconciled replay)\n`,
						);
					}
				})
				.catch((error) => {
					const message =
						error instanceof Error ? error.message : String(error);
					// startTurn resolves on RPC ACCEPTANCE; a timeout here is an
					// AMBIGUOUS send, not evidence of a running task. The latch stays
					// clear and the next coordinator tick reconciles via thread/read
					// before deciding whether to start again.
					process.stderr.write(
						`[tmux-launcher] codex assignment send for ${sessionRef} did not confirm (${message}) — will reconcile and retry next tick\n`,
					);
				});
		}
		if (this.#options.mailboxMcpPath && !codexRemote) {
			// FLY-1547: the dev-channels consent dialog is NOT persistable (real-
			// machine finding: a completed consent leaves no state on disk), so it
			// is auto-confirmed here after the launch gate opens — the proven
			// claude-lead.sh capture-pane pattern, bounded and fail-loud.
			void this.#confirmDevChannelConsent(sessionRef).catch((error) => {
				process.stderr.write(
					`[tmux-launcher] dev-channels consent confirm failed for ${sessionRef}: ${
						error instanceof Error ? error.message : String(error)
					}\n`,
				);
			});
		}
	}

	/**
	 * FLY-1547: write the per-session mailbox MCP registration. The server gets
	 * the same authenticated socket identity the runner itself holds plus the
	 * health-lease path the doorbell probes.
	 */
	#materializeMailboxMcpConfig(request: RuntimeLaunchRequest): void {
		const serverPath = this.#options.mailboxMcpPath;
		if (!serverPath) return;
		if (!isAbsolute(serverPath)) {
			throw new RunnerLaunchConfigError(
				"mailboxMcpPath must be an absolute path",
			);
		}
		mkdirSync(this.#options.stateRoot, { recursive: true });
		writeFileSync(
			mailboxMcpConfigPath(this.#options.stateRoot, request.sessionRef),
			JSON.stringify(
				{
					mcpServers: {
						[MAILBOX_MCP_SERVER_NAME]: {
							command: process.execPath,
							args: [serverPath],
							env: {
								FLYWHEEL_V2_SOCKET: this.#options.socketPath,
								FLYWHEEL_V2_SECRET_PATH: this.#options.secretPath,
								FLYWHEEL_V2_SESSION_REF: request.sessionRef,
								FLYWHEEL_V2_MAILBOX_LEASE: mailboxLeasePath(
									this.#options.stateRoot,
									request.sessionRef,
								),
							},
						},
					},
				},
				null,
				"\t",
			),
		);
	}

	/**
	 * FLY-1547: doorbell health probe — is this recipient's mailbox MCP channel
	 * alive AND fresh?
	 *
	 * Codex R1 M-2 (FLY-1563): `mailboxMcpPath` gates only RUNNER wiring — it is
	 * this launcher's own spawn-time registration knob. A LEAD's channel is
	 * enabled by claude-lead.sh independently (built server + per-lead
	 * credential), so a lead lease is probed unconditionally; ignoring it would
	 * double-ring a lead whose official channel is healthy.
	 */
	async channelHealthy(sessionRef: string): Promise<boolean> {
		if (sessionRef.startsWith("v2dag:") && !this.#options.mailboxMcpPath) {
			return false;
		}
		return leaseIsHealthy(
			mailboxLeasePath(this.#options.stateRoot, sessionRef),
			{
				nowMs: Date.now(),
				maxAgeMs: 15_000,
				pidIsLive: (pid) => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				},
			},
		);
	}

	/**
	 * FLY-1547 §2.6: the engine doorbell's codex route. A session with a daemon
	 * record gets the pointer bell as a real turn (renders in the attached
	 * pane); anyone else returns false and the caller falls to the paste.
	 */
	async codexBell(
		sessionRef: string,
		text: string,
		idempotencyKey: string,
	): Promise<boolean> {
		const state = this.#readCodexRemoteState(sessionRef);
		if (!state?.codex_daemon.thread_id) return false;
		const daemon = state.codex_daemon;
		await this.#sendTurnSerial(sessionRef, () =>
			sendCodexTurn(
				daemon,
				text,
				idempotencyKey,
				this.#options.codexRemotePorts ?? {},
			),
		);
		return true;
	}

	/** One in-flight daemon turn per session — reconcile-then-start is only a
	 * single-effect primitive when the sequence cannot interleave. */
	#sendTurnSerial<T>(sessionRef: string, op: () => Promise<T>): Promise<T> {
		const prior = this.#turnChains.get(sessionRef) ?? Promise.resolve();
		const run = prior.then(op, op);
		this.#turnChains.set(
			sessionRef,
			run.catch(() => undefined),
		);
		return run;
	}

	/** Bounded poller: watch the fresh pane for the dev-channels consent dialog
	 * and confirm option 1. No dialog within the window is success (already
	 * confirmed or not shown); a send failure surfaces via the caller's log. */
	async #confirmDevChannelConsent(sessionRef: string): Promise<void> {
		const target = `=${this.#sessionName(sessionRef)}:0.0`;
		const deadline = Date.now() + CONSENT_POLL_WINDOW_MS;
		while (Date.now() < deadline) {
			let screen = "";
			try {
				const captured = await this.#command.run(this.#options.tmuxBin, [
					"capture-pane",
					"-p",
					"-t",
					target,
				]);
				screen = captured.stdout;
			} catch {
				return; // pane gone — nothing to confirm
			}
			if (screen.includes("I am using this for local development")) {
				await this.#command.run(this.#options.tmuxBin, [
					"send-keys",
					"-t",
					target,
					"Enter",
				]);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	async probe(sessionRef: string): Promise<
		| {
				state: "present";
				confirmedAt: string;
				sessionBinding: SessionBinding;
		  }
		| { state: "absent"; confirmedAt: string }
	> {
		const confirmedAt = this.#now().toISOString();
		const sessionName = this.#sessionName(sessionRef);
		if (!(await this.#hasSession(sessionName))) {
			return { state: "absent", confirmedAt };
		}
		const environment = await this.#command.run(this.#options.tmuxBin, [
			"show-environment",
			"-t",
			`=${sessionName}`,
			"FLYWHEEL_V2_SESSION_REF",
		]);
		if (environment.stdout.trim() !== `FLYWHEEL_V2_SESSION_REF=${sessionRef}`) {
			throw new Error("tmux runner session identity is ambiguous");
		}
		const pane = await this.#command.run(this.#options.tmuxBin, [
			"display-message",
			"-p",
			"-t",
			`=${sessionName}:0.0`,
			"#{pane_pid}|#{pane_dead}",
		]);
		const match = /^([1-9][0-9]*)\|([01])$/.exec(pane.stdout.trim());
		if (!match) throw new Error("tmux runner pane identity is malformed");
		if (match[2] === "1") return { state: "absent", confirmedAt };
		const pid = Number(match[1]);
		const pidStart = this.#processStart(pid);
		if (!pidStart)
			throw new Error("tmux runner process identity is unavailable");
		publishSessionProof({
			root: this.#options.sessionProofRoot,
			sessionId: sessionRef,
			pid,
			pidStart,
		});
		return {
			state: "present",
			confirmedAt,
			sessionBinding: {
				v: 1,
				hostEpoch: this.#options.hostEpoch,
				sessionId: sessionRef,
				pid,
				pidStart,
			},
		};
	}

	async stop(sessionRef: string): Promise<void> {
		const sessionName = this.#sessionName(sessionRef);
		if (await this.#hasSession(sessionName)) {
			// FLY-1550 ③: resolve the window name while the session is still alive
			// (the v1 ordering -- FLY-638). It is also the cmux workspace title, so
			// after the kill the v1 close-request marker retires the workspace pin
			// through the watcher's revalidating chokepoint (FLY-685). Best-effort:
			// pin recycling must never block a stop; the watcher's window-unlinked
			// hook + stale ladders remain the fallback.
			let windowName: string | undefined;
			try {
				const windows = await this.#command.run(this.#options.tmuxBin, [
					"list-windows",
					"-t",
					`=${sessionName}`,
					"-F",
					"#{window_name}",
				]);
				windowName = windows.stdout
					.split("\n")
					.map((line) => line.trim())
					.find((line) => line.length > 0);
			} catch {
				// window name unresolvable; the watcher's fallbacks own the pin
			}
			await this.#command.run(this.#options.tmuxBin, [
				"kill-session",
				"-t",
				`=${sessionName}`,
			]);
			if (windowName) requestCmuxPinClose(windowName);
		}
		const releasePath = this.#releasePath(sessionRef);
		if (existsSync(releasePath)) unlinkSync(releasePath);
		if (await this.#hasSession(sessionName)) {
			throw new Error("tmux runner stop could not prove process absence");
		}
		// FLY-1547 §2.6: the session's daemon dies with it. Prefer the live
		// handle (stop + ensureDead proves death by socket); after a host
		// restart fall back to the persisted group + connect-probe teardown.
		this.#assignmentDone.delete(sessionRef);
		const handle = this.#daemonHandles.get(sessionRef);
		if (handle) {
			this.#daemonHandles.delete(sessionRef);
			handle.stop();
			if (!(await handle.ensureDead())) {
				throw new Error(
					`codex daemon for ${sessionRef} could not be proven dead (live handle)`,
				);
			}
			return;
		}
		const codexRemote = this.#readCodexRemoteState(sessionRef);
		if (codexRemote) {
			const dead = await teardownCodexRemote(
				codexRemote.codex_daemon,
				this.#options.codexRemotePorts ?? {},
			);
			if (!dead) {
				throw new Error(
					`codex daemon for ${sessionRef} could not be proven dead (socket still listening)`,
				);
			}
			try {
				unlinkSync(this.#codexRemoteStatePath(sessionRef));
			} catch {
				// already gone
			}
		}
	}

	/** FLY-1547 §2.6 (rebased): the launcher-owned codex remote-form ledger —
	 * daemon identity + the persisted bootstrap the assignment turn delivers. */
	#codexRemoteStatePath(sessionRef: string): string {
		return join(
			this.#options.stateRoot,
			`${safeKey(sessionRef)}-codex-remote.json`,
		);
	}

	#readCodexRemoteState(
		sessionRef: string,
	): { v: 1; codex_daemon: CodexDaemonState; bootstrap: string } | undefined {
		const path = this.#codexRemoteStatePath(sessionRef);
		if (!existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const record = parsed as {
			v?: unknown;
			codex_daemon?: CodexDaemonState;
			bootstrap?: unknown;
		};
		if (
			record.v !== 1 ||
			typeof record.bootstrap !== "string" ||
			typeof record.codex_daemon !== "object" ||
			record.codex_daemon === null ||
			typeof record.codex_daemon.socket_path !== "string" ||
			typeof record.codex_daemon.thread_id !== "string"
		) {
			throw new RunnerLaunchConfigError(
				`codex remote state at ${path} has an invalid shape`,
			);
		}
		return record as {
			v: 1;
			codex_daemon: CodexDaemonState;
			bootstrap: string;
		};
	}

	#writeCodexRemoteState(
		sessionRef: string,
		state: { v: 1; codex_daemon: CodexDaemonState; bootstrap: string },
	): void {
		mkdirSync(this.#options.stateRoot, { recursive: true });
		writeFileSync(
			this.#codexRemoteStatePath(sessionRef),
			JSON.stringify(state, null, "\t"),
		);
	}

	/**
	 * FLY-1544 doorbell: paste text into the session terminal and submit it.
	 * Vendor-neutral — a tmux buffer paste followed by Enter works identically
	 * for the Claude and Codex TUIs (bracketed paste keeps multi-line payloads
	 * a single input). Fails loud when the session is absent; the caller keeps
	 * the mailbox row pending and rings again.
	 */
	async deliver(sessionRef: string, text: string): Promise<void> {
		const sessionName = this.#sessionName(sessionRef);
		if (!(await this.#hasSession(sessionName))) {
			throw new Error("tmux runner session is absent");
		}
		await this.#pasteInto(
			`=${sessionName}:0.0`,
			`flywheel-v2-doorbell-${safeKey(sessionRef).slice(0, 12)}`,
			text,
		);
	}

	/**
	 * FLY-1563 ③: paste the bell into a LEAD's terminal. A lead session is
	 * created by claude-lead.sh/cmux, not by this launcher, so no tmux session
	 * name is derivable from an id — the registration's pid (agents row session
	 * binding) is the ground truth. The hosting pane is found by walking the
	 * process ancestry (pid → ppid) until a pane_pid matches; a dead pid or a
	 * process outside tmux fails loud and the doorbell keeps the debt pending.
	 *
	 * Codex R1 HIGH-1 (pid reuse): the pid alone is not an identity — a
	 * recycled pid inside tmux would take the paste, the cursor would advance,
	 * and the REAL lead would never be woken again. The binding's pidStart is
	 * therefore verified against the live process both before and after pane
	 * resolution; any mismatch fails loud and the debt stays pending.
	 */
	async deliverLead(
		agentId: string,
		pid: number,
		pidStart: string,
		text: string,
	): Promise<void> {
		this.#requireLeadProcessIdentity(pid, pidStart);
		const target = await this.#resolveLeadPane(pid);
		// The pane list and the process table are two snapshots — re-verify so a
		// reuse in between cannot slip through the gap.
		this.#requireLeadProcessIdentity(pid, pidStart);
		await this.#pasteInto(
			target,
			`flywheel-v2-doorbell-lead-${safeKey(agentId).slice(0, 12)}`,
			text,
		);
	}

	#requireLeadProcessIdentity(pid: number, pidStart: string): void {
		const observed = this.#processStart(pid);
		if (observed !== pidStart) {
			throw new Error(
				`lead process ${pid} start identity mismatch (expected ${JSON.stringify(pidStart)}, observed ${JSON.stringify(observed)}) — refusing the paste (pid reuse guard)`,
			);
		}
	}

	async #resolveLeadPane(pid: number): Promise<string> {
		if (!Number.isSafeInteger(pid) || pid <= 1) {
			throw new Error(`lead pane pid ${pid} is not addressable`);
		}
		const panes = await this.#command.run(this.#options.tmuxBin, [
			"list-panes",
			"-a",
			"-F",
			"#{pane_pid} #{pane_id}",
		]);
		const paneByPid = new Map<number, string>();
		for (const line of panes.stdout.split("\n")) {
			const match = /^([1-9][0-9]*) (%[0-9]+)$/.exec(line.trim());
			if (match) paneByPid.set(Number(match[1]), match[2] as string);
		}
		const processes = await this.#command.run("/bin/ps", [
			"-axo",
			"pid=,ppid=",
		]);
		const parentOf = new Map<number, number>();
		for (const line of processes.stdout.split("\n")) {
			const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/.exec(line);
			if (match) parentOf.set(Number(match[1]), Number(match[2]));
		}
		if (!parentOf.has(pid)) {
			throw new Error(`lead process ${pid} is not alive`);
		}
		let current: number | undefined = pid;
		const seen = new Set<number>();
		while (current !== undefined && current > 1 && !seen.has(current)) {
			const pane = paneByPid.get(current);
			if (pane) return pane;
			seen.add(current);
			current = parentOf.get(current);
		}
		throw new Error(`no tmux pane hosts lead process ${pid}`);
	}

	async #pasteInto(
		target: string,
		buffer: string,
		text: string,
	): Promise<void> {
		await this.#command.run(this.#options.tmuxBin, [
			"set-buffer",
			"-b",
			buffer,
			text,
		]);
		await this.#command.run(this.#options.tmuxBin, [
			"paste-buffer",
			"-p",
			"-d",
			"-b",
			buffer,
			"-t",
			target,
		]);
		await this.#command.run(this.#options.tmuxBin, [
			"send-keys",
			"-t",
			target,
			"Enter",
		]);
	}
}
