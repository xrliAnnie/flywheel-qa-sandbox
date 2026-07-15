// FLY-968 V8 自动初筛 judge(两厂商通用) — model-as-judge,只做第一道筛,
// wav 样本保留给 founder 终审(方法学已在 shortlist evidence 预声明)。
// 每 wav 一次 generateContent(音频入):逐字转写 + 声学描述;再按厂商一次汇总
// 打分(可懂度 0-2 / 可区分度 0-3)+ 选 top3。
// usage: GEMINI_API_KEY=... node s4b-voice-judge.mjs <glob-prefix> <label>
//   e.g. node s4b-voice-judge.mjs out/s4a-voice- gemini
//        node s4b-voice-judge.mjs out/s3-voice-  openai

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { sleep } from "./lib/events.mjs";

if (!process.env.GEMINI_API_KEY) {
	console.error("GEMINI_API_KEY missing in env");
	process.exit(2);
}
const [, , prefix, label] = process.argv;
if (!prefix || !label) {
	console.error("usage: node s4b-voice-judge.mjs <prefix> <label>");
	process.exit(2);
}
const JUDGE_MODEL =
	process.env.FLYWHEEL_VOICE_JUDGE_MODEL ?? "gemini-2.5-flash";
const SENTENCE = "大家好，我是语音会议里的工程 Lead。Huddle 模式今天可以用了。";

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const dir = prefix.split("/").slice(0, -1).join("/") || ".";
const base = prefix.split("/").at(-1);
const files = readdirSync(dir)
	.filter((f) => f.startsWith(base) && f.endsWith(".wav"))
	.sort();

const perVoice = [];
for (const f of files) {
	const voice = f.slice(base.length, -4);
	const audio = readFileSync(`${dir}/${f}`);
	const res = await client.models.generateContent({
		model: JUDGE_MODEL,
		contents: [
			{
				role: "user",
				parts: [
					{
						inlineData: {
							mimeType: "audio/wav",
							data: audio.toString("base64"),
						},
					},
					{
						text:
							`这段音频应该念的是:「${SENTENCE}」。请输出 JSON(不要 markdown 包裹):` +
							`{"transcript":"逐字转写","verbatim":"完全一致|轻微出入|明显出入",` +
							`"intelligibility":0-2 整数(0=不可懂或重外国口音,1=可懂有瑕疵,2=自然母语级),` +
							`"gender":"男|女|中性","pitch":"低|中|高","timbre":"一句话音色描述",` +
							`"accentNotes":"口音/发音问题一句话,没有就写 无"}`,
					},
				],
			},
		],
	});
	let judged = null;
	try {
		judged = JSON.parse(
			res.text.replace(/^```json?\s*/i, "").replace(/```\s*$/, ""),
		);
	} catch {
		judged = { parseError: res.text.slice(0, 200) };
	}
	perVoice.push({ voice, file: `${dir}/${f}`, ...judged });
	console.error(
		`[${voice}] intel=${judged.intelligibility} ${judged.gender ?? ""} ${judged.timbre ?? ""}`,
	);
	await sleep(300);
}

// 汇总:两两可区分度 + top3
const res2 = await client.models.generateContent({
	model: JUDGE_MODEL,
	contents: [
		{
			role: "user",
			parts: [
				{
					text:
						`以下是 ${label} 厂商 ${perVoice.length} 个语音合成声线念同一句中文的评估结果:\n` +
						JSON.stringify(perVoice, null, 1) +
						`\n\n任务:为「多个 AI 同事在同一场语音会议里靠声线区分身份」选声线。` +
						`只在 intelligibility>=1 的声线里选。输出 JSON(不要 markdown 包裹):` +
						`{"top3":[{"voice":"名字","distinctness":0-3 整数(与另外两个入选者的两两区分度下限),"why":"一句话"}],` +
						`"usableCount":intelligibility>=1 的总数,"notes":"整体观察一句话"}`,
				},
			],
		},
	],
});
let ranking = null;
try {
	ranking = JSON.parse(
		res2.text.replace(/^```json?\s*/i, "").replace(/```\s*$/, ""),
	);
} catch {
	ranking = { parseError: res2.text.slice(0, 400) };
}
const out = { label, judgeModel: JUDGE_MODEL, perVoice, ranking };
writeFileSync(`out/s4b-judge-${label}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
