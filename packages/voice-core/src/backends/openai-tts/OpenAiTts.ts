import {
	type AudioFormat,
	type StreamingTtsChunk,
	type StreamingTtsEngine,
	toVoiceSpec,
	VoiceError,
	type VoiceRef,
} from "../../types.js";

export const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_OPENAI_TTS_ENDPOINT =
	"https://api.openai.com/v1/audio/speech";
/** Stable identifier recorded in announcer events (plan §7 QA: ttsEngine). */
export const OPENAI_TTS_BACKEND_ID = "openai-tts";

const PCM24: AudioFormat = {
	encoding: "pcm16",
	sampleRateHz: 24_000,
	channels: 1,
};

export interface OpenAiTtsOptions {
	apiKey: string;
	model?: string;
	endpoint?: string;
	/** Bound on waiting for the response headers (and between body chunks). */
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

/** OpenAI endpoints only: the credential never leaves the TLS allowlist. */
export function assertOpenAiTtsEndpoint(endpoint: string): void {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new VoiceError(
			"component-missing",
			"语音不可用: GPT voice endpoint is outside the TLS allowlist",
		);
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "api.openai.com" ||
		url.username ||
		url.password
	)
		throw new VoiceError(
			"component-missing",
			"语音不可用: GPT voice endpoint is outside the TLS allowlist",
		);
}

/**
 * FLY-2863 §5.2: deterministic announcer in the Lead's own GPT voice. The
 * text sent is exactly the text spoken (`contentProof=deterministic_tts`);
 * PCM 24kHz mono needs no decoder. There is no fallback to a synthetic voice:
 * a failure surfaces as "voice unavailable".
 */
export class OpenAiTts implements StreamingTtsEngine {
	private readonly model: string;
	private readonly endpoint: string;
	private readonly timeoutMs: number;

	constructor(private readonly options: OpenAiTtsOptions) {
		if (!options.apiKey)
			throw new VoiceError(
				"component-missing",
				"语音不可用: GPT voice credential is not set",
			);
		this.model = options.model || DEFAULT_OPENAI_TTS_MODEL;
		this.endpoint = options.endpoint || DEFAULT_OPENAI_TTS_ENDPOINT;
		assertOpenAiTtsEndpoint(this.endpoint);
		this.timeoutMs = options.timeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
			throw new VoiceError(
				"component-missing",
				"语音不可用: GPT voice timeout must be a positive integer",
			);
	}

	async synthesize(
		text: string,
		voice: VoiceRef,
		opts: { signal: AbortSignal },
	): Promise<{ audio: Buffer; format: AudioFormat; ttsFirstByteMs: number }> {
		const chunks: Buffer[] = [];
		let ttsFirstByteMs = 0;
		for await (const chunk of this.synthesizeStream(text, voice, opts)) {
			if (chunk.ttsFirstByteMs !== undefined)
				ttsFirstByteMs = chunk.ttsFirstByteMs;
			chunks.push(chunk.audio);
		}
		return { audio: Buffer.concat(chunks), format: PCM24, ttsFirstByteMs };
	}

	async *synthesizeStream(
		text: string,
		voice: VoiceRef,
		opts: { signal: AbortSignal },
	): AsyncIterable<StreamingTtsChunk> {
		const voiceId = toVoiceSpec(voice).voiceId;
		if (!text.trim())
			throw new VoiceError("unsupported", "openai-tts: empty text");
		if (!voiceId)
			throw new VoiceError(
				"component-missing",
				"语音不可用: GPT voice not set",
			);
		const now = this.options.now ?? Date.now;
		const startedAt = now();
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (opts.signal.aborted) abort();
		opts.signal.addEventListener("abort", abort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const arm = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timedOut = true;
				abort();
			}, this.timeoutMs);
			timer.unref?.();
		};
		try {
			arm();
			let response: Response;
			try {
				response = await (this.options.fetchImpl ?? fetch)(this.endpoint, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.options.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: this.model,
						input: text,
						voice: voiceId,
						response_format: "pcm",
					}),
					signal: controller.signal,
				});
			} catch (error) {
				throw this.failure(opts.signal, timedOut, error, "request failed");
			}
			if (!response.ok || !response.body) {
				// Never echo the provider body: it may carry account details.
				throw new VoiceError(
					"subprocess-failed",
					`语音不可用: GPT voice HTTP ${response.status}`,
				);
			}
			const reader = response.body.getReader();
			let carry: Buffer | undefined;
			let first = true;
			try {
				for (;;) {
					arm();
					let step: Awaited<ReturnType<typeof reader.read>>;
					try {
						step = await reader.read();
					} catch (error) {
						throw this.failure(opts.signal, timedOut, error, "stream failed");
					}
					if (step.done) break;
					let bytes = Buffer.from(step.value);
					if (carry) {
						bytes = Buffer.concat([carry, bytes]);
						carry = undefined;
					}
					// PCM16 frames are two bytes; keep an odd tail for the next read.
					if (bytes.length % 2 === 1) {
						carry = bytes.subarray(bytes.length - 1);
						bytes = bytes.subarray(0, bytes.length - 1);
					}
					if (bytes.length === 0) continue;
					yield {
						audio: bytes,
						format: PCM24,
						...(first ? { ttsFirstByteMs: now() - startedAt } : {}),
					};
					first = false;
				}
			} finally {
				reader.releaseLock();
			}
			if (first)
				throw new VoiceError(
					"backend-protocol",
					"语音不可用: GPT voice returned no audio",
				);
		} finally {
			if (timer) clearTimeout(timer);
			opts.signal.removeEventListener("abort", abort);
		}
	}

	private failure(
		signal: AbortSignal,
		timedOut: boolean,
		error: unknown,
		what: string,
	): VoiceError {
		if (signal.aborted)
			return new VoiceError("cancelled", "openai-tts: cancelled", error);
		return new VoiceError(
			timedOut ? "timeout" : "subprocess-failed",
			`语音不可用: GPT voice ${timedOut ? "timed out" : what}`,
			error instanceof Error ? error.name : undefined,
		);
	}
}
