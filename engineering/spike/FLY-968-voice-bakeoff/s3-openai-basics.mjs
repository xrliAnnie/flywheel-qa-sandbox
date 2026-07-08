// FLY-968 P2 — OpenAI 基础面(V8-OpenAI 半 + V9):
//   ① 10 内置声线各念同一句中文(audio-out 短 session) → 落 wav(founder 终审素材)
//   ② 1 次真 function calling 往返(语音触发假 issue_status 工具)
//   ③ barge-in:response 播报中推新语音,记录 cancel 事件序列
//
// usage: OPENAI_API_KEY=... node s3-openai-basics.mjs [part]   (part ∈ voices|tool|barge|all)

import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { makeLogger, pcmToWav, sleep } from "./lib/events.mjs";

if (!process.env.OPENAI_API_KEY) {
	console.error("OPENAI_API_KEY missing in env");
	process.exit(2);
}
const MODEL = process.env.FLYWHEEL_VOICE_OPENAI_MODEL ?? "gpt-realtime-2.1";
const PART = process.argv[2] ?? "all";
const { now, logEvent } = makeLogger("out/s3-openai-basics.jsonl");
const VOICES = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"sage",
	"shimmer",
	"verse",
	"marin",
	"cedar",
];
const SENTENCE = "大家好，我是语音会议里的工程 Lead。Huddle 模式今天可以用了。";
const FRAME_BYTES = 960;
const FRAME_MS = 20;
const silenceFrame = Buffer.alloc(FRAME_BYTES);

function connect(sessionPatch, onMsg) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(
			`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
			{ headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } },
		);
		ws.on("open", () => {
			ws.send(
				JSON.stringify({ type: "session.update", session: sessionPatch }),
			);
		});
		ws.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (msg.type === "error") {
				logEvent({ type: "error-detail", error: msg.error });
				console.error(
					"[server error]",
					JSON.stringify(msg.error).slice(0, 300),
				);
			}
			if (msg.type === "session.updated") resolve(ws);
			onMsg(msg, ws);
		});
		ws.on("error", reject);
	});
}

async function streamSpeech(ws, pcm) {
	for (let k = 0; k < 15; k++) {
		ws.send(
			JSON.stringify({
				type: "input_audio_buffer.append",
				audio: silenceFrame.toString("base64"),
			}),
		);
		await sleep(FRAME_MS);
	}
	for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
		ws.send(
			JSON.stringify({
				type: "input_audio_buffer.append",
				audio: pcm.subarray(off, off + FRAME_BYTES).toString("base64"),
			}),
		);
		await sleep(FRAME_MS);
	}
}

// ── ① 声线 sweep ──────────────────────────────────────────────
async function partVoices() {
	const summary = [];
	for (const voice of VOICES) {
		const chunks = [];
		let done = null;
		const donePromise = new Promise((r) => {
			done = r;
		});
		const ws = await connect(
			{
				type: "realtime",
				output_modalities: ["audio"],
				audio: {
					output: { format: { type: "audio/pcm", rate: 24000 }, voice },
				},
			},
			(msg) => {
				if (msg.type === "response.output_audio.delta")
					chunks.push(Buffer.from(msg.delta, "base64"));
				if (msg.type === "response.done") done(msg.response?.status);
			},
		);
		ws.send(
			JSON.stringify({
				type: "response.create",
				response: {
					instructions: `一字不差地用中文念这句话，不要加任何别的内容：${SENTENCE}`,
				},
			}),
		);
		const status = await Promise.race([
			donePromise,
			sleep(20_000).then(() => "timeout"),
		]);
		const pcm = Buffer.concat(chunks);
		if (pcm.length > 0)
			writeFileSync(`out/s3-voice-${voice}.wav`, pcmToWav(pcm, 24000));
		summary.push({
			voice,
			status,
			audioBytes: pcm.length,
			seconds: +(pcm.length / 48000).toFixed(1),
		});
		console.error(
			`[voice ${voice}] ${status} ${(pcm.length / 48000).toFixed(1)}s`,
		);
		ws.close();
		await sleep(300);
	}
	writeFileSync("out/s3-voices-summary.json", JSON.stringify(summary, null, 2));
	return summary;
}

// ── ② function calling 往返 ──────────────────────────────────
async function partTool() {
	const events = [];
	let callDone = null;
	const callPromise = new Promise((r) => {
		callDone = r;
	});
	let finalDone = null;
	const finalPromise = new Promise((r) => {
		finalDone = r;
	});
	let phase = "call";
	let call = null;
	let finalText = "";
	const ws = await connect(
		{
			type: "realtime",
			output_modalities: ["text"],
			instructions:
				"你是工程 Lead。用户问 issue 状态时,必须调用 get_issue_status 工具。中文短句回答。",
			audio: {
				input: {
					format: { type: "audio/pcm", rate: 24000 },
					transcription: { model: "gpt-4o-mini-transcribe" },
					turn_detection: { type: "server_vad" },
				},
			},
			tools: [
				{
					type: "function",
					name: "get_issue_status",
					description: "查询 Linear issue 的当前状态和 PR 审批情况",
					parameters: {
						type: "object",
						properties: { issue_id: { type: "string" } },
						required: ["issue_id"],
					},
				},
			],
		},
		(msg) => {
			events.push(msg.type);
			if (msg.type === "response.function_call_arguments.done")
				call = {
					name: msg.name ?? "get_issue_status",
					call_id: msg.call_id,
					args: msg.arguments,
				};
			if (msg.type === "response.output_text.delta" && phase === "final")
				finalText += msg.delta ?? "";
			if (msg.type === "response.done") {
				if (phase === "call") callDone();
				else finalDone();
			}
		},
	);
	const pcm = readFileSync("ref/u2-24k.pcm");
	await streamSpeech(ws, pcm);
	const speechEnd = now();
	logEvent({ type: "tool-speech-end" });
	let silencing = true;
	const silencer = (async () => {
		while (silencing) {
			ws.send(
				JSON.stringify({
					type: "input_audio_buffer.append",
					audio: silenceFrame.toString("base64"),
				}),
			);
			await sleep(FRAME_MS);
		}
	})();
	await Promise.race([callPromise, sleep(20_000)]);
	silencing = false;
	await silencer;
	const callMs = now() - speechEnd;
	if (call) {
		phase = "final";
		ws.send(
			JSON.stringify({
				type: "conversation.item.create",
				item: {
					type: "function_call_output",
					call_id: call.call_id,
					output: JSON.stringify({
						issue: "FLY-968",
						status: "In Progress",
						pr: "not yet approved",
					}),
				},
			}),
		);
		ws.send(JSON.stringify({ type: "response.create" }));
		await Promise.race([finalPromise, sleep(20_000)]);
	}
	ws.close();
	const result = {
		toolCallFired: !!call,
		callArgs: call?.args ?? null,
		speechEndToCall_ms: call ? callMs : null,
		finalText,
		eventChain: events.filter((e) =>
			/function_call|response\.(created|done)|speech_/.test(e),
		),
	};
	writeFileSync("out/s3-tool-result.json", JSON.stringify(result, null, 2));
	console.error(
		`[tool] fired=${result.toolCallFired} args=${result.callArgs} final="${finalText.slice(0, 80)}"`,
	);
	return result;
}

// ── ③ barge-in ───────────────────────────────────────────────
async function partBarge() {
	const timeline = [];
	let audioDeltasBeforeBarge = 0;
	let audioDeltasAfterCancel = 0;
	let cancelled = false;
	let firstAudio = null;
	const ws = await connect(
		{
			type: "realtime",
			output_modalities: ["audio"],
			instructions: "你是工程 Lead。用中文详细回答,至少五句话。",
			audio: {
				input: {
					format: { type: "audio/pcm", rate: 24000 },
					turn_detection: { type: "server_vad" },
				},
				output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
			},
		},
		(msg) => {
			const t = now();
			if (
				/^(input_audio_buffer\.(speech_started|speech_stopped)|response\.(created|done|output_audio\.done)|conversation\.item\.truncated)$/.test(
					msg.type,
				) ||
				(msg.type === "response.done" && msg.response?.status)
			)
				timeline.push({ t, type: msg.type, status: msg.response?.status });
			if (msg.type === "response.output_audio.delta") {
				if (firstAudio === null) firstAudio = t;
				if (!cancelled) audioDeltasBeforeBarge++;
				else audioDeltasAfterCancel++;
			}
			if (msg.type === "response.done" && msg.response?.status === "cancelled")
				cancelled = true;
		},
	);
	await streamSpeech(ws, readFileSync("ref/u1-24k.pcm"));
	logEvent({ type: "barge-q1-end" });
	// 尾随静音让 server VAD 判定 speech 结束;有界等待首个 audio delta
	const waitStart = Date.now();
	while (firstAudio === null && Date.now() - waitStart < 20_000) {
		ws.send(
			JSON.stringify({
				type: "input_audio_buffer.append",
				audio: silenceFrame.toString("base64"),
			}),
		);
		await sleep(FRAME_MS);
	}
	if (firstAudio === null) {
		ws.close();
		const result = {
			cancelled: false,
			error: "no-audio-response-within-20s",
			timeline,
		};
		writeFileSync("out/s3-barge-result.json", JSON.stringify(result, null, 2));
		return result;
	}
	await sleep(400); // 让它播一会儿
	const bargeStart = now();
	timeline.push({ t: bargeStart, type: "CLIENT:barge-speech-start" });
	await streamSpeech(ws, readFileSync("ref/u3a-24k.pcm"));
	// 静音尾巴等服务端反应
	for (let k = 0; k < 100; k++) {
		ws.send(
			JSON.stringify({
				type: "input_audio_buffer.append",
				audio: silenceFrame.toString("base64"),
			}),
		);
		await sleep(FRAME_MS);
	}
	await sleep(3000);
	ws.close();
	const cancelEvt = timeline.find(
		(e) => e.type === "response.done" && e.status === "cancelled",
	);
	const result = {
		cancelled,
		bargeToCancel_ms: cancelEvt ? cancelEvt.t - bargeStart : null,
		audioDeltasBeforeBarge,
		audioDeltasAfterCancel,
		timeline,
	};
	writeFileSync("out/s3-barge-result.json", JSON.stringify(result, null, 2));
	console.error(
		`[barge] cancelled=${cancelled} bargeToCancel=${result.bargeToCancel_ms}ms deltasAfterCancel=${audioDeltasAfterCancel}`,
	);
	return result;
}

const out = {};
if (PART === "voices" || PART === "all") out.voices = await partVoices();
if (PART === "tool" || PART === "all") out.tool = await partTool();
if (PART === "barge" || PART === "all") out.barge = await partBarge();
console.log(JSON.stringify({ model: MODEL, ...out }, null, 2));
process.exit(0);
