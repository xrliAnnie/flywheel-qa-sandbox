// FLY-980 S7 — 8-Lead 声线 audition (V9)。三个子命令:
//   list                     — 拉 premade 声线表(labels 含 gender/age/accent)
//   synth <candidates.json>  — 每 Lead 候选 × zh/en/mix 三句合成(筛选档 flash_v2_5;
//                              --final 用 multilingual_v2 高质量档)
//   judge <dir>              — Gemini 参数化 judge(可懂度 0-2),逐样本打分 +
//                              per-Lead 汇总建议(可区分度 0-3)
// candidates.json: {"tadashi": ["voiceId1","voiceId2"], ...}
// 产物: ~/fly980-eleven/audition/<lead>/<voice>-<lang>.mp3/.wav + judge json
// env: ELEVENLABS_API_KEY / GEMINI_API_KEY (~/.flywheel/.env)
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API_BASE, requireApiKey, xi } from "./lib/eleven.mjs";
import { loadFlywheelEnv } from "./lib/env.mjs";

const AUD_DIR = join(homedir(), "fly980-eleven", "audition");

// 8-Lead persona 表(plan §S7 内联;edge-tts 列=对照基线)
export const LEADS = {
	tadashi: { want: "男声 Professional 工程口吻", edge: "zh-CN-YunyangNeural" },
	cass: { want: "女声 Warm 总管温和", edge: "zh-CN-XiaoxiaoNeural" },
	honeylemon: { want: "女声 Lively 产品共创活泼", edge: "zh-CN-XiaoyiNeural" },
	mufasa: { want: "男声 沉稳导师", edge: "zh-CN-YunjianNeural(-10%)" },
	belle: { want: "女声 Bright 辨识度高", edge: "zh-CN-shaanxi-XiaoniNeural" },
	peter: { want: "男声 Sunshine", edge: "zh-CN-YunxiNeural" },
	hiro: { want: "男声 年轻感", edge: "zh-CN-YunxiaNeural" },
	simba: {
		want: "wildcard 不报身份也能听辨",
		edge: "zh-CN-liaoning-XiaobeiNeural",
	},
};

// 样句: zh 逐字沿用 s4b(跨厂商可比);en/mix 全 Lead 统一(D11'/D12')
export const SENTENCES = {
	zh: "大家好，我是语音会议里的工程 Lead。Huddle 模式今天可以用了。",
	en: "Hi, this is your Flywheel lead speaking. Huddle mode is ready for today's meeting.",
	mix: "帮我 check 一下 FLY-980 的 PR，CI 过了就可以 approve 了。",
};

const [, , cmd, arg1] = process.argv;
const FINAL = process.argv.includes("--final");

if (cmd === "list") {
	const key = requireApiKey();
	const data = await xi("/v2/voices?page_size=100", { key });
	const rows = (data.voices ?? []).map((v) => ({
		voice_id: v.voice_id,
		name: v.name,
		category: v.category,
		labels: v.labels,
		languages: (v.verified_languages ?? []).map((l) => l.language),
	}));
	mkdirSync("out", { recursive: true });
	writeFileSync("out/voices.json", JSON.stringify(rows, null, 2));
	for (const r of rows) {
		console.log(
			`${r.voice_id}  ${r.name}  [${r.category}]  ${JSON.stringify(r.labels)}`,
		);
	}
	console.log(`${rows.length} voices → out/voices.json`);
} else if (cmd === "synth") {
	const key = requireApiKey();
	const candidates = JSON.parse(readFileSync(arg1, "utf8"));
	const modelId = FINAL ? "eleven_multilingual_v2" : "eleven_flash_v2_5";
	const langs = FINAL ? ["zh", "en"] : ["zh", "en", "mix"];
	for (const [lead, voices] of Object.entries(candidates)) {
		const dir = join(AUD_DIR, lead);
		mkdirSync(dir, { recursive: true });
		for (const vid of voices) {
			for (const lang of langs) {
				const outBase = join(dir, `${vid}-${lang}${FINAL ? "-final" : ""}`);
				const res = await fetch(
					`${API_BASE}/v1/text-to-speech/${vid}?output_format=mp3_44100_128`,
					{
						method: "POST",
						headers: { "xi-api-key": key, "content-type": "application/json" },
						body: JSON.stringify({ text: SENTENCES[lang], model_id: modelId }),
					},
				);
				if (!res.ok) {
					console.error(
						`FAIL ${lead}/${vid}/${lang}: ${res.status} ${(await res.text()).slice(0, 200)}`,
					);
					continue;
				}
				const buf = Buffer.from(await res.arrayBuffer());
				writeFileSync(`${outBase}.mp3`, buf);
				execFileSync("ffmpeg", [
					"-y",
					"-loglevel",
					"error",
					"-i",
					`${outBase}.mp3`,
					`${outBase}.wav`,
				]);
				console.log(`ok ${lead}/${vid}/${lang} (${modelId})`);
			}
		}
	}
	console.log(`samples → ${AUD_DIR}`);
} else if (cmd === "judge") {
	loadFlywheelEnv();
	resolveGeminiKey();
	if (!process.env.GEMINI_API_KEY) {
		console.error("GEMINI_API_KEY missing (~/.flywheel/.env or ~/.zshrc)");
		process.exit(2);
	}
	const judgeModel = process.env.FLY980_JUDGE_MODEL ?? "gemini-2.5-flash";
	const root = arg1 ?? AUD_DIR;
	const perSample = [];
	for (const lead of readdirSync(root)) {
		const dir = join(root, lead);
		let files;
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".mp3"));
		} catch {
			continue;
		}
		for (const f of files) {
			const m = f.match(/^(.+)-(zh|en|mix)(-final)?\.mp3$/);
			if (!m) continue;
			const [, vid, lang] = m;
			const audio = readFileSync(join(dir, f));
			const judged = await geminiJudge(judgeModel, audio, SENTENCES[lang]);
			perSample.push({
				lead,
				voice_id: vid,
				lang,
				file: join(dir, f),
				...judged,
			});
			console.error(
				`[${lead}/${vid}/${lang}] intel=${judged.intelligibility} ${judged.gender ?? ""} ${judged.timbre ?? ""}`,
			);
			await new Promise((r) => setTimeout(r, 300));
		}
	}
	// per-Lead 汇总: persona 契合 + 终选建议 + 跨 Lead 可区分度
	const summaryPrompt = [
		"你是声线选配评委。下面是 8 个角色的 persona 要求和候选声线的逐样本评测。",
		"为每个角色选 1 个最合适的 voice_id(同一 voice 的 zh/en/mix 表现都要好——",
		"一把声线中英通吃是硬要求),给出理由;然后对 8 个终选声线两两比较,",
		"给整体可区分度打分(0-3, 3=闭眼能分清)。输出 JSON(不要 markdown):",
		'{"picks":{"<lead>":{"voice_id":"...","reason":"..."}},"distinctiveness":0-3,"notes":"..."}',
		`persona 要求: ${JSON.stringify(Object.fromEntries(Object.entries(LEADS).map(([k, v]) => [k, v.want])))}`,
		`逐样本评测: ${JSON.stringify(perSample.map(({ file, ...rest }) => rest))}`,
	].join("\n");
	const summary = await geminiText(judgeModel, summaryPrompt);
	mkdirSync("out", { recursive: true });
	writeFileSync(
		"out/audition-judge.json",
		JSON.stringify({ perSample, summary }, null, 2),
	);
	console.log(JSON.stringify(summary, null, 2));
	console.log("full → out/audition-judge.json");
} else {
	console.error(
		"usage: node audition.mjs list | synth <candidates.json> [--final] | judge [dir]",
	);
	process.exit(2);
}

// gemini-image skill 同款 key 解析链: env → ~/.zshrc 的 export 行
function resolveGeminiKey() {
	if (process.env.GEMINI_API_KEY) return;
	try {
		const zshrc = readFileSync(join(homedir(), ".zshrc"), "utf8");
		for (const name of [
			"GEMINI_API_KEY",
			"GEMINI_IMAGE_API_KEY",
			"NANOBANANA_GEMINI_API_KEY",
		]) {
			const m = zshrc.match(
				new RegExp(`^export ${name}=["']?([^"'\\n]+)["']?$`, "m"),
			);
			if (m) {
				process.env.GEMINI_API_KEY = m[1];
				return;
			}
		}
	} catch {
		// no zshrc — caller reports the missing key
	}
}

async function geminiCall(model, parts) {
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ contents: [{ role: "user", parts }] }),
		},
	);
	const json = await res.json();
	const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	try {
		return JSON.parse(text.replace(/^```json?\s*/i, "").replace(/```\s*$/, ""));
	} catch {
		return { parseError: text.slice(0, 300) };
	}
}

function geminiJudge(model, audioBuf, sentence) {
	return geminiCall(model, [
		{
			inlineData: { mimeType: "audio/mp3", data: audioBuf.toString("base64") },
		},
		{
			text:
				`这段音频应该念的是:「${sentence}」。请输出 JSON(不要 markdown 包裹):` +
				`{"transcript":"逐字转写","verbatim":"完全一致|轻微出入|明显出入",` +
				`"intelligibility":0-2 整数(0=不可懂或重外国口音,1=可懂有瑕疵,2=自然母语级),` +
				`"gender":"男|女|中性","pitch":"低|中|高","timbre":"一句话音色描述",` +
				`"accentNotes":"口音/发音问题一句话,没有就写 无"}`,
		},
	]);
}

function geminiText(model, prompt) {
	return geminiCall(model, [{ text: prompt }]);
}
