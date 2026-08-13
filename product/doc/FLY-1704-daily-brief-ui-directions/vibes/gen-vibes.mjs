#!/usr/bin/env node
/**
 * FLY-1704 轮 4 —— 六个「vibe」概念图，给 Annie 挑「想不想看下去」。
 *
 * Annie 原话：「都好难看 还是 Codex image 吧 不行就 Gemini。**不追求完全的精确
 * 主要是那个 vibe 让人想看下去** 可以参考其他做的比较好的 Feed 都是怎么设计的
 * 另外其实**也不光是颜色 还有字体 排版等等整个的组合** 希望整体**既有美感
 * 又能够帮我轻松抓住重点**」
 *
 * 跟前三轮的根本区别：
 *   轮 2/3 我在做「配色变体」—— 骨架锁死，只换色值，还写了像素校验算 ΔE。
 *   那套的第一标准是**准确**。但准确从来不是她的目的，vibe 才是。
 *   ⇒ 这轮**不做像素校验、不算 ΔE**。每一版是一整套设计语言：
 *     版式 + 字体层级 + 留白 + 密度 + 卡片形态 + 配色，一起变。
 *
 * 每版都钉一个**真实做得好的 feed** 当参照，不是凭空想。
 * 全局 codex-image 已修好（Tadashi 换掉了 --full-auto），直接用它，本地复刻版退役。
 *
 *   node gen-vibes.mjs [id ...] [--gemini]
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DIR = dirname(fileURLToPath(import.meta.url));

export const VIBES = [
	{
		id: "editorial",
		name: "社论",
		feel: "像一份有观点的周报 —— 你会想坐下来读完，而不是扫一眼关掉。",
		ref: "Stratechery / The Browser / NYT Opinion",
		brief: `A long-form editorial digest. Large elegant serif headlines with real typographic contrast — headline about 3x the body size. Generous white space, a single narrow measure of text. One restrained accent colour used sparingly (a deep ink blue) on links and a thin rule. Small-caps metadata in muted grey. Hairline dividers between stories, never boxes. The first story gets noticeably more room than the rest. Feels like a well-set magazine page, calm and authoritative.`,
	},
	{
		id: "paper",
		name: "暖纸",
		feel: "像刚印出来的纸质晨报 —— 有温度，读久了眼睛不累。",
		ref: "Import AI / Money Stuff",
		brief: `A warm printed-newsletter feel. Cream / off-white paper background, warm near-black serif body text, generous line height. No cards and no boxes at all — structure comes only from whitespace, bold lead-ins and thin warm-grey rules. Section labels in small caps letterspaced. A rust-orange accent only on links and one left rule. Numbers set in an old-style serif. Looks like something printed, not something rendered.`,
	},
	{
		id: "signal",
		name: "信号台",
		feel: "密、快、专业 —— 三十秒扫完全部，重点自己跳出来。",
		ref: "Linear changelog / GitHub Trending / 终端仪表盘的克制版",
		brief: `A dense, high-signal list interface. Tight rows, compact line height, a monospaced column of right-aligned numbers, small coloured status dots. Sans-serif throughout, small sizes, very high information density — around sixteen items visible at once. Colour used only functionally: one blue for links, one green and one amber for status. Crisp 1px separators. Feels like a professional tool: fast, scannable, zero decoration.`,
	},
	{
		id: "cover",
		name: "头条",
		feel: "替你排好了 —— 最重要那条大得躲不掉，其余安静排在下面。",
		ref: "报纸头版 / Every.to",
		brief: `A front-page layout with dramatic hierarchy. One hero story occupies the top third with a very large headline and a short standfirst; a coloured band or oversized numeral marks it. Below, the remaining stories shrink to a compact two-column list with small titles and one-line summaries. The size jump between hero and the rest is deliberately extreme. Bold editorial typography, one strong accent colour.`,
	},
	{
		id: "soft",
		name: "柔卡",
		feel: "轻松、现代、不严肃 —— 像在读一个设计得很舒服的 app。",
		ref: "Notion / Readwise Reader / Arc 的 feed",
		brief: `A soft modern card feed. Rounded cards on a very light grey canvas, subtle soft shadows, generous internal padding, a coloured left edge or small coloured tag per card indicating its source. Friendly geometric sans typography with clear size steps. Rounded pill badges. Pastel accents on white — light, airy, contemporary product design. Comfortable rather than dense.`,
	},
	{
		id: "zen",
		name: "留白",
		feel: "安静到只剩内容 —— 一次只让你看见一件事。",
		ref: "Kinfolk / Apple Newsroom",
		brief: `Extreme minimalism. Enormous white space, a very narrow column, and a dramatic type-scale contrast: large light-weight headlines against tiny muted metadata. Almost monochrome — black, white and one barely-there accent. No rules, no boxes, no icons; separation comes purely from vertical rhythm. Very few items visible at once, each given a lot of air. Quiet, confident, gallery-like.`,
	},
];

const COMMON = `
This is a mockup of a personal daily-briefing web page ("Morning Brief") on desktop, 16:9.
Content shape: a page title with a date line, then a list of stories. Each story shows a number,
a linked title, one or two lines of summary, a short "why it matters to us" line, and a tiny status chip.

CONSTRAINTS:
- Light background. No dark mode.
- All text in Latin letters and digits only. NO Chinese, NO CJK. Text is placeholder — it exists so the
  page looks real; the wording does not matter. It must read like plausible English, never scrambled letters.
- Real UI, not an illustration of one: no device frame, no browser chrome, no hands, no desk, no watermark.
- The goal is VIBE — would someone want to keep reading this page? Beauty and clear hierarchy matter more
  than any exact colour value.`;

const args = process.argv.slice(2);
const gemini = args.includes("--gemini");
const want = args.filter((a) => !a.startsWith("--"));
const list = want.length ? VIBES.filter((v) => want.includes(v.id)) : VIBES;
const SKILL = join(
	process.env.HOME,
	gemini
		? ".claude/skills/gemini-image/generate.sh"
		: ".claude/skills/codex-image/generate.sh",
);

process.stdout.write(
	`engine=${gemini ? "gemini" : "codex"}  ${list.length} 版\n`,
);
for (const v of list) {
	const out = join(DIR, `vibe-${v.id}.png`);
	process.stdout.write(`→ ${v.id} (${v.name}) …\n`);
	try {
		await run(SKILL, ["--prompt", `${v.brief}\n${COMMON}`, "--output", out], {
			timeout: 420000,
			maxBuffer: 64 * 1024 * 1024,
		});
		const stem = out.replace(/\.[^.]+$/, "");
		const hit = [".png", ".jpeg", ".jpg", ".webp"]
			.map((e) => stem + e)
			.find(existsSync);
		process.stdout.write(
			hit
				? `  ✓ ${hit.split("/").pop()}  ${statSync(hit).size} bytes\n`
				: `  ✗ 退出码 0 但没有文件\n`,
		);
	} catch (e) {
		const d = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n");
		process.stdout.write(`  ✗ 失败\n${d.split("\n").slice(-12).join("\n")}\n`);
	}
}
