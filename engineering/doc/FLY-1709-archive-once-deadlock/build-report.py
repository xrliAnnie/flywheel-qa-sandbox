#!/usr/bin/env python3
"""Build the FLY-1709 founder design HTML with inlined build-time SVGs."""
import pathlib

d = pathlib.Path(__file__).parent
svgs = {f"D{i}": (d / n).read_text() for i, n in
        ((1, "d1-bug-chain.svg"), (2, "d2-decision-flow.svg"), (3, "d3-lifecycle.svg"))}

HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-1709 设计:归档死角修复</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#f5f5f7; color:#1d1d1f; font-family:-apple-system,system-ui,"PingFang SC","Hiragino Sans GB",sans-serif; line-height:1.75; padding:24px 16px 80px; }
  .wrap { max-width:960px; margin:0 auto; }
  h1 { font-size:26px; margin:8px 0 4px; color:#1a365d; }
  .sub { color:#86868b; font-size:14px; margin-bottom:24px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.06); padding:20px 22px; margin-bottom:20px; border-left:4px solid #007aff; }
  .card.red { border-left-color:#ff3b30; }
  .card.green { border-left-color:#34c759; }
  .card.amber { border-left-color:#ff9500; }
  .card.purple { border-left-color:#af52de; }
  .card.gray { border-left-color:#86868b; }
  h2 { font-size:19px; color:#1a365d; margin-bottom:10px; }
  h3 { font-size:15px; color:#1a365d; margin:14px 0 6px; }
  p, li { font-size:15px; }
  ul, ol { padding-left:22px; margin:8px 0; }
  li { margin:4px 0; }
  code { font-family:"SF Mono",Menlo,monospace; font-size:13px; background:#f0f0f2; border-radius:4px; padding:1px 5px; }
  .term { color:#af52de; font-weight:600; }
  .diagram { overflow-x:auto; background:#fff; margin:12px 0; text-align:center; }
  .diagram svg { max-width:100%; height:auto; }
  table { border-collapse:collapse; width:100%; margin:10px 0; font-size:14px; }
  th, td { border:1px solid #e5e5ea; padding:7px 10px; text-align:left; vertical-align:top; }
  th { background:#f5f5f7; color:#1a365d; }
  .badge { display:inline-block; font-size:12px; font-weight:600; border-radius:6px; padding:1px 8px; margin-right:6px; }
  .badge.ok { background:#e6f9ec; color:#1d7a3d; }
  .badge.no { background:#ffe5e3; color:#c1271d; }
  .badge.info { background:#e8f1ff; color:#0a5ad4; }
  .comment-block { margin-top:16px; border-top:1px dashed #e5e5ea; padding-top:10px; }
  .comment-block label { font-size:13px; color:#86868b; display:block; margin-bottom:6px; }
  .comment-block textarea { width:100%; min-height:64px; border:1px solid #d2d2d7; border-radius:8px; padding:8px 10px; font-size:14px; font-family:inherit; resize:vertical; background:#fbfbfd; }
  .comment-block textarea:focus { outline:none; border-color:#007aff; }
  #summary-list { margin-top:8px; }
  .sum-item { background:#fbfbfd; border:1px solid #e5e5ea; border-radius:8px; padding:8px 12px; margin:6px 0; font-size:14px; white-space:pre-wrap; }
  .sum-title { font-weight:600; color:#1a365d; }
  #copy-btn { margin-top:12px; background:#007aff; color:#fff; border:none; border-radius:8px; padding:9px 18px; font-size:14px; font-weight:600; cursor:pointer; }
  #copy-btn:active { opacity:.8; }
  #copy-status { margin-left:10px; font-size:13px; color:#34c759; }
  .empty-hint { color:#86868b; font-size:14px; }
</style>
</head>
<body>
<div class="wrap">
<h1>FLY-1709 设计:归档死角修复</h1>
<div class="sub">设计文档(实施前)· 2026-08-12 · Codex 设计评审 6 轮通过 · 完整计划在仓库 engineering/doc/FLY-1709-archive-once-deadlock/plan.md</div>
"""

S1 = """
<div class="card green" data-section="一句话总结">
<h2>① 一句话总结</h2>
<p>修一个让 Discord 讨论串「永远关不上、还谎报已关上」的死角:以后系统关闭讨论串前先看 Discord 的真实状态、分清是谁把它弄开的——bot(机器人程序,系统里的自动角色)弄开的就安安静静重新关上,你亲手打开的绝不去抢;所有返回值只说真话;自动状态贴不再往已收起的讨论串里发消息;账面清理的收尾也不再被错标成「受阻」吓到你。</p>
COMMENT
</div>
"""

S2 = """
<div class="card red" data-section="问题:死角怎么形成">
<h2>② 问题:死角是怎么形成的</h2>
<p>这里的 <span class="term">thread</span>(Discord 频道下每个 issue 的子讨论串)做完收尾后会被<span class="term">归档</span>(archive,把讨论串收起、从侧栏消失)。8-11 晚上你连撞两批案例:讨论串明明开着,但谁都关不上——接口一直说「已归档」。</p>
<div class="diagram">D1SVG</div>
<p>链条上有四个独立的毛病,叠在一起才成为死角:</p>
<table>
<tr><th>#</th><th>毛病</th><th>后果</th></tr>
<tr><td>①</td><td>「归档过一次就不再归档」的守卫分不清<b>是谁重开的</b>。这个守卫本意是保护你:你手动重开的讨论串,系统不该跟你抢着关。但 bot 自己发消息弄开的,也享受了同样的保护</td><td>bot 弄开的讨论串永远关不上</td></tr>
<tr><td>②</td><td>「什么都没做」的返回值伪装成「已完成」(archived:true)</td><td>agent 拿着假成功向你汇报了不准的话</td></tr>
<tr><td>③</td><td>自动状态贴(把 issue 进度同步到讨论串标题/置顶的程序)发消息前不看归档状态</td><td>已收官、你亲自下令归档的讨论串被它弹开(FLY-1680 当晚实况)</td></tr>
<tr><td>④</td><td>run(一次派工执行)被账面清理时标成 terminated,显示层一律渲染成「🔴受阻」</td><td>PR 早已合入的收官 issue 显示成受阻,误导你追问</td></tr>
</table>
COMMENT
</div>
"""

S3 = """
<div class="card green" data-section="修复:归档决策收口">
<h2>③ 修复核心:归档决策全部收口到一处,只说真话</h2>
<p>所有归档入口(手动接口、收工自动归档、定期清扫)本来就路过同一个<span class="term">收口</span>(代码里唯一真正执行归档的函数)。修复把「分辨谁重开的」放进这个收口:</p>
<div class="diagram">D2SVG</div>
<ul>
<li><b>先问 Discord 真实状态</b>,不再只信自己账本。真关着 → 如实说「已归档」;被弄开了 → 才进入分辨。</li>
<li><b>分辨规则(比 issue 原文更保守)</b>:归档之后只要有<b>任何一条人类发言</b>,就不抢——不只是看「最后一条是谁」。因为你重开聊了几句后,bot 若又回了一条,按「看最后一条」就会当着你的面把讨论串关掉。</li>
<li><b>重新关上前后各做一次「静窗核验」</b>(确认这段时间没有人插话、且确实关上了);中途你插了话 → 立刻撤销这次关闭。任何拿不准 → 宁可让讨论串开着。</li>
<li><b>返回值合同</b>:archived:true 只在 Discord 侧验证过时出现;「不抢」「有活跃 run 在用」「没看清」各有自己的诚实标签,下游各消费方(收尾流程、定期清扫)也逐一改成正确理解这些标签,不会把「按设计不抢」当成失败无限重试。</li>
</ul>
COMMENT
</div>
"""

S4 = """
<div class="card purple" data-section="生命周期与数据模型">
<h2>④ 生命周期与数据模型</h2>
<p>讨论串的一生用「<span class="term">归档周期</span>」(epoch,从一次归档到下一次活跃之间的时间段)来记账:</p>
<div class="diagram">D3SVG</div>
<h3>动到的数据(刻意最小)</h3>
<table>
<tr><th>数据</th><th>变化</th><th>为什么</th></tr>
<tr><td><code>archived_at</code>(归档时刻,已有字段)</td><td>精度从秒升到毫秒;重新关上会刷新;新 run 启动时清空(reactivation,讨论串回到活跃生命周期)</td><td>它就是「归档周期」的边界,用来判定发言/新工作属于哪个周期</td></tr>
<tr><td><code>reopen_compensation_pending</code>(新增一列,可空)</td><td>重新关上前先写一张「欠条」(receipt):万一关的过程中你插了话、或程序中途崩溃,重启后凭这张欠条把讨论串恢复打开,直到验证确实打开才销掉</td><td>没有它,崩溃后系统会把你的话埋在一个再也没人看的归档讨论串里。这是唯一的表结构改动(一列,不是新表)</td></tr>
</table>
<h3>判「有活跃 run 在用」的规则</h3>
<p>不看状态行「存在不存在」——系统里有些早就死掉的残行(husk)会永远躺在「活跃」状态上,看存在性会把死角原样复活。规则是:刚派进来的新工作给一个短暂宽限期,其余一律<b>现场探测进程是否真活着</b>:活的保护,死壳不挡路。</p>
COMMENT
</div>
"""

S5 = """
<div class="card amber" data-section="四个修点明细">
<h2>⑤ 四个修点落到哪里</h2>
<table>
<tr><th>修点</th><th>位置</th><th>一句话</th></tr>
<tr><td>A · 收口守卫</td><td>done-thread-archiver.ts</td><td>分辨重开者 + 静窗核验 + 欠条协议,全在既有的按讨论串排队的锁里</td></tr>
<tr><td>B · 返回诚实</td><td>tools.ts 归档接口</td><td>删掉「看账本就直接回 archived:true」的短路,收口的结果原样透传</td></tr>
<tr><td>C · 状态贴闸门</td><td>issue-display-refresher.ts 等 4 处写手</td><td>讨论串已归档 → 一个字都不写(统一刷新器 + 3 个旧路径写手全覆盖);新 run 启动时清账本恢复显示</td></tr>
<tr><td>D · 终态映射</td><td>issue-display.ts</td><td>terminated(被终止)且 issue 有耐久收官证据(PR 合入记录/完成的 session)→ 显示 ✅ 而不是 🔴受阻;真失败/真受阻一个不改</td></tr>
</table>
<p>部署面:纯 Bridge(中枢服务)侧,合入后重启一次 Bridge 即生效,不动 Lead/Runner。回滚 = 一次 revert + 重启(新增列保留,回滚前先把未销的欠条逐个处理掉,已写进回滚手册)。</p>
COMMENT
</div>
"""

S6 = """
<div class="card gray" data-section="关键取舍与被否方案">
<h2>⑥ 关键取舍与被否掉的方案</h2>
<table>
<tr><th>决策</th><th>选了</th><th>否了</th><th>为什么</th></tr>
<tr><td>「谁重开的」判定</td><td>归档后<b>存在任何人类发言</b>就不抢</td><td>issue 原文的「看最后一条发言者」</td><td>后者会在「你重开聊天、bot 又回了一条」时当面关掉你的讨论串;两案对全部实证案例判定一致,只会更保守(评审认可)</td></tr>
<tr><td>状态贴撞上归档讨论串</td><td>一个字不写(静默)</td><td>「改发到主频道」</td><td>收官 issue 的状态噪音换个地方还是打扰;信息 Linear 本来就有</td></tr>
<tr><td>bot 弄开后的自动收敛</td><td>靠下一次归档动作(agent 发完就调归档/收工/清扫/手动)</td><td>加后台巡逻扫所有归档过的讨论串</td><td>巡逻要对全部历史讨论串反复请求 Discord,无界增长;实证序列正是「发完最后一条 → 调归档」,修好接口即收敛</td></tr>
<tr><td>关闭中途你插话的极小窗口</td><td>关后复核 + 立即撤销(补偿),欠条保证崩溃后也会恢复</td><td>「窗口很小,忍了」(我方初版)</td><td>评审证伪了「会自愈」:一旦关上,后续调用只会看到「已归档」直接短路,你的话就被埋了——这不可接受</td></tr>
<tr><td>手动归档接口要不要加「有活跃状态行就拒绝」</td><td>不加(保持逃生口)</td><td>评审初版建议加</td><td>死掉的残行永远「活跃」,加了它,卡死的讨论串又关不上了——恰是本单要消灭的死角(评审复议后认可)</td></tr>
</table>
COMMENT
</div>
"""

S7 = """
<div class="card red" data-section="诚实边界">
<h2>⑦ 诚实边界:这个设计不做什么</h2>
<ul>
<li>你参与过的重开讨论串(本周期内有你的发言)<b>永远不会被自动关</b>——要么你自己关,要么 Lead 在下个周期处理。这是「不抢」语义的刻意延伸。</li>
<li>bot 弄开的讨论串没有后台巡逻兜底——收敛依赖下一次归档动作。若某个讨论串弄开后再没有任何归档触发,它会一直开着,但接口现在<b>能</b>关它(死角消失,需要一次调用)。</li>
<li>没有耐久收官证据的 issue,terminated 仍显示 🔴受阻——宁可红,不假绿。</li>
<li>Lead 主动发消息(转达、提问、给你的通知)不设归档闸——把讨论串弄开是 Discord「重新使用」的正常语义。</li>
<li>探测进程活性持续出错的残行会以「in_active_use + 具体 run 身份」的形式挡住重新关闭——响亮可见,操作员按既有流程收掉残行即可,不是无声死角。</li>
</ul>
COMMENT
</div>
"""

S8 = """
<div class="card" data-section="评审过程">
<h2>⑧ 设计评审过程(Codex,6 轮)</h2>
<p>逐轮把守卫从「一个 if」打磨成了带崩溃恢复的完整合同:</p>
<ul>
<li><b>R1(6 项)</b>:清账挂错位置、新标签会卡死收尾流程、漏了第 3 个状态写手、并发窗、Discord 翻页、审计事件 id 撞车。</li>
<li><b>R2(5 项)</b>:清账权威点收窄到「run 真正启动」;评审证伪我方「窗口会自愈」的论断 → 引入关后复核+撤销。我方顶回「手动接口加活跃拒绝」(会杀逃生口),评审认可。</li>
<li><b>R3(5 项)</b>:「看状态行存在性」会用我方自己的残行论据反噬 → 改按周期绑定;重放/合并会误清、漏清 → 改可重算判定;补偿失败后「可重试」是谎言 → 引入耐久欠条。</li>
<li><b>R4(5 项)</b>:欠条必须<b>先写后做</b>(write-ahead),否则崩溃窗保不住你;启动判定要经得起重试;秒/毫秒精度混用会误判同秒边界。</li>
<li><b>R5(5 项)</b>:归档请求失败不等于没生效,欠条不能清;started_at 会被重放覆盖 → 局部 set-once;「新周期无条件算活跃」会把死角推迟到新周期 → 一切最终看真实进程活性。</li>
<li><b>R6:APPROVED</b>,附 4 条非阻塞实现备注(已全部折入计划)。</li>
</ul>
<p class="empty-hint">完整往返与每条的采纳/顶回理由:plan.md §9。</p>
COMMENT
</div>
"""

SUMMARY = """
<div class="card info" id="summary-card" data-nocomment="1">
<h2>💬 你的批注汇总</h2>
<p class="empty-hint">在上面任何一节下方留言,这里会实时汇总;「复制全部批注」可以一键拷走发给 Tadashi。</p>
<div id="summary-list"></div>
<button id="copy-btn" type="button">复制全部批注</button><span id="copy-status"></span>
</div>
</div>
"""

SCRIPT = """<script nonce="__CSP_NONCE__">
(function () {
  "use strict";
  var PREFIX = "fly1709-comment:" + location.pathname + ":";
  function lsGet(k) { try { return localStorage.getItem(PREFIX + k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch (e) {} }

  var cards = Array.prototype.slice.call(document.querySelectorAll(".card[data-section]"));
  var entries = [];

  cards.forEach(function (card) {
    var title = card.getAttribute("data-section") || "";
    var block = card.querySelector(".comment-block textarea");
    if (!block) return;
    block.value = lsGet(title);
    block.addEventListener("input", function () {
      lsSet(title, block.value);
      renderSummary();
    });
    entries.push({ title: title, box: block });
  });

  var list = document.getElementById("summary-list");
  function renderSummary() {
    while (list.firstChild) list.removeChild(list.firstChild);
    entries.forEach(function (e) {
      var v = e.box.value.trim();
      if (!v) return;
      var item = document.createElement("div");
      item.className = "sum-item";
      var t = document.createElement("div");
      t.className = "sum-title";
      t.textContent = "【" + e.title + "】";
      var body = document.createElement("div");
      body.textContent = v;
      item.appendChild(t);
      item.appendChild(body);
      list.appendChild(item);
    });
  }
  renderSummary();

  function aggregateText() {
    var parts = [];
    entries.forEach(function (e) {
      var v = e.box.value.trim();
      if (v) parts.push("【" + e.title + "】\\n" + v);
    });
    return parts.join("\\n\\n");
  }

  var btn = document.getElementById("copy-btn");
  var status = document.getElementById("copy-status");
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    status.textContent = ok ? "已复制 ✓" : "复制失败,请手动选择文本";
  }
  btn.addEventListener("click", function () {
    var text = aggregateText();
    if (!text) { status.textContent = "还没有批注"; return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        status.textContent = "已复制 ✓";
      }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
    setTimeout(function () { status.textContent = ""; }, 4000);
  });
})();
</script>
</body>
</html>
"""

COMMENT_HTML = """<div class="comment-block"><label>给这一节留个批注(自动保存在本机浏览器):</label><textarea placeholder="想改哪里、疑问、拍板意见……"></textarea></div>"""

sections = [S1, S2, S3, S4, S5, S6, S7, S8]
body = "".join(s.replace("COMMENT", COMMENT_HTML) for s in sections)
body = body.replace("D1SVG", svgs["D1"]).replace("D2SVG", svgs["D2"]).replace("D3SVG", svgs["D3"])

html = HEAD + body + SUMMARY + SCRIPT
out = d / "FLY-1709-design-report.html"
out.write_text(html)
print("wrote", out, len(html), "bytes")
