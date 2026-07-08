// FLY-980 S4-S6 — E2E session driver (s5-elevenlabs-agent.mjs 改造):
// get-signed-url → WS → 起始帧(可带 conversation_config_override / extra body)
// → 喂 ref PCM → 打点 speech-end→首 audio/首 text → 可注入打断(V6)。
// 每轮 agent 音频落 wav(founder 终审 + judge 素材)；全事件 jsonl 落盘。
//
// usage: node e2e-session.mjs <agent_id> --label <tag> [--rounds u1,u2,u3en]
//   [--override-voice <voice_id>] [--override-prompt-file <path>]
//   [--override-language <lang>] [--extra-body '<json>'] [--interrupt]
//   [--wait-ms 30000] [--tail-ms 4000]
// env: ELEVENLABS_API_KEY (~/.flywheel/.env)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { requireApiKey } from "./lib/eleven.mjs";

const argv = process.argv.slice(2);
const agentId = argv[0];
if (!agentId || agentId.startsWith("--")) {
	console.error("usage: node e2e-session.mjs <agent_id> --label <tag> [...]");
	process.exit(2);
}
const opt = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const label = opt("label", "run");
const roundIds = opt("rounds", "u1,u2").split(",").filter(Boolean);
const waitMs = Number(opt("wait-ms", 30_000));
const tailMs = Number(opt("tail-ms", 4_000));
const interrupt = has("interrupt");

const ROUND_PCM = {
	u1: "ref/u1-16k.pcm",
	u2: "ref/u2-16k.pcm",
	u3en: "ref/u3en-16k.pcm",
	u4slow: "ref/u4slow-16k.pcm",
	u5status: "ref/u5status-16k.pcm",
	u6who: "ref/u6who-16k.pcm",
};
for (const id of roundIds) {
	if (!ROUND_PCM[id] || !existsSync(ROUND_PCM[id])) {
		console.error(
			`round ${id}: pcm missing (${ROUND_PCM[id] ?? "unknown id"}) — run ./gen-ref-audio.sh`,
		);
		process.exit(2);
	}
}

const key = requireApiKey();
mkdirSync("out", { recursive: true });
const t0 = Date.now();
const now = () => Date.now() - t0;
const jsonlFile = `out/e2e-${label}.jsonl`;
const logEvent = (e) => {
	writeFileSync(jsonlFile, `${JSON.stringify({ t: now(), ...e })}\n`, {
		flag: "a",
	});
};

// override 起始帧(V8): per-session voice / persona / language
const override = {};
if (opt("override-voice")) {
	override.tts = { voice_id: opt("override-voice") };
}
if (opt("override-prompt-file")) {
	override.agent = {
		...(override.agent ?? {}),
		prompt: { prompt: readFileSync(opt("override-prompt-file"), "utf8") },
	};
}
if (opt("override-language")) {
	override.agent = {
		...(override.agent ?? {}),
		language: opt("override-language"),
	};
}
const initFrame = { type: "conversation_initiation_client_data" };
if (Object.keys(override).length > 0) {
	initFrame.conversation_config_override = override;
}
if (opt("extra-body")) {
	initFrame.custom_llm_extra_body = JSON.parse(opt("extra-body"));
}

const su = await (
	await fetch(
		`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
		{ headers: { "xi-api-key": key } },
	)
).json();
if (!su.signed_url) {
	console.error("get-signed-url failed:", JSON.stringify(su).slice(0, 300));
	process.exit(1);
}

const FRAME_BYTES = 640; // 16k s16le 20ms
const FRAME_MS = 20;
const silence = Buffer.alloc(FRAME_BYTES);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pcmToWav(pcmBuf, sampleRate) {
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + pcmBuf.length, 4);
	h.write("WAVE", 8);
	h.write("fmt ", 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(1, 22);
	h.writeUInt32LE(sampleRate, 24);
	h.writeUInt32LE(sampleRate * 2, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(pcmBuf.length, 40);
	return Buffer.concat([h, pcmBuf]);
}

const ws = new WebSocket(su.signed_url);
let round = null;
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
	// 全事件类型留证(V5b 垫话/挂断行为、V6 interruption、V7a 工具链路)
	const detail = { type: `evt:${msg.type}` };
	if (msg.type === "agent_response") {
		detail.text = msg.agent_response_event?.agent_response ?? "";
	}
	if (msg.type === "user_transcript") {
		detail.text = msg.user_transcription_event?.user_transcript ?? "";
	}
	if (msg.type === "agent_tool_response" || msg.type === "client_tool_call") {
		detail.raw = msg;
	}
	if (msg.type === "conversation_initiation_metadata") {
		detail.meta = msg.conversation_initiation_metadata_event;
	}
	if (msg.type === "interruption") detail.raw = msg;
	logEvent(detail);
	if (!round) return;
	if (msg.type === "user_transcript") {
		round.userTx = msg.user_transcription_event?.user_transcript ?? "";
	}
	if (msg.type === "agent_response") {
		round.agentText = msg.agent_response_event?.agent_response ?? "";
		if (round.firstTextMs === null) round.firstTextMs = t;
	}
	if (msg.type === "audio") {
		if (round.firstAudioMs === null) round.firstAudioMs = t;
		round.lastAudioMs = t;
		const b = Buffer.from(msg.audio_event?.audio_base_64 ?? "", "base64");
		round.audioBytes += b.length;
		round.chunks.push(b);
	}
});
let wsClosed = false;
ws.on("error", (e) => {
	console.error("ws error:", e?.message ?? e);
	process.exit(1);
});
ws.on("close", (code) => {
	wsClosed = true;
	logEvent({ type: "ws_close", code });
});
await new Promise((r) => ws.on("open", r));
logEvent({
	type: "init_sent",
	override,
	extra: initFrame.custom_llm_extra_body ?? null,
});
ws.send(JSON.stringify(initFrame));
await sleep(800);

const results = [];
for (const id of roundIds) {
	if (wsClosed) {
		console.error(`ws closed — aborting remaining rounds at ${id}`);
		break;
	}
	const speech = readFileSync(ROUND_PCM[id]);
	round = {
		id,
		speechEndMs: null,
		firstAudioMs: null,
		firstTextMs: null,
		lastAudioMs: null,
		audioBytes: 0,
		userTx: "",
		agentText: "",
		chunks: [],
		interrupted: false,
	};
	for (let k = 0; k < 15; k++) {
		ws.send(JSON.stringify({ user_audio_chunk: silence.toString("base64") }));
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
	logEvent({ type: "speech_end", id });

	// 尾随静音直到首 audio(或超时)
	const tStart = Date.now();
	while (round.firstAudioMs === null && Date.now() - tStart < waitMs) {
		ws.send(JSON.stringify({ user_audio_chunk: silence.toString("base64") }));
		await sleep(FRAME_MS);
	}

	if (interrupt && round.firstAudioMs !== null) {
		// V6: 答中打断 —— 首音后 ~1s 再次喂人声
		await sleep(1000);
		logEvent({ type: "interrupt_inject", id });
		round.interrupted = true;
		const again = readFileSync(ROUND_PCM.u1);
		for (let off = 0; off < again.length; off += FRAME_BYTES) {
			ws.send(
				JSON.stringify({
					user_audio_chunk: again
						.subarray(off, off + FRAME_BYTES)
						.toString("base64"),
				}),
			);
			await sleep(FRAME_MS);
		}
		logEvent({ type: "interrupt_speech_end", id });
	}

	// 收尾静音,收全回复
	const tTail = Date.now();
	while (Date.now() - tTail < tailMs) {
		ws.send(JSON.stringify({ user_audio_chunk: silence.toString("base64") }));
		await sleep(FRAME_MS);
	}

	const r = {
		id,
		endpointToFirstAudio_ms:
			round.firstAudioMs !== null
				? round.firstAudioMs - round.speechEndMs
				: null,
		endpointToFirstText_ms:
			round.firstTextMs !== null ? round.firstTextMs - round.speechEndMs : null,
		audioBytes: round.audioBytes,
		interrupted: round.interrupted,
		userTx: round.userTx,
		agentText: round.agentText,
	};
	results.push(r);
	if (round.chunks.length) {
		writeFileSync(
			`out/e2e-${label}-${id}.wav`,
			pcmToWav(Buffer.concat(round.chunks), 16000),
		);
	}
	console.error(
		`[${id}] firstAudio=${r.endpointToFirstAudio_ms}ms firstText=${r.endpointToFirstText_ms}ms userTx="${r.userTx}" agent="${r.agentText.slice(0, 60)}"`,
	);
	round = null;
	await sleep(500);
}

ws.close();
writeFileSync(
	`out/e2e-${label}-results.json`,
	JSON.stringify({ agentId, label, override, results }, null, 2),
);
console.log(JSON.stringify(results, null, 2));
process.exit(0);
