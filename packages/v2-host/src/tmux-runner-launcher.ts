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
import { requestCmuxPinClose } from "flywheel-teamlead/bridge/cmux-close-request";
import type { SessionBinding } from "flywheel-v2-engine";
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
}

/**
 * FLY-1550: byte contract with `EVENT_FILE` in scripts/flywheel-cmux-sync.sh.
 */
const CMUX_EVENT_FILE = "/tmp/flywheel-cmux-events";

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
	const prompt = [
		`Flywheel v2 runner bootstrap for ${request.context.issueId}.`,
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
		return {
			binary: options.claudeBin,
			args: [
				"--session-id",
				randomUUID(),
				"--permission-mode",
				"bypassPermissions",
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
		return `v2-${safeKey(sessionRef).slice(0, 32)}`;
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
		const pinnedPath = this.#materializeInstruction(request, instruction);
		const vendorCommand = commandForVendor(
			request,
			this.#options,
			vendor,
			instruction,
			pinnedPath,
		);
		const prior = await this.probe(request.sessionRef);
		if (prior.state === "present") return prior.sessionBinding;

		const sessionName = this.#sessionName(request.sessionRef);
		const releasePath = this.#releasePath(request.sessionRef);
		if (existsSync(releasePath)) unlinkSync(releasePath);
		// FLY-1550: the window name is the founder-facing cmux workspace title.
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
		const buffer = `flywheel-v2-doorbell-${safeKey(sessionRef).slice(0, 12)}`;
		const target = `=${sessionName}:0.0`;
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
