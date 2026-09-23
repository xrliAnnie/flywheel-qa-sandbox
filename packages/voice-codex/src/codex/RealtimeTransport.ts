export const CODEX_REALTIME_INPUT_QUEUE_BYTES = 48_000;
export const CODEX_REALTIME_MAX_INPUT_FRAME_BYTES = 4_800;
const CODEX_REALTIME_START_TIMEOUT_MS = 60_000;
const CODEX_REALTIME_CLOSE_TIMEOUT_MS = 5_000;

export interface CodexRealtimeRpc {
	on(
		event: "notification" | "exit",
		callback:
			| ((method: string, params: unknown) => void)
			| ((code: number | null, signal: NodeJS.Signals | null) => void),
	): void;
	request(
		method: string,
		params?: unknown,
	): Promise<{
		result?: unknown;
		error?: { code: number; message: string; data?: unknown };
	}>;
}

export interface CodexRealtimeInputOwner {
	utteranceId: string | null;
	ownerUserId: string | null;
	ownerName?: string | null;
}

export type CodexRealtimeAppendOutcome =
	| "sent"
	| "sent:need-drain"
	| "dropped:backpressure"
	| "dropped:stale-generation"
	| "dropped:closed";

export interface CodexRealtimeAudioDelta {
	generation: number;
	itemId: string;
	pcm24Mono: Buffer;
	sampleRate: 24_000;
	numChannels: 1;
	samplesPerChannel: number | null;
	raw: Record<string, unknown>;
}

export interface CodexRealtimeTranscript {
	generation: number;
	itemId?: string;
	association: "preceding_item" | "unattributed";
	role: "assistant" | "user";
	text: string;
	final: boolean;
	/** Present only when one gap-free RoomIO owner is bound to this provider item. */
	inputOwner?: CodexRealtimeInputOwner;
	raw: Record<string, unknown>;
}

export interface CodexRealtimeItem {
	generation: number;
	itemId: string;
	role: "assistant" | "user";
	status?: string;
	raw: Record<string, unknown>;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(code)), timeoutMs);
		timer.unref?.();
	});
	return Promise.race([promise, expiry]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function rpcError(
	method: string,
	response: { error?: { code: number; message: string } },
): void {
	if (response.error) {
		throw new Error(`${method}: ${response.error.message}`);
	}
}

function decodeCanonicalBase64(value: unknown): Buffer | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0)
		return undefined;
	const decoded = Buffer.from(value, "base64");
	return decoded.toString("base64") === value ? decoded : undefined;
}

type State = "idle" | "opening" | "active" | "fenced" | "closed";

interface InputOwnership {
	owner?: CodexRealtimeInputOwner;
	valid: boolean;
	sawAudio: boolean;
}

function freshInputOwnership(): InputOwnership {
	return { valid: true, sawAudio: false };
}

function sameOwner(
	left: CodexRealtimeInputOwner,
	right: CodexRealtimeInputOwner,
): boolean {
	return (
		left.utteranceId === right.utteranceId &&
		left.ownerUserId === right.ownerUserId
	);
}

/**
 * A generation-fenced adapter over the Codex 0.156.1 V2 realtime RPCs.
 *
 * It deliberately exposes raw server fields together with any inferred item
 * association. V2 transcript notifications do not carry an item id, so a
 * preceding itemAdded association is useful ordering evidence but is not a
 * verbatim proof.
 */
export class CodexRealtimeTransport {
	private state: State = "idle";
	private started?: Deferred<void>;
	private closed?: Deferred<void>;
	private cancelPromise?: Promise<void>;
	private pendingAudioBytes = 0;
	private audioTail: Promise<void> = Promise.resolve();
	private readonly lastItemByRole = new Map<string, string>();
	private inputOwnership = freshInputOwnership();
	private activeInputItemId?: string;
	private readonly inputOwnershipByItem = new Map<string, InputOwnership>();
	private closedReported = false;

	constructor(
		private readonly options: {
			rpc: CodexRealtimeRpc;
			sessionId: string;
			threadId: string;
			generation: number;
			start: Record<string, unknown>;
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
			onClosed?(input: { generation: number; reason: string }): void;
			onError?(error: Error): void;
			startTimeoutMs?: number;
			closeTimeoutMs?: number;
		},
	) {
		if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
			throw new Error("realtime_generation_invalid");
		}
		options.rpc.on("notification", (method: string, params: unknown) =>
			this.notification(method, params),
		);
		options.rpc.on(
			"exit",
			(code: number | null, signal: NodeJS.Signals | null) =>
				this.processExit(code, signal),
		);
	}

	get generation(): number {
		return this.options.generation;
	}

	async start(): Promise<void> {
		if (this.state !== "idle") throw new Error("realtime_start_state");
		this.state = "opening";
		this.started = deferred<void>();
		try {
			const rpc = this.options.rpc
				.request("thread/realtime/start", {
					...this.options.start,
					threadId: this.options.threadId,
					version: "v2",
				})
				.then((response) => rpcError("thread/realtime/start", response));
			await withTimeout(
				Promise.all([rpc, this.started.promise]).then(() => undefined),
				this.options.startTimeoutMs ?? CODEX_REALTIME_START_TIMEOUT_MS,
				"realtime_start_timeout",
			);
			if (this.state !== "opening") throw new Error("realtime_start_closed");
			this.state = "active";
		} catch (error) {
			this.state = "fenced";
			throw error;
		}
	}

	appendAudio(
		frame: Buffer,
		generation: number,
		owner: CodexRealtimeInputOwner,
	): CodexRealtimeAppendOutcome {
		if (generation !== this.options.generation)
			return "dropped:stale-generation";
		if (this.state !== "active") return "dropped:closed";
		if (
			frame.length === 0 ||
			frame.length > CODEX_REALTIME_MAX_INPUT_FRAME_BYTES ||
			frame.length % 2 !== 0
		) {
			throw new Error("realtime_audio_frame_invalid");
		}
		if (
			this.pendingAudioBytes + frame.length >
			CODEX_REALTIME_INPUT_QUEUE_BYTES
		) {
			this.inputOwnership.valid = false;
			this.options.onInputGap?.({
				generation,
				...owner,
				droppedBytes: frame.length,
				reason: "backpressure",
			});
			return "dropped:backpressure";
		}

		this.observeInputOwner(owner);
		this.pendingAudioBytes += frame.length;
		const ownership = this.inputOwnership;
		const data = frame.toString("base64");
		const send = this.audioTail.then(async () => {
			if (this.state !== "active") return;
			const response = await this.options.rpc.request(
				"thread/realtime/appendAudio",
				{
					threadId: this.options.threadId,
					audio: {
						data,
						sampleRate: 24_000,
						numChannels: 1,
						samplesPerChannel: frame.length / 2,
					},
				},
			);
			rpcError("thread/realtime/appendAudio", response);
		});
		this.audioTail = send
			.catch((error: unknown) => {
				ownership.valid = false;
				this.options.onInputGap?.({
					generation,
					...owner,
					droppedBytes: frame.length,
					reason: "rpc_error",
				});
				this.options.onError?.(
					error instanceof Error ? error : new Error(String(error)),
				);
			})
			.finally(() => {
				this.pendingAudioBytes -= frame.length;
			});
		return this.pendingAudioBytes >=
			CODEX_REALTIME_INPUT_QUEUE_BYTES - CODEX_REALTIME_MAX_INPUT_FRAME_BYTES
			? "sent:need-drain"
			: "sent";
	}

	invalidateInputOwnership(): void {
		this.inputOwnership.valid = false;
	}

	async appendText(
		text: string,
		role: "developer" | "user",
		generation: number,
	): Promise<void> {
		this.assertCurrent(generation);
		if (!text || Buffer.byteLength(text, "utf8") > 128 * 1024) {
			throw new Error("realtime_text_invalid");
		}
		const response = await this.options.rpc.request(
			"thread/realtime/appendText",
			{ threadId: this.options.threadId, text, role },
		);
		rpcError("thread/realtime/appendText", response);
		this.assertCurrent(generation);
	}

	async appendSpeech(text: string, generation: number): Promise<void> {
		this.assertCurrent(generation);
		if (!text || Buffer.byteLength(text, "utf8") > 32 * 1024) {
			throw new Error("realtime_speech_invalid");
		}
		const response = await this.options.rpc.request(
			"thread/realtime/appendSpeech",
			{ threadId: this.options.threadId, text },
		);
		rpcError("thread/realtime/appendSpeech", response);
		this.assertCurrent(generation);
	}

	drain(): Promise<void> {
		return this.audioTail;
	}

	cancel(): Promise<void> {
		this.cancelPromise ??= this.cancelOnce();
		return this.cancelPromise;
	}

	private async cancelOnce(): Promise<void> {
		if (this.state === "closed") return;
		this.state = "fenced";
		this.closed = deferred<void>();
		const stop = this.options.rpc
			.request("thread/realtime/stop", { threadId: this.options.threadId })
			.then((response) => rpcError("thread/realtime/stop", response));
		await withTimeout(
			Promise.all([stop, this.closed.promise]).then(() => undefined),
			this.options.closeTimeoutMs ?? CODEX_REALTIME_CLOSE_TIMEOUT_MS,
			"realtime_close_timeout",
		);
	}

	private assertCurrent(generation: number): void {
		if (generation !== this.options.generation) {
			throw new Error("realtime_stale_generation");
		}
		if (this.state !== "active") throw new Error("realtime_closed");
	}

	private notification(method: string, value: unknown): void {
		const params = record(value);
		if (!params || params.threadId !== this.options.threadId) return;

		if (method === "thread/realtime/started") {
			if (this.state !== "opening" || !this.started) return;
			if (params.version !== "v2") {
				this.started.reject(new Error("realtime_version_mismatch"));
				return;
			}
			if (
				typeof params.realtimeSessionId !== "string" ||
				params.realtimeSessionId.length === 0
			) {
				this.started.reject(new Error("realtime_started_invalid"));
				return;
			}
			this.started.resolve();
			return;
		}

		if (method === "thread/realtime/closed") {
			const reason =
				typeof params.reason === "string" ? params.reason : "realtime_closed";
			const wasOpening = this.state === "opening";
			this.state = "closed";
			if (wasOpening) this.started?.reject(new Error(reason));
			this.closed?.resolve();
			this.reportClosed(reason);
			return;
		}

		if (this.state !== "active") return;
		if (method === "thread/realtime/itemAdded") {
			const item = record(params.item);
			if (
				item?.type === "input_audio_buffer.speech_started" &&
				typeof item.item_id === "string" &&
				item.item_id.length > 0
			) {
				this.activeInputItemId = item.item_id;
				this.inputOwnershipByItem.set(item.item_id, this.inputOwnership);
				return;
			}
			if (
				item &&
				typeof item.id === "string" &&
				(item.role === "assistant" || item.role === "user")
			) {
				this.lastItemByRole.set(item.role, item.id);
				if (item.role === "user" && item.status === "completed") {
					if (this.activeInputItemId === item.id) {
						this.inputOwnershipByItem.set(item.id, this.inputOwnership);
					} else {
						this.inputOwnershipByItem.delete(item.id);
					}
					this.inputOwnership = freshInputOwnership();
					this.activeInputItemId = undefined;
				}
				this.options.onItem?.({
					generation: this.options.generation,
					itemId: item.id,
					role: item.role,
					...(typeof item.status === "string" ? { status: item.status } : {}),
					raw: item,
				});
			}
			return;
		}
		if (method === "thread/realtime/outputAudio/delta") {
			this.outputAudio(params);
			return;
		}
		if (
			method === "thread/realtime/transcript/delta" ||
			method === "thread/realtime/transcript/done"
		) {
			this.outputTranscript(params, method.endsWith("/done"));
			return;
		}
		if (
			method === "turn/started" ||
			method.includes("commandExecution") ||
			method.includes("mcpToolCall")
		) {
			this.state = "fenced";
			this.options.onCapabilityViolation?.({
				generation: this.options.generation,
				method,
				params: value,
			});
			return;
		}
		if (method === "thread/realtime/error") {
			this.state = "fenced";
			this.options.onError?.(new Error("realtime_server_error"));
		}
	}

	private outputAudio(params: Record<string, unknown>): void {
		const audio = record(params.audio);
		const pcm = decodeCanonicalBase64(audio?.data);
		if (
			!audio ||
			!pcm ||
			pcm.length === 0 ||
			pcm.length % 2 !== 0 ||
			audio.sampleRate !== 24_000 ||
			audio.numChannels !== 1 ||
			typeof audio.itemId !== "string" ||
			audio.itemId.length === 0 ||
			!(
				audio.samplesPerChannel === null ||
				typeof audio.samplesPerChannel === "number"
			)
		) {
			this.state = "fenced";
			this.options.onError?.(new Error("realtime_output_audio_invalid"));
			return;
		}
		this.options.onAudio?.({
			generation: this.options.generation,
			itemId: audio.itemId,
			pcm24Mono: pcm,
			sampleRate: 24_000,
			numChannels: 1,
			samplesPerChannel: audio.samplesPerChannel,
			raw: params,
		});
	}

	private outputTranscript(
		params: Record<string, unknown>,
		final: boolean,
	): void {
		const role = params.role;
		const text = final ? params.text : params.delta;
		if (
			(role !== "assistant" && role !== "user") ||
			typeof text !== "string" ||
			text.length === 0
		) {
			this.state = "fenced";
			this.options.onError?.(new Error("realtime_transcript_invalid"));
			return;
		}
		const itemId = this.lastItemByRole.get(role);
		const ownership =
			role === "user" && itemId
				? this.inputOwnershipByItem.get(itemId)
				: undefined;
		const inputOwner =
			ownership?.valid === true && ownership.sawAudio
				? ownership.owner
				: undefined;
		this.options.onTranscript?.({
			generation: this.options.generation,
			...(itemId ? { itemId } : {}),
			association: itemId ? "preceding_item" : "unattributed",
			role,
			text,
			final,
			...(inputOwner ? { inputOwner: { ...inputOwner } } : {}),
			raw: params,
		});
		if (final && role === "user" && itemId)
			this.inputOwnershipByItem.delete(itemId);
	}

	private observeInputOwner(owner: CodexRealtimeInputOwner): void {
		const ownership = this.inputOwnership;
		ownership.sawAudio = true;
		if (!owner.utteranceId || !owner.ownerUserId) {
			ownership.valid = false;
			return;
		}
		if (!ownership.owner) {
			ownership.owner = { ...owner };
			return;
		}
		if (!sameOwner(ownership.owner, owner)) ownership.valid = false;
	}

	private processExit(
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		const reason = [
			"process_exit",
			code === null ? "null" : String(code),
			signal ?? "none",
		].join(":");
		this.state = "closed";
		this.started?.reject(new Error(reason));
		this.closed?.reject(new Error(reason));
		this.reportClosed(reason);
	}

	private reportClosed(reason: string): void {
		if (this.closedReported) return;
		this.closedReported = true;
		this.options.onClosed?.({
			generation: this.options.generation,
			reason,
		});
	}
}
