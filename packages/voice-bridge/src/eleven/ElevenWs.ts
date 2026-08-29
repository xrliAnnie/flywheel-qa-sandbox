/**
 * ElevenWs (FLY-1006 S6) — the ElevenLabs Agents WebSocket client for
 * /eleven: get-signed-url REST (key stays in-process, never argv/logs) →
 * WS → init frame → bidirectional codec.
 *
 * FLY-980 real-machine findings this client hard-codes:
 *   - custom_llm_extra_body.conversation_id is MANDATORY and unique — the
 *     platform sends no session identity by default, and without it the shim
 *     collapses every conversation into one bucket (v10 取证; Codex R1#5).
 *   - platform `ping` must be answered with `pong` (long sessions flake
 *     otherwise; e2e-session.mjs precedent).
 *   - conversation_initiation_metadata is a runtime gate: anything other
 *     than pcm_24000 out / pcm_16000 in means the upsample chain would
 *     garble — fail LOUD and close, never play noise (plan §S1 M2 硬门).
 *
 * Transport-injection convention (voice-core): fetch + the WS constructor
 * are injectable seams, so every behavior above is unit-tested offline.
 */

export interface WsLike {
	send(data: string): void;
	close(): void;
	on(event: string, cb: (...args: never[]) => void): void;
}

export interface ElevenOverrides {
	voiceId?: string;
	prompt?: string;
	firstMessage?: string;
	language?: string;
}

export interface ElevenMetadata {
	conversationId: string;
	agentOutputAudioFormat: string;
	userInputAudioFormat: string;
}

export interface ElevenWsOptions {
	agentId: string;
	/** xi-api-key — read from env by the caller; never logged here. */
	apiKey: string;
	/** REQUIRED non-empty unique id → custom_llm_extra_body (shim keying). */
	conversationId: string;
	overrides?: ElevenOverrides;
	/** inbound 16k s16le aggregation window before a user_audio_chunk
	 * (~100-250ms; default 150ms — one WS message per window, not per 20ms). */
	aggregateMs?: number;
	fetchImpl?: typeof fetch;
	wsFactory?: (signedUrl: string) => WsLike;
	log?: (line: string) => void;
	onAudio: (chunk: Buffer) => void;
	onInterruption: () => void;
	onUserTranscript?: (text: string) => void;
	onAgentResponse?: (text: string) => void;
	onMetadata?: (meta: ElevenMetadata) => void;
	onError: (err: Error) => void;
	onClose?: (code: number) => void;
}

const API_BASE = "https://api.elevenlabs.io";
const DEFAULT_AGGREGATE_MS = 150;
const BYTES_PER_MS_16K_S16LE = 32;
const EXPECTED_OUT_FORMAT = "pcm_24000";
const EXPECTED_IN_FORMAT = "pcm_16000";

export class ElevenWs {
	private ws: WsLike | null = null;
	private closed = false;
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private readonly flushBytes: number;

	constructor(private readonly opts: ElevenWsOptions) {
		if (!opts.conversationId || !opts.conversationId.trim()) {
			throw new Error(
				"ElevenWs: conversationId must be a non-empty unique id — without it the custom-LLM shim collapses sessions into one bucket (FLY-980 v10)",
			);
		}
		this.flushBytes =
			(opts.aggregateMs ?? DEFAULT_AGGREGATE_MS) * BYTES_PER_MS_16K_S16LE;
	}

	async connect(): Promise<void> {
		const fetchImpl = this.opts.fetchImpl ?? fetch;
		const res = await fetchImpl(
			`${API_BASE}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(this.opts.agentId)}`,
			{ headers: { "xi-api-key": this.opts.apiKey } },
		);
		const body = (await res.json().catch(() => ({}))) as {
			signed_url?: string;
		};
		if (!res.ok || !body.signed_url) {
			// key 绝不进错误文本
			throw new Error(`ElevenWs: get-signed-url failed (${res.status})`);
		}
		const wsFactory = this.opts.wsFactory ?? defaultWsFactory;
		const ws = wsFactory(body.signed_url);
		this.ws = ws;
		ws.on("message", ((raw: Buffer) => this.onMessage(raw)) as never);
		ws.on("error", ((err: Error) =>
			this.opts.onError(
				err instanceof Error ? err : new Error(String(err)),
			)) as never);
		ws.on("close", ((code: number) => {
			this.closed = true;
			this.opts.onClose?.(code ?? 0);
		}) as never);
		// pre-open error/close must REJECT, not just fire callbacks — the
		// /eleven command holds the shared VC slot while awaiting this promise,
		// so a forever-pending connect wedges the room (Codex code review R1).
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				fn();
			};
			ws.on("open", (() => settle(resolve)) as never);
			ws.on("error", ((err: Error) =>
				settle(() =>
					reject(
						new Error(
							`ElevenWs: websocket failed before open (${String((err as Error)?.message ?? err)})`,
						),
					),
				)) as never);
			ws.on("close", ((code: number) =>
				settle(() =>
					reject(
						new Error(
							`ElevenWs: websocket closed before open (code ${code ?? 0})`,
						),
					),
				)) as never);
		});
		ws.send(JSON.stringify(this.initFrame()));
	}

	private initFrame(): Record<string, unknown> {
		const o = this.opts.overrides;
		const override: Record<string, unknown> = {};
		if (o?.voiceId) override.tts = { voice_id: o.voiceId };
		const agent: Record<string, unknown> = {};
		if (o?.prompt) agent.prompt = { prompt: o.prompt };
		if (o?.firstMessage) agent.first_message = o.firstMessage;
		if (o?.language) agent.language = o.language;
		if (Object.keys(agent).length > 0) override.agent = agent;
		return {
			type: "conversation_initiation_client_data",
			...(Object.keys(override).length > 0
				? { conversation_config_override: override }
				: {}),
			custom_llm_extra_body: { conversation_id: this.opts.conversationId },
		};
	}

	private onMessage(raw: Buffer): void {
		if (this.closed) return;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		switch (msg.type) {
			case "ping": {
				const ev = msg.ping_event as { event_id?: number } | undefined;
				this.ws?.send(JSON.stringify({ type: "pong", event_id: ev?.event_id }));
				return;
			}
			case "audio": {
				const b64 = (msg.audio_event as { audio_base_64?: string })
					?.audio_base_64;
				if (b64) this.opts.onAudio(Buffer.from(b64, "base64"));
				return;
			}
			case "interruption":
				this.opts.onInterruption();
				return;
			case "user_transcript":
				this.opts.onUserTranscript?.(
					(msg.user_transcription_event as { user_transcript?: string })
						?.user_transcript ?? "",
				);
				return;
			case "agent_response":
				this.opts.onAgentResponse?.(
					(msg.agent_response_event as { agent_response?: string })
						?.agent_response ?? "",
				);
				return;
			case "conversation_initiation_metadata": {
				const meta = msg.conversation_initiation_metadata_event as {
					conversation_id?: string;
					agent_output_audio_format?: string;
					user_input_audio_format?: string;
				};
				const out = meta?.agent_output_audio_format ?? "(missing)";
				const inn = meta?.user_input_audio_format ?? "(missing)";
				if (out !== EXPECTED_OUT_FORMAT || inn !== EXPECTED_IN_FORMAT) {
					// the upsample chain assumes 24k out / 16k in — playing anything
					// else is garbled noise. Fail LOUD and stop (plan M2 硬门).
					this.opts.onError(
						new Error(
							`ElevenWs: agent audio formats are ${out}/${inn}, expected ${EXPECTED_OUT_FORMAT}/${EXPECTED_IN_FORMAT} — re-run the agent PATCH runbook (m1-rig.md)`,
						),
					);
					this.close();
					return;
				}
				this.opts.onMetadata?.({
					conversationId: meta?.conversation_id ?? "",
					agentOutputAudioFormat: out,
					userInputAudioFormat: inn,
				});
				return;
			}
			default:
				return;
		}
	}

	/** inbound 16k s16le mono frames (EarsReceiver) — aggregated to one WS
	 * message per ~aggregateMs window. */
	sendAudio(frame16k: Buffer): void {
		if (this.closed || !this.ws) return;
		this.pending.push(frame16k);
		this.pendingBytes += frame16k.length;
		if (this.pendingBytes >= this.flushBytes) this.flushAudio();
	}

	/** flush the aggregation remainder (call on speaking-end so the tail of
	 * an utterance never sits in the buffer). */
	flushAudio(): void {
		if (this.closed || !this.ws || this.pendingBytes === 0) return;
		const chunk = Buffer.concat(this.pending, this.pendingBytes);
		this.pending = [];
		this.pendingBytes = 0;
		this.ws.send(
			JSON.stringify({ user_audio_chunk: chunk.toString("base64") }),
		);
	}

	/** idempotent: safe on every teardown path. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.pending = [];
		this.pendingBytes = 0;
		this.ws?.close();
	}
}

/** Node ≥22 built-in WebSocket (undici) adapted to the injectable WsLike
 * shape — no extra dependency; unit tests always inject their own factory. */
function defaultWsFactory(url: string): WsLike {
	const sock = new WebSocket(url);
	sock.binaryType = "arraybuffer";
	return {
		send: (data) => sock.send(data),
		close: () => sock.close(),
		on: (event, cb) => {
			if (event === "open") {
				sock.addEventListener("open", () => (cb as () => void)());
			} else if (event === "message") {
				sock.addEventListener("message", (ev) =>
					(cb as (b: Buffer) => void)(
						typeof ev.data === "string"
							? Buffer.from(ev.data)
							: Buffer.from(new Uint8Array(ev.data as ArrayBuffer)),
					),
				);
			} else if (event === "close") {
				sock.addEventListener("close", (ev) =>
					(cb as (code: number) => void)(
						(ev as unknown as { code?: number }).code ?? 0,
					),
				);
			} else if (event === "error") {
				sock.addEventListener("error", () =>
					(cb as (e: Error) => void)(new Error("ElevenWs: websocket error")),
				);
			}
		},
	};
}
