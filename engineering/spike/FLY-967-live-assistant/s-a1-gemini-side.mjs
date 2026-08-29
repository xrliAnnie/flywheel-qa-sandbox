/**
 * FLY-967 S-A1 spike — Gemini 侧三件事(throwaway,不进包):
 *   ① prebuilt voiceName 真机可用(voice-core P1 speechConfig 增量直验)
 *   ② systemPreamble 简报注入 → board 问题答题(outputTranscription 判据)
 *   ③ sendText 控制口 → 首音延迟(文字提示→第一个 response-audio chunk)
 * 用法: GEMINI_API_KEY=... node s-a1-gemini-side.mjs [voice ...]
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import {
	createGenaiTransport,
	GeminiLiveBackend,
	resolveConfig,
} from "../../../packages/voice-core/dist/index.js";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}s-a1-${Date.now()}.jsonl`;
const log = (o) => appendFileSync(LOG, `${JSON.stringify(o)}\n`);

const VOICES = process.argv.slice(2).length
	? process.argv.slice(2)
	: ["default", "Kore", "Puck", "Aoede", "Charon"];

const BRIEFING = buildBriefing();

const stubBrain = {
	async *respond() {
		yield "(spike stub — ask_lead 不在本 spike 范围)";
	},
};

function buildBriefing() {
	const board = [
		"## Board 快照(In Progress)",
		"- FLY-967 会议模式 A — 纯 Gemini Live 语音助理(/live 命令,Annie 拍板定名)",
		"- FLY-545 Huddle 模式 B — Gemini 耳朵 + Claude 人格 + 单嘴播音(D1-A 降级已激活)",
		"- FLY-927 infra alerts — 告警频道 bot 工单队列",
		"## In Review",
		"- FLY-954 provision sandbox escape root-cure",
		"## Todo",
		"- FLY-546 语音批准第三信号源(readback 精确匹配,默认 OFF)",
	].join("\n");
	const decisions = [
		"## 最近决策(近 14 天)",
		"- A/B 对比主轴改为「脑子」:B = Claude 人格+会议流程,A = 纯 Gemini+简报注入(545 S1 坐实 TEXT 模态全系不支持)",
		"- 「卡不卡」维度降权,「懂不懂我们」升首位",
		"- FLY-967 的 Discord 命令定名 /live(取代 design 建议的 /talk)",
	].join("\n");
	const docs = [
		"## 文档要点(voice PRD 摘录)",
		"- 会议助理的项目事实必须走工具查询,不许编造",
		"- 口语短句,零工程黑话;长答先一句 ack",
		"- 任何写动作只 readback 不执行,执行永远走 founder gate",
	].join("\n");
	const pad = "\n(简报填充行,模拟真实预算体量。)".repeat(60);
	return `[简报生成时间 15:00]\n${board}\n${decisions}\n${docs}${pad}`;
}

const SYSTEM_HINT = [
	"你是这个团队的会议助理。用口语短句回答,零工程黑话。",
	"项目事实只依据简报或工具查询,不许编。",
].join("\n");

function wavHeader(pcmLen, rate = 24000, ch = 1) {
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + pcmLen, 4);
	h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(ch, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * ch * 2, 28);
	h.writeUInt16LE(ch * 2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(pcmLen, 40);
	return h;
}

async function runVoice(voiceArg) {
	const voice = voiceArg === "default" ? undefined : voiceArg;
	const config = resolveConfig({}, process.env);
	const apiKey = process.env[config.gemini.apiKeyEnv];
	if (!apiKey) throw new Error(`${config.gemini.apiKeyEnv} not set`);
	const transport = createGenaiTransport({ apiKey });
	const backend = new GeminiLiveBackend({
		transport,
		profile: { model: config.gemini.model, asyncFunctionCalling: false },
	});

	const t0 = Date.now();
	const session = await backend.createConversation({
		brain: stubBrain,
		voice,
		systemHint: SYSTEM_HINT,
		systemPreamble: BRIEFING,
	});
	const connectMs = Date.now() - t0;

	const chunks = [];
	const transcript = [];
	let sentAt = 0;
	let firstChunkMs = null;
	let turnDone;
	let resolveTurn;
	const newTurn = () =>
		new Promise((r) => {
			resolveTurn = r;
		});
	session.on("response-audio", (chunk) => {
		if (firstChunkMs === null) firstChunkMs = Date.now() - sentAt;
		chunks.push(chunk);
	});
	session.on("transcript", (t) => {
		if (t.role === "assistant") transcript.push(t.text);
	});
	session.on("response-done", () => resolveTurn?.());
	session.on("error", (e) => {
		log({ voice: voiceArg, event: "error", message: e.message });
		resolveTurn?.();
	});

	const results = { voice: voiceArg, connectMs, turns: [] };
	const prompts = [
		"请用一两句话开场,报出简报生成时间。",
		"FLY-967 现在是什么状态?它的 Discord 命令定名是什么?",
	];
	for (const p of prompts) {
		chunks.length = 0;
		transcript.length = 0;
		firstChunkMs = null;
		turnDone = newTurn();
		sentAt = Date.now();
		session.sendText(p);
		await Promise.race([turnDone, new Promise((r) => setTimeout(r, 30_000))]);
		const pcm = Buffer.concat(chunks);
		results.turns.push({
			prompt: p,
			firstChunkMs,
			audioBytes: pcm.length,
			audioSec: +(pcm.length / 2 / 24_000).toFixed(1),
			transcript: transcript.join(""),
		});
		log({
			voice: voiceArg,
			prompt: p,
			firstChunkMs,
			transcript: transcript.join(""),
		});
		if (pcm.length) {
			const f = `${OUT}audition-${voiceArg}-${results.turns.length}.wav`;
			writeFileSync(f, Buffer.concat([wavHeader(pcm.length), pcm]));
		}
	}
	await session.close();
	return results;
}

const all = [];
for (const v of VOICES) {
	try {
		console.log(`--- voice: ${v}`);
		const r = await runVoice(v);
		all.push(r);
		for (const t of r.turns) {
			console.log(
				`  [${t.firstChunkMs}ms first-chunk, ${t.audioSec}s audio] ${t.transcript.slice(0, 120)}`,
			);
		}
	} catch (err) {
		console.error(`  voice ${v} FAILED:`, err.message);
		all.push({ voice: v, error: err.message });
		log({ voice: v, event: "fatal", message: err.message });
	}
}
writeFileSync(`${OUT}s-a1-summary.json`, JSON.stringify(all, null, 2));
console.log(`\nsummary → ${OUT}s-a1-summary.json\nlog → ${LOG}`);
