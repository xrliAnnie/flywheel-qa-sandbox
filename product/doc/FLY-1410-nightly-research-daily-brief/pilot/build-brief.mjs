#!/usr/bin/env node
/**
 * FLY-1410 早报生成器 —— 真正每天跑的那个,不是 mockup。
 *
 * 版式 = Annie 2026-08-11 拍板的那一套:
 *   结构  FLY-1704 方向 E(十条一屏)
 *   tab   GitHub Trending / X · For you,标签带条数
 *   皮肤  樱白 —— 粉调 radial-gradient 底 + 白卡片(圆角 16px)
 *
 * 出处(照搬,不重造):
 *   design/FLY-1704-palettes @530ddfdd
 *   mockups/direction-e.html   骨架 + tab 逻辑(已验收)
 *   mockups/poc-blossom.html   她挑的那版渲染 —— 本文件的 CSS 就是从它的
 *                              <style> 里整块抽出来的,见 layout-e-blossom.css。
 *                              「颜色值直接取」因此是可以拿 diff 证明的。
 *                              (唯一的差:删掉了一条命中数为 0 的死规则,见下)
 *   mockups/build-mockups.mjs  renderE() / splitLead() —— 字段到版位的映射
 *
 * 【跟 mockup 的差别,一共五处,每一处都是刻意的】
 *   1. 不发配色切换条(.palbar/.palnote):生产只有樱白一套,发出来是死 DOM。
 *      改为在 <body> 上静态写死 data-pal="plain" —— 这正是 POC 加载后 JS 设出来
 *      的那个值,基础色变量(--e-meta/--e-num/... 等樱白没重声明的)照旧生效,
 *      而且不再依赖 JS 才有颜色。
 *   2. 不发方向自述标签(.dirtag)和「这是版式方向图不是上线版本」那段页脚 ——
 *      那是 mockup 对着 Annie 解释自己,日报里出现是错的。
 *   3. 日期和「读了代码的有几个」改为从数据算,不再写死。
 *      写死的数字在重跑旧数据 / 换一天时会直接变成谎话(这一轮已经栽过一次)。
 *   4. 只发一个 <script>(合并 tab + 备注),并给复制加了失败兜底。
 *      C/D 方向才用的 [data-acc]/[data-filter]/.c-nb 那三段在方向 E 的 markup 里
 *      一个对象都没有(已核),是死代码,不带走。
 *   5. 加了一行 color-scheme:light。mockup 没有;它不是暗色分支,恰恰相反 ——
 *      它把表单控件钉死在浅色,是在守 Annie「浅色底、不要暗色模式」那条硬线。
 *      在浅色机器上零变化。
 *
 * 【那条死掉的圆点规则:已删,不是激活】(Honey Lemon 2026-08-12 定)
 *   樱白皮肤里那条 .met .qty::before 找的是 .met 后代里的 .qty,而真 markup 是
 *   同一个元素的 class 上并排挂着 qty 和 meta 两个值,没有任何 .met 祖先 ——
 *   浏览器 CSSOM 实测命中数 = 0。⇒ 她拍板的那版渲染里,那个粉色小圆点
 *   从来没出现过。
 *   (这里刻意不写那个 class 属性的引号原文 —— 写了就是在文件里留一个跟真
 *    markup 逐字相同的诱饵串,已经把数这个文件的人骗过三次。)
 *   激活它 = 让页面长出她没看过的东西;原样留着 = 下一个人照抄继承这个坑。
 *   所以删。删掉渲染结果零变化(前后对照证过),属纯死代码清理。
 *   1704 那份 POC 不动 —— 它是「她当时批的那版」的历史记录。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const j = read("judgments.json");
const CSS = readFileSync(join(DIR, "layout-e-blossom.css"), "utf8");

/* ─────────────────────────── 工具(照搬 1704) ─────────────────────────── */

const esc = (s) =>
	String(s ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);

/** markdown 子集:**加粗** 和 `代码` */
const rich = (s) =>
	esc(s)
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");

/**
 * 把 why 切成「一句论断」+「余下原文」。断言 lead + rest === why(逐字),
 * 所以外面用 lead、折叠区续 rest,一个字不丢也不重复。
 *
 * 🔴 不能在 **加粗** 或 `代码` 跨度中间切 —— 在句号处硬切会让 lead 拿到落单的
 * "**",rich() 配不成对,页面上直接漏出星号。所以扫的时候记着自己在不在标记
 * 里面,只在**外面**的句末标点切。若整段以加粗论断开头,则整个加粗跨度算导语。
 */
function splitLead(why) {
	const s = String(why ?? "");
	if (s.startsWith("**")) {
		const close = s.indexOf("**", 2);
		if (close > 0) {
			const inner = s.slice(2, close);
			if (/[。！？!?]/.test(inner))
				return { lead: s.slice(0, close + 2), rest: s.slice(close + 2) };
		}
	}
	let inBold = false;
	let inCode = false;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "*" && s[i + 1] === "*") {
			inBold = !inBold;
			i++;
			continue;
		}
		if (s[i] === "`") {
			inCode = !inCode;
			continue;
		}
		if (!inBold && !inCode && "。！？!?".includes(s[i]))
			return { lead: s.slice(0, i + 1), rest: s.slice(i + 1) };
	}
	return { lead: s, rest: "" };
}

/** GitHub 条目没有 id,必须派生 */
const itemKey = (it) => (it.id ? `x:${it.id}` : `gh:${it.repo}`);

const STATE = {
	verified: { icon: "✅", label: "核过原物" },
	scanned: { icon: "⚪", label: "只扫了，没核" },
	mismatch: { icon: "⚠️", label: "数字对不上" },
};
const stateOf = (it) => STATE[it.check] ?? STATE.scanned;

const num = (s) => Number(String(s ?? "").replace(/[^0-9]/g, "")) || 0;
const kviews = (v) => {
	const n = num(v);
	return n >= 10000
		? `${(n / 1000).toFixed(1)}k 浏览`
		: `${n.toLocaleString()} 浏览`;
};

/**
 * 日期取自采集产物的 run_at,不取「今天」——
 * 拿旧数据重跑一次就把页面戳成今天,是跟写死 13 同一类的谎话。
 */
function briefDate() {
	for (const f of ["collected-x.json", "collected-gh.json"]) {
		const p = join(DIR, f);
		if (!existsSync(p)) continue;
		try {
			const d = JSON.parse(readFileSync(p, "utf8"));
			if (d && !Array.isArray(d) && d.run_at)
				return String(d.run_at).slice(0, 10);
		} catch {
			/* 坏文件就往下试 */
		}
	}
	for (const f of ["collected-x.json", "collected-gh.json"]) {
		const p = join(DIR, f);
		if (existsSync(p))
			return new Date(statSync(p).mtime).toISOString().slice(0, 10);
	}
	throw new Error("拿不到采集日期:collected-*.json 都不在");
}

/* ───────────────────── 统一的条目模型(照搬 1704) ───────────────────── */

const deep = j.github.filter((r) => r.depth !== "shallow");
const shallow = j.github.filter((r) => r.depth === "shallow");
const xs = j.x.items;

/**
 * 编号 = 【该 tab 内的序位】,不是全局序位。(Annie 2026-08-12:
 * 「不用这个样子,每个tab都是从一开始重新标就行了」)
 *
 * 所以两个计数器:GitHub 面的「读了代码」和「只扫了没深入」两节共用一个
 * (它们同属一个 tab,连着数到 18),X 面自己从 1 数起。
 *
 * 🔴 不能在渲染时按数组下标算。切 tab 只是 hidden 的显隐,DOM 一直都在 ——
 * 按下标算出来的号跟「它在自己 tab 里排第几」是两回事,切过去只会看见
 * 一串接着上一个 tab 往下走的号。号在建模型时就按 tab 定死,渲染只是照抄。
 */
let ghSeq = 0;
let xSeq = 0;
const model = [
	...deep.map((r) => ({
		kind: "deep",
		raw: r,
		key: itemKey(r),
		n: ++ghSeq,
		...splitLead(r.why),
	})),
	...shallow.map((r) => ({
		kind: "shallow",
		raw: r,
		key: itemKey(r),
		n: ++ghSeq,
		lead: "",
		rest: "",
	})),
	...xs.map((r) => ({
		kind: "x",
		raw: r,
		key: itemKey(r),
		n: ++xSeq,
		...splitLead(r.why),
	})),
];

const byKind = (k) => model.filter((m) => m.kind === k);

const metaBits = (m) =>
	m.kind === "x"
		? [
				`${m.raw.author}`,
				kviews(m.raw.views),
				`${stateOf(m.raw).icon} ${stateOf(m.raw).label}`,
			]
		: [
				`今日 +${m.raw.stars_today} 星`,
				m.raw.lang ?? "—",
				`${stateOf(m.raw).icon} ${stateOf(m.raw).label}`,
			];

const titleText = (m) => (m.kind === "x" ? m.raw.author : m.raw.repo);
const linkOf = (m) => m.raw.url;

const checkLine = (m) =>
	m.raw.check_note
		? `<div class="chk">${stateOf(m.raw).icon} ${rich(m.raw.check_note)}</div>`
		: `<div class="chk dim">${stateOf(m.raw).icon} ${esc(stateOf(m.raw).label)} —— 我没去核原物，这不是「可信」，是「未知」。</div>`;

/**
 * 备注框 —— 每条一个、能选中复制、localStorage 存。
 *
 * 【默认展开】(Annie 2026-08-12:「让我留comments的部分,你不用给我收起来了,
 * 全部都自动打开就行」)—— 打开页面就能直接写,不用先点一下。
 *
 * 用 <details open> 而不是干脆去掉 <details>,两个理由:
 *   ① summary 那行「+ 备注」同时是这个框的标签;去掉 details 就剩一个没有
 *      标签的秃 textarea。
 *   ② 复制失败时那条兜底(把有内容的备注展开)靠的就是 closest('details');
 *      details 没了它会变成空跑。她要的是「默认打开」,不是「不许合上」——
 *      留着 details 她想收起来仍然收得起来。
 */
const note = (key) =>
	`<details class="nbd" open><summary>+ 备注</summary><div class="nb"><textarea class="note" data-note="${esc(key)}" rows="2" placeholder="写几句，刷新不会丢"></textarea></div></details>`;

const sec = (title, count) =>
	`<div class="secthd"><h2>${esc(title)}</h2><span class="cnt">${count} 条</span></div>`;

/* ───────────────────── 条目渲染(照搬 renderE 的 one()) ───────────────────── */

const firstSentence = (t) => splitLead(String(t ?? "")).lead.trim();

function one(m) {
	const r = m.raw;
	// 第 1 句:这是什么
	const s1 = firstSentence(r.what);
	// 第 2 句:跟我们什么关系(浅扫条没有 relation,用「为什么没深入」的第一句 —— 它答的正是这个)
	const s2 =
		m.kind === "shallow"
			? firstSentence(r.no_code_reason)
			: firstSentence(r.relation);

	// 折叠区:所有没进上面两句的原文,一个字不丢
	const restOf = (t, keptFirst) => {
		const full = String(t ?? "");
		const rest = full.slice(firstSentence(full).length).trim();
		return keptFirst && rest ? rest : keptFirst ? "" : full;
	};
	const bits = [];
	if (m.kind === "x") bits.push(`<p>${rich(r.summary_cn)}</p>`);
	if (m.lead)
		bits.push(
			`<p><span class="cue">为什么值得你看 ——</span> ${rich(m.lead + m.rest)}</p>`,
		);
	const whatRest = restOf(r.what, true);
	if (whatRest) bits.push(`<p>${rich(whatRest)}</p>`);
	if (m.kind === "shallow") {
		const nr = restOf(r.no_code_reason, true);
		if (nr) bits.push(`<p>${rich(nr)}</p>`);
	} else {
		const relRest = restOf(r.relation, true);
		if (relRest) bits.push(`<p>${rich(relRest)}</p>`);
		bits.push(`<p><span class="cue">能借的 ——</span> ${rich(r.borrow)}</p>`);
	}
	if (m.kind === "deep")
		bits.push(`<div class="codeblk">${rich(r.code)}</div>`);
	if (m.kind === "x") bits.push(`<div class="codeblk">${rich(r.quote)}</div>`);

	return `<article class="itemE${m.kind === "shallow" ? " shallow" : ""}" data-fw-item="${esc(m.key)}">
  <div class="hdE"><span class="no">${m.n}</span>
    <a href="${esc(linkOf(m))}" target="_blank" rel="noopener">${esc(titleText(m))}</a>
    <span class="qty meta">${esc(metaBits(m).join("  ·  "))}</span></div>
  <div class="bodyE" data-fw-prose>
    <span class="s1">${rich(s1)}</span>
    <span class="s2"><span class="cue">跟我们 ——</span> ${rich(s2)}</span>
  </div>
  <details><summary>展开全文</summary><div class="deepA">${bits.join("")}</div></details>
  ${checkLine(m)}
  ${note(m.key)}
<!--/fw-item:${esc(m.key)}--></article>`;
}

/* ─────────────────────────── 组页 ─────────────────────────── */

const DATE = briefDate();
const nGh = byKind("deep").length + byKind("shallow").length;
const nX = byKind("x").length;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>早报 — ${esc(DATE)}</title>
<style>:root{color-scheme:light}
${CSS}</style></head>
<body data-dir="e" data-pal="plain">

<div class="pagehd">
  <h1>早报</h1>
  <p class="sub">${esc(DATE)} · GitHub 那 ${j.scan.gh_deep} 个我真去读了代码，不是读 README</p>
</div>
<div class="basis">
  <div class="row1">
    <div><b>扫 ${j.scan.gh_scanned} · 读码 ${j.scan.gh_deep} · 浅过 ${j.scan.gh_shallow}</b>GitHub Trending</div>
    <div><b>扫 ${j.scan.x_recorded} · 选 ${j.scan.x_selected}</b>X For you</div>
  </div>
  <p style="margin:0 0 6px">${rich(j.scan.gh_scope)}</p>
  <p style="margin:0">${rich(j.scan.x_scope)}</p>
</div>
<div class="xfind">
  <h3>${esc(j.cross_finding.title)}</h3>
  <div>${rich(j.cross_finding.body)}</div>
</div>

<div class="tabsE" role="tablist">
  <button type="button" role="tab" data-pane="gh" aria-selected="true">GitHub Trending<span class="cnt">${nGh}</span></button>
  <button type="button" role="tab" data-pane="x"  aria-selected="false">X · For you<span class="cnt">${nX}</span></button>
</div>
<section class="paneE" data-pane="gh">
<div class="wrapE">
  ${sec("⌘ GitHub · 读了代码", byKind("deep").length)}
  ${byKind("deep").map(one).join("\n")}
  ${sec("⌘ GitHub · 只扫了没深入", byKind("shallow").length)}
  ${byKind("shallow").map(one).join("\n")}
</div>
</section>
<section class="paneE" data-pane="x" hidden>
<div class="basis" style="margin-top:18px">
  <p style="margin:0 0 8px">${rich(j.x.blocked_banner)}</p>
  <p style="margin:0 0 8px">${rich(j.x.summary)}</p>
  <p class="tone">${rich(j.x.tone)}</p>
</div>
<div class="wrapE">
  ${sec("𝕏 For you", nX)}
  ${byKind("x").map(one).join("\n")}
</div>
</section>

<div class="foot">
  备注存在你这台机器的浏览器里（localStorage），换机器看不到。<br>
  「⚪ 只扫了」= 我没去核原物 —— 那是「未知」，不是「可信」。
</div>

<button class="copyall">复制我写的全部备注</button>
<script nonce="__CSP_NONCE__">
(function(){
 // ── tab(照搬方向 E 已验收的那段)──
 function setPane(v){
   document.querySelectorAll('.paneE').forEach(function(p){ p.hidden = (p.dataset.pane!==v); });
   document.querySelectorAll('.tabsE button').forEach(function(b){
     b.setAttribute('aria-selected', String(b.dataset.pane===v)); });
 }
 document.querySelectorAll('.tabsE button').forEach(function(b){
   b.addEventListener('click',function(){ setPane(b.dataset.pane); }); });

 // ── 备注:localStorage 存,刷新不丢 ──
 var K='fly1410-notes';
 var S={}; try{S=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){}
 function bind(t){ if(S[t.dataset.note]) t.value=S[t.dataset.note];
   t.addEventListener('input',function(){S[t.dataset.note]=t.value;
     try{localStorage.setItem(K,JSON.stringify(S))}catch(e){}}); }
 document.querySelectorAll('textarea.note').forEach(bind);

 // ── 复制全部备注 ──
 // 剪贴板 API 会因为不安全上下文 / 没授权而拒绝。原版只写了 .then,
 // 拒绝时按钮一声不吭 —— 她会以为复制成功了。所以补一条兜底路径。
 function fallback(s){
   var ta=document.createElement('textarea');
   ta.value=s; ta.setAttribute('readonly','');
   ta.style.position='fixed'; ta.style.top='0'; ta.style.opacity='0';
   document.body.appendChild(ta); ta.select();
   var ok=false; try{ ok=document.execCommand('copy'); }catch(e){ ok=false; }
   document.body.removeChild(ta);
   return ok;
 }
 var b=document.querySelector('.copyall');
 if(b) b.addEventListener('click',function(){
   var out=[]; document.querySelectorAll('textarea.note').forEach(function(t){
     if(t.value.trim()) out.push('['+t.dataset.note+'] '+t.value.trim()); });
   var s=out.join('\\n\\n')||'（还没有写备注）';
   function done(){ b.textContent='已复制 '+out.length+' 条';
     setTimeout(function(){b.textContent='复制我写的全部备注'},1800); }
   function failed(){
     // 失败不能只是说一声就完 —— 备注可能还折叠着,她连选都选不到。
     // 把有内容的那几条展开,让「手动选中」这句话真的可执行。
     document.querySelectorAll('textarea.note').forEach(function(t){
       if(t.value.trim()){ var d=t.closest('details'); if(d){ d.open=true; } } });
     b.textContent='复制失败 —— 备注已展开，请手动选中';
     setTimeout(function(){b.textContent='复制我写的全部备注'},2600); }
   try{
     if(navigator.clipboard && navigator.clipboard.writeText){
       navigator.clipboard.writeText(s).then(done, function(){ if(fallback(s)){done()}else{failed()} });
     } else if(fallback(s)){ done(); } else { failed(); }
   }catch(e){ if(fallback(s)){done()}else{failed()} }
 });
})();
</script>
</body></html>
`;

/* ─────────────────────── 生成期自检 ───────────────────────
   静态门全绿也可以是坏的 —— 这些只挡缺陷,挡不了「渲染出来对不对」。
   后者必须真开浏览器看,是另一件事。                                   */
{
	const fail = (m) => {
		throw new Error(m);
	};
	// ① 每一个 script 都要带 nonce,而且每一段都要能真的解析
	const all = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
	if (all.length === 0) fail("一个 script 都没有");
	for (const [, attrs, code] of all) {
		if (!/nonce="__CSP_NONCE__"/.test(attrs))
			fail(`有 script 没带 nonce: <script${attrs}>`);
		try {
			new Function(code);
		} catch (e) {
			fail(`内联脚本语法错误,页面 JS 会全死: ${e.message}`);
		}
	}
	if (/\son[a-z]+\s*=/i.test(html)) fail("出现 inline handler,违反 nonce 硬门");
	if (/src="https?:\/\//i.test(html)) fail("出现外链图/资源,CSP 只放 data:");
	// ② 不要暗色模式(Annie 硬线)。color-scheme:light 是钉死浅色,不算分支。
	if (/prefers-color-scheme/.test(html))
		fail("出现 prefers-color-scheme,违反「不要暗色模式」");
	// ③ 未渲染的 markdown 标记漏到页面上 —— 不设界限地查
	for (const [mark, name] of [
		["**", "加粗"],
		["`", "反引号"],
	]) {
		const at = html.indexOf(mark);
		if (at !== -1)
			fail(
				`页面上漏出了未渲染的${name}标记: ...${html.slice(Math.max(0, at - 30), at + 40)}...`,
			);
	}
	// ④ 卡片数跟数据源比,不硬写数字 —— 要保证的是「版式没吃掉任何一条」
	const cards = (html.match(/class="itemE\b[^"]*"/g) || []).length;
	const want = model.length;
	if (cards !== want)
		fail(`卡片 ${cards} 条,数据源 ${want} 条 —— 版式吃掉了条目`);
	// ⑤ 每条都要有备注框
	const notes = (html.match(/<textarea class="note"/g) || []).length;
	if (notes !== want) fail(`备注框 ${notes} 个,条目 ${want} 条`);
	// ⑥ 樱白皮肤真的在页面里(而不是 CSS 文件读错了)
	if (!/radial-gradient/.test(html) || !/border-radius:16px/.test(html))
		fail("樱白皮肤特征没出现在页面里,CSS 可能没接上");
	// ⑦ 那条命中数为 0 的死规则不许回来 —— 从 POC 照抄很容易又把它带进来。
	//    必须先把注释剥掉再查:解释这条规则的那段注释里就写着它的选择器,
	//    直接 grep 会把「注释提到它」误判成「规则回来了」(第一版就是这么自己拦自己的)。
	const cssCode = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
	if (/\.met\b/.test(cssCode))
		fail("死规则 .met 又回到 CSS 里了(命中数为 0,见文件头说明)");
	// ⑧ 复制按钮必须存在,否则那段绑定是空跑
	if (!/class="copyall"/.test(html))
		fail("复制按钮不在页面里,复制那段绑定是空跑");
	// ⑨ 备注框必须【默认展开】—— 只数个数不够,折叠着的也是 24 个
	const nbdAll = html.match(/<details class="nbd"[^>]*>/g) || [];
	const nbdOpen = nbdAll.filter((t) => /\bopen\b/.test(t)).length;
	if (nbdOpen !== want)
		fail(`备注框展开 ${nbdOpen} 个,应为 ${want} 个(有折叠着的)`);
	// ⑩ 编号按 tab 各自从 1 数 —— 判据跟【该 tab 的真实条数】比,不写死数字
	const paneBody = (id) => {
		const m = html.match(
			new RegExp(
				`<section class="paneE" data-pane="${id}"[^>]*>([\\s\\S]*?)</section>`,
			),
		);
		if (!m) fail(`找不到 ${id} 这个 tab`);
		return m[1];
	};
	const panes = [
		{ id: "gh", items: byKind("deep").length + byKind("shallow").length },
		{ id: "x", items: byKind("x").length },
	];
	const paneReport = [];
	for (const p of panes) {
		const body = paneBody(p.id);
		const nos = [...body.matchAll(/<span class="no">(\d+)<\/span>/g)].map((m) =>
			Number(m[1]),
		);
		if (nos.length !== p.items)
			fail(`${p.id} 面编号 ${nos.length} 个,条目 ${p.items} 条`);
		const want1toN = Array.from({ length: p.items }, (_, i) => i + 1);
		if (nos.join(",") !== want1toN.join(","))
			fail(
				`${p.id} 面编号不是 1..${p.items},实际是 ${nos.slice(0, 3).join(",")}…${nos.slice(-2).join(",")}`,
			);
		paneReport.push(`${p.id} 1..${nos[nos.length - 1]}(${p.items} 条)`);
	}
	const KB = Buffer.byteLength(html) / 1024;
	if (KB > 512) fail(`HTML ${KB.toFixed(0)}KB 超过 512KB 上限`);

	console.log(`✅ daily-brief.html ${KB.toFixed(0)}KB · ${DATE}`);
	console.log(
		`   卡片 ${cards} = 数据源 ${want}(读码 ${deep.length} · 浅过 ${shallow.length} · X ${xs.length})`,
	);
	console.log(`   编号按 tab 各自从 1:${paneReport.join(" · ")}`);
	console.log(
		`   备注框 ${notes}(默认展开 ${nbdOpen})· script ${all.length}(全部带 nonce)· 裸 script 0 · prefers-color-scheme 0`,
	);
}

writeFileSync(join(DIR, "daily-brief.html"), html, "utf8");
