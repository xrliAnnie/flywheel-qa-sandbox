import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
	CodexLeadProcess,
	spawnCodexAppServer,
} from "flywheel-teamlead/codex-process";
import {
	assertVoiceCodexHome,
	VOICE_CODEX_HOME_CONFIG,
} from "../codex-home.js";

export const CODEX_VOICE_BINARY_VERSION = "codex-cli 0.156.1";
export const CODEX_VOICE_BINARY_SHA256 =
	"0196e89fe5a7598f816ee54232c3d7c26d75e502ab5cfe2c9240e81d90f7255a";
export const CODEX_VOICE_REALTIME_MODEL = "gpt-realtime-2.1";
export const CODEX_VOICE_REALTIME_VERSION = "v2";
export const CODEX_VOICE_OPEN_TIMEOUT_MS = 60_000;
const CONTEXT_MAX_AGE_MS = 60_000;
const CONTEXT_MAX_BYTES = 128 * 1024;
const CONTEXT_MAX_ESTIMATED_TOKENS = 32_768;
const CLOSE_RPC_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

export interface CodexVoiceContextSnapshot {
	baseInstructions: string;
	realtimePrompt: string;
	snapshotDigest: string;
	manifest: {
		version: 1;
		capturedAt: string;
		snapshotDigest: string;
		leaseBindingDigest: string;
		[key: string]: unknown;
	};
	measurements: {
		baseInstructions: { bytes: number; estimatedTokens: number };
		realtimePrompt: { bytes: number; estimatedTokens: number };
	};
}

export interface CodexVoiceProcess {
	on(
		event: "notification" | "exit",
		callback:
			| ((method: string, params: unknown) => void)
			| ((code: number | null, signal: NodeJS.Signals | null) => void),
	): void;
	start(): Promise<void>;
	startThreadWithResult(params: Record<string, unknown>): Promise<{
		id: string;
		result: unknown;
	}>;
	request(
		method: string,
		params?: unknown,
	): Promise<{
		result?: unknown;
		error?: { code: number; message: string; data?: unknown };
	}>;
	stop(): Promise<void>;
}

export interface CodexVoiceProcessFactoryOptions {
	root: string;
	codexBin: string;
	codexHome: string;
	cwd: string;
	mcpArgv: string[];
	baseEnv: NodeJS.ProcessEnv;
	voiceProfile: { openAiApiKey: string };
	knownServerMethods: string[];
}

interface BinaryEvidence {
	version: string;
	sha256: string;
	realtimeFeatureEnabled: boolean;
}

type EvidenceSink = (record: Record<string, unknown>) => void;

interface OpenResources {
	cancelled: boolean;
	root?: string;
	process?: CodexVoiceProcess;
	cleanup?: Promise<void>;
}

export class CodexVoiceContainerError extends Error {
	readonly code = "voice_unavailable";

	constructor(
		readonly reason:
			| "codex_binary_mismatch"
			| "codex_profile_mismatch"
			| "codex_quota_exhausted"
			| "codex_open_failed"
			| "context_stale"
			| "context_invalid"
			| "cleanup_pending",
	) {
		super(`voice_unavailable: ${reason}`);
		this.name = "CodexVoiceContainerError";
	}
}

function emptyStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.length === 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function assertThreadReceipt(
	result: unknown,
	threadId: string,
	cwd: string,
): void {
	const row = asRecord(result);
	const thread = asRecord(row?.thread);
	const sandbox = asRecord(row?.sandbox);
	if (
		!row ||
		!thread ||
		thread.id !== threadId ||
		thread.ephemeral !== true ||
		!emptyStringArray(thread.environments) ||
		thread.cwd !== cwd ||
		thread.cliVersion !== "0.156.1" ||
		thread.modelProvider !== "openai" ||
		row.cwd !== cwd ||
		!emptyStringArray(row.runtimeWorkspaceRoots) ||
		!emptyStringArray(row.instructionSources) ||
		row.approvalPolicy !== "never" ||
		!sandbox ||
		sandbox.type !== "readOnly" ||
		sandbox.networkAccess !== false ||
		row.activePermissionProfile !== null ||
		row.multiAgentMode !== "explicitRequestOnly"
	) {
		throw new CodexVoiceContainerError("codex_profile_mismatch");
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const input = createReadStream(path);
		input.on("data", (chunk) => hash.update(chunk));
		input.on("error", reject);
		input.on("end", resolve);
	});
	return hash.digest("hex");
}

export async function inspectCodexVoiceBinary(
	binaryPath: string,
): Promise<BinaryEvidence> {
	if (!isAbsolute(binaryPath)) {
		throw new CodexVoiceContainerError("codex_binary_mismatch");
	}
	try {
		const metadata = await lstat(binaryPath);
		if (!metadata.isFile() || metadata.isSymbolicLink())
			throw new Error("file");
		const [digest, version, features] = await Promise.all([
			sha256File(binaryPath),
			execFileAsync(binaryPath, ["--version"], {
				timeout: 5_000,
				maxBuffer: 64 * 1024,
				env: {},
			}),
			execFileAsync(binaryPath, ["features", "list"], {
				timeout: 5_000,
				maxBuffer: 1024 * 1024,
				env: {},
			}),
		]);
		return {
			version: version.stdout.trim(),
			sha256: digest,
			realtimeFeatureEnabled: /^realtime_conversation\s+stable\s+true$/mu.test(
				features.stdout,
			),
		};
	} catch (error) {
		if (error instanceof CodexVoiceContainerError) throw error;
		throw new CodexVoiceContainerError("codex_binary_mismatch");
	}
}

function positiveChildEnv(
	env: NodeJS.ProcessEnv,
	home: string,
	workdir: string,
): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = { HOME: home, TMPDIR: workdir };
	for (const key of [
		"PATH",
		"USER",
		"LOGNAME",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
	] as const) {
		const value = env[key];
		if (value) result[key] = value;
	}
	return result;
}

function defaultCreateProcess(
	options: CodexVoiceProcessFactoryOptions,
): CodexVoiceProcess {
	const process = new CodexLeadProcess({
		spawnChild: () =>
			spawnCodexAppServer({
				codexBin: options.codexBin,
				mcpArgv: options.mcpArgv,
				codexHome: options.codexHome,
				cwd: options.cwd,
				baseEnv: options.baseEnv,
				voiceProfile: options.voiceProfile,
			}),
		experimentalApi: true,
		knownServerMethods: options.knownServerMethods,
		requestTimeoutMs: CODEX_VOICE_OPEN_TIMEOUT_MS,
		shutdownGraceMs: 50,
		shutdownTermMs: 5_000,
		shutdownKillMs: 5_000,
		clientInfo: { name: "flywheel-voice-codex", version: "0.1.0" },
	});
	return {
		on(event, callback) {
			if (event === "notification") {
				process.on(
					"notification",
					callback as (method: string, params: unknown) => void,
				);
			} else {
				process.on(
					"exit",
					callback as (
						code: number | null,
						signal: NodeJS.Signals | null,
					) => void,
				);
			}
		},
		start: () => process.start(),
		startThreadWithResult: (params) => process.startThreadWithResult(params),
		request: (method, params) => process.request(method, params),
		stop: () => process.stop(),
	};
}

function rpcErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	const row = asRecord(error);
	return typeof row?.message === "string" ? row.message : "";
}

function classifyOpenError(error: unknown): CodexVoiceContainerError {
	if (error instanceof CodexVoiceContainerError) return error;
	const message = rpcErrorMessage(error).toLowerCase();
	if (
		message.includes("insufficient_quota") ||
		message.includes("quota exceeded") ||
		message.includes("usage limit")
	) {
		return new CodexVoiceContainerError("codex_quota_exhausted");
	}
	return new CodexVoiceContainerError("codex_open_failed");
}

function contextIsFresh(
	snapshot: CodexVoiceContextSnapshot,
	now: number,
): boolean {
	const capturedAt = Date.parse(snapshot.manifest.capturedAt);
	return (
		Number.isFinite(capturedAt) &&
		capturedAt <= now &&
		now - capturedAt <= CONTEXT_MAX_AGE_MS
	);
}

function assertContext(
	snapshot: CodexVoiceContextSnapshot,
	sessionId: string,
): void {
	const marker = `snapshotDigest=${snapshot.snapshotDigest} sessionId=${sessionId}]`;
	const digest = /^[a-f0-9]{64}$/u;
	const baseBytes = Buffer.byteLength(snapshot.baseInstructions, "utf8");
	const realtimeBytes = Buffer.byteLength(snapshot.realtimePrompt, "utf8");
	if (
		!digest.test(snapshot.snapshotDigest) ||
		snapshot.manifest.version !== 1 ||
		snapshot.manifest.snapshotDigest !== snapshot.snapshotDigest ||
		!digest.test(snapshot.manifest.leaseBindingDigest) ||
		!snapshot.baseInstructions.includes(marker) ||
		!snapshot.realtimePrompt.includes(marker) ||
		!snapshot.realtimePrompt.startsWith(snapshot.baseInstructions) ||
		baseBytes !== snapshot.measurements.baseInstructions.bytes ||
		realtimeBytes !== snapshot.measurements.realtimePrompt.bytes ||
		baseBytes > CONTEXT_MAX_BYTES ||
		realtimeBytes > CONTEXT_MAX_BYTES ||
		snapshot.measurements.baseInstructions.estimatedTokens >
			CONTEXT_MAX_ESTIMATED_TOKENS ||
		snapshot.measurements.realtimePrompt.estimatedTokens >
			CONTEXT_MAX_ESTIMATED_TOKENS
	) {
		throw new CodexVoiceContainerError("context_invalid");
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: CodexVoiceContainerError["reason"],
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new CodexVoiceContainerError(reason)),
			timeoutMs,
		);
		timer.unref?.();
	});
	return Promise.race([promise, expiry]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export class CodexVoiceConversation {
	private closePromise?: Promise<void>;

	constructor(
		readonly sessionId: string,
		readonly threadId: string,
		readonly root: string,
		readonly home: string,
		readonly workdir: string,
		readonly snapshotDigest: string,
		private readonly process: CodexVoiceProcess,
		private readonly evidence: EvidenceSink,
	) {}

	close(reason = "session_end"): Promise<void> {
		this.closePromise ??= this.closeOnce(reason);
		return this.closePromise;
	}

	private async closeOnce(reason: string): Promise<void> {
		try {
			await withTimeout(
				this.process.request("thread/realtime/stop", {
					threadId: this.threadId,
				}),
				CLOSE_RPC_TIMEOUT_MS,
				"codex_open_failed",
			).catch(() => undefined);
			await this.process.stop();
		} catch {
			this.evidence({
				kind: "codex_voice_cleanup_pending",
				sessionId: this.sessionId,
				threadId: this.threadId,
				reason,
			});
			throw new CodexVoiceContainerError("cleanup_pending");
		}
		await rm(this.root, { recursive: true, force: true });
		this.evidence({
			kind: "codex_voice_container_closed",
			sessionId: this.sessionId,
			threadId: this.threadId,
			reason,
		});
	}
}

export class CodexVoiceContainer {
	private readonly now: () => number;
	private readonly inspectBinary: (path: string) => Promise<BinaryEvidence>;
	private readonly createProcess: (
		options: CodexVoiceProcessFactoryOptions,
	) => CodexVoiceProcess;
	private readonly evidence: EvidenceSink;

	constructor(
		private readonly options: {
			binaryPath: string;
			scratchRoot: string;
			openAiApiKey: string;
			processEnv?: NodeJS.ProcessEnv;
			now?: () => number;
			inspectBinary?: (path: string) => Promise<BinaryEvidence>;
			createProcess?: (
				options: CodexVoiceProcessFactoryOptions,
			) => CodexVoiceProcess;
			onEvidence?: EvidenceSink;
		},
	) {
		this.now = options.now ?? Date.now;
		this.inspectBinary = options.inspectBinary ?? inspectCodexVoiceBinary;
		this.createProcess = options.createProcess ?? defaultCreateProcess;
		this.evidence = options.onEvidence ?? (() => undefined);
	}

	open(input: {
		sessionId: string;
		voice: string;
		loadContext: () => Promise<CodexVoiceContextSnapshot>;
	}): Promise<CodexVoiceConversation> {
		const resources: OpenResources = { cancelled: false };
		const attempt = this.openWithinDeadline(input, resources);
		// A timed-out real child is stopped below. Its in-flight RPC then rejects;
		// keep that late settlement observed while the caller sees the deadline.
		attempt.catch(() => undefined);
		return withTimeout(
			attempt,
			CODEX_VOICE_OPEN_TIMEOUT_MS,
			"codex_open_failed",
		).catch(async (error) => {
			resources.cancelled = true;
			await this.cleanupOpen(resources, input.sessionId);
			throw classifyOpenError(error);
		});
	}

	private async openWithinDeadline(
		input: {
			sessionId: string;
			voice: string;
			loadContext: () => Promise<CodexVoiceContextSnapshot>;
		},
		resources: OpenResources,
	): Promise<CodexVoiceConversation> {
		const assertActive = () => {
			if (resources.cancelled) {
				throw new CodexVoiceContainerError("codex_open_failed");
			}
		};
		if (!this.options.openAiApiKey.trim()) {
			throw new CodexVoiceContainerError("codex_open_failed");
		}
		const binary = await this.inspectBinary(this.options.binaryPath);
		assertActive();
		if (
			binary.version !== CODEX_VOICE_BINARY_VERSION ||
			binary.sha256 !== CODEX_VOICE_BINARY_SHA256 ||
			!binary.realtimeFeatureEnabled
		) {
			throw new CodexVoiceContainerError("codex_binary_mismatch");
		}

		let snapshot = await input.loadContext();
		assertActive();
		if (!contextIsFresh(snapshot, this.now()))
			snapshot = await input.loadContext();
		assertActive();
		if (!contextIsFresh(snapshot, this.now())) {
			throw new CodexVoiceContainerError("context_stale");
		}
		assertContext(snapshot, input.sessionId);

		let conversation: CodexVoiceConversation | undefined;
		let violation: string | undefined;
		try {
			await mkdir(this.options.scratchRoot, { recursive: true, mode: 0o700 });
			assertActive();
			const scratch = await lstat(this.options.scratchRoot);
			const uid = processUid();
			if (
				!scratch.isDirectory() ||
				scratch.isSymbolicLink() ||
				(scratch.mode & 0o777) !== 0o700 ||
				(uid !== undefined && scratch.uid !== uid)
			) {
				throw new CodexVoiceContainerError("codex_profile_mismatch");
			}
			resources.root = await mkdtemp(
				join(this.options.scratchRoot, "container-"),
			);
			assertActive();
			const root = resources.root;
			await chmod(root, 0o700);
			const home = join(root, "home");
			const workdir = join(root, "work");
			await mkdir(home, { mode: 0o700 });
			await mkdir(workdir, { mode: 0o700 });
			await writeFile(join(home, "config.toml"), VOICE_CODEX_HOME_CONFIG, {
				mode: 0o600,
				flag: "wx",
			});
			assertActive();
			assertVoiceCodexHome(home);

			const processOptions: CodexVoiceProcessFactoryOptions = {
				root,
				codexBin: this.options.binaryPath,
				codexHome: home,
				cwd: workdir,
				mcpArgv: [],
				baseEnv: positiveChildEnv(
					this.options.processEnv ?? processEnv(),
					home,
					workdir,
				),
				voiceProfile: { openAiApiKey: this.options.openAiApiKey },
				knownServerMethods: [],
			};
			const process = this.createProcess(processOptions);
			resources.process = process;
			process.on("notification", (method: string) => {
				if (
					method === "turn/started" ||
					method.includes("commandExecution") ||
					method.includes("mcpToolCall")
				) {
					violation = "unexpected_backend_execution";
					this.evidence({
						kind: "codex_voice_capability_violation",
						sessionId: input.sessionId,
						reason: violation,
					});
					if (conversation)
						void conversation.close(violation).catch(() => undefined);
				}
			});
			process.on("exit", () => {
				if (!conversation) violation ??= "process_exited_during_open";
				else void conversation.close("process_exit").catch(() => undefined);
			});
			await process.start();
			assertActive();
			if (violation) throw new Error(violation);
			const opened = await process.startThreadWithResult({
				cwd: workdir,
				approvalPolicy: "never",
				sandbox: "read-only",
				ephemeral: true,
				environments: [],
				baseInstructions: snapshot.baseInstructions,
				config: {
					"features.shell_tool": false,
					"features.memories": false,
				},
			});
			assertActive();
			if (violation) throw new Error(violation);
			assertThreadReceipt(opened.result, opened.id, workdir);
			const realtime = await process.request("thread/realtime/start", {
				threadId: opened.id,
				outputModality: "audio",
				clientManagedHandoffs: true,
				includeStartupContext: false,
				prompt: snapshot.realtimePrompt,
				transport: { type: "websocket" },
				version: CODEX_VOICE_REALTIME_VERSION,
				model: CODEX_VOICE_REALTIME_MODEL,
				voice: input.voice,
			});
			assertActive();
			if (realtime.error) throw new Error(realtime.error.message);
			if (violation) throw new Error(violation);
			conversation = new CodexVoiceConversation(
				input.sessionId,
				opened.id,
				root,
				home,
				workdir,
				snapshot.snapshotDigest,
				process,
				this.evidence,
			);
			this.evidence({
				kind: "codex_voice_container_opened",
				sessionId: input.sessionId,
				threadId: opened.id,
				binaryDigest: binary.sha256,
				configDigest: sha256(VOICE_CODEX_HOME_CONFIG),
				contextDigest: snapshot.snapshotDigest,
			});
			return conversation;
		} catch (error) {
			resources.cancelled = true;
			await this.cleanupOpen(resources, input.sessionId);
			throw classifyOpenError(error);
		}
	}

	private async cleanupOpen(
		resources: OpenResources,
		sessionId: string,
	): Promise<void> {
		if (resources.cleanup) return resources.cleanup;
		if (!resources.process && !resources.root) return;
		resources.cleanup = (async () => {
			if (resources.process) {
				try {
					await resources.process.stop();
				} catch {
					this.evidence({
						kind: "codex_voice_cleanup_pending",
						sessionId,
					});
					throw new CodexVoiceContainerError("cleanup_pending");
				}
			}
			if (resources.root) {
				await rm(resources.root, { recursive: true, force: true });
			}
		})();
		return resources.cleanup;
	}
}

function processEnv(): NodeJS.ProcessEnv {
	return process.env;
}

function processUid(): number | undefined {
	return process.getuid?.();
}
