#!/usr/bin/env node
/**
 * FLY-1704 — 早报 feed 四个版式方向的 mockup 生成器。
 *
 *   node build-mockups.mjs
 *
 * 输入:../data-judgments.json —— 从 FLY-1410 v8 原样复制的真实数据,**只读**。
 * 输出:direction-a.html / -b / -c / -d + index.html(并排对比页)
 *
 * 这不是产品代码。它只回答一个问题:同一份内容,四种摆法,Annie 要哪种。
 * 内容一个字不改 —— 见 plan.md §2 的构建期硬断言,跑不过就 exit(1)。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const j = JSON.parse(
	readFileSync(join(DIR, "..", "data-judgments.json"), "utf8"),
);

/* ─────────────────────────── 工具 ─────────────────────────── */

const esc = (s) =>
	String(s ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);

/** v8 的 markdown 子集:**加粗** 和 `code` */
const rich = (s) =>
	esc(s)
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");

const stripTags = (h) => String(h).replace(/<[^>]*>/g, "");

/** 原文和渲染结果走同一条管道,才能拿来比 —— plan.md §2 */
const normalize = (s) => stripTags(rich(s)).replace(/\s+/g, " ").trim();

/**
 * plan.md §1 —— 把 why 切成「一句论断」+「余下原文」。
 * 断言 lead + rest === why(逐字),所以标题用 lead、正文续 rest,一个字不丢也不重复。
 * 实测:13 条深读里 8 条的 why 是多句的 —— 直接截首句会丢字,所以是切分不是截取。
 */
function splitLead(why) {
	const s = String(why ?? "");
	// 🔴 不能在 **加粗** 或 `代码` 跨度中间切。实测 4 条 why 长这样:
	//    "**一个人写的单个技能,涨到六千多星。** 而且它的做法很朴素:…"
	//    在第一个句号处硬切 → lead 拿到落单的 "**",rich() 配不成对 → 页面上直接漏出 ** 星号。
	// 所以扫的时候记着自己在不在标记里面,只在**外面**的句末标点切。
	// 情况一:整句话就是以 **加粗** 开头的一段论断(Import AI 的经典形状)——
	// 那个加粗跨度本身就是导语,在它的收尾 ** 之后切。
	//
	// ⚠️ 合同精确表述(Codex 复审提的):导语 = **第一个在标记外结束的句子**;
	//    若整段以加粗论断开头,则**整个加粗跨度**算导语 —— 即使跨度里不止一句。
	//    当前数据里 paperclipai/paperclip 就是这种(加粗跨度内两句),两句一起做导语。
	//    这是刻意的:那一整跨度本来就是作者自己划出来的「一句话论断」,
	//    从中间切开会切断 ** 配对,星号会印到页面上(已经栽过一次)。
	if (s.startsWith("**")) {
		const close = s.indexOf("**", 2);
		if (close > 0) {
			const inner = s.slice(2, close);
			if (/[。！？!?]/.test(inner))
				return { lead: s.slice(0, close + 2), rest: s.slice(close + 2) };
		}
	}
	// 情况二:在标记**外面**的第一个句末标点切。
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

/** GitHub 条目没有 id,必须派生 —— plan.md §2 */
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

/* ───────────────────── 统一的条目模型 ───────────────────── */
/* 三种形状(plan.md §2):GH 深读 13 / GH 浅扫 5 / X 6 = 24 条 */

const deep = j.github.filter((r) => r.depth !== "shallow");
const shallow = j.github.filter((r) => r.depth === "shallow");
const xs = j.x.items;

let seq = 0;
const model = [
	...deep.map((r) => ({
		kind: "deep",
		raw: r,
		key: itemKey(r),
		n: ++seq,
		...splitLead(r.why),
	})),
	...shallow.map((r) => ({
		kind: "shallow",
		raw: r,
		key: itemKey(r),
		n: ++seq,
		lead: "",
		rest: "",
	})),
	...xs.map((r) => ({
		kind: "x",
		raw: r,
		key: itemKey(r),
		n: ++seq,
		...splitLead(r.why),
	})),
];

const byKind = (k) => model.filter((m) => m.kind === k);

/* 元数据行(每种形状不一样) */
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

/** 条末核验说明 */
const checkLine = (m) =>
	m.raw.check_note
		? `<div class="chk">${stateOf(m.raw).icon} ${rich(m.raw.check_note)}</div>`
		: `<div class="chk dim">${stateOf(m.raw).icon} ${esc(stateOf(m.raw).label)} —— 我没去核原物，这不是「可信」，是「未知」。</div>`;

/** 备注框 —— Annie v7 硬要求:每条一个、能选中复制、localStorage 存 */
const note = (key, open = false) =>
	open
		? `<div class="nb"><textarea class="note" data-note="${esc(key)}" rows="2" placeholder="写几句，刷新不会丢"></textarea></div>`
		: `<details class="nbd"><summary>+ 备注</summary><div class="nb"><textarea class="note" data-note="${esc(key)}" rows="2" placeholder="写几句，刷新不会丢"></textarea></div></details>`;

/* ───────────────────── 共享 CSS + 页壳 ───────────────────── */

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:0;background:#fff;color:#1d1d1f;
 font:15.5px/1.85 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB",system-ui,sans-serif;
 -webkit-font-smoothing:antialiased}
a{color:#0645c8}
code{font:.86em/1 "SF Mono",ui-monospace,monospace;background:#f2f2f4;padding:1px 5px;border-radius:4px}
.pagehd{max-width:900px;margin:0 auto;padding:52px 24px 0}
.pagehd h1{font-size:30px;letter-spacing:-.02em;margin:0 0 4px;font-weight:700}
.pagehd .sub{color:#86868b;font-size:13.5px;margin:0 0 4px}
.dirtag{display:inline-block;margin:14px 0 0;padding:5px 12px;border-radius:999px;
 background:#f5f5f7;color:#6e6e73;font-size:12.5px}
.basis{max-width:900px;margin:26px auto 0;padding:0 24px;color:#3a3a3c;font-size:13.5px;line-height:1.75}
.basis b{color:#1d1d1f}
.basis .row1{display:flex;flex-wrap:wrap;gap:22px;margin-bottom:9px;font-size:13px;color:#6e6e73}
.basis .row1 b{display:block;font-size:16.5px;color:#1d1d1f;letter-spacing:-.01em;font-weight:650}
.xfind{max-width:900px;margin:22px auto 0;padding:16px 20px;border-left:3px solid #d2d2d7;
 color:#3a3a3c;font-size:14px;line-height:1.8}
.xfind h3{margin:0 0 6px;font-size:13px;color:#1a365d;letter-spacing:.02em;font-weight:700}
.tone{color:#8a6d00;font-size:13.5px;line-height:1.75;margin:6px 0 0}
.secthd{display:flex;align-items:baseline;gap:9px;margin:56px 0 22px;
 padding-bottom:9px;border-bottom:1px solid #ebebed}
.secthd h2{font-size:14px;font-weight:700;letter-spacing:.04em;color:#1d1d1f;margin:0}
.secthd .cnt{font-size:12.5px;color:#a1a1a6}
.no{font:400 26px/1 Georgia,"Songti SC",serif;color:#c7c7cc;font-variant-numeric:tabular-nums}
.meta{font:12px/1 "SF Mono",ui-monospace,monospace;color:#a1a1a6;letter-spacing:.01em}
.chk{margin-top:12px;font-size:12.5px;color:#6e6e73;line-height:1.7}
.chk.dim{color:#a1a1a6}
.lead{font-weight:650}
.cue{font-weight:650;color:#1a365d}
details{margin-top:12px}
summary{cursor:pointer;font-size:12.5px;color:#86868b;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸ ";color:#c7c7cc}
details[open] summary::before{content:"▾ "}
.codeblk{margin-top:12px;font-size:14px;color:#3a3a3c;line-height:1.8;
 padding-left:14px;border-left:2px solid #ebebed}
.nbd summary{margin-top:10px}
.nb{margin-top:8px}
.note{width:100%;padding:9px 11px;border:1px solid #e3e3e6;border-radius:8px;
 font:inherit;font-size:14px;resize:vertical;background:#fcfcfd;color:#1d1d1f}
.note:focus{outline:none;border-color:#0645c8;background:#fff}
.shallow{opacity:.62}
.foot{max-width:900px;margin:70px auto 0;padding:22px 24px 70px;border-top:1px solid #ebebed;
 color:#a1a1a6;font-size:12.5px;line-height:1.8}
.copyall{position:fixed;left:20px;bottom:20px;padding:9px 16px;border:0;border-radius:9px;
 background:#1d1d1f;color:#fff;font:600 13px/1 inherit;cursor:pointer;z-index:9}
.copyall:active{transform:translateY(1px)}
`;

const NOTE_JS = `
<script nonce="__CSP_NONCE__">
(function(){
 var K='fly1704-notes-'+document.body.dataset.dir;
 var S={}; try{S=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){}
 function bind(t){ if(S[t.dataset.note]) t.value=S[t.dataset.note];
   t.addEventListener('input',function(){S[t.dataset.note]=t.value;
     try{localStorage.setItem(K,JSON.stringify(S))}catch(e){}}); }
 document.querySelectorAll('textarea.note').forEach(bind);
 var b=document.querySelector('.copyall');
 if(b) b.addEventListener('click',function(){
   var out=[]; document.querySelectorAll('textarea.note').forEach(function(t){
     if(t.value.trim()) out.push('['+t.dataset.note+'] '+t.value.trim()); });
   var s=out.join('\\n\\n')||'（还没有写备注）';
   navigator.clipboard.writeText(s).then(function(){b.textContent='已复制 '+out.length+' 条';
     setTimeout(function(){b.textContent='复制我写的全部备注'},1800)});
 });
 document.querySelectorAll('[data-acc]').forEach(function(r){
   r.addEventListener('click',function(e){
     if(e.target.closest('a,textarea,summary')) return;
     // 面板在同一个条目里显式标了 data-acc-panel —— 不能用 nextElementSibling:
     // 方向 C 的清单条目下一个兄弟是那行摘要 .one,不是展开区,点了会把摘要藏掉而正文永远打不开。
     var root=r.closest('[data-fw-item]')||r.parentNode;
     var p=root.querySelector('[data-acc-panel]');
     if(!p) return;
     var open=p.hasAttribute('hidden');
     if(open){p.removeAttribute('hidden');r.setAttribute('aria-expanded','true');}
     else{p.setAttribute('hidden','');r.setAttribute('aria-expanded','false');}
   });
 });
 // 备注圆点:有内容就点亮(方向 D 的行尾状态)
 function dot(t){
   var it=t.closest('[data-fw-item]'); if(!it) return;
   var d=it.querySelector('.c-nb'); if(!d) return;
   d.textContent=t.value.trim()?'●':'○'; d.style.color=t.value.trim()?'#248a3d':'';
 }
 document.querySelectorAll('textarea.note').forEach(function(t){
   dot(t); t.addEventListener('input',function(){dot(t)});
 });
 // 方向 D 的统计行:点一下按类型筛选(再点一下取消)
 var active=null;
 document.querySelectorAll('[data-filter]').forEach(function(f){
   f.addEventListener('click',function(){
     var k=f.dataset.filter; active=(active===k)?null:k;
     document.querySelectorAll('[data-filter]').forEach(function(x){
       x.classList.toggle('on', x.dataset.filter===active); });
     document.querySelectorAll('[data-fw-item][data-kind]').forEach(function(it){
       var show=!active||active==='all'||it.dataset.kind===active
         ||(active==='verified'&&it.dataset.check==='verified');
       it.style.display=show?'':'none';
     });
   });
 });
})();
</script>`;

// 对比页(dir="index")没有备注框,不该挂「复制全部备注」按钮 —— 它还会盖住下面的标题
const page = (dir, title, css, body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_CSS}${css}</style></head>
<body data-dir="${esc(dir)}">
${body}
${dir === "index" ? "" : `<button class="copyall">复制我写的全部备注</button>`}
${dir === "index" ? "" : NOTE_JS}
</body></html>`;

/* 页顶:底数 + 横看发现 + 方向自述 */
const header = (label, bet, cost) => `
<div class="pagehd">
  <h1>早报</h1>
  <p class="sub">2026-08-11 · GitHub 那 13 个我真去读了代码，不是读 README</p>
  <span class="dirtag">${esc(label)} · 赌的是「${esc(bet)}」 · 代价：${esc(cost)}</span>
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
</div>`;

const footer = `
<div class="foot">
  这是 <b>FLY-1704 的版式方向图</b>，不是上线版本 —— 内容与 v8 逐字相同，只换了摆法。<br>
  备注存在你这台机器的浏览器里（localStorage），换机器看不到。
</div>`;

const sec = (title, count) =>
	`<div class="secthd"><h2>${esc(title)}</h2><span class="cnt">${count} 条</span></div>`;

const xBanner = `
<div class="basis" style="margin-top:18px">
  <p style="margin:0 0 8px">${rich(j.x.blocked_banner)}</p>
  <p style="margin:0 0 8px">${rich(j.x.summary)}</p>
  <p class="tone">${rich(j.x.tone)}</p>
</div>`;

/* ═══════════════════ 方向 A — 电报 Wire ═══════════════════ */

const CSS_A = `
.wrapA{max-width:608px;margin:0 auto;padding:0 24px}
.pagehd,.basis,.xfind,.foot{max-width:608px}
.itemA{padding:26px 0;border-top:1px solid #f0f0f2}
.itemA:first-of-type{border-top:0}
.hdA{display:flex;align-items:baseline;gap:11px;margin-bottom:2px}
.hdA .no{font-size:22px;min-width:28px}
.hdA a{font-size:17px;font-weight:650;text-decoration:underline;text-underline-offset:3px;letter-spacing:-.01em}
.metaA{margin:0 0 11px 39px}
.proseA{margin-left:39px}
.itemA details,.itemA .nbd{margin-left:39px}
.foldA summary{color:#0645c8}
.deepA{padding-top:10px}
.deepA p{margin:0 0 11px}
`;

/**
 * 方向 A 的取舍(值得写下来,因为它是刻意的):
 * 第一版把 lead+rest+what+relation+borrow 全部平铺,只折 code —— 实测 **11.9 屏**,
 * 比 v8 的 10.9 屏还长。原因是物理的:窄栏(521px / 34 字每行)比 v8 的 665px 每行少 12 个字,
 * 同样的字数就要多约三分之一的行。
 *
 * 一个「赌扫得快」却比被替代对象还长的版式,不是方向 A,是换了栏宽的方向 B。
 * 所以 A **只把「是什么」留在外面**(lead + rest + what),
 * 把「跟我们的关系 / 能借的 / 我读到的代码」一起收进一个折叠区 ——
 * 这正是 A 自己写明的代价:「深读要多点一下才看得到」。
 * 内容一个字没少(折叠区在 DOM 里,断言照样过),少的是**默认可见的量**。
 */
function renderA() {
	const one = (m) => {
		const r = m.raw;
		// 外面只放「这是什么」
		let prose = "";
		if (m.kind === "shallow") {
			prose = `${rich(r.what)} ${rich(r.no_code_reason)}`;
		} else if (m.kind === "x") {
			prose =
				`<span class="lead">${rich(m.lead)}</span>${m.rest ? " " + rich(m.rest) : ""} ` +
				`${rich(r.summary_cn)}`;
		} else {
			prose =
				`<span class="lead">${rich(m.lead)}</span>${m.rest ? " " + rich(m.rest) : ""} ` +
				`${rich(r.what)}`;
		}
		// 折叠区放「跟我们什么关系 / 能借什么 / 我读到的代码 / 原推」
		let deepBits = "";
		if (m.kind === "deep") {
			deepBits = `<p><span class="cue">跟我们的关系 ——</span> ${rich(r.relation)}</p>
        <p><span class="cue">能借的 ——</span> ${rich(r.borrow)}</p>
        <div class="codeblk">${rich(r.code)}</div>`;
		} else if (m.kind === "x") {
			deepBits = `<p>${rich(r.what)}</p>
        <p><span class="cue">跟我们的关系 ——</span> ${rich(r.relation)}</p>
        <p><span class="cue">能借的 ——</span> ${rich(r.borrow)}</p>
        <div class="codeblk">${rich(r.quote)}</div>`;
		}
		const fold = deepBits
			? `<details class="foldA"><summary>${m.kind === "x" ? "展开：跟我们的关系 · 能借的 · 原推" : "展开：跟我们的关系 · 能借的 · 我读到的代码"}</summary>
         <div class="deepA">${deepBits}</div></details>`
			: "";
		return `<article class="itemA${m.kind === "shallow" ? " shallow" : ""}" data-fw-item="${esc(m.key)}">
  <div class="hdA"><span class="no">${m.n}</span>
    <a href="${esc(linkOf(m))}" target="_blank" rel="noopener">${esc(titleText(m))}</a></div>
  <div class="metaA meta">${esc(metaBits(m).join("  ·  "))}</div>
  <div class="proseA" data-fw-prose>${prose}</div>
  ${fold}
  <div class="proseA">${checkLine(m)}</div>
  ${note(m.key)}
<!--/fw-item:${esc(m.key)}--></article>`;
	};

	const body = `${header("方向 A · 电报", "扫得快", "深读要多点一下")}
<div class="wrapA">
  ${sec("⌘ GitHub · 读了代码", byKind("deep").length)}
  ${byKind("deep").map(one).join("\n")}
  ${sec("⌘ GitHub · 只扫了没深入", byKind("shallow").length)}
  ${byKind("shallow").map(one).join("\n")}
</div>
${sec.length ? "" : ""}
<div class="wrapA">${sec("𝕏 For you", byKind("x").length)}</div>
${xBanner}
<div class="wrapA">${byKind("x").map(one).join("\n")}</div>
${footer}`;
	return page("a", "早报 · 方向 A 电报", CSS_A, body);
}

/* ═══════════════════ 方向 B — 简报 Briefing ═══════════════════ */

const CSS_B = `
.wrapB{max-width:790px;margin:0 auto;padding:0 24px}
.pagehd,.basis,.xfind,.foot{max-width:790px}
.itemB{display:grid;grid-template-columns:150px 1fr;gap:40px;
 padding:38px 0;border-top:1px solid #f0f0f2}
.itemB:first-of-type{border-top:0}
.railB{font-size:12.5px;color:#a1a1a6;line-height:2.05;text-align:right}
.railB .no{display:block;font-size:30px;line-height:1.1;margin-bottom:10px;color:#d8d8dc}
.railB .pen{display:block;margin-top:10px;cursor:pointer;color:#c7c7cc;font-size:15px}
.bodyB h3{font-size:19px;line-height:1.55;font-weight:650;letter-spacing:-.01em;margin:0 0 8px}
.bodyB .src{margin:0 0 14px}
.bodyB p{margin:0 0 13px}
.railB .nbd summary{text-align:right}
@media(max-width:900px){.itemB{grid-template-columns:1fr;gap:8px}
 .railB{text-align:left}.railB .no{display:inline;font-size:15px;margin-right:8px}}
`;

function renderB() {
	const one = (m) => {
		const r = m.raw;
		let prose = "";
		if (m.kind === "shallow") {
			prose = `<p>${rich(r.what)}</p><p>${rich(r.no_code_reason)}</p>`;
		} else {
			const sum = m.kind === "x" ? `<p>${rich(r.summary_cn)}</p>` : "";
			const code =
				m.kind === "deep" ? `<div class="codeblk">${rich(r.code)}</div>` : "";
			const quote =
				m.kind === "x"
					? `<details><summary>看原推</summary><div class="codeblk">${rich(r.quote)}</div></details>`
					: "";
			prose =
				`${m.rest ? `<p>${rich(m.rest)}</p>` : ""}${sum}<p>${rich(r.what)}</p>${code}` +
				`<p><span class="cue">这跟我们的关系 ——</span> ${rich(r.relation)}</p>` +
				`<p><span class="cue">能借的 ——</span> ${rich(r.borrow)}</p>${quote}`;
		}
		const head =
			m.kind === "shallow"
				? `<h3><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.repo)}</a></h3>`
				: `<h3>${rich(m.lead)}</h3>
           <div class="src meta"><a href="${esc(linkOf(m))}" target="_blank" rel="noopener">${esc(titleText(m))} ↗</a></div>`;
		return `<article class="itemB${m.kind === "shallow" ? " shallow" : ""}" data-fw-item="${esc(m.key)}">
  <div class="railB"><span class="no">${m.n}</span>
    ${metaBits(m)
			.map((b) => `<div>${esc(b)}</div>`)
			.join("")}
    ${note(m.key)}
  </div>
  <div class="bodyB">${head}<div data-fw-prose>${prose}</div>${checkLine(m)}</div>
<!--/fw-item:${esc(m.key)}--></article>`;
	};
	const body = `${header("方向 B · 简报", "读的时候不被打断", "要宽屏；手机上塌成单栏")}
<div class="wrapB">
  ${sec("⌘ GitHub · 读了代码", byKind("deep").length)}
  ${byKind("deep").map(one).join("\n")}
  ${sec("⌘ GitHub · 只扫了没深入", byKind("shallow").length)}
  ${byKind("shallow").map(one).join("\n")}
  ${sec("𝕏 For you", byKind("x").length)}
</div>
${xBanner}
<div class="wrapB">${byKind("x").map(one).join("\n")}</div>
${footer}`;
	return page("b", "早报 · 方向 B 简报", CSS_B, body);
}

/* ═══════════════════ 方向 C — 杂志 Magazine ═══════════════════ */

const CSS_C = `
.wrapC{max-width:660px;margin:0 auto;padding:0 24px}
.pagehd,.basis,.xfind,.foot{max-width:660px}
.lede{padding:34px 0 40px;border-bottom:2px solid #1d1d1f}
.lede .kicker{font-size:11.5px;letter-spacing:.14em;color:#b8860b;font-weight:700;margin-bottom:12px}
.lede h2{font-size:33px;line-height:1.36;letter-spacing:-.025em;font-weight:700;margin:0 0 14px}
.lede .src{margin-bottom:18px}
.lede p{margin:0 0 14px;font-size:16.5px}
.second{padding:30px 0;border-bottom:1px solid #ebebed}
.second h3{font-size:21px;line-height:1.5;font-weight:650;letter-spacing:-.015em;margin:0 0 7px}
.second .src{margin-bottom:12px}
.second p{margin:0 0 11px}
.rest{padding:22px 0;border-bottom:1px solid #f2f2f4;cursor:pointer}
.rest .rhd{display:flex;gap:13px;align-items:baseline}
.rest .no{font-size:19px;min-width:26px}
.rest h4{font-size:15.5px;font-weight:600;line-height:1.65;margin:0;flex:1}
.rest .one{margin:5px 0 0 39px;color:#6e6e73;font-size:14px;line-height:1.75}
.rest .exp{margin-left:39px;padding-top:12px}
.rest .exp p{margin:0 0 11px}
.rest[aria-expanded="true"] .one{display:none}
.subhd{margin:34px 0 4px;font-size:12px;letter-spacing:.06em;color:#a1a1a6;font-weight:700}
.lede .no,.second .no{font-size:20px;margin-right:9px}
`;

function renderC() {
	const ranked = [...byKind("deep")].sort(
		(a, b) => num(b.raw.stars_today) - num(a.raw.stars_today),
	);
	const [top, ...restDeepAll] = ranked;
	const seconds = restDeepAll.slice(0, 3);
	const listDeep = restDeepAll.slice(3);

	const full = (m) => {
		const r = m.raw;
		const sum = m.kind === "x" ? `<p>${rich(r.summary_cn)}</p>` : "";
		const code =
			m.kind === "deep" ? `<div class="codeblk">${rich(r.code)}</div>` : "";
		const quote =
			m.kind === "x"
				? `<details><summary>看原推</summary><div class="codeblk">${rich(r.quote)}</div></details>`
				: "";
		if (m.kind === "shallow")
			return `<p>${rich(r.what)}</p><p>${rich(r.no_code_reason)}</p>`;
		return `${m.rest ? `<p>${rich(m.rest)}</p>` : ""}${sum}<p>${rich(r.what)}</p>${code}
<p><span class="cue">这跟我们的关系 ——</span> ${rich(r.relation)}</p>
<p><span class="cue">能借的 ——</span> ${rich(r.borrow)}</p>${quote}`;
	};

	const lede = (m) => `<article class="lede" data-fw-item="${esc(m.key)}">
  <div class="kicker">今晚头条</div>
  <h2><span class="no">${m.n}</span>${rich(m.lead)}</h2>
  <div class="src meta"><a href="${esc(linkOf(m))}" target="_blank" rel="noopener">${esc(titleText(m))} ↗</a>  ·  ${esc(metaBits(m).join("  ·  "))}</div>
  <div data-fw-prose>${full(m)}</div>${checkLine(m)}${note(m.key, true)}<!--/fw-item:${esc(m.key)}--></article>`;

	const secnd = (m) => `<article class="second" data-fw-item="${esc(m.key)}">
  <h3><span class="no">${m.n}</span>${rich(m.lead)}</h3>
  <div class="src meta"><a href="${esc(linkOf(m))}" target="_blank" rel="noopener">${esc(titleText(m))} ↗</a>  ·  ${esc(metaBits(m).join("  ·  "))}</div>
  <div data-fw-prose>${full(m)}</div>${checkLine(m)}${note(m.key, true)}<!--/fw-item:${esc(m.key)}--></article>`;

	const row = (m) => {
		const head = m.kind === "shallow" ? esc(m.raw.repo) : rich(m.lead);
		const oneLine = m.kind === "shallow" ? rich(m.raw.what) : esc(titleText(m));
		return `<article class="rest" data-fw-item="${esc(m.key)}">
  <div class="rhd" data-acc aria-expanded="false"><span class="no">${m.n}</span><h4>${head}</h4></div>
  <div class="one">${oneLine}  ·  ${esc(metaBits(m).join("  ·  "))}</div>
  <div class="exp" data-acc-panel hidden>
    <div class="meta" style="margin-bottom:10px"><a href="${esc(linkOf(m))}" target="_blank" rel="noopener">${esc(titleText(m))} ↗</a></div>
    <div data-fw-prose>${full(m)}</div>${checkLine(m)}${note(m.key, true)}
  </div><!--/fw-item:${esc(m.key)}--></article>`;
	};

	const body = `${header("方向 C · 杂志", "替你做减法", "需要「谁是头条」的排序判断")}
<div class="wrapC">
  ${lede(top)}
  <div class="subhd">要闻</div>
  ${seconds.map(secnd).join("\n")}
  <div class="secthd"><h2>其余 ${listDeep.length + byKind("shallow").length + byKind("x").length} 条</h2><span class="cnt">点开就地展开</span></div>
  <div class="subhd">⌘ GitHub · 读了代码</div>
  ${listDeep.map(row).join("\n")}
  <div class="subhd">⌘ GitHub · 只扫了没深入</div>
  ${byKind("shallow").map(row).join("\n")}
  <div class="subhd">𝕏 For you</div>
</div>
${xBanner}
<div class="wrapC">${byKind("x").map(row).join("\n")}
  <p style="margin:26px 0 0;color:#a1a1a6;font-size:12.5px;line-height:1.8">
    分级规则（程序化，可核）：先取「真读了代码」的 ${byKind("deep").length} 条，按今日涨星降序，
    第 1 名做头条、第 2–4 名做要闻，其余全进清单。<b>排序算法对不对由你定，这一版只定版式。</b></p>
</div>
${footer}`;
	return page("c", "早报 · 方向 C 杂志", CSS_C, body);
}

/* ═══════════════════ 方向 D — 工作台 Console ═══════════════════ */

const CSS_D = `
.wrapD{max-width:1080px;margin:0 auto;padding:0 24px}
.pagehd,.basis,.xfind,.foot{max-width:1080px}
.stat{display:flex;gap:20px;margin:30px 0 14px;font-size:12.5px;color:#6e6e73;
 font-family:"SF Mono",ui-monospace,monospace}
.stat b{color:#1d1d1f}
.stat span[data-filter]{cursor:pointer;padding:3px 9px;border-radius:6px}
.stat span[data-filter]:hover{background:#f0f0f2}
.stat span.on{background:#1d1d1f;color:#fff}
.stat span.on b{color:#fff}
.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl thead th{text-align:left;font-size:11px;letter-spacing:.06em;color:#a1a1a6;font-weight:700;
 padding:0 10px 8px;border-bottom:1px solid #e3e3e6}
.rowD{cursor:pointer}
.rowD:nth-child(4n+1){background:#fafafb}
.rowD>div{padding:8px 10px;line-height:1.5;vertical-align:middle}
.rowD .c-no{color:#c7c7cc;font-variant-numeric:tabular-nums;width:38px}
.rowD .c-src{width:26px;color:#a1a1a6}
.rowD .c-name{width:232px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rowD .c-qty{width:112px;color:#6e6e73;font-family:"SF Mono",ui-monospace,monospace;font-size:11.5px}
.rowD .c-st{width:128px;font-size:11.5px;color:#6e6e73;white-space:nowrap;overflow:hidden}
.rowD .c-one{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3a3a3c}
.rowD .c-nb{width:26px;text-align:center;color:#d8d8dc}
.rowD{display:flex;align-items:baseline;border-bottom:1px solid #f4f4f6}
.rowD:hover{background:#f5f8ff}
.rowD[aria-expanded="true"]{background:#f0f4ff;font-weight:600}
.expD{padding:16px 10px 26px 48px}
.expD .inner{max-width:500px}
.expD p{margin:0 0 12px;font-size:15px;line-height:1.85}
.expD h4{margin:0 0 10px;font-size:17px;line-height:1.55;font-weight:650}
.coldD{margin:30px 0 8px;padding:12px 14px;background:#fffbe9;border-radius:8px;
 color:#8a6d00;font-size:13px;line-height:1.75}
`;

function renderD() {
	const one = (m) => {
		const r = m.raw;
		const sum = m.kind === "x" ? `<p>${rich(r.summary_cn)}</p>` : "";
		const code =
			m.kind === "deep" ? `<div class="codeblk">${rich(r.code)}</div>` : "";
		const quote =
			m.kind === "x"
				? `<details><summary>看原推</summary><div class="codeblk">${rich(r.quote)}</div></details>`
				: "";
		const prose =
			m.kind === "shallow"
				? `<p>${rich(r.what)}</p><p>${rich(r.no_code_reason)}</p>`
				: `${m.rest ? `<p>${rich(m.rest)}</p>` : ""}${sum}<p>${rich(r.what)}</p>${code}
<p><span class="cue">这跟我们的关系 ——</span> ${rich(r.relation)}</p>
<p><span class="cue">能借的 ——</span> ${rich(r.borrow)}</p>${quote}`;
		const oneLine = m.kind === "shallow" ? m.raw.what : m.lead;
		const qty = m.kind === "x" ? kviews(r.views) : `+${r.stars_today} 星`;
		const st =
			m.kind === "shallow"
				? "— 没读代码"
				: `${stateOf(r).icon} ${stateOf(r).label}`;
		return `<article data-fw-item="${esc(m.key)}" data-kind="${m.kind}" data-check="${esc(r.check ?? "scanned")}">
  <div class="rowD${m.kind === "shallow" ? " shallow" : ""}" data-acc aria-expanded="false">
    <div class="c-no">${m.n}</div><div class="c-src">${m.kind === "x" ? "𝕏" : "⌘"}</div>
    <div class="c-name">${esc(titleText(m))}</div><div class="c-qty">${esc(qty)}</div>
    <div class="c-st">${esc(st)}</div><div class="c-one">${rich(oneLine)}</div><div class="c-nb">○</div>
  </div>
  <div class="expD" data-acc-panel hidden><div class="inner">
    <h4>${m.kind === "shallow" ? esc(r.repo) : rich(m.lead)}</h4>
    <div class="meta" style="margin-bottom:12px"><a href="${esc(linkOf(m))}" target="_blank" rel="noopener">${esc(titleText(m))} ↗</a>  ·  ${esc(metaBits(m).join("  ·  "))}</div>
    <div data-fw-prose>${prose}</div>${checkLine(m)}${note(m.key, true)}
  </div></div><!--/fw-item:${esc(m.key)}--></article>`;
	};
	const body = `${header("方向 D · 工作台", "先给全局，再钻细节", "那一句话结论必须真的够好")}
<div class="wrapD">
  <div class="coldD">这一版赌的是<b>你想先看全貌</b> —— 一屏看完今晚一共有什么，再决定钻哪条。
    如果你其实是想坐下来「读」，这一版会显得冷。<b>它是故意做成对照组的。</b></div>
  <div class="stat"><span data-filter="all"><b>${model.length}</b> 条</span>
    <span data-filter="deep">读了代码 <b>${byKind("deep").length}</b></span>
    <span data-filter="shallow">只扫了 <b>${byKind("shallow").length}</b></span>
    <span data-filter="x">X <b>${byKind("x").length}</b></span>
    <span data-filter="verified">核过原物 <b>${model.filter((m) => m.raw.check === "verified").length}</b></span></div>
  <div class="tbl"><div class="rowD" style="border-bottom:1px solid #e3e3e6;cursor:default;background:none">
    <div class="c-no meta">№</div><div class="c-src"></div><div class="c-name meta">名字</div>
    <div class="c-qty meta">量</div><div class="c-st meta">状态</div>
    <div class="c-one meta">一句话结论（点开看全文）</div><div class="c-nb meta">备</div></div>
  ${model.map(one).join("\n")}
  </div>
</div>
${xBanner}
${footer}`;
	return page("d", "早报 · 方向 D 工作台", CSS_D, body);
}

/* ═══════════════════ 构建期硬断言(plan.md §2) ═══════════════════ */

const PROSE_FIELDS = {
	deep: ["repo", "code", "what", "relation", "borrow", "check_note"],
	shallow: ["repo", "what", "no_code_reason", "check_note"],
	x: [
		"author",
		"quote",
		"what",
		"relation",
		"borrow",
		"check_note",
		"summary_cn",
	],
};

function assertAll(dir, html, opts = {}) {
	// 🔴 有的方向会**故意**把一个字段拆成「完整第一句」+「余下」放在两处
	//    (方向 E:第一句在正文两行里,余下在折叠区)。
	//    这时拿整条原文去找连续匹配会必然误红 —— 跟 why 拆成 lead/rest 是同一回事。
	//    所以这类字段改为**分别断言两半**,合起来仍然逐字覆盖全文,一个字不丢。
	const splitFields = new Set(opts.splitFields ?? []);
	const firstOf = (t) => splitLead(String(t ?? "")).lead.trim();
	const errs = [];

	// A 层:lead + rest 逐字等于 why
	for (const m of model) {
		if (m.kind === "shallow") continue;
		if (m.lead + m.rest !== String(m.raw.why))
			errs.push(`[A] ${m.key}: splitLead 不还原 why`);
	}

	// key 唯一
	const keys = model.map((m) => m.key);
	if (new Set(keys).size !== keys.length) errs.push(`[key] itemKey 有重复`);
	if (model.length !== 24) errs.push(`[key] 条目数 ${model.length} != 24`);

	// 把 HTML 按 data-fw-item 切段
	const parts = html.split(/<(?:article|div)[^>]*data-fw-item="/).slice(1);
	if (parts.length !== 24)
		errs.push(`[B] data-fw-item 段数 ${parts.length} != 24`);
	// 两份:seg = 去标签的可读文本(比散文字段);rawSeg = 原始 HTML(比 url,它住在 href 属性里)
	// 🔴 边界必须是**显式闭合标记**,不能切到「下一个 opening tag」为止 ——
	//    否则条目外的兄弟元素只要排在下一个锚点之前,就会被算进上一条然后蒙混过关。
	//    每个条目渲染时在自己的收尾处打了 <!--/fw-item:KEY-->,按它切,边界跟 DOM 一致。
	const seg = {};
	const rawSeg = {};
	for (const p of parts) {
		const k = p.slice(0, p.indexOf('"'));
		const end = p.indexOf(`<!--/fw-item:${k}-->`);
		if (end < 0) {
			errs.push(
				`[B] ${k}: 找不到闭合标记 <!--/fw-item:${k}--> —— 切段边界不可信`,
			);
			continue;
		}
		const inside = p.slice(0, end);
		seg[k] = (seg[k] ?? "") + stripTags(inside).replace(/\s+/g, " ");
		rawSeg[k] = (rawSeg[k] ?? "") + inside;
	}

	// B 层:逐条目 · 散文白名单
	let fieldCount = 0;
	for (const m of model) {
		const s = seg[m.key];
		if (s === undefined) {
			errs.push(`[B] ${m.key}: 页面里找不到这一段`);
			continue;
		}
		const checks = PROSE_FIELDS[m.kind].map((f) => [f, m.raw[f]]);
		if (m.kind !== "shallow") {
			checks.push(["lead", m.lead]);
			if (m.rest.trim()) checks.push(["rest", m.rest]);
		}
		for (const [name, val] of checks) {
			if (val === null || val === undefined || String(val).trim() === "")
				continue;
			if (splitFields.has(name)) {
				// 拆两半分别断言:第一句 + 余下。两半拼起来 = 原文,覆盖不缩水。
				const head = firstOf(val);
				const tail = String(val).slice(head.length).trim();
				fieldCount++;
				if (!s.includes(normalize(head)))
					errs.push(`[B] ${m.key}: 字段 ${name} 的第一句不在该条目段里`);
				if (tail) {
					fieldCount++;
					if (!s.includes(normalize(tail)))
						errs.push(`[B] ${m.key}: 字段 ${name} 的余下部分不在该条目段里`);
				}
				continue;
			}
			fieldCount++;
			if (!s.includes(normalize(val)))
				errs.push(`[B] ${m.key}: 字段 ${name} 不在该条目段里`);
		}
		// url 住在 href 属性里,必须比原始 HTML 段而不是去标签后的文本
		if (!rawSeg[m.key].includes(`href="${esc(m.raw.url)}"`))
			errs.push(`[B] ${m.key}: url 不在该条目段的任何 href 里`);

		// 🔴 显示时会重排的字段(星数/语言/浏览量/核验状态/编号)不能只因为「不好比原值」就不比。
		//    Codex 实测:把 metaBits() 换成 () => [] 之后,四个方向照样报 24/24 全绿 ——
		//    整批星数、语言、浏览量、核验状态可以人间蒸发而断言不响。
		//    所以这里比的是**格式化后的期望值**,而不是放弃。
		const display =
			m.kind === "x"
				? [
						["author", m.raw.author],
						["views", kviews(m.raw.views)],
					]
				: [
						["stars", `+${m.raw.stars_today} 星`],
						["lang", m.raw.lang ?? "—"],
					];
		display.push(["state", stateOf(m.raw).label]);
		display.push(["seq", String(m.n)]);
		for (const [name, val] of display) {
			if (!val) continue;
			fieldCount++;
			if (!s.includes(normalize(val)))
				errs.push(`[B] ${m.key}: 显示字段 ${name}(${val}) 不在该条目段里`);
		}
		// 备注框:每条恰好一个,且 data-note 是这条自己的 key
		const notes = (rawSeg[m.key].match(/<textarea[^>]*data-note="/g) ?? [])
			.length;
		if (notes !== 1) errs.push(`[B] ${m.key}: 备注框 ${notes} 个,应为 1`);
		if (!rawSeg[m.key].includes(`data-note="${esc(m.key)}"`))
			errs.push(`[B] ${m.key}: 备注框绑的不是自己的 key`);
	}

	// 页级字段
	const flat = stripTags(html).replace(/\s+/g, " ");
	const pageLevel = {
		"scan.gh_scope": j.scan.gh_scope,
		"scan.x_scope": j.scan.x_scope,
		"cross_finding.title": j.cross_finding.title,
		"cross_finding.body": j.cross_finding.body,
		"x.blocked_banner": j.x.blocked_banner,
		"x.summary": j.x.summary,
		"x.tone": j.x.tone,
	};
	for (const [name, val] of Object.entries(pageLevel))
		if (!flat.includes(normalize(val))) errs.push(`[page] ${name} 不在页面里`);

	// 锚点
	const labels = (html.match(/data-fw-label/g) ?? []).length;
	if (labels !== 0) errs.push(`[anchor] data-fw-label = ${labels}, 必须 0`);

	// 🔴 markdown 标记必须全部被 rich() 吃掉 —— 页面上不许漏出裸 ** 或落单的反引号。
	// 这条是被真 bug 逼出来的:splitLead 早先在 **加粗** 中间切,4 条 why 的星号直接印到了标题上。
	// 只靠肉眼看截图会漏(它长得就像内容的一部分),所以做成构建期断言。
	const leakStars = (flat.match(/\*\*/g) ?? []).length;
	if (leakStars)
		errs.push(`[md] 页面文本里漏出 ${leakStars} 处裸 ** —— 标记被切断了`);
	const leakTicks = (flat.match(/`/g) ?? []).length;
	if (leakTicks) errs.push(`[md] 页面文本里漏出 ${leakTicks} 处裸反引号`);

	if (errs.length) {
		console.error(`\n❌ ${dir} 断言失败 (${errs.length} 条):`);
		errs.slice(0, 25).forEach((e) => console.error("   " + e));
		process.exit(1);
	}
	console.log(
		`✅ ${dir}: 24/24 条目 · ${fieldCount} 个散文字段 · ${Object.keys(pageLevel).length} 个页级字段 · 0 个字段名`,
	);
}

/* 轮 2:tab 切换 + 配色切换。两者都只改 class/attr,不动任何 DOM 结构。 */
const TABS_PAL_JS = `
<script nonce="__CSP_NONCE__">
(function(){
 var PK='fly1704-e-pal';\n var FEEL=document.getElementById('palfeel');
 function setPal(v){
   document.body.dataset.pal=v;
   document.querySelectorAll('.palbar button').forEach(function(b){
     var on = b.dataset.pal===v;
     b.setAttribute('aria-pressed', String(on));
     if(on && FEEL) FEEL.textContent = b.textContent + ' —— ' + b.dataset.feel; });
   try{localStorage.setItem(PK,v)}catch(e){}
 }
 var saved=null; try{saved=localStorage.getItem(PK)}catch(e){}
 setPal(saved||'plain');
 document.querySelectorAll('.palbar button').forEach(function(b){
   b.addEventListener('click',function(){ setPal(b.dataset.pal); }); });

 function setPane(v){
   document.querySelectorAll('.paneE').forEach(function(p){ p.hidden = (p.dataset.pane!==v); });
   document.querySelectorAll('.tabsE button').forEach(function(b){
     b.setAttribute('aria-selected', String(b.dataset.pane===v)); });
 }
 document.querySelectorAll('.tabsE button').forEach(function(b){
   b.addEventListener('click',function(){ setPane(b.dataset.pane); }); });
})();
<\/script>`;

/* ═══════════════ 方向 E — 十条一屏 One-Screen ═══════════════ */
/*
 * Lead 提的手艺题:每条要给多少字,才能同时满足
 *   「十条一屏扫得完」 和 「不点进去也看得懂它是什么」。
 * 写太少 → 退化成 A(还得点进去,她抱怨的正是这个)
 * 写太多 → 变长文,「一眼看全」就没了(她喜欢的正是这个)
 *
 * 我的取法(可被推翻):**一行标题 + 两句实写**,两句各答一个问题:
 *   第 1 句 = 这是什么   → 直接用 `what` 的**完整第一句**
 *   第 2 句 = 跟我们什么关系 → 直接用 `relation` 的**完整第一句**
 *
 * 🔴 关键:用 splitLead() 取**完整的一句**,不是按字数截断。
 *    Annie 明确嫌弃过截断式摘要(v7 就是因为「截原推前 N 个字符」被否的)。
 *    句子完整 = 读完就是一个完整意思;截断 = 读完还得猜。
 *    余下的原文一个字不丢,全在折叠区里。
 */
const CSS_E = `
/* ── FLY-1704 轮 2:配色变体 ──────────────────────────────────────
   Annie:「make it more colorful」。边界:Apple 浅色底线不变 ——
   「白/浅灰底、深色字」,不做暗色模式,也不按系统深浅自动切换。
   所以「更有颜色」= 强调色 / 分类色 / 层次,不是把底色压深。

   上色的位置(都不是底色):
     ① 编号 .no  ② 分节标题 .secthd h2  ③ 「跟我们 ——」标签 .cue
     ④ tab 选中指示 + GitHub / X 各一个分类色  ⑤ 链接 / chip / 横看发现左边线
   骨架、卡片结构、信息层级、字号字重行高一律不动 —— 套与套之间只有变量不同。
   「素白」逐值等于改动前,是对照组。                                    */
body[data-pal="plain"]{--e-bg:#fff;--e-ink:#1d1d1f;--e-link:#0645c8;--e-rule:#f2f2f4;
 --e-rule2:#ebebed;--e-meta:#a1a1a6;--e-dim:#86868b;--e-s2:#3a3a3c;--e-cue:#1a365d;
 --e-num:#c7c7cc;--e-chip:#f5f5f7;--e-chiptx:#6e6e73;--e-code:#f2f2f4;--e-notebg:#fcfcfd;
 --e-noteln:#e3e3e6;--e-btn:#1d1d1f;--e-btntx:#fff;
 --e-accent:#1d1d1f;--e-gh:#1d1d1f;--e-x:#1d1d1f}
body[data-pal="indigo"]{--e-bg:#fff;--e-ink:#16181d;--e-link:#1348c8;--e-rule:#edf0f7;
 --e-rule2:#e3e8f3;--e-meta:#9aa3b5;--e-dim:#7d8798;--e-s2:#3b4152;--e-cue:#1348c8;
 --e-num:#a9bce8;--e-chip:#eaf0fd;--e-chiptx:#4a5a7d;--e-code:#eff3fc;--e-notebg:#fcfdff;
 --e-noteln:#dbe3f4;--e-btn:#1348c8;--e-btntx:#fff;
 --e-accent:#1348c8;--e-gh:#1348c8;--e-x:#6b3fd4}
body[data-pal="amber"]{--e-bg:#fffdf8;--e-ink:#241f18;--e-link:#b8501a;--e-rule:#f5ece0;
 --e-rule2:#efe3d2;--e-meta:#a89684;--e-dim:#8f7f6c;--e-s2:#4a4238;--e-cue:#96420f;
 --e-num:#e0b98d;--e-chip:#fdf0e2;--e-chiptx:#7a604a;--e-code:#fbf2e6;--e-notebg:#fffefb;
 --e-noteln:#eadcc8;--e-btn:#b8501a;--e-btntx:#fffdf8;
 --e-accent:#b8501a;--e-gh:#b8501a;--e-x:#8a6212}
body[data-pal="forest"]{--e-bg:#fbfdfb;--e-ink:#171d19;--e-link:#0f6b45;--e-rule:#e9f2ec;
 --e-rule2:#dfebe4;--e-meta:#93a69a;--e-dim:#7a8e82;--e-s2:#374039;--e-cue:#0f6b45;
 --e-num:#a2cfb8;--e-chip:#e8f4ed;--e-chiptx:#4c6357;--e-code:#eef6f1;--e-notebg:#fff;
 --e-noteln:#d6e6dc;--e-btn:#0f6b45;--e-btntx:#fbfdfb;
 --e-accent:#0f6b45;--e-gh:#0f6b45;--e-x:#2a5ea8}

body{background:var(--e-bg);color:var(--e-ink)}
a{color:var(--e-link)}
code{background:var(--e-code)}
.pagehd .sub{color:var(--e-dim)}
.dirtag{background:var(--e-chip);color:var(--e-chiptx)}
.basis{color:var(--e-s2)} .basis b{color:var(--e-ink)} .basis .row1{color:var(--e-chiptx)}
.basis .row1 b{color:var(--e-ink)}
.xfind{border-left-color:var(--e-accent);color:var(--e-s2)} .xfind h3{color:var(--e-accent)}
.secthd{border-bottom-color:var(--e-rule2)} .secthd .cnt{color:var(--e-meta)}
.no{color:var(--e-num)} .meta{color:var(--e-meta)}
.chk{color:var(--e-chiptx)} .chk.dim{color:var(--e-meta)} .cue{color:var(--e-cue)}
summary{color:var(--e-dim)} summary::before{color:var(--e-num)}
.codeblk{color:var(--e-s2);border-left-color:var(--e-rule2)}
.note{background:var(--e-notebg);border-color:var(--e-noteln);color:var(--e-ink)}
.note:focus{border-color:var(--e-link);background:var(--e-bg)}
.foot{border-top-color:var(--e-rule2);color:var(--e-meta)}
.copyall{background:var(--e-btn);color:var(--e-btntx)}
/* 分类色:GitHub 和 X 各一个色,分节标题和 tab 指示都跟着走 */
.paneE[data-pane="gh"] .secthd h2{color:var(--e-gh)}
.paneE[data-pane="x"]  .secthd h2{color:var(--e-x)}
.tabsE button[data-pane="gh"][aria-selected="true"]{color:var(--e-gh);border-bottom-color:var(--e-gh)}
.tabsE button[data-pane="x"][aria-selected="true"]{color:var(--e-x);border-bottom-color:var(--e-x)}

/* ── 配色切换条 ── */
.palbar{max-width:640px;margin:26px auto 0;padding:0 20px;display:flex;align-items:center;
 gap:8px;flex-wrap:wrap}
.palbar .lb{font-size:12px;color:var(--e-meta)}
.palbar button{font:13px/1 inherit;padding:7px 13px;border:1px solid var(--e-rule2);
 border-radius:999px;background:transparent;color:var(--e-s2);cursor:pointer}
.palbar button[aria-pressed="true"]{background:var(--e-btn);border-color:var(--e-btn);color:var(--e-btntx)}
.palnote{max-width:640px;margin:8px auto 0;padding:0 20px;font-size:12.5px;
 color:var(--e-meta);line-height:1.7}

/* ── GitHub / X 两个 tab(文字型 + 下划线指示,跟 v8 同一种做法)── */
.tabsE{display:flex;gap:24px;max-width:640px;margin:40px auto 0;padding:0 20px;
 border-bottom:1px solid var(--e-rule2)}
.tabsE button{font:650 14.5px/1 inherit;padding:9px 2px 10px;border:0;background:none;
 color:var(--e-dim);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabsE button[aria-selected="true"]{color:var(--e-ink);border-bottom-color:var(--e-ink)}
.tabsE button .cnt{font-weight:400;font-size:12px;color:var(--e-meta);margin-left:6px}
.paneE[hidden]{display:none}
.paneE .secthd:first-of-type{margin-top:34px}

.wrapE{max-width:640px;margin:0 auto;padding:0 20px}
.pagehd,.basis,.xfind,.foot{max-width:640px}
.itemE{padding:15px 0;border-top:1px solid #f2f2f4}
.itemE:first-of-type{border-top:0}
.hdE{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}
.hdE .no{font-size:17px;min-width:24px;text-align:right}
.hdE a{font-size:15.5px;font-weight:650;text-decoration:underline;text-underline-offset:3px;
 letter-spacing:-.01em;overflow-wrap:anywhere}
.hdE .qty{margin-left:auto;white-space:nowrap;flex:0 0 auto}
.bodyE{margin-left:34px;font-size:14.5px;line-height:1.72}
.bodyE .s1{display:block;margin-bottom:3px}
.bodyE .s2{display:block;color:#3a3a3c}
.itemE details,.itemE .nbd{margin-left:34px}
.itemE .chk{margin-left:34px}
@media(max-width:640px){
 .wrapE{padding:0 16px}
 .hdE{flex-wrap:wrap;gap:6px}
 .hdE .qty{margin-left:0;flex-basis:100%}
 .bodyE,.itemE details,.itemE .nbd,.itemE .chk{margin-left:0}
}

/* E 自己那两处硬编码色值必须排在配色变量之后 —— 否则夜间下
   分隔线仍是浅色亮条、第二行仍是深灰几乎看不见。只改色，不改布局。 */
.itemE{border-top-color:var(--e-rule)}
.bodyE .s2{color:var(--e-s2)}
`;

function renderE() {
	// 「完整第一句」—— 复用 splitLead 的切分,标记安全,绝不按字数截断
	const firstSentence = (t) => splitLead(String(t ?? "")).lead.trim();

	const one = (m) => {
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
		if (m.kind === "x")
			bits.push(`<div class="codeblk">${rich(r.quote)}</div>`);

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
	};

	const nGh = byKind("deep").length + byKind("shallow").length;
	const nX = byKind("x").length;

	// 轮 2 ①:GitHub 和 X 拆成两个 tab。
	// 两边的条目都留在 HTML 里(只是 hidden),所以 24 条的构建期断言照样成立。
	const tabs = `
<div class="palbar">
  <span class="lb">配色</span>
  <button type="button" data-pal="plain"  aria-pressed="true"  data-feel="安静，不来打扰你读。这是你上次看的那版，一个色值都没改，放这儿当对照。">素白 · 现状</button>
  <button type="button" data-pal="indigo" aria-pressed="false" data-feel="像一份正经的晨间简报 —— 冷静、有条理、可以直接拿去开会。">墨蓝</button>
  <button type="button" data-pal="amber"  aria-pressed="false" data-feel="像刚印出来的纸质报 —— 暖，有人气，配一杯咖啡刚好。">暖橘</button>
  <button type="button" data-pal="forest" aria-pressed="false" data-feel="清爽、专注 —— 一天里第一件正事的那种感觉。">森绿</button>
</div>
<p class="palnote"><b id="palfeel"></b><br>
四套<b>只换颜色</b>：编号、分节标题、「跟我们 ——」这个标签、tab 指示，还有 GitHub 和 X 各自一个分类色。
骨架、卡片结构、信息层级、字号字重全都没动 —— 所以你看到的差别百分之百来自配色。
四套<b>都是浅底深字</b>，没有暗色模式。</p>
<div class="tabsE" role="tablist">
  <button type="button" role="tab" data-pane="gh" aria-selected="true">GitHub Trending<span class="cnt">${nGh}</span></button>
  <button type="button" role="tab" data-pane="x"  aria-selected="false">X · For you<span class="cnt">${nX}</span></button>
</div>`;

	const body = `${header("方向 E · 十条一屏", "不点进去也看得懂", "每条只给两句 —— 剩下的要展开")}
${tabs}
<section class="paneE" data-pane="gh">
<div class="wrapE">
  ${sec("⌘ GitHub · 读了代码", byKind("deep").length)}
  ${byKind("deep").map(one).join("\n")}
  ${sec("⌘ GitHub · 只扫了没深入", byKind("shallow").length)}
  ${byKind("shallow").map(one).join("\n")}
</div>
</section>
<section class="paneE" data-pane="x" hidden>
${xBanner}
<div class="wrapE">
  ${sec("𝕏 For you", nX)}
  ${byKind("x").map(one).join("\n")}
</div>
</section>
${footer}
${TABS_PAL_JS}`;
	return page("e", "早报 · 方向 E 十条一屏", CSS_E, body);
}

/* ═══════════════════ 并排对比页(Annie 的入口) ═══════════════════ */

/**
 * 这里的数字**全部是实测**,不是目标值 —— 2026-08-11 在 Chrome 1280×900 下
 * 对五个页面各跑一遍 assets/measure.js 拿到的。任何人都能自己复跑核一遍。
 * 计划里 A 的目标是「≤5 屏」,实测 9.3 —— 照实写实测,不改数字去迁就计划。
 */
const MEASURED = {
	v8: {
		labels: 74,
		cjk: 46,
		boxed: 10,
		enclosed: 24,
		screens: 10.9,
		exp: 10.9,
	},
	a: { labels: 0, cjk: 34, boxed: 3, enclosed: 0, screens: 9.3, exp: 17.6 },
	b: { labels: 0, cjk: 36, boxed: 3, enclosed: 0, screens: 13.7, exp: 14.6 },
	c: { labels: 0, cjk: 39, boxed: 3, enclosed: 0, screens: 6.8, exp: 16.1 },
	d: { labels: 0, cjk: 37, boxed: 3, enclosed: 0, screens: 2.1, exp: 16.6 },
};

const DIRS = [
	{
		id: "a",
		name: "A · 电报",
		bet: "扫得快",
		body: "一栏到底，每条只留「这是什么」，把「跟我们的关系 / 能借的 / 我读到的代码」收进一个折叠。学的是 TLDR 当日刊。",
		cost: "深读的内容要多点一下才看得到。",
	},
	{
		id: "b",
		name: "B · 简报",
		bet: "读的时候不被打断",
		body: "左边一条窄栏放编号、星数、语言、核验状态、备注入口；右边一条窄栏从头到尾只有文章。信息一条不少，但读的时候眼睛只走一条直线。学的是 Linear changelog + Import AI。",
		cost: "要宽屏；窄屏会塌成单栏。四段全展开，所以最长。",
	},
	{
		id: "c",
		name: "C · 杂志",
		bet: "替你做减法",
		body: "今晚 18 条不是平的：头条 1 条大版面，要闻 3 条中等，其余 20 条收成紧凑清单点开即展开。学的是 NextDraft。",
		cost: "需要「谁是头条」的排序判断 —— 这一版用的是程序化规则，对不对由你定。",
	},
	{
		id: "d",
		name: "D · 工作台",
		bet: "先给全局，再钻细节",
		body: "一行一条的密集表，24 条基本一屏看完，点任一行就地展开全文。这是刻意做的**对照组** —— 它不假装自己是读物，它承认这是一份每天要过一遍的清单。",
		cost: "那一句话结论必须真的够好；如果你其实想坐下来「读」，这版会显得冷。",
	},
];

const CSS_IDX = `
body{background:#f5f5f7;font-size:15px}
.ix{max-width:1180px;margin:0 auto;padding:56px 24px 90px}
.ix h1{font-size:31px;letter-spacing:-.022em;margin:0 0 10px;font-weight:700}
.ix .intro{color:#3a3a3c;font-size:15px;line-height:1.85;max-width:660px;margin:0 0 8px}
.ix .intro b{color:#1d1d1f}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:26px;margin:34px 0 0}
.cardI{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.shot{height:330px;overflow:hidden;position:relative;background:#fff;border-bottom:1px solid #ebebed}
.shot iframe{width:1280px;height:1320px;border:0;transform:scale(.4);transform-origin:0 0;
 position:absolute;top:0;left:0;pointer-events:none}
.cardI .in{padding:20px 22px 22px}
.cardI h2{font-size:19px;margin:0 0 3px;letter-spacing:-.01em;font-weight:650}
.cardI .bet{font-size:13px;color:#b8860b;font-weight:650;margin:0 0 10px}
.cardI .desc{font-size:13.5px;line-height:1.8;color:#3a3a3c;margin:0 0 12px}
.cardI .cost{font-size:13px;line-height:1.75;color:#86868b;margin:0 0 16px}
.cardI .cost b{color:#6e6e73}
.nums{display:flex;flex-wrap:wrap;gap:0;border-top:1px solid #f0f0f2;padding-top:13px;margin-bottom:16px}
.nums div{flex:1;min-width:74px}
.nums .k{font-size:10.5px;color:#a1a1a6;letter-spacing:.02em;margin-bottom:3px}
.nums .v{font-size:17px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.nums .v.good{color:#248a3d}
.nums .v.warn{color:#b8860b}
.open{display:inline-block;padding:9px 17px;border-radius:9px;background:#1d1d1f;color:#fff;
 text-decoration:none;font-size:13.5px;font-weight:600}
.base{background:#fff;border-radius:14px;padding:22px 24px;margin:30px 0 0;
 box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid #ff9500}
.base h2{font-size:17px;margin:0 0 4px;font-weight:650}
.base p{font-size:13.5px;color:#6e6e73;line-height:1.8;margin:0 0 14px}
.tbl2{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl2 th{text-align:left;font-size:11px;letter-spacing:.05em;color:#a1a1a6;font-weight:700;
 padding:0 10px 8px;border-bottom:1px solid #ebebed}
.tbl2 td{padding:9px 10px;border-bottom:1px solid #f5f5f7;font-variant-numeric:tabular-nums}
.tbl2 td:first-child{font-weight:600}
.tbl2 tr.v8row td{color:#6e6e73;background:#fffbf2}
.note2{background:#fff;border-radius:14px;padding:22px 24px;margin:26px 0 0;
 box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid #34c759}
.note2 h2{font-size:17px;margin:0 0 8px;font-weight:650}
.note2 p{font-size:14px;color:#3a3a3c;line-height:1.85;margin:0 0 10px}
.foot2{color:#a1a1a6;font-size:12.5px;line-height:1.85;margin:34px 0 0}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
`;

function renderIndex() {
	const card = (d) => {
		const m = MEASURED[d.id];
		return `<div class="cardI">
  <div class="shot"><iframe src="direction-${d.id}.html" loading="lazy" scrolling="no" title="${esc(d.name)} 预览"></iframe></div>
  <div class="in">
    <h2>${esc(d.name)}</h2>
    <p class="bet">赌的是「${esc(d.bet)}」</p>
    <p class="desc">${rich(d.body)}</p>
    <p class="cost"><b>代价：</b>${esc(d.cost)}</p>
    <div class="nums">
      <div><div class="k">字段名</div><div class="v good">${m.labels}</div></div>
      <div><div class="k">每行汉字</div><div class="v good">${m.cjk}</div></div>
      <div><div class="k">单条容器</div><div class="v good">${m.boxed}</div></div>
      <div><div class="k">打开时屏数</div><div class="v${m.screens <= 7 ? " good" : m.screens > 10.9 ? " warn" : ""}">${m.screens}</div></div>
    </div>
    <a class="open" href="direction-${d.id}.html" target="_blank" rel="noopener">打开整页 ↗</a>
  </div>
</div>`;
	};

	const row = (label, id, cls = "") => {
		const m = MEASURED[id];
		return `<tr class="${cls}"><td>${esc(label)}</td><td>${m.labels}</td><td>${m.cjk}</td><td>${m.boxed}</td><td>${m.enclosed}</td><td>${m.screens}</td><td>${m.exp}</td></tr>`;
	};

	const body = `<div class="ix">
<h1>早报 feed — 四个版式方向</h1>
<p class="intro">同一天的内容（<b>一个字都没改</b>），四种摆法。你挑的其实不是「哪个好看」，
是<b>哪一种读法</b> —— 四个方向赌的东西不一样，下面每张卡都写了它赌什么、代价是什么。</p>
<p class="intro">缩略图是<b>真实页面本身</b>缩放来的，不是示意图；点「打开整页」看到的就是它放大后的样子。</p>

<div class="grid">${DIRS.map(card).join("\n")}</div>

<div class="base">
  <h2>跟现在这一版（v8）比</h2>
  <p>下面这些数字是<b>实测</b>的 —— 五个页面各跑一遍同一个测量脚本（<code>assets/measure.js</code>），不是我写的目标值。</p>
  <table class="tbl2">
    <thead><tr><th>版本</th><th>字段名个数</th><th>每行汉字</th><th>单条容器数</th><th>被围成卡片</th><th>打开时屏数</th><th>全展开屏数</th></tr></thead>
    <tbody>
      ${row("现在这版 v8", "v8", "v8row")}
      ${DIRS.map((d) => row(d.name, d.id)).join("\n")}
    </tbody>
  </table>
  <p style="margin:16px 0 0">
    「字段名」= 页面上「这是什么 / 为什么值得你看 / 跟我们什么关系 / 哪里能借鉴」这种<b>表单标签</b>出现的次数。
    v8 有 74 个；我看的四个真实参考物（Import AI / TLDR / NextDraft / Linear）<b>全都是 0</b>。
    这是 v8 和它们之间最大的一处差别，也是「像表格」的主要来源。<br>
    「全展开屏数」= 如果你把每一条的折叠区都点开。<b>A 打开时短、全展开长</b>，那正是它的取舍。
  </p>
</div>

<div class="note2">
  <h2>「都不对，因为 X」也是有效答案</h2>
  <p>这一单的目的是<b>先把壳定下来</b>，不是逼你从四个里挑一个。
  如果四个都不对，请直接说<b>因为什么</b> —— 那个「因为」就是下一轮的输入，比勉强挑一个有用得多。</p>
  <p>另外两件想请你顺手拍的：<br>
  ① <b>备注框怎么摆</b> —— 四个方向处理得不一样（A 点开才出现 / B 在左栏 / C 头条常驻 / D 行尾小圆点）。
  这是你 v7 明确要的功能，我没动它，只是给了四种摆法。<br>
  ② <b>要不要排序</b> —— 只有 C 假设「18 条不是平的、有头条」。如果你觉得都一样重、你自己挑，C 就出局。</p>
</div>

<p class="foot2">
FLY-1704 · 2026-08-11 · 内容来自 FLY-1410 v8 的真实数据，逐字未改（构建期有断言，24 条 × 241 个字段全部核对过）。<br>
这些是<b>方向图，不是上线版本</b>。备注存在你这台机器的浏览器里。
</p>
</div>`;
	return page("index", "早报 feed — 四个版式方向", CSS_IDX, body);
}

/* ═══════════════════ 出货 ═══════════════════ */

mkdirSync(DIR, { recursive: true });
const built = {
	"direction-a.html": renderA(),
	"direction-b.html": renderB(),
	"direction-c.html": renderC(),
	"direction-d.html": renderD(),
	"direction-e.html": renderE(),
};
// 方向 E 刻意把 what / relation / no_code_reason 拆成「完整第一句 + 余下」两处
const SPLIT_BY_DIR = {
	"direction-e.html": ["what", "relation", "no_code_reason"],
};
for (const [file, html] of Object.entries(built)) {
	assertAll(file, html, { splitFields: SPLIT_BY_DIR[file] });
	writeFileSync(join(DIR, file), html);
}
// 对比页不走条目断言(它没有条目),但要保证四个方向都被引到、数字表齐全
const idx = renderIndex();
for (const d of DIRS) {
	if (!idx.includes(`direction-${d.id}.html`)) {
		console.error(`\u274c index.html 没有引到 direction-${d.id}.html`);
		process.exit(1);
	}
}
writeFileSync(join(DIR, "index.html"), idx);
console.log(`\u2705 index.html: 4 个方向缩略 + v8 对照表(5 行实测数字)`);

// ── founder.html:交给 Lead 发布的那一份 ────────────────────────────────
// 🔴 publish-report 只托管**一个** HTML 文件(读单个 --html,不带同目录兄弟文件)。
//    index.html 用 <iframe src="direction-x.html"> 引兄弟文件,一发布就是四个空白缩略图
//    + 四个 404 的「打开整页」。所以给创始人的那一份必须**自包含**:
//    四个方向整页塞进 srcdoc,「打开整页」开同 srcdoc 的全屏浮层,零外部依赖。
const attr = (h) => h.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// 🔴 顺序很重要:**先挂浮层,再内联四个方向**。
//    反过来会踩一个很隐蔽的坑 —— 内联之后,每个方向的整页 HTML 都躺在 srcdoc 属性里,
//    里面各自带着一个 `</body></html>`(attr() 只转义 & 和 ",不转义 <)。
//    这时候 String.replace(string,…) 只换**第一个**匹配 = 换进了方向 A 的 srcdoc 里面,
//    浮层被塞进了内嵌页面,顶层文档压根没有。文件里搜 id="ov" 还搜得到,所以字符串断言查不出来;
//    是真浏览器点「打开整页」没反应才发现的。
let founder = idx;
const OVERLAY = `
<div id="ov" hidden><div class="ovbar"><span id="ovt"></span><button id="ovx">关闭 ✕</button></div><iframe id="ovf"></iframe></div>
<style>
#ov{position:fixed;inset:0;background:#fff;z-index:99;display:flex;flex-direction:column}
#ov[hidden]{display:none}
.ovbar{display:flex;align-items:center;justify-content:space-between;padding:10px 18px;
 border-bottom:1px solid #ebebed;background:#f5f5f7;font-size:14px;font-weight:600;flex:0 0 auto}
#ovx{border:0;background:#1d1d1f;color:#fff;padding:7px 15px;border-radius:8px;cursor:pointer;font:600 13px/1 inherit}
#ovf{flex:1 1 auto;width:100%;border:0}
</style>
<script nonce="__CSP_NONCE__">
(function(){
 var ov=document.getElementById('ov'),ovf=document.getElementById('ovf'),ovt=document.getElementById('ovt');
 var srcs={};
 document.querySelectorAll('iframe[data-full]').forEach(function(f){srcs[f.dataset.full]=f.getAttribute('srcdoc')});
 document.querySelectorAll('[data-open]').forEach(function(b){
   b.addEventListener('click',function(){
     var k=b.dataset.open;
     ovt.textContent=b.closest('.cardI').querySelector('h2').textContent;
     ovf.setAttribute('srcdoc',srcs[k]); ov.removeAttribute('hidden');
   });
 });
 document.getElementById('ovx').addEventListener('click',function(){
   ov.setAttribute('hidden',''); ovf.removeAttribute('srcdoc');
 });
 document.addEventListener('keydown',function(e){if(e.key==='Escape')document.getElementById('ovx').click()});
})();
</script>
</body></html>`;
{
	const before = founder.length;
	founder = founder.replace("</body></html>", OVERLAY);
	if (founder.length === before) {
		console.error(
			"\u274c founder.html 浮层没挂上 —— </body></html> 锚点没命中",
		);
		process.exit(1);
	}
}

// 挂完浮层再内联 —— 此时 srcdoc 里的 </body></html> 已经影响不到上面那次 replace
for (const d of DIRS) {
	const inline = attr(built[`direction-${d.id}.html`]);
	const t1 = `<iframe src="direction-${d.id}.html" loading="lazy" scrolling="no" title="${esc(d.name)} 预览"></iframe>`;
	const t2 = `<a class="open" href="direction-${d.id}.html" target="_blank" rel="noopener">打开整页 ↗</a>`;
	if (!founder.includes(t1) || !founder.includes(t2)) {
		console.error(`\u274c founder.html 找不到方向 ${d.id} 的缩略图或按钮锚点`);
		process.exit(1);
	}
	founder = founder.replace(
		t1,
		`<iframe srcdoc="${inline}" scrolling="no" title="${esc(d.name)} 预览" data-full="${d.id}"></iframe>`,
	);
	founder = founder.replace(
		t2,
		`<button class="open" data-open="${d.id}">打开整页 ↗</button>`,
	);
}

// 自包含 + 浮层落在**顶层文档**的硬断言
for (const d of DIRS) {
	if (
		founder.includes(`src="direction-${d.id}.html"`) ||
		founder.includes(`href="direction-${d.id}.html"`)
	) {
		console.error(
			`\u274c founder.html 仍然引用兄弟文件 direction-${d.id}.html —— 发布后会 404`,
		);
		process.exit(1);
	}
	if (!founder.includes(`data-full="${d.id}"`)) {
		console.error(`\u274c founder.html 缺少方向 ${d.id} 的内联副本`);
		process.exit(1);
	}
}
// 🔴 光查「文件里有 id=ov」不够 —— 它可能藏在某个 srcdoc 里(上面那个坑就是这么来的)。
//    浮层必须在**最后一个 srcdoc 之后**,也就是真的在顶层文档尾部。
const lastSrcdoc = founder.lastIndexOf("srcdoc=");
for (const need of ['id="ov"', 'id="ovf"', 'id="ovx"']) {
	const at = founder.lastIndexOf(need);
	if (at < 0 || at < lastSrcdoc) {
		console.error(
			`\u274c founder.html 的 ${need} 不在顶层文档里(可能被塞进了某个 srcdoc)`,
		);
		process.exit(1);
	}
}
if ((founder.match(/data-open=/g) ?? []).length !== DIRS.length) {
	console.error(`\u274c founder.html 的「打开整页」按钮数量不对`);
	process.exit(1);
}
writeFileSync(join(DIR, "founder.html"), founder);
console.log(
	`\u2705 founder.html: 自包含单文件(4 个方向内联),${(founder.length / 1024).toFixed(0)}KB —— 这一份才是交给 Lead 发布的`,
);
console.log(`\n写出 ${Object.keys(built).length} 个方向 + 1 个对比页。`);
export { model, splitLead, normalize, itemKey };
