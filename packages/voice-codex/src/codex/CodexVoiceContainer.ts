import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	rm,
	symlink,
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
	pinVoiceCodexAuthSource,
	VOICE_CODEX_HOME_CONFIG,
} from "../codex-home.js";
import {
	type CodexRealtimeBackgroundTurn,
	type CodexRealtimeExecutionIntent,
	type CodexRealtimeItem,
	type CodexRealtimeRpc,
	type CodexRealtimeTranscript,
	CodexRealtimeTransport,
} from "./RealtimeTransport.js";
import {
	type DownlinkPacket,
	type RealtimeDataEvent,
	type RealtimeMediaLeg,
	WebRtcLeg,
	type WebRtcLegOptions,
} from "./WebRtcLeg.js";

export const CODEX_VOICE_BINARY_VERSION = "codex-cli 0.156.1";
export const CODEX_VOICE_BINARY_SHA256 =
	"0196e89fe5a7598f816ee54232c3d7c26d75e502ab5cfe2c9240e81d90f7255a";
/** FLY-2885: the same session parameters as Codex CLI /voice. */
export const CODEX_VOICE_REALTIME_MODEL = "gpt-live-1-codex";
export const CODEX_VOICE_REALTIME_VERSION = "v3";
export const CODEX_VOICE_OPEN_TIMEOUT_MS = 60_000;
export const CODEX_VOICE_MAX_JSON_LINE_BYTES = 1024 * 1024;
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
	knownServerMethods: string[];
	maxJsonLineBytes: number;
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
	leg?: RealtimeMediaLeg;
	process?: CodexVoiceProcess;
	cleanup?: Promise<void>;
}

export class CodexVoiceContainerError extends Error {
	readonly code = "voice_unavailable";
	readonly cause?: unknown;

	constructor(
		readonly reason:
			| "codex_binary_mismatch"
			| "codex_profile_mismatch"
			| "codex_quota_exhausted"
			| "codex_auth_rejected"
			| "codex_open_failed"
			| "context_stale"
			| "context_invalid"
			| "cleanup_pending",
		cause?: unknown,
	) {
		super(`voice_unavailable: ${reason}`);
		this.name = "CodexVoiceContainerError";
		this.cause = cause;
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
				// FLY-2885: no voiceProfile. The subscription login comes from the
				// home's linked auth.json; the washed env carries no API key.
				baseEnv: options.baseEnv,
			}),
		experimentalApi: true,
		knownServerMethods: options.knownServerMethods,
		requestTimeoutMs: CODEX_VOICE_OPEN_TIMEOUT_MS,
		maxJsonLineBytes: options.maxJsonLineBytes,
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
		message.includes("usage limit") ||
		message.includes("usage_limit") ||
		message.includes("rate limit") ||
		message.includes("rate_limit") ||
		message.includes("http 429") ||
		message.includes("status 429")
	) {
		return new CodexVoiceContainerError("codex_quota_exhausted", error);
	}
	if (
		message.includes("invalid_api_key") ||
		message.includes("authentication") ||
		message.includes("unauthorized") ||
		message.includes("forbidden") ||
		message.includes("http 401") ||
		message.includes("status 401") ||
		message.includes("http 403") ||
		message.includes("status 403") ||
		message.includes("refresh_token") ||
		message.includes("token_expired") ||
		message.includes("not logged in")
	) {
		return new CodexVoiceContainerError("codex_auth_rejected", error);
	}
	return new CodexVoiceContainerError("codex_open_failed", error);
}

/**
 * FLY-2885: the voice session must run on the ChatGPT subscription. Anything
 * else (an API-key login, no login, a rejected token) is an auth failure; the
 * engine and model are never swapped to get around it.
 */
async function assertSubscriptionAccount(
	process: CodexVoiceProcess,
): Promise<void> {
	let response: Awaited<ReturnType<CodexVoiceProcess["request"]>>;
	try {
		response = await process.request("account/read", {});
	} catch (error) {
		const classified = classifyOpenError(error);
		throw classified.reason === "codex_open_failed"
			? new CodexVoiceContainerError("codex_auth_rejected", error)
			: classified;
	}
	if (response.error) {
		const classified = classifyOpenError(new Error(response.error.message));
		throw classified.reason === "codex_quota_exhausted"
			? classified
			: new CodexVoiceContainerError(
					"codex_auth_rejected",
					new Error(`account/read: ${response.error.message}`),
				);
	}
	const account = asRecord(asRecord(response.result)?.account);
	if (account?.type !== "chatgpt") {
		throw new CodexVoiceContainerError(
			"codex_auth_rejected",
			new Error(
				`account/read: ${typeof account?.type === "string" ? account.type : "none"}`,
			),
		);
	}
}

function openFailureEvidence(
	sessionId: string,
	error: CodexVoiceContainerError,
): Record<string, unknown> {
	const cause = error.cause;
	return {
		kind: "codex_voice_container_open_failed",
		sessionId,
		reason: error.reason,
		errorType: cause instanceof Error ? cause.name : typeof cause,
		message:
			cause instanceof Error
				? cause.message
				: typeof cause === "string"
					? cause
					: "unknown",
		...(cause instanceof Error &&
		"upstreamEvent" in cause &&
		cause.upstreamEvent !== null &&
		typeof cause.upstreamEvent === "object"
			? { upstreamEvent: cause.upstreamEvent }
			: {}),
	};
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

type NotificationListener = (method: string, params: unknown) => void;
type ExitListener = (
	code: number | null,
	signal: NodeJS.Signals | null,
) => void;

/**
 * FLY-2885 T3: the one listener on the shared app-server. Each realtime
 * generation gets an RPC facade whose notifications flow only while it is
 * the current generation; a retired generation hears nothing more.
 */
class GenerationRouter {
	private readonly routes = new Map<
		number,
		{ notification?: NotificationListener; exit?: ExitListener }
	>();
	private current = 0;

	constructor(private readonly process: CodexVoiceProcess) {
		process.on("notification", ((method: string, params: unknown) =>
			this.routes
				.get(this.current)
				?.notification?.(method, params)) as NotificationListener);
		process.on("exit", ((code: number | null, signal: NodeJS.Signals | null) =>
			this.routes.get(this.current)?.exit?.(code, signal)) as ExitListener);
	}

	rpc(generation: number): CodexRealtimeRpc {
		const route = this.routes.get(generation) ?? {};
		this.routes.set(generation, route);
		return {
			request: (method, params) => this.process.request(method, params),
			on: (event, callback) => {
				if (event === "notification")
					route.notification = callback as NotificationListener;
				else route.exit = callback as ExitListener;
			},
		};
	}

	activate(generation: number): void {
		this.current = generation;
	}

	isCurrent(generation: number): boolean {
		return this.current === generation && this.routes.has(generation);
	}

	retire(generation: number): void {
		this.routes.delete(generation);
	}
}

export interface CodexVoiceGeneration {
	generation: number;
	transport: CodexRealtimeTransport;
	leg: RealtimeMediaLeg;
}

export class CodexVoiceConversation {
	private closePromise?: Promise<void>;
	private restartPromise?: Promise<number>;
	private current: CodexVoiceGeneration;

	constructor(
		readonly sessionId: string,
		readonly threadId: string,
		readonly root: string,
		readonly home: string,
		readonly workdir: string,
		readonly snapshotDigest: string,
		private readonly process: CodexVoiceProcess,
		initial: CodexVoiceGeneration,
		private readonly createGeneration: (
			generation: number,
		) => CodexVoiceGeneration,
		private readonly retireGeneration: (generation: number) => void,
		private readonly evidence: EvidenceSink,
		private readonly onLegLost: (input: {
			generation: number;
			reason: string;
		}) => void = () => undefined,
	) {
		this.current = initial;
	}

	get generation(): number {
		return this.current.generation;
	}

	get transport(): CodexRealtimeTransport {
		return this.current.transport;
	}

	get leg(): RealtimeMediaLeg {
		return this.current.leg;
	}

	/** The WebRTC leg of `generation` reported its peer gone. */
	legLost(generation: number, reason: string): void {
		this.evidence({
			kind: "codex_voice_webrtc_lost",
			sessionId: this.sessionId,
			threadId: this.threadId,
			generation,
			reason,
			current: generation === this.current.generation,
		});
		if (this.closePromise || generation !== this.current.generation) return;
		this.onLegLost({ generation, reason: `webrtc_${reason}` });
	}

	restart(): Promise<number> {
		if (this.closePromise)
			return Promise.reject(new Error("conversation_closed"));
		this.restartPromise ??= this.restartOnce().finally(() => {
			this.restartPromise = undefined;
		});
		return this.restartPromise;
	}

	private async restartOnce(): Promise<number> {
		const previous = this.current;
		await withTimeout(
			previous.transport.cancel(),
			CLOSE_RPC_TIMEOUT_MS,
			"codex_open_failed",
		);
		await previous.leg.close();
		this.retireGeneration(previous.generation);
		if (this.closePromise) throw new Error("conversation_closed");
		const next = this.createGeneration(previous.generation + 1);
		try {
			await next.transport.start();
		} catch (error) {
			await next.leg.close();
			throw error;
		}
		if (this.closePromise) {
			await next.transport.cancel().catch(() => undefined);
			await next.leg.close();
			throw new Error("conversation_closed");
		}
		this.current = next;
		this.evidence({
			kind: "codex_voice_realtime_restarted",
			sessionId: this.sessionId,
			threadId: this.threadId,
			generation: next.generation,
		});
		return next.generation;
	}

	close(reason = "session_end"): Promise<void> {
		this.closePromise ??= this.closeOnce(reason);
		return this.closePromise;
	}

	/**
	 * Plan T7 order: the caller has stopped the uplink and cut the downlink;
	 * then realtime stop (waiting up to 5 s for closed), the leg, the
	 * app-server, and last the temporary root.
	 */
	private async closeOnce(reason: string): Promise<void> {
		try {
			await this.restartPromise?.catch(() => undefined);
			await withTimeout(
				this.current.transport.cancel(),
				CLOSE_RPC_TIMEOUT_MS,
				"codex_open_failed",
			).catch(() => undefined);
			await this.current.leg.close();
			this.retireGeneration(this.current.generation);
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

export interface CodexVoiceOpenInput {
	sessionId: string;
	voice: string;
	loadContext: () => Promise<CodexVoiceContextSnapshot>;
	realtime?: {
		/** RTP audio of the current generation, payload untouched. */
		onDownlink?(packet: DownlinkPacket & { generation: number }): void;
		/** oai-events of the current generation (not a Codex protocol surface). */
		onDataEvent?(input: { generation: number; event: RealtimeDataEvent }): void;
		onTranscript?(transcript: CodexRealtimeTranscript): void;
		onItem?(item: CodexRealtimeItem): void;
		onInputGap?(gap: {
			generation: number;
			utteranceId: string | null;
			ownerUserId: string | null;
			droppedBytes: number;
			reason: "backpressure" | "rpc_error";
		}): void;
		onCapabilityViolation?(input: {
			generation: number;
			method: string;
			params: unknown;
		}): void;
		onExecutionIntent?(input: CodexRealtimeExecutionIntent): void;
		onBackgroundTurn?(input: CodexRealtimeBackgroundTurn): void;
		onClosed?(input: { generation: number; reason: string }): void;
		onError?(error: Error): void;
	};
}

export class CodexVoiceContainer {
	private readonly now: () => number;
	private readonly inspectBinary: (path: string) => Promise<BinaryEvidence>;
	private readonly createProcess: (
		options: CodexVoiceProcessFactoryOptions,
	) => CodexVoiceProcess;
	private readonly evidence: EvidenceSink;
	private readonly createLeg: (options: WebRtcLegOptions) => RealtimeMediaLeg;

	constructor(
		private readonly options: {
			binaryPath: string;
			scratchRoot: string;
			/** FLY-2885 T2: ICE servers for the WebRTC leg; empty = host only. */
			stunUrls?: string[];
			createLeg?: (options: WebRtcLegOptions) => RealtimeMediaLeg;
			/** FLY-2885: the fleet's subscription credential; linked, never copied. */
			authSource: string;
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
		this.createLeg =
			options.createLeg ?? ((legOptions) => new WebRtcLeg(legOptions));
	}

	open(input: CodexVoiceOpenInput): Promise<CodexVoiceConversation> {
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
			const classified = classifyOpenError(error);
			this.evidence(openFailureEvidence(input.sessionId, classified));
			throw classified;
		});
	}

	private async openWithinDeadline(
		input: CodexVoiceOpenInput,
		resources: OpenResources,
	): Promise<CodexVoiceConversation> {
		const assertActive = () => {
			if (resources.cancelled) {
				throw new CodexVoiceContainerError("codex_open_failed");
			}
		};
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
		let authSource: string;
		try {
			authSource = pinVoiceCodexAuthSource(this.options.authSource);
		} catch (error) {
			throw new CodexVoiceContainerError("codex_profile_mismatch", error);
		}

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
			await symlink(authSource, join(home, "auth.json"));
			assertActive();
			try {
				assertVoiceCodexHome(home, authSource);
			} catch (error) {
				throw new CodexVoiceContainerError("codex_profile_mismatch", error);
			}

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
				knownServerMethods: [],
				maxJsonLineBytes: CODEX_VOICE_MAX_JSON_LINE_BYTES,
			};
			const process = this.createProcess(processOptions);
			resources.process = process;
			process.on("exit", () => {
				if (!conversation) violation ??= "process_exited_during_open";
				else void conversation.close("process_exit").catch(() => undefined);
			});
			await process.start();
			assertActive();
			if (violation) throw new Error(violation);
			await assertSubscriptionAccount(process);
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
					"features.unified_exec": false,
					"features.view_image": false,
					"features.image_generation": false,
					"features.code_mode_host": false,
					"features.standalone_web_search": false,
					web_search: "disabled",
				},
			});
			assertActive();
			if (violation) throw new Error(violation);
			assertThreadReceipt(opened.result, opened.id, workdir);
			// transport and version are the transport's own: v3 over WebRTC.
			const realtimeStart = {
				outputModality: "audio",
				clientManagedHandoffs: true,
				includeStartupContext: false,
				prompt: snapshot.realtimePrompt,
				model: CODEX_VOICE_REALTIME_MODEL,
				voice: input.voice,
			};
			const { onDownlink, onDataEvent, onClosed, ...transportCallbacks } =
				input.realtime ?? {};
			const router = new GenerationRouter(process);
			const createGeneration = (generation: number): CodexVoiceGeneration => {
				router.activate(generation);
				const leg = this.createLeg({
					stunUrls: this.options.stunUrls ?? [],
					onDownlink: (packet) => {
						if (router.isCurrent(generation))
							onDownlink?.({ ...packet, generation });
					},
					onDataEvent: (event) => {
						if (router.isCurrent(generation))
							onDataEvent?.({ generation, event });
					},
					onLost: (reason) => {
						if (conversation) conversation.legLost(generation, reason);
						else violation ??= `webrtc_${reason}`;
					},
					onEvidence: (record) =>
						this.evidence({
							sessionId: input.sessionId,
							generation,
							...record,
						}),
				});
				const transport = new CodexRealtimeTransport({
					rpc: router.rpc(generation),
					sessionId: input.sessionId,
					threadId: opened.id,
					generation,
					leg,
					start: realtimeStart,
					...transportCallbacks,
					...(onClosed ? { onClosed } : {}),
				});
				return { generation, transport, leg };
			};
			const initial = createGeneration(1);
			resources.leg = initial.leg;
			await initial.transport.start();
			assertActive();
			if (violation) throw new Error(violation);
			conversation = new CodexVoiceConversation(
				input.sessionId,
				opened.id,
				root,
				home,
				workdir,
				snapshot.snapshotDigest,
				process,
				initial,
				createGeneration,
				(generation) => router.retire(generation),
				this.evidence,
				(lost) => onClosed?.(lost),
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
			await resources.leg?.close();
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
