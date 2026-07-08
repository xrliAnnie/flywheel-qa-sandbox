// FLY-968 P3a — Gemini 声线 sweep(V8-Gemini):
// 预筛 shortlist(见 evidence/v8-gemini-voice-shortlist-predeclared.md,先于本脚本声明)
// 逐声线短 Live session 念同一句中文(与 OpenAI sweep 同句,跨厂商可比) → 落 wav。
// usage: GEMINI_API_KEY=... node s4a-gemini-voice-sweep.mjs

import { writeFileSync } from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import { makeLogger, pcmToWav, sleep } from "./lib/events.mjs";

if (!process.env.GEMINI_API_KEY) {
	console.error("GEMINI_API_KEY missing in env");
	process.exit(2);
}
const MODEL =
	process.env.FLYWHEEL_VOICE_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview";
const { logEvent } = makeLogger("out/s4a-voice-sweep.jsonl");
const SHORTLIST = [
	"Charon",
	"Sadaltager",
	"Iapetus",
	"Puck",
	"Fenrir",
	"Kore",
	"Aoede",
	"Leda",
	"Sulafat",
	"Gacrux",
];
const SENTENCE = "大家好，我是语音会议里的工程 Lead。Huddle 模式今天可以用了。";

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const summary = [];

for (const voice of SHORTLIST) {
	const chunks = [];
	let done = null;
	const donePromise = new Promise((r) => {
		done = r;
	});
	let errored = null;
	let session;
	try {
		session = await client.live.connect({
			model: MODEL,
			config: {
				responseModalities: [Modality.AUDIO],
				speechConfig: {
					voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
				},
			},
			callbacks: {
				onmessage: (msg) => {
					for (const p of msg?.serverContent?.modelTurn?.parts ?? []) {
						if (p?.inlineData?.data)
							chunks.push(Buffer.from(p.inlineData.data, "base64"));
					}
					if (msg?.serverContent?.turnComplete) done("ok");
				},
				onerror: (e) => {
					errored = String(e?.message ?? e);
					logEvent({ type: "error", voice, message: errored });
					done("error");
				},
				onclose: (e) =>
					logEvent({ type: "close", voice, reason: String(e?.reason ?? "") }),
			},
		});
	} catch (e) {
		summary.push({
			voice,
			status: "connect-failed",
			error: String(e?.message ?? e),
		});
		console.error(`[${voice}] connect-failed: ${e?.message ?? e}`);
		continue;
	}
	session.sendClientContent({
		turns: [
			{
				role: "user",
				parts: [
					{
						text: `请一字不差地用中文念这句话，不要加任何别的内容：${SENTENCE}`,
					},
				],
			},
		],
		turnComplete: true,
	});
	const status = await Promise.race([
		donePromise,
		sleep(20_000).then(() => "timeout"),
	]);
	const pcm = Buffer.concat(chunks);
	if (pcm.length > 0)
		writeFileSync(`out/s4a-voice-${voice}.wav`, pcmToWav(pcm, 24000));
	summary.push({
		voice,
		status: errored ? `error:${errored}` : status,
		audioBytes: pcm.length,
		seconds: +(pcm.length / 48000).toFixed(1),
	});
	console.error(`[${voice}] ${status} ${(pcm.length / 48000).toFixed(1)}s`);
	session.close();
	await sleep(400);
}
writeFileSync(
	"out/s4a-voices-summary.json",
	JSON.stringify({ model: MODEL, summary }, null, 2),
);
console.log(JSON.stringify({ model: MODEL, summary }, null, 2));
