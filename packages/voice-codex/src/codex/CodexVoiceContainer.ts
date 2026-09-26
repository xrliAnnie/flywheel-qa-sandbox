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
	VOICE_BASE_MAX_BYTES,
	VOICE_BASE_MAX_ESTIMATED_TOKENS,
	VOICE_CONTEXT_TOKENIZER,
	VOICE_CONTEXT_VERSION,
	VOICE_INITIAL_ITEM_WRAPPER_TOKENS,
	VOICE_INITIAL_ITEMS_MAX_BYTES,
	VOICE_INITIAL_ITEMS_MAX_COUNT,
	VOICE_INITIAL_ITEMS_MAX_TOKENS,
	VOICE_MEMORY_SEGMENT_MAX_BYTES,
	VOICE_MEMORY_SEGMENT_MAX_TOKENS,
	VOICE_REALTIME_PROMPT_MAX_BYTES,
	VOICE_REALTIME_PROMPT_MAX_TOKENS,
	type VoiceRealtimeItem,
	voiceContextDigest,
	voiceContextHeader,
	voiceContextSourceManifest,
	voiceInitialItemsTokens,
} from "flywheel-teamlead/voice-context-contract";
import { BridgeVoiceHttpError } from "../bridge-client.js";
import {
	assertVoiceCodexHome,
	pinVoiceCodexAuthSource,
	VOICE_CODEX_HOME_CONFIG,
} from "../codex-home.js";
import { countVoiceContextTokens } from "./context-tokens.js";
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
const CLOSE_RPC_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

/**
 * FLY-2885 T8 (v2): the backing thread gets the whole context as
 * baseInstructions; the realtime session gets a prompt without the memory
 * plus the memory as developer initialItems.
 */
export interface CodexVoiceContextSnapshot {
	baseInstructions: string;
	realtime: { prompt: string; initialItems: VoiceRealtimeItem[] };
	snapshotDigest: string;
	manifest: {
		version: 2;
		sourceVersion: number;
		capturedAt: string;
		snapshotDigest: string;
		leaseBindingDigest: string;
		rosterDigest: string;
		[key: string]: unknown;
	};
	measurements: {
		baseInstructions: { bytes: number; estimatedTokens: number };
		realtimePrompt: { bytes: number; estimatedTokens: number };
		initialItems: {
			count: number;
			bytes: number;
			codexEstimatedTokens: number;
			/** plan §12.2: o200k per item text, without the wrapper. */
			itemTokens: number[];
			/** Σ itemTokens + 8 per item. */
			tokens: number;
		};
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
			| "context_too_large"
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
		...(cause instanceof BridgeVoiceHttpError && cause.context
			? { contextReason: cause.context.reason, details: cause.context.details }
			: {}),
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

/**
 * T8: re-verify the Bridge's v2 snapshot before anything opens: one header on
 * both texts, the digest recomputed from the unheaded bodies, items and
 * source manifest (the same code the Bridge used), and every budget.
 */
function assertContext(
	snapshot: CodexVoiceContextSnapshot,
	sessionId: string,
	countTokens: (value: string) => number,
): void {
	const invalid = () => new CodexVoiceContainerError("context_invalid");
	const digest = /^[a-f0-9]{64}$/u;
	const manifest = snapshot?.manifest;
	const realtime = snapshot?.realtime;
	if (
		!manifest ||
		!realtime ||
		typeof snapshot.baseInstructions !== "string" ||
		typeof realtime.prompt !== "string" ||
		!Array.isArray(realtime.initialItems) ||
		!digest.test(snapshot.snapshotDigest) ||
		manifest.version !== VOICE_CONTEXT_VERSION ||
		manifest.tokenizer !== VOICE_CONTEXT_TOKENIZER ||
		manifest.snapshotDigest !== snapshot.snapshotDigest ||
		!digest.test(String(manifest.leaseBindingDigest)) ||
		!digest.test(String(manifest.rosterDigest))
	)
		throw invalid();
	const header = `${voiceContextHeader(snapshot.snapshotDigest, sessionId)}\n\n`;
	if (
		!snapshot.baseInstructions.startsWith(header) ||
		!realtime.prompt.startsWith(header)
	)
		throw invalid();
	const items = realtime.initialItems;
	if (
		items.length > VOICE_INITIAL_ITEMS_MAX_COUNT ||
		!items.every(
			(item) =>
				item !== null &&
				typeof item === "object" &&
				item.role === "developer" &&
				typeof item.text === "string" &&
				item.text.length > 0 &&
				Object.keys(item).length === 2,
		)
	)
		throw invalid();
	const recomputed = voiceContextDigest({
		baseBody: snapshot.baseInstructions.slice(header.length),
		realtimePromptBody: realtime.prompt.slice(header.length),
		initialItems: items,
		leaseBindingDigest: manifest.leaseBindingDigest,
		sourceManifest: voiceContextSourceManifest(manifest),
		rosterDigest: manifest.rosterDigest,
		sessionId,
	});
	if (recomputed !== snapshot.snapshotDigest) throw invalid();
	const baseBytes = Buffer.byteLength(snapshot.baseInstructions, "utf8");
	const promptBytes = Buffer.byteLength(realtime.prompt, "utf8");
	const itemBytes = items.reduce(
		(total, item) => total + Buffer.byteLength(item.text, "utf8"),
		0,
	);
	const measured = snapshot.measurements;
	if (
		baseBytes !== measured?.baseInstructions?.bytes ||
		promptBytes !== measured.realtimePrompt?.bytes ||
		itemBytes !== measured.initialItems?.bytes ||
		items.length !== measured.initialItems.count ||
		baseBytes > VOICE_BASE_MAX_BYTES ||
		promptBytes > VOICE_REALTIME_PROMPT_MAX_BYTES ||
		itemBytes > VOICE_INITIAL_ITEMS_MAX_BYTES ||
		measured.baseInstructions.estimatedTokens >
			VOICE_BASE_MAX_ESTIMATED_TOKENS ||
		measured.realtimePrompt.estimatedTokens > VOICE_REALTIME_PROMPT_MAX_TOKENS
	)
		throw invalid();
	// plan §12.2: the measurements sit outside the digest, so recount every
	// text with the same tokenizer (bytes are already bounded above) and
	// require the Bridge's numbers to match exactly.
	const count = (text: string): number => {
		let tokens: number;
		try {
			tokens = countTokens(text);
		} catch {
			throw invalid();
		}
		if (!Number.isSafeInteger(tokens) || tokens < 0) throw invalid();
		return tokens;
	};
	if (
		count(snapshot.baseInstructions) !==
			measured.baseInstructions.estimatedTokens ||
		count(realtime.prompt) !== measured.realtimePrompt.estimatedTokens
	)
		throw invalid();
	const itemTokens = measured.initialItems.itemTokens;
	if (!Array.isArray(itemTokens) || itemTokens.length !== items.length)
		throw invalid();
	for (const [index, item] of items.entries()) {
		const tokens = count(item.text);
		// plan §12.4: every item is one segment within 2,000 tokens with its
		// wrapper and 8,000 bytes, whatever the total.
		if (
			tokens !== itemTokens[index] ||
			tokens + VOICE_INITIAL_ITEM_WRAPPER_TOKENS >
				VOICE_MEMORY_SEGMENT_MAX_TOKENS ||
			Buffer.byteLength(item.text, "utf8") > VOICE_MEMORY_SEGMENT_MAX_BYTES
		)
			throw invalid();
	}
	const tokens = voiceInitialItemsTokens(itemTokens);
	if (
		tokens !== measured.initialItems.tokens ||
		tokens > VOICE_INITIAL_ITEMS_MAX_TOKENS
	)
		throw invalid();
}

/**
 * plan §12.5: a Bridge that could not build the context says why; an
 * oversized context is its own reason, an uncountable one is invalid.
 */
function contextLoadError(error: unknown): unknown {
	if (!(error instanceof BridgeVoiceHttpError) || !error.context) return error;
	if (error.context.reason === "context_too_large")
		return new CodexVoiceContainerError("context_too_large", error);
	if (error.context.reason === "context_token_count_unavailable")
		return new CodexVoiceContainerError("context_invalid", error);
	return error;
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

/** Plan T7: at most three generation changes per session. */
const RECONNECT_BACKOFF_MS = [0, 2_000, 5_000] as const;
const RECONNECT_ATTEMPT_TIMEOUT_MS = 20_000;

export interface CodexVoiceGenerationEvents {
	/** The current generation is gone; a new one is being opened (T7). */
	onGenerationLost?(input: { generation: number; reason: string }): void;
	/** A new generation is live. */
	onGenerationReady?(input: { generation: number }): void;
	/** Terminal: the session cannot continue. */
	onClosed?(input: { generation: number; reason: string }): void;
}

type ConversationState = "live" | "draining" | "reopening" | "closed";

export class CodexVoiceConversation {
	private closePromise?: Promise<void>;
	private reconnectPromise?: Promise<void>;
	private readonly closing = new AbortController();
	private state: ConversationState = "live";
	private current: CodexVoiceGeneration;
	private nextGeneration: number;
	private reconnects = 0;
	private pending?: { generation: number; controller: AbortController };

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
		private readonly events: CodexVoiceGenerationEvents = {},
		private readonly timing: {
			backoffMs?: readonly number[];
			attemptTimeoutMs?: number;
			closeTimeoutMs?: number;
		} = {},
	) {
		this.current = initial;
		this.nextGeneration = initial.generation + 1;
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

	/**
	 * T7: one entry for every way a generation dies — the WebRTC leg lost, the
	 * realtime session closed or errored. The first one starts a generation
	 * change; the rest only leave evidence.
	 */
	fault(generation: number, reason: string): void {
		if (this.pending?.generation === generation) {
			this.pending.controller.abort(new Error(reason));
			return;
		}
		if (this.state !== "live" || generation !== this.current.generation) {
			this.evidence({
				kind: "codex_voice_fault_merged",
				sessionId: this.sessionId,
				generation,
				reason,
				state: this.state,
			});
			return;
		}
		this.reconnectPromise = this.reconnectOnce(reason).finally(() => {
			this.reconnectPromise = undefined;
		});
	}

	/** The WebRTC leg of `generation` reported its peer gone. */
	legLost(generation: number, reason: string): void {
		this.fault(generation, `webrtc_${reason}`);
	}

	/** T5c: the current generation cannot continue; open a new one. */
	reconnect(reason: string): void {
		this.fault(this.current.generation, reason);
	}

	/** QA-3a only (FLYWHEEL_VOICE_QA_FAULTS=1): drop the current WebRTC leg. */
	qaDropLeg(): void {
		const current = this.current;
		void current.leg.close();
		this.fault(current.generation, "qa_leg_closed");
	}

	/** The session is over for a reason outside this conversation. */
	terminate(reason: string): void {
		if (this.state === "closed") return;
		this.state = "closed";
		this.events.onClosed?.({ generation: this.current.generation, reason });
		void this.close(reason).catch(() => undefined);
	}

	private async reconnectOnce(reason: string): Promise<void> {
		const lost = this.current;
		this.state = "draining";
		this.evidence({
			kind: "codex_voice_realtime_reconnecting",
			sessionId: this.sessionId,
			generation: lost.generation,
			reason,
		});
		this.events.onGenerationLost?.({ generation: lost.generation, reason });
		// Error/closed notifications carry no realtime generation: only the
		// old session's confirmed close makes the thread safe to reuse.
		const confirmed = await this.barrier(lost);
		await lost.leg.close();
		this.retireGeneration(lost.generation);
		if (!confirmed) {
			this.fail("realtime_reconnect_unconfirmed");
			return;
		}
		const backoff = this.timing.backoffMs ?? RECONNECT_BACKOFF_MS;
		while (this.reconnects < backoff.length) {
			const delay = backoff[this.reconnects] ?? 0;
			this.reconnects += 1;
			if (!(await this.sleep(delay))) return;
			this.state = "reopening";
			const generation = this.nextGeneration++;
			const controller = new AbortController();
			this.pending = { generation, controller };
			const next = this.createGeneration(generation);
			const timer = setTimeout(
				() => controller.abort(new Error("reconnect_attempt_timeout")),
				this.timing.attemptTimeoutMs ?? RECONNECT_ATTEMPT_TIMEOUT_MS,
			);
			timer.unref?.();
			const stopAttempt = () =>
				controller.abort(new Error("conversation_closed"));
			this.closing.signal.addEventListener("abort", stopAttempt, {
				once: true,
			});
			try {
				await next.transport.start(controller.signal);
				if (this.closePromise) throw new Error("conversation_closed");
				this.pending = undefined;
				this.current = next;
				this.state = "live";
				this.evidence({
					kind: "codex_voice_realtime_reconnected",
					sessionId: this.sessionId,
					generation,
					attempt: this.reconnects,
				});
				this.events.onGenerationReady?.({ generation });
				return;
			} catch (error) {
				this.pending = undefined;
				this.state = "draining";
				this.evidence({
					kind: "codex_voice_reconnect_attempt_failed",
					sessionId: this.sessionId,
					generation,
					attempt: this.reconnects,
					reason: error instanceof Error ? error.message : String(error),
				});
				await next.leg.close();
				const settled = next.transport.startRequested
					? await this.barrier(next)
					: true;
				this.retireGeneration(generation);
				if (this.closePromise) return;
				if (!settled) {
					this.fail("realtime_reconnect_unconfirmed");
					return;
				}
			} finally {
				clearTimeout(timer);
				this.closing.signal.removeEventListener("abort", stopAttempt);
			}
		}
		this.fail("realtime_reconnect_exhausted");
	}

	/** Stop and wait for closed (≤5 s); false when it cannot be confirmed. */
	private async barrier(generation: CodexVoiceGeneration): Promise<boolean> {
		try {
			await withTimeout(
				generation.transport.cancel(),
				this.timing.closeTimeoutMs ?? CLOSE_RPC_TIMEOUT_MS,
				"codex_open_failed",
			);
			return true;
		} catch {
			return false;
		}
	}

	private sleep(ms: number): Promise<boolean> {
		if (this.closePromise) return Promise.resolve(false);
		if (ms <= 0) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.closing.signal.removeEventListener("abort", stop);
				resolve(true);
			}, ms);
			timer.unref?.();
			const stop = () => {
				clearTimeout(timer);
				resolve(false);
			};
			this.closing.signal.addEventListener("abort", stop, { once: true });
		});
	}

	private fail(reason: string): void {
		if (this.closePromise) return;
		this.evidence({
			kind: "codex_voice_realtime_reconnect_failed",
			sessionId: this.sessionId,
			reason,
			attempts: this.reconnects,
		});
		this.terminate(reason);
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
		this.state = "closed";
		this.closing.abort();
		try {
			await this.reconnectPromise?.catch(() => undefined);
			await withTimeout(
				this.current.transport.cancel(),
				this.timing.closeTimeoutMs ?? CLOSE_RPC_TIMEOUT_MS,
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
		onGenerationLost?(input: { generation: number; reason: string }): void;
		onGenerationReady?(input: { generation: number }): void;
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
			/** Every conversation this container opens (QA fault hook). */
			onOpened?: (conversation: CodexVoiceConversation) => void;
			/** Tests only: shorter T7 backoff/attempt/close timings. */
			reconnectTiming?: {
				backoffMs?: readonly number[];
				attemptTimeoutMs?: number;
				closeTimeoutMs?: number;
			};
			/** FLY-2885: the fleet's subscription credential; linked, never copied. */
			authSource: string;
			processEnv?: NodeJS.ProcessEnv;
			now?: () => number;
			inspectBinary?: (path: string) => Promise<BinaryEvidence>;
			createProcess?: (
				options: CodexVoiceProcessFactoryOptions,
			) => CodexVoiceProcess;
			onEvidence?: EvidenceSink;
			/** plan §12.2: tests only; production recounts with o200k. */
			countTokens?: (value: string) => number;
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

		const loadContext = () =>
			input.loadContext().catch((error: unknown) => {
				throw contextLoadError(error);
			});
		let snapshot = await loadContext();
		assertActive();
		if (!contextIsFresh(snapshot, this.now())) snapshot = await loadContext();
		assertActive();
		if (!contextIsFresh(snapshot, this.now())) {
			throw new CodexVoiceContainerError("context_stale");
		}
		try {
			assertContext(
				snapshot,
				input.sessionId,
				this.options.countTokens ?? countVoiceContextTokens,
			);
		} catch (error) {
			throw error instanceof CodexVoiceContainerError
				? error
				: new CodexVoiceContainerError("context_invalid", error);
		}
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
				// No reconnect without the app-server: the session ends here.
				else conversation.terminate("process_exit");
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
				// T8: the same snapshot for every generation of this session.
				prompt: snapshot.realtime.prompt,
				initialItems: snapshot.realtime.initialItems,
				model: CODEX_VOICE_REALTIME_MODEL,
				voice: input.voice,
			};
			const {
				onDownlink,
				onDataEvent,
				onClosed,
				onError,
				onGenerationLost,
				onGenerationReady,
				...transportCallbacks
			} = input.realtime ?? {};
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
					// T7: a closed or errored generation is recoverable; the
					// conversation decides, and only a terminal end reaches the
					// session as onClosed.
					onClosed: ({ reason }) => {
						if (conversation)
							conversation.fault(generation, `realtime_closed:${reason}`);
					},
					onError: (error) => {
						this.evidence({
							kind: "codex_voice_realtime_error",
							sessionId: input.sessionId,
							generation,
							errorType: error.name,
							message: error.message,
						});
						if (conversation)
							conversation.fault(generation, `realtime_error:${error.message}`);
						else onError?.(error);
					},
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
				{
					onGenerationLost: (lost) => onGenerationLost?.(lost),
					onGenerationReady: (ready) => onGenerationReady?.(ready),
					onClosed: (closed) => onClosed?.(closed),
				},
				this.options.reconnectTiming,
			);
			this.evidence({
				kind: "codex_voice_container_opened",
				sessionId: input.sessionId,
				threadId: opened.id,
				binaryDigest: binary.sha256,
				configDigest: sha256(VOICE_CODEX_HOME_CONFIG),
				contextDigest: snapshot.snapshotDigest,
			});
			this.options.onOpened?.(conversation);
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
