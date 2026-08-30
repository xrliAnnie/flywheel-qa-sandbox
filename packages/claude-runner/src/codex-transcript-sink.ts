import {
	appendFile as appendFileFs,
	mkdir as mkdirFs,
	rename as renameFs,
	stat as statFs,
} from "node:fs/promises";
import { dirname } from "node:path";

const UNKNOWN_EVENT_MAX_CHARS = 500;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024;
const DEFAULT_CLOSE_DEADLINE_MS = 5_000;
const BACKPRESSURE_MARKER = "── output dropped (backpressure) ──\n";
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function textParts(value: unknown): string[] {
	return asArray(value)
		.map((part) =>
			typeof part === "string" ? part : asString(asRecord(part)?.text),
		)
		.filter((part): part is string => part !== undefined && part.length > 0);
}

function sanitizeTerminalText(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate OSC terminal-sequence sanitizer
			.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate CSI terminal-sequence sanitizer
			.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate two-byte terminal escape sanitizer
			.replace(/\u001b[@-_]/g, "")
			.replace(
				// biome-ignore lint/suspicious/noControlCharactersInRegex: transcript security boundary strips unsafe controls while preserving newline/tab
				/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
				"",
			)
			.replace(/\r/g, "")
	);
}

function boundedSingleLine(value: string, maxChars: number): string {
	const singleLine = sanitizeTerminalText(value).replace(/[\n\t]+/g, " ");
	const chars = Array.from(singleLine);
	return chars.length <= maxChars
		? singleLine
		: `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "[unserializable]";
	}
}

export function renderCodexNotification(
	method: string,
	params: unknown,
): string | undefined {
	if (method.includes("/delta") || method === "thread/tokenUsage/updated") {
		return undefined;
	}

	const body = asRecord(params);
	if (method === "turn/started" || method === "turn/completed") {
		const turn = asRecord(body?.turn);
		const id = asString(turn?.id) ?? "unknown";
		const boundary = method === "turn/started" ? "started" : "completed";
		return `── turn ${boundary}: ${sanitizeTerminalText(id)} ──`;
	}
	if (method === "thread/goal/updated") {
		const goal = asRecord(body?.goal);
		const status = asString(goal?.status) ?? "unknown";
		const tokensUsed = asNumber(goal?.tokensUsed);
		return `── goal ${boundedSingleLine(status, 80)}${tokensUsed === undefined ? "" : ` · tokens=${tokensUsed}`} ──`;
	}

	if (method === "item/completed") {
		const item = asRecord(body?.item);
		const type = asString(item?.type);
		if (type === "agentMessage") {
			const text = asString(item?.text);
			return text === undefined ? undefined : sanitizeTerminalText(text);
		}
		if (type === "commandExecution") {
			const command = asString(item?.command) ?? "(unknown command)";
			const status = asString(item?.status) ?? "unknown";
			const exitCode = asNumber(item?.exitCode);
			return `[command ${boundedSingleLine(status, 80)}${exitCode === undefined ? "" : ` exit=${exitCode}`}] ${boundedSingleLine(command, UNKNOWN_EVENT_MAX_CHARS)}`;
		}
		if (type === "reasoning") {
			const summary = textParts(item?.summary).join(" ");
			return summary.length === 0
				? undefined
				: `[reasoning] ${boundedSingleLine(summary, UNKNOWN_EVENT_MAX_CHARS)}`;
		}
		if (type === "fileChange") {
			const status = asString(item?.status) ?? "unknown";
			const changes = asArray(item?.changes)
				.map((change) => {
					const row = asRecord(change);
					const path = asString(row?.path);
					if (!path) return undefined;
					const kind = asString(row?.kind) ?? "change";
					return `${boundedSingleLine(kind, 40)} ${boundedSingleLine(path, 300)}`;
				})
				.filter((change): change is string => change !== undefined)
				.join(", ");
			return `[files ${boundedSingleLine(status, 80)}] ${changes || "(details unavailable)"}`;
		}
	}

	return `[${boundedSingleLine(method, 100)}] ${boundedSingleLine(safeJson(params), UNKNOWN_EVENT_MAX_CHARS)}`;
}

export interface CodexTranscriptFsOps {
	appendFile(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	stat(path: string): Promise<{ size: number }>;
}

export interface CodexTranscriptSinkOptions {
	path: string;
	maxBytes?: number;
	maxQueuedBytes?: number;
	closeDeadlineMs?: number;
	fsOps?: CodexTranscriptFsOps;
	render?: typeof renderCodexNotification;
	log?: (message: string) => void;
}

export interface CodexTranscriptHeader {
	executionId: string;
	issueId?: string;
	label?: string;
	cwd: string;
	objective?: string;
	socketPath?: string;
}

const defaultFsOps: CodexTranscriptFsOps = {
	appendFile: async (path, data) => {
		await appendFileFs(path, data, "utf8");
	},
	mkdir: async (path) => {
		await mkdirFs(path, { recursive: true, mode: 0o700 });
	},
	rename: async (from, to) => {
		await renameFs(from, to);
	},
	stat: async (path) => statFs(path),
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notificationThreadId(params: unknown): string | undefined {
	const body = asRecord(params);
	return (
		asString(body?.threadId) ??
		asString(asRecord(body?.thread)?.id) ??
		asString(asRecord(body?.goal)?.threadId)
	);
}

const UNSCOPED_NOTIFICATION_ALLOWLIST = new Set(["thread/goal/updated"]);

export class CodexTranscriptSink {
	private readonly path: string;
	private readonly maxBytes: number;
	private readonly maxQueuedBytes: number;
	private readonly closeDeadlineMs: number;
	private readonly fsOps: CodexTranscriptFsOps;
	private readonly render: typeof renderCodexNotification;
	private readonly log?: (message: string) => void;
	private writeChain: Promise<void> = Promise.resolve();
	private queuedBytes = 0;
	private backpressureMarkerQueued = false;
	private directoryReady = false;
	private knownSize: number | undefined;
	private scopedThreadId: string | undefined;
	private preThreadMarkerWritten = false;
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: CodexTranscriptSinkOptions) {
		this.path = options.path;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
		this.closeDeadlineMs = options.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS;
		this.fsOps = options.fsOps ?? defaultFsOps;
		this.render = options.render ?? renderCodexNotification;
		this.log = options.log;
	}

	writeHeader(header: CodexTranscriptHeader): void {
		try {
			const identity = [header.issueId, header.label]
				.filter((part): part is string => Boolean(part))
				.map((part) => boundedSingleLine(part, 160))
				.join(" · ");
			const lines = [
				"── Codex runner observer ──",
				identity,
				`execution: ${boundedSingleLine(header.executionId, 160)}`,
				`working directory: ${boundedSingleLine(header.cwd, 500)}`,
				header.objective
					? `objective: ${boundedSingleLine(header.objective, 500)}`
					: "",
				header.socketPath
					? `socket: ${boundedSingleLine(header.socketPath, 500)}`
					: "",
				"",
			].filter((line, index) => line.length > 0 || index === 0);
			this.enqueue(`${lines.join("\n")}\n`);
		} catch (error) {
			this.safeLog(`transcript header failed: ${errorMessage(error)}`);
		}
	}

	appendMeta(line: string): void {
		try {
			this.enqueue(`── ${boundedSingleLine(line, 1_000)} ──\n`);
		} catch (error) {
			this.safeLog(`transcript metadata failed: ${errorMessage(error)}`);
		}
	}

	setThreadScope(threadId: string): void {
		try {
			this.scopedThreadId = threadId;
			this.appendMeta(`thread: ${threadId}`);
		} catch (error) {
			this.safeLog(`transcript thread scope failed: ${errorMessage(error)}`);
		}
	}

	onNotification(method: string, params: unknown): void {
		try {
			const threadId = notificationThreadId(params);
			const allowUnscoped =
				threadId === undefined && UNSCOPED_NOTIFICATION_ALLOWLIST.has(method);
			if (this.scopedThreadId === undefined && !allowUnscoped) {
				if (!this.preThreadMarkerWritten) {
					this.preThreadMarkerWritten = true;
					this.appendMeta("waiting for thread scope");
				}
				return;
			}
			if (!allowUnscoped && threadId !== this.scopedThreadId) return;

			const rendered = this.render(method, params);
			if (rendered !== undefined && rendered.length > 0) {
				this.enqueue(`${rendered}\n`);
			}
		} catch (error) {
			this.safeLog(`transcript render failed: ${errorMessage(error)}`);
		}
	}

	close(finalState?: string): Promise<void> {
		if (this.closePromise === undefined) {
			this.closePromise = this.closeOnce(finalState);
		}
		return this.closePromise;
	}

	private async closeOnce(finalState?: string): Promise<void> {
		if (finalState) this.appendMeta(`run ended: ${finalState}`);
		this.closed = true;

		let timer: ReturnType<typeof setTimeout> | undefined;
		const flushed = await Promise.race([
			this.writeChain.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), this.closeDeadlineMs);
			}),
		]);
		if (timer !== undefined) clearTimeout(timer);
		if (!flushed) {
			this.safeLog(
				`transcript close deadline exceeded after ${this.closeDeadlineMs}ms; output may be truncated`,
			);
		}
	}

	private enqueue(data: string, bypassBackpressure = false): void {
		if (this.closed || data.length === 0) return;
		const bytes = Buffer.byteLength(data, "utf8");
		if (!bypassBackpressure && this.queuedBytes + bytes > this.maxQueuedBytes) {
			if (!this.backpressureMarkerQueued) {
				this.backpressureMarkerQueued = true;
				this.enqueue(BACKPRESSURE_MARKER, true);
			}
			return;
		}

		this.queuedBytes += bytes;
		this.writeChain = this.writeChain.then(async () => {
			try {
				await this.writeChunk(data, bytes);
			} catch (error) {
				this.safeLog(`transcript append failed: ${errorMessage(error)}`);
			} finally {
				this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
				if (data === BACKPRESSURE_MARKER) {
					this.backpressureMarkerQueued = false;
				}
			}
		});
	}

	private async writeChunk(data: string, bytes: number): Promise<void> {
		if (!this.directoryReady) {
			await this.fsOps.mkdir(dirname(this.path));
			this.directoryReady = true;
		}
		if (this.knownSize === undefined) {
			try {
				this.knownSize = (await this.fsOps.stat(this.path)).size;
			} catch (error) {
				const code = asString(asRecord(error)?.code);
				if (code !== "ENOENT") throw error;
				this.knownSize = 0;
			}
		}
		if (this.knownSize > 0 && this.knownSize + bytes > this.maxBytes) {
			await this.fsOps.rename(this.path, `${this.path}.1`);
			this.knownSize = 0;
		}
		await this.fsOps.appendFile(this.path, data);
		this.knownSize += bytes;
	}

	private safeLog(message: string): void {
		try {
			this.log?.(message);
		} catch {
			// Observability must never affect runner execution.
		}
	}
}
