// FLY-968 P3 — multi-Gemini-Live 编排主实验(V3-V7,问①核心):
//   T3-a 连通(V3):3 条并发 Live session、声线互异(P3a top3),各自报身份收 wav
//   T3-b all-listen 服从性(V4):点名句 ×10 轮全量推 3 条 session,统计未点名者出声
//   T3-c gated+补喂(V5):①founder 文本补喂 5 段+点名提问 ②跨 agent 事实注入+负对照
//   T3-d 延迟(V6):3 并发下被点名者 speech-end→首 audio chunk(从 T3-b 轮提取)
//   T3-e 成本(V7):per-session 音频秒数实测 + usageMetadata(若下发)
//
// usage: GEMINI_API_KEY=... node s4-gemini-multisession.mjs [phase]  (phase ∈ a|b|c|all)

import { readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import { makeLogger, pcmToWav, sleep } from "./lib/events.mjs";

if (!process.env.GEMINI_API_KEY) {
	console.error("GEMINI_API_KEY missing in env");
	process.exit(2);
}
const MODEL =
	process.env.FLYWHEEL_VOICE_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview";
const PHASE = process.argv[2] ?? "all";
const { now, logEvent } = makeLogger("out/s4-multisession.jsonl");

const FRAME_BYTES = 640; // 16k s16le mono 20ms
const FRAME_MS = 20;
const silenceFrame = Buffer.alloc(FRAME_BYTES);
const SPEECH_BYTES_THRESHOLD = 12_000; // ~0.25s@24k s16le,低于此视为「没出声」

const LEADS = [
	{
		name: "Tadashi",
		voice: "Fenrir",
		persona:
			"你是 Tadashi,工程 Lead。你知道的内部信息:这次部署的内部代号是「蓝鲸七号」,今天的部署进展顺利。",
	},
	{
		name: "Honey Lemon",
		voice: "Sulafat",
		persona: "你是 Honey Lemon,产品 Lead。你最近在想语音会议的新交互形态。",
	},
	{
		name: "Hiro",
		voice: "Puck",
		persona: "你是 Hiro,Joy-Con 项目的 Lead。项目下一步是打字延迟优化。",
	},
];
const DISCIPLINE =
	"你在一场多人语音会议里,会议里还有其他 AI 同事。铁律:只有当发言者叫到你的名字时你才说话;" +
	"没点你名时必须完全保持沉默,一个字都不要说,也不要发出任何声音。" +
	"被点名时用中文口语短句回答,一两句话即可。";

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── session 包装:每条连接自带事件簿 ──────────────────────────
async function openLead(lead) {
	const s = {
		lead,
		chunks: [],
		roundAudioBytes: 0,
		roundOutTx: "",
		roundInTx: "",
		roundFirstAudioMs: null,
		totalAudioOutBytes: 0,
		totalAudioInMs: 0,
		usage: [],
		turnDone: null,
		session: null,
		errors: [],
	};
	s.session = await client.live.connect({
		model: MODEL,
		config: {
			responseModalities: [Modality.AUDIO],
			speechConfig: {
				voiceConfig: { prebuiltVoiceConfig: { voiceName: lead.voice } },
			},
			inputAudioTranscription: {},
			outputAudioTranscription: {},
			systemInstruction: {
				parts: [{ text: `${DISCIPLINE}\n${lead.persona}` }],
			},
		},
		callbacks: {
			onmessage: (msg) => {
				const t = now();
				const sc = msg?.serverContent;
				if (msg?.usageMetadata) s.usage.push(msg.usageMetadata);
				if (sc?.inputTranscription?.text)
					s.roundInTx += sc.inputTranscription.text;
				if (sc?.outputTranscription?.text)
					s.roundOutTx += sc.outputTranscription.text;
				for (const p of sc?.modelTurn?.parts ?? []) {
					if (p?.inlineData?.data) {
						const buf = Buffer.from(p.inlineData.data, "base64");
						s.chunks.push(buf);
						s.roundAudioBytes += buf.length;
						s.totalAudioOutBytes += buf.length;
						if (s.roundFirstAudioMs === null) s.roundFirstAudioMs = t;
					}
				}
				if (sc?.turnComplete) s.turnDone?.();
			},
			onerror: (e) => {
				s.errors.push(String(e?.message ?? e));
				logEvent({
					type: "error",
					lead: lead.name,
					message: String(e?.message ?? e),
				});
			},
			onclose: (e) =>
				logEvent({
					type: "close",
					lead: lead.name,
					reason: String(e?.reason ?? ""),
				}),
		},
	});
	return s;
}

const resetRound = (s) => {
	s.chunks = [];
	s.roundAudioBytes = 0;
	s.roundOutTx = "";
	s.roundInTx = "";
	s.roundFirstAudioMs = null;
};

const sendAudioFrame = (s, frame) => {
	s.session.sendRealtimeInput({
		audio: { data: frame.toString("base64"), mimeType: "audio/pcm;rate=16000" },
	});
};

// 把一段 16k PCM 以实时节奏同时推给一组 session;返回 speech-end 时刻
async function broadcastSpeech(targets, pcm, { leadSilenceFrames = 15 } = {}) {
	for (let k = 0; k < leadSilenceFrames; k++) {
		for (const s of targets) sendAudioFrame(s, silenceFrame);
		await sleep(FRAME_MS);
	}
	for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
		const frame = pcm.subarray(off, off + FRAME_BYTES);
		for (const s of targets) sendAudioFrame(s, frame);
		await sleep(FRAME_MS);
	}
	const speechEnd = now();
	for (const s of targets)
		s.totalAudioInMs +=
			leadSilenceFrames * FRAME_MS + (pcm.length / FRAME_BYTES) * FRAME_MS;
	return speechEnd;
}

// speech 之后持续给 targets 喂静音,直到全部 turnComplete 或超时
async function awaitTurns(targets, timeoutMs = 15_000) {
	const dones = targets.map(
		(s) =>
			new Promise((resolve) => {
				s.turnDone = resolve;
			}),
	);
	let silencing = true;
	const silencer = (async () => {
		while (silencing) {
			for (const s of targets) sendAudioFrame(s, silenceFrame);
			await sleep(FRAME_MS);
		}
	})();
	const outcome = await Promise.race([
		Promise.all(dones).then(() => "all-done"),
		sleep(timeoutMs).then(() => "timeout"),
	]);
	silencing = false;
	await silencer;
	for (const s of targets) s.turnDone = null;
	return outcome;
}

const results = { model: MODEL, phases: {} };

// ═══ T3-a 连通(V3) ═══════════════════════════════════════════
async function phaseA() {
	const t0 = now();
	const leads = await Promise.all(LEADS.map(openLead)); // 3 条并发建立
	const connectMs = now() - t0;
	logEvent({ type: "t3a-connected", connectMs });
	const intro = [];
	for (const s of leads) {
		resetRound(s);
		s.session.sendClientContent({
			turns: [
				{
					role: "user",
					parts: [
						{
							text: `${s.lead.name},请用一句话自报身份(你的名字和角色)。`,
						},
					],
				},
			],
			turnComplete: true,
		});
		const done = new Promise((r) => {
			s.turnDone = r;
		});
		await Promise.race([done, sleep(15_000)]);
		s.turnDone = null;
		const pcm = Buffer.concat(s.chunks);
		if (pcm.length > 0)
			writeFileSync(
				`out/s4-intro-${s.lead.name.replace(" ", "")}.wav`,
				pcmToWav(pcm, 24000),
			);
		intro.push({
			lead: s.lead.name,
			voice: s.lead.voice,
			audioBytes: pcm.length,
			outTx: s.roundOutTx,
			errors: s.errors.slice(),
		});
		console.error(
			`[t3a ${s.lead.name}/${s.lead.voice}] ${(pcm.length / 48000).toFixed(1)}s "${s.roundOutTx.slice(0, 60)}"`,
		);
	}
	results.phases.a = {
		concurrentReady: leads.length,
		connectMs,
		intro,
		verdict3Ready: intro.every((i) => i.audioBytes > 0),
	};
	return leads;
}

// ═══ T3-b all-listen(V4) + T3-d 延迟(V6) ═════════════════════
async function phaseB(leads) {
	const ORDER = [
		"u3a",
		"u3b",
		"u3c",
		"u3a",
		"u3b",
		"u3c",
		"u3a",
		"u3b",
		"u3c",
		"u3a",
	];
	const NAMED = {
		u3a: "Tadashi",
		u3b: "Honey Lemon",
		u3c: "Hiro",
	};
	const rounds = [];
	for (const [i, uid] of ORDER.entries()) {
		for (const s of leads) resetRound(s);
		const pcm = readFileSync(`ref/${uid}-16k.pcm`);
		logEvent({ type: "t3b-round-start", round: i + 1, uid, named: NAMED[uid] });
		const speechEnd = await broadcastSpeech(leads, pcm);
		const outcome = await awaitTurns(leads, 15_000);
		const perLead = leads.map((s) => ({
			lead: s.lead.name,
			named: s.lead.name === NAMED[uid],
			audioBytes: s.roundAudioBytes,
			spoke: s.roundAudioBytes > SPEECH_BYTES_THRESHOLD,
			firstAudio_ms:
				s.roundFirstAudioMs !== null ? s.roundFirstAudioMs - speechEnd : null,
			outTx: s.roundOutTx.slice(0, 100),
		}));
		rounds.push({ round: i + 1, uid, named: NAMED[uid], outcome, perLead });
		const named = perLead.find((p) => p.named);
		const offenders = perLead
			.filter((p) => !p.named && p.spoke)
			.map((p) => p.lead);
		console.error(
			`[t3b r${i + 1} →${NAMED[uid]}] namedSpoke=${named.spoke} firstAudio=${named.firstAudio_ms}ms offenders=[${offenders.join(",")}]`,
		);
		await sleep(800);
	}
	const violations = rounds.reduce(
		(n, r) => n + r.perLead.filter((p) => !p.named && p.spoke).length,
		0,
	);
	const roundsWithViolation = rounds.filter((r) =>
		r.perLead.some((p) => !p.named && p.spoke),
	).length;
	const namedMiss = rounds.filter(
		(r) => !r.perLead.find((p) => p.named)?.spoke,
	).length;
	const namedLatencies = rounds
		.map((r) => r.perLead.find((p) => p.named)?.firstAudio_ms)
		.filter((v) => v !== null && v !== undefined);
	results.phases.b = {
		rounds,
		violations,
		roundsWithViolation,
		namedMiss,
		namedLatencies,
	};
	console.error(
		`[t3b] roundsWithViolation=${roundsWithViolation}/10 namedMiss=${namedMiss} latencies=${JSON.stringify(namedLatencies)}`,
	);
}

// ═══ T3-c gated + 补喂(V5,两层场景+负对照) ═══════════════════
// FLYWHEEL_FEED_METHOD=cc → sendClientContent(turnComplete:false)(s4c 证明的静默通路);
// 默认 rt → sendRealtimeInput(text)(3.1 上会触发出声,首跑实录)。
const FEED_METHOD = process.env.FLYWHEEL_FEED_METHOD ?? "rt";
const injectText = (s, text) => {
	if (FEED_METHOD === "cc")
		s.session.sendClientContent({
			turns: [{ role: "user", parts: [{ text }] }],
			turnComplete: false,
		});
	else s.session.sendRealtimeInput({ text });
};

async function phaseC() {
	// 全新三条 session(干净上下文)
	const leads = await Promise.all(LEADS.map(openLead));
	const [tadashi, honey, hiro] = leads;

	// ① founder 发言补喂:5 段文本注入 Tadashi(不推音频),补喂过程必须零出声
	const feedSegments = [
		"(会议记录)Annie:我们先过一下这周的安排。",
		"(会议记录)Annie:发布时间定在周五下午三点。",
		"(会议记录)Annie:市场那边的物料周四要收齐。",
		"(会议记录)Annie:QA 这轮重点盯语音链路。",
		"(会议记录)Annie:有问题随时在会上叫人。",
	];
	resetRound(tadashi);
	for (const seg of feedSegments) {
		injectText(tadashi, seg);
		logEvent({
			type: "t3c-feed",
			to: "Tadashi",
			method: FEED_METHOD,
			payload: seg,
		});
		await sleep(700);
	}
	await sleep(2500); // 观察窗:补喂后是否抢答
	const feedSpokeBytes = tadashi.roundAudioBytes;
	const feedSpoke = feedSpokeBytes > SPEECH_BYTES_THRESHOLD;
	console.error(
		`[t3c-①feed] Tadashi bytes-during-feed=${feedSpokeBytes} spoke=${feedSpoke}`,
	);

	// 点名提问:发布时间(u5,只推 Tadashi = gated)
	resetRound(tadashi);
	const u5 = readFileSync("ref/u5-16k.pcm");
	const end5 = await broadcastSpeech([tadashi], u5);
	await awaitTurns([tadashi], 15_000);
	const s1Answer = {
		outTx: tadashi.roundOutTx,
		firstAudio_ms:
			tadashi.roundFirstAudioMs !== null
				? tadashi.roundFirstAudioMs - end5
				: null,
		citesFact: /周五|下午三点|15[:点]/.test(tadashi.roundOutTx),
	};
	console.error(
		`[t3c-①ask] cites=${s1Answer.citesFact} "${s1Answer.outTx.slice(0, 80)}"`,
	);

	// ② 跨 agent:问 Tadashi 代号(gated 只推他)
	resetRound(tadashi);
	const u4a = readFileSync("ref/u4a-16k.pcm");
	const end4a = await broadcastSpeech([tadashi], u4a);
	await awaitTurns([tadashi], 15_000);
	const aAnswer = {
		outTx: tadashi.roundOutTx,
		firstAudio_ms:
			tadashi.roundFirstAudioMs !== null
				? tadashi.roundFirstAudioMs - end4a
				: null,
		containsFact: /蓝鲸七号/.test(tadashi.roundOutTx),
	};
	console.error(
		`[t3c-②A] fact=${aAnswer.containsFact} "${aAnswer.outTx.slice(0, 80)}"`,
	);

	// 负对照先行:Hiro 未补喂,同问(u4c) → 应答不出/瞎编
	resetRound(hiro);
	const u4c = readFileSync("ref/u4c-16k.pcm");
	await broadcastSpeech([hiro], u4c);
	await awaitTurns([hiro], 15_000);
	const negControl = {
		outTx: hiro.roundOutTx,
		knowsFact: /蓝鲸七号/.test(hiro.roundOutTx),
	};
	console.error(
		`[t3c-②neg] knowsFact=${negControl.knowsFact} "${negControl.outTx.slice(0, 80)}"`,
	);

	// 把 A 的回答转写注入 Honey Lemon(逐字落 evidence)
	resetRound(honey);
	const injection = `(会议记录)Tadashi 刚才说:「${aAnswer.outTx.trim()}」`;
	injectText(honey, injection);
	logEvent({
		type: "t3c-inject",
		to: "Honey Lemon",
		method: FEED_METHOD,
		payload: injection,
	});
	await sleep(2500);
	const injectSpoke = honey.roundAudioBytes > SPEECH_BYTES_THRESHOLD;

	// 点名 Honey Lemon 问 A 的事实(u4b,gated 只推她)
	resetRound(honey);
	const u4b = readFileSync("ref/u4b-16k.pcm");
	const end4b = await broadcastSpeech([honey], u4b);
	await awaitTurns([honey], 15_000);
	const bAnswer = {
		outTx: honey.roundOutTx,
		firstAudio_ms:
			honey.roundFirstAudioMs !== null ? honey.roundFirstAudioMs - end4b : null,
		citesFact: /蓝鲸七号/.test(honey.roundOutTx),
	};
	console.error(
		`[t3c-②B] cites=${bAnswer.citesFact} "${bAnswer.outTx.slice(0, 80)}"`,
	);

	// T3-e 素材:per-session 音频量 + usage
	const usage = leads.map((s) => ({
		lead: s.lead.name,
		audioInApprox_s: +(s.totalAudioInMs / 1000).toFixed(1),
		audioOut_s: +(s.totalAudioOutBytes / 48000).toFixed(1),
		usageMetadataSamples: s.usage.slice(-2),
	}));
	for (const s of leads) s.session.close();
	results.phases.c = {
		feedMethod: FEED_METHOD,
		scene1: { feedSpokeBytes, feedSpoke, answer: s1Answer, feedSegments },
		scene2: {
			aAnswer,
			negControl,
			injectionPayload: injection,
			injectSpoke,
			bAnswer,
		},
		usage,
	};
}

// ═══ 执行 ════════════════════════════════════════════════════
let leadsA = null;
if (PHASE === "a" || PHASE === "b" || PHASE === "all") leadsA = await phaseA();
if (PHASE === "b" || PHASE === "all") await phaseB(leadsA);
if (leadsA) {
	results.phases.aUsage = leadsA.map((s) => ({
		lead: s.lead.name,
		audioInApprox_s: +(s.totalAudioInMs / 1000).toFixed(1),
		audioOut_s: +(s.totalAudioOutBytes / 48000).toFixed(1),
		usageMetadataSamples: s.usage.slice(-2),
	}));
	for (const s of leadsA) s.session.close();
}
if (PHASE === "c" || PHASE === "all") await phaseC();

writeFileSync(
	"out/s4-multisession-results.json",
	JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
process.exit(0);
