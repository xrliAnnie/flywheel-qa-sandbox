import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	assertSocketPathFitsSunLen,
	CodexDaemonClient,
	connectDaemonTransport,
} from "flywheel-claude-runner";
import {
	ClaudeInjectionShim,
	CodexInjectionShim,
	type SessionBinding,
} from "flywheel-v2-engine";
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

export interface CodexRunnerControlPort {
	ensureThread(input: {
		socketPath: string;
		threadId: string | null;
		cwd: string;
		model: string;
		baseInstructions: string;
	}): Promise<string>;
	deliver(
		sessionRef: string,
		message: { messageUid: string; attemptUid: string; payload: string },
	): Promise<void>;
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
	/** Codex R1 MEDIUM-5: root that every injection-derived path must stay inside.
	 * configDir is walked up from an injection ref, so without containment a
	 * crafted ref could aim the writes below at $HOME/.claude.json. */
	injectionRoot: string;
	/**
	 * Codex R4 MEDIUM-2: operator-provisioned Claude credentials.
	 *
	 * Making the config root per-activation (R3 MEDIUM-5/7) broke credentials. A
	 * fresh CLAUDE_CONFIG_DIR contains no `.credentials.json`, Claude only reads
	 * that file when CLAUDE_CONFIG_DIR is non-default -- not the Keychain -- and the
	 * runner is started with `/usr/bin/env -i` and an allowlist carrying neither
	 * CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY. So every spawn would have sat
	 * at an interactive login. "the operator provisions once per config dir" is
	 * incompatible with "a new dir per activation", so the source is named once
	 * here and each activation is linked to it.
	 */
	claudeCredentialsPath: string;
	command?: TmuxCommandPort;
	codexControl?: CodexRunnerControlPort;
	claudeDeliver?: (
		sessionRef: string,
		message: { messageUid: string; attemptUid: string; payload: string },
	) => Promise<void>;
	now?: () => Date;
	processStart?: (pid: number) => string | null;
	/**
	 * How long #acquireOnboardingLock waits for a live holder before failing
	 * closed. Deployment-relevant (a slow disk can need longer) and lets the
	 * contention test assert the waiting behaviour without burning the default.
	 */
	onboardingLockTimeoutMs?: number;
}

interface RunnerState {
	v: 1;
	session_ref: string;
	vendor: "claude" | "codex";
	project_root: string;
	instruction_source_path: string;
	instruction_content_digest: string;
	instruction_content_bytes: number;
	injection_ref: string;
	model: string;
	effort: string;
	thread_id: string | null;
}

/**
 * Codex R3 MEDIUM-5: bounded wait rather than a spin, and a stale threshold well
 * above any plausible merge duration so a live holder is never robbed on age.
 */
const ONBOARDING_LOCK_TIMEOUT_MS = 10_000;
const ONBOARDING_LOCK_POLL_MS = 25;
const ONBOARDING_LOCK_STALE_MS = 120_000;

interface OnboardingLockHolder {
	token: string;
	pid: number;
	pidStart: string | null;
	acquiredAtMs: number;
	ino: number;
}

interface ClaudeTarget {
	configDir: string;
	teamName: string;
	agentName: string;
	inboxPath: string;
	sidecarPath: string;
}

interface CodexTarget {
	v: 1;
	backend: "codex";
	socketPath: string;
	threadId: string;
}

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

function verifyInstruction(input: {
	sourcePath: string;
	contentDigest: string;
	contentBytes: number;
}): Buffer {
	let bytes: Buffer;
	try {
		if (lstatSync(input.sourcePath).isSymbolicLink()) {
			throw new RunnerLaunchConfigError(
				"pinned role instruction became a symlink",
			);
		}
		if (realpathSync(input.sourcePath) !== input.sourcePath) {
			throw new RunnerLaunchConfigError(
				"pinned role instruction canonical path changed",
			);
		}
		bytes = readFileSync(input.sourcePath);
	} catch (error) {
		if (error instanceof RunnerLaunchConfigError) throw error;
		throw new RunnerLaunchConfigError(
			`pinned role instruction cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		bytes.length !== input.contentBytes ||
		createHash("sha256").update(bytes).digest("hex") !== input.contentDigest
	) {
		throw new RunnerLaunchConfigError(
			"pinned role instruction changed before runner launch",
		);
	}
	return bytes;
}

function verifyPinnedInstruction(request: RuntimeLaunchRequest): Buffer {
	return verifyInstruction({
		sourcePath: request.context.instruction.sourcePath,
		contentDigest: request.context.instruction.contentDigest,
		contentBytes: request.context.instruction.contentBytes,
	});
}

function vendorKind(value: string): "claude" | "codex" {
	const normalized = value.trim().toLowerCase();
	if (normalized === "claude" || normalized === "claude-code") return "claude";
	if (normalized === "codex") return "codex";
	throw new RunnerLaunchConfigError(
		`unsupported runner vendor ${value || "<empty>"}`,
	);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RunnerLaunchConfigError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new RunnerLaunchConfigError(`${label} must be a non-empty string`);
	}
	return value;
}

function exactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return (
		actual.length === wanted.length &&
		actual.every((key, index) => key === wanted[index])
	);
}

function parseClaudeTarget(value: string): ClaudeTarget {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new RunnerLaunchConfigError(
			"Claude injection reference is malformed",
		);
	}
	const input = record(parsed, "Claude injection reference");
	if (
		!exactKeys(input, [
			"backend",
			"inboxPath",
			"sidecarPath",
			"toAgent",
			"v",
		]) ||
		input.v !== 1 ||
		input.backend !== "claude"
	) {
		throw new RunnerLaunchConfigError(
			"Claude injection reference has an invalid shape",
		);
	}
	const inboxPath = absolute(
		text(input.inboxPath, "Claude inboxPath"),
		"Claude inboxPath",
	);
	const sidecarPath = absolute(
		text(input.sidecarPath, "Claude sidecarPath"),
		"Claude sidecarPath",
	);
	const agentName = text(input.toAgent, "Claude toAgent");
	const inboxDir = dirname(inboxPath);
	const teamDir = dirname(inboxDir);
	const teamsDir = dirname(teamDir);
	const configDir = dirname(teamsDir);
	const teamName = basename(teamDir);
	if (
		basename(inboxDir) !== "inboxes" ||
		basename(teamsDir) !== "teams" ||
		basename(inboxPath) !== `${agentName}.json` ||
		sidecarPath !== `${inboxPath}.flywheel.jsonl` ||
		!/^v2-[a-z0-9-]+$/.test(teamName) ||
		!/^[A-Za-z0-9_-]+$/.test(agentName)
	) {
		throw new RunnerLaunchConfigError(
			"Claude injection reference does not name the isolated stock inbox",
		);
	}
	// Codex R3 MEDIUM-5/7: the config dir must be per-activation. The builder now
	// emits `<root>/claude/<sha256(activationId)>`, and this checks that shape
	// rather than trusting the path it was handed.
	//
	// A ref written before that change resolves configDir to `<root>/claude` and
	// is still accepted, so an activation that is already in flight can still be
	// probed and stopped across the deploy that introduces this. Only the emitted
	// shape carries the isolation guarantee; nothing but the dispatcher writes
	// refs, and containment confines either shape to the injection root.
	const perActivation =
		basename(dirname(configDir)) === "claude" &&
		/^[0-9a-f]{64}$/.test(basename(configDir));
	const legacyShared = basename(configDir) === "claude";
	if (!perActivation && !legacyShared) {
		throw new RunnerLaunchConfigError(
			"Claude injection reference does not name a recognised config root",
		);
	}
	return {
		configDir,
		teamName,
		agentName,
		inboxPath,
		sidecarPath,
	};
}

function parseCodexTarget(value: string): CodexTarget {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new RunnerLaunchConfigError("Codex injection reference is malformed");
	}
	const input = record(parsed, "Codex injection reference");
	if (
		!exactKeys(input, ["backend", "socketPath", "threadId", "v"]) ||
		input.v !== 1 ||
		input.backend !== "codex"
	) {
		throw new RunnerLaunchConfigError(
			"Codex injection reference has an invalid shape",
		);
	}
	return {
		v: 1,
		backend: "codex",
		socketPath: absolute(
			text(input.socketPath, "Codex socketPath"),
			"Codex socketPath",
		),
		threadId: text(input.threadId, "Codex threadId"),
	};
}

function runnerPrompt(request: RuntimeLaunchRequest): string {
	const instruction = request.context.instruction;
	return [
		`Flywheel v2 runner bootstrap for ${request.context.issueId}.`,
		`The complete role authority is pinned at ${instruction.sourcePath} with SHA-256 ${instruction.contentDigest}.`,
		"Do not use any legacy control-plane CLI, inbox, Bridge, adapter, or database.",
		"Wait for work delivered through this isolated v2 vendor session. Each injected envelope carries the durable issue context, exact attempt/message identities, and proposal authorization.",
		"Submit effects only through the flywheel-v2 CLI named by FLYWHEEL_V2_CLIENT_CLI and the authenticated host socket in this session environment.",
		`Activation: ${request.activationId}. Session: ${request.sessionRef}.`,
	].join("\n");
}

function cleanRunnerEnvironment(v2Environment: string[]): string[] {
	const inherited: string[] = [];
	for (const key of [
		"HOME",
		"PATH",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"CODEX_HOME",
	] as const) {
		const value = process.env[key];
		if (!value || value.includes("\0")) continue;
		if (
			(key === "HOME" || key === "TMPDIR" || key === "CODEX_HOME") &&
			!isAbsolute(value)
		) {
			continue;
		}
		inherited.push(`${key}=${value}`);
	}
	return [...inherited, ...v2Environment];
}

function commandForVendor(
	request: RuntimeLaunchRequest,
	options: TmuxRunnerLauncherOptions,
	kind: "claude" | "codex",
): { binary: string; args: string[] } {
	if (!EFFORTS.has(request.executor.effort)) {
		throw new RunnerLaunchConfigError(
			`unsupported runner effort ${request.executor.effort}`,
		);
	}
	if (kind === "claude") {
		const target = parseClaudeTarget(request.injectionRef);
		return {
			binary: options.claudeBin,
			args: [
				"--session-id",
				randomUUID(),
				"--permission-mode",
				"bypassPermissions",
				"--append-system-prompt-file",
				request.context.instruction.sourcePath,
				"--model",
				request.executor.model,
				"--effort",
				request.executor.effort,
				"--name",
				safeName(
					`v2-${request.context.issueId}-${request.agent.agentId}`,
					"v2-runner",
				),
				"--agent-id",
				`${target.agentName}@${target.teamName}`,
				"--agent-name",
				target.agentName,
				"--team-name",
				target.teamName,
				runnerPrompt(request),
			],
		};
	}
	const target = parseCodexTarget(request.injectionRef);
	return {
		binary: options.codexBin,
		args: [
			"app-server",
			"--remote-control",
			"--listen",
			`unix://${target.socketPath}`,
			"-c",
			`model_reasoning_effort=${JSON.stringify(request.executor.effort)}`,
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

function defaultCodexControl(): CodexRunnerControlPort {
	return {
		async ensureThread(input) {
			const transport = await connectDaemonTransport({
				socketPath: input.socketPath,
				connectTimeoutMs: 10_000,
			});
			const client = new CodexDaemonClient({
				transport,
				requestTimeoutMs: 30_000,
				clientName: "flywheel-v2-runner-launcher",
			});
			try {
				await client.initialize();
				return input.threadId
					? await client.resumeThread(input.threadId)
					: await client.startThread({
							cwd: input.cwd,
							sandbox: "workspace-write",
							approvalPolicy: "never",
							model: input.model,
							baseInstructions: input.baseInstructions,
						});
			} finally {
				client.close();
			}
		},
		async deliver(sessionRef, message) {
			await new CodexInjectionShim().deliver(sessionRef, message);
		},
	};
}

function parseRunnerState(value: unknown): RunnerState {
	const input = record(value, "runner state");
	if (
		!exactKeys(input, [
			"effort",
			"injection_ref",
			"instruction_content_bytes",
			"instruction_content_digest",
			"instruction_source_path",
			"model",
			"project_root",
			"session_ref",
			"thread_id",
			"v",
			"vendor",
		]) ||
		input.v !== 1 ||
		(input.vendor !== "claude" && input.vendor !== "codex") ||
		!Number.isSafeInteger(input.instruction_content_bytes) ||
		(input.instruction_content_bytes as number) <= 0 ||
		(input.thread_id !== null && typeof input.thread_id !== "string")
	) {
		throw new RunnerLaunchConfigError("runner state has an invalid shape");
	}
	return {
		v: 1,
		session_ref: text(input.session_ref, "runner state session_ref"),
		vendor: input.vendor,
		project_root: absolute(
			text(input.project_root, "runner state project_root"),
			"runner state project_root",
		),
		instruction_source_path: absolute(
			text(
				input.instruction_source_path,
				"runner state instruction_source_path",
			),
			"runner state instruction_source_path",
		),
		instruction_content_digest: text(
			input.instruction_content_digest,
			"runner state instruction_content_digest",
		),
		instruction_content_bytes: input.instruction_content_bytes as number,
		injection_ref: text(input.injection_ref, "runner state injection_ref"),
		model: text(input.model, "runner state model"),
		effort: text(input.effort, "runner state effort"),
		thread_id:
			input.thread_id === null
				? null
				: text(input.thread_id, "runner state thread_id"),
	};
}

function stateFromRequest(
	request: RuntimeLaunchRequest,
	vendor: "claude" | "codex",
): RunnerState {
	return {
		v: 1,
		session_ref: request.sessionRef,
		vendor,
		project_root: request.context.projectRoot,
		instruction_source_path: request.context.instruction.sourcePath,
		instruction_content_digest: request.context.instruction.contentDigest,
		instruction_content_bytes: request.context.instruction.contentBytes,
		injection_ref: request.injectionRef,
		model: request.executor.model,
		effort: request.executor.effort,
		thread_id: null,
	};
}

function sameStateAuthority(left: RunnerState, right: RunnerState): boolean {
	return (
		left.v === right.v &&
		left.session_ref === right.session_ref &&
		left.vendor === right.vendor &&
		left.project_root === right.project_root &&
		left.instruction_source_path === right.instruction_source_path &&
		left.instruction_content_digest === right.instruction_content_digest &&
		left.instruction_content_bytes === right.instruction_content_bytes &&
		left.injection_ref === right.injection_ref &&
		left.model === right.model &&
		left.effort === right.effort
	);
}

export class TmuxRunnerLauncher implements RunnerLauncherPort {
	readonly #options: TmuxRunnerLauncherOptions;
	readonly #command: TmuxCommandPort;
	readonly #codexControl: CodexRunnerControlPort;
	readonly #claudeDeliver: NonNullable<
		TmuxRunnerLauncherOptions["claudeDeliver"]
	>;
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
		this.#codexControl = options.codexControl ?? defaultCodexControl();
		this.#claudeDeliver =
			options.claudeDeliver ??
			((sessionRef, message) =>
				new ClaudeInjectionShim().deliver(sessionRef, message));
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

	#statePath(sessionRef: string): string {
		return join(this.#options.stateRoot, `${safeKey(sessionRef)}.json`);
	}

	#readState(sessionRef: string): RunnerState {
		const state = parseRunnerState(
			JSON.parse(readFileSync(this.#statePath(sessionRef), "utf8")) as unknown,
		);
		if (state.session_ref !== sessionRef) {
			throw new RunnerLaunchConfigError(
				"runner state session identity mismatch",
			);
		}
		return state;
	}

	#writeState(state: RunnerState): void {
		atomicFile(
			this.#statePath(state.session_ref),
			`${JSON.stringify(state)}\n`,
		);
	}

	#prepareState(
		request: RuntimeLaunchRequest,
		vendor: "claude" | "codex",
	): void {
		const next = stateFromRequest(request, vendor);
		const path = this.#statePath(request.sessionRef);
		if (existsSync(path)) {
			const prior = this.#readState(request.sessionRef);
			if (!sameStateAuthority(prior, next)) {
				throw new RunnerLaunchConfigError(
					"runner session state conflicts with launch authority",
				);
			}
			return;
		}
		this.#writeState(next);
	}

	/**
	 * Codex R1 MEDIUM-5: refuse any injection-derived path outside the configured
	 * injection root. parseClaudeTarget only validates basenames, so a crafted or
	 * corrupt ref could otherwise resolve configDir to a real user config dir.
	 */
	#assertContainedInInjectionRoot(candidate: string): void {
		// Codex R2 MEDIUM-4: resolve() is only lexical. If any existing ancestor
		// inside the root is a symlink pointing outside it, a lexical check passes
		// while the write lands outside. Canonicalise the deepest EXISTING ancestor
		// and re-attach the not-yet-created tail.
		mkdirSync(this.#options.injectionRoot, { recursive: true, mode: 0o700 });
		const root = realpathSync(this.#options.injectionRoot);
		let probe = resolve(candidate);
		const tail: string[] = [];
		while (!existsSync(probe)) {
			const parent = dirname(probe);
			if (parent === probe) break;
			tail.unshift(basename(probe));
			probe = parent;
		}
		const target = join(realpathSync(probe), ...tail);
		if (target !== root && !target.startsWith(`${root}${sep}`)) {
			throw new RunnerLaunchConfigError(
				"Claude injection path escapes the configured injection root",
			);
		}
	}

	/**
	 * Codex R1 MEDIUM-5: never read or replace through a symlink, and never touch
	 * a non-regular file (a FIFO would block the launcher). A symlink here could
	 * point at credentials, whose contents would then be merged into the new file.
	 */
	#assertPlainFileTarget(path: string): void {
		let stats: Stats;
		try {
			stats = lstatSync(path);
		} catch (error) {
			// Codex R2 MEDIUM-4: only a genuine ENOENT means "absent". Treating every
			// lstat error as absent would let a permission or I/O failure through.
			if ((error as { code?: string }).code === "ENOENT") return;
			throw new RunnerLaunchConfigError(
				"isolated Claude config path could not be inspected",
			);
		}
		if (!stats.isFile()) {
			throw new RunnerLaunchConfigError(
				"isolated Claude config path is not a regular file",
			);
		}
	}

	async #prepareClaudeTeam(
		request: RuntimeLaunchRequest,
	): Promise<ClaudeTarget> {
		const target = parseClaudeTarget(request.injectionRef);
		// Codex R2 MEDIUM-4: containment must be proven before ANY I/O. It used to
		// run inside the preseed, by which point the team config.json had already
		// been written outside the root.
		this.#assertContainedInInjectionRoot(target.configDir);
		this.#assertContainedInInjectionRoot(target.inboxPath);
		// Before any tmux work: no credentials means fail closed with a message that
		// names the path, never a runner parked on a login screen where only a human
		// watching the pane would notice.
		this.#provisionClaudeCredentials(target);
		const teamPath = join(dirname(dirname(target.inboxPath)), "config.json");
		const sessionId = randomUUID();
		const createdAt = this.#now().getTime();
		atomicFile(
			teamPath,
			`${JSON.stringify({
				name: target.teamName,
				description: `Flywheel v2 isolated runner team for ${request.context.issueId}`,
				createdAt,
				leadAgentId: `${target.agentName}@${target.teamName}`,
				leadSessionId: sessionId,
				members: [
					{
						agentId: `${target.agentName}@${target.teamName}`,
						name: target.agentName,
						agentType: request.executor.logicalAgentId,
						model: request.executor.model,
						joinedAt: createdAt,
						tmuxPaneId: "pending",
						cwd: request.context.projectRoot,
						subscriptions: [],
						worktreePath: request.context.projectRoot,
						sessionId,
						backendType: "tmux",
						isActive: true,
						mode: "bypassPermissions",
					},
				],
			})}\n`,
		);
		await this.#preseedClaudeOnboarding(target, request);
		return target;
	}

	/**
	 * FLY-1503 item 7: the isolated CLAUDE_CONFIG_DIR started empty, so a fresh
	 * runner spawned into a interactive first-run sequence -- theme picker, then
	 * trust-this-folder, then bypass-permissions -- and sat there forever because
	 * nobody is at the terminal to answer. This was previously preseeded by hand.
	 *
	 * Credentials are deliberately NOT written here. .credentials.json is a secret
	 * and stays operator-provisioned once per config dir; a launcher that copies
	 * credentials around would spread them into every per-runner directory.
	 */
	/**
	 * Codex R4 MEDIUM-2 / R5 MEDIUM-2: give the per-activation config dir working
	 * credentials, or refuse to launch.
	 *
	 * A COPY, and never an overwrite of one that already exists. The first version
	 * of this used a symlink on the reasoning that Claude rotates the OAuth token and
	 * writes it back through the link. That reasoning was wrong, and I verified it:
	 * Claude's credential writer writes a temp file and renames over the path, and
	 * POSIX rename replaces the SYMLINK itself rather than writing through it. So
	 * after a rotation the activation directory held the only valid token as a
	 * regular file -- and the relaunch path then unlinked it and re-linked the stale
	 * source, destroying it. That was data loss introduced by a fix.
	 *
	 * So: copy the source in when the activation has no credentials yet, and if it
	 * already has a regular file, leave it completely alone. A rotated token is never
	 * overwritten. Accepting an 0400 source is also consistent now, because nothing
	 * expects to write back to it.
	 *
	 * Residual, stated rather than glossed: a token rotated inside one activation is
	 * not propagated back to the operator source, so the source must stay valid on
	 * its own. That is inherent to per-activation isolation -- sharing one mutable
	 * credential file is what the isolation removes -- and the failure mode is a
	 * visible auth error on a new activation, not silent corruption. Same-uid
	 * tampering with the source is an accepted design boundary and is not addressed
	 * here.
	 */
	#provisionClaudeCredentials(target: ClaudeTarget): void {
		const source = this.#options.claudeCredentialsPath;
		if (typeof source !== "string" || !isAbsolute(source)) {
			throw new RunnerLaunchConfigError(
				"Claude credentials path must be configured as an absolute path",
			);
		}
		const destination = join(target.configDir, ".credentials.json");
		mkdirSync(target.configDir, { recursive: true, mode: 0o700 });
		chmodSync(target.configDir, 0o700);

		// Whatever this activation already has wins: it may be a rotated token that
		// exists nowhere else. Only a non-regular entry is refused, because reading or
		// replacing through a link is not something to do with a credential.
		let existing: Stats | undefined;
		try {
			existing = lstatSync(destination);
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") {
				throw new RunnerLaunchConfigError(
					`isolated Claude credentials path could not be inspected: ${destination}`,
				);
			}
		}
		if (existing) {
			if (!existing.isFile()) {
				throw new RunnerLaunchConfigError(
					`isolated Claude credentials path is not a regular file: ${destination}`,
				);
			}
			if (existing.size > 0) return;
			// A zero-byte file cannot be a token; fall through and seed from source.
		}

		const bytes = this.#readClaudeCredentialSource(source);
		const staging = join(
			target.configDir,
			`.credentials.json.staging.${process.pid}.${randomUUID()}`,
		);
		const fd = openSync(staging, "wx", 0o600);
		try {
			writeFileSync(fd, bytes);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			renameSync(staging, destination);
		} catch (error) {
			try {
				unlinkSync(staging);
			} catch {
				// already gone
			}
			throw error;
		}
		chmodSync(destination, 0o600);
	}

	/** Every rule the operator source must satisfy, checked before any tmux call. */
	#readClaudeCredentialSource(source: string): Buffer {
		let stats: Stats;
		try {
			stats = lstatSync(source);
		} catch (error) {
			throw new RunnerLaunchConfigError(
				`Claude credentials are missing at ${source}: provision them once for this host before spawning a Claude runner (${
					(error as { code?: string }).code ?? "unreadable"
				})`,
			);
		}
		// Not a symlink: following one would let anything able to create it aim the
		// runner at another file entirely.
		if (!stats.isFile()) {
			throw new RunnerLaunchConfigError(
				`Claude credentials at ${source} must be a regular file`,
			);
		}
		if (stats.size === 0) {
			throw new RunnerLaunchConfigError(
				`Claude credentials at ${source} are empty`,
			);
		}
		const mode = stats.mode & 0o777;
		if (mode !== 0o600 && mode !== 0o400) {
			throw new RunnerLaunchConfigError(
				`Claude credentials at ${source} must be mode 0600 or 0400, found 0${mode.toString(8)}`,
			);
		}
		const bytes = readFileSync(source);
		try {
			JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new RunnerLaunchConfigError(
				`Claude credentials at ${source} are not valid JSON`,
			);
		}
		return bytes;
	}

	async #preseedClaudeOnboarding(
		target: ClaudeTarget,
		request: RuntimeLaunchRequest,
	): Promise<void> {
		const statePath = join(target.configDir, ".claude.json");
		this.#assertPlainFileTarget(statePath);
		// Codex R2 MEDIUM-5 / R3 MEDIUM-5: with a per-activation config root the
		// only writer of this file is this launcher plus the one Claude process it
		// is about to start, so the last-writer-wins hazard that made this lock
		// necessary is largely gone. The lock stays because it is still the
		// correctness boundary for a `legacy-shared` ref and for two launches of the
		// same activation, and because the previous implementation was itself
		// unsound: it had no wait between the 50 attempts (so it burned them in a
		// microsecond and failed a merely-brief contention) and it deleted any lock
		// older than 30s with no ownership check, so it could unlink a legitimate
		// holder's lock -- or a *later* holder's lock, having decided staleness from
		// an earlier one.
		const lockPath = `${statePath}.fly1503.lock`;
		// Codex R5 MEDIUM-4: prove ownership again at the critical-section boundary. A
		// holder can be displaced between acquiring and here, so writing without
		// re-checking is what would put two processes in the section at once.
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const owner = await this.#acquireOnboardingLock(lockPath);
			try {
				if (!this.#assertStillOwns(lockPath, owner)) continue;
				this.#mergeClaudeOnboarding(statePath, request);
				return;
			} finally {
				closeSync(owner.fd);
				this.#releaseOnboardingLock(lockPath, owner.token);
			}
		}
		throw new RunnerLaunchConfigError(
			"isolated Claude config lock was lost twice before the merge could start",
		);
	}

	/**
	 * Bounded wait, owner token, inode-checked stale recovery.
	 *
	 * The token is written into the lock file, so release and stale reclaim both
	 * verify they are acting on the lock they believe in. Reclaim goes through an
	 * atomic rename: only one racer can win the rename, and the winner re-reads
	 * the renamed file to confirm it moved the same lock it judged stale.
	 */
	async #acquireOnboardingLock(
		lockPath: string,
	): Promise<{ fd: number; token: string; ino: number }> {
		// Deliberately the real clock, not the injected one: a lock's liveness is
		// about elapsed wall time, and the injected clock is a fixed domain
		// timestamp (it is frozen in tests, which would make this spin forever).
		const deadline =
			Date.now() +
			(this.#options.onboardingLockTimeoutMs ?? ONBOARDING_LOCK_TIMEOUT_MS);
		let lastHolder = "";
		for (;;) {
			// Codex R4 MEDIUM-3: write the content to a private temp file and link it
			// into place, so the lock never exists in a zero-byte state. The previous
			// create-then-write left a window where a crash produced an unattributable
			// lock that could only ever be reclaimed by age.
			const token = randomUUID();
			const staging = `${lockPath}.staging.${process.pid}.${token}`;
			// Codex R5 MEDIUM-5: every exit from here closes the fd and removes the
			// staging file. The previous version leaked the fd when the write threw
			// after openSync -- enough repeated launches would exhaust descriptors --
			// and, worse, if linkSync SUCCEEDED and the staging unlink then failed it
			// threw while leaving lockPath published, recording this still-live host
			// pid: every later launch would refuse to reclaim it until the host exited.
			let fd: number | undefined;
			let acquired = false;
			try {
				fd = openSync(staging, "wx", 0o600);
				writeFileSync(
					fd,
					`${JSON.stringify({
						v: 1,
						token,
						pid: process.pid,
						pidStart: this.#processStart(process.pid),
						acquiredAt: new Date(Date.now()).toISOString(),
					})}\n`,
				);
				fsyncSync(fd);
				// linkSync fails with EEXIST rather than replacing, so this is the
				// atomic acquire.
				linkSync(staging, lockPath);
				acquired = true;
			} catch (error) {
				if (fd !== undefined) closeSync(fd);
				fd = undefined;
				if (!acquired && (error as { code?: string }).code !== "EEXIST") {
					throw error;
				}
			} finally {
				// Always: the staging name is this process's private handle, and leaving
				// it behind serves nothing whether the acquire won or lost.
				try {
					unlinkSync(staging);
				} catch {
					// never created, or already removed
				}
			}
			if (acquired && fd !== undefined) {
				const published = this.#readOnboardingLock(lockPath);
				if (published === null || published.token !== token) {
					// Lost between link and read; release nothing and retry.
					closeSync(fd);
				} else {
					return { fd, token, ino: published.ino };
				}
			}
			const holder = this.#readOnboardingLock(lockPath);
			// Codex R4 MEDIUM-3: the deadline must be checked on EVERY path. A lock
			// that reads back as null -- released between the two calls, or previously
			// unparseable -- used to `continue` without it, so an unparseable lock
			// spun this loop forever at full speed.
			if (Date.now() >= deadline) {
				throw new RunnerLaunchConfigError(
					`isolated Claude config is locked by another launcher (holder ${
						holder?.token || lastHolder || "unattributable"
					})`,
				);
			}
			if (holder === null) {
				await new Promise((resolve) =>
					setTimeout(resolve, ONBOARDING_LOCK_POLL_MS),
				);
				continue;
			}
			lastHolder = holder.token;
			if (this.#onboardingLockIsStale(holder)) {
				this.#reclaimOnboardingLock(lockPath, holder);
				continue;
			}
			if (Date.now() >= deadline) {
				throw new RunnerLaunchConfigError(
					`isolated Claude config is locked by another launcher (holder ${lastHolder})`,
				);
			}
			await new Promise((resolve) =>
				setTimeout(resolve, ONBOARDING_LOCK_POLL_MS),
			);
		}
	}

	#readOnboardingLock(lockPath: string): OnboardingLockHolder | null {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "r");
			const stats = fstatSync(fd);
			if (!stats.isFile()) {
				throw new RunnerLaunchConfigError(
					"isolated Claude config lock is not a regular file",
				);
			}
			// An unattributable lock -- unreadable JSON, or JSON that is not an object --
			// must still be reclaimable by age. Returning null here instead (which is
			// what invalid JSON used to do) meant such a lock could never be cleared:
			// it wedged every later launch until the acquire timed out, every time.
			const unattributable = {
				token: "",
				pid: 0,
				pidStart: null,
				acquiredAtMs: stats.mtimeMs,
				ino: stats.ino,
			};
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(fd, "utf8"));
			} catch {
				return unattributable;
			}
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				return unattributable;
			}
			const record = parsed as Record<string, unknown>;
			const acquiredAt =
				typeof record.acquiredAt === "string"
					? Date.parse(record.acquiredAt)
					: Number.NaN;
			return {
				token: typeof record.token === "string" ? record.token : "",
				pid:
					typeof record.pid === "number" && Number.isSafeInteger(record.pid)
						? record.pid
						: 0,
				pidStart:
					typeof record.pidStart === "string" && record.pidStart.length > 0
						? record.pidStart
						: null,
				acquiredAtMs: Number.isNaN(acquiredAt) ? stats.mtimeMs : acquiredAt,
				ino: stats.ino,
			};
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return null;
			if (error instanceof RunnerLaunchConfigError) throw error;
			return null;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	#onboardingLockIsStale(holder: OnboardingLockHolder): boolean {
		// Positive evidence first: a recorded pid whose process is gone -- or which
		// is now a different process -- cannot still be holding this lock. Age alone
		// is the fallback, and it must be long enough that a slow-but-live holder is
		// never robbed.
		if (holder.pid > 0 && holder.pidStart !== null) {
			// Codex R4 MEDIUM-3: `null` conflates "the pid is gone" with "the probe
			// could not answer" -- the fail-open fixed one layer up in R3 HIGH-1 and
			// reintroduced here.
			//
			// Codex R5 MEDIUM-3: falling through to the age rule was still that same
			// fail-open with a two-minute delay. A live holder paused or blocked on a
			// slow filesystem for two minutes, plus one transient /bin/ps failure in
			// the other launcher, and the live lock was taken -- two processes writing
			// one onboarding state. An unanswerable probe now fails CLOSED: a lock that
			// names a process is only ever stale on positive evidence that the process
			// is gone or is a different one. If the probe stays unavailable the acquire
			// times out, which is the correct outcome.
			const observed = this.#processStart(holder.pid);
			if (observed === null) return false;
			return observed !== holder.pidStart;
		}
		// Only a lock that names no process at all can be reclaimed on age. This code
		// cannot create one -- the content is staged and linked atomically -- so this
		// covers a lock left by an older build, which would otherwise wedge every
		// future launch permanently.
		return Date.now() - holder.acquiredAtMs > ONBOARDING_LOCK_STALE_MS;
	}

	#reclaimOnboardingLock(lockPath: string, holder: OnboardingLockHolder): void {
		// Codex R4 MEDIUM-3 / R5 MEDIUM-4: re-read and re-judge at the lock path
		// before moving anything, and NEVER rename a lock back.
		//
		// The rename-back was the two-holder bug: R quarantines what is now S's fresh
		// lock, sees the inode mismatch, and renames S's file back -- over a path U may
		// already have acquired in the gap. S and U then both believe they hold the
		// mutex. Renaming back can only ever clobber; dropping the quarantined file is
		// the safe branch, and #assertStillOwns below is what makes it safe for the
		// displaced holder.
		const current = this.#readOnboardingLock(lockPath);
		if (current === null || current.ino !== holder.ino) return;
		if (!this.#onboardingLockIsStale(current)) return;
		const quarantine = `${lockPath}.stale.${randomUUID()}`;
		try {
			// One racer wins the rename; the loser sees ENOENT and re-evaluates.
			renameSync(lockPath, quarantine);
		} catch {
			return;
		}
		try {
			unlinkSync(quarantine);
		} catch {
			// nothing further to do; the next attempt re-evaluates
		}
	}

	/**
	 * Codex R5 MEDIUM-4: the guarantee that makes the reclaim path safe.
	 *
	 * A holder can be displaced between acquiring and entering the critical section --
	 * by a reclaimer that judged an earlier inode stale, or by any other removal. So
	 * ownership is re-proved immediately before the merge: the lock file must still
	 * exist, still be the inode this process created, and still carry its token. A
	 * mismatch means the lock was lost, and the caller retries rather than writing.
	 */
	#assertStillOwns(
		lockPath: string,
		owner: { token: string; ino: number },
	): boolean {
		const holder = this.#readOnboardingLock(lockPath);
		return (
			holder !== null &&
			holder.ino === owner.ino &&
			holder.token === owner.token
		);
	}

	#releaseOnboardingLock(lockPath: string, token: string): void {
		// Only unlink the lock this process actually owns. Releasing blindly would
		// delete a successor's lock if this holder had already been reclaimed.
		const holder = this.#readOnboardingLock(lockPath);
		if (holder === null || holder.token !== token) return;
		try {
			unlinkSync(lockPath);
		} catch {
			// already removed
		}
	}

	#mergeClaudeOnboarding(
		statePath: string,
		request: RuntimeLaunchRequest,
	): void {
		let state: Record<string, unknown> = {};
		if (existsSync(statePath)) {
			// Merge: the config dir also holds onboarding history and cached feature
			// state that must survive.
			const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				throw new RunnerLaunchConfigError(
					"isolated Claude config state is not an object",
				);
			}
			state = parsed as Record<string, unknown>;
		}
		const priorProjects = state.projects;
		const projects: Record<string, unknown> =
			typeof priorProjects === "object" &&
			priorProjects !== null &&
			!Array.isArray(priorProjects)
				? { ...(priorProjects as Record<string, unknown>) }
				: {};
		const priorProject = projects[request.context.projectRoot];
		projects[request.context.projectRoot] = {
			...(typeof priorProject === "object" &&
			priorProject !== null &&
			!Array.isArray(priorProject)
				? priorProject
				: {}),
			hasTrustDialogAccepted: true,
			hasCompletedProjectOnboarding: true,
		};
		atomicFile(
			statePath,
			`${JSON.stringify({
				...state,
				hasCompletedOnboarding: true,
				bypassPermissionsModeAccepted: true,
				projects,
			})}\n`,
		);
	}

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
		verifyPinnedInstruction(request);
		const vendor = vendorKind(request.executor.vendor);
		const vendorCommand = commandForVendor(request, this.#options, vendor);
		this.#prepareState(request, vendor);
		const claudeTarget =
			vendor === "claude" ? await this.#prepareClaudeTeam(request) : undefined;
		if (vendor === "codex") {
			const target = parseCodexTarget(request.injectionRef);
			assertSocketPathFitsSunLen(target.socketPath);
			mkdirSync(dirname(target.socketPath), {
				recursive: true,
				mode: 0o700,
			});
			chmodSync(dirname(target.socketPath), 0o700);
		}
		const prior = await this.probe(request.sessionRef);
		if (prior.state === "present") return prior.sessionBinding;

		const sessionName = this.#sessionName(request.sessionRef);
		const releasePath = this.#releasePath(request.sessionRef);
		if (existsSync(releasePath)) unlinkSync(releasePath);
		const windowName = safeName(
			`v2-${request.context.issueId}-${request.agent.agentId}-${safeKey(request.sessionRef).slice(0, 8)}`,
			"v2-runner",
		);
		const gateScript =
			'gate="$0"; n=0; while [ ! -f "$gate" ]; do [ "$n" -ge 86400 ] && exit 75; sleep 1; n=$((n+1)); done; exec "$@"';
		const environment = [
			`FLYWHEEL_V2_SESSION_REF=${request.sessionRef}`,
			`FLYWHEEL_V2_AGENT_ID=${request.agent.agentId}`,
			`FLYWHEEL_V2_ACTIVATION_ID=${request.activationId}`,
			`FLYWHEEL_V2_INJECTION_REF=${request.injectionRef}`,
			`FLYWHEEL_V2_SOCKET=${this.#options.socketPath}`,
			`FLYWHEEL_V2_SECRET_PATH=${this.#options.secretPath}`,
			`FLYWHEEL_V2_CLIENT_CLI=${this.#options.clientCliPath}`,
			...(claudeTarget
				? [
						`CLAUDE_CONFIG_DIR=${claudeTarget.configDir}`,
						"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1",
					]
				: []),
		];
		try {
			await this.#command.run(this.#options.tmuxBin, [
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
				"/usr/bin/env",
				"-i",
				...cleanRunnerEnvironment(environment),
				vendorCommand.binary,
				...vendorCommand.args,
			]);
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
		const launched = await this.probe(request.sessionRef);
		if (launched.state !== "present") {
			throw new Error("tmux runner disappeared before registration");
		}
		return launched.sessionBinding;
	}

	async activate(sessionRef: string): Promise<void> {
		const state = this.#readState(sessionRef);
		verifyInstruction({
			sourcePath: state.instruction_source_path,
			contentDigest: state.instruction_content_digest,
			contentBytes: state.instruction_content_bytes,
		});
		const probe = await this.probe(sessionRef);
		if (probe.state !== "present") {
			throw new Error("cannot activate an absent tmux runner");
		}
		atomicRelease(this.#releasePath(sessionRef));
		if (state.vendor === "codex") {
			const target = parseCodexTarget(state.injection_ref);
			const threadId = await this.#codexControl.ensureThread({
				socketPath: target.socketPath,
				threadId: state.thread_id,
				cwd: state.project_root,
				model: state.model,
				baseInstructions: readFileSync(state.instruction_source_path, "utf8"),
			});
			if (threadId.trim().length === 0) {
				throw new RunnerLaunchConfigError(
					"Codex runner activation returned an empty thread id",
				);
			}
			if (state.thread_id !== threadId) {
				this.#writeState({ ...state, thread_id: threadId });
			}
		}
	}

	async deliver(
		sessionRef: string,
		injectionRef: string,
		message: { messageUid: string; attemptUid: string; payload: string },
	): Promise<void> {
		const state = this.#readState(sessionRef);
		if (state.injection_ref !== injectionRef) {
			throw new RunnerLaunchConfigError(
				"runner delivery injection authority mismatch",
			);
		}
		if (state.vendor === "claude") {
			parseClaudeTarget(injectionRef);
			await this.#claudeDeliver(injectionRef, message);
			return;
		}
		const target = parseCodexTarget(injectionRef);
		if (!state.thread_id) {
			throw new RunnerLaunchConfigError(
				"Codex runner delivery preceded thread activation",
			);
		}
		await this.#codexControl.deliver(
			JSON.stringify({ ...target, threadId: state.thread_id }),
			message,
		);
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
			await this.#command.run(this.#options.tmuxBin, [
				"kill-session",
				"-t",
				`=${sessionName}`,
			]);
		}
		const releasePath = this.#releasePath(sessionRef);
		if (existsSync(releasePath)) unlinkSync(releasePath);
		if (await this.#hasSession(sessionName)) {
			throw new Error("tmux runner stop could not prove process absence");
		}
	}
}
