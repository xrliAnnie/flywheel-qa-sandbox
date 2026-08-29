// FLY-545 S1 spike — Gemini Live TEXT response modality + inputAudioTranscription 并用 + 延迟量测。
// throwaway:不进包,零生产代码改动。plan.md §7 P0-S1。
//
// usage: GEMINI_API_KEY=... node s1-text-modality.mjs <utterance-16k-mono.pcm> [rounds]
//   <utterance-16k-mono.pcm> = s16le 16kHz mono raw PCM(一句短问话,尾部不带长静默)
//   量测:t_speech_end → 首个 input transcription / 首个 TEXT part / turnComplete。
//   输出:out/s1-events.jsonl(全事件带时间戳)+ stdout JSON summary。
//
// 判据(plan §8 A2):①TEXT 模态下 inputTranscription 事件照常下发;②延迟数字,
//   全链首音估算 >2s → 停,报 Tadashi(降级位 D1-A)。

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";

const [, , pcmPath, roundsArg] = process.argv;
if (!process.env.GEMINI_API_KEY || !pcmPath) {
	console.error(
		"usage: GEMINI_API_KEY=... node s1-text-modality.mjs <utterance-16k-mono.pcm> [rounds]",
	);
	process.exit(2);
}
const ROUNDS = Number(roundsArg ?? 3);
const MODEL =
	process.env.FLYWHEEL_VOICE_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview";

mkdirSync("out", { recursive: true });
const EVENTS = "out/s1-events.jsonl";
const t0 = Date.now();
const now = () => Date.now() - t0;
const logEvent = (e) =>
	appendFileSync(EVENTS, `${JSON.stringify({ t: now(), ...e })}\n`);

// 16kHz mono s16le:20ms 帧 = 320 samples = 640 bytes。真实节奏 pace(VAD 语义端点要真实时间轴)。
const FRAME_BYTES = 640;
const FRAME_MS = 20;
const speech = readFileSync(pcmPath);
const silenceFrame = Buffer.alloc(FRAME_BYTES);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/** per-round measurement state */
let round = null;
let onTurnComplete = null;

function handleMessage(msg) {
	const t = now();
	const sc = msg?.serverContent;
	if (sc?.inputTranscription?.text) {
		logEvent({ type: "input-transcription", text: sc.inputTranscription.text });
		if (round && round.firstInputTranscriptMs === null)
			round.firstInputTranscriptMs = t;
		if (round) round.inputTranscript += sc.inputTranscription.text;
	}
	if (sc?.outputTranscription?.text)
		logEvent({
			type: "output-transcription",
			text: sc.outputTranscription.text,
		});
	for (const p of sc?.modelTurn?.parts ?? []) {
		if (typeof p?.text === "string" && p.text.length > 0) {
			logEvent({ type: "text-part", text: p.text });
			if (round && round.firstTextMs === null) round.firstTextMs = t;
			if (round) round.responseText += p.text;
		}
		if (p?.inlineData?.data)
			logEvent({ type: "audio-part", bytes: p.inlineData.data.length });
	}
	if (sc?.generationComplete) logEvent({ type: "generation-complete" });
	if (sc?.turnComplete) {
		logEvent({ type: "turn-complete" });
		if (round && round.turnCompleteMs === null) round.turnCompleteMs = t;
		onTurnComplete?.();
	}
	if (sc?.interrupted) logEvent({ type: "interrupted" });
	if (msg?.toolCall)
		logEvent({
			type: "tool-call",
			raw: JSON.stringify(msg.toolCall).slice(0, 200),
		});
}

const session = await client.live.connect({
	model: MODEL,
	config: {
		responseModalities: [Modality.TEXT],
		inputAudioTranscription: {},
		systemInstruction: {
			parts: [
				{
					text: "你是语音会议里的工程 Lead。用中文口语短句回答,一两句话即可,不用 markdown。",
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

async function sendPcmPaced(buf) {
	for (let off = 0; off < buf.length; off += FRAME_BYTES) {
		session.sendRealtimeInput({
			audio: {
				data: buf.subarray(off, off + FRAME_BYTES).toString("base64"),
				mimeType: "audio/pcm;rate=16000",
			},
		});
		await sleep(FRAME_MS);
	}
}

const results = [];
for (let i = 0; i < ROUNDS; i++) {
	round = {
		round: i + 1,
		speechEndMs: null,
		firstInputTranscriptMs: null,
		firstTextMs: null,
		turnCompleteMs: null,
		inputTranscript: "",
		responseText: "",
	};
	logEvent({ type: "round-start", round: i + 1 });
	// 300ms 前导静默,然后真话音,然后持续静默直到 turn-complete(VAD 端点靠尾部静默判)
	for (let k = 0; k < 15; k++) {
		session.sendRealtimeInput({
			audio: {
				data: silenceFrame.toString("base64"),
				mimeType: "audio/pcm;rate=16000",
			},
		});
		await sleep(FRAME_MS);
	}
	await sendPcmPaced(speech);
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
	const timeout = sleep(20_000).then(() => "timeout");
	const outcome = await Promise.race([done.then(() => "ok"), timeout]);
	silencing = false;
	await silencer;
	onTurnComplete = null;

	const r = {
		round: i + 1,
		outcome,
		endpointToFirstText_ms:
			round.firstTextMs !== null ? round.firstTextMs - round.speechEndMs : null,
		endpointToFirstInputTranscript_ms:
			round.firstInputTranscriptMs !== null
				? round.firstInputTranscriptMs - round.speechEndMs
				: null,
		endpointToTurnComplete_ms:
			round.turnCompleteMs !== null
				? round.turnCompleteMs - round.speechEndMs
				: null,
		inputTranscript: round.inputTranscript,
		responseText: round.responseText.slice(0, 300),
	};
	results.push(r);
	console.error(
		`[round ${i + 1}] ${outcome} firstText=${r.endpointToFirstText_ms}ms inputTx="${r.inputTranscript.slice(0, 60)}"`,
	);
	await sleep(1000);
}
round = null;

session.close();
const summary = {
	model: MODEL,
	rounds: results,
	inputTranscriptionWorksWithTextModality: results.every(
		(r) => r.inputTranscript.length > 0,
	),
	textResponseWorks: results.every((r) => r.responseText.length > 0),
};
console.log(JSON.stringify(summary, null, 2));
