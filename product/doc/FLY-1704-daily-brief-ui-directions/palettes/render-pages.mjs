#!/usr/bin/env node
/**
 * FLY-1704 轮 3 · 路线 B —— 用 direction-e.html 的 CSS 变量系统渲 6 张真页面。
 *
 * 为什么改用真渲染（Lead 判的）：
 *   三轮图像模型证明它压不住 UI 配色 —— 它有自己的「漂亮默认审美」，会把配色
 *   收敛回白蓝调，CAT-X 的紫三轮一次没出现。用一组**不能显示候选色系**的图去
 *   选色系，是让 Annie 在一个坏掉的量具上做决定。
 *   产物种类不变（还是静态页面图给她挑），只换生成器；她的选择步骤原封不动。
 *
 * 硬约束（Lead）：骨架 / 卡片 / 信息层级 / 字号层级一概不动，只换 CSS 变量。
 *   ⇒ 本脚本**不改** direction-e.html，只在渲染时把 <body data-pal> 换成目标套，
 *     并把该套的变量注入成一段追加样式。#813 的 head 一个字节不动。
 *
 *   node render-pages.mjs            → page-real-{id}.html × 6（供截图）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(DIR, "..", "mockups", "direction-e.html");
const { palettes } = JSON.parse(
	readFileSync(join(DIR, "palettes.json"), "utf8"),
);

const html = readFileSync(SRC, "utf8");
if (!html.includes('data-dir="e"'))
	throw new Error("direction-e.html 结构对不上，停手");

for (const p of palettes) {
	const vars = Object.entries(p.colors)
		.map(
			([k, v]) =>
				`--e-${k.toLowerCase().replace("cat-github", "gh").replace("cat-x", "x")}:${v}`,
		)
		.join(";");
	// 追加一层同名变量覆盖 —— 不动原文件里任何一条规则，只把值换掉。
	// 另外补齐 direction-e.html 里独有的几个派生变量（rule / chip / note 等），
	// 由角色色推导，保证「每个角色色都真的出现在页面上」。
	const extra = `
<style id="fly1704-pal">
body[data-pal="${p.id}"]{
  ${vars};
  --e-bg:${p.colors.BASE}; --e-ink:${p.colors.INK}; --e-link:${p.colors.PRIMARY};
  --e-s2:${p.colors.INK}; --e-cue:${p.colors.SECONDARY}; --e-accent:${p.colors.ACCENT};
  --e-meta:${p.colors.MUTED}; --e-dim:${p.colors.MUTED}; --e-num:${p.colors.PRIMARY};
  --e-chiptx:${p.colors.MUTED}; --e-chip:${p.colors.SURFACE};
  --e-code:${p.colors.SURFACE}; --e-notebg:${p.colors.SURFACE};
  --e-noteln:${p.colors.MUTED}; --e-rule:${p.colors.MUTED}33; --e-rule2:${p.colors.MUTED}55;
  --e-btn:${p.colors.PRIMARY}; --e-btntx:${p.colors.SURFACE};
  --e-gh:${p.colors["CAT-GITHUB"]}; --e-x:${p.colors["CAT-X"]};
}
/* 让每个角色色都真的落在页面上（Lead 第 2 条硬要求）。
   注意:只给面积，不动骨架 —— 加的全是底色/描边，没有新元素、没有改字号行高间距。
   之前 SECONDARY 只活在 14px 抗锯齿小字里、ACCENT 只活在 3px 细线里，
   那种用量肉眼根本感知不到,正是 Annie 说的「颜色太单调」。 */
body[data-pal="${p.id}"] .chk{
  background:${p.colors.ACCENT}26; border-left:4px solid ${p.colors.ACCENT};
  padding:7px 11px; border-radius:0 6px 6px 0;
}
/* 分节标题:整条 SECONDARY 浅底 + 实色左块 —— 这是 SECONDARY 的主要面积 */
body[data-pal="${p.id}"] .secthd{
  background:${p.colors.SECONDARY}1F; border-bottom:2px solid ${p.colors.SECONDARY};
  padding:8px 12px; border-radius:6px 6px 0 0;
}
body[data-pal="${p.id}"] .secthd h2{color:${p.colors.SECONDARY}}
/* 横着看才看得见的事:ACCENT 浅底 + 粗左线（原来只有一条灰边线） */
body[data-pal="${p.id}"] .xfind{
  background:${p.colors.ACCENT}17; border-left:5px solid ${p.colors.ACCENT};
  border-radius:0 8px 8px 0;
}
body[data-pal="${p.id}"] .xfind h3{color:${p.colors.ACCENT}}
/* 底数条的两个数字:一个主色一个辅色，给 SECONDARY 再添一处实色 */
body[data-pal="${p.id}"] .basis .row1 div:nth-child(1) b{color:${p.colors.PRIMARY}}
body[data-pal="${p.id}"] .basis .row1 div:nth-child(2) b{color:${p.colors.SECONDARY}}
/* 「跟我们 ——」标签:加浅底,从纯小字变成一小块色 */
body[data-pal="${p.id}"] .bodyE .s2 .cue{
  background:${p.colors.SECONDARY}1F; padding:1px 6px; border-radius:4px;
}
/* 分类色:GitHub / X 两个 tab 的计数做成实色药丸，一眼分得开 */
body[data-pal="${p.id}"] .tabsE button[data-pane="gh"] .cnt{
  background:${p.colors["CAT-GITHUB"]}; color:${p.colors.SURFACE};
  padding:2px 8px; border-radius:999px; opacity:1;
}
body[data-pal="${p.id}"] .tabsE button[data-pane="x"] .cnt{
  background:${p.colors["CAT-X"]}; color:${p.colors.SURFACE};
  padding:2px 8px; border-radius:999px; opacity:1;
}
body[data-pal="${p.id}"] .paneE[data-pane="gh"] .no{color:${p.colors["CAT-GITHUB"]}}
body[data-pal="${p.id}"] .paneE[data-pane="x"] .no{color:${p.colors["CAT-X"]}}
/* 配色切换条在截图里没用，收掉 —— 每张图就是一套配色 */
body[data-pal="${p.id}"] .palbar,
body[data-pal="${p.id}"] .palnote{display:none}
</style>
`;
	const out = html
		.replace('<body data-dir="e">', `<body data-dir="e" data-pal="${p.id}">`)
		.replace("</head>", extra + "</head>")
		// 页内脚本会按 localStorage 把 data-pal 改回去，钉死它
		.replace("setPal(saved||'plain');", `setPal(${JSON.stringify(p.id)});`)
		.replace(/__CSP_NONCE__/g, "render");
	writeFileSync(join(DIR, `page-real-${p.id}.html`), out);
	console.log(`✓ page-real-${p.id}.html  ${(out.length / 1024).toFixed(0)}KB`);
}
console.log(`\n${palettes.length} 张待截图。direction-e.html 未改动。`);
