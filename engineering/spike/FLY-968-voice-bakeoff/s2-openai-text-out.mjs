// FLY-968 P1 — OpenAI Realtime text-out 复活线(V1+V2):
//   V1: 现役 gpt-realtime 系是否接受 output_modalities:["text"] 并稳定 text 出(零 audio 帧)
//   V2: speech-end → 首 text token 延迟;叠 edge-tts(整段 vs 分句流水)的全链首音估算
//
// usage: OPENAI_API_KEY=... node s2-openai-text-out.mjs
//   (音频固定用 ref/u1-24k.pcm / ref/u2-24k.pcm,轮次 = u1,u2,u1)
// env: FLYWHEEL_VOICE_OPENAI_MODEL 覆盖模型名(默认 gpt-realtime-2.1)

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { makeLogger, sleep } from "./lib/events.mjs";

if (!process.env.OPENAI_API_KEY) {
	console.error("OPENAI_API_KEY missing in env");
	process.exit(2);
}
const MODEL = process.env.FLYWHEEL_VOICE_OPENAI_MODEL ?? "gpt-realtime-2.1";
const { now, logEvent } = makeLogger("out/s2-openai-text-out.jsonl");

const FRAME_BYTES = 960; // 24kHz s16le mono, 20ms
const FRAME_MS = 20;
const silenceFrame = Buffer.alloc(FRAME_BYTES);
const ROUNDS = [
	{ id: "u1", pcm: "ref/u1-24k.pcm" },
	{ id: "u2", pcm: "ref/u2-24k.pcm" },
	{ id: "u1b", pcm: "ref/u1-24k.pcm" },
];

const ws = new WebSocket(
	`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
	{ headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } },
);

let round = null;
let onRoundDone = null;
const send = (obj) => ws.send(JSON.stringify(obj));

ws.on("open", () => {
	logEvent({ type: "ws-open", model: MODEL });
	send({
		type: "session.update",
		session: {
			type: "realtime",
			output_modalities: ["text"],
			instructions:
				"你是语音会议里的工程 Lead。用中文口语短句回答,一两句话即可。",
			audio: {
				input: {
					format: { type: "audio/pcm", rate: 24000 },
					transcription: { model: "gpt-4o-mini-transcribe" },
					turn_detection: { type: "server_vad" },
				},
			},
		},
	});
});

ws.on("message", (raw) => {
	const t = now();
	let msg;
	try {
		msg = JSON.parse(raw.toString());
	} catch {
		logEvent({ type: "unparseable", raw: raw.toString().slice(0, 200) });
		return;
	}
	// 全事件类型序列落日志(payload 只留证据必需字段)
	logEvent({ type: `evt:${msg.type}` });
	if (msg.type === "error") {
		logEvent({ type: "error-detail", error: msg.error });
		console.error("[server error]", JSON.stringify(msg.error));
	}
	if (msg.type === "session.created" || msg.type === "session.updated") {
		logEvent({ type: `${msg.type}-detail`, session: msg.session });
	}
	if (!round) return;
	if (msg.type === "input_audio_buffer.speech_stopped") round.vadStopMs = t;
	if (msg.type === "conversation.item.input_audio_transcription.completed") {
		round.inputTranscript = msg.transcript ?? "";
	}
	if (
		msg.type === "response.output_text.delta" ||
		msg.type === "response.text.delta"
	) {
		if (round.firstTextMs === null) {
			round.firstTextMs = t;
			round.textDeltaEventName = msg.type;
		}
		round.text += msg.delta ?? "";
		// 分句流水锚点:首个句末标点出现时刻
		if (round.firstSentenceMs === null && /[。！？!?.]/.test(round.text))
			round.firstSentenceMs = t;
	}
	if (
		msg.type === "response.output_audio.delta" ||
		msg.type === "response.audio.delta"
	)
		round.audioDeltaCount += 1;
	if (msg.type === "response.done") {
		round.doneMs = t;
		round.status = msg.response?.status;
		round.usage = msg.response?.usage;
		onRoundDone?.();
	}
});
ws.on("error", (e) => {
	logEvent({ type: "ws-error", message: String(e?.message ?? e) });
	console.error("ws error:", e?.message ?? e);
	process.exit(1);
});
ws.on("close", (code, reason) =>
	logEvent({ type: "ws-close", code, reason: String(reason) }),
);

await new Promise((resolve) => {
	const iv = setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) {
			clearInterval(iv);
			resolve();
		}
	}, 20);
});
await sleep(500); // 等 session.updated 落地

// edge-tts 合成计时(V2 叠加段):返回合成毫秒数
async function edgeTtsSynth(text, outFile) {
	const t0 = Date.now();
	await new Promise((resolve, reject) => {
		const p = spawn("edge-tts", [
			"--voice",
			"zh-CN-YunxiNeural",
			"--text",
			text,
			"--write-media",
			outFile,
		]);
		p.on("exit", (c) =>
			c === 0 ? resolve() : reject(new Error(`edge-tts exit ${c}`)),
		);
		p.on("error", reject);
	});
	return Date.now() - t0;
}

const results = [];
for (const spec of ROUNDS) {
	const speech = readFileSync(spec.pcm);
	round = {
		id: spec.id,
		speechEndMs: null,
		vadStopMs: null,
		firstTextMs: null,
		firstSentenceMs: null,
		doneMs: null,
		text: "",
		inputTranscript: "",
		audioDeltaCount: 0,
		textDeltaEventName: null,
		status: null,
		usage: null,
	};
	logEvent({ type: "round-start", id: spec.id });
	// 前置静音 300ms 让 VAD 建立底噪
	for (let k = 0; k < 15; k++) {
		send({
			type: "input_audio_buffer.append",
			audio: silenceFrame.toString("base64"),
		});
		await sleep(FRAME_MS);
	}
	for (let off = 0; off < speech.length; off += FRAME_BYTES) {
		send({
			type: "input_audio_buffer.append",
			audio: speech.subarray(off, off + FRAME_BYTES).toString("base64"),
		});
		await sleep(FRAME_MS);
	}
	round.speechEndMs = now();
	logEvent({ type: "speech-end", id: spec.id });

	const done = new Promise((resolve) => {
		onRoundDone = resolve;
	});
	let silencing = true;
	const silencer = (async () => {
		while (silencing) {
			send({
				type: "input_audio_buffer.append",
				audio: silenceFrame.toString("base64"),
			});
			await sleep(FRAME_MS);
		}
	})();
	const outcome = await Promise.race([
		done.then(() => "ok"),
		sleep(30_000).then(() => "timeout"),
	]);
	silencing = false;
	await silencer;
	onRoundDone = null;

	// V2 叠加段:整段合成 vs 首句流水
	let fullSynthMs = null;
	let firstSentenceSynthMs = null;
	let firstSentence = null;
	if (round.text) {
		const m = round.text.match(/^[^。！？!?.]*[。！？!?.]/);
		firstSentence = m ? m[0] : round.text;
		fullSynthMs = await edgeTtsSynth(round.text, `out/s2-${spec.id}-full.mp3`);
		firstSentenceSynthMs = await edgeTtsSynth(
			firstSentence,
			`out/s2-${spec.id}-first.mp3`,
		);
	}

	const r = {
		id: spec.id,
		outcome,
		status: round.status,
		textDeltaEventName: round.textDeltaEventName,
		vadLag_ms:
			round.vadStopMs !== null ? round.vadStopMs - round.speechEndMs : null,
		endpointToFirstText_ms:
			round.firstTextMs !== null ? round.firstTextMs - round.speechEndMs : null,
		endpointToFirstSentence_ms:
			round.firstSentenceMs !== null
				? round.firstSentenceMs - round.speechEndMs
				: null,
		endpointToDone_ms:
			round.doneMs !== null ? round.doneMs - round.speechEndMs : null,
		audioDeltaCount: round.audioDeltaCount,
		inputTranscript: round.inputTranscript,
		text: round.text,
		firstSentence,
		fullSynthMs,
		firstSentenceSynthMs,
		// 全链首音估算:speech-end→text 就绪 + edge-tts 合成
		fullChain_wholeText_ms:
			round.doneMs !== null && fullSynthMs !== null
				? round.doneMs - round.speechEndMs + fullSynthMs
				: null,
		fullChain_sentencePipeline_ms:
			round.firstSentenceMs !== null && firstSentenceSynthMs !== null
				? round.firstSentenceMs - round.speechEndMs + firstSentenceSynthMs
				: null,
		usage: round.usage,
	};
	results.push(r);
	console.error(
		`[${spec.id}] ${outcome} firstText=${r.endpointToFirstText_ms}ms firstSentence=${r.endpointToFirstSentence_ms}ms done=${r.endpointToDone_ms}ms audioDeltas=${r.audioDeltaCount} chain(sentence)=${r.fullChain_sentencePipeline_ms}ms`,
	);
	round = null;
	await sleep(1000);
}

ws.close();
writeFileSync(
	"out/s2-openai-text-out-results.json",
	JSON.stringify({ model: MODEL, rounds: results }, null, 2),
);
console.log(JSON.stringify({ model: MODEL, rounds: results }, null, 2));
