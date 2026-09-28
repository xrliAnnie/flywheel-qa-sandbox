#!/usr/bin/env python3
"""Build founder-design.html for FLY-2984 from the rendered Mermaid SVGs."""
import html
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
ISSUE = "FLY-2984"
ISSUE_URL = "https://linear.app/geoforge3d/issue/FLY-2984/qa-sbx-fly-2925-n-to-n-synthetic-runner-lifecycle-task"
e = html.escape


def svg(name: str, max_px: int = 0) -> str:
    raw = (HERE / f"{name}.svg").read_text(encoding="utf-8")
    raw = re.sub(r"^<\?xml[^>]*>\s*", "", raw)
    style = f' style="max-width:{max_px}px;margin:12px auto"' if max_px else ""
    return f'<div class="diagram"{style}>{raw}</div>'


PARAS = [
    ("第 1 步 · runner 做什么", "A runner is a single worker session that Flywheel starts for one node of a workflow. It receives a bounded task, writes to the shared git worktree only while it holds the TURN, reports its stage and progress to the Bridge, and asks its Lead through flywheel-comm whenever it needs a decision it cannot make alone."),
    ("第 2 步 · 重启时发生什么", "When a runner is restarted, it does not start over. It resumes as the same execution rather than a fresh one: it re-checks that it still holds the TURN, reads the progress ledger committed on the branch, and inspects the files themselves to see which steps are already done; finished work that was committed and pushed stays in place, and the runner continues from the first unfinished step instead of redoing or rolling back earlier ones."),
    ("第 3 步 · 如何交卷", "Work is handed in through the normal flow: the runner commits and pushes its changes to the issue branch, reports the result to its Lead with a structured flywheel-comm receipt, and then runs flywheel-comm complete with its node's route. It never merges, deploys, or dispatches the next node; the workflow orchestrator decides what happens next."),
]

sections = []


def section(sid: str, color: str, title: str, body: str) -> None:
    sections.append((sid, title, f'''
<section class="card {color}" data-section="{e(sid)}" data-title="{e(title)}">
  <h2>{e(title)}</h2>
  {body}
  <label class="cmt-label" for="c-{e(sid)}">你的意见（自动保存在本浏览器）</label>
  <textarea class="cmt" id="c-{e(sid)}" data-key="{e(sid)}" rows="3" placeholder="对这一节有什么想法？"></textarea>
</section>'''))


section("summary", "blue", "一句话总结", f'''
<p class="lead-text">实现者把 <code>qa-sandbox/fly2925-n2n.md</code> 分三步写成「一个标题 + 三段英文」，每写一段就单独提交并推送一次；
每一步开始前都先看文件实际写到哪了，所以就算中途被重启，也只会从没做完的那一步接着做，不会重复写、不会回退、不会碰别的文件。</p>
<div class="gloss">
<p><b>runner</b>：Flywheel 为某个任务节点启动的一个 AI 工作会话，相当于一名只负责这一小块活的工程师。</p>
<p><b>提交（commit）/ 推送（push）</b>：提交是把改动存成本地的一个版本快照；推送是把这些快照上传到 GitHub 上的分支，别人才看得见。</p>
<p><b>为什么要三步三推</b>：这是 FLY-2925 在 529 测试房做的「中途重启」端到端测试，每次推送都是一个可观察的检查点——重启后如果重复写或漏写，git 历史里一眼就能看出来。</p>
</div>''')

section("flow", "green", "核心流程：每一步都先看再做", f'''
<p>下图是实现者每次启动（包括被重启后）都会走的同一条路。每个菱形都是「先检查、已完成就跳过」——这就是<b>幂等</b>：同一件事做一次和做十次，结果一样。</p>
<p class="dim"><b>TURN</b>：共享工作目录的「写入令牌」，同一时刻只有持有它的 runner 能改文件，避免两个 runner 互相覆盖。<b>进度账本</b>：分支上的 <code>progress.md</code>，记录「做到第几步」，供重启后参考。</p>
{svg("core-flow")}''')

rows = "".join(f"<tr><td>{e(t)}</td><td class='en'>{e(p)}</td></tr>" for t, p in PARAS)
section("model", "purple", "数据 / 结构模型：文件只有 5 种状态", f'''
<p>文件内容是唯一的「权威」。它只可能处在下面 5 种状态之一；任何对不上的内容都被判为 X，实现者会停下来问 Lead，绝不覆盖。</p>
{svg("state-model", 520)}
<p>判断「下一步该干什么」时，实现者分别看四个信号，互不替代：</p>
<table>
<tr><th>信号</th><th>回答的问题</th><th>决定什么</th></tr>
<tr><td>工作区文件</td><td>文件现在写到第几段？</td><td>要不要追加这一段</td></tr>
<tr><td>已提交版本（HEAD）</td><td>已存成快照的写到第几段？</td><td>要不要提交</td></tr>
<tr><td>进度账本</td><td>账上记到第几步？</td><td>要不要记账（只前进、不回退）</td></tr>
<tr><td>远端分支</td><td>GitHub 上是不是最新？</td><td>要不要推送（只做普通快进）</td></tr>
</table>
<p class="dim"><b>快进（fast-forward）推送</b>：只在远端历史后面追加新版本，不改写已有历史；与之相对的「强推」会覆盖别人的历史，本设计禁止。</p>
<h3>重启恢复举例</h3>
{svg("restart-seq")}
<h3>最终文件的三段内容（逐字）</h3>
<table class="paras"><tr><th>步骤</th><th>段落</th></tr>{rows}</table>''')

section("tradeoffs", "amber", "关键取舍与放弃的方案", '''
<table>
<tr><th>方案</th><th>结论</th><th>原因</th></tr>
<tr><td>以<b>文件内容</b>判断进度</td><td class="ok">采用</td><td>文件是交付物本身，离线可查，最不会说谎</td></tr>
<tr><td>只看进度账本判断进度</td><td class="no">放弃</td><td>「写完文件、还没记账」时被杀，账本会落后于实际</td></tr>
<tr><td>只看提交信息判断进度</td><td class="no">放弃</td><td>中间夹着账本的提交，且提交信息不代表文件内容</td></tr>
<tr><td>把分支重新对齐到 main</td><td class="no">不做</td><td>工作目录绑定已锁定，且是多个节点共享的分支；已向 Lead 提非阻塞问题</td></tr>
<tr><td>按角色惯例加里程碑文件</td><td class="no">默认不加</td><td>issue 明说「不改任何其他文件」，比通用惯例更具体；需 Lead 明确要求才加</td></tr>
<tr><td>设计阶段直接写三段</td><td class="no">不做</td><td>设计节点只出方案；写文件是实现节点的活，否则测试就观察不到实现者的重启行为</td></tr>
</table>
<p class="dim">设计阶段在隔离的临时仓库里把方案脚本真跑了一遍（含 6 种中途被杀 / 异常场景），第一版就被抓出一个「重跑第 1 步会把第 2 步内容误提交」的错误，已修正。</p>''')

section("boundary", "red", "诚实边界：做什么、不做什么", '''
<div class="two">
<div><h3>这份设计做到</h3><ul>
<li>给出逐字的最终文件内容和可照抄执行的步骤</li>
<li>任何时刻被重启都能续跑，不重复、不回退</li>
<li>每次提交前机器断言只动了这一个文件</li>
<li>5 条最终验收（内容、提交数、改动范围、远端一致、提交信息）</li>
</ul></div>
<div><h3>这份设计不做</h3><ul>
<li>不写 <code>qa-sandbox/fly2925-n2n.md</code> 本身（留给实现节点）</li>
<li>不改任何代码、配置、测试</li>
<li>不合并、不部署、不决定下一个节点</li>
<li>不决定 PR 的目标分支（交 Lead 决定）</li>
</ul></div>
</div>
<p class="warn"><b>评审状态（如实）</b>：Codex 设计评审（一个独立 AI 审稿人）第 1 轮中途因全部账号额度用尽而中断，没有给出通过/不通过的结论；它中断前指出的 3 处问题已全部修正。设计评审门尚未通过，已请 Lead 裁定后续走法。</p>''')

body = "".join(s[2] for s in sections)

page = f'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(ISSUE)} 设计 · runner 生命周期说明</title>
<style>
:root {{ --bg:#f5f5f7; --fg:#1d1d1f; --dim:#86868b; --card:#fff; --navy:#1a365d; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font-family:-apple-system,system-ui,sans-serif; line-height:1.6; }}
main {{ max-width:960px; margin:0 auto; padding:32px 16px 64px; }}
header h1 {{ color:var(--navy); margin:0 0 4px; font-size:26px; }}
header .meta {{ color:var(--dim); font-size:14px; }}
header a, .issue-id {{ font-family:'SF Mono',monospace; color:var(--navy); }}
.card {{ background:var(--card); border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.06); padding:20px 22px; margin:20px 0; border-left:4px solid #86868b; }}
.card.blue {{ border-left-color:#007aff; }} .card.green {{ border-left-color:#34c759; }} .card.purple {{ border-left-color:#af52de; }}
.card.amber {{ border-left-color:#ff9500; }} .card.red {{ border-left-color:#ff3b30; }} .card.navy {{ border-left-color:#1a365d; }}
h2 {{ margin:0 0 12px; font-size:20px; color:var(--navy); }} h3 {{ font-size:16px; margin:18px 0 8px; }}
.lead-text {{ font-size:17px; }}
.gloss p, .dim {{ color:#515154; font-size:14px; }}
code {{ font-family:'SF Mono',monospace; font-size:13px; background:#f0f0f3; padding:1px 5px; border-radius:4px; }}
table {{ width:100%; border-collapse:collapse; font-size:14px; margin:8px 0; }}
th, td {{ text-align:left; padding:8px; border-bottom:1px solid #e5e5ea; vertical-align:top; }}
th {{ color:var(--dim); font-weight:600; }}
td.en {{ font-size:13px; color:#333; }}
td.ok {{ color:#248a3d; font-weight:600; }} td.no {{ color:#c9342a; font-weight:600; }}
.diagram {{ overflow-x:auto; margin:12px 0; text-align:center; }}
.diagram svg {{ max-width:100% !important; height:auto; }}
td, code {{ overflow-wrap:anywhere; }}
.two {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }}
@media (max-width:640px) {{ .two {{ grid-template-columns:1fr; }} }}
.warn {{ background:#fff4e5; border-radius:8px; padding:10px 12px; font-size:14px; }}
.cmt-label {{ display:block; margin-top:16px; font-size:13px; color:var(--dim); }}
.cmt {{ width:100%; border:1px solid #d2d2d7; border-radius:8px; padding:8px; font:inherit; font-size:14px; resize:vertical; }}
#summary-out {{ white-space:pre-wrap; overflow-wrap:anywhere; font-family:'SF Mono',monospace; font-size:13px; background:#f5f5f7; border-radius:8px; padding:12px; min-height:48px; }}
.chunk {{ margin-top:10px; }}
button {{ background:#007aff; color:#fff; border:0; border-radius:8px; padding:8px 14px; font:inherit; font-size:14px; cursor:pointer; margin:8px 8px 0 0; }}
#copy-status {{ color:var(--dim); font-size:13px; }}
</style>
</head>
<body>
<main>
<header>
  <h1>runner 生命周期说明文件 · 设计</h1>
  <div class="meta"><a class="issue-id" href="{e(ISSUE_URL)}">{e(ISSUE)}</a> · QA 沙箱合成单（FLY-2925 N-to-N 测试）· 2026-09-27 · 设计节点产出，未实现</div>
</header>
{body}
<section class="card navy" id="summary-card">
  <h2>页面意见汇总</h2>
  <p class="dim">自动汇总上面各节的非空意见。复制后贴回给 Lead；这是修改意见，不代表通过。超过约 1800 字会分段，每段都带标记。</p>
  <div id="summary-out"></div>
  <div id="chunks"></div>
  <button type="button" id="copy-all">复制全部意见</button><span id="copy-status"></span>
</section>
</main>
<script nonce="__CSP_NONCE__">
(function () {{
  var MARK = "【页面意见汇总】{ISSUE}";
  var PREFIX = "fw-comments:" + location.pathname + ":";
  var LIMIT = 1800;
  function load(k) {{ try {{ return localStorage.getItem(PREFIX + k) || ""; }} catch (err) {{ return ""; }} }}
  function save(k, v) {{ try {{ localStorage.setItem(PREFIX + k, v); }} catch (err) {{}} }}
  var boxes = Array.prototype.slice.call(document.querySelectorAll("textarea.cmt"));
  function titleOf(box) {{ var s = box.closest("section"); return s ? s.getAttribute("data-title") : ""; }}
  function entries() {{
    var out = [];
    boxes.forEach(function (b) {{ var v = b.value.trim(); if (v) out.push("【" + titleOf(b) + "】\\n" + v); }});
    return out;
  }}
  function chunks() {{
    var list = entries(), res = [], cur = MARK;
    list.forEach(function (item) {{
      var next = cur + "\\n\\n" + item;
      if (next.length > LIMIT && cur !== MARK) {{ res.push(cur); cur = MARK + "\\n\\n" + item; }}
      else {{ cur = next; }}
    }});
    if (list.length) res.push(cur);
    return res;
  }}
  function copyText(text) {{
    function fallback() {{
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = false; try {{ ok = document.execCommand("copy"); }} catch (err) {{ ok = false; }}
      document.body.removeChild(ta); return ok;
    }}
    var status = document.getElementById("copy-status");
    function done(ok) {{ status.textContent = ok ? " 已复制" : " 复制失败，请手动选择文本"; }}
    if (navigator.clipboard && navigator.clipboard.writeText) {{
      navigator.clipboard.writeText(text).then(function () {{ done(true); }}, function () {{ done(fallback()); }});
    }} else {{ done(fallback()); }}
  }}
  function render() {{
    var parts = chunks();
    var out = document.getElementById("summary-out");
    var holder = document.getElementById("chunks");
    out.textContent = parts.length ? parts.join("\\n\\n") : "（还没有意见）";
    while (holder.firstChild) holder.removeChild(holder.firstChild);
    if (parts.length > 1) {{
      parts.forEach(function (p, i) {{
        var d = document.createElement("div"); d.className = "chunk";
        var btn = document.createElement("button"); btn.type = "button";
        btn.textContent = "复制第 " + (i + 1) + " / " + parts.length + " 段";
        btn.addEventListener("click", function () {{ copyText(p); }});
        d.appendChild(btn); holder.appendChild(d);
      }});
    }}
  }}
  boxes.forEach(function (b) {{
    var k = b.getAttribute("data-key");
    b.value = load(k);
    b.addEventListener("input", function () {{ save(k, b.value); render(); }});
  }});
  document.getElementById("copy-all").addEventListener("click", function () {{
    var parts = chunks(); copyText(parts.length ? parts.join("\\n\\n") : MARK);
  }});
  render();
}})();
</script>
</body>
</html>
'''
(HERE / "founder-design.html").write_text(page, encoding="utf-8")
print("wrote", HERE / "founder-design.html", len(page))
