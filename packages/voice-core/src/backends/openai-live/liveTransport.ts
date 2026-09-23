import WebSocket from "ws";
import { VoiceError } from "../../types.js";
import type { OpenAiLiveSocket } from "./LiveSession.js";
import type { OpenAiLiveClientEvent } from "./liveProtocol.js";

export interface OpenAiLiveWebSocketOptions {
	headers: { Authorization: string };
}

export interface OpenAiLiveWebSocket {
	readyState: number;
	send(data: string): void;
	close(): void;
	on(event: string | symbol, listener: (...args: any[]) => void): this;
	off(event: string | symbol, listener: (...args: any[]) => void): this;
}

export type OpenAiLiveWebSocketFactory = (
	endpoint: string,
	options: OpenAiLiveWebSocketOptions,
) => OpenAiLiveWebSocket;

export interface OpenAiLiveTransportOptions {
	endpoint: string;
	apiKey: string;
	connectTimeoutMs?: number;
	webSocketFactory?: OpenAiLiveWebSocketFactory;
}

function unavailable(message: string, cause?: unknown): VoiceError {
	return new VoiceError(
		"connection-closed",
		`语音不可用: OpenAI Live ${message}`,
		cause,
	);
}

function normalizeMessage(raw: unknown): string | Buffer {
	if (typeof raw === "string" || Buffer.isBuffer(raw)) return raw;
	if (raw instanceof ArrayBuffer) return Buffer.from(raw);
	if (ArrayBuffer.isView(raw)) {
		return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
	}
	if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
		return Buffer.concat(raw);
	}
	throw new VoiceError(
		"backend-protocol",
		"openai-live: unsupported WebSocket message type",
	);
}

class JsonLiveSocket implements OpenAiLiveSocket {
	private readonly messageHandlers = new Set<(raw: string | Buffer) => void>();
	private readonly closeHandlers = new Set<(error?: Error) => void>();
	private readonly errorHandlers = new Set<(error: Error) => void>();
	private terminalError?: Error;
	private terminalClosed = false;

	constructor(private readonly raw: OpenAiLiveWebSocket) {
		raw.on("message", (data: unknown) => {
			try {
				const normalized = normalizeMessage(data);
				for (const handler of [...this.messageHandlers]) handler(normalized);
			} catch (error) {
				this.dispatchError(error as Error);
			}
		});
		raw.on("error", (error: Error) => this.dispatchError(error));
		raw.on("close", (code?: number, reason?: Buffer) => {
			this.terminalClosed = true;
			const detail =
				code === undefined
					? undefined
					: new Error(
							`WebSocket closed (${code}${reason?.length ? `: ${reason.toString()}` : ""})`,
						);
			this.terminalError ??= detail;
			for (const handler of [...this.closeHandlers]) handler(detail);
		});
	}

	send(event: OpenAiLiveClientEvent): void {
		if (this.raw.readyState !== WebSocket.OPEN) {
			throw unavailable("socket is not open");
		}
		this.raw.send(JSON.stringify(event));
	}

	onMessage(handler: (raw: string | Buffer) => void): () => void {
		this.messageHandlers.add(handler);
		return () => this.messageHandlers.delete(handler);
	}

	onClose(handler: (error?: Error) => void): () => void {
		this.closeHandlers.add(handler);
		if (this.terminalClosed) queueMicrotask(() => handler(this.terminalError));
		return () => this.closeHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.errorHandlers.add(handler);
		if (this.terminalError)
			queueMicrotask(() => handler(this.terminalError as Error));
		return () => this.errorHandlers.delete(handler);
	}

	close(): void {
		this.raw.close();
	}

	private dispatchError(error: Error): void {
		this.terminalError = error;
		for (const handler of [...this.errorHandlers]) handler(error);
	}
}

export class OpenAiLiveTransport {
	constructor(private readonly opts: OpenAiLiveTransportOptions) {}

	connect(): Promise<OpenAiLiveSocket> {
		if (!this.opts.apiKey.trim()) {
			return Promise.reject(unavailable("API key is not configured"));
		}
		try {
			const endpoint = new URL(this.opts.endpoint);
			if (
				endpoint.protocol !== "wss:" ||
				endpoint.hostname !== "api.openai.com" ||
				endpoint.username ||
				endpoint.password
			) {
				throw new Error("outside allowlist");
			}
		} catch {
			return Promise.reject(
				unavailable("endpoint is outside the TLS allowlist"),
			);
		}
		const factory =
			this.opts.webSocketFactory ??
			((endpoint: string, options: OpenAiLiveWebSocketOptions) =>
				new WebSocket(endpoint, options));
		let raw: OpenAiLiveWebSocket;
		try {
			raw = factory(this.opts.endpoint, {
				headers: { Authorization: `Bearer ${this.opts.apiKey}` },
			});
		} catch (error) {
			return Promise.reject(unavailable("connection failed", error));
		}
		const socket = new JsonLiveSocket(raw);
		return new Promise<OpenAiLiveSocket>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				raw.off("open", onOpen);
				raw.off("error", onError);
				raw.off("close", onClose);
				fn();
			};
			const onOpen = (): void => finish(() => resolve(socket));
			const onError = (error: Error): void =>
				finish(() => {
					raw.close();
					reject(unavailable(`admission failed (${error.message})`, error));
				});
			const onClose = (code?: number): void =>
				finish(() =>
					reject(unavailable(`admission closed${code ? ` (${code})` : ""}`)),
				);
			const timer = setTimeout(
				() =>
					finish(() => {
						raw.close();
						reject(unavailable("admission timed out"));
					}),
				this.opts.connectTimeoutMs ?? 10_000,
			);
			raw.on("open", onOpen);
			raw.on("error", onError);
			raw.on("close", onClose);
		});
	}
}
