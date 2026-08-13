#!/usr/bin/env node
/**
 * FLY-1704 轮 5 —— 「清新」方向的 6 个不同解法。
 *
 * Annie:「暖纸 and 柔卡 id better but not perfect... I like more 清新 style」
 * ⇒ 以暖纸 + 柔卡为底，往通透 / 干净 / 轻 / 有呼吸感推。不是冷淡，是清爽。
 *
 * ── 关于 frontend-design skill（Annie 直接问的，答案见 SKILL-AUDIT.md）──
 * 这个 skill **调不到**（Skill 工具返回 Unknown skill）。但我**读了磁盘上的文件**，
 * 并把它里面三条能用的方针写进了下面的 prompt —— 这跟「用了 skill」不是一回事，
 * 措辞上不含糊：
 *   1. 别用 Inter / Roboto / Arial / 系统字体这类通用字体，要有个性的显示字 + 精致正文字配对
 *   2. **「主色 + 尖锐强调色」胜过「平均分布的怯懦调色板」**
 *      ← 这条正好是我前几轮的病:9 个角色色平均用力 = 每个都不突出
 *   3. 明令避开 AI 味套路，尤其**白底紫渐变**
 * 它给的是审美方针,不是排版参数(没有行高/字号阶/间距刻度/对比度数值),
 * 而且它面向的是「写代码」不是「出概念图」。
 *
 *   node gen-fresh.mjs [id ...] [--codex]
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DIR = dirname(fileURLToPath(import.meta.url));

const FRESH = [
	{
		id: "mist",
		name: "晨雾",
		feel: "刚睡醒拉开窗帘 —— 淡、静、有空气。",
		brief: `Palest cool grey-blue wash over an off-white page. A refined light-weight serif for headlines paired with a clean humanist sans for body. Hairline dividers at barely 8% opacity. Enormous vertical breathing room between stories. One single sharp deep-teal accent, used only on links and one small marker — everything else is air.`,
	},
	{
		id: "mint",
		name: "薄荷纸",
		feel: "清爽、干净 —— 像洗过的白衬衫。",
		brief: `Warm off-white paper with very pale mint-green tinted blocks that read as light washes rather than cards — no borders, no shadows, just soft tinted shapes with big radii. Light-weight geometric sans throughout, wide letter spacing on small labels. One sharp emerald accent for links. Airy, crisp, uncluttered.`,
	},
	{
		id: "yuzu",
		name: "柚子",
		feel: "有点甜但不腻 —— 早晨那杯温水加柠檬。",
		brief: `Soft warm cream background with pale butter-yellow and light apricot tints. Cards are defined only by a 1px very light warm outline, never shadows. A characterful rounded serif for titles against a light grainy-textured sans for body. One sharp tangerine accent used sparingly. Cheerful, warm, and light — never heavy or saturated.`,
	},
	{
		id: "seasalt",
		name: "海盐",
		feel: "通透、微凉 —— 像早上的海边空气。",
		brief: `Cool near-white page with translucent pale sky-blue and sand-beige panels that look like frosted glass — soft blur, no hard edges. Elegant light serif display type, small crisp sans metadata. Very generous margins, a narrow measure of text. A single sharp navy accent. Feels open, breezy, weightless.`,
	},
	{
		id: "grass",
		name: "草叶",
		feel: "自然、不紧绷 —— 窗边有植物的房间。",
		brief: `Clean white with the palest sage and celadon tints. Fine hairline rules in warm grey. A distinctive high-contrast serif for headlines paired with a quiet grotesque for body. Botanical restraint: lots of white, small type, one sharp forest-green accent. Organic and calm without being decorative.`,
	},
	{
		id: "blossom",
		name: "樱白",
		feel: "柔和、有一点点温柔 —— 但不是粉红少女。",
		brief: `White page with the faintest blush and warm-grey tints, kept desaturated and grown-up. Delicate light-weight display serif with wide tracking, paired with a neutral sans for body. Rounded but extremely thin card outlines. One sharp plum accent. Soft and gentle, deliberately not sweet or girlish.`,
	},
];

// 全部共享的「清新」硬要求 —— 这是这一轮的方向,不是每版各自的风格
const FRESH_RULES = `
THE DIRECTION FOR ALL OF THESE IS 清新 — fresh, airy, clean, breathable:
- Very generous whitespace. Let the page breathe; do not fill it.
- LIGHT type weights for headlines. Nothing heavy or bold-black.
- Dividers barely visible: hairlines at low opacity, or no dividers at all.
- Colours pale and translucent, like a wash — never saturated blocks.
- If cards exist they must feel thin and weightless: large radii, no heavy shadows.
- Fresh, NOT cold or clinical. Warm and inviting, just light.

Craft notes (from the frontend-design guidance):
- Avoid generic fonts — no Inter, Roboto, Arial or default system UI faces.
  Pair a distinctive display face with a refined body face.
- One dominant tint plus ONE sharp accent beats an evenly-distributed timid palette.
- Avoid AI-slop clichés, especially purple gradients on white.`;

// 重出乱码版用的收紧版:降乱码最有效的杠杆是**给它逐字要渲染的字符串**,
// 而不是让它「编一段像样的英文」—— 后者是乱码的来源。条数从 6 减到 4,标题限死 3-5 词。
// 另外明令单栏 —— 柚子那版自作主张变双栏,我们要的是同一形态下的不同气质。
const COMMON_TIGHT = `
This is a mockup of a personal daily-briefing web page on desktop, 16:9.

RENDER EXACTLY THIS TEXT, character for character. Do not invent or alter any words:
  Page title:  Morning Brief
  Date line:   Tuesday, June 18
  Item 01  title: "Quiet Hours Ship Today"      body: "Notifications now pause overnight."   note: "Why it matters: fewer 3am pings."      chip: New
  Item 02  title: "Search Gets Faster"          body: "Results now load in under a second."  note: "Why it matters: less waiting."          chip: Live
  Item 03  title: "Team Notes Are Shared"       body: "Everyone sees the same draft."        note: "Why it matters: no more forwarding."    chip: Beta
  Item 04  title: "Weekly Recap Returns"        body: "A short summary lands each Friday."   note: "Why it matters: catch up in a minute."  chip: Soon

LAYOUT:
- ONE single centred column. Absolutely NOT two columns. Never split the page side by side.
- Four items stacked vertically, each with its number, title, body line, note line and small chip.

CONSTRAINTS:
- Light background always. No dark mode.
- Only the exact strings above may appear as text. No extra words, no lorem ipsum,
  no invented headlines, no scrambled or misspelled letters. Spelling must be perfect.
- Real UI, not an illustration of one: no device frame, no browser chrome, no hands, no watermark.
- The goal is VIBE — would someone want to keep reading this page?`;

const COMMON = `
This is a mockup of a personal daily-briefing web page ("Morning Brief") on desktop, 16:9.
Content: a page title with a date line, then five or six stories. Each story shows a number,
a linked title, one or two lines of summary, a short "why it matters to us" line, and a tiny status chip.

CONSTRAINTS:
- Light background always. No dark mode.
- Latin letters and digits only. NO Chinese, NO CJK. Text is placeholder — wording does not matter,
  but it must read like plausible English, never scrambled letters.
- Real UI, not an illustration of one: no device frame, no browser chrome, no hands, no desk, no watermark.
- The goal is VIBE — would someone want to keep reading this page?`;

const args = process.argv.slice(2);
const codex = args.includes("--codex");
const TIGHT = args.includes("--tight");
const want = args.filter((a) => !a.startsWith("--"));
const list = want.length ? FRESH.filter((v) => want.includes(v.id)) : FRESH;
const SKILL = join(
	process.env.HOME,
	codex
		? ".claude/skills/codex-image/generate.sh"
		: ".claude/skills/gemini-image/generate.sh",
);

process.stdout.write(
	`engine=${codex ? "codex" : "gemini"}  ${list.length} 版\n`,
);
for (const v of list) {
	const out = join(DIR, `fresh-${v.id}.png`);
	process.stdout.write(`→ ${v.id} (${v.name}) …\n`);
	try {
		await run(
			SKILL,
			[
				"--prompt",
				`${v.brief}\n${FRESH_RULES}\n${TIGHT ? COMMON_TIGHT : COMMON}`,
				"--output",
				out,
			],
			{ timeout: 420000, maxBuffer: 64 * 1024 * 1024 },
		);
		const stem = out.replace(/\.[^.]+$/, "");
		const hit = [".png", ".jpeg", ".jpg", ".webp"]
			.map((e) => stem + e)
			.find(existsSync);
		process.stdout.write(
			hit
				? `  ✓ ${hit.split("/").pop()} ${statSync(hit).size}B\n`
				: `  ✗ 无文件\n`,
		);
	} catch (e) {
		process.stdout.write(
			`  ✗ ${String(e.message).split("\n").slice(-3).join(" ").slice(0, 200)}\n`,
		);
	}
}
