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
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
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
	/** The spawn bootstrap prompt, first envelope included (FLY-1543 ④). */
	bootstrap: string;
	model: string;
	effort: string;
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

/**
 * FLY-1543 ④: vendor-neutral session resources are derived, not carried by an
 * injection reference -- the reference (and the teams JSON it used to point at)
 * is abolished. The Claude config root stays per-activation
 * (`<root>/claude/<sha256(activationId)>`, Codex R3 MEDIUM-5/7) because the
 * `.claude.json` onboarding preseed still needs isolation.
 */
function claudeConfigDir(injectionRoot: string, activationId: string): string {
	return join(injectionRoot, "claude", safeKey(activationId));
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
function runnerPrompt(request: RuntimeLaunchRequest): string {
	const instruction = request.context.instruction;
	const prompt = [
		`Flywheel v2 runner bootstrap for ${request.context.issueId}.`,
		`The complete role authority is pinned at ${instruction.sourcePath} with SHA-256 ${instruction.contentDigest}.`,
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
	instruction: Buffer,
): { binary: string; args: string[] } {
	if (!EFFORTS.has(request.executor.effort)) {
		throw new RunnerLaunchConfigError(
			`unsupported runner effort ${request.executor.effort}`,
		);
	}
	if (kind === "claude") {
		// FLY-1543 ④: no --agent-id/--agent-name/--team-name and no agent-teams
		// experiment flag -- the vendor team machinery is not part of the design.
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
					`v2-${request.context.issueId}-${request.taskKind}`,
					"v2-runner",
				),
				runnerPrompt(request),
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
			`${instruction.toString("utf8")}\n\n---\n\n${runnerPrompt(request)}`,
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

function parseRunnerState(value: unknown): RunnerState {
	const input = record(value, "runner state");
	if (
		!exactKeys(input, [
			"bootstrap",
			"effort",
			"instruction_content_bytes",
			"instruction_content_digest",
			"instruction_source_path",
			"model",
			"project_root",
			"session_ref",
			"v",
			"vendor",
		]) ||
		input.v !== 1 ||
		(input.vendor !== "claude" && input.vendor !== "codex") ||
		!Number.isSafeInteger(input.instruction_content_bytes) ||
		(input.instruction_content_bytes as number) <= 0
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
		bootstrap: text(input.bootstrap, "runner state bootstrap"),
		model: text(input.model, "runner state model"),
		effort: text(input.effort, "runner state effort"),
	};
}

function stateFromRequest(
	request: RuntimeLaunchRequest,
	vendor: "claude" | "codex",
	bootstrap: string,
): RunnerState {
	return {
		v: 1,
		session_ref: request.sessionRef,
		vendor,
		project_root: request.context.projectRoot,
		instruction_source_path: request.context.instruction.sourcePath,
		instruction_content_digest: request.context.instruction.contentDigest,
		instruction_content_bytes: request.context.instruction.contentBytes,
		bootstrap,
		model: request.executor.model,
		effort: request.executor.effort,
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
		left.bootstrap === right.bootstrap &&
		left.model === right.model &&
		left.effort === right.effort
	);
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
		bootstrap: string,
	): void {
		const next = stateFromRequest(request, vendor, bootstrap);
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

	/**
	 * FLY-1543 ④: no Agent Team, no teams config.json, no vendor inbox. The
	 * per-activation config dir exists only for credentials and the onboarding
	 * preseed.
	 */
	async #prepareClaudeConfig(request: RuntimeLaunchRequest): Promise<string> {
		const configDir = claudeConfigDir(
			this.#options.injectionRoot,
			request.activationId,
		);
		// Codex R2 MEDIUM-4: containment must be proven before ANY I/O.
		this.#assertContainedInInjectionRoot(configDir);
		// Before any tmux work: no credentials means fail closed with a message that
		// names the path, never a runner parked on a login screen where only a human
		// watching the pane would notice.
		this.#linkClaudeCredentials(configDir);
		await this.#preseedClaudeOnboarding(configDir, request);
		return configDir;
	}

	/**
	 * FLY-1543 ②: ONE live credential file, shared by every activation.
	 *
	 * The per-activation COPY is deleted: a copy goes stale the moment the
	 * operator/quota system refreshes the source, and a runner that opens on a
	 * login screen has nobody watching the pane. Every launch re-points a
	 * symlink at the shared file, so a refresh of the source is immediately
	 * visible to every runner -- no sync, no refresher, no stale copies.
	 *
	 * Stated residual (recorded, not fallback-ed): if Claude's credential writer
	 * rename-overs the path, the symlink is replaced by a regular file holding
	 * that activation's own token, which is NOT propagated back to the shared
	 * file; the next launch re-points the link. The shared file is maintained as
	 * the single source of truth by the operator/quota system, and same-uid
	 * tampering with it is an accepted design boundary.
	 */
	#linkClaudeCredentials(configDir: string): void {
		const source = this.#options.claudeCredentialsPath;
		if (typeof source !== "string" || !isAbsolute(source)) {
			throw new RunnerLaunchConfigError(
				"Claude credentials path must be configured as an absolute path",
			);
		}
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
		if (!stats.isFile()) {
			throw new RunnerLaunchConfigError(
				`Claude credentials at ${source} must be a regular file`,
			);
		}
		const destination = join(configDir, ".credentials.json");
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		chmodSync(configDir, 0o700);
		// Always re-point: keeping an existing entry is exactly the mechanism by
		// which a stale copy used to survive.
		try {
			unlinkSync(destination);
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") {
				throw new RunnerLaunchConfigError(
					`isolated Claude credentials path could not be replaced: ${destination}`,
				);
			}
		}
		symlinkSync(source, destination);
	}

	async #preseedClaudeOnboarding(
		configDir: string,
		request: RuntimeLaunchRequest,
	): Promise<void> {
		const statePath = join(configDir, ".claude.json");
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
		const instruction = verifyPinnedInstruction(request);
		const vendor = vendorKind(request.executor.vendor);
		const vendorCommand = commandForVendor(
			request,
			this.#options,
			vendor,
			instruction,
		);
		this.#prepareState(request, vendor, runnerPrompt(request));
		const claudeConfig =
			vendor === "claude"
				? await this.#prepareClaudeConfig(request)
				: undefined;
		const prior = await this.probe(request.sessionRef);
		if (prior.state === "present") return prior.sessionBinding;

		const sessionName = this.#sessionName(request.sessionRef);
		const releasePath = this.#releasePath(request.sessionRef);
		if (existsSync(releasePath)) unlinkSync(releasePath);
		// FLY-1544 ①: window name derives from issue + node kind.
		const windowName = safeName(
			`v2-${request.context.issueId}-${request.taskKind}-${safeKey(request.sessionRef).slice(0, 8)}`,
			"v2-runner",
		);
		const gateScript =
			'gate="$0"; n=0; while [ ! -f "$gate" ]; do [ "$n" -ge 86400 ] && exit 75; sleep 1; n=$((n+1)); done; exec "$@"';
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
			...(claudeConfig ? [`CLAUDE_CONFIG_DIR=${claudeConfig}`] : []),
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
