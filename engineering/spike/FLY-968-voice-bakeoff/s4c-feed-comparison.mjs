// FLY-968 P3 补充 — 静默补喂通路对照(T3-c 行为异常后的两代模型对照,plan §3 P3 T3-c):
// 已证:3.1 + sendRealtimeInput(text) → 必触发出声(s4 主实验)。
// 本脚本补三格矩阵:
//   B: 3.1 + sendClientContent(turnComplete:false) 会话中注入
//   C: 2.5 native-audio + sendClientContent(turnComplete:false)
//   D: 2.5 native-audio + sendRealtimeInput(text)
// 每格:先一轮音频建立会话 → 注入 2 段(含事实「发布时间周五下午三点」) → 观察 3s 是否出声
//        → 音频点名提问(u5) → 验证引用。
// usage: GEMINI_API_KEY=... node s4c-feed-comparison.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import { makeLogger, sleep } from "./lib/events.mjs";

if (!process.env.GEMINI_API_KEY) {
	console.error("GEMINI_API_KEY missing in env");
	process.exit(2);
}
const { now, logEvent } = makeLogger("out/s4c-feed-comparison.jsonl");
const FRAME_BYTES = 640;
const FRAME_MS = 20;
const silenceFrame = Buffer.alloc(FRAME_BYTES);
const SPEECH_BYTES_THRESHOLD = 12_000;
const MODEL_31 = "gemini-3.1-flash-live-preview";
const MODEL_25 =
	process.env.FLYWHEEL_VOICE_GEMINI25_MODEL ??
	"gemini-2.5-flash-native-audio-preview-12-2025";
const PERSONA =
	"你是 Tadashi,工程 Lead,在一场多人语音会议里。铁律:只有被点名才说话;没点你名保持完全沉默。被点名时用中文口语短句回答。";
const FEED = [
	"(会议记录)Annie:我们先过一下这周的安排。",
	"(会议记录)Annie:发布时间定在周五下午三点。",
];

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function runCase(id, model, injectFn) {
	const st = {
		bytes: 0,
		outTx: "",
		inTx: "",
		firstAudioMs: null,
		turnDone: null,
		errors: [],
	};
	let session;
	try {
		session = await client.live.connect({
			model,
			config: {
				responseModalities: [Modality.AUDIO],
				inputAudioTranscription: {},
				outputAudioTranscription: {},
				systemInstruction: { parts: [{ text: PERSONA }] },
			},
			callbacks: {
				onmessage: (msg) => {
					const sc = msg?.serverContent;
					if (sc?.outputTranscription?.text)
						st.outTx += sc.outputTranscription.text;
					for (const p of sc?.modelTurn?.parts ?? []) {
						if (p?.inlineData?.data) {
							st.bytes += Buffer.from(p.inlineData.data, "base64").length;
							if (st.firstAudioMs === null) st.firstAudioMs = now();
						}
					}
					if (sc?.turnComplete) st.turnDone?.();
				},
				onerror: (e) => st.errors.push(String(e?.message ?? e)),
				onclose: (e) =>
					logEvent({ type: "close", id, reason: String(e?.reason ?? "") }),
			},
		});
	} catch (e) {
		return {
			id,
			model,
			status: "connect-failed",
			error: String(e?.message ?? e),
		};
	}

	const pushAudio = async (pcm) => {
		for (let k = 0; k < 15; k++) {
			session.sendRealtimeInput({
				audio: {
					data: silenceFrame.toString("base64"),
					mimeType: "audio/pcm;rate=16000",
				},
			});
			await sleep(FRAME_MS);
		}
		for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
			session.sendRealtimeInput({
				audio: {
					data: pcm.subarray(off, off + FRAME_BYTES).toString("base64"),
					mimeType: "audio/pcm;rate=16000",
				},
			});
			await sleep(FRAME_MS);
		}
		const end = now();
		const done = new Promise((r) => {
			st.turnDone = r;
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
		await Promise.race([done, sleep(15_000)]);
		silencing = false;
		await silencer;
		st.turnDone = null;
		return end;
	};

	// 1) 建立会话:一轮真音频(u3a 点名 Tadashi)
	await pushAudio(readFileSync("ref/u3a-16k.pcm"));
	const warmupTx = st.outTx;

	// 2) 注入 + 观察窗
	st.bytes = 0;
	st.outTx = "";
	let injectError = null;
	try {
		await injectFn(session);
	} catch (e) {
		injectError = String(e?.message ?? e);
	}
	await sleep(3000);
	const spokeDuringFeed = st.bytes > SPEECH_BYTES_THRESHOLD;
	const feedTx = st.outTx;

	// 3) 音频点名提问(u5:发布时间)
	st.bytes = 0;
	st.outTx = "";
	st.firstAudioMs = null;
	await pushAudio(readFileSync("ref/u5-16k.pcm"));
	const result = {
		id,
		model,
		warmupTx: warmupTx.slice(0, 60),
		injectError,
		spokeDuringFeed,
		feedBytes: st.bytes,
		feedTx: feedTx.slice(0, 100),
		askAnswer: st.outTx.slice(0, 120),
		citesFact: /周五|下午三点|15[:点]/.test(st.outTx),
		errors: st.errors.slice(),
	};
	session.close();
	console.error(
		`[${id}] inject=${injectError ? "ERR" : "ok"} spokeDuringFeed=${spokeDuringFeed} cites=${result.citesFact} "${result.askAnswer.slice(0, 60)}"`,
	);
	return result;
}

const injectClientContent = async (session) => {
	for (const seg of FEED) {
		session.sendClientContent({
			turns: [{ role: "user", parts: [{ text: seg }] }],
			turnComplete: false,
		});
		logEvent({ type: "inject-cc", payload: seg });
		await sleep(700);
	}
};
const injectRealtimeText = async (session) => {
	for (const seg of FEED) {
		session.sendRealtimeInput({ text: seg });
		logEvent({ type: "inject-rt", payload: seg });
		await sleep(700);
	}
};

const results = [];
results.push(
	await runCase("B-31-clientContent", MODEL_31, injectClientContent),
);
results.push(
	await runCase("C-25-clientContent", MODEL_25, injectClientContent),
);
results.push(await runCase("D-25-realtimeText", MODEL_25, injectRealtimeText));
writeFileSync(
	"out/s4c-feed-comparison-results.json",
	JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
process.exit(0);
