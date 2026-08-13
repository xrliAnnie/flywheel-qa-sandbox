#!/usr/bin/env node
import { execFile } from "node:child_process";
/**
 * FLY-1704 轮 3 —— 用 codex-image 出配色概念图，给 Annie 先挑色系。
 *
 * 刻意**不是**整页渲染：她 04:00 要的从来是「先把色系选好，再真正地去做」。
 * 色系里没有中文要渲 → 图里零中文，只有色块 + hex + 英文角色标签，避免假字。
 *
 * ⚠️ codex-image 的已知弱点（skill 自述）：
 *    "Precise brand color execution — Codex often picks pretty defaults over the prompt's exact hex"
 *    ⇒ 图只负责「看色系关系」。权威色值在 palettes.json；
 *      生成后 verify.mjs 会从 PNG 真实像素取色，报出图与意图的偏差。
 *
 *   node gen.mjs [id ...]     不给 id 就全跑
 */
import {
	copyFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DIR = dirname(fileURLToPath(import.meta.url));
const { palettes } = JSON.parse(
	readFileSync(join(DIR, "palettes.json"), "utf8"),
);

// 图里只出现英文 —— 中文的「感觉」那句留在交付文字里，不进图。
const FEEL_EN = {
	nordic: "Cool and orderly - a white-walled studio with good daylight",
	press: "Warm and human - a morning paper still smelling of ink",
	botanical: "Natural and relaxed - reading by a window",
	studio: "Lively and young - the least corporate of the set",
	editorial: "Restrained and tasteful - many colours, all dialled down",
	signal: "Clear and direct - lots of white, a few high-signal colours",
};

function prompt(p) {
	const rows = Object.entries(p.colors)
		.map(([role, hex]) => `    ${role}  ${hex}`)
		.join("\n");
	return `A colour palette specimen card for a design system. Aspect ratio 16:9. Flat vector style, no photography, no 3D, no drop shadows.

LAYOUT, follow exactly:
- Page background: a very light neutral, almost white.
- Top left, large bold sans-serif heading, exactly this text: "${p.name_en}"
- Immediately below it, one line of small grey sans-serif text, exactly this text: "${FEEL_EN[p.id]}"
- Below that, one single horizontal row of NINE equal-width rounded-rectangle swatches, spanning the full width, small gaps between them.
- Under EACH swatch, two lines of tiny monospace text: the role label on the first line, the hex code on the second line.
- The nine swatches, left to right, exactly these colours and labels:
${rows}
- Bottom strip: three small example chips demonstrating PRIMARY, SECONDARY and ACCENT used as coloured text on the BASE colour, labelled "LINK", "HEADING", "BADGE".

HARD CONSTRAINTS:
- Reproduce the specified hex colours EXACTLY. Do not substitute prettier defaults. Colour accuracy matters more than aesthetics.
- Every character must be a Latin letter, a digit, or #. Absolutely NO Chinese characters, NO CJK glyphs, no lorem ipsum, no invented words.
- This is a palette specimen sheet ONLY. No article layout, no page mockup, no browser chrome, no device frame, no icons.
- No watermark, no logo, no signature.`;
}

/* ── 页面感 mockup（主交付物）─────────────────────────────────────
   Annie 补充原话:「也不是说只出颜色，就是它还是把那种页面的感觉出来…
   我希望的还是有一个那种 markup 的页面，这样的 feel 配上这个不同的 color palette。」
   ⇒ 不是色卡，是**一张看起来像早报页面的 mockup**，套上各套配色，让她在页面语境里看颜色。
   她同时明说「不一定要做得非常仿真」「字啊啥都出来…那当然出来更好」——
   **判颜色不需要字是真的**，所以假字/占位字可接受，不必为此纠结。
   版式照 direction E 的骨架来（编号 + 一行标题 + 两句 + 分节 + 两个 tab），
   这样她看到的是「我们这个产品」换了配色，不是某个通用 dashboard。       */
function pagePrompt(p) {
	const c = p.colors;
	return `A clean UI mockup of a personal daily-briefing web page, viewed on desktop. Aspect ratio 16:9. Flat modern interface design, crisp, no photography, no 3D, no device frame, no browser chrome.

COLOUR SCHEME — use these exactly, this is the point of the image:
- Page background: ${c.BASE}
- Cards / raised areas (if any): ${c.SURFACE}
- Main body and heading text: ${c.INK}
- Links and the active tab underline: ${c.PRIMARY}
- Section headings and the small "relates to us" label: ${c.SECONDARY}
- Small badges and the highlight rule: ${c.ACCENT}
- The GitHub section's colour: ${c["CAT-GITHUB"]}
- The X section's colour: ${c["CAT-X"]}
- Secondary / metadata text: ${c.MUTED}

LAYOUT, one narrow centred reading column, roughly 55% of the width, generous white space either side:
- Top: a large bold heading reading "Morning Brief", and under it one small line of muted metadata text.
- A thin strip with two small statistics, each a bold number over a tiny caption.
- A callout block with a thick vertical rule on its left in the ACCENT colour, containing three lines of text — this is a highlighted finding.
- A row of two text tabs: "GitHub Trending" and "X · For you", each followed by a small count. The first tab is active: its label is dark and it has a 2px underline in the PRIMARY colour. The second tab is muted with no underline.
- A small uppercase section heading in the SECONDARY colour with a thin hairline under it.
- Then FIVE list entries stacked vertically, separated by thin hairlines. NO cards, NO boxes, NO drop shadows — just hairlines. Each entry has:
    * a small light serif number on the left (1, 2, 3, 4, 5)
    * a bold underlined link-style title in the PRIMARY colour
    * on the same line, far right, tiny monospace metadata in the MUTED colour
    * two lines of body text below it in the INK colour, the second line beginning with a short bold label in the SECONDARY colour
    * a tiny grey "expand" affordance and a small pill badge with a check mark in the ACCENT colour
- Bottom of the visible area: a faint muted line suggesting a note field.

TEXT:
- All text must be Latin letters and digits only. NO Chinese, NO CJK characters.
- The text content itself does not matter and may be generic placeholder wording — this mockup exists to judge COLOUR, not copy. Keep it looking like plausible English sentences, not scrambled letters.

HARD CONSTRAINTS:
- The page background must stay LIGHT. Never a dark theme.
- Reproduce the specified hex colours as closely as possible.
- No watermark, no logo, no signature, no cursor.`;
}

/* ⚠️ 全局 skill ~/.claude/skills/codex-image/generate.sh 在这台机器上是坏的：
 *    第 56 行 CODEX_CMD 里带 `--full-auto`，而 codex-cli 0.147.0 已经不接受这个 flag
 *    （error: unexpected argument '--full-auto' found）→ 六张图全部 0 字节失败。
 *    **不改全局文件**（那是整机半径、不在这一单授权内），在这里复刻同样的调用，
 *    只把 flag 换成当前版本能跑的。已单独报给 Lead，她另立单给 infra。
 *
 *    🔴 **这份复刻只服务 FLY-1704 这一单，不是全局那行的修法建议。**
 *       下面这组 flag 是「今天在这台机器上能跑通的形态」，不是结论 ——
 *       全局 generate.sh 该怎么改由 infra 判，别照抄这里。
 *    复刻的部分：--enable image_generation / --skip-git-repo-check / 同款 wrapped prompt /
 *    落盘失败时回到 ~/.codex/generated_images 找最新一张。                        */
const CODEX_ARGS = [
	"exec",
	"--enable",
	"image_generation",
	"--skip-git-repo-check",
	"--sandbox",
	"workspace-write",
];

// 引擎二:gemini-image。不依赖 codex CLI(走独立的 Gemini API),所以不受上面那个故障影响。
// 付费约 $0.13/张。Lead 原话给了这个备选:「复刻版还出不来 → 直接换 gemini-image，别在 codex 这条路上耗」。
async function generateGemini(p, out) {
	await run(
		join(process.env.HOME, ".claude/skills/gemini-image/generate.sh"),
		["--prompt", (MODE === "page" ? pagePrompt : prompt)(p), "--output", out],
		{ timeout: 420000, maxBuffer: 64 * 1024 * 1024 },
	);
	// ⚠️ gemini 的 generate.sh 按 API 返回的 mime 决定后缀，**无视 --output 给的扩展名**
	//    （要 .png 它给 .jpeg）。第一次就是这里判错:退出码 0、文件也在，
	//    但我只 existsSync 了 .png 于是报「没产出」。按 basename 找，别按扩展名找。
	const stem = out.replace(/\.[^.]+$/, "");
	for (const ext of [".png", ".jpeg", ".jpg", ".webp"]) {
		if (existsSync(stem + ext)) return "gemini" + ext;
	}
	throw new Error(
		"gemini: 退出码 0 但 " + stem + ".{png,jpeg,jpg,webp} 都不存在",
	);
}

async function generate(p, out) {
	const wrapped =
		`Use your image generation tool to generate an image with this exact prompt: '${prompt(p)}'. ` +
		`Save the result as '${out}'. Do NOT write Python or other code to synthesize the image — ` +
		`use the native image_generation tool only. After saving, print the absolute path of the saved file.`;
	const started = Date.now();
	await run("codex-with-fallback", [...CODEX_ARGS, wrapped], {
		timeout: 420000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (existsSync(out)) return "saved";
	// 回退：codex 有时只落在自己的目录里，没执行 cp
	const gen = join(process.env.HOME, ".codex/generated_images");
	if (!existsSync(gen))
		throw new Error("no image produced and no generated_images dir");
	const newest = readdirSync(gen, { recursive: true })
		.filter((f) => String(f).endsWith(".png"))
		.map((f) => ({
			f: join(gen, String(f)),
			t: statSync(join(gen, String(f))).mtimeMs,
		}))
		.filter((x) => x.t >= started)
		.sort((a, b) => b.t - a.t)[0];
	if (!newest) throw new Error("no image produced");
	copyFileSync(newest.f, out);
	return "recovered";
}

const argv = process.argv.slice(2);
const engine = argv.includes("--gemini") ? "gemini" : "codex";
const MODE = argv.includes("--page") ? "page" : "swatch";
const want = argv.filter((a) => !a.startsWith("--"));
const list = want.length
	? palettes.filter((p) => want.includes(p.id))
	: palettes;
process.stdout.write(`engine=${engine} mode=${MODE}  ${list.length} 套\n`);

for (const p of list) {
	const out = join(DIR, `${MODE === "page" ? "page" : "palette"}-${p.id}.png`);
	process.stdout.write(`→ ${p.id} (${p.name_cn}) …\n`);
	try {
		const how =
			engine === "gemini"
				? await generateGemini(p, out)
				: await generate(p, out);
		const real = how.startsWith("gemini")
			? out.replace(/\.[^.]+$/, "") + how.slice(6)
			: out;
		process.stdout.write(
			`  ✓ ${how}  ${statSync(real).size} bytes  ${real.split("/").pop()}\n`,
		);
	} catch (e) {
		const detail = [e.stderr, e.stdout, e.message]
			.filter(Boolean)
			.join("\n---\n");
		process.stdout.write(
			`  ✗ 失败\n${detail.split("\n").slice(-25).join("\n")}\n`,
		);
	}
}
