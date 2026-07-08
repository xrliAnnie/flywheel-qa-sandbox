#!/usr/bin/env node
/**
 * FLY-546 A4 — per-agent voice audition kit.
 *
 * Synthesizes one fixed headline sample across all 8 zh-CN edge-tts voices
 * (base + two prosody variants each) into ~/fly546-audition/, plus an
 * index.md with the voice roster and the PROPOSED default per-Lead mapping.
 * Annie listens and finalizes the mapping with Honey Lemon; changing a
 * Lead's voice afterwards = edit one `leads[].voice` line in the project
 * config (see index.md footer for the exact shape).
 *
 * Usage: node scripts/voice-audition-fly546.mjs [outDir]
 * Requires: edge-tts on PATH (`pip install edge-tts`).
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const SAMPLE_TEXT =
	"我是 Tadashi。FLY-546,耳机模式——正在实现。有一件事想跟你确认:语音批准的收据卡要不要带 PR 链接?";

/** Full zh-CN roster (edge-tts --list-voices, research.md §1). */
const VOICES = [
	{ id: "zh-CN-XiaoxiaoNeural", gender: "女", tone: "Warm(现全局默认)" },
	{ id: "zh-CN-XiaoyiNeural", gender: "女", tone: "Lively" },
	{ id: "zh-CN-YunjianNeural", gender: "男", tone: "Passion" },
	{ id: "zh-CN-YunxiNeural", gender: "男", tone: "Lively, Sunshine" },
	{ id: "zh-CN-YunxiaNeural", gender: "男", tone: "Cute" },
	{ id: "zh-CN-YunyangNeural", gender: "男", tone: "Professional, Reliable" },
	{
		id: "zh-CN-liaoning-XiaobeiNeural",
		gender: "女",
		tone: "东北口音, Humorous",
	},
	{ id: "zh-CN-shaanxi-XiaoniNeural", gender: "女", tone: "陕西口音, Bright" },
];

/** base + two prosody variants per voice (same grammar as leads[].voice). */
const VARIANTS = [
	{ suffix: "", args: [] },
	{ suffix: "-slow", args: ["--rate=-15%"] },
	{ suffix: "-bright", args: ["--pitch=+20Hz"] },
];

/**
 * PROPOSED default mapping (A4.2) — a starting point only; the final
 * per-Lead voice is Annie & Honey Lemon's product call. Engineering's job
 * is that swapping = one config line.
 */
const PROPOSED_MAPPING = [
	["Tadashi(Eng Lead)", "zh-CN-YunyangNeural", "男声,Professional——工程口吻"],
	["Aunt Cass(CoS)", "zh-CN-XiaoxiaoNeural", "女声,Warm——总管温和"],
	[
		"Honey Lemon(Product Lead)",
		"zh-CN-XiaoyiNeural",
		"女声,Lively——产品共创活泼",
	],
	[
		"Mufasa(growth 陪练)",
		"zh-CN-YunjianNeural + rate -10%",
		"男声,Passion 降速——沉稳导师",
	],
	["Belle(生活助理)", "zh-CN-shaanxi-XiaoniNeural", "女声,Bright,口音辨识度高"],
	["Peter(GeoForge3D product)", "zh-CN-YunxiNeural", "男声,Sunshine"],
	["Hiro(Joy-Con)", "zh-CN-YunxiaNeural", "男声,Cute——年轻感"],
	[
		"Simba(GeoForge3D cos)",
		"zh-CN-liaoning-XiaobeiNeural",
		"东北口音,不报身份也能听辨的 wildcard 位",
	],
];

const outDir = process.argv[2] ?? join(homedir(), "fly546-audition");
mkdirSync(outDir, { recursive: true });

const rows = [];
let failures = 0;
for (const voice of VOICES) {
	for (const variant of VARIANTS) {
		const file = `${voice.id}${variant.suffix}.mp3`;
		const outPath = join(outDir, file);
		try {
			await run("edge-tts", [
				"--voice",
				voice.id,
				...variant.args,
				"--text",
				SAMPLE_TEXT,
				"--write-media",
				outPath,
			]);
			rows.push({ voice, variant, file, ok: true });
			console.log(`ok   ${file}`);
		} catch (err) {
			failures++;
			rows.push({ voice, variant, file, ok: false });
			console.error(`FAIL ${file}: ${err?.message ?? err}`);
		}
	}
}

const index = `# FLY-546 声线 audition kit

样本文本(固定报头,所有声线同文):
> ${SAMPLE_TEXT}

## 声线一览(${rows.filter((r) => r.ok).length}/${rows.length} 合成成功)

| 文件 | 声线 | 性别 | 音色 | 变体 |
|------|------|------|------|------|
${rows
	.map(
		(r) =>
			`| ${r.ok ? r.file : `~~${r.file}~~(失败)`} | ${r.voice.id} | ${r.voice.gender} | ${r.voice.tone} | ${
				r.variant.suffix === ""
					? "base"
					: r.variant.suffix === "-slow"
						? "rate -15%"
						: "pitch +20Hz"
			} |`,
	)
	.join("\n")}

## 提议默认映射(A4.2 —— 最终由 Annie 和 Honey Lemon 拍板)

| Lead | 声线 | 理由 |
|------|------|------|
${PROPOSED_MAPPING.map(([lead, v, why]) => `| ${lead} | ${v} | ${why} |`).join("\n")}

默认 fallback(未配置的 agent):zh-CN-XiaoxiaoNeural(现全局默认,字节兼容)。

## 换声线 = 改一行 config(A4.3 工程合同)

项目 config 的 leads[] 里加/改 \`voice\` 字段即可,Bridge 重启后生效:

\`\`\`json
{ "agentId": "flywheel-eng-lead", "voice": { "voiceId": "zh-CN-YunyangNeural", "rate": "-10%", "pitch": "+2Hz" } }
\`\`\`

rate 必须 ±N%(如 "-10%"),pitch 必须 ±NHz(如 "+2Hz");格式错误 config 加载即报错。
`;
writeFileSync(join(outDir, "index.md"), index, "utf8");
console.log(`\nwrote ${join(outDir, "index.md")}`);
if (failures > 0) {
	console.error(`${failures} synth failure(s) — see index.md`);
	process.exit(1);
}
