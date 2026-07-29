import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
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
	command?: TmuxCommandPort;
	codexControl?: CodexRunnerControlPort;
	claudeDeliver?: (
		sessionRef: string,
		message: { messageUid: string; attemptUid: string; payload: string },
	) => Promise<void>;
	now?: () => Date;
	processStart?: (pid: number) => string | null;
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

	#prepareClaudeTeam(request: RuntimeLaunchRequest): ClaudeTarget {
		const target = parseClaudeTarget(request.injectionRef);
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
		return target;
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
			vendor === "claude" ? this.#prepareClaudeTeam(request) : undefined;
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
					`=${sessionName}`,
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
