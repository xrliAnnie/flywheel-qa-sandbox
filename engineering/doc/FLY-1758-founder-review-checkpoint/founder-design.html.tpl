<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FLY-1758 · 产品线互动回合:founder_review 设计</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, system-ui, "PingFang SC", sans-serif;
    background: #f5f5f7; color: #1d1d1f;
    line-height: 1.7; padding: 24px 16px 80px;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 26px; color: #1a365d; margin-bottom: 6px; }
  .meta { color: #86868b; font-size: 13px; margin-bottom: 28px; }
  .meta code { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; }
  .card {
    background: #fff; border-radius: 12px; padding: 22px 24px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 14px;
    border-left: 4px solid #007aff;
  }
  .card.red { border-left-color: #ff3b30; }
  .card.green { border-left-color: #34c759; }
  .card.amber { border-left-color: #ff9500; }
  .card.purple { border-left-color: #af52de; }
  .card.gray { border-left-color: #86868b; }
  h2 { font-size: 19px; color: #1a365d; margin-bottom: 12px; }
  h3 { font-size: 15px; color: #1d1d1f; margin: 14px 0 6px; }
  p { margin-bottom: 10px; font-size: 15px; }
  ul, ol { margin: 0 0 10px 22px; font-size: 15px; }
  li { margin-bottom: 6px; }
  .lede { font-size: 17px; }
  .term { color: #86868b; font-size: 13.5px; }
  .diagram { overflow-x: auto; background: #fff; padding: 8px 0; margin: 12px 0; text-align: center; }
  .diagram svg { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 14px; font-size: 14px; }
  th, td { border: 1px solid #e5e5ea; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f5f5f7; color: #1a365d; }
  .quote {
    border-left: 3px solid #d2d2d7; padding: 6px 14px; color: #515154;
    background: #fafafa; border-radius: 0 8px 8px 0; margin: 10px 0; font-size: 14.5px;
  }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-right: 6px; }
  .badge.no { background: #ffe5e3; color: #c0392b; }
  .badge.yes { background: #e2f7e8; color: #1e7e34; }
  .comment-box { margin-top: 16px; padding-top: 14px; border-top: 1px dashed #e5e5ea; }
  .comment-box label { font-size: 13px; color: #86868b; display: block; margin-bottom: 6px; }
  .comment-box textarea {
    width: 100%; min-height: 64px; border: 1px solid #d2d2d7; border-radius: 8px;
    padding: 10px; font: inherit; font-size: 14px; resize: vertical; background: #fbfbfd;
  }
  .comment-box textarea:focus { outline: none; border-color: #007aff; }
  #summary-card { border-left-color: #1a365d; }
  #summary-list { font-size: 14px; }
  #summary-list .sum-item { margin-bottom: 10px; }
  #summary-list .sum-sec { font-weight: 600; color: #1a365d; }
  #copy-all {
    background: #007aff; color: #fff; border: none; border-radius: 8px;
    padding: 9px 18px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 10px;
  }
  #copy-all:active { opacity: 0.75; }
  #copy-hint { font-size: 13px; color: #34c759; margin-left: 10px; }
  .empty-note { color: #86868b; font-style: italic; }
</style>
</head>
<body>
<div class="wrap">
  <h1>产品线互动回合:founder_review</h1>
  <div class="meta">FLY-1758 · 设计稿(方案设计,尚未开始写代码)· 2026-08-14 · 图和文字下方都有留言框,写完点页底「复制全部留言」贴回 Discord 即可</div>

  <div class="card green" data-section="一句话总结">
    <h2>1 · 一句话总结</h2>
    <p class="lede">给产品线(PRD / 设计 / 原型)加一种新的回合:<strong>每个阶段性产出必须先交给你 review</strong>——卡片直达你的 issue thread,你留言就打回、点 ✅ 才通过;<strong>没有你末轮的「通过」,runner 收不了工,ship 卡根本不会出现</strong>。Lead 想代答会被机器直接拒绝。</p>
    <p class="term">「checkpoint(回合点)」= 系统里一种"停下来等一个人答复"的机制;这次新增的一种叫 founder_review,只有你能答。</p>
    <div class="comment-box"><label>对这一节的留言:</label><textarea data-sec="一句话总结" placeholder="写下你的意见…(自动保存在本机)"></textarea></div>
  </div>

  <div class="card red" data-section="病根">
    <h2>2 · 病根:回合的收件人变成了 Lead</h2>
    <p>你 8/13 说的病:「runner 一直闷头做,做完就说可以 ship,中间完全没有跟我互动」。我们查了代码和数据,病根不是流程图坏了,而是<strong>「一轮互动」的收件人在结构上就是 Lead,不是你</strong>:</p>
    <ul>
      <li>八月全库 runner 发出的提问:发给工程 Lead 1961 条、产品 Lead 78 条、<strong>发给你 0 条</strong>;产品 Lead 那 78 条全部被 Lead 自己答掉了。</li>
      <li>Lead 答得越快越"称职",你越彻底看不见任何一轮 —— 这是机制问题,不是谁偷懒。</li>
      <li>你记忆里"以前 interactive 很好"的时期,其实还没上模板引擎,当时是 Lead 手工把每版东西早早投给你 —— 那个体验正是本设计要机制化的东西。</li>
    </ul>
    <div class="diagram">{{SVG1}}</div>
    <div class="comment-box"><label>对这一节的留言:</label><textarea data-sec="病根" placeholder="写下你的意见…(自动保存在本机)"></textarea></div>
  </div>

  <div class="card" data-section="一轮怎么走">
    <h2>3 · 一轮 review 怎么走(核心流程)</h2>
    <p>每当 runner 做出一个阶段性产出(比如 PRD 第一版),它必须:先做成<strong>可留言的网页</strong>(每一节下面有留言框,就像你现在看的这页)→ 开一个 founder_review 回合 → 卡片立刻出现在 issue thread 里 @你,带链接和两个动作:<strong>回复 = 意见打回(你的原话会一字不差交回 runner)</strong>,<strong>点 ✅ = 通过</strong>。打回后 runner 改完再开下一轮,轮数不限;只有末轮通过,它才能收工。</p>
    <div class="diagram">{{SVG2}}</div>
    <p class="term">「runner」= 干活的 AI 工人;「Bridge」= 系统的中枢服务,负责把卡片发进 Discord、并核验回复真的是你本人。</p>
    <div class="comment-box"><label>对这一节的留言:</label><textarea data-sec="一轮怎么走" placeholder="写下你的意见…(自动保存在本机)"></textarea></div>
  </div>

  <div class="card purple" data-section="谁的答复算数">
    <h2>4 · 谁的答复算数(数据与守卫)</h2>
    <p>这是本单的命门。系统里已经有一套久经考验的身份判定(ship 门在用的那套):只认<strong>你的 Discord 身份</strong>和<strong>面板批准</strong>,Lead 的名字明确不算、冒名参数也伪造不了。founder_review 直接复用它,并且比 ship 门更严:<strong>Lead 连"替你写打回意见"都不行</strong>(通过和打回都只能出自你),否则中间版本照样绕过你。</p>
    <div class="diagram">{{SVG3}}</div>
    <h3>每一轮在账本里长什么样</h3>
    <table>
      <tr><th>记录</th><th>内容</th><th>说明</th></tr>
      <tr><td>回合问题</td><td>第几轮 + 变更说明 + 网页链接</td><td>runner 开回合时写入;没提交产出连回合都开不了</td></tr>
      <tr><td>你的裁定</td><td>通过 / 打回 + 意见全文</td><td>只有核验过"作者是你"才写得进;写入者身份机器可查</td></tr>
      <tr><td>两道门</td><td>收工门 + 合入门</td><td>都读同一份账本、用同一个判定函数 —— 不会出现"一道门撤了另一道还卡着"的老毛病</td></tr>
    </table>
    <div class="comment-box"><label>对这一节的留言:</label><textarea data-sec="谁的答复算数" placeholder="写下你的意见…(自动保存在本机)"></textarea></div>
  </div>

  <div class="card amber" data-section="粒度">
    <h2>5 · 什么必须交给你,什么不打扰你</h2>
    <p>按你 8/13 拍板的粒度,逐字落进三个产品线工人的行为规范:</p>
    <table>
      <tr><th>流</th><th>必须交你 review 的</th></tr>
      <tr><td>PRD</td><td>调研摘要一页 → 第一版 PRD(可留言)→ 之后每一版按你意见改完的</td></tr>
      <tr><td>Design</td><td>mockup 几个方向 → 你挑定方向后的高保真版</td></tr>
      <tr><td>Prototype</td><td>第一个能跑的版本 → 之后每一轮修订</td></tr>
    </table>
    <p><strong>不打扰你的</strong>:runner 问 Lead 的技术/执行问题(这条通道一字不动)、中途研究笔记、代码级改动。</p>
    <div class="comment-box"><label>对这一节的留言:</label><textarea data-sec="粒度" placeholder="写下你的意见…(自动保存在本机)"></textarea></div>
  </div>

  <div class="card gray" data-section="取舍">
    <h2>6 · 关键取舍与被否掉的方案</h2>
    <table>
      <tr><th>选择</th><th>为什么</th></tr>
      <tr><td><span class="badge yes">采纳</span>新回合点 founder_review,发生在工人干活的节点内部</td><td>零流程图改动、零新基建;复用 ship 门的身份判定和卡片通道</td></tr>
      <tr><td><span class="badge yes">采纳</span>拦截点放在「runner 收工」那一步</td><td>字面实现"不许把做完了当可以 ship":没通过就收不了工,ship 卡根本不会铸出来,你不会收到一张你从没 review 过的 ship 卡</td></tr>
      <tr><td><span class="badge no">否掉</span>纯靠提示词约定(不写代码)</td><td>没有机器拒绝,Lead 代答的病原封不动 —— 这正是现在的病</td></tr>
      <tr><td><span class="badge no">否掉</span>在流程图上加"打回"环/第二个 gate 节点</td><td>你已冻结过 kickback 方案(FLY-1691);引擎一图只许一个 gate;每一轮本来就发生在节点内部</td></tr>
      <tr><td><span class="badge no">否掉</span>复活七月被你撤掉的 UX 签字门(FLY-900)</td><td>那个门挡错了地方(挡工程 implement)、还因配置缺失把全部工人卡死过;这次严格只管产品线,配置缺失会大声报错而不是静默卡死</td></tr>
    </table>
    <div class="comment-box"><label>对这一节的留言:</label><textarea data-sec="取舍" placeholder="写下你的意见…(自动保存在本机)"></textarea></div>
  </div>

  <div class="card red" data-section="诚实边界">
    <h2>7 · 诚实边界:这个设计不做什么</h2>
    <ul>
      <li><strong>你在网页上的留言不会自动飞回 runner。</strong>回传后端(FLY-298)还在 Backlog。真实闭环是:你留言 → 点页底「复制全部留言」→ 粘贴成对卡片的回复 → 这条回复本身就是本轮的打回意见,机器会原文交给 runner。少一步复制粘贴,但每个字都会到。</li>
      <li><strong>"每一版都送来"靠工人的行为规范驱动;机器门保证的是:至少送过、末轮是通过、没送过连收工都不行。</strong>机器无法逐版点名"你还有一版没送"。</li>
      <li><strong>超时取"宁可停"</strong>:你 48 小时没答,runner 停下报告 Lead,等你回来重开回合 —— 绝不"没人答就当通过"。</li>
      <li>工程线(写代码的流)完全不受影响;runner 问 Lead 的问题通道也一字不动。</li>
    </ul>
    <div class="comment-box"><label>对这一节的留言:</label><textarea data-sec="诚实边界" placeholder="写下你的意见…(自动保存在本机)"></textarea></div>
  </div>

  <div class="card green" data-section="验收">
    <h2>8 · 怎么证明它真的挡得住</h2>
    <ul>
      <li>会写一个<strong>主动去破它</strong>的测试:让一个产品线任务在没有你通过的情况下硬闯 ship —— 必须被拦下,而不是一句"我们保证"。</li>
      <li>Lead 用命令代答 founder_review(不管是替你"通过"还是替你"打回")—— 必须被拒,测试覆盖。</li>
      <li>产出没做出来/没提交 —— 连回合都开不了,不计数。</li>
      <li>端到端真机验证:你收到可留言网页 → 留言 → 打回 → 修订版再送达。</li>
    </ul>
    <div class="comment-box"><label>对这一节的留言:</label><textarea data-sec="验收" placeholder="写下你的意见…(自动保存在本机)"></textarea></div>
  </div>

  <div class="card" id="summary-card" data-section="__summary__">
    <h2>📋 你的全部留言</h2>
    <div id="summary-list"><p class="empty-note">还没有留言。在上面任意一节的框里写字,这里会实时汇总。</p></div>
    <button id="copy-all" type="button">复制全部留言</button><span id="copy-hint"></span>
  </div>
</div>

<script nonce="__CSP_NONCE__">
(function () {
  "use strict";
  var PREFIX = "fly1758-comment:" + location.pathname + ":";
  var areas = Array.prototype.slice.call(document.querySelectorAll("textarea[data-sec]"));

  function load(sec) {
    try { return localStorage.getItem(PREFIX + sec) || ""; } catch (e) { return ""; }
  }
  function save(sec, val) {
    try { localStorage.setItem(PREFIX + sec, val); } catch (e) { /* storage unavailable */ }
  }
  function collect() {
    var out = [];
    areas.forEach(function (ta) {
      var v = ta.value.trim();
      if (v) out.push({ sec: ta.getAttribute("data-sec"), text: v });
    });
    return out;
  }
  function renderSummary() {
    var list = document.getElementById("summary-list");
    var items = collect();
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!items.length) {
      var p = document.createElement("p");
      p.className = "empty-note";
      p.textContent = "还没有留言。在上面任意一节的框里写字,这里会实时汇总。";
      list.appendChild(p);
      return;
    }
    items.forEach(function (it) {
      var div = document.createElement("div");
      div.className = "sum-item";
      var b = document.createElement("div");
      b.className = "sum-sec";
      b.textContent = "【" + it.sec + "】";
      var t = document.createElement("div");
      t.textContent = it.text;
      div.appendChild(b); div.appendChild(t);
      list.appendChild(div);
    });
  }
  function allText() {
    return collect().map(function (it) { return "【" + it.sec + "】\n" + it.text; }).join("\n\n");
  }
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function showHint(msg) {
    var hint = document.getElementById("copy-hint");
    hint.textContent = msg;
    setTimeout(function () { hint.textContent = ""; }, 2500);
  }

  areas.forEach(function (ta) {
    var sec = ta.getAttribute("data-sec");
    ta.value = load(sec);
    ta.addEventListener("input", function () {
      save(sec, ta.value);
      renderSummary();
    });
  });
  renderSummary();

  document.getElementById("copy-all").addEventListener("click", function () {
    var text = allText();
    if (!text) { showHint("没有可复制的留言"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { showHint("✅ 已复制,去 Discord 粘贴吧"); },
        function () { showHint(legacyCopy(text) ? "✅ 已复制(兼容模式)" : "❌ 复制失败,请手动全选"); }
      );
    } else {
      showHint(legacyCopy(text) ? "✅ 已复制(兼容模式)" : "❌ 复制失败,请手动全选");
    }
  });
})();
</script>
</body>
</html>
