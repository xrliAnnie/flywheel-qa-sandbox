#!/usr/bin/env node
/**
 * FLY-1704 轮 6 —— 樱白 / 海盐 两版真 HTML POC。
 *
 * Annie:「海盐 is slightly better.... but tbh, **we also need to represent the info clear**
 *        ....ok let's **render a real poc html in 樱白 and 海盐** so we could tell」
 *
 * 为什么这轮真渲染是对的(跟轮 3 我们判错那次区分开):
 *   轮 3 用真渲染是为了**色值准确** —— 但她要的是 vibe,工具用错了。
 *   这轮她要的是**「信息读不读得清」** —— 概念图给不了这个,
 *   判读性必须拿**真实长度的中文标题/摘要**才看得出来。所以这轮**假字不行**。
 *
 * 机制:**不修改 direction-e.html**(Annie 拍板过的骨架 + 已验收的 tab 逻辑),
 * 只在渲染期把皮肤 CSS 追加进它的 <style> 末尾。同特异性、靠后 ⇒ 覆盖前面的配色块。
 * 不新增任何 <script> ⇒ nonce 数、裸 script 数原样不动(那是硬门)。
 *
 * 验收只挡缺陷,不规定长相 —— 上一轮「每个角色色必须落地」正是把设计做成
 * 平均调色板的元凶,这轮不要那条。
 *
 *   node build-poc.mjs
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(DIR, "direction-e.html");
const src = readFileSync(SRC, "utf8");

// ── 皮肤 ───────────────────────────────────────────────────────────────────
// 只动"长相":底色 / 卡片形态 / 字体配对 / 间距呼吸感。
// 不动:信息层级、条数、tab 逻辑、展开交互。

const BLOSSOM = `
/* ═══ 樱白 —— 粉调水彩底 + 白卡片 + 圆点标签。柔和但不甜腻 ═══ */
body[data-dir="e"]{
  --e-bg:#fdfaFB; --e-ink:#2a2328; --e-link:#8e4a6b; --e-rule:#f3e8ee;
  --e-s2:#6f6169; --e-accent:#a8446e;
  background:
    radial-gradient(1100px 620px at 12% -8%,  #fbeef3 0%, rgba(251,238,243,0) 62%),
    radial-gradient(900px  540px at 92% 4%,   #f6eef4 0%, rgba(246,238,244,0) 58%),
    radial-gradient(760px  460px at 60% 100%, #fdf3ee 0%, rgba(253,243,238,0) 60%),
    #fdfafb;
  background-attachment:fixed;
  color:var(--e-ink);
  font-family:"PingFang SC","Hiragino Sans GB",system-ui,sans-serif;
}
.pagehd h1{
  font-family:"Songti SC","Noto Serif SC",Georgia,serif;
  font-weight:300; letter-spacing:.14em; color:#3a2a33;
}
/* 卡片:白底,极细描边,不用阴影堆重量 */
.itemE{
  background:#fff; border:1px solid #f0e2e9; border-top-color:#f0e2e9;
  border-radius:16px; padding:20px 22px; margin:14px 0;
  box-shadow:0 1px 2px rgba(150,110,130,.05);
}
.hdE{ line-height:1.5 }
.bodyE .s2{ color:var(--e-s2) }
/* 圆点标签 —— 概念图里那个右侧小圆点 */
.met .qty::before{
  content:""; display:inline-block; width:7px; height:7px; border-radius:50%;
  background:var(--e-accent); margin-right:7px; vertical-align:middle; opacity:.75;
}
.no{ color:#c9a6b8; font-variant-numeric:tabular-nums }
.note{ background:#fdf6f9; border-left:2px solid #eccfdd; border-radius:0 8px 8px 0 }
`;

const SEASALT = `
/* ═══ 海盐 —— 磨砂玻璃浮动面板,最通透。开阔、微凉、轻 ═══ */
body[data-dir="e"]{
  --e-bg:#f7fafc; --e-ink:#1b2733; --e-link:#1d4e79; --e-rule:#e6eef4;
  --e-s2:#5c6b78; --e-accent:#17456e;
  background:
    radial-gradient(1200px 680px at 8% -6%,  #e8f2f8 0%, rgba(232,242,248,0) 60%),
    radial-gradient(1000px 600px at 96% 8%,  #f5efe6 0%, rgba(245,239,230,0) 58%),
    radial-gradient(820px  520px at 50% 104%,#eaf3f6 0%, rgba(234,243,246,0) 62%),
    #f8fbfc;
  background-attachment:fixed;
  color:var(--e-ink);
  font-family:"PingFang SC","Hiragino Sans GB",system-ui,sans-serif;
}
.pagehd h1{
  font-family:"Songti SC","Noto Serif SC",Georgia,serif;
  font-weight:200; letter-spacing:.18em; color:#20323f;
}
/* 面板:半透明 + 模糊,没有硬边 —— 这是"磨砂玻璃"的来源 */
.itemE{
  background:rgba(255,255,255,.62);
  -webkit-backdrop-filter:blur(14px) saturate(1.15);
  backdrop-filter:blur(14px) saturate(1.15);
  border:1px solid rgba(255,255,255,.85); border-top-color:rgba(255,255,255,.85);
  border-radius:18px; padding:22px 26px; margin:16px 0;
  box-shadow:0 2px 20px rgba(31,72,102,.055);
}
.hdE{ line-height:1.55 }
.bodyE .s2{ color:var(--e-s2) }
.no{ color:#9db3c2; font-variant-numeric:tabular-nums }
.met .qty{ color:var(--e-accent) }
.note{
  background:rgba(255,255,255,.5); border-left:2px solid #cfe0ea; border-radius:0 10px 10px 0;
}
/* 更窄的行宽 + 更松的呼吸 —— 通透主要来自留白,不是颜色 */
.wrpE{ max-width:860px }
.pneE{ padding-top:6px }
`;

const SKINS = [
	{ id: "blossom", cn: "樱白", css: BLOSSOM },
	{ id: "seasalt", cn: "海盐", css: SEASALT },
];

// 单皮肤 POC:配色切换条无意义,隐掉(不删 DOM,只隐藏 —— 不动结构)
const HIDE_SWITCHER = `\n.palbar{display:none !important}\n`;

const rows = [];
for (const s of SKINS) {
	const out = join(DIR, `poc-${s.id}.html`);
	// 追加进已有 <style> 末尾 ⇒ 同特异性靠后取胜,且不新增 style/script 标签
	const html = src.replace(
		"</style></head>",
		`${s.css}${HIDE_SWITCHER}</style></head>`,
	);
	if (html === src) {
		console.error(`✗ ${s.id}: 没找到 </style></head> 锚点,中止`);
		process.exit(1);
	}
	writeFileSync(out, html);

	// ── 自检:只挡缺陷,不规定长相 ──
	const n = (s, re) => (s.match(re) || []).length;
	// 卡片数要按 **class token** 数 —— 有 5 个是 class="itemE xxx",
	// 写成 /class="itemE"/ 会漏数成 19。那是量具错,不是内容缺。
	const cards = (s) => (s.match(/class="[^"]*\bitemE\b[^"]*"/g) || []).length;
	const chk = {
		nonce: n(html, /__CSP_NONCE__/g),
		bareScript: n(html, /<script(?![^>]*nonce)/g), // 没带 nonce 的 script = 会被 CSP 打死
		pcs: n(html, /prefers-color-scheme/g),
		cards: cards(html),
		kb: +(statSync(out).size / 1024).toFixed(1),
	};
	// 判据跟**源文件**比,不硬写数字:我要保证的是"皮肤没吃掉任何一条",
	// 不是"恰好等于我记得的那个数"。
	const srcCards = cards(src);
	const ok =
		chk.nonce === 2 &&
		chk.bareScript === 0 &&
		chk.pcs === 0 &&
		chk.cards === srcCards &&
		chk.cards === 24 &&
		chk.kb < 512;
	chk.源卡片 = srcCards;
	rows.push({ 版本: `${s.cn} ${s.id}`, ...chk, 判定: ok ? "✓" : "✗" });
}
console.table(rows);
process.exit(rows.every((r) => r.判定 === "✓") ? 0 : 1);
