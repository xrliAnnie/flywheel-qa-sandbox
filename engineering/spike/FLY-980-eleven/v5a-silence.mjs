// FLY-980 V5a — turn_timeout 语义取证:不说话只喂静默,记录 agent 主动接话
// 的时刻(= turn_timeout 的「用户静默端点」语义;它不管慢 LLM —— research §2)。
// usage: node v5a-silence.mjs <agent_id> <label> [watch-ms]
import WebSocket from "ws";
import { requireApiKey } from "./lib/eleven.mjs";

const [, , agentId, label = "v5a", watchArg] = process.argv;
const WATCH_MS = Number(watchArg ?? 25_000);
const key = requireApiKey();

const su = await (
	await fetch(
		`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
		{ headers: { "xi-api-key": key } },
	)
).json();
const ws = new WebSocket(su.signed_url);
const t0 = Date.now();
let firstAudioMs = null;
let firstText = "";
ws.on("message", (raw) => {
	let msg;
	try {
		msg = JSON.parse(raw.toString());
	} catch {
		return;
	}
	if (msg.type === "ping") {
		ws.send(
			JSON.stringify({ type: "pong", event_id: msg.ping_event?.event_id }),
		);
		return;
	}
	if (msg.type === "audio" && firstAudioMs === null) {
		firstAudioMs = Date.now() - t0;
	}
	if (msg.type === "agent_response" && !firstText) {
		firstText = msg.agent_response_event?.agent_response ?? "";
	}
});
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
const silence = Buffer.alloc(640);
const until = Date.now() + WATCH_MS;
while (Date.now() < until) {
	ws.send(JSON.stringify({ user_audio_chunk: silence.toString("base64") }));
	await new Promise((r) => setTimeout(r, 20));
}
ws.close();
console.log(
	JSON.stringify({
		label,
		silence_to_first_agent_audio_ms: firstAudioMs,
		agent_said: firstText.slice(0, 60),
	}),
);
