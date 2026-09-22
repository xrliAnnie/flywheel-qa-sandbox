/**
 * FLY-259 PR-C — tui-window: ensure the founder-facing tmux window running the
 * REAL interactive `codex resume --remote` TUI against the Lead's shared
 * remote-control daemon.
 *
 * Shape adapted from FLY-242 #249's `ensureObserverWindow` (that PR is HELD/
 * superseded — the window-lifecycle learnings carry over, the renderer does
 * not): tmux probe → ensure session → UNCONDITIONAL same-named stale-kill
 * (the dead-pane cure must not depend on any opt-out — FLY-242 R1 MED-3) →
 * create the window. Window name is EXACTLY `<project>-<leadId>` (FLY-169
 * MANAGED-title hard contract; backend info never goes into the title).
 *
 * A remote resume inherits permissions from the app-server-owned thread and
 * config.toml. Codex 0.154 rejects client-side `-s`, `approval_policy`, and
 * `default_permissions` overrides for remote tasks, so the founder TUI passes
 * none of them. `-C <cwd>` kills the resume cwd-menu; the trusted project entry
 * in config.toml kills the trust-menu (both spike-verified — zero boot menus).
 *
 * Observation only + fail-open: ensure failures cost visibility, never the
 * Lead (the sidecar keeps serving Discord; it re-ensures on its own cadence —
 * PR-D). All side effects injected for tests.
 */

import { execFile, spawnSync } from "node:child_process";
import { basename } from "node:path";
import {
	buildTmuxServerBirthEnvironment,
	withSyncOpMarker,
} from "flywheel-claude-runner";

import {
	buildLeadModelEnv,
	type LeadModelEnvPins,
} from "../../lead-capabilities/model-env.js";

/** Trusted parent inputs, never reconstructed from model-supplied environment. */
export interface TuiCapabilityModelEnv {
	pins: LeadModelEnvPins;
	env: NodeJS.ProcessEnv;
}

export const TUI_TMUX_SESSION = "flywheel";
const TUI_TMUX_FIELD_SEPARATOR = "|";

export interface TuiWindowSpec {
	projectName: string;
	leadId: string;
	/** The Lead's isolated CODEX_HOME (daemon socket + auth + pins live here). */
	codexHome: string;
	/** Thread the TUI must resume (created/owned by the sidecar — machine
	 * thread/start is the mainline; SP-3 discovery is fallback knowledge only). */
	threadId: string;
	/** Working directory for the TUI (`-C` — kills the resume cwd menu). */
	cwd: string;
	/** codex binary (default "codex"). */
	codexBin?: string;
	/** FLY-398 compatibility field. The app-server-owned remote thread already
	 * carries this permission tier; the TUI command must not override it. */
	fullAccess?: boolean;
	/** FLY-1309 generation capability, inherited by the founder TUI shell. */
	carrierInstanceId?: string;
	capabilityModelEnv?: TuiCapabilityModelEnv;
	/** Trusted parent-owned socket; only valid with capabilityModelEnv. */
	capabilitySocketPath?: string;
}

/** The command string is executed by tmux via a shell — every interpolated
 * value is system-derived config (launcher env / sidecar), NOT user input,
 * but we validate at the boundary anyway (Non-Negotiable): a value that
 * could break out of its quoting is a config error → throw (fail-loud). */
function assertShellSafe(name: string, value: string, re: RegExp): string {
	if (!re.test(value)) {
		throw new Error(
			`tui-window: ${name} contains characters unsafe for the tmux shell command: ${JSON.stringify(value)}`,
		);
	}
	return value;
}
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/; // absolute paths, no quotes/spaces/metachars
export const SAFE_ID = /^[A-Za-z0-9-]+$/; // thread ids are UUID-shaped
const SAFE_BIN = /^[A-Za-z0-9_./-]+$/;
const SAFE_CARRIER_ID = /^[A-Za-z0-9_-]+$/;

/** Build the exact TUI command line (pure — unit-testable; quoted for the
 * shell tmux spawns). The remote socket path is derived from codexHome. */
export function buildTuiCommand(spec: TuiWindowSpec): string {
	assertShellSafe("codexHome", spec.codexHome, SAFE_PATH);
	assertShellSafe("cwd", spec.cwd, SAFE_PATH);
	assertShellSafe("threadId", spec.threadId, SAFE_ID);
	if (spec.codexBin) assertShellSafe("codexBin", spec.codexBin, SAFE_BIN);
	if (spec.carrierInstanceId) {
		assertShellSafe(
			"carrierInstanceId",
			spec.carrierInstanceId,
			SAFE_CARRIER_ID,
		);
	}
	const bin = spec.codexBin ?? "codex";
	const sock =
		spec.capabilitySocketPath ??
		`${spec.codexHome}/app-server-control/app-server-control.sock`;
	if (spec.capabilitySocketPath) {
		assertShellSafe("capabilitySocketPath", sock, SAFE_PATH);
		if (
			!spec.capabilityModelEnv ||
			!sock.startsWith("/") ||
			sock.split("/").includes("..") ||
			Buffer.byteLength(sock) > 103
		)
			throw new Error("tui-window: invalid capability socket");
	}
	if (spec.capabilityModelEnv) {
		const { pins, env } = spec.capabilityModelEnv;
		if (
			pins.codexHome !== spec.codexHome ||
			pins.projectName !== spec.projectName ||
			pins.leadId !== spec.leadId
		)
			throw new Error("tui-window: capability identity mismatch");
		const modelEnv = buildLeadModelEnv(env, pins);
		const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
		return [
			"/usr/bin/env",
			"-i",
			...Object.entries(modelEnv).map(([key, value]) =>
				quote(`${key}=${value}`),
			),
			quote(bin),
			"resume",
			"--remote",
			quote(`unix://${sock}`),
			"-C",
			quote(spec.cwd),
			quote(spec.threadId),
		].join(" ");
	}
	return [
		`CODEX_HOME="${spec.codexHome}"`,
		bin,
		"resume",
		`--remote "unix://${sock}"`,
		`-C "${spec.cwd}"`,
		spec.threadId,
	].join(" ");
}

export interface EnsureTuiWindowDeps {
	exec?: (
		cmd: string,
		args: string[],
		options?: { env?: NodeJS.ProcessEnv },
	) => { ok: boolean };
	log?: (m: string) => void;
}

function defaultExec(
	cmd: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv } = {},
): { ok: boolean } {
	try {
		const subcommand = args.find((arg) => !arg.startsWith("-")) ?? cmd;
		const r = withSyncOpMarker(`codex-tui:${subcommand}`, () =>
			spawnSync(cmd, args, {
				stdio: "ignore",
				timeout: 10_000,
				...(options.env ? { env: options.env } : {}),
			}),
		);
		return { ok: r.status === 0 };
	} catch {
		return { ok: false };
	}
}

/**
 * Ensure the TUI window. Returns true when the window was (re)created.
 * Steps (each fail-open):
 *   1. `tmux -V` probe — absent → skip all (headless box: Lead still serves
 *      Discord, only the terminal view is missing).
 *   2. ensure shared session (idempotent attach-or-create).
 *   3. UNCONDITIONAL stale-kill of `<project>-<leadId>` (old Claude dead pane
 *      from a backend switch / a previous TUI's remains).
 *   4. create the window running the real TUI.
 */
export function ensureTuiWindow(
	spec: TuiWindowSpec,
	deps: EnsureTuiWindowDeps = {},
): boolean {
	const exec = deps.exec ?? defaultExec;
	const log = deps.log ?? (() => {});
	const windowName = `${spec.projectName}-${spec.leadId}`;
	const legacyCarrierEnv =
		spec.carrierInstanceId && !spec.capabilityModelEnv
			? [
					"-e",
					`FLYWHEEL_LEAD_CARRIER_INSTANCE_ID=${spec.carrierInstanceId}`,
					"-e",
					`FLYWHEEL_LEAD_ID=${spec.leadId}`,
					"-e",
					`FLYWHEEL_PROJECT_NAME=${spec.projectName}`,
				]
			: [];
	try {
		if (!exec("tmux", ["-V"]).ok) {
			log(`tui-window: tmux unavailable — skipping (${windowName})`);
			return false;
		}
		exec("tmux", ["new-session", "-Ad", "-s", TUI_TMUX_SESSION], {
			env: buildTmuxServerBirthEnvironment(),
		});
		exec("tmux", ["kill-window", "-t", `=${TUI_TMUX_SESSION}:=${windowName}`]);
		const target = `=${TUI_TMUX_SESSION}:=${windowName}`;
		const created = exec("tmux", [
			"new-window",
			"-d",
			"-t",
			`=${TUI_TMUX_SESSION}`,
			"-n",
			windowName,
		]);
		if (!created.ok) {
			log(
				`tui-window: create failed (non-fatal, Lead unaffected): ${windowName}`,
			);
			return false;
		}
		// Scope exit retention to this exact window. Creating the shell first lets
		// us arm remain-on-exit before the real TUI starts, so a sub-second resume
		// failure still leaves an exit code and terminal tail for diagnosis.
		const retained = exec("tmux", [
			"set-window-option",
			"-t",
			target,
			"remain-on-exit",
			"on",
		]);
		const launched = retained.ok
			? exec("tmux", [
					"respawn-pane",
					"-k",
					"-t",
					target,
					...legacyCarrierEnv,
					buildTuiCommand(spec),
				])
			: { ok: false };
		if (!retained.ok || !launched.ok) {
			exec("tmux", ["kill-window", "-t", target]);
			log(
				`tui-window: retained launch failed (non-fatal, Lead unaffected): ${windowName}`,
			);
			return false;
		}
		log(
			`tui-window: window_created_unverified (${windowName}, thread ${spec.threadId})`,
		);
		return true;
	} catch (err) {
		log(`tui-window: ensure failed (non-fatal): ${(err as Error).message}`);
		return false;
	}
}

export interface TuiWindowIdentity {
	windowName: string;
	paneId: string;
	panePid: number;
	startCommand: string;
	currentCommand: string;
	modelAlive: boolean;
}

type TuiExecOut = (cmd: string, args: string[]) => string | undefined;

function defaultExecOut(cmd: string, args: string[]): string | undefined {
	try {
		const subcommand = args.find((arg) => !arg.startsWith("-")) ?? cmd;
		const r = withSyncOpMarker(`codex-tui:${subcommand}`, () =>
			spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000 }),
		);
		return r.status === 0 ? r.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

function parseTuiWindowIdentity(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId" | "codexBin">,
	out: string | undefined,
): TuiWindowIdentity | null {
	const windowName = `${spec.projectName}-${spec.leadId}`;
	if (!out) return null;
	const fields = out.trim().split(TUI_TMUX_FIELD_SEPARATOR);
	if (fields.length !== 6) return null;
	const [
		actualName,
		paneDead,
		paneId,
		panePidRaw,
		startCommand,
		currentCommand,
	] = fields;
	if (
		actualName !== windowName ||
		paneDead !== "0" ||
		!/^%[1-9][0-9]*$/.test(paneId ?? "") ||
		!/^[1-9][0-9]*$/.test(panePidRaw ?? "") ||
		!startCommand ||
		!currentCommand
	)
		return null;
	const expectedCommand = basename(spec.codexBin ?? "codex");
	return {
		windowName,
		paneId: paneId!,
		panePid: Number(panePidRaw),
		startCommand,
		currentCommand,
		modelAlive: basename(currentCommand) === expectedCommand,
	};
}

function tuiIdentityArgs(windowName: string): string[] {
	return [
		"display-message",
		"-p",
		"-t",
		`=${TUI_TMUX_SESSION}:=${windowName}`,
		"#{window_name}|#{pane_dead}|#{pane_id}|#{pane_pid}|#{pane_start_command}|#{pane_current_command}",
	];
}

/**
 * Read the exact pane tuple used by the asynchronous stability proof. A live
 * tmux pane is returned even while its child is still starting; modelAlive is
 * separate so the second sample can require the real Codex process instead of
 * mistaking the wrapper shell for the TUI.
 */
export function readTuiWindowIdentity(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId" | "codexBin">,
	deps: { execOut?: TuiExecOut } = {},
): TuiWindowIdentity | null {
	const windowName = `${spec.projectName}-${spec.leadId}`;
	return parseTuiWindowIdentity(
		spec,
		(deps.execOut ?? defaultExecOut)("tmux", tuiIdentityArgs(windowName)),
	);
}

/** Async variant used by the five-second proof so tmux process I/O never
 * blocks the runtime event loop. */
export async function readTuiWindowIdentityAsync(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId" | "codexBin">,
	deps: {
		execOut?: (cmd: string, args: string[]) => Promise<string | undefined>;
	} = {},
): Promise<TuiWindowIdentity | null> {
	const windowName = `${spec.projectName}-${spec.leadId}`;
	const execOut =
		deps.execOut ??
		((cmd: string, args: string[]) =>
			new Promise<string | undefined>((resolve) => {
				execFile(
					cmd,
					args,
					{ encoding: "utf8", timeout: 5_000 },
					(error, stdout) => resolve(error ? undefined : stdout.trim()),
				);
			}));
	return parseTuiWindowIdentity(
		spec,
		await execOut("tmux", tuiIdentityArgs(windowName)),
	);
}

function sameTuiPaneTuple(
	first: TuiWindowIdentity,
	second: TuiWindowIdentity,
): boolean {
	return (
		first.windowName === second.windowName &&
		first.paneId === second.paneId &&
		first.panePid === second.panePid &&
		first.startCommand === second.startCommand
	);
}

export const TUI_VISIBILITY_STABILITY_MS = 5_000;

export const TUI_INSTANT_DEATH_THRESHOLD = 3;
export const TUI_RETRY_BACKOFF_BASE_MS = 60_000;
export const TUI_RETRY_BACKOFF_MAX_MS = 15 * 60_000;

/** Process-scoped retry policy for windows that repeatedly die before the
 * five-second stability proof. Ordinary single failures retain the 20-second
 * recovery cadence; the third and later failures use bounded exponential
 * backoff so a broken resume cannot churn tmux forever. */
export class TuiWindowRetryBackoff {
	private consecutiveFailures = 0;
	private retryNotBefore = 0;

	canAttempt(now = Date.now()): boolean {
		return now >= this.retryNotBefore;
	}

	recordFailure(now = Date.now()): number {
		this.consecutiveFailures += 1;
		if (this.consecutiveFailures < TUI_INSTANT_DEATH_THRESHOLD) return 0;
		const exponent = this.consecutiveFailures - TUI_INSTANT_DEATH_THRESHOLD;
		const delay = Math.min(
			TUI_RETRY_BACKOFF_BASE_MS * 2 ** exponent,
			TUI_RETRY_BACKOFF_MAX_MS,
		);
		this.retryNotBefore = now + delay;
		return delay;
	}

	recordHealthy(): void {
		this.consecutiveFailures = 0;
		this.retryNotBefore = 0;
	}
}

export interface TuiWindowExitEvidence {
	windowName: string;
	paneId: string;
	exitStatus: number | null;
	terminalTail: string[];
}

const EXIT_TAIL_LINES = 20;
const EXIT_TAIL_LINE_BYTES = 240;
// biome-ignore lint/complexity/useRegexLiterals: a constructor keeps escaped control characters out of the source regex literal.
const ANSI_CSI_SEQUENCE = new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g");
// biome-ignore lint/complexity/useRegexLiterals: a constructor keeps escaped control characters out of the source regex literal.
const UNSAFE_CONTROL_CHARACTERS = new RegExp(
	"[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]",
	"g",
);

function sanitizeTerminalTail(raw: string): string[] {
	return raw
		.replace(ANSI_CSI_SEQUENCE, "")
		.split(/\r?\n/)
		.map((line) =>
			line
				.replace(UNSAFE_CONTROL_CHARACTERS, "")
				.replace(/Bearer\s+\S+/gi, "[redacted]")
				.replace(
					/\b([A-Za-z0-9_-]*(?:token|secret|authorization|api[_-]?key)[A-Za-z0-9_-]*)\s*[:=]\s*\S.*/gi,
					"$1=[redacted]",
				)
				.slice(0, EXIT_TAIL_LINE_BYTES),
		)
		.filter((line) => line.trim().length > 0)
		.slice(-EXIT_TAIL_LINES);
}

/** Read exit-only evidence from the exact retained pane. No pane command or
 * environment is logged; terminal output is bounded, control-stripped and
 * redacted before it leaves this boundary. */
export async function readTuiWindowExitEvidenceAsync(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId">,
	deps: {
		execOut?: (cmd: string, args: string[]) => Promise<string | undefined>;
	} = {},
): Promise<TuiWindowExitEvidence | null> {
	const windowName = `${spec.projectName}-${spec.leadId}`;
	const target = `=${TUI_TMUX_SESSION}:=${windowName}`;
	const execOut =
		deps.execOut ??
		((cmd: string, args: string[]) =>
			new Promise<string | undefined>((resolve) => {
				execFile(
					cmd,
					args,
					{ encoding: "utf8", timeout: 5_000 },
					(error, stdout) => resolve(error ? undefined : stdout),
				);
			}));
	const pane = (
		await execOut("tmux", [
			"display-message",
			"-p",
			"-t",
			target,
			"#{window_name}|#{pane_dead}|#{pane_id}|#{pane_dead_status}",
		])
	)?.trim();
	if (!pane) return null;
	const [actualName, dead, paneId, exitStatusRaw] = pane.split(
		TUI_TMUX_FIELD_SEPARATOR,
	);
	if (
		actualName !== windowName ||
		dead !== "1" ||
		!/^%[1-9][0-9]*$/.test(paneId ?? "")
	)
		return null;
	const rawTail =
		(await execOut("tmux", [
			"capture-pane",
			"-p",
			"-J",
			"-S",
			`-${EXIT_TAIL_LINES}`,
			"-t",
			target,
		])) ?? "";
	return {
		windowName,
		paneId: paneId!,
		exitStatus: /^-?[0-9]+$/.test(exitStatusRaw ?? "")
			? Number(exitStatusRaw)
			: null,
		terminalTail: sanitizeTerminalTail(rawTail),
	};
}

/**
 * Prove that the created pane kept the same identity for five seconds and now
 * owns a live Codex model process. The caller owns generation/thread fencing;
 * cancel resolves fail-closed so an obsolete callback cannot become healthy.
 */
export function beginTuiWindowVisibilityProof(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId" | "codexBin">,
	first: TuiWindowIdentity,
	deps: {
		readIdentity?: () =>
			| TuiWindowIdentity
			| null
			| Promise<TuiWindowIdentity | null>;
		setTimeoutFn?: (
			fn: () => void,
			ms: number,
		) => ReturnType<typeof setTimeout>;
		clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
	} = {},
): {
	promise: Promise<TuiWindowIdentity | null>;
	cancel(): void;
} {
	const readIdentity =
		deps.readIdentity ?? (() => readTuiWindowIdentityAsync(spec));
	const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
	let settled = false;
	let resolveProof!: (identity: TuiWindowIdentity | null) => void;
	const promise = new Promise<TuiWindowIdentity | null>((resolve) => {
		resolveProof = resolve;
	});
	const settle = (identity: TuiWindowIdentity | null) => {
		if (settled) return;
		settled = true;
		resolveProof(identity);
	};
	const timer = setTimeoutFn(() => {
		void Promise.resolve(readIdentity())
			.then((second) =>
				settle(
					second?.modelAlive && sameTuiPaneTuple(first, second) ? second : null,
				),
			)
			.catch(() => settle(null));
	}, TUI_VISIBILITY_STABILITY_MS);
	return {
		promise,
		cancel() {
			if (settled) return;
			clearTimeoutFn(timer);
			settle(null);
		},
	};
}

/** ID-scoped liveness probe for the TUI window (PR-D's death-detection input;
 * identity-echo defends against tmux resolving a missing target to the
 * session's current window — FLY-242 #248 real-tmux smoke finding). */
export function isTuiWindowAlive(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId">,
	deps: {
		execOut?: (cmd: string, args: string[]) => string | undefined;
	} = {},
): boolean {
	const windowName = `${spec.projectName}-${spec.leadId}`;
	const execOut = deps.execOut ?? defaultExecOut;
	const out = execOut("tmux", [
		"display-message",
		"-p",
		"-t",
		`=${TUI_TMUX_SESSION}:=${windowName}`,
		"#{window_name} #{pane_dead}",
	]);
	return out === `${windowName} 0`;
}

/**
 * Explicitly tear down the TUI window (FLY-259 PR-D review HIGH-1: on generation
 * stop / runtime shutdown the founder's `codex resume --remote` window must be
 * killed — leaving it alive orphans a TUI pointing at a dead daemon socket and
 * violates the cutover "stop the sidecar/TUI first" contract). Targets the same
 * `=session:=window` selector ensureTuiWindow creates; fail-open (never throws —
 * a missing window is already the goal state).
 */
export function killTuiWindow(
	spec: Pick<TuiWindowSpec, "projectName" | "leadId">,
	deps: EnsureTuiWindowDeps & {
		execOut?: (cmd: string, args: string[]) => string | undefined;
	} = {},
): boolean {
	const exec = deps.exec ?? defaultExec;
	const log = deps.log ?? (() => {});
	const windowName = `${spec.projectName}-${spec.leadId}`;
	try {
		exec("tmux", ["kill-window", "-t", `=${TUI_TMUX_SESSION}:=${windowName}`]);
		if (isTuiWindowAlive(spec, { execOut: deps.execOut })) return false;
		log(`tui-window: killed (${windowName})`);
		return true;
	} catch (err) {
		log(`tui-window: kill failed (non-fatal): ${(err as Error).message}`);
		return false;
	}
}
