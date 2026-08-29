// FLY-968 P4 — ElevenLabs Agents 时间盒评估(V10):
// 最小 Agent(平台内置 LLM gpt-4o-mini + eleven_flash_v2_5,zh) WebSocket 直连,
// 测 speech-end→首 audio event 延迟 + 自定义音频进出形态(Discord 桥接摩擦定性素材)。
// usage: ELEVENLABS_API_KEY=... node s5-elevenlabs-agent.mjs <agent_id> [rounds]

import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { makeLogger, pcmToWav, sleep } from "./lib/events.mjs";

const [, , agentId, roundsArg] = process.argv;
if (!process.env.ELEVENLABS_API_KEY || !agentId) {
	console.error(
		"usage: ELEVENLABS_API_KEY=... node s5-elevenlabs-agent.mjs <agent_id>",
	);
	process.exit(2);
}
const { now, logEvent } = makeLogger("out/s5-elevenlabs.jsonl");
const FRAME_BYTES = 640; // 16k s16le 20ms(agent asr user_input_audio_format=pcm_16000)
const FRAME_MS = 20;
const silenceFrame = Buffer.alloc(FRAME_BYTES);
const ROUNDS = [
	{ id: "u1", pcm: "ref/u1-16k.pcm" },
	{ id: "u2", pcm: "ref/u2-16k.pcm" },
].slice(0, Number(roundsArg ?? 2));

const su = await (
	await fetch(
		`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
		{ headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } },
	)
).json();
if (!su.signed_url) {
	console.error("get-signed-url failed:", JSON.stringify(su).slice(0, 200));
	process.exit(1);
}

const ws = new WebSocket(su.signed_url);
let round = null;
const chunksAll = [];
ws.on("message", (raw) => {
	const t = now();
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
	logEvent({ type: `evt:${msg.type}` });
	if (msg.type === "conversation_initiation_metadata")
		logEvent({
			type: "init-detail",
			meta: msg.conversation_initiation_metadata_event,
		});
	if (!round) return;
	if (msg.type === "user_transcript")
		round.userTx = msg.user_transcription_event?.user_transcript ?? "";
	if (msg.type === "agent_response") {
		round.agentText = msg.agent_response_event?.agent_response ?? "";
		if (round.firstTextMs === null) round.firstTextMs = t;
	}
	if (msg.type === "audio") {
		if (round.firstAudioMs === null) round.firstAudioMs = t;
		const b = Buffer.from(msg.audio_event?.audio_base_64 ?? "", "base64");
		round.audioBytes += b.length;
		chunksAll.push(b);
	}
});
ws.on("error", (e) => {
	console.error("ws error:", e?.message ?? e);
	process.exit(1);
});
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
await sleep(800);

const results = [];
for (const spec of ROUNDS) {
	const speech = readFileSync(spec.pcm);
	round = {
		id: spec.id,
		speechEndMs: null,
		firstAudioMs: null,
		firstTextMs: null,
		audioBytes: 0,
		userTx: "",
		agentText: "",
	};
	for (let k = 0; k < 15; k++) {
		ws.send(
			JSON.stringify({ user_audio_chunk: silenceFrame.toString("base64") }),
		);
		await sleep(FRAME_MS);
	}
	for (let off = 0; off < speech.length; off += FRAME_BYTES) {
		ws.send(
			JSON.stringify({
				user_audio_chunk: speech
					.subarray(off, off + FRAME_BYTES)
					.toString("base64"),
			}),
		);
		await sleep(FRAME_MS);
	}
	round.speechEndMs = now();
	logEvent({ type: "speech-end", id: spec.id });
	// 尾随静音直到收到首 audio + 再等 4s 收尾(或 20s 超时)
	const t0 = Date.now();
	while (round.firstAudioMs === null && Date.now() - t0 < 20_000) {
		ws.send(
			JSON.stringify({ user_audio_chunk: silenceFrame.toString("base64") }),
		);
		await sleep(FRAME_MS);
	}
	await sleep(4000);
	results.push({
		id: spec.id,
		endpointToFirstAudio_ms:
			round.firstAudioMs !== null
				? round.firstAudioMs - round.speechEndMs
				: null,
		endpointToFirstText_ms:
			round.firstTextMs !== null ? round.firstTextMs - round.speechEndMs : null,
		audioBytes: round.audioBytes,
		userTx: round.userTx,
		agentText: round.agentText,
	});
	console.error(
		`[${spec.id}] firstAudio=${results.at(-1).endpointToFirstAudio_ms}ms firstText=${results.at(-1).endpointToFirstText_ms}ms userTx="${round.userTx}" agent="${round.agentText.slice(0, 60)}"`,
	);
	round = null;
	await sleep(500);
}
ws.close();
if (chunksAll.length)
	writeFileSync(
		"out/s5-elevenlabs-agent.wav",
		pcmToWav(Buffer.concat(chunksAll), 16000),
	);
writeFileSync(
	"out/s5-elevenlabs-results.json",
	JSON.stringify({ agentId, results }, null, 2),
);
console.log(JSON.stringify(results, null, 2));
process.exit(0);
