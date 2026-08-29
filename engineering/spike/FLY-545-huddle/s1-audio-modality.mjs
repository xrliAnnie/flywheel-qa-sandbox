// FLY-545 S1 spike(第二腿)— TEXT 模态被服务端拒绝后,量 AUDIO 模态的真实延迟:
//   ① D1-A 口径:speech-end → 首个 audio chunk(inlineData)= 全链首音的模型侧下界
//   ② 混合口径:speech-end → 首个 outputTranscription chunk(若走「audio 丢弃 + 转写→edge-tts」)
//   ③ inputTranscription 照常性(TIV 字幕依赖)
//
// usage: GEMINI_API_KEY=... node s1-audio-modality.mjs <utterance-16k-mono.pcm> [rounds]

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";

const [, , pcmPath, roundsArg] = process.argv;
if (!process.env.GEMINI_API_KEY || !pcmPath) {
	console.error(
		"usage: GEMINI_API_KEY=... node s1-audio-modality.mjs <pcm> [rounds]",
	);
	process.exit(2);
}
const ROUNDS = Number(roundsArg ?? 3);
const MODEL =
	process.env.FLYWHEEL_VOICE_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview";

mkdirSync("out", { recursive: true });
const EVENTS = "out/s1-audio-events.jsonl";
const t0 = Date.now();
const now = () => Date.now() - t0;
const logEvent = (e) =>
	appendFileSync(EVENTS, `${JSON.stringify({ t: now(), ...e })}\n`);

const FRAME_BYTES = 640;
const FRAME_MS = 20;
const speech = readFileSync(pcmPath);
const silenceFrame = Buffer.alloc(FRAME_BYTES);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let round = null;
let onTurnComplete = null;

function handleMessage(msg) {
	const t = now();
	const sc = msg?.serverContent;
	if (sc?.inputTranscription?.text) {
		if (round && round.firstInputTranscriptMs === null)
			round.firstInputTranscriptMs = t;
		if (round) round.inputTranscript += sc.inputTranscription.text;
	}
	if (sc?.outputTranscription?.text) {
		logEvent({
			type: "output-transcription",
			text: sc.outputTranscription.text,
		});
		if (round && round.firstOutputTranscriptMs === null)
			round.firstOutputTranscriptMs = t;
		if (round) round.outputTranscript += sc.outputTranscription.text;
	}
	for (const p of sc?.modelTurn?.parts ?? []) {
		if (p?.inlineData?.data) {
			if (round && round.firstAudioMs === null) {
				round.firstAudioMs = t;
				logEvent({ type: "first-audio-part", bytes: p.inlineData.data.length });
			}
			if (round) round.audioBytes += p.inlineData.data.length;
		}
	}
	if (sc?.turnComplete) {
		logEvent({ type: "turn-complete" });
		if (round && round.turnCompleteMs === null) round.turnCompleteMs = t;
		onTurnComplete?.();
	}
}

const session = await client.live.connect({
	model: MODEL,
	config: {
		responseModalities: [Modality.AUDIO],
		inputAudioTranscription: {},
		outputAudioTranscription: {},
		systemInstruction: {
			parts: [
				{
					text: "你是语音会议里的工程 Lead。用中文口语短句回答,一两句话即可。",
				},
			],
		},
	},
	callbacks: {
		onmessage: handleMessage,
		onerror: (e) =>
			logEvent({ type: "error", message: String(e?.message ?? e) }),
		onclose: (e) =>
			logEvent({ type: "close", reason: String(e?.reason ?? "") }),
	},
});
logEvent({ type: "connected", model: MODEL });

const results = [];
for (let i = 0; i < ROUNDS; i++) {
	round = {
		speechEndMs: null,
		firstInputTranscriptMs: null,
		firstOutputTranscriptMs: null,
		firstAudioMs: null,
		turnCompleteMs: null,
		inputTranscript: "",
		outputTranscript: "",
		audioBytes: 0,
	};
	logEvent({ type: "round-start", round: i + 1 });
	for (let k = 0; k < 15; k++) {
		session.sendRealtimeInput({
			audio: {
				data: silenceFrame.toString("base64"),
				mimeType: "audio/pcm;rate=16000",
			},
		});
		await sleep(FRAME_MS);
	}
	for (let off = 0; off < speech.length; off += FRAME_BYTES) {
		session.sendRealtimeInput({
			audio: {
				data: speech.subarray(off, off + FRAME_BYTES).toString("base64"),
				mimeType: "audio/pcm;rate=16000",
			},
		});
		await sleep(FRAME_MS);
	}
	round.speechEndMs = now();
	logEvent({ type: "speech-end", round: i + 1 });

	const done = new Promise((resolve) => {
		onTurnComplete = resolve;
	});
	let silencing = true;
	const silencer = (async () => {
		while (silencing) {
			session.sendRealtimeInput({
				audio: {
					data: silenceFrame.toString("base64"),
					mimeType: "audio/pcm;rate=16000",
				},
			});
			await sleep(FRAME_MS);
		}
	})();
	const outcome = await Promise.race([
		done.then(() => "ok"),
		sleep(25_000).then(() => "timeout"),
	]);
	silencing = false;
	await silencer;
	onTurnComplete = null;

	const r = {
		round: i + 1,
		outcome,
		endpointToFirstAudio_ms:
			round.firstAudioMs !== null
				? round.firstAudioMs - round.speechEndMs
				: null,
		endpointToFirstOutputTranscript_ms:
			round.firstOutputTranscriptMs !== null
				? round.firstOutputTranscriptMs - round.speechEndMs
				: null,
		endpointToTurnComplete_ms:
			round.turnCompleteMs !== null
				? round.turnCompleteMs - round.speechEndMs
				: null,
		inputTranscriptionWorks: round.inputTranscript.length > 0,
		inputTranscript: round.inputTranscript.slice(0, 120),
		outputTranscript: round.outputTranscript.slice(0, 200),
		audioBytes: round.audioBytes,
	};
	results.push(r);
	console.error(
		`[round ${i + 1}] ${outcome} firstAudio=${r.endpointToFirstAudio_ms}ms firstOutTx=${r.endpointToFirstOutputTranscript_ms}ms inputTx=${r.inputTranscriptionWorks}`,
	);
	await sleep(1000);
}
round = null;
session.close();
console.log(JSON.stringify({ model: MODEL, rounds: results }, null, 2));
