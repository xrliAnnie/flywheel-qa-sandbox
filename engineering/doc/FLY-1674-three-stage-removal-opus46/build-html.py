#!/usr/bin/env python3
"""Assemble the FLY-1674 founder design HTML with inlined mmdc SVGs."""
import pathlib

base = pathlib.Path(__file__).parent
svgs = {k: (base / "diagrams" / f"{k}.svg").read_text() for k in
        ["d1-incident", "d2-chain", "d3-boundary", "d4-deploy"]}

TPL = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-1674 三段式退役 · QA 换乘 Opus 4.6 — 设计方案</title>
<style>
  :root { --red:#ff3b30; --amber:#ff9500; --blue:#007aff; --green:#34c759; --gray:#86868b; --navy:#1a365d; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:#f5f5f7; color:#1d1d1f; font-family:-apple-system,system-ui,"PingFang SC",sans-serif; line-height:1.75; }
  .wrap { max-width:960px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:26px; color:var(--navy); margin-bottom:6px; }
  .meta { color:var(--gray); font-size:13px; margin-bottom:26px; }
  .meta a { color:var(--blue); text-decoration:none; }
  .badge { display:inline-block; font-size:12px; font-weight:600; padding:2px 10px; border-radius:10px; margin-left:6px; vertical-align:2px; }
  .badge.ok { background:#e8f7ec; color:#1e7e34; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.06); padding:24px 26px; margin-bottom:22px; border-left:4px solid var(--blue); }
  .card.red { border-left-color:var(--red); }
  .card.amber { border-left-color:var(--amber); }
  .card.green { border-left-color:var(--green); }
  .card.purple { border-left-color:#af52de; }
  .card h2 { font-size:19px; color:var(--navy); margin-bottom:12px; }
  .card h3 { font-size:15px; color:var(--navy); margin:16px 0 6px; }
  .card p, .card li { font-size:14.5px; }
  .card ul, .card ol { padding-left:22px; margin:8px 0; }
  .card li { margin:5px 0; }
  .lede { font-size:16px; }
  .diagram { overflow-x:auto; background:#fff; border:1px solid #eee; border-radius:8px; padding:10px; margin:14px 0; }
  .diagram svg { max-width:100%; height:auto; }
  code, .mono { font-family:"SF Mono",Menlo,monospace; font-size:.92em; background:#f2f2f4; border-radius:4px; padding:1px 5px; }
  table { border-collapse:collapse; width:100%; margin:10px 0; font-size:13.5px; }
  th, td { border:1px solid #e5e5ea; padding:7px 10px; text-align:left; vertical-align:top; }
  th { background:#fafafc; color:var(--navy); }
  .dim { color:var(--gray); }
  .warn { color:var(--amber); font-weight:600; }
  .crit { color:var(--red); font-weight:600; }
  .good { color:#1e7e34; font-weight:600; }
  .term { border-bottom:1px dotted var(--gray); }
  .cwrap { margin-top:18px; padding-top:14px; border-top:1px dashed #e5e5ea; }
  .cwrap label { font-size:12.5px; color:var(--gray); display:block; margin-bottom:6px; }
  textarea.cbox { width:100%; min-height:64px; border:1px solid #d2d2d7; border-radius:8px; padding:10px; font:inherit; font-size:13.5px; resize:vertical; background:#fbfbfd; }
  textarea.cbox:focus { outline:none; border-color:var(--blue); background:#fff; }
  #summary-list { white-space:pre-wrap; font-size:13.5px; background:#fbfbfd; border:1px solid #e5e5ea; border-radius:8px; padding:14px; min-height:40px; }
  #copy-btn { margin-top:12px; background:var(--blue); color:#fff; border:none; border-radius:8px; padding:9px 18px; font-size:14px; cursor:pointer; }
  #copy-btn:active { opacity:.7; }
  .num { font-size:22px; font-weight:700; color:var(--navy); }
</style>
</head>
<body>
<div class="wrap">
<h1>FLY-1674 · 三段式退役 + QA 换乘 Opus 4.6<span class="badge ok">Codex 设计评审 3 轮通过</span></h1>
<div class="meta">设计方案(design 节点交付) · 2026-08-12 · <a href="https://linear.app/geoforge3d/issue/FLY-1674">Linear FLY-1674</a> · 完整计划:<span class="mono">engineering/doc/FLY-1674-three-stage-removal-opus46/plan.md</span></div>

<div class="card green" data-title="一句话总结">
  <h2>一句话总结</h2>
  <p class="lede">把已经没人走的「三段式」旧流水线连代码带开关整体拆掉,让模型配置只剩一个能写的地方(<code>bindings</code>),同时拆掉上次让你被迫回滚的启动炸弹,然后真正把 QA 节点切到 Opus 4.6 —— 用一条真实 run 的三重证据验收,不看配置文件。</p>
  __CBOX(s0,一句话总结)__
</div>

<div class="card red" data-title="出了什么事">
  <h2>① 出了什么事:配置写进了废墟</h2>
  <p>你拍的「QA 节点用 Opus 4.6」被写进了<span class="term" title="三段式">三段式</span>(旧的设计→实现→QA 三连 session 流水线,FLY-793 时代的产物)的 <code>phases</code> 配置表。但现在所有活儿实际都走 <span class="term">DAG 工作流引擎</span>(新的"流程图"引擎:每个 issue 按模板生成设计/实现/QA 节点图,一格一格推进)—— 它读的是另一个位置 <code>bindings.opus</code>(=Opus 5)。结果:<span class="crit">配置写了,从未生效</span>,直到你追问才发现。</p>
  <div class="diagram">__D1__</div>
  <p>账面铁证:最近 6 条真实 run 的 QA 节点全部固化 <code>claude-opus-5[1m]</code>;三段式最后一次真正跑 QA 是 <b>7 月 29 日</b>,它的 turn 账本表已经是 <b>0 行</b>。旧路早死了,但它的配置面还活着能写 —— 这就是「省得你还会在那里搞错」要拆的东西。</p>
  __CBOX(s1,出了什么事)__
</div>

<div class="card amber" data-title="模型怎么真正生效">
  <h2>② 模型怎么真正生效 + 上次为什么炸</h2>
  <p>QA 节点用什么模型,由这条链决定(唯一的真路径):</p>
  <div class="diagram">__D2__</div>
  <p><b>上次(8-09)切 4.6 被迫回滚的原因</b>:菜单文件里声明了 <span class="term">xhigh</span>(思考力度档位之一;Opus 4.6 没有这一档,只有 low/medium/high/max)。菜单校验要求声明的档位表和模型真实支持的档位表<b>逐字相等</b>,不等就在 Bridge <span class="term">boot</span>(启动)时直接崩 —— 切了 4.6 之后下一次重启必炸,只能回滚。</p>
  <p><b>本方案的拆弹法</b>:把「逐字相等」放宽为「<b>子集</b>」—— 菜单声明的档位必须是模型支持档位的一部分(声明模型不支持的档照样拦),但不必列全。这样菜单声明 4 档,对 Opus 5(5 档)和 4.6(4 档)都合法,<span class="good">代码合入和配置切换谁先谁后都不会炸</span>。这很重要:PR 合入后到部署之间,自动部署车随时可能重启 Bridge,靠"操作顺序正确"保命是赌运气,结构上拆掉才是拆掉。</p>
  <p class="dim">复核中还发现:炸点不止 issue 里说的 1 个菜单文件,而是全部 5 个(generic/design/prd/prototype 的节点也都用 opus 档)。</p>
  __CBOX(s2,模型怎么生效与拆弹)__
</div>

<div class="card" data-title="删什么留什么">
  <h2>③ 删什么、留什么(50+ 文件逐一判定)</h2>
  <p>先诊断后删:两路并行盘点把每处三段式引用分了三类,<b>最重要的发现是「三段式的词汇是新引擎的地基」</b>—— design/implement/qa 这套角色、TURN 轮转机制、徽章显示,新引擎全在用,盲删会当场弄死现役系统。所以边界是:</p>
  <div class="diagram">__D3__</div>
  <ul>
    <li><b>净删除量级</b>:约 <span class="num">-4000</span> 行(编排器 2376 + 策略 339 + 影子桥 + 6 个开关 + 配置段 + 测试)。</li>
    <li><b>6 个 feature flag</b>(功能开关的环境变量)全部按既有「退役墓碑」规范删除:删定义 + 进墓碑名单(以后谁再设这个变量,系统会报错说"这是已退役的假开关,删掉这行")。其中 1 个开关推翻了 FLY-1456 当时"保持关"的裁决 —— 依据就是你 8-10 的删除直令,PR 里会写明。</li>
    <li><b>生产环境的 <code>.env</code> 里还躺着 2 行三段式开关</b>(都写的是默认值,纯垃圾),部署时一并清掉。</li>
  </ul>
  __CBOX(s3,删除边界)__
</div>

<div class="card purple" data-title="配置终态">
  <h2>④ 配置终态:只剩一个地方可写</h2>
  <table>
    <tr><th></th><th>现在(三个段,一个是废墟)</th><th>之后(废墟消失)</th></tr>
    <tr><td><code>bindings</code></td><td>opus → Opus 5</td><td class="good">opus → <b>Opus 4.6[1m]</b> ← 唯一的模型切换开关</td></tr>
    <tr><td><code>tiers</code></td><td>难度分档(Opus 5)</td><td>不动(你没拍这个,不越权)</td></tr>
    <tr><td><code>phases</code></td><td class="crit">废墟:写了不生效、坏值也只默默回落</td><td class="good">段删除、解析代码删除、概念消失</td></tr>
  </table>
  <p>切换的影响面(如实披露):<code>bindings.opus</code> 是全局 opus 档。切到 4.6 后,<b>5 类工作模板里所有用 opus 档的节点都换 4.6</b> —— 不止 code 模板的 QA 节点,还有 generic/PRD/design/prototype 模板的执行节点。这是 binding 这个词的本义,也和你 8-09 亲手切的那次影响面一致。若只想 QA 节点换,就得在菜单里写死具体型号 —— 那等于又造出第二个模型配置位置,与本单的根治方向相反,已否决。</p>
  <p class="dim">Lead 均不受影响(已逐个核对:7 个用 opus[1m] 档 —— 本次不动;其余用 fable/sonnet/codex;没有任何 Lead 用裸 opus 档)。</p>
  __CBOX(s4,配置终态与影响面)__
</div>

<div class="card" data-title="关键取舍">
  <h2>⑤ 关键取舍与被否决的方案</h2>
  <table>
    <tr><th>决策</th><th>选了</th><th>否决了(为什么)</th></tr>
    <tr><td>菜单 vs 4.6 档位冲突</td><td>菜单声明改 4 档 + 校验放宽为子集(纯减法)</td><td>派发层加"降级映射"(新增逻辑,违反「修复=净删除」;且已有 FLY-1650 的档位丢弃机制,加映射是重复建设)</td></tr>
    <tr><td>QA 档位落点</td><td>high(4.6 没有 xhigh;不擅自升 max)</td><td>max(那是显式升档,你没拍)</td></tr>
    <tr><td>切换方式</td><td>切 bindings(唯一可写位置)</td><td>菜单写死 4.6 型号(制造第二个配置位置,复制这次事故的土壤)</td></tr>
    <tr><td>三个"名字带三段式"的活机制</td><td>保留字符串、改说明文案</td><td>连名字一起改(turn 数据表改名要动数据库迁移、告警 kind 改名动 6 处+历史账本、标签改名动 Linear 存量 —— 风险全大于纯命名收益)</td></tr>
    <tr><td>QA 节点死亡后的恢复</td><td>删旧恢复器前,先用定向测试证明新引擎既有恢复链完整覆盖;<b>发现真缺口就停下修订计划</b></td><td>"边删边补"(在删除单里临场扩新恢复逻辑 = 失控)</td></tr>
  </table>
  __CBOX(s5,关键取舍)__
</div>

<div class="card amber" data-title="部署与验收">
  <h2>⑥ 部署与验收:真实 run 说了算</h2>
  <div class="diagram">__D4__</div>
  <ul>
    <li><b>验收全部是"实证"不是"配置"</b>:run 快照里 QA 节点固化的型号、派发审计账本行、QA session 进程命令行参数,三处都要看到 <code>claude-opus-4-6[1m]</code>;并且由独立 QA 验,不由实施者自证。</li>
    <li><b>重启一次不炸</b>就是炸弹拆除的阴性对照(上次的雷正是埋在重启里)。</li>
    <li><b>删干净的验收做成常驻测试</b>:一个进 CI 的残留扫描器,大小写不敏感全仓扫,豁免表精确到「文件+字符串」并且每项都有存在性断言 —— 豁免本身也不许腐烂。</li>
  </ul>
  __CBOX(s6,部署与验收)__
</div>

<div class="card green" data-title="诚实边界">
  <h2>⑦ 诚实边界:这个方案不做什么</h2>
  <ul>
    <li>不动 <code>tiers</code>(难度分档仍 Opus 5)和 <code>opus[1m]</code> 档(7 个 Lead 在用)—— 你只拍了 QA/bindings.opus。</li>
    <li>不给 Lead 用 4.6(FLY-1650 定的边界:4.6 只开 runner 侧)。</li>
    <li>三个活机制保留旧名字(turn 数据表 / no-three-stage 标签 / 2 个告警 kind)—— 机制是新引擎的,名字是旧的,注释里讲清楚;改名的风险大于收益。</li>
    <li>历史文档(含 product/doc 下 43 个含三段式字样的旧 PRD/研报)不删不改 —— 它们是历史记录,残留扫描器显式排除。</li>
    <li>一张已停写的旧对话表(phase_chat_threads)不在本单删,另立小单 —— 控制这次删除的爆炸半径。</li>
  </ul>
  __CBOX(s7,诚实边界)__
</div>

<div class="card" data-title="评论汇总">
  <h2>💬 你的批注汇总</h2>
  <p class="dim">在上面每个卡片底部的输入框留言,内容自动保存在你的浏览器里;这里实时汇总,可一键复制发给 Tadashi。</p>
  <div id="summary-list">(暂无批注)</div>
  <button id="copy-btn" type="button">复制全部批注</button>
</div>

</div>
<script nonce="__CSP_NONCE__">
(function () {
  "use strict";
  var PREFIX = "fly1674-comments:" + location.pathname + ":";
  var boxes = Array.prototype.slice.call(document.querySelectorAll("textarea.cbox"));
  var summary = document.getElementById("summary-list");
  var copyBtn = document.getElementById("copy-btn");

  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function collect() {
    var parts = [];
    boxes.forEach(function (ta) {
      var v = ta.value.trim();
      if (v) parts.push("【" + ta.getAttribute("data-sec-title") + "】\n" + v);
    });
    return parts.join("\n\n");
  }
  function refresh() {
    var text = collect();
    summary.textContent = text || "(暂无批注)";
  }
  boxes.forEach(function (ta) {
    ta.value = lsGet(PREFIX + ta.id);
    ta.addEventListener("input", function () {
      lsSet(PREFIX + ta.id, ta.value);
      refresh();
    });
  });
  refresh();

  function fallbackCopy(text) {
    var tmp = document.createElement("textarea");
    tmp.value = text;
    tmp.setAttribute("readonly", "");
    tmp.style.position = "fixed";
    tmp.style.left = "-9999px";
    document.body.appendChild(tmp);
    tmp.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(tmp);
  }
  copyBtn.addEventListener("click", function () {
    var text = collect() || "(暂无批注)";
    var done = function () {
      copyBtn.textContent = "已复制 ✓";
      setTimeout(function () { copyBtn.textContent = "复制全部批注"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  });
})();
</script>
</body>
</html>
"""

def cbox(sec_id: str, title: str) -> str:
    return ('<div class="cwrap"><label for="c-{sid}">给这一节留个批注(自动保存)</label>'
            '<textarea class="cbox" id="c-{sid}" data-sec-title="{t}" '
            'placeholder="想改哪里、疑问、拍板意见……"></textarea></div>').format(sid=sec_id, t=title)

html = TPL
for sid, title in [("s0", "一句话总结"), ("s1", "出了什么事"), ("s2", "模型怎么生效与拆弹"),
                   ("s3", "删除边界"), ("s4", "配置终态与影响面"), ("s5", "关键取舍"),
                   ("s6", "部署与验收"), ("s7", "诚实边界")]:
    html = html.replace("__CBOX({},{})__".format(sid, title), cbox(sid, title))
html = (html.replace("__D1__", svgs["d1-incident"])
            .replace("__D2__", svgs["d2-chain"])
            .replace("__D3__", svgs["d3-boundary"])
            .replace("__D4__", svgs["d4-deploy"]))

out = base / "design-review.html"
out.write_text(html)
assert "__CBOX" not in html and "__D1__" not in html, "unreplaced placeholder"
assert html.count('<script nonce="__CSP_NONCE__">') == 1
assert "onclick=" not in html
print(f"wrote {out} ({len(html)} bytes)")
