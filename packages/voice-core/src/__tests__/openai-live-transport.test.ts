import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	OpenAiLiveTransport,
	type OpenAiLiveWebSocket,
	type OpenAiLiveWebSocketOptions,
} from "../backends/openai-live/liveTransport.js";

class FakeWebSocket extends EventEmitter implements OpenAiLiveWebSocket {
	readyState = 0;
	readonly sent: string[] = [];
	closed = false;

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
		this.readyState = 3;
	}

	open(): void {
		this.readyState = 1;
		this.emit("open");
	}
}

describe("OpenAiLiveTransport", () => {
	it("authenticates the configured endpoint and exposes a JSON event socket", async () => {
		const raw = new FakeWebSocket();
		let connected:
			| { endpoint: string; options: OpenAiLiveWebSocketOptions }
			| undefined;
		const transport = new OpenAiLiveTransport({
			endpoint: "wss://api.openai.com/v1/live/sessions",
			apiKey: "test-secret",
			webSocketFactory: (endpoint, options) => {
				connected = { endpoint, options };
				return raw;
			},
		});

		const opening = transport.connect();
		raw.open();
		const socket = await opening;
		expect(connected).toEqual({
			endpoint: "wss://api.openai.com/v1/live/sessions",
			options: { headers: { Authorization: "Bearer test-secret" } },
		});

		const messages: Array<string | Buffer> = [];
		socket.onMessage((message) => messages.push(message));
		socket.send({ type: "session.close", event_id: "evt-1" });
		raw.emit("message", Buffer.from('{"type":"session.closed"}'));
		expect(raw.sent).toEqual([
			JSON.stringify({ type: "session.close", event_id: "evt-1" }),
		]);
		expect(messages).toEqual([Buffer.from('{"type":"session.closed"}')]);
	});

	it("fails closed as voice unavailable when credentials or admission fail", async () => {
		await expect(
			new OpenAiLiveTransport({
				endpoint: "wss://api.openai.com/v1/live/sessions",
				apiKey: "",
				webSocketFactory: () => new FakeWebSocket(),
			}).connect(),
		).rejects.toThrow(/语音不可用.*API key/);
		let insecureFactoryCalled = false;
		await expect(
			new OpenAiLiveTransport({
				endpoint: "ws://attacker.invalid/live",
				apiKey: "test-secret",
				webSocketFactory: () => {
					insecureFactoryCalled = true;
					throw new Error("must not connect");
				},
			}).connect(),
		).rejects.toThrow(/语音不可用.*TLS allowlist/);
		expect(insecureFactoryCalled).toBe(false);

		const raw = new FakeWebSocket();
		const opening = new OpenAiLiveTransport({
			endpoint: "wss://api.openai.com/v1/live/sessions",
			apiKey: "test-secret",
			webSocketFactory: () => raw,
		}).connect();
		raw.emit("error", new Error("401 Unauthorized"));
		await expect(opening).rejects.toThrow(/语音不可用.*401 Unauthorized/);
		expect(raw.closed).toBe(true);
	});
});
