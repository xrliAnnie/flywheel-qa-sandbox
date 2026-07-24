/**
 * FLY-1413 — deterministic HTML builder (forked from the FLY-1136 builder,
 * branch flywheel-FLY-1136 commit dc62daac).
 *
 * Joins flags-data.js (human judgment) with snapshot.json (machine facts) by
 * `name` and renders the founder-facing per-flag card. Machine facts are ALWAYS
 * read from snapshot — flags-data never re-copies a current value, so refreshing
 * the snapshot before delivery cannot drift the two apart.
 *
 * Differences from FLY-1136:
 *  - scope is the INCREMENT (snapshot.newSinceBaseline, 62) not the whole registry
 *  - three buckets (清 / 动态化 / 留) instead of four, and the option set depends
 *    on `kind`: a numeric knob is not offered 「清」 (a knob is rarely deleted)
 *  - cards are grouped BY SUGGESTED BUCKET so the founder can confirm the obvious
 *    ones fast and spend judgment on the few that need it
 *  - an extra section for registry-drift env vars that are read as flags but were
 *    never registered
 *  - emits a COMPLETE document (<!DOCTYPE html> … </html>); the FLY-1136 output
 *    started at <head>, which the publisher rejects
 *
 * Guards — any failure exits non-zero and writes no HTML. Everything the Lead
 * reviews by hand is asserted here instead, because these are exactly the checks
 * that get skipped under time pressure (the nonce one was missed twice: FLY-1045,
 * FLY-1311):
 *   1.  flags-data names unique
 *   2.  name-set === snapshot.newSinceBaseline (the INCREMENT, not the registry)
 *   3.  group counts === declared partition
 *   3b. bucketSuggest counts === declared partition (what the founder acts on)
 *   3c. `kind` === the registry's own valueKind (no hand-copied machine facts)
 *   3d. anything the snapshot proves dead MUST be suggested 清
 *   4.  snapshot.registryContentSha256 === live registry.ts content hash
 *   5.  the generated inline <script> parses
 *   6.  every <script> carries nonce="__CSP_NONCE__"   (publisher CSP)
 *   7.  zero prefers-color-scheme                      (light-only)
 *   7b. html{color-scheme:light only} present          (light-only, UA half)
 *   7c. zero inline event handlers                     (CSP would kill them)
 *   7d. no fetch/XHR/WebSocket and no external resource refs
 *   8.  output is a complete document
 *   9.  card count === 62 + 4
 *   10. the fact-version placeholder was substituted
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { DRIFT, FLAGS } from "./flags-data.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const snapshot = JSON.parse(
	fs.readFileSync(path.join(HERE, "snapshot.json"), "utf8"),
);
const byName = new Map(snapshot.rows.map((r) => [r.name, r]));

/** Mutually-exclusive partition of the 62 — asserted, never inferred. */
const PARTITION = {
	clear: 14,
	dynamize_f: 14,
	dynamize_e: 9,
	dynamize_knob: 3,
	keep_direct: 15,
	keep_gate: 2,
	keep_project: 1,
	keep_percall: 2,
	keep_qa: 1,
	keep_path: 1,
};
const TOTAL_FLAGS = Object.values(PARTITION).reduce((a, b) => a + b, 0); // 62

/**
 * The SUGGESTION counts, asserted separately from `group` (Codex R1 MEDIUM-1).
 * Group is layout; bucketSuggest is what the founder sees pre-selected — and the
 * two legitimately diverge (a card can sit in a dynamize group but be suggested
 * `unknown`). Asserting only the group counts would let a suggestion change slip
 * through green, which is exactly the number the founder acts on.
 */
const SUGGEST_PARTITION = { clear: 13, dynamize: 25, keep: 22, unknown: 2 };

function fail(msg) {
	console.error(`[build-html] GUARD FAILED: ${msg}`);
	process.exit(1);
}

// ── Guards 1–4 ──
const names = FLAGS.map((f) => f.name);
if (new Set(names).size !== names.length)
	fail("duplicate flag name in flags-data");
const dataSet = new Set(names);
const scopeSet = new Set(snapshot.newSinceBaseline);
const missing = [...scopeSet].filter((n) => !dataSet.has(n));
const extra = [...dataSet].filter((n) => !scopeSet.has(n));
if (missing.length || extra.length)
	fail(
		`name-set mismatch vs snapshot.newSinceBaseline: missing=${missing.join(",")} extra=${extra.join(",")}`,
	);
const groupCounts = {};
for (const f of FLAGS) groupCounts[f.group] = (groupCounts[f.group] || 0) + 1;
for (const [g, n] of Object.entries(PARTITION))
	if (groupCounts[g] !== n)
		fail(`group ${g}: expected ${n}, got ${groupCounts[g] || 0}`);
const totalGrouped = Object.values(groupCounts).reduce((a, b) => a + b, 0);
if (totalGrouped !== TOTAL_FLAGS)
	fail(`grouped total ${totalGrouped} !== ${TOTAL_FLAGS}`);
// Guard 3b: assert the SUGGESTION counts too — that is the number that drives
// the founder's decision, and it can drift independently of `group`.
const suggestCounts = {};
for (const f of FLAGS)
	suggestCounts[f.bucketSuggest] = (suggestCounts[f.bucketSuggest] || 0) + 1;
for (const [b, n] of Object.entries(SUGGEST_PARTITION))
	if (suggestCounts[b] !== n)
		fail(`bucketSuggest ${b}: expected ${n}, got ${suggestCounts[b] || 0}`);
if (Object.keys(suggestCounts).some((b) => !(b in SUGGEST_PARTITION)))
	fail(`unknown bucketSuggest value: ${Object.keys(suggestCounts).join(",")}`);

// Guard 3c: `kind` must agree with the registry's own valueKind — it is a
// MACHINE fact, and hand-copying it into flags-data is how the two drift apart
// (Codex R1 MEDIUM-1). "value" and path-like flags map to knob; enum to enum.
for (const f of FLAGS) {
	const vk = byName.get(f.name)?.valueKind;
	const expected = vk === "bool" ? "bool" : vk === "enum" ? "enum" : "knob";
	if (f.kind !== expected)
		fail(
			`kind mismatch for ${f.name}: flags-data says "${f.kind}", registry valueKind is "${vk}" (expected "${expected}")`,
		);
}

// Guard 3d: every flag the extractor proved dead MUST be suggested 清 — an
// audit that shows a dead switch as something to keep or make dynamic is worse
// than no audit. `quota_daemon_cutover` is deliberately not in this set (it is
// retirement-by-its-own-condition, not dead), so it is allowed to be `unknown`.
for (const row of snapshot.rows) {
	if (!scopeSet.has(row.name)) continue;
	if (!row.runtimeHardOff && !row.deadByDependency) continue;
	const f = FLAGS.find((x) => x.name === row.name);
	if (f.bucketSuggest !== "clear")
		fail(
			`${row.name} is proven dead in the snapshot but suggested "${f.bucketSuggest}" — dead flags must be suggested 清`,
		);
}
// Guard 4b (Codex R2 MEDIUM-1): the audit SCOPE is defined by the pinned
// baseline. If the extractor could not verify it against git, we do not know
// the scope is right — refuse to build the founder artifact rather than ship an
// unverified one.
if (snapshot.provenance.baseline?.verifiedAgainstGit !== true)
	fail(
		"baseline was not verified against git (verifiedAgainstGit !== true) — fetch the flywheel-FLY-1136 branch and re-run extract.mjs; the audit scope is unproven without it",
	);

const registrySrc = fs.readFileSync(
	path.join(REPO, "packages/config/src/feature-flags/registry.ts"),
	"utf8",
);
const liveSha = createHash("sha256").update(registrySrc).digest("hex");
if (liveSha !== snapshot.provenance.registryContentSha256)
	fail(
		`registry content hash drift: snapshot ${snapshot.provenance.registryContentSha256.slice(0, 12)} vs live ${liveSha.slice(0, 12)} — re-run extract.mjs`,
	);

// ── Renderers ──
const esc = (s) =>
	String(s).replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	);
/**
 * The ONE renderer for authored prose. Everything is escaped first, then exactly
 * two things are re-enabled: `**bold**` and a bare `<br>` line break. Nothing
 * else can survive — no attributes, no scripts, no other tags — so authored
 * strings stay safe while still reading naturally in the data file.
 */
const rich = (s) =>
	esc(s)
		.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
		.replace(/&lt;br\s*\/?&gt;/gi, "<br>")
		.replace(/&lt;(\/?)code&gt;/gi, "<$1code>");

/**
 * Codex R2 HIGH-1: say the boundary PER OWNING PROCESS. The old version fell
 * through to "restart the Bridge" for everything, so a quota-daemon flag told
 * the founder to restart the Bridge — which would do nothing — while the same
 * card's owner banner said the Bridge is not what reads it.
 */
function activationText(act) {
	if (!act || act.n_a) return "改动后 N/A（未接入运行时）";
	const parts = [];
	// Codex R2 MEDIUM-1: do NOT return early on a live Bridge — a flag can be
	// console-live in the Bridge and still have another owner (a CLI) with its
	// own boundary. Returning early said "takes effect immediately" on a card
	// whose own banner said otherwise.
	if (act.bridge === "live") parts.push("Bridge 改了立刻生效（不用重启）");
	if (act.bridge === "restart") parts.push("重启 Bridge");
	if (act.lead === "restart") parts.push("重启各 Lead");
	if (act.daemon === "restart") parts.push("重启配额守护进程");
	if (act.voice === "restart") parts.push("重启 voice-bridge");
	if (act.watcher === "next_invocation")
		parts.push("cmux watcher 下次跑就生效");
	if (act.watcher === "restart") parts.push("重启 watcher");
	if (act.cli === "next_invocation") parts.push("下次命令行调用就生效");
	if (!parts.length) return "改动生效方式见本条";
	return parts.length === 1 ? parts[0] : `分别是：${parts.join(" / ")}`;
}

function currentValueBadge(row) {
	const c = row.configured;
	if (!c) return "现值未知";
	if (c.dormant) return "未接入运行时（dormant / N/A）";
	if (c.kind === "per_lead")
		return "按 Lead 不同（launcher 逐 Lead 派生，全局 .env 判不出）";
	if (c.kind === "project") {
		const nonDefault = c.byProject.filter((p) => !p.isDefault);
		if (!nonDefault.length)
			return `全部 ${c.byProject.length} 个项目都用默认（${row.default}）`;
		return `按项目不同：${nonDefault.map((p) => `${p.project}=${p.value}`).join("、")}`;
	}
	if (row.valueKind === "bool")
		return c.value
			? c.set
				? "现在开着（.env 显式 =1）"
				: "现在开着（默认）"
			: c.set
				? "现在关着（.env 显式 =0）"
				: "现在关着（默认 / 没设）";
	return c.set ? `现在 = ${c.value}（.env 显式设过）` : `用默认 = ${c.value}`;
}

const BUCKETS = {
	clear: { label: "清", cls: "b1" },
	dynamize: { label: "动态化", cls: "b4" },
	keep: { label: "留", cls: "b3" },
	unknown: { label: "不确定", cls: "bu" },
};

/**
 * Option set per kind (Tadashi: a numeric knob is rarely "deleted", so do not
 * force 「清」 onto one). The 4 park knobs are the exception — their lane is
 * dead, so `deadKnob` puts 「清」 back on the card.
 */
function optionsFor(f) {
	if (f.kind === "knob" && !f.deadKnob)
		return [
			["keep", "留（继续可调）"],
			["dynamize", "动态化（免重启可调）"],
			["unknown", "不确定"],
		];
	if (f.kind === "enum")
		return [
			["keep", "留"],
			["clear", "定一个赢家、其余删"],
			["dynamize", "动态化"],
			["unknown", "不确定"],
		];
	return [
		["keep", "留"],
		["clear", "清"],
		["dynamize", "动态化"],
		["unknown", "不确定"],
	];
}

function flagBlock(f) {
	const row = byName.get(f.name);
	const badge = currentValueBadge(row);
	const act = activationText(row.activation);
	const sug = BUCKETS[f.bucketSuggest];
	const picks = optionsFor(f)
		.map(
			([v, label]) =>
				`<label class="${BUCKETS[v].cls}${f.bucketSuggest === v ? " sug" : ""}"><input type="radio" name="f_${f.name}" data-q="flag:${f.name}" value="${v}"${f.bucketSuggest === v ? ' data-default="1"' : ""}>${esc(label)}</label>`,
		)
		.join("");

	// runtime truth OUTRANKS the configured value — say so loudly, and keep both.
	const hardOff = row.runtimeHardOff
		? `<div class="dead">💀 <b>这个开关现在是死的</b>：${esc(row.runtimeHardOff.reason)}<br><span class="ev">取证：${esc(row.runtimeHardOff.evidence)}</span></div>`
		: "";
	const deadDep = row.deadByDependency
		? `<div class="dead">💀 <b>${f.kind === "knob" ? "死旋钮" : "这个开关现在是死的"}</b>：它唯一的生产消费者接在已退役的 <code>${esc(row.deadByDependency.via)}</code> 后面，永不运行 —— 设成什么都不改变行为。<br><span class="ev">取证：${esc(row.deadByDependency.chain)}</span></div>`
		: "";
	// Codex R1 HIGH-2: which process actually reads it. The console's live toggle
	// only mutates the Bridge's own env, so a non-Bridge consumer cannot be made
	// hot by reclassifying the flag — say so instead of implying it is cheap.
	// Codex R3 MEDIUM-1: the banner used one blanket sentence for every
	// multi-process flag. For a flag the Bridge ALSO owns (and can already toggle
	// live) that sentence contradicted the activation line right above it.
	let ownerNote = "";
	if (row.processOwners && !row.bridgeOnlyConsumers) {
		const alsoBridge = row.processOwners.includes("Bridge");
		ownerNote = alsoBridge
			? "控制台的秒切只改 Bridge 自己的环境，所以 <b>Bridge 那半</b>可以，<b>其余那半不会</b>跟着变。"
			: "控制台的秒切只改 Bridge 自己的环境，而读它的根本不是 Bridge —— 所以这条<b>不是</b>「改个分类就能热切」。";
	}
	const owners = ownerNote
		? `<div class="owner">🔌 <b>读它的进程</b>：${esc(row.processOwners.join(" + "))} —— ${ownerNote}<br><span class="ev">取证：${esc(row.processOwnerEvidence)}</span></div>`
		: "";
	const envLine = row.envVar
		? `<code>${esc(row.envVar)}</code>`
		: `<code>${esc(row.configKey)}</code>（逐项目配置）`;
	const lead = f.leadOpinion
		? `<div class="lead">🍋 我的看法（工程事实以 Tadashi 为准，最后你圈）：${rich(f.leadOpinion)}</div>`
		: "";
	const premise = f.premise
		? `<div class="premise">前提：${rich(f.premise)}</div>`
		: "";
	const verified =
		row.runtimeHardOff || row.deadByDependency
			? ""
			: ' · <span class="dim">运行未独立验证</span>';

	return `<div class="fr">
  <div class="fh"><span class="fn">${esc(f.name)}</span><span class="pill ${sug.cls} sugpill">建议 ${esc(sug.label)}</span></div>
  <div class="cur"><b>配置里写的值：</b>${esc(badge)} · <b>改了怎么才生效：</b>${esc(act)}${verified}<br><span class="dim">开关名 ${envLine}</span></div>
  ${hardOff}${deadDep}${owners}
  <div class="plain"><b>开着＝</b>${rich(f.plain.on)}<br><b>关了＝</b>${rich(f.plain.off)}<br><b>为啥现在是这状态＝</b>${rich(f.plain.why)}</div>
  ${lead}
  <div class="pick">${picks}</div>
  ${premise}
  <div class="cmt"><label>对这条有疑问 / 决定就写这（可空）</label><textarea data-c="${esc(f.name)}"></textarea></div>
</div>`;
}

/**
 * Codex R1 HIGH-3: the drift entries are NOT one kind. An intentionally
 * unregistered internal seam (QA fault injection; reaping Chrome that might be
 * the founder's own window) must not be offered "promote into the console" —
 * that option is precisely the thing it is designed not to have.
 */
const DRIFT_KINDS = {
	product_flag: {
		note: "真的是功能开关、也确实该登记",
		options: [
			["register", "补登记进注册表", true],
			["clear", "就地清掉", false],
			["unknown", "不确定", false],
		],
	},
	ops_lever: {
		note: "内部运维 rollout 杆 —— 不算漏登记，问的是「转正吗」",
		options: [
			["register", "转正、登记进控制台", false],
			["keep", "维持内部杆不转正", true],
			["clear", "就地清掉", false],
			["unknown", "不确定", false],
		],
	},
	internal_seam: {
		note: "刻意不登记的内部接缝 —— 不提供「补登记到控制台」",
		options: [
			["keep", "维持现状（留在代码里、不进控制台）", true],
			["clear", "就地清掉", false],
			["unknown", "不确定", false],
		],
	},
};

function driftBlock(d, i) {
	const kind = DRIFT_KINDS[d.kind];
	if (!kind) fail(`drift entry ${d.envVar} has unknown kind "${d.kind}"`);
	const key = `drift_${i}`;
	const def = kind.options.find(([, , isDefault]) => isDefault);
	const cls = { register: "b3", keep: "b3", clear: "b1", unknown: "bu" };
	const picks = kind.options
		.map(
			([v, label, isDefault]) =>
				`<label class="${cls[v]}${isDefault ? " sug" : ""}"><input type="radio" name="f_${key}" data-q="drift:${d.envVar}" value="${v}"${isDefault ? ' data-default="1"' : ""}>${esc(label)}</label>`,
		)
		.join("");
	return `<div class="fr">
  <div class="fh"><span class="fn">${esc(d.envVar)}</span><span class="pill ${cls[def[0]]} sugpill">建议 ${esc(def[1])}</span></div>
  <div class="cur"><b>配置里写的值：</b>${esc(d.current)} · <span class="dim">没进注册表 → 控制台看不见</span><br><span class="dim">这一类：${esc(kind.note)}</span><br><span class="ev">取证：${rich(d.evidence)}</span></div>
  <div class="plain"><b>开着＝</b>${rich(d.plain.on)}<br><b>关了＝</b>${rich(d.plain.off)}<br><b>为啥现在是这状态＝</b>${rich(d.plain.why)}</div>
  <div class="pick">${picks}</div>
  <div class="cmt"><label>对这条有疑问 / 决定就写这（可空）</label><textarea data-c="${esc(d.envVar)}"></textarea></div>
</div>`;
}

/** Explicitly-set flags first — those are the ones that most need her call. */
function sortForReview(a, b) {
	const setOf = (f) => (byName.get(f.name)?.configured?.set ? 0 : 1);
	return setOf(a) - setOf(b);
}

function section(title, cls, hint, groupNames, collapsed) {
	const picked = FLAGS.filter((f) => groupNames.includes(f.group)).sort(
		sortForReview,
	);
	const blocks = picked.map(flagBlock).join("\n");
	const head = `<h2><span class="pill ${cls}">${esc(title)}</span> <span class="gc">${picked.length}</span></h2><p class="hint">${rich(hint)}</p>`;
	if (collapsed)
		return `${head}<details><summary>展开这 ${picked.length} 条（每条都有人话解释 + 留言位）</summary>\n${blocks}\n</details>`;
	return `${head}\n${blocks}`;
}

const prov = snapshot.provenance;
const body = `<div class="wrap">
<header>
<h1>62 个新开关，逐条说清在干嘛</h1>
<p class="sub">FLY-1413 · ${esc(prov.capturedAt.slice(0, 10))} · 上次 FLY-1136 审完之后新冒出来的这批 · 每条：人话在干嘛 + 现状 + 改了怎么才生效 + 我的建议 + 你圈</p>
</header>

<div class="hero">
<b>先说一个数字更正。</b>单子上写「~55 个」，实际数出来是 <b>62 个</b>。算法：上次 FLY-1136 审到最后是 103 个，之后清掉了 17 个（就是 FLY-1240 到 1243 那几单干的），现在注册表里是 148 个 —— <code>103 − 17 + 62 = 148</code>。对得上。<br>
<b>怎么用这张：</b>我已经按建议 <b>预选</b> 了每一条，并<b>按处理方式分了组</b>（不完全等于建议 —— 有 2 条我建议「不确定」，但按它们的工程处理方式排在下面的组里，卡片右上角会写「建议 不确定」）。你只要从上往下过，<b>改掉不同意的</b>，有疑问就在那条下面写。底部「复制我的逐条决定」一次带走。没点过的会在导出里标「未过目」。
</div>

<div class="grow">📌 <b>三个桶什么意思</b><br>
<b>清</b>＝这开关已经不起作用了（代码里硬关死），或者它自己写明的退役条件已经到了 → 固化成默认 + 退休开关，逻辑保留。<br>
<b>动态化</b>＝该继续当开关，但现在改了要重启才算数 → 把读取时机改掉 / 接进控制台，归 FLY-1405 那条线。<br>
<b>留</b>＝现在就已经是想要的样子：要么已经能秒切，要么是治理门（本来就不该随手切），要么是路径配置（不该热改）。</div>

<div class="caveat">⚠️ <b>两条口径，先说清楚免得误读</b><br>
① 每条写的「配置里写的值」是<b>磁盘上配置文件的值</b>，不是跑着的进程里的活值。如果某个值改过、但相关进程还没重启过，进程里可能还是旧的 —— 这张表看不出来，要看活值得查控制台。<br>
② 除了标 💀 的 13 条（那些我逐个追到调用点取了证），其余的<b>运行时行为我没有独立验证</b>，写的是代码和注册表说的。工程事实以 Tadashi 为准。</div>

<div style="margin:8px 0 2px"><span id="prog">已过 0 / ${TOTAL_FLAGS + DRIFT.length}</span></div>

${section("清", "b1", "这组有实打实的证据：**13 条是死壳** —— 环境变量还在，但它的消费者接在一条已经退役的巷道后面（判断函数写死了「关」），你怎么设都没用。分两批：一批是停车扫描（park_watch + 它的 4 个旋钮 + checkpoint 巡检），另一批是投递签收（delivery_ack + 4 个旋钮 + 空档扫描判据），根都是同一次退役。剩下 1 条 <code>quota_daemon_cutover</code> 不是死壳 —— 它**自己写明**了退役条件、但**条件我没验**，所以它排在这组里但**预选的是「不确定」**。", ["clear"], false)}

${section("动态化 · 一改就能秒切的", "b4", "这 14 条**在代码里已经是随用随读**了，只是注册表把它们标成「只读」—— 离「能秒切」差一层分类 + 一条证明测试，是 FLY-1405 性价比最高的一段。<br>两条标了 ⚠️：注册表写着「立即生效」「应急停用」，实际改完并不会立刻生效 —— **说的和做的对不上**，事故当下最容易踩。<br>另外带 🔌 的那几条要注意：它们不止 Bridge 一个读者（有的是独立守护进程，有的还有命令行），而控制台的秒切只改 Bridge 自己的环境 —— 这几条不是「改个分类」就完事的。", ["dynamize_f"], false)}

${section("动态化 · 要改读取时机的", "b4", "这 9 条是**真的**在启动那一刻读一次就焊死了，动态化要逐个改读点，工作量比上面那组大。里面 cmux_linked_view 那条我标了「不确定」—— 它默认是开的、生产却被显式关掉，而**没有任何地方记了为什么**，我没编理由。", ["dynamize_e"], false)}

${section("动态化 · 数值旋钮", "b4", "这 3 条不是开关是数字（几分钟、多久）。它们现在调不了热的，原因很具体：控制台的切换接口只认「布尔」和「有限取值」，自由数字被结构性拒绝 —— 要动态化就得给它加带边界的数值校验。**这组不给「清」选项**（旋钮很少是删掉，是调）。", ["dynamize_knob"], false)}

${section("留 · 已经能秒切的", "b3", "这 15 条**已经是我们想要的样子了** —— 改了立刻生效，不用重启。不用动。<br>其中 3 条（workflow_template_dispatch / claims_write / claims_read）按「已经全量开着就该固化」的规矩像清理对象，但它们是明确交给你控制的 DAG 杆，而 v2 那半还关着＝**上线在半途**。现在退休它们等于上线中途拆方向盘 —— 我建议 DAG v2 收尾后一批三个一起转「清」。", ["keep_direct"], true)}

${section("留 · 其余", "b3", "治理门 2 条（能随手关的门不叫门，按规矩永远不进批量切换）· 逐项目配置 1 条（改配置文件就生效，已经是好形态）· 按次调用生效 2 条（本来就不用重启，不属于动态化对象）· 测试专用接缝 1 条（做成能随手切反而会削弱它的硬保险）· 路径配置 1 条（跑着的时候改会让在途凭据失效）。", ["keep_gate", "keep_project", "keep_percall", "keep_qa", "keep_path"], true)}

<h2><span class="pill bu">额外一节：${DRIFT.length} 个没登记的开关</span> <span class="gc">${DRIFT.length}</span></h2>
<p class="hint">这 ${DRIFT.length} 个<b>不在上面 62 条里</b>，因为它们压根没登记过。代码里它们被当开关用（<code>=== "1"</code>），也进了真值白名单（所以漂移检查不报），<b>但没进注册表</b> —— 控制台看不见、逐条审计也会漏掉。这一节是拿 Tadashi 那份 env 侧清单（444 个变量）和注册表交叉核出来的。<br>
<b>但它们不是一类东西，所以选项不一样</b>：前两个是<b>内部运维杆</b>（生产开着，问的是「转正吗」，不是「漏登记了」）；后两个是<b>刻意不登记的内部接缝</b>（一个是 QA 故障注入，一个会去回收「认不出归属」的 Chrome —— 那可能是你自己开的窗口）。后两个<b>不提供「补登记到控制台」</b>，因为那正是它们被设计成不该有的入口。</p>
${DRIFT.map(driftBlock).join("\n")}

<div class="grow" style="margin-top:20px">📏 <b>顺带一个规模数字（不用你圈，只是让你知道盘子多大）</b><br>
Tadashi 机械扫了一遍所有 <code>FLYWHEEL_*</code> 环境变量，一共 <b>444 个</b>。其中真正的开关只有 <b>53 个</b>（13 个默认关 + 40 个默认开）—— 剩下 <b>391 个是「值配置」</b>：超时秒数、token、频道 id、目录路径这类。<br>
<b>它们不是 on/off 开关，所以不进这张圈选页</b>。放这句是因为它本身就是 flag 债的规模证据：真正要你拍的开关是几十个量级，而挂在环境变量上的配置是它的七八倍。<br>
<span style="color:#a06a00">覆盖率交代（拿他那份清单跟这页逐个对过）：那 <b>53</b> 个真开关 = <b>19</b> 个在上面的卡片里（本轮新增）+ <b>4</b> 个在「没登记」那节 + <b>30</b> 个是 FLY-1136 那轮你已经圈过的。<b>19+4+30 = 53，没有漏网的新开关</b>。<br>
（为什么这页有 62 张卡、这里却只对上 19 个：他那份是机械扫 <code>process.env.FLYWHEEL_X</code> 这种字面写法，认不出 <code>defaultOn(env, "X")</code> 之类的间接读法，所以他的 53 是偏少的一份。注册表才是全的，这页按注册表出。）</span></div>

<div class="cmt" style="margin-top:16px"><label>整体留言（可选，比如「这批清理我同意，但 X 先别动」）</label><textarea data-k="overall"></textarea></div>
<div class="bar">
<button class="primary" id="exportBtn">复制我的逐条决定</button>
<button class="ghost" id="clearBtn">清空</button>
<span id="saveHint">自动存在本机</span>
</div>
<p class="foot">口径：注册表是唯一真源（内容哈希 <code>${esc(prov.registryContentSha256.slice(0, 12))}</code>，抽取于 ${esc(prov.capturedAt.slice(0, 16).replace("T", " "))}）。基线是 FLY-1136 那轮的 103 条（commit <code>${esc(prov.baseline.commit)}</code>，已${prov.baseline.verifiedAgainstGit ? "" : "<b>未</b>"}用 git 逐条核对）。<br>
「配置里写的值」＝磁盘配置，不等于跑着的进程里的活值。除标 💀 的 13 条外，运行时行为未独立验证。本页只做审计和圈选，<b>不改任何 flag</b>。导出的决定带「事实版本」一行，下游执行单请核对。</p>
</div>
<dialog id="dlg"><div class="dlg"><h3>你的逐条决定（已复制）</h3><p class="dlgsub">粘回 Discord 发我就行。</p><textarea id="out" readonly></textarea><div class="dlgbtns"><button class="primary" id="dlBtn">下载 .md</button><button class="ghost" id="closeBtn">关闭</button></div></div></dialog>`;

const script = `
(function(){
  var scope=(typeof location!=="undefined"&&location.pathname)?location.pathname:"local";
  // Codex R1 HIGH-6: bind saved state AND the export to the fact version. A
  // regenerated page (registry moved, wording changed) must NOT silently inherit
  // the old "已过目" ticks, and a downstream execution issue must be able to
  // check that a decision was made against the facts it can still reproduce.
  var FACTS="__FACT_VERSION__";
  var KEY="fly1413-flag-audit::"+scope+"::"+FACTS;
  var LABEL={"clear":"清 / 清掉","dynamize":"动态化","keep":"留 / 维持现状","unknown":"不确定","register":"补登记 / 转正"};
  var areas=Array.prototype.slice.call(document.querySelectorAll("textarea[data-c],textarea[data-k]"));
  var radios=Array.prototype.slice.call(document.querySelectorAll("input[type=radio][data-q]"));
  var names={}; radios.forEach(function(r){names[r.name]=1;}); var TOTAL=Object.keys(names).length;
  var saved={}; try{saved=JSON.parse(localStorage.getItem(KEY)||"{}");}catch(e){saved={};}
  // Pre-fill my suggestion so she confirms-or-overrides instead of clicking 66 times.
  // "Reviewed" is tracked separately so the progress count stays honest.
  radios.forEach(function(r){var nk="r::"+r.name; if(saved[nk]===undefined && r.getAttribute("data-default")==="1"){saved[nk]=r.value;}});
  function seenCount(){var c=0; for(var k in saved){if(k.indexOf("seen::")===0 && names[k.slice(6)])c++;} return c;}
  function prog(){var el=document.getElementById("prog"); if(el)el.textContent="已过 "+seenCount()+" / "+TOTAL+"（已按我的建议预选，你只需过一遍、改不同意的）";}
  function persist(){try{localStorage.setItem(KEY,JSON.stringify(saved));}catch(e){} var h=document.getElementById("saveHint"); if(h)h.textContent="已保存 ✓"; prog();}
  areas.forEach(function(t){var k=t.getAttribute("data-c")?("c::"+t.getAttribute("data-c")):("k::"+t.getAttribute("data-k")); if(saved[k])t.value=saved[k]; t.addEventListener("input",function(){saved[k]=t.value;persist();});});
  // Mark reviewed on BOTH change AND click — clicking an already-selected
  // suggestion (the common case here) does not fire change.
  function markSeen(r){if(r.checked){saved["r::"+r.name]=r.value;saved["seen::"+r.name]=1;persist();}}
  radios.forEach(function(r){var nk="r::"+r.name; if(saved[nk]===r.value)r.checked=true; r.addEventListener("change",function(){markSeen(r);}); r.addEventListener("click",function(){markSeen(r);});});
  prog();
  function labelOf(r){var q=r.getAttribute("data-q"); return q.indexOf("drift:")===0?q.slice(6):q.slice(5);}
  function buildMd(){
    var lines=["# FLY-1413 · 62 个新开关 + 4 个没登记的 —— Annie 的逐条决定","","日期: "+new Date().toLocaleString(),"已过目 "+seenCount()+" / "+TOTAL+" 条（其余用了我的建议，下面标「未过目」）","事实版本: "+FACTS+"（下游执行单请核对这一行；对不上说明注册表已经变了，要重出这张表）",""];
    // Keep the 62 registered flags and the 4 unregistered vars in SEPARATE
    // sections: both can be answered "keep", but "keep a registered flag" and
    // "leave an unregistered seam alone" are different follow-up work.
    var by={}, byDrift={};
    Object.keys(LABEL).forEach(function(k){by[k]=[];byDrift[k]=[];});
    radios.forEach(function(r){
      if(!r.checked) return;
      var mark=saved["seen::"+r.name]?"":" （未过目）";
      var isDrift=r.getAttribute("data-q").indexOf("drift:")===0;
      (isDrift?byDrift:by)[r.value].push(labelOf(r)+mark);
    });
    lines.push("## 一、62 个新开关","");
    ["clear","dynamize","unknown","keep"].forEach(function(k){
      var arr=by[k]||[]; lines.push("### "+LABEL[k]+"（"+arr.length+"）","",arr.map(function(x){return "- "+x;}).join("\\n")||"> (无)","");
    });
    lines.push("## 二、4 个没登记进注册表的","");
    ["register","keep","clear","unknown"].forEach(function(k){
      var arr=byDrift[k]||[]; if(!arr.length) return;
      lines.push("### "+LABEL[k]+"（"+arr.length+"）","",arr.map(function(x){return "- "+x;}).join("\\n"),"");
    });
    var cmts=[];
    areas.forEach(function(t){var fk=t.getAttribute("data-c"); if(fk&&t.value.trim())cmts.push("- **"+fk+"**: "+t.value.trim());});
    if(cmts.length){lines.push("## 逐条留言","",cmts.join("\\n"),"");}
    var ovEl=document.querySelector("textarea[data-k=overall]"); var ov=ovEl?ovEl.value:"";
    if(ov&&ov.trim()){lines.push("## 整体留言","",ov.trim());}
    return lines.join("\\n");
  }
  var dlg=document.getElementById("dlg"),out=document.getElementById("out");
  document.getElementById("exportBtn").addEventListener("click",function(){out.value=buildMd(); if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(out.value).catch(function(){}); if(dlg.showModal)dlg.showModal(); else alert(out.value);});
  document.getElementById("clearBtn").addEventListener("click",function(){if(!confirm("清空所有圈选和留言?不可撤销。"))return; areas.forEach(function(t){t.value="";}); radios.forEach(function(r){r.checked=false;}); saved={}; try{localStorage.removeItem(KEY);}catch(e){} prog(); var h=document.getElementById("saveHint"); if(h)h.textContent="已清空。";});
  document.getElementById("dlBtn").addEventListener("click",function(){var b=new Blob([out.value],{type:"text/markdown"}),u=URL.createObjectURL(b); var a=document.createElement("a"); a.href=u; a.download="fly1413-62flag-决定.md"; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function(){URL.revokeObjectURL(u);},1000);});
  document.getElementById("closeBtn").addEventListener("click",function(){if(dlg.close)dlg.close();});
})();
`;

/**
 * The fact version every saved/exported decision is bound to (Codex R1 HIGH-6,
 * widened in R2 HIGH-2).
 *
 * The first version hashed only registry.ts, so a correction that did NOT touch
 * the registry — a fixed process attribution, a reworded card, a changed
 * suggestion, an updated `.env` value — kept the SAME version. Old "已过目" ticks
 * would carry over onto changed facts, and two different pages would export the
 * same version string. Now it covers everything the founder actually reads:
 * normalized snapshot (capture time excluded so a pure re-run is stable) +
 * the authored data file + the pinned baseline + the scope size.
 */
const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const normalizedSnapshot = JSON.stringify({
	...snapshot,
	provenance: { ...snapshot.provenance, capturedAt: "<normalized>" },
});
const FACT_VERSION = [
	`snap:${sha12(normalizedSnapshot)}`,
	`data:${sha12(fs.readFileSync(path.join(HERE, "flags-data.js"), "utf8"))}`,
	`base:${prov.baseline.commit}`,
	`n:${TOTAL_FLAGS}+${DRIFT.length}`,
].join("/");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-1413 · 62 个新开关，逐条说清在干嘛 + 你圈留/清/动态化</title>
<style>
/* Light-only, declared to the UA as well as in our own colours: without this a
   dark-mode browser still paints the form controls (radios, textareas) with its
   dark widget styling on top of a light page. Annie's pages are light-only. */
html{color-scheme:light only}
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#86868b;--line:#e5e5ea;--navy:#1a365d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,system-ui,"SF Pro Text",Segoe UI,Roboto,sans-serif;line-height:1.55;-webkit-text-size-adjust:100%}
.wrap{max-width:900px;margin:0 auto;padding:20px 16px 96px}
h1{font-size:22px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:var(--dim);font-size:13px;margin:0 0 10px}
h2{font-size:16px;margin:28px 0 2px}
.gc{color:var(--dim);font-size:13px;font-weight:600}
.hint{color:#555;font-size:12.5px;margin:3px 0 10px}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:1px 8px;border-radius:6px}
.b1{background:#fdeceb;color:#c0322b}.b3{background:#e3f9ea;color:#1a7a3c}.b4{background:#f3e8fd;color:#7b2ec8}.bu{background:#f0f0f4;color:#555}
.hero{background:#fff;border:1px solid var(--line);border-left:4px solid #af52de;border-radius:12px;padding:13px 15px;margin:6px 0 8px;font-size:13.5px}
.hero b{color:var(--navy)}
.grow{background:#fff6e6;border:1px solid #ffe0a3;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:13px;color:#8a5a00}
.fr{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.fh{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.fn{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:13.5px;color:var(--navy);font-weight:600;word-break:break-all}
.sugpill{margin-left:auto}
.cur{font-size:12.5px;color:#333;margin:2px 0}
.plain{font-size:13.5px;color:#222;margin:6px 0;background:#fafafd;border-radius:8px;padding:8px 10px}
.dim{color:var(--dim)}
.dead{font-size:12.5px;color:#c0322b;background:#fdeceb;border:1px solid #f5b7b1;border-left:4px solid #ff3b30;border-radius:8px;padding:7px 10px;margin:5px 0}
.dead b{color:#a02620}
.owner{font-size:12.5px;color:#7b2ec8;background:#f7f0ff;border:1px solid #e3d0f7;border-radius:7px;padding:5px 9px;margin:5px 0}
.caveat{background:#fff;border:1px solid var(--line);border-left:4px solid #ff9500;border-radius:10px;padding:9px 12px;margin:8px 0;font-size:12.5px;color:#7a4a00}
.ev{color:#8a4a45;font-size:11.5px;font-family:"SF Mono",ui-monospace,Menlo,monospace;word-break:break-all}
.lead{font-size:12.5px;color:#8a5a00;background:#fff6e6;border:1px solid #ffe0a3;border-radius:7px;padding:5px 9px;margin:5px 0}
code{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:11.5px;background:#f0f0f4;border-radius:4px;padding:0 4px}
.pick{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 2px}
.pick label{display:flex;gap:4px;align-items:center;font-size:12.5px;background:#f6f6fa;border:1px solid var(--line);border-radius:8px;padding:5px 11px;cursor:pointer}
.pick label.sug{outline:2px solid #34c759;outline-offset:-1px;font-weight:600}
.pick input{accent-color:#007aff}
.premise{font-size:11.5px;color:#8a5a00;background:#fff6e6;border-radius:7px;padding:5px 8px;margin:5px 0 0}
.cmt{margin:8px 0 0}
.cmt label{display:block;font-size:11.5px;color:var(--dim);margin-bottom:3px}
.cmt textarea{width:100%;min-height:44px;border:1px solid var(--line);border-radius:8px;padding:7px 9px;font:inherit;font-size:14px;background:#fff;color:var(--ink);resize:vertical}
details{margin:6px 0}summary{cursor:pointer;font-size:13px;color:var(--navy);font-weight:600;padding:6px 0}
.foot{font-size:11.5px;color:var(--dim);margin-top:18px;line-height:1.6}
.bar{position:sticky;bottom:0;margin-top:20px;background:rgba(245,245,247,.92);backdrop-filter:saturate(180%) blur(8px);border-top:1px solid var(--line);padding:10px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
button{font:inherit;font-size:14px;font-weight:600;border:none;border-radius:10px;padding:9px 16px;cursor:pointer}
button.primary{background:#007aff;color:#fff}button.ghost{background:#fff;color:var(--navy);border:1px solid var(--line)}
#saveHint{color:var(--dim);font-size:12.5px}#prog{font-size:12.5px;color:var(--navy);font-weight:600}
dialog{border:none;border-radius:14px;padding:0;max-width:680px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,.25)}
dialog::backdrop{background:rgba(0,0,0,.35)}
.dlg{padding:18px 20px}.dlg h3{margin-top:0}.dlgsub{font-size:12.5px;color:var(--dim)}
.dlg textarea{width:100%;min-height:220px;border:1px solid var(--line);border-radius:10px;padding:10px;font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:12px;background:#fff;color:var(--ink)}
.dlgbtns{margin-top:10px;display:flex;gap:8px}
</style>
</head>
<body>
${body}
<script nonce="__CSP_NONCE__">${script.replace("__FACT_VERSION__", FACT_VERSION)}</script>
</body>
</html>
`;

// ── Guard 5: the generated inline script must parse ──
const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
if (!scriptTags.length) fail("no inline <script> found in generated HTML");
for (const [, attrs, bodyText] of scriptTags) {
	try {
		// Compile-only syntax check: `new vm.Script` parses and throws on a syntax
		// error but never produces anything callable, so nothing here can run
		// (preferred over `new Function`, which compiles into a callable).
		new Script(bodyText);
	} catch (e) {
		fail(`generated inline script has a syntax error: ${e.message}`);
	}
	// ── Guard 6: EVERY script tag must carry the publisher's nonce placeholder.
	// This was a hand-run grep that got missed twice (FLY-1045, FLY-1311); a bare
	// <script> passes local preview and is then blocked by the published CSP,
	// silently killing every radio and textarea on the page.
	if (!/nonce="__CSP_NONCE__"/.test(attrs))
		fail(
			'a <script> tag is missing nonce="__CSP_NONCE__" — published CSP would block it',
		);
}
if ((html.match(/__CSP_NONCE__/g) || []).length < 1)
	fail("__CSP_NONCE__ placeholder count is 0");

// ── Guard 7: light-only house style, both halves ──
// 7a: no dark media query. 7b: the UA is told too — otherwise a dark-mode
// browser paints the radios/textareas dark on our light page.
if ((html.match(/prefers-color-scheme/g) || []).length !== 0)
	fail("prefers-color-scheme present — Annie's pages are light-only");
if (!/html\s*\{[^}]*color-scheme:\s*light only/.test(html))
	fail(
		"missing `html{color-scheme:light only}` — dark-mode UAs would still dark-style the form controls",
	);

// ── Guard 7c: zero inline event handlers (all wiring via addEventListener).
// An `onclick=` attribute is blocked by the publisher's nonce-based CSP, which
// would silently kill the control it is attached to. ──
const inlineHandlers = [...html.matchAll(/\son[a-z]+\s*=/gi)].map((m) =>
	m[0].trim(),
);
if (inlineHandlers.length)
	fail(
		`inline event handler(s) present, blocked by CSP: ${[...new Set(inlineHandlers)].join(", ")}`,
	);

// ── Guard 7d: no network access from the page (self-contained, CSP-safe) ──
const net = [
	...html.matchAll(/\b(fetch\(|XMLHttpRequest|WebSocket|EventSource)/g),
].map((m) => m[1]);
if (net.length)
	fail(`page attempts network access: ${[...new Set(net)].join(", ")}`);
const externalRefs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map(
	(m) => m[1],
);
if (externalRefs.length)
	fail(`external resource reference(s): ${externalRefs.join(", ")}`);

// ── Guard 7e: every TEXT-BEARING control must declare BOTH background and
// color. `color-scheme: light only` is one layer; the Lead found a textarea rule
// that set only geometry, so a dark-mode UA still painted inside it.
//
// The first version of this guard only fired on "background without color" —
// which caught the second instance I found but NOT the Lead's original one
// (neither property set). A guard that misses the case that motivated it is
// worse than none, because it reads as covered. Both cases now fail.
{
	// Scope to the <style> block — searching the whole document would run past
	// </style> and treat script braces as CSS.
	const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
	const textControlRules = [
		...css.matchAll(/(?:^|[};])\s*([^{};]*\btextarea\b[^{};]*)\{([^}]*)\}/g),
	];
	if (!textControlRules.length)
		fail("no textarea CSS rule found — guard 7e would pass vacuously");
	for (const [, selector, decls] of textControlRules) {
		const hasBg = /(^|;)\s*background(-color)?\s*:/.test(decls);
		const hasColor = /(^|;)\s*color\s*:/.test(decls);
		if (!hasBg || !hasColor)
			fail(
				`CSS rule "${selector.trim()}" must declare BOTH background and color (has background=${hasBg}, color=${hasColor}) — a dark-mode UA paints text controls with its own palette otherwise`,
			);
	}
}

// ── Guard 8: complete document (the publisher rejects a fragment) ──
if (!html.startsWith("<!DOCTYPE html>"))
	fail("output does not start with <!DOCTYPE html>");
for (const tag of ["<html", "<head>", "<body>", "</body>", "</html>"])
	if (!html.includes(tag))
		fail(`output is not a complete document: missing ${tag}`);

// ── Guard 9: card count must equal the audited scope ──
const cardCount = (html.match(/<div class="fr">/g) || []).length;
if (cardCount !== TOTAL_FLAGS + DRIFT.length)
	fail(`card count ${cardCount} !== ${TOTAL_FLAGS} + ${DRIFT.length} drift`);

// ── Guard 9b: no authored markdown may leak into the rendered page. Literal
// `**` or an escaped `&lt;br&gt;` means a string bypassed rich() or embedded raw
// HTML — the founder sees asterisks and tag text. The inline <script> legitimately
// contains `**` (it BUILDS markdown for the export), so check the body only. ──
const renderedBody = html.slice(0, html.indexOf("<script"));
const mdLeak = renderedBody.match(
	// Match the opening `&lt;` + a tag-name letter. An earlier version required
	// the closing `&gt;` with `[^&]*` in between, which an escaped attribute
	// (`&lt;aside title=&quot;x&quot;&gt;`) breaks — so it was not the "any
	// escaped tag" guard it claimed to be. Prefix-only is strictly fail-closed.
	/\*\*|&lt;\/?[a-z]/i,
);
if (mdLeak)
	fail(
		`unrendered markup leaked into the page: ${JSON.stringify(mdLeak[0])} — route the string through rich() instead of embedding raw HTML`,
	);

// ── Guard 10: the fact-version placeholder must be substituted, and the real
// version must appear. A silent no-op here would ship a page whose saved state
// is not bound to anything — the exact failure HIGH-6 asked us to close. ──
if (html.includes("__FACT_VERSION__"))
	fail("__FACT_VERSION__ placeholder was not substituted");
if (!html.includes(FACT_VERSION))
	fail(`fact version ${FACT_VERSION} missing from output`);

fs.writeFileSync(path.join(HERE, "flag-audit.html"), html);
console.log(
	`flag-audit.html written: ${TOTAL_FLAGS} flags + ${DRIFT.length} drift = ${cardCount} cards · groups ${JSON.stringify(groupCounts)} · suggest ${JSON.stringify(suggestCounts)} · facts ${FACT_VERSION} · all 14 guards passed`,
);
