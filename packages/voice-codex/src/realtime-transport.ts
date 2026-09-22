import WebSocket, { type ClientOptions } from "ws";

export const OPENAI_REALTIME_URL =
	"wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5";
export const REALTIME_MAX_WIRE_BYTES = 2 * 1024 * 1024;

export type RealtimeSocketFactory = (
	url: string,
	options: ClientOptions,
) => WebSocket;

export function createRealtimeSocket(
	apiKey: string,
	factory: RealtimeSocketFactory = (url, options) =>
		new WebSocket(url, options),
): WebSocket {
	const key = apiKey.trim();
	if (!key) throw new Error("realtime_api_auth");
	return factory(OPENAI_REALTIME_URL, {
		headers: { Authorization: `Bearer ${key}` },
		followRedirects: false,
		handshakeTimeout: 20_000,
		maxPayload: REALTIME_MAX_WIRE_BYTES,
		perMessageDeflate: false,
	});
}
