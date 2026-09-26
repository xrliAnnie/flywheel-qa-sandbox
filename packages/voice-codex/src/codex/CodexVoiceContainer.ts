import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	realpath,
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
	bindAdmittedVoiceCapabilities,
	observeChildSpawns,
	startVoiceCapabilityParent,
	type VoiceBackgroundDegradedReason,
	type VoiceCapabilityParentInput,
} from "flywheel-teamlead/voice-capability";
import {
	assertVoiceCapabilityHome,
	assertVoiceCodexHome,
	assertVoiceScribeHome,
	VOICE_CODEX_HOME_CONFIG,
	VOICE_SCRIBE_HOME_CONFIG,
} from "../codex-home.js";
import {
	AdmissionResidualRegistry,
	type AdmissionResiduals,
} from "./admission-residuals.js";
import type { BackgroundTurnTerminal } from "./BrainCoordinator.js";
import {
	type CodexRealtimeAudioDelta,
	type CodexRealtimeBackgroundTurn,
	type CodexRealtimeExecutionIntent,
	type CodexRealtimeItem,
	type CodexRealtimeTranscript,
	CodexRealtimeTransport,
} from "./RealtimeTransport.js";
import { ScriptWriter, type ScriptWriterResult } from "./ScriptWriter.js";
import {
	type ThreadCompletedItem,
	ThreadEventRouter,
} from "./ThreadEventRouter.js";

export const CODEX_VOICE_BINARY_VERSION = "codex-cli 0.156.1";
export const CODEX_VOICE_BINARY_SHA256 =
	"0196e89fe5a7598f816ee54232c3d7c26d75e502ab5cfe2c9240e81d90f7255a";
export const CODEX_VOICE_REALTIME_MODEL = "gpt-realtime-2.1";
export const CODEX_VOICE_REALTIME_VERSION = "v2";
export const CODEX_VOICE_OPEN_TIMEOUT_MS = 60_000;
/** Background sessions: open within min(entry + this, session start deadline − 10s). */
export const CODEX_VOICE_BACKGROUND_OPEN_TIMEOUT_MS = 90_000;
/** Reserved from the open deadline for admission teardown (plan v12 §14.2). */
export const CODEX_VOICE_TEARDOWN_RESERVE_MS = 25_000;
/** Reserved for the degraded POST, context reload and foreground open. */
export const CODEX_VOICE_FOREGROUND_RESERVE_MS = 20_000;
/** Below this much admission time the background is skipped outright. */
export const CODEX_VOICE_MIN_ADMISSION_MS = 10_000;
export const CODEX_VOICE_MAX_JSON_LINE_BYTES = 1024 * 1024;
const CONTEXT_MAX_AGE_MS = 60_000;
const CONTEXT_MAX_BYTES = 128 * 1024;
const CONTEXT_MAX_ESTIMATED_TOKENS = 32_768;
const CLOSE_RPC_TIMEOUT_MS = 5_000;
/** Process-level features the background agent must not carry. */
export const CAPABILITY_FEATURE_ARGV = Object.freeze([
	"-c",
	"features.apps=false",
]);

const execFileAsync = promisify(execFile);

export interface CodexVoiceContextSnapshot {
	readonly rosterNames?: readonly string[];
	contextGeneration?: number;
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
	voiceProfile?: { openAiApiKey: string };
	profile?: "voice-capability";
	capabilityModelEnv?: Parameters<
		typeof spawnCodexAppServer
	>[0]["capabilityModelEnv"];
	knownServerMethods: string[];
	maxJsonLineBytes: number;
}

interface BinaryEvidence {
	version: string;
	sha256: string;
	realtimeFeatureEnabled: boolean;
}

type EvidenceSink = (record: Record<string, unknown>) => void;

export type VoiceCapabilityParent = Awaited<
	ReturnType<typeof startVoiceCapabilityParent>
>;

interface OpenResources {
	cancelled: boolean;
	root?: string;
	process?: CodexVoiceProcess;
	scribe?: CodexVoiceProcess;
	parent?: VoiceCapabilityParent;
	/** The admitted parent's short activation root (outside `root`). */
	activationRoot?: string;
	cleanup?: Promise<void>;
	/** Background admission; owned separately until it succeeds (plan v12 §14.2). */
	admission?: AdmissionScope;
}

/** What the conversation actually runs with; the configured value is only an attempt. */
export type VoiceBackgroundState =
	| { state: "enabled" }
	| { state: "degraded"; reason: VoiceBackgroundDegradedReason };

type AdmissionStage =
	| "budget"
	| "parent"
	| "capability_process"
	| "capability_thread"
	| "scribe"
	| "script_writer";

class AdmissionCancelled extends Error {
	constructor() {
		super("voice_admission_cancelled");
	}
}
class AdmissionTimeout extends Error {
	constructor() {
		super("voice_admission_timeout");
	}
}

/**
 * Independent ownership of the background admission (R1#B5): its cancellation
 * is separate from the whole open's; once cancelled, a late continuation may
 * only close what it holds, never assemble or touch the foreground.
 */
class AdmissionScope {
	cancelled = false;
	/** Admission succeeded and handed its resources to the open. */
	transferred = false;
	/** The degrade path owns its teardown; the open's cleanup must not repeat it. */
	released = false;
	stage: AdmissionStage = "parent";
	violation?: string;
	parent?: VoiceCapabilityParent;
	process?: CodexVoiceProcess;
	scribe?: CodexVoiceProcess;
	/**
	 * Holds the parent's broker socket, so it lives under a short private root:
	 * the voice root can be arbitrarily deep but a UDS path is capped (QA@3 B1).
	 */
	activationRoot?: string;
	constructor(
		readonly root: string,
		readonly residuals: AdmissionResiduals,
		private readonly open: OpenResources,
	) {}
	assertActive(): void {
		if (this.cancelled || this.open.cancelled) throw new AdmissionCancelled();
		if (this.violation) throw new Error(this.violation);
	}
}

/**
 * Every admission RPC checks the admission is still active before it is sent
 * and after it returns, so a late continuation can only close (review R1#4).
 * Once the admission is handed over the guard no longer applies.
 */
function guardAdmissionProcess(
	process: CodexVoiceProcess,
	scope: AdmissionScope,
): CodexVoiceProcess {
	const check = () => {
		if (!scope.transferred) scope.assertActive();
	};
	const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
		check();
		const result = await call();
		check();
		return result;
	};
	return {
		on: (event, callback) => process.on(event, callback as never),
		start: () => guarded(() => process.start()),
		startThreadWithResult: (params) =>
			guarded(() => process.startThreadWithResult(params)),
		request: (method, params) => guarded(() => process.request(method, params)),
		stop: () => process.stop(),
	};
}

/** Map an admission failure to its public reason; the raw error stays local. */
function degradedReason(
	error: unknown,
	stage: AdmissionStage,
): VoiceBackgroundDegradedReason {
	if (error instanceof AdmissionTimeout) return "admission_timeout";
	const text = [
		rpcErrorMessage(error),
		error instanceof CodexVoiceContainerError ? error.reason : "",
		error instanceof Error && error.cause instanceof Error
			? error.cause.message
			: "",
	].join(" ");
	if (
		/native_skill|capability_skills_unverified/u.test(text) ||
		(stage === "parent" && /baseline_drift/u.test(text))
	)
		return "native_skill_baseline_unverified";
	if (text.includes("model_isolation_unproven"))
		return "model_isolation_unproven";
	if (text.includes("node_runtime_closure_unresolved"))
		return "node_runtime_closure_unresolved";
	if (text.includes("voice_capability_bridge_unavailable"))
		return "bridge_unavailable";
	if (/voice_capability_auth_invalid|codex_auth_rejected/u.test(text))
		return "subscription_auth_unverified";
	if (stage !== "parent") return "capability_process_failed";
	return "parent_start_failed";
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

async function readRpc(
	process: CodexVoiceProcess,
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response = await process.request(method, params);
	const result = asRecord(response.result);
	if (response.error || !result)
		throw new CodexVoiceContainerError("codex_profile_mismatch");
	return result;
}

async function assertSubscription(process: CodexVoiceProcess): Promise<void> {
	const account = await readRpc(process, "account/read", {
		refreshToken: false,
	});
	if (asRecord(account.account)?.type !== "chatgpt")
		throw new CodexVoiceContainerError("codex_auth_rejected");
}

async function assertTools(
	process: CodexVoiceProcess,
	expected: Record<string, unknown>,
): Promise<void> {
	const status = await readRpc(process, "mcpServerStatus/list", { limit: 100 });
	if (!Array.isArray(status.data) || status.nextCursor != null)
		throw new CodexVoiceContainerError("codex_profile_mismatch");
	const names = status.data.map((value: unknown) => asRecord(value)?.name);
	if (
		JSON.stringify([...names].sort()) !==
		JSON.stringify(Object.keys(expected).sort())
	)
		throw new CodexVoiceContainerError("codex_profile_mismatch");
	for (const value of status.data) {
		const server = asRecord(value)!;
		const spec = asRecord(expected[String(server.name)]);
		const toolNames = Array.isArray(server.tools)
			? server.tools.map((tool: unknown) => asRecord(tool)?.name)
			: Object.keys(asRecord(server.tools) ?? {});
		const allowed = spec?.enabled_tools;
		if (
			!Array.isArray(allowed) ||
			!allowed.length ||
			JSON.stringify(toolNames.sort()) !== JSON.stringify([...allowed].sort())
		)
			throw new CodexVoiceContainerError("codex_profile_mismatch");
	}
}

async function assertCapabilityProcess(
	process: CodexVoiceProcess,
	parent: VoiceCapabilityParent,
): Promise<void> {
	await parent.assertCurrent();
	await assertSubscription(process);
	const configResult = await readRpc(process, "config/read", {
		cwd: parent.cwd,
		includeLayers: false,
	});
	const config = asRecord(configResult.config);
	if (!config || config.forced_login_method === "api")
		throw new CodexVoiceContainerError("codex_profile_mismatch");
	await parent.verifyEffectiveConfig(config);
	const skills = await readRpc(process, "skills/list", {
		cwds: [parent.cwd],
		forceReload: true,
	});
	if (!parent.verifyEffectiveSkills)
		throw new CodexVoiceContainerError("codex_profile_mismatch");
	await parent.verifyEffectiveSkills(skills, parent.cwd);
	await assertTools(process, asRecord(config.mcp_servers) ?? {});
	await parent.assertCurrent();
}

async function assertScribeTools(
	process: CodexVoiceProcess,
	cwd: string,
): Promise<void> {
	const result = await readRpc(process, "config/read", {
		cwd,
		includeLayers: false,
	});
	const config = asRecord(result.config);
	const features = asRecord(config?.features);
	const disabled = [
		"shell_tool",
		"unified_exec",
		"view_image",
		"image_generation",
		"code_mode_host",
		"standalone_web_search",
		"memories",
		"apps",
		"plugins",
		"browser_use",
		"computer_use",
		"multi_agent",
		"hooks",
	];
	if (
		!config ||
		config.forced_login_method === "api" ||
		config.web_search !== "disabled" ||
		disabled.some((key) => features?.[key] !== false) ||
		Object.keys(asRecord(config.mcp_servers) ?? {}).length
	)
		throw new CodexVoiceContainerError("codex_profile_mismatch");
	await assertTools(process, {});
}

function assertCapabilityThreadReceipt(
	result: unknown,
	threadId: string,
	cwd: string,
): void {
	const row = asRecord(result);
	const thread = asRecord(row?.thread);
	const profile = asRecord(row?.activePermissionProfile);
	if (
		!row ||
		!thread ||
		thread.id !== threadId ||
		thread.cwd !== cwd ||
		thread.ephemeral !== true ||
		thread.cliVersion !== "0.156.1" ||
		thread.modelProvider !== "openai" ||
		!emptyStringArray(thread.environments) ||
		row.cwd !== cwd ||
		row.approvalPolicy !== "never" ||
		profile?.id !== "flywheel-lead-v2" ||
		profile.extends !== ":workspace"
	)
		throw new CodexVoiceContainerError("codex_profile_mismatch");
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
				profile: options.profile,
				capabilityModelEnv: options.capabilityModelEnv,
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
		message.includes("usage limit")
	) {
		return new CodexVoiceContainerError("codex_quota_exhausted", error);
	}
	if (
		message.includes("invalid_api_key") ||
		message.includes("authentication") ||
		message.includes("unauthorized") ||
		message.includes("http 401")
	) {
		return new CodexVoiceContainerError("codex_auth_rejected", error);
	}
	return new CodexVoiceContainerError("codex_open_failed", error);
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
	backgroundEnabled = false,
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
		(!backgroundEnabled &&
			!snapshot.realtimePrompt.startsWith(snapshot.baseInstructions)) ||
		baseBytes !== snapshot.measurements.baseInstructions.bytes ||
		realtimeBytes !== snapshot.measurements.realtimePrompt.bytes ||
		baseBytes > CONTEXT_MAX_BYTES ||
		realtimeBytes > CONTEXT_MAX_BYTES ||
		snapshot.measurements.baseInstructions.estimatedTokens >
			CONTEXT_MAX_ESTIMATED_TOKENS ||
		snapshot.measurements.realtimePrompt.estimatedTokens >
			(backgroundEnabled ? 4096 : CONTEXT_MAX_ESTIMATED_TOKENS)
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

function withTimeoutError<T>(
	promise: Promise<T>,
	timeoutMs: number,
	error: () => Error,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(error()), timeoutMs);
		timer.unref?.();
	});
	promise.catch(() => undefined);
	return Promise.race([promise, expiry]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

async function closeOwnedProcesses(
	process: CodexVoiceProcess | undefined,
	scribe: CodexVoiceProcess | undefined,
	parent: VoiceCapabilityParent | undefined,
): Promise<void> {
	// Revoke broker authority even when a child fails its shutdown handshake.
	const results = await Promise.allSettled([
		parent?.close(),
		process?.stop(),
		scribe?.stop(),
	]);
	if (results.some((result) => result.status === "rejected"))
		throw new CodexVoiceContainerError("cleanup_pending");
}

export class CodexVoiceConversation {
	private closePromise?: Promise<void>;
	private restartPromise?: Promise<number>;
	private currentGeneration: number;
	private currentTransport: CodexRealtimeTransport;

	constructor(
		readonly sessionId: string,
		readonly threadId: string,
		readonly root: string,
		readonly home: string,
		readonly workdir: string,
		readonly snapshotDigest: string,
		private readonly process: CodexVoiceProcess,
		transport: CodexRealtimeTransport,
		private readonly createTransport: (
			generation: number,
		) => Promise<CodexRealtimeTransport>,
		private readonly evidence: EvidenceSink,
		private readonly capability?: {
			parent: VoiceCapabilityParent;
			scribe: CodexVoiceProcess;
			writer: ScriptWriter;
			/** Outside `root`; removed with it (QA@3 B1). */
			activationRoot?: string;
		},
		private readonly threadEvents?: {
			router: ThreadEventRouter;
			unregister(): void;
		},
		/** Background sessions only: enabled, or degraded to foreground voice. */
		readonly background?: VoiceBackgroundState,
	) {
		this.currentTransport = transport;
		this.currentGeneration = transport.generation;
	}

	rewriteSpeech(input: {
		sourceText: string;
		rosterNames: readonly string[];
	}): Promise<ScriptWriterResult> {
		if (this.closePromise || !this.capability)
			return Promise.reject(new Error("voice_scribe_unavailable"));
		return this.capability.writer.rewrite(input);
	}

	actionLedger() {
		return this.capability?.parent.actionLedger() ?? [];
	}

	turnActionLedger(turnId: string) {
		return this.capability?.parent.turnActionLedger(turnId);
	}

	observeFounderUtterance(text: string): void {
		this.capability?.parent.observeFounderUtterance(text);
	}

	get generation(): number {
		return this.currentGeneration;
	}

	get transport(): CodexRealtimeTransport {
		return this.currentTransport;
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
		const previous = this.currentTransport;
		await withTimeout(
			previous.cancel(),
			CLOSE_RPC_TIMEOUT_MS,
			"codex_open_failed",
		);
		if (this.closePromise) throw new Error("conversation_closed");
		const generation = ++this.currentGeneration;
		const next = await withTimeout(
			this.createTransport(generation),
			CODEX_VOICE_OPEN_TIMEOUT_MS,
			"codex_open_failed",
		);
		if (this.closePromise) throw new Error("conversation_closed");
		await next.start();
		if (this.closePromise) {
			await next.cancel().catch(() => undefined);
			throw new Error("conversation_closed");
		}
		this.currentTransport = next;
		this.currentGeneration = generation;
		this.evidence({
			kind: "codex_voice_realtime_restarted",
			sessionId: this.sessionId,
			threadId: this.threadId,
			generation,
		});
		return generation;
	}

	close(reason = "session_end"): Promise<void> {
		this.closePromise ??= this.closeOnce(reason);
		return this.closePromise;
	}

	private async closeOnce(reason: string): Promise<void> {
		try {
			await this.restartPromise?.catch(() => undefined);
			const activeTurnId = this.threadEvents?.router.activeTurnId(
				this.threadId,
			);
			if (activeTurnId) {
				try {
					const interrupted = await withTimeout(
						this.process.request("turn/interrupt", {
							threadId: this.threadId,
							turnId: activeTurnId,
						}),
						CLOSE_RPC_TIMEOUT_MS,
						"codex_open_failed",
					);
					if (interrupted.error) throw new Error(interrupted.error.message);
				} catch (error) {
					this.evidence({
						kind: "codex_background_turn_interrupt_failed",
						threadId: this.threadId,
						turnId: activeTurnId,
						reason: error instanceof Error ? error.message : "unknown_error",
					});
				}
			}
			await withTimeout(
				this.currentTransport.cancel(),
				CLOSE_RPC_TIMEOUT_MS,
				"codex_open_failed",
			).catch(() => undefined);
			await closeOwnedProcesses(
				this.process,
				this.capability?.scribe,
				this.capability?.parent,
			);
		} catch {
			this.evidence({
				kind: "codex_voice_cleanup_pending",
				sessionId: this.sessionId,
				threadId: this.threadId,
				reason,
			});
			throw new CodexVoiceContainerError("cleanup_pending");
		}
		this.threadEvents?.unregister();
		await rm(this.root, { recursive: true, force: true });
		if (this.capability?.activationRoot)
			await rm(this.capability.activationRoot, {
				recursive: true,
				force: true,
			});
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
	loadContext: (generation?: number) => Promise<CodexVoiceContextSnapshot>;
	realtime?: {
		onAudio?(delta: CodexRealtimeAudioDelta): void;
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
	background?: {
		enabled: true;
		onTurnStarted(turnId: string): void;
		onTurnTerminal(turn: BackgroundTurnTerminal): void;
		onItemCompleted?(item: ThreadCompletedItem): void;
		/**
		 * Tell Bridge before loading the foreground context (plan v12 §14.2).
		 * If this rejects the session is unavailable: Bridge would still hand out
		 * background-shaped context.
		 */
		markDegraded(reason: VoiceBackgroundDegradedReason): Promise<void>;
		/** Runs after the foreground conversation is open (e.g. the thread notice). */
		onDegraded?(reason: VoiceBackgroundDegradedReason): void;
	};
	/** Absolute deadline by the container clock; defaults to now + 60s. */
	openDeadlineAt?: number;
}

interface AdmittedBackground {
	parent: VoiceCapabilityParent;
	process: CodexVoiceProcess;
	threadEventRouter: ThreadEventRouter;
	opened: { id: string; result: unknown };
	scribe: CodexVoiceProcess;
	writer: ScriptWriter;
	/** The opening brief bound to the admitted manifest. */
	snapshot: CodexVoiceContextSnapshot;
}

export class CodexVoiceContainer {
	private readonly now: () => number;
	private readonly inspectBinary: (path: string) => Promise<BinaryEvidence>;
	private readonly createProcess: (
		options: CodexVoiceProcessFactoryOptions,
	) => CodexVoiceProcess;
	private readonly evidence: EvidenceSink;
	private readonly residuals: AdmissionResidualRegistry;

	constructor(
		private readonly options: {
			binaryPath: string;
			scratchRoot: string;
			openAiApiKey: string;
			processEnv?: NodeJS.ProcessEnv;
			capability?: Omit<
				VoiceCapabilityParentInput,
				"sessionId" | "codexHome" | "codexBin" | "activationRoot" | "env"
			>;
			createCapabilityParent?: typeof startVoiceCapabilityParent;
			now?: () => number;
			inspectBinary?: (path: string) => Promise<BinaryEvidence>;
			createProcess?: (
				options: CodexVoiceProcessFactoryOptions,
			) => CodexVoiceProcess;
			onEvidence?: EvidenceSink;
			/** Daemon-level residual files; defaults under scratchRoot/residuals. */
			residuals?: AdmissionResidualRegistry;
		},
	) {
		this.now = options.now ?? Date.now;
		this.inspectBinary = options.inspectBinary ?? inspectCodexVoiceBinary;
		this.createProcess = options.createProcess ?? defaultCreateProcess;
		this.evidence = options.onEvidence ?? (() => undefined);
		this.residuals =
			options.residuals ??
			new AdmissionResidualRegistry({
				root: join(options.scratchRoot, "residuals"),
			});
	}

	open(input: CodexVoiceOpenInput): Promise<CodexVoiceConversation> {
		const resources: OpenResources = { cancelled: false };
		const openDeadlineAt =
			input.openDeadlineAt ?? this.now() + CODEX_VOICE_OPEN_TIMEOUT_MS;
		const attempt = this.openWithinDeadline(input, resources, openDeadlineAt);
		// A timed-out real child is stopped below. Its in-flight RPC then rejects;
		// keep that late settlement observed while the caller sees the deadline.
		attempt.catch(() => undefined);
		return withTimeout(
			attempt,
			Math.max(0, openDeadlineAt - this.now()),
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
		openDeadlineAt: number,
	): Promise<CodexVoiceConversation> {
		const openedAt = this.now();
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

		const loadFresh = async (backgroundShape: boolean) => {
			let loaded = await input.loadContext(undefined);
			assertActive();
			if (!contextIsFresh(loaded, this.now()))
				loaded = await input.loadContext(undefined);
			assertActive();
			if (!contextIsFresh(loaded, this.now())) {
				throw new CodexVoiceContainerError("context_stale");
			}
			assertContext(loaded, input.sessionId, backgroundShape);
			return loaded;
		};
		let snapshot = await loadFresh(input.background?.enabled === true);
		let initialGeneration = snapshot.contextGeneration ?? 1;
		if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1)
			throw new CodexVoiceContainerError("context_invalid");

		let conversation: CodexVoiceConversation | undefined;
		let violation: string | undefined;
		const timing: Record<string, number> = {
			preAdmissionMs: 0,
			admissionMs: 0,
			teardownMs: 0,
			foregroundMs: 0,
		};
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
			// The foreground never reuses a directory the admission wrote.
			const home = join(root, "fg", "home");
			const workdir = join(root, "fg", "work");
			await mkdir(join(root, "fg"), { mode: 0o700 });
			await mkdir(home, { mode: 0o700 });
			await mkdir(workdir, { mode: 0o700 });
			timing.preAdmissionMs = this.now() - openedAt;

			let admitted: AdmittedBackground | undefined;
			let degraded:
				| { reason: VoiceBackgroundDegradedReason; stage: AdmissionStage }
				| undefined;
			if (input.background?.enabled) {
				if (!this.options.capability)
					throw new Error("voice_capability_identity_missing");
				const admissionDeadlineAt =
					openDeadlineAt -
					CODEX_VOICE_TEARDOWN_RESERVE_MS -
					CODEX_VOICE_FOREGROUND_RESERVE_MS;
				const admissionStartedAt = this.now();
				if (
					admissionDeadlineAt - admissionStartedAt <
					CODEX_VOICE_MIN_ADMISSION_MS
				) {
					degraded = { reason: "admission_budget_exhausted", stage: "budget" };
					this.evidence({
						kind: "codex_voice_background_degraded",
						sessionId: input.sessionId,
						reason: degraded.reason,
						stage: degraded.stage,
						errorCode: "admission_budget_exhausted",
					});
					await this.markDegraded(input, degraded.reason);
				} else {
					// Claimed: periodic sweeps leave an in-flight admission alone.
					const scope = new AdmissionScope(
						join(root, "admission"),
						this.residuals.claim(input.sessionId),
						resources,
					);
					resources.admission = scope;
					try {
						admitted = await withTimeoutError(
							this.admit(input, scope, snapshot),
							Math.max(0, admissionDeadlineAt - this.now()),
							() => new AdmissionTimeout(),
						);
					} catch (error) {
						if (resources.cancelled) throw error;
						degraded = {
							reason: degradedReason(error, scope.stage),
							stage: scope.stage,
						};
						timing.admissionMs = this.now() - admissionStartedAt;
						const teardownStartedAt = this.now();
						await this.degradeAdmission(
							input,
							scope,
							degraded,
							error,
							openDeadlineAt - CODEX_VOICE_FOREGROUND_RESERVE_MS,
						);
						timing.teardownMs = this.now() - teardownStartedAt;
					}
					if (admitted) {
						timing.admissionMs = this.now() - admissionStartedAt;
						scope.transferred = true;
						// The conversation owns these processes now; no sweep may reap them.
						scope.residuals.release();
						resources.parent = admitted.parent;
						resources.process = admitted.process;
						resources.scribe = admitted.scribe;
						resources.activationRoot = scope.activationRoot;
					}
				}
				assertActive();
			}
			const foregroundStartedAt = this.now();
			if (degraded) {
				// Bridge now serves the foreground shape; never reuse the admission's.
				snapshot = await loadFresh(false);
				initialGeneration = snapshot.contextGeneration ?? 1;
				if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1)
					throw new CodexVoiceContainerError("context_invalid");
			}
			let process: CodexVoiceProcess;
			let threadEventRouter: ThreadEventRouter;
			let opened: { id: string; result: unknown };
			const parent = admitted?.parent;
			const onProcessExit = () => {
				if (!conversation) violation ??= "process_exited_during_open";
				else void conversation.close("process_exit").catch(() => undefined);
			};
			if (admitted) {
				process = admitted.process;
				threadEventRouter = admitted.threadEventRouter;
				opened = admitted.opened;
				snapshot = admitted.snapshot;
				process.on("exit", onProcessExit);
			} else {
				await writeFile(join(home, "config.toml"), VOICE_CODEX_HOME_CONFIG, {
					mode: 0o600,
					flag: "wx",
				});
				assertVoiceCodexHome(home);
				assertActive();
				process = this.createProcess({
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
					maxJsonLineBytes: CODEX_VOICE_MAX_JSON_LINE_BYTES,
				});
				threadEventRouter = new ThreadEventRouter(process);
				resources.process = process;
				process.on("exit", onProcessExit);
				await process.start();
				assertActive();
				if (violation) throw new Error(violation);
				opened = await process.startThreadWithResult({
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
			}
			const background = input.background;
			const unregisterBackground =
				admitted && background
					? threadEventRouter.register(opened.id, {
							onTurnStarted: (turnId) => {
								try {
									parent?.beginTurn(opened.id, turnId);
									background.onTurnStarted(turnId);
								} catch (error) {
									violation = "background_context_failed";
									this.evidence({
										kind: "codex_background_context_failed",
										threadId: opened.id,
										turnId,
										reason: rpcErrorMessage(error),
									});
									void process
										.request("turn/interrupt", { threadId: opened.id, turnId })
										.catch(() => undefined);
									void conversation?.close(violation).catch(() => undefined);
								}
							},
							onTurnTerminal: (turn) => {
								try {
									parent?.endTurn(turn.turnId, turn.outcome);
								} catch (error) {
									violation = "background_context_failed";
									this.evidence({
										kind: "codex_background_context_failed",
										threadId: opened.id,
										turnId: turn.turnId,
										reason: rpcErrorMessage(error),
									});
									void conversation?.close(violation).catch(() => undefined);
								}
								background.onTurnTerminal(turn);
							},
							...(background.onItemCompleted
								? { onItemCompleted: background.onItemCompleted }
								: {}),
						})
					: undefined;
			const realtimeStart = {
				outputModality: "audio",
				clientManagedHandoffs: true,
				includeStartupContext: false,
				prompt: snapshot.realtimePrompt,
				transport: { type: "websocket" },
				version: CODEX_VOICE_REALTIME_VERSION,
				model: CODEX_VOICE_REALTIME_MODEL,
				voice: input.voice,
			};
			const createTransport = async (generation: number) => {
				if (generation !== initialGeneration) {
					snapshot = await input.loadContext(generation);
					if (!contextIsFresh(snapshot, this.now()))
						throw new CodexVoiceContainerError("context_stale");
					assertContext(snapshot, input.sessionId, !!admitted);
					if (parent) {
						await assertCapabilityProcess(process, parent);
						snapshot = bindAdmittedVoiceCapabilities(snapshot, parent.manifest);
						assertContext(snapshot, input.sessionId, true);
					}
					if (
						snapshot.contextGeneration !== undefined &&
						snapshot.contextGeneration !== generation
					)
						throw new CodexVoiceContainerError("context_invalid");
				}
				return new CodexRealtimeTransport({
					rpc: process,
					sessionId: input.sessionId,
					threadId: opened.id,
					generation,
					start: { ...realtimeStart, prompt: snapshot.realtimePrompt },
					backgroundExecution: admitted ? "allow" : "interrupt",
					...input.realtime,
				});
			};
			const transport = await createTransport(initialGeneration);
			await transport.start();
			assertActive();
			if (violation) throw new Error(violation);
			timing.foregroundMs = this.now() - foregroundStartedAt;
			const backgroundState: VoiceBackgroundState | undefined = input.background
				?.enabled
				? admitted
					? { state: "enabled" }
					: { state: "degraded", reason: degraded!.reason }
				: undefined;
			conversation = new CodexVoiceConversation(
				input.sessionId,
				opened.id,
				root,
				home,
				workdir,
				snapshot.snapshotDigest,
				process,
				transport,
				createTransport,
				this.evidence,
				admitted
					? {
							parent: admitted.parent,
							scribe: admitted.scribe,
							writer: admitted.writer,
							activationRoot: resources.activationRoot,
						}
					: undefined,
				unregisterBackground
					? {
							router: threadEventRouter,
							unregister: unregisterBackground,
						}
					: undefined,
				backgroundState,
			);
			this.evidence({
				kind: "codex_voice_container_opened",
				sessionId: input.sessionId,
				threadId: opened.id,
				binaryDigest: binary.sha256,
				configDigest: parent?.mcp.configHash ?? sha256(VOICE_CODEX_HOME_CONFIG),
				contextDigest: snapshot.snapshotDigest,
				generation: initialGeneration,
				backgroundExecution: admitted ? "enabled" : "disabled",
				...(backgroundState ? { background: backgroundState.state } : {}),
				...(parent
					? { accountType: "chatgpt", toolServers: parent.mcp.included }
					: {}),
			});
			if (input.background?.enabled)
				this.evidence({
					kind: "codex_voice_open_timing",
					sessionId: input.sessionId,
					...timing,
				});
			if (backgroundState?.state === "degraded") {
				try {
					input.background?.onDegraded?.(backgroundState.reason);
				} catch {
					/* A notice failure does not undo an open conversation. */
				}
			}
			return conversation;
		} catch (error) {
			resources.cancelled = true;
			await this.cleanupOpen(resources, input.sessionId);
			throw classifyOpenError(error);
		}
	}

	/** Parent → capability process → capability thread → scribe → script writer. */
	private async admit(
		input: CodexVoiceOpenInput,
		scope: AdmissionScope,
		snapshot: CodexVoiceContextSnapshot,
	): Promise<AdmittedBackground> {
		const directory = scope.root;
		await mkdir(directory, { mode: 0o700 });
		scope.residuals.registerDirectory(directory);
		scope.assertActive();
		// Same short private root as the resident parent (default-runtime `fw-cap-`).
		const activationRoot = await mkdtemp(
			join(await realpath("/tmp"), "fw-vcap-"),
		);
		scope.activationRoot = activationRoot;
		scope.residuals.registerDirectory(activationRoot);
		const home = join(directory, "home");
		const scribeHome = join(directory, "scribe-home");
		const scribeWork = join(directory, "scribe-work");
		const work = join(directory, "work");
		for (const path of [home, scribeHome, scribeWork, work])
			await mkdir(path, { mode: 0o700 });
		scope.assertActive();
		return observeChildSpawns(
			(pid) => scope.residuals.registerSpawned(pid),
			async () => {
				scope.stage = "parent";
				const parent = await (
					this.options.createCapabilityParent ?? startVoiceCapabilityParent
				)({
					...this.options.capability!,
					sessionId: input.sessionId,
					codexHome: home,
					codexBin: this.options.binaryPath,
					activationRoot,
					env: this.options.processEnv ?? processEnv(),
				});
				if (scope.cancelled) {
					// Late: revoke at once, then only close it.
					try {
						parent.revoke?.();
					} catch {
						/* close() revokes too. */
					}
					void parent.close().catch(() => undefined);
					throw new AdmissionCancelled();
				}
				scope.parent = parent;
				scope.assertActive();
				if (parent.nodeRuntimeClosure)
					this.evidence({
						kind: "codex_voice_node_runtime_closure",
						sessionId: input.sessionId,
						files: parent.nodeRuntimeClosure.files,
						directories: parent.nodeRuntimeClosure.directories,
					});
				assertVoiceCapabilityHome(home, parent.authSourcePath);

				scope.stage = "capability_process";
				const process = this.createProcess({
					root: directory,
					codexBin: this.options.binaryPath,
					codexHome: home,
					cwd: parent.cwd,
					// Codex injects a `codex_apps` MCP server (ChatGPT apps) for subscription
					// accounts; those tools are not Lead capabilities (FLY-2886 real host).
					mcpArgv: [
						...parent.permissionArgv,
						...parent.mcp.argv,
						...CAPABILITY_FEATURE_ARGV,
					],
					profile: "voice-capability",
					capabilityModelEnv: parent.capabilityModelEnv,
					baseEnv: positiveChildEnv(
						this.options.processEnv ?? processEnv(),
						home,
						work,
					),
					voiceProfile: { openAiApiKey: this.options.openAiApiKey },
					knownServerMethods: [],
					maxJsonLineBytes: CODEX_VOICE_MAX_JSON_LINE_BYTES,
				});
				const threadEventRouter = new ThreadEventRouter(process);
				scope.process = process;
				process.on("exit", () => {
					if (!scope.transferred)
						scope.violation ??= "process_exited_during_open";
				});
				const admitting = guardAdmissionProcess(process, scope);
				await admitting.start();
				scope.assertActive();
				await assertCapabilityProcess(admitting, parent);
				scope.assertActive();
				const bound = bindAdmittedVoiceCapabilities(snapshot, parent.manifest);
				assertContext(bound, input.sessionId, true);

				scope.stage = "capability_thread";
				const opened = await admitting.startThreadWithResult({
					cwd: parent.cwd,
					approvalPolicy: "never",
					permissions: "flywheel-lead-v2",
					ephemeral: true,
					environments: [],
					baseInstructions: parent.baseInstructions,
					developerInstructions: bound.baseInstructions,
					config: { "features.realtime_conversation": true },
				});
				scope.assertActive();
				assertCapabilityThreadReceipt(opened.result, opened.id, parent.cwd);

				scope.stage = "scribe";
				await writeFile(
					join(scribeHome, "config.toml"),
					VOICE_SCRIBE_HOME_CONFIG,
					{ mode: 0o600, flag: "wx" },
				);
				await symlink(parent.authSourcePath, join(scribeHome, "auth.json"));
				assertVoiceScribeHome(scribeHome, parent.authSourcePath);
				scope.assertActive();
				const scribe = this.createProcess({
					root: directory,
					codexBin: this.options.binaryPath,
					codexHome: scribeHome,
					cwd: scribeWork,
					mcpArgv: [],
					baseEnv: positiveChildEnv(
						this.options.processEnv ?? processEnv(),
						scribeHome,
						scribeWork,
					),
					knownServerMethods: [],
					maxJsonLineBytes: CODEX_VOICE_MAX_JSON_LINE_BYTES,
				});
				scope.scribe = scribe;
				const scribing = guardAdmissionProcess(scribe, scope);
				await scribing.start();
				scope.assertActive();
				await assertSubscription(scribing);
				scope.assertActive();
				await assertScribeTools(scribing, scribeWork);
				scope.assertActive();
				const scribeThread = await scribing.startThreadWithResult({
					cwd: scribeWork,
					approvalPolicy: "never",
					sandbox: "read-only",
					ephemeral: true,
					environments: [],
				});
				assertThreadReceipt(scribeThread.result, scribeThread.id, scribeWork);
				scope.assertActive();

				scope.stage = "script_writer";
				const writer = new ScriptWriter({
					process: scribing,
					threadId: scribeThread.id,
				});
				// This ordinary subscription turn also admits the structured-output protocol.
				await writer.rewrite({ sourceText: "准备好了。", rosterNames: [] });
				scope.assertActive();
				return {
					parent,
					process,
					threadEventRouter,
					opened,
					scribe,
					writer,
					snapshot: bound,
				};
			},
		);
	}

	/**
	 * Fixed order (plan v12 §14.2, R6#N5): revoke the parent → Bridge degraded →
	 * snapshot/freeze/reap by identity → close() each resource → foreground. Every
	 * step runs even if an earlier one failed; only a failed degraded POST makes
	 * the session unavailable, after the rest has run.
	 */
	private async degradeAdmission(
		input: CodexVoiceOpenInput,
		scope: AdmissionScope,
		degraded: { reason: VoiceBackgroundDegradedReason; stage: AdmissionStage },
		error: unknown,
		teardownDeadlineAt: number,
	): Promise<void> {
		scope.cancelled = true;
		scope.released = true;
		try {
			scope.parent?.revoke?.();
		} catch {
			/* Recorded by the reap/close below; never blocks degradation. */
		}
		this.evidence({
			kind: "codex_voice_background_degraded",
			sessionId: input.sessionId,
			reason: degraded.reason,
			stage: degraded.stage,
			errorCode:
				error instanceof AdmissionTimeout
					? "admission_timeout"
					: rpcErrorMessage(error) || "unknown_error",
		});
		let markError: unknown;
		try {
			await this.markDegraded(input, degraded.reason);
		} catch (failure) {
			markError = failure;
		}
		const teardown = (async () => {
			await scope.residuals.reap(this.evidence).catch(() => "pending");
			for (const close of [
				() => scope.scribe?.stop(),
				() => scope.process?.stop(),
				() => scope.parent?.close(),
			]) {
				try {
					await close();
				} catch {
					/* The residual file keeps anything still alive. */
				}
			}
			for (const path of [scope.root, scope.activationRoot])
				if (path)
					await rm(path, { recursive: true, force: true }).catch(
						() => undefined,
					);
			await scope.residuals.reap(this.evidence).catch(() => "pending");
		})();
		// Hand leftovers to the periodic sweep only once this teardown is over.
		void teardown
			.finally(() => scope.residuals.detach())
			.catch(() => undefined);
		await withTimeout(
			teardown,
			Math.max(0, teardownDeadlineAt - this.now()),
			"codex_open_failed",
		).catch(() => {
			this.evidence({
				kind: "codex_voice_admission_teardown_deferred",
				sessionId: input.sessionId,
			});
		});
		if (markError)
			throw new CodexVoiceContainerError("codex_open_failed", markError);
	}

	private async markDegraded(
		input: CodexVoiceOpenInput,
		reason: VoiceBackgroundDegradedReason,
	): Promise<void> {
		if (!input.background?.markDegraded)
			throw new Error("voice_background_degraded_unreported");
		await input.background.markDegraded(reason);
	}

	private async cleanupOpen(
		resources: OpenResources,
		sessionId: string,
	): Promise<void> {
		if (resources.cleanup) return resources.cleanup;
		const admission = resources.admission;
		if (admission && !admission.transferred && !admission.released) {
			admission.released = true;
			// Best effort and outside the open's failure path (R4#N3).
			admission.cancelled = true;
			try {
				admission.parent?.revoke?.();
			} catch {
				/* close() revokes too. */
			}
			void (async () => {
				await admission.residuals.reap(this.evidence).catch(() => undefined);
				for (const close of [
					() => admission.scribe?.stop(),
					() => admission.process?.stop(),
					() => admission.parent?.close(),
				])
					await Promise.resolve()
						.then(close)
						.catch(() => undefined);
				for (const path of [admission.root, admission.activationRoot])
					if (path)
						await rm(path, { recursive: true, force: true }).catch(
							() => undefined,
						);
			})().finally(() => admission.residuals.detach());
		}
		if (!resources.process && !resources.root && !resources.activationRoot)
			return;
		resources.cleanup = (async () => {
			try {
				await closeOwnedProcesses(
					resources.process,
					resources.scribe,
					resources.parent,
				);
			} catch {
				this.evidence({ kind: "codex_voice_cleanup_pending", sessionId });
				throw new CodexVoiceContainerError("cleanup_pending");
			}
			if (resources.root) {
				await rm(resources.root, { recursive: true, force: true });
			}
			if (resources.activationRoot)
				await rm(resources.activationRoot, { recursive: true, force: true });
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
