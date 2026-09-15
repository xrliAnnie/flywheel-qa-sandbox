#!/usr/bin/env python3
"""Build founder-design.html for FLY-2560: inline pre-rendered mermaid SVGs, zero external deps.
Run from this folder: python3 build-founder-html.py
"""
from html import escape
from pathlib import Path

HERE = Path(__file__).resolve().parent
ISSUE = "FLY-2560"
ISSUE_URL = "https://linear.app/geoforge3d/issue/FLY-2560/自动合并试判-机器试判首次真跑三项全待补证判定器输入为空卡面写0-仓在飞-pr-未取全-输入必须拿到-pr-diff-设计文档-qa"


def svg(name: str) -> str:
    text = (HERE / name).read_text(encoding="utf-8")
    # keep the unique svgId produced by mmdc; strip xml prolog if any
    if text.startswith("<?xml"):
        text = text.split("?>", 1)[1]
    return text


# ---- issue / tool-derived text goes through escape() before interpolation ----
FOUNDER_QUOTE = escape("你这里是说那个不可判定哦，就是那个 PRD 合并什么 QA 都是待补证。那如果你所有的东西最后都判定是待补证，没有办法判断的话，那我们这一个 Auto approve 这条线路就是失败的呀……我觉得你这还是做的不对啊。")
CARD_BEFORE = escape("""机器试判：不可判定 · dry_run
① PRD / 设计对齐：待补证
② 合并与在飞文件：待补证
③ QA 用例覆盖：待补证
检查范围：main合并＋目标分支合并＋同项目在飞文件；0 仓，在飞 PR 未取全。""")
CARD_AFTER = escape("""机器试判：可自动批（若开自动批） · dry_run
① PRD / 设计对齐：通过 · 设计评审 APPROVED r1（blob 未核）· 代码评审 APPROVED@5ce2ca41 r5 · diff 12 文件
② 合并与在飞文件：通过 · main 可合 · 在飞 38 PR 无同文件
③ QA 用例覆盖：通过 · qa_passed claim#1148 · 报告 12a253b4
缺证据：无
语义复核：未跑
截至 2026-09-14T20:19Z 的试判；后续检查可能待更新，仍由你批准。""")
CARD_MISSING = escape("""机器试判：缺证据：③ QA 判决 · dry_run
① PRD / 设计对齐：通过 · 设计评审 APPROVED r1 · 代码评审 APPROVED@a20caf40 r3 · diff 9 文件
② 合并与在飞文件：通过 · main 可合 · 在飞 38 PR 无同文件
③ QA 用例覆盖：缺 QA 判决 · 未见 head a20caf40 的 qa_verdict claim
缺证据：③ QA 判决
语义复核：未跑""")
ROOT_CAUSE_A = escape("xrliAnnie/flywheel")
ROOT_CAUSE_B = escape("xrliannie/flywheel")

SECTIONS = []  # (id, title, body_html)


def section(sid: str, title: str, body: str, color: str = "#007aff"):
    SECTIONS.append((sid, title, body, color))


section("s1", "1. 一句话", f"""
<p class="lead">机器试判之前是「拿不到输入 → 三项一起写待补证」。本设计把它改成：<b>先自检输入</b>，然后 <b>三项各自绑到机器里已有的凭证</b>，逐项独立给出「通过 / 不通过 / 缺哪一样」，模型只保留否决权；再用你今天已经按过的 12 张卡做一次<b>离线回放</b>，告诉你「若开自动批会批几张、错几张」。</p>
<p>本单 <b>不开自动批</b>、不改你的审批权限，只改试判文本与它背后的判定。</p>
""", "#34c759")

section("s2", "2. 现场：为什么三项全「待补证」", f"""
<p>你 2026-09-14 20:20Z 的原话：</p>
<blockquote>{FOUNDER_QUOTE}</blockquote>
<p>生产里今天三张真卡（FLY-2556 / FLY-2553 / FLY-2555）的试判记录，<b>原因码全部相同</b>：<code>project_sources_unavailable</code>（意思是「判定器连仓库列表都没拿到」）。它从来没走到读 PR diff 那一步，更没起过模型。</p>
<div class="two">
<div><div class="sub">根因 A：仓库名大小写</div>
<p>配置文件写的是 <code>{ROOT_CAUSE_A}</code>（大写 A），而机器里所有 PR 绑定记录写的是 <code>{ROOT_CAUSE_B}</code>（全小写）。GitHub 认为这是同一个仓库，判定器却把它当成「同一个身份绑了两个仓」，直接放弃并写「0 仓」。</p></div>
<div><div class="sub">根因 B：证据接错了表</div>
<p>③ QA 判决原来读的是一张几乎没人写的表（全库 12 行，今天 14 张卡里 0 行）；真正的 QA 判决在另一张表里（近 30 天 405 条通过、190 条不通过）。① 设计评审只在「当前这次运行」里找，而设计批准常常记在更早一次运行上，会漏。</p></div>
</div>
<p>另外，采集是「全或无」：四样输入缺任何一样，整包作废，三项一起待补证——这正是你反对的形态。</p>
""", "#ff3b30")

section("s3", "3. 核心流程", f"""
<p>图里每个方框是一步；实线是必经，虚线「可选」是模型语义复核（<b>语义复核</b>：让模型读设计文档与 diff，判断实现是否对齐需求。它现在只能把某一项从「通过」降为「不通过」，不能把「缺证据」变成「通过」）。</p>
<div class="diagram">{svg('d1-flow.svg')}</div>
""")

section("s4", "4. 数据结构：证据账本", f"""
<p><b>证据账本</b>（每张卡一份的结构化记录）：每个 PR 目标各自记录 ① 与 ③ 的判定，② 只在卡级；每个判定点写明「通过 / 不通过 / 缺哪样」和它引用了哪几条证据（证据池最多 64 条，目标最多 50 个）。账本存进意见表新列 <code>evidence_json</code>，历史行为空，不影响旧记录。</p>
<div class="diagram">{svg('d2-model.svg')}</div>
""")

section("s5", "5. 三项各绑什么证据", """
<table>
<thead><tr><th>项</th><th>通过要凑齐</th><th>直接不通过</th><th>缺证据时写什么</th></tr></thead>
<tbody>
<tr><td>① PRD / 设计对齐</td><td>设计评审 APPROVED（按 issue 找，不限当次运行）＋ 代码评审 APPROVED 且评的正是<b>这个精确 head</b>（<b>head</b>：PR 最新一次提交的唯一编号）＋ PR diff 已取到</td><td>设计评审或代码评审最新一轮是 CHANGES_REQUESTED；diff 含二进制无法比对</td><td>缺 设计评审 / 缺 代码评审@head / 缺 PR diff</td></tr>
<tr><td>② 合并与在飞文件</td><td>试合并 main 无冲突 ＋ 同项目其它在飞 PR 与本 PR 没有改同一个文件</td><td>合并冲突；或有同文件在飞</td><td>缺 在飞快照（例如 GitHub 调用预算用尽）</td></tr>
<tr><td>③ QA 用例覆盖</td><td>QA 节点对<b>这个精确 head</b> 的 <code>qa_passed</code> 判决（当前 attempt、正确签发者、未撤销、在截止前签发）</td><td><code>qa_failed</code></td><td>缺 QA 判决</td></tr>
</tbody></table>
<p>三项都通过 → 「可自动批（若开自动批）」；任一不通过 → 「不可自动批：第几项」；任一缺 → 「缺证据：第几项缺什么」。「不可判定」四个字从卡面消失。</p>
""", "#af52de")

section("s6", "6. 卡面前后对比", f"""
<div class="two">
<div><div class="sub">之前（今天 FLY-2553 真卡）</div><pre>{CARD_BEFORE}</pre></div>
<div><div class="sub">之后（同一张卡、同一份输入）</div><pre>{CARD_AFTER}</pre></div>
</div>
<div class="sub">缺证据的样子（示例：只缺 QA 判决，其它两项照判）</div><pre>{CARD_MISSING}</pre>
<p>「blob 未核」的意思：设计评审批准的是哪一版 plan 文档，机器没有留下指纹（近 30 天 164 条设计批准 0 条有），所以只能核「文档在 head 上存在」；文档批准后被改动的风险由「代码评审@精确 head」兜住（文档和代码在同一个 PR 里被一起评）。</p>
""", "#ff9500")

section("s7", "7. 离线回放：12 张卡", f"""
<p>用你 2026-09-14 已按的 12 张卡（2544 / 2549 / 2543 / 2360 / 2542 / 2541 / 2467 / 2548 / 2546 / 2399 / 2496 / 2556）做只读回放。<b>截止时间 = 你按下的那一刻</b>，之后才产生的记录一律不算，避免「事后证据」把当时的判断说漂亮。</p>
<div class="diagram">{svg('d3-replay.svg')}</div>
<p>产出一张托管表：每张卡的 ① / ②（事后合入，明确标注）/ ③ / 机器总判 / 你的实际决定 / 是否一致，以及一行汇总「若开自动批：会批 N 张、错 M 张、弃权 K 张」。按现有记录预判：12 张全是批准；FLY-2360 是没有设计与 QA 节点的通用运行，机器只能「缺证据」（弃权，不是错判）；其余 11 张凭证齐全。<b>实际数字以脚本输出为准</b>，实现节点跑完后写进实现记录并托管。</p>
""")

section("s8", "8. 关键取舍与被否决的方案", """
<table>
<thead><tr><th>取舍</th><th>选了什么</th><th>为什么不选另一边</th></tr></thead>
<tbody>
<tr><td>谁说了算：凭证还是模型</td><td>凭证先判，模型只否决（Lead 已裁定）</td><td>若坚持「①③ 只由模型定」，模型没跑或预算用尽时三项又会变回待补证；12 张回放会全部弃权</td></tr>
<tr><td>缺一样怎么办</td><td>逐项独立，缺哪项标哪项</td><td>「全或无」正是这次故障的形态</td></tr>
<tr><td>仓库名大小写</td><td>比较时两边统一小写</td><td>改配置文件治标；GitHub 本来就不分大小写</td></tr>
<tr><td>设计批准找法</td><td>按 issue 找，再核文档在 head 上存在</td><td>按当次运行找会漏掉设计与实现分两次运行的卡（今天至少 3 张）</td></tr>
<tr><td>回放的 ②</td><td>用耐久的「已合入 main」记录并标注为事后证据</td><td>当时的在飞 PR 集合没有留存，重跑试合并也不是当时的情形</td></tr>
<tr><td>设计文档指纹缺失</td><td>通过但标「blob 未核」</td><td>「没指纹就算缺」会让 ① 在所有真卡上退回缺证据</td></tr>
</tbody></table>
""", "#86868b")

section("s9", "9. 诚实边界：做什么、不做什么", """
<div class="two">
<div><div class="sub">做</div><ul>
<li>修「0 仓」根因，加启动自检，输入不可得时卡面写明原因</li>
<li>三项各绑机器凭证、逐项独立判、卡面三行结论</li>
<li>模型语义复核保留，降为否决层，状态如实显示（未跑 / 已跑未否决 / 通过 / 不通过）</li>
<li>12 张卡只读回放 + 托管表</li>
</ul></div>
<div><div class="sub">不做</div><ul>
<li><b>不开自动批</b>，不改 approve_to_ship 权限、founder gate、land、auto 开关；试判仍只是文本</li>
<li>不重写模型评估、学习统计、旧窄口统计</li>
<li>不扩 GitHub 调用预算（每小时 120 次；39 个在飞 PR 一次全量约 109 次，预算不足时 ② 写「缺在飞快照」）</li>
<li>没有设计 / QA 节点的通用运行（如 FLY-2360）只能「缺证据」，这不是缺陷</li>
<li>设计文档指纹在生产 0/164 可得，「blob 未核」是边界不是免检</li>
</ul></div>
</div>
<p>设计评审：Codex R1（7 条）、R2（6 条）全部修进计划；R3 因 Codex 账号池全部撞额度未能跑。按工程 Lead 裁定改由 Gemini 独立评审一轮：<b>APPROVED</b>，3 条低级建议已吸收；两条残差（设计文档指纹缺失的降级、在飞文件交集超 200 条的既有上限）由 Lead 接受为诚实边界。实现阶段的代码评审会再对照本计划。</p>
""", "#1a365d")


def render_sections() -> str:
    out = []
    for sid, title, body, color in SECTIONS:
        out.append(f"""
<section class="card" id="{sid}" style="border-left-color:{color}">
  <h2>{escape(title)}</h2>
  {body}
  <div class="comment-box">
    <label for="c-{sid}">对这一节的意见（自动保存在本机浏览器）</label>
    <textarea id="c-{sid}" data-section="{sid}" data-title="{escape(title)}" rows="3" placeholder="写在这里…"></textarea>
  </div>
</section>""")
    return "\n".join(out)


HTML = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-2560 机器试判：三项各绑证据 · 设计</title>
<style>
  :root {{ color-scheme: light; }}
  body {{ margin:0; background:#f5f5f7; color:#1d1d1f; font-family:-apple-system,system-ui,"PingFang SC","Helvetica Neue",sans-serif; line-height:1.55; }}
  .wrap {{ max-width:960px; margin:0 auto; padding:24px 16px 64px; }}
  header {{ margin-bottom:20px; }}
  header h1 {{ font-size:24px; margin:0 0 6px; }}
  .meta {{ color:#86868b; font-size:13px; }}
  .meta a {{ color:#007aff; text-decoration:none; }}
  .issue-id {{ font-family:"SF Mono",Menlo,monospace; color:#1a365d; font-weight:600; }}
  .card {{ background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.06); padding:18px 20px; margin:14px 0; border-left:4px solid #007aff; }}
  .card h2 {{ font-size:18px; margin:0 0 10px; }}
  .lead {{ font-size:16px; }}
  .sub {{ font-weight:600; margin:10px 0 4px; color:#1a365d; }}
  .two {{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }}
  @media (max-width:640px) {{ .two {{ grid-template-columns:1fr; }} }}
  blockquote {{ margin:8px 0; padding:10px 14px; background:#fff7ec; border-left:3px solid #ff9500; border-radius:6px; }}
  pre {{ background:#f5f5f7; border-radius:8px; padding:12px; font-size:12.5px; white-space:pre-wrap; word-break:break-word; font-family:"SF Mono",Menlo,monospace; }}
  code {{ font-family:"SF Mono",Menlo,monospace; font-size:12.5px; background:#f0f0f2; padding:1px 4px; border-radius:4px; }}
  table {{ width:100%; border-collapse:collapse; font-size:14px; }}
  th,td {{ text-align:left; vertical-align:top; padding:8px 8px; border-bottom:1px solid #e5e5ea; }}
  th {{ color:#86868b; font-weight:600; font-size:13px; }}
  .diagram {{ overflow-x:auto; background:#fff; padding:6px 0; }}
  .diagram svg {{ max-width:100%; height:auto; }}
  .comment-box {{ margin-top:14px; border-top:1px dashed #e5e5ea; padding-top:10px; }}
  .comment-box label {{ display:block; font-size:12px; color:#86868b; margin-bottom:4px; }}
  textarea {{ width:100%; box-sizing:border-box; border:1px solid #d2d2d7; border-radius:8px; padding:8px; font:inherit; font-size:14px; resize:vertical; }}
  .summary pre {{ min-height:60px; }}
  button {{ background:#007aff; color:#fff; border:0; border-radius:8px; padding:8px 14px; font:inherit; cursor:pointer; }}
  button.secondary {{ background:#e5e5ea; color:#1d1d1f; }}
  .status {{ font-size:13px; color:#34c759; margin-left:8px; }}
  .chunk {{ margin-top:10px; }}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>机器试判：三项各绑机器证据，缺哪样写哪样</h1>
  <div class="meta"><span class="issue-id">{ISSUE}</span> · 设计文档 · 2026-09-14 · <a href="{escape(ISSUE_URL)}">Linear</a> · 状态：设计评审已收口（详见第 9 节）</div>
</header>

{render_sections()}

<section class="card summary" id="summary" style="border-left-color:#34c759">
  <h2>页面意见汇总</h2>
  <p class="meta">下面自动汇总你在每一节写的意见。点「复制全部意见」后贴回 Discord 即可；文本首行固定为 <code>【页面意见汇总】{ISSUE}</code>，这是修订反馈标记，不是通过信号。</p>
  <div id="chunks"></div>
  <div style="margin-top:10px">
    <button id="copy-all" type="button">复制全部意见</button>
    <button id="clear-all" type="button" class="secondary">清空本机草稿</button>
    <span id="copy-status" class="status"></span>
  </div>
</section>
</div>

<script nonce="__CSP_NONCE__">
(function () {{
  var ISSUE = {ISSUE!r};
  var MARKER = "【页面意见汇总】" + ISSUE;
  var PREFIX = "fly2560-comment:" + location.pathname + ":";
  var LIMIT = 1800;
  function lsGet(k) {{ try {{ return localStorage.getItem(k); }} catch (e) {{ return null; }} }}
  function lsSet(k, v) {{ try {{ localStorage.setItem(k, v); }} catch (e) {{}} }}
  function lsDel(k) {{ try {{ localStorage.removeItem(k); }} catch (e) {{}} }}
  var areas = Array.prototype.slice.call(document.querySelectorAll("textarea[data-section]"));
  function collect() {{
    var parts = [];
    areas.forEach(function (a) {{
      var v = (a.value || "").trim();
      if (v) parts.push("[" + a.getAttribute("data-title") + "] " + v);
    }});
    return parts;
  }}
  function chunk(parts) {{
    var chunks = [], cur = MARKER;
    parts.forEach(function (p) {{
      var next = cur + "\\n" + p;
      if (next.length > LIMIT && cur !== MARKER) {{ chunks.push(cur); cur = MARKER + "\\n" + p; }}
      else cur = next;
    }});
    chunks.push(cur);
    return chunks;
  }}
  var chunksEl = document.getElementById("chunks");
  function renderSummary() {{
    var parts = collect();
    while (chunksEl.firstChild) chunksEl.removeChild(chunksEl.firstChild);
    if (!parts.length) {{
      var empty = document.createElement("pre"); empty.textContent = MARKER + "\\n（还没有意见）"; chunksEl.appendChild(empty); return;
    }}
    chunk(parts).forEach(function (c, i, all) {{
      var box = document.createElement("div"); box.className = "chunk";
      if (all.length > 1) {{ var lab = document.createElement("div"); lab.className = "meta"; lab.textContent = "第 " + (i + 1) + " / " + all.length + " 段"; box.appendChild(lab); }}
      var pre = document.createElement("pre"); pre.textContent = c; box.appendChild(pre);
      if (all.length > 1) {{ var b = document.createElement("button"); b.type = "button"; b.className = "secondary"; b.textContent = "复制这一段"; b.addEventListener("click", function () {{ copyText(c); }}); box.appendChild(b); }}
      chunksEl.appendChild(box);
    }});
  }}
  var statusEl = document.getElementById("copy-status");
  function fallbackCopy(text) {{
    var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    var ok = false; try {{ ok = document.execCommand("copy"); }} catch (e) {{ ok = false; }}
    document.body.removeChild(ta); return ok;
  }}
  function copyText(text) {{
    var done = function (ok) {{ statusEl.textContent = ok ? "已复制" : "复制失败，请手动选中复制"; setTimeout(function () {{ statusEl.textContent = ""; }}, 2500); }};
    if (navigator.clipboard && navigator.clipboard.writeText) {{
      navigator.clipboard.writeText(text).then(function () {{ done(true); }}, function () {{ done(fallbackCopy(text)); }});
    }} else done(fallbackCopy(text));
  }}
  areas.forEach(function (a) {{
    var key = PREFIX + a.getAttribute("data-section");
    var saved = lsGet(key); if (saved) a.value = saved;
    a.addEventListener("input", function () {{ lsSet(key, a.value); renderSummary(); }});
  }});
  document.getElementById("copy-all").addEventListener("click", function () {{ copyText(chunk(collect()).join("\\n\\n")); }});
  document.getElementById("clear-all").addEventListener("click", function () {{
    areas.forEach(function (a) {{ a.value = ""; lsDel(PREFIX + a.getAttribute("data-section")); }}); renderSummary();
  }});
  renderSummary();
}})();
</script>
</body>
</html>
"""

(HERE / "founder-design.html").write_text(HTML, encoding="utf-8")
print("wrote founder-design.html", len(HTML.encode("utf-8")), "bytes")
