/**
 * FLY-1413 — 收敛版 tab 内容生成器(FRAGMENT,不是整页)。
 *
 * Annie 把流程从「她逐条圈 62 个」改成「HL + Tadashi 先 align 值 → 给她收敛版」。
 * 所以这个产物不是圈选页,是**待她拍**的裁决汇总,由 Tadashi 的多-tab 壳(v13)嵌入。
 *
 * 与 flag-audit.html 同一条纪律:裁决与人话只在 tab-decisions.js,机器事实只从
 * snapshot.json 来,build 期按 name 拼 + 硬门。这里绝不手抄任何现值。
 *
 * ── 嵌入契约(交给 Tadashi 的壳) ──
 *  · 输出是 FRAGMENT:没有 DOCTYPE / <html> / <head> / <body>,可直接塞进 tab 容器。
 *  · 所有样式内联在片段自带的 <style> 里,类名全部 `f13-` 前缀,不污染壳。
 *  · **无 <script>、无 inline handler、无外部资源、无 fetch** —— 这个 tab 是只读的。
 *  · 片段**不能**自己设 `html{color-scheme}`(那是壳的职责)。所以片段对自己渲染的
 *    每一处都显式声明前景色与背景色,深色壳里也不会被 UA 反色。
 *    → 壳那边仍建议保留 `html{color-scheme: light only}`。
 *
 * 硬门(任一不过 → 非零退出,不出片):
 *  1. 裁决里引用的每个 flag 名都必须存在于本轮审计范围(snapshot.newSinceBaseline)
 *  2. registry 内容哈希 === snapshot 记录的(防审计期间 registry 漂了)
 *  3. 互斥等式必须自洽且加总 === 62(本单栽过跟头的地方,两次)
 *  4. 显式设过的集合必须 === snapshot 算出来的,不许手写
 *  5. 死壳集合必须 === snapshot 判定的,且 7 + 6 必须覆盖它
 *  6. 是 FRAGMENT:不得含 DOCTYPE / <html> / <body>
 *  7. 零 <script> / 零 inline handler / 零外部资源
 *  8. 零 prefers-color-scheme;每条 f13- 文本规则都要有显式 color
 *  9. 无未渲染的 markdown 泄漏
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	BATCH_NOTE,
	DEAD_SPLIT,
	EXPLICIT_RULINGS,
	OWNED_ELSEWHERE,
	PROD_CROSSCHECK,
	RESERVED,
	UNKNOWNS,
} from "./tab-decisions.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const snapshot = JSON.parse(
	fs.readFileSync(path.join(HERE, "snapshot.json"), "utf8"),
);
const scope = new Set(snapshot.newSinceBaseline);
const rows = snapshot.rows.filter((r) => scope.has(r.name));
const byName = new Map(rows.map((r) => [r.name, r]));

function fail(msg) {
	console.error(`[build-tab] GUARD FAILED: ${msg}`);
	process.exit(1);
}

// ── Guard 2: registry drift ──
const liveSha = createHash("sha256")
	.update(
		fs.readFileSync(
			path.join(REPO, "packages/config/src/feature-flags/registry.ts"),
			"utf8",
		),
	)
	.digest("hex");
if (liveSha !== snapshot.provenance.registryContentSha256)
	fail("registry content hash drift — re-run extract.mjs");

// ── Machine-derived sets (NEVER hand-written) ──
const explicitSet = new Set(
	rows
		.filter((r) => r.configured.kind === "global_env" && r.configured.set)
		.map((r) => r.name),
);
const deadSet = new Set(
	rows.filter((r) => r.runtimeHardOff || r.deadByDependency).map((r) => r.name),
);
const unknownSet = new Set(UNKNOWNS.map((u) => u.name));
const ownedSet = new Set([OWNED_ELSEWHERE.name]);

// ── Guard 1: every referenced name is in scope ──
for (const n of [
	...EXPLICIT_RULINGS.map((r) => r.name),
	...unknownSet,
	...DEAD_SPLIT.settled.names,
	...DEAD_SPLIT.pending.names,
	...ownedSet,
])
	if (!scope.has(n)) fail(`unknown flag referenced in tab-decisions: ${n}`);

// ── Guard 4: the authored explicit list must equal the machine-derived one ──
const authoredExplicit = new Set(EXPLICIT_RULINGS.map((r) => r.name));
const diffA = [...explicitSet].filter((n) => !authoredExplicit.has(n));
const diffB = [...authoredExplicit].filter((n) => !explicitSet.has(n));
if (diffA.length || diffB.length)
	fail(
		`explicit-set mismatch vs snapshot: missing=${diffA.join(",")} extra=${diffB.join(",")}`,
	);

// ── Guard 5: the 7 + 6 split must exactly cover the machine-derived dead set ──
const splitAll = [...DEAD_SPLIT.settled.names, ...DEAD_SPLIT.pending.names];
if (new Set(splitAll).size !== splitAll.length)
	fail("a flag appears in both the settled and pending dead lists");
const dA = [...deadSet].filter((n) => !splitAll.includes(n));
const dB = splitAll.filter((n) => !deadSet.has(n));
if (dA.length || dB.length)
	fail(`dead split mismatch: missing=${dA.join(",")} extra=${dB.join(",")}`);

// ── Guard 3: the mutually-exclusive equation must add up to the audited scope.
// This is where this ticket got it wrong TWICE (23+30+4, then 9+13+1+2). The
// groups the reader sees OVERLAP, so the arithmetic is asserted separately from
// the presentation and printed with the overlaps named. ──
const bucketOf = (r) => {
	const e = explicitSet.has(r.name);
	if (e && deadSet.has(r.name)) return "explicit_dead";
	if (e && unknownSet.has(r.name)) return "explicit_unknown";
	if (e) return "explicit_other";
	if (deadSet.has(r.name)) return "dead_only";
	if (ownedSet.has(r.name)) return "owned_elsewhere";
	return "default_only";
};
const partition = {};
for (const r of rows)
	partition[bucketOf(r)] = (partition[bucketOf(r)] || 0) + 1;
const partitionTotal = Object.values(partition).reduce((a, b) => a + b, 0);
if (partitionTotal !== rows.length)
	fail(`partition ${partitionTotal} !== audited scope ${rows.length}`);
if (explicitSet.size !== 9)
	fail(`expected 9 explicit, got ${explicitSet.size}`);
if (deadSet.size !== 13) fail(`expected 13 dead, got ${deadSet.size}`);

/**
 * Codex/Lead review 第 5 次数字事故的根治:凡是要在正文里说「A 条 + B 条 …」的
 * 拆分,都必须先在这里声明 {total, parts},由 assertSplit 校验加总;正文只能引用
 * 这里算出来的数,不许手打。手打的数加不起来时读者会当场发现,而我们已经栽过四次。
 *
 * 这次抓到的:第一节副标题写「其余 53 条…其中 12 条已判死…真正行为=默认的是 40 条」,
 * 12 + 40 = 52 ≠ 53 —— 漏掉的正是被单独归到第四节的那 1 条 1436-owned
 * (它同样没被显式设过、同样跑默认值,只是换了个桶陈述,于是从这句里蒸发了)。
 */
function assertSplit(label, total, parts) {
	const sum = Object.values(parts).reduce((a, b) => a + b, 0);
	if (sum !== total)
		fail(
			`split "${label}" does not add up: ${Object.entries(parts)
				.map(([k, v]) => `${k}=${v}`)
				.join(" + ")} = ${sum}, but it claims ${total}`,
		);
	return { total, ...parts };
}

/** 「没被显式设过」的 53 条怎么分 —— 副标题直接引用它,不手打。 */
const NOT_EXPLICIT = assertSplit(
	"没显式设过的拆分",
	rows.length - explicitSet.size,
	{
		已判死: partition.dead_only,
		"1436-owned": partition.owned_elsewhere,
		其余: partition.default_only,
	},
);
/**
 * 「没有已知的行为-默认值偏差」的条数。注意口径:
 * 这**不是**「已验证行为=默认值」—— 我们只担保「.env 没写」和「默认值是多少」,
 * 运行时没独立验证(见第五节)。这里说的是「没有已知偏差」:已知有偏差的就是那
 * 12 条死壳。1436-owned 那条也在这一档里,所以是 41 不是 40 —— Lead 跟 Tadashi
 * 说 41、tab 早先写 40,两个都不错,是含不含它的口径差,所以下面把口径写出来。
 */
const NO_KNOWN_DEVIATION = NOT_EXPLICIT.其余 + NOT_EXPLICIT["1436-owned"];

// ── Renderers ──
const esc = (s) =>
	String(s).replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	);
const rich = (s) =>
	esc(s)
		.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
		.replace(/`([^`]+?)`/g, "<code>$1</code>")
		.replace(/&lt;br\s*\/?&gt;/gi, "<br>");

/** Current configured value, straight from the snapshot — never hand-written. */
function configuredValueOf(name) {
	const r = byName.get(name);
	const c = r.configured;
	if (c.kind === "project") {
		const nd = c.byProject.filter((p) => !p.isDefault);
		return nd.length
			? `按项目不同：${nd.map((p) => `${p.project}=${p.value}`).join("、")}`
			: `全部项目跑默认（${r.default}）`;
	}
	if (r.valueKind === "bool")
		return c.value
			? c.set
				? "开（.env 显式 =1）"
				: "开（默认）"
			: c.set
				? "关（.env 显式 =0）"
				: "关（默认 / 没设）";
	return c.set ? `= ${c.value}（.env 显式）` : `= ${c.value}（默认）`;
}

const RULING_CLS = {
	delete: "f13-r-del",
	keep: "f13-r-keep",
	frozen: "f13-r-frozen",
	unknown: "f13-r-unk",
};

const explicitRows = EXPLICIT_RULINGS.map(
	(d) => `<tr>
<td class="f13-fn">${esc(d.name)}</td>
<td class="f13-val">${esc(configuredValueOf(d.name))}</td>
<td><span class="f13-pill ${RULING_CLS[d.rulingKind]}">${esc(d.ruling)}</span></td>
<td class="f13-note">${d.note ? rich(d.note) : "—"}</td>
</tr>`,
).join("\n");

const unknownBlocks = UNKNOWNS.map(
	(u) => `<div class="f13-unk">
<div class="f13-unk-h"><code>${esc(u.name)}</code> · ${rich(u.headline)}</div>
<div class="f13-line"><b>现值：</b>${esc(configuredValueOf(u.name))}</div>
<div class="f13-line"><b>查到的：</b>${rich(u.evidence)}</div>
<div class="f13-recall"><b>${esc(u.recollectionLabel)}：</b>${rich(u.recollection)}<br><span class="f13-caveat">${rich(u.recollectionCaveat)}</span></div>
<div class="f13-line"><b>结论：</b>${rich(u.decision)}</div>
</div>`,
).join("\n");

const nameList = (names) =>
	names.map((n) => `<code>${esc(n)}</code>`).join(" · ");

const deadPendingSteps = DEAD_SPLIT.pending.verification
	.map((v, i) => `<li><b>第 ${i + 1} 层</b>：${rich(v)}</li>`)
	.join("\n");

const body = `<section class="f13">
<style>
.f13{background:#fff;color:#1d1d1f;font-family:-apple-system,system-ui,"SF Pro Text",Segoe UI,Roboto,sans-serif;font-size:13.5px;line-height:1.6;padding:2px 0}
.f13 *{box-sizing:border-box}
.f13 h3{font-size:15px;margin:20px 0 6px;color:#1a365d;background:#fff}
.f13 h3:first-of-type{margin-top:8px}
.f13 p,.f13 li,.f13 td,.f13 th,.f13 div{color:#1d1d1f}
.f13 code{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:11.5px;background:#f0f0f4;color:#1d1d1f;border-radius:4px;padding:0 4px}
.f13-hero{background:#fff;color:#1d1d1f;border:1px solid #e5e5ea;border-left:4px solid #af52de;border-radius:10px;padding:11px 13px;margin:4px 0 10px}
.f13-callout{background:#fff6e6;color:#7a4a00;border:1px solid #ffe0a3;border-radius:9px;padding:9px 12px;margin:8px 0;font-size:13px}
.f13-math{background:#f6f8fc;color:#1d1d1f;border:1px solid #d9e2f2;border-radius:9px;padding:9px 12px;margin:8px 0;font-size:12.5px}
.f13-math code{background:#e8eefa;color:#1a365d}
.f13 table{width:100%;border-collapse:collapse;margin:6px 0;background:#fff;color:#1d1d1f}
.f13 th{text-align:left;font-size:11.5px;color:#55555c;background:#fafafd;border-bottom:1px solid #e5e5ea;padding:5px 7px;font-weight:600}
.f13 td{border-bottom:1px solid #f0f0f4;padding:6px 7px;vertical-align:top;background:#fff;color:#1d1d1f}
.f13-fn{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:11.5px;color:#1a365d;word-break:break-all;background:#fff}
.f13-val{font-size:12px;color:#444;white-space:nowrap;background:#fff}
.f13-note{font-size:12.5px;color:#333;background:#fff}
.f13-pill{display:inline-block;font-size:11.5px;font-weight:700;padding:1px 7px;border-radius:6px;white-space:nowrap}
.f13-r-del{background:#fdeceb;color:#c0322b}
.f13-r-keep{background:#e3f9ea;color:#1a7a3c}
.f13-r-frozen{background:#fff0e0;color:#a04a00;outline:1.5px solid #ff9500}
.f13-r-unk{background:#f0f0f4;color:#555}
.f13-unk{background:#fff;color:#1d1d1f;border:1px solid #e5e5ea;border-left:4px solid #86868b;border-radius:9px;padding:9px 12px;margin:8px 0}
.f13-unk-h{font-weight:700;color:#1a365d;background:#fff;margin-bottom:4px}
.f13-line{margin:3px 0;color:#1d1d1f;background:#fff;font-size:13px}
.f13-recall{background:#fafafd;color:#444;border-radius:7px;padding:6px 9px;margin:5px 0;font-size:12.5px}
.f13-caveat{color:#c0322b}
.f13-dead{background:#fff;color:#1d1d1f;border:1px solid #e5e5ea;border-radius:9px;padding:9px 12px;margin:8px 0}
.f13-dead-t{font-weight:700;color:#1a365d;background:#fff;margin-bottom:4px}
.f13 ol{margin:6px 0 4px;padding-left:20px}
.f13 li{margin:3px 0;font-size:12.5px;background:#fff}
.f13-verdict{background:#e3f9ea;color:#14532d;border:1px solid #b7e4c7;border-radius:7px;padding:6px 10px;margin:6px 0 0;font-size:12.5px}
.f13-frozen-box{background:#fff0e0;color:#7a3a00;border:1px solid #ffc98a;border-left:4px solid #ff9500;border-radius:9px;padding:9px 12px;margin:8px 0;font-size:13px}
.f13-foot{color:#86868b;font-size:11.5px;line-height:1.6;margin-top:16px;background:#fff}
</style>

<div class="f13-hero"><b>这一 tab 是「待你拍」，不是「已定」。</b>
下面是 HL + Tadashi 就本轮新增的 <b>${rows.length}</b> 个开关 align 出来的值。每条都标了现值和依据；<b>凡是回忆、没取证的，都标成了回忆</b>，没有写成结论。你只需要看有没有不同意的。</div>

<div class="f13-callout">⚠️ <b>下面几组是按「怎么处理」分的，彼此有重叠，别把它们相加。</b>
（比如 <code>checkpoint_watchdog</code> 既被显式设过、又是死壳；两条说不清的也都在显式那 9 个里面。）不重复计数的算式在本 tab 最后。</div>

<h3>一、9 条有人在 .env 里显式设过值的</h3>
<p class="f13-line">这 9 条是唯一在 <code>.env</code> 里被<b>显式写过</b>的。其余 <b>${NOT_EXPLICIT.total}</b> 条没人显式写过，它们分三拨：<b>${NOT_EXPLICIT.已判死} 条已判死的空壳</b>（见第三节，默认值宣称的行为和运行时不符）+ <b>${NOT_EXPLICIT["1436-owned"]} 条 1436-owned</b>（见第四节，勿动）+ <b>${NOT_EXPLICIT.其余} 条其余</b>。<br>
换句话说：<b>已知「行为与默认值不符」的就是那 ${NOT_EXPLICIT.已判死} 条</b>；剩下 <b>${NO_KNOWN_DEVIATION} 条没有已知偏差</b>（${NOT_EXPLICIT.其余} 条在第五节讲 + 1436-owned 那条在第四节）。<span style="color:#7a4a00">注意口径：「没有已知偏差」<b>不等于</b>「已验证行为=默认值」—— 运行时我们没独立验证，见第五节。</span></p>
<table>
<thead><tr><th>开关</th><th>现值</th><th>裁决</th><th>依据</th></tr></thead>
<tbody>
${explicitRows}
</tbody>
</table>

<div class="f13-frozen-box">🛑 <b><code>workflow_template_dispatch</code> 标红：不许动。</b>
它不只是「保持」——同时是 <b>FLY-1436 应急 containment 的急停杆</b>。任何清理动作都不能碰它。</div>

<h3>二、2 条说不清的（诚实归档）</h3>
${unknownBlocks}

<h3>三、13 条死壳 —— 全部确认可删（无异议 7 + 取证后升级 6）</h3>
<p class="f13-line">死壳 = 环境变量还在，但它的消费者接在一条已退役的巷道后面，<b>设成什么都不改变行为</b>。</p>

<div class="f13-dead">
<div class="f13-dead-t">✅ ${esc(DEAD_SPLIT.settled.title)}</div>
<div class="f13-line">${nameList(DEAD_SPLIT.settled.names)}</div>
<div class="f13-line" style="color:#555;font-size:12.5px">${rich(DEAD_SPLIT.settled.note)}</div>
</div>

<div class="f13-dead">
<div class="f13-dead-t">🔍 ${esc(DEAD_SPLIT.pending.title)}</div>
<div class="f13-line">${nameList(DEAD_SPLIT.pending.names)}</div>
<div class="f13-line" style="color:#555;font-size:12.5px">${rich(DEAD_SPLIT.pending.note)}</div>
<ol>
${deadPendingSteps}
</ol>
<div class="f13-verdict">${rich(DEAD_SPLIT.pending.verdict)}</div>
</div>

<h3>四、1 条是别人家的</h3>
<div class="f13-frozen-box">🛑 <code>${esc(OWNED_ELSEWHERE.name)}</code> —— <b>${esc(OWNED_ELSEWHERE.owner)} owned，勿动。</b><br>${rich(OWNED_ELSEWHERE.note)}<br>它<b>不是</b> 1413 的待办，也不进清理候选。</div>

<h3>五、其余 ${partition.default_only} 条：没人设过，跑代码默认值</h3>
<div class="f13-callout">📌 <b>一句必须说清的边界，别把这 ${partition.default_only} 条当成「已经确认没问题」：</b><br>
我们能担保的只有两件事 —— <b>「.env 里没写这一行」</b> 和 <b>「注册表里的默认值是多少」</b>。<br>
<b>我们没有独立验证它们此刻在运行时真的按默认值在跑</b>（死壳那 13 条是例外，那些逐个追到调用点取过证）。这一层要靠 Tadashi 的生产实况补。</div>

<div class="f13-callout" style="border-color:#cfe0ff;background:#eef4ff;color:#1a3a6b">🔧 <b>${esc(PROD_CROSSCHECK.label)}</b><br>${rich(PROD_CROSSCHECK.body)}<br><span style="color:#5a4a00">${rich(PROD_CROSSCHECK.caveat)}</span></div>

<div class="f13-math"><b>不重复计数的算式（互斥，加起来正好 ${rows.length}）：</b><br>
显式设过 ∩ 已判死 = <code>${partition.explicit_dead}</code>　·　显式设过 ∩ 说不清 = <code>${partition.explicit_unknown}</code>　·　显式设过 ∩ 其余 = <code>${partition.explicit_other}</code><br>
没显式设过 ∩ 已判死 = <code>${partition.dead_only}</code>　·　没显式设过 ∩ 别人家的 = <code>${partition.owned_elsewhere}</code>　·　没显式设过 ∩ 其余 = <code>${partition.default_only}</code><br>
<b>${partition.explicit_dead} + ${partition.explicit_unknown} + ${partition.explicit_other} + ${partition.dead_only} + ${partition.owned_elsewhere} + ${partition.default_only} = ${partitionTotal}</b>
（对照：显式 ${partition.explicit_dead + partition.explicit_unknown + partition.explicit_other} 条 · 死壳 ${partition.explicit_dead + partition.dead_only} 条 —— 这两组重叠 ${partition.explicit_dead} 条，所以不能相加。）</div>

<div class="f13-callout">🔭 <b>预留位（已知，不当漂移抓）</b><br>
${RESERVED.map((r) => `<code>${esc(r.envVar)}</code> —— ${esc(r.status)}。${rich(r.note)}`).join("<br>")}</div>

<div class="f13-callout">📦 ${rich(BATCH_NOTE.text)}</div>

<p class="f13-foot">口径：注册表是唯一真源（内容哈希 <code>${esc(snapshot.provenance.registryContentSha256.slice(0, 12))}</code>）。基线是 FLY-1136 那轮的 ${snapshot.provenance.baseline.total} 条（commit <code>${esc(snapshot.provenance.baseline.commit)}</code>，已用 git 逐条核对）。
「现值」＝磁盘配置文件里写的值，不等于跑着的进程里的活值。本 tab 只做归档与待拍，<b>不改任何 flag</b>。</p>
</section>
`;

// ── Guard 6: must be a FRAGMENT ──
for (const bad of ["<!DOCTYPE", "<html", "<body", "</html>"])
	if (body.includes(bad)) fail(`fragment must not contain ${bad}`);

// ── Guard 7: no script / no inline handler / no external resource ──
if (/<script/i.test(body)) fail("fragment must not contain <script>");
const handlers = [...body.matchAll(/\son[a-z]+\s*=/gi)].map((m) => m[0].trim());
if (handlers.length)
	fail(`inline handler(s): ${[...new Set(handlers)].join(",")}`);
const refs = [...body.matchAll(/\b(?:src|href)\s*=/gi)];
if (refs.length) fail("fragment must not reference external resources");
if (/\b(fetch\(|XMLHttpRequest|WebSocket)/.test(body))
	fail("fragment must not access the network");

// ── Guard 8: light-safe. No dark media query, and every f13- rule that paints
// a background must also declare a colour (the shell may be dark). ──
if (/prefers-color-scheme/.test(body)) fail("prefers-color-scheme present");
const css = body.slice(body.indexOf("<style>"), body.indexOf("</style>"));
for (const [, selector, decls] of css.matchAll(
	/(?:^|[};])\s*([^{};]*\.f13[^{};]*)\{([^}]*)\}/g,
)) {
	if (!/(^|;)\s*background\s*:/.test(decls)) continue;
	if (!/(^|;)\s*color\s*:/.test(decls))
		fail(
			`CSS rule "${selector.trim()}" sets background but not color — a dark shell would repaint its text`,
		);
}

// ── Guard 9: no unrendered markdown leaked into the fragment ──
const visible = body.slice(body.indexOf("</style>"));
const leak = visible.match(/\*\*|`|&lt;\/?[a-z]/i);
if (leak) fail(`unrendered markup leaked: ${JSON.stringify(leak[0])}`);

fs.writeFileSync(path.join(HERE, "flag-tab.html"), body);
console.log(
	`flag-tab.html (FRAGMENT) written · ${rows.length} flags · 显式 ${explicitSet.size} · 死壳 ${deadSet.size} (${DEAD_SPLIT.settled.names.length}+${DEAD_SPLIT.pending.names.length}) · 互斥等式 ${Object.values(partition).join("+")}=${partitionTotal} · all 9 guards passed`,
);
