// Assemble founder design HTML with inlined local-rendered SVGs (zero external deps).
import { readFileSync, writeFileSync } from "node:fs";

const svg = (name) =>
	readFileSync(new URL(`./${name}.svg`, import.meta.url), "utf8");

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-1940 引擎生命周期三缺口收口 — 设计方案</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#f5f5f7; color:#1d1d1f; font-family:-apple-system,system-ui,sans-serif; line-height:1.45; }
  .wrap { max-width:960px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:22px; color:#1a365d; margin-bottom:4px; }
  .sub { color:#86868b; font-size:13px; margin-bottom:14px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.06); padding:14px 18px; margin-bottom:12px; }
  .card.blue { border-left:4px solid #007aff; }
  .card.red { border-left:4px solid #ff3b30; }
  .card.amber { border-left:4px solid #ff9500; }
  .card.green { border-left:4px solid #34c759; }
  .card.purple { border-left:4px solid #af52de; }
  h2 { font-size:17px; color:#1a365d; margin-bottom:10px; }
  h3 { font-size:14px; color:#1d1d1f; margin:12px 0 6px; }
  p { font-size:13.5px; margin-bottom:7px; }
  .dim { color:#86868b; font-size:12.5px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; margin:6px 0; }
  th { text-align:left; color:#86868b; font-weight:600; padding:6px 8px; border-bottom:1px solid #e5e5ea; white-space:nowrap; }
  td { padding:5px 7px; border-bottom:1px solid #f2f2f4; vertical-align:top; }
  .mono { font-family:'SF Mono',Menlo,monospace; font-size:12px; color:#1a365d; }
  .diagram { text-align:center; margin:10px 0; overflow-x:auto; }
  .diagram svg { max-width:100%; height:auto; }
  .diagram.h620 svg { height:575px; width:auto; max-width:100%; }
  .diagram.h520 svg { height:490px; width:auto; max-width:100%; }
  .diagram.h430 svg { height:430px; width:auto; max-width:100%; }
  .diagram.h820 svg { height:730px; width:auto; max-width:100%; }
  .cap { text-align:center; color:#86868b; font-size:12px; margin-top:4px; }
  .cbox { margin-top:10px; border-top:1px dashed #e5e5ea; padding-top:8px; }
  .cbox label { display:block; font-size:12px; color:#86868b; margin-bottom:4px; }
  .cbox textarea { width:100%; min-height:36px; border:1px solid #d2d2d7; border-radius:8px; padding:8px 10px; font-size:13px; font-family:inherit; resize:vertical; background:#fafafa; }
  .cbox textarea:focus { outline:none; border-color:#007aff; background:#fff; }
  .btn { display:inline-block; background:#007aff; color:#fff; border:none; border-radius:8px; padding:8px 16px; font-size:14px; cursor:pointer; font-family:inherit; }
  .btn:active { opacity:.8; }
  #copy-status { margin-left:10px; font-size:13px; }
  #summary-preview { background:#fafafa; border:1px solid #e5e5ea; border-radius:8px; padding:10px 12px; font-size:12.5px; white-space:pre-wrap; font-family:'SF Mono',Menlo,monospace; max-height:220px; overflow-y:auto; margin-top:10px; }
  .badge { display:inline-block; font-size:11px; font-weight:600; border-radius:5px; padding:1px 7px; margin-right:6px; vertical-align:1px; }
  .badge.p0 { background:#ffebe9; color:#ff3b30; }
  .badge.p1 { background:#fff4e5; color:#ff9500; }
  .badge.p2 { background:#f2f2f4; color:#86868b; }
  ul { padding-left:20px; font-size:13.5px; }
  li { margin-bottom:4px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>FLY-1940 引擎生命周期三缺口收口 — 设计方案</h1>
  <div class="sub">2026-08-21 · 合并 FLY-1940/1941/1946 · Codex design review 5 轮 APPROVED(20 项 findings 全折入,零拒绝)</div>

  <div class="card blue" data-sec="一句话总结">
    <h2>一句话总结</h2>
    <p><strong>引擎每一次状态交接都默认「对面还在、下一步会自然发生」,从不回头验证——这次给每类交接补上「验证-闭环-出口」:发货卡必须验当前版本的 QA 章、交接棒必须等回执、审批闸有人看护、卡死的任务有正门出口、解雇必须杀干净、收尾必须收到底。</strong></p>
    <p class="dim">背景:8-20~8-21 一天半内生产连发六类事故(founder 当场抓到复活工人直通发货卡;一天两起交棒不唤醒;审批闸挂 152 小时;任务卡死三条正路全堵;被解雇的 Codex 后台进程烧钱一小时;三次发货收尾全靠 Lead 手工补)。</p>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-summary" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card red" data-sec="出了什么事">
    <h2>出了什么事:六个切面,同一个病</h2>
    <table>
      <tr><th>切面</th><th>案发</th><th>一句话病情</th></tr>
      <tr><td>① 复活直通发货卡</td><td>FLY-1894 案</td><td>工人 session(一次派工的工作进程)被判死,重启后窗口复活走完流程开出发货卡——QA 章却盖在 6 轮修复之前的旧代码上,founder 当场抓到</td></tr>
      <tr><td>② 交棒不唤醒</td><td>8-20 两案 + 8-21 两案</td><td>QA 打回后引擎把活交给停驻的 Codex 工人,唤醒信写进邮箱就算「送达」——没人读信,Lead 手工敲门才动;还有一次投给了已经死掉的工人也算送达</td></tr>
      <tr><td>③ 孤儿闸</td><td>FLY-1758 / FLY-1911</td><td>请 founder 审批的闸开了 152.8 小时没人管——任务六天前就完结了,没有任何机制负责关它;巡检名册只看活工人,这种形态全盲</td></tr>
      <tr><td>④ needs_lead 死路</td><td>FLY-1925 / FLY-1934,founder 授权实测</td><td>投递失败 5 次后任务进「等 Lead 处理」态——但三条正规恢复路全是死胡同:判活探针把「拆干净的工人」永远当成「可能还活着」,重启也不重放</td></tr>
      <tr><td>⑤ 解雇不杀进程</td><td>8-21 实证</td><td>解雇 Codex 工人只拆了终端窗口——它的后台守护进程没死,一小时后还在烧额度、往系统里发消息</td></tr>
      <tr><td>⑥ 收尾停一半</td><td>1912/1929/1795 三连</td><td>发货后的收尾(归档讨论串、Linear 标完成、清窗口)停在「部分完成」不吵不闹,三单全靠 Lead 手工补;founder 定的标准:发完货讨论串自己消失,谁都不用碰</td></tr>
    </table>
    <p class="dim">另有存量欠账:生产账本里有 158 根「死棒」——交接棒(TURN,同一时刻谁有权动共享代码的令牌)的持有人早已死亡,棒龄上千小时,每根都在阻塞收尾。</p>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-incidents" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card purple" data-sec="病根">
    <h2>病根:三门缺课</h2>
    <p>六个切面不是六个 bug,是三个共同缺陷各自表现:</p>
    <div class="diagram h620">__SVG_D1__</div>
    <div class="cap">图 1 · 六个切面 → 三门缺课的映射</div>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-rootcause" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card green" data-sec="怎么修:交棒与发货卡">
    <h2>怎么修(一):交棒必有回执,发货卡必验版本</h2>
    <p><strong>交棒(切面②)</strong>:「送达」的定义从「唤醒信写进了邮箱」改为「接棒人真的回了执」——接棒人跑一条既有的 turn 命令就是回执,这条命令本来就是他们的规定动作,只是引擎从来没等它。没回执就按 3 分钟节奏重探重敲;对停驻的 Codex 工人,第二次起直接敲它的终端窗口(把 Lead 的手工敲门机械化)。超时走既有的 30/60 分钟升级告警,绝不静默。</p>
    <div class="diagram h520">__SVG_D2A__</div>
    <div class="cap">图 2 · 修复后的交接闭环</div>
    <p style="margin-top:10px"><strong>发货卡(切面①)</strong>:开卡前多一条断言——QA 通过章必须盖在<em>当前</em>代码版本上,版本不符卡直接被拦、要求复测;同时「已判死」的工人失去一切写权,复活了也改不动任何账。</p>
    <div class="diagram h430">__SVG_D2B__</div>
    <div class="cap">图 3 · 修复后的发货卡前置断言</div>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-fix-handoff" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card amber" data-sec="怎么修:审批闸与死棒">
    <h2>怎么修(二):审批闸有人看护,死棒一次清完</h2>
    <p><strong>孤儿闸监控(切面③)</strong>:四条判据缺一不可——缺任何一条,监控第一天就会拿已交付/已放弃的活去吵人,很快被所有人忽略,比没有更糟。「任务活着」显式包含 held(挂起)态:实测发现真死的任务多半已被引擎挂起,不算它就两头都不报。此外「闸开过」≠「founder 看见了」:压根没生成审批卡片的闸(从未送达),首轮巡检立即上浮,不等 24 小时。</p>
    <div class="diagram h820">__SVG_D3A__</div>
    <div class="cap">图 4 · 孤儿闸监控的四条与判据</div>
    <p style="margin-top:10px"><strong>闸的退休</strong>:issue 完结/PR 合并后自动关闸的机制早就存在,只是把 founder 审批闸排除在白名单外——把它加进去,152 小时孤儿闸这类形态直接由既有机制顺手关掉(1758/1911 两形态重放后均不再吵人)。</p>
    <p><strong>158 根死棒(存量收敛,Tadashi 要求论证后选)</strong>:选「一次性收敛」不选「巡检渐清」。理由:死棒不是被动欠账,每根都在主动阻塞收尾、批量再生孤儿闸;渐清 = 让泵多跑几周,且巡检上线后 158 根同时亮红就是监控噪音的死法。而全量清扫的位点本来就在(Bridge 每次重启跑一次,今天是空转,只因清扫器对引擎任务全量跳过)——解除跳过,下一次部署重启天然就是那次「一次性 reconcile」,自带并发保护与审计。只清两类可证死透的形态,模糊的保留并点名残余,不承诺归零、不误杀活棒。</p>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-fix-gate" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card green" data-sec="怎么修:判死与收尾">
    <h2>怎么修(三):解雇杀干净,判死有依据,收尾必到底</h2>
    <ul>
      <li><strong>解雇杀全家(切面⑤)</strong>:解雇工人时按「这次派工」为单位收割全部宿主进程——Codex 守护进程用它的通信 socket(进程间通信的门牌)做身份双证,组信号杀+验尸,杀完记档;「无该派工的宿主进程」从此是判死证据之一。工人出生的第一毫秒就登记进程组身份,登记失败就地杀掉不许无主进程存活。</li>
      <li><strong>判死学(切面④根因)</strong>:判活探针补上「查无此人 + 无终端 + 无进程 = 死透」的判定(引擎另一处早就这么判,唯独这里漏了);同时 daemon 活着就永远判不死(防止杀不干净时误判)。卡死任务的三条死路全部打通:判死修好后正门自然通,另补一个 Lead 侧恢复入口兜底,「指向死工人的排队占位」也自动失效。</li>
      <li><strong>收尾必到底(切面⑥)</strong>:收尾卡在「部分完成」的根因就是⑤④——工人没杀干净,收尾确认不了「人走干净了」。根因修掉后大头自动通;再补一个「总攻数预算」(13 次或 48 小时封顶,任何中间小动作不得复位它),到顶必升级,消灭「安静停在部分完成」的稳态。</li>
    </ul>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-fix-kill" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card blue" data-sec="数据与结构">
    <h2>数据/结构模型:动了哪些账本</h2>
    <table>
      <tr><th>账本/机制</th><th>改动</th></tr>
      <tr><td class="mono">发货卡权威账(gate holder)</td><td>开卡新增断言:QA 章版本 == 当前版本,不符 typed 拒绝(复用已合入的拒绝机制)</td></tr>
      <tr><td class="mono">QA 章(workflow_claims)</td><td>代码版本前进时自动作废旧版本的 QA 章(复制设计评审章已有的同款机制)</td></tr>
      <tr><td class="mono">写权栅栏(writer fence)</td><td>补 session 状态谓词:判死即失写权;返回结构化分类,session 缺行 fail-closed</td></tr>
      <tr><td class="mono">交付账(rework/carrier delivery)</td><td>「送达」改由回执投影驱动;新增中性等待态(耐久停驻 3 分钟节奏,不烧每秒轮询);删「写文件即送达」老路</td></tr>
      <tr><td class="mono">审批闸(mailbox 表)</td><td>founder_review 加入既有顶替/退休机制白名单(superseded 字段本来就有,只是没人写);零新表</td></tr>
      <tr><td class="mono">交接棒(three_stage_turn)</td><td>清扫器解除引擎任务全量跳过;只用带并发保护的删除原语;存量 boot 一次清</td></tr>
      <tr><td class="mono">Codex 守护进程身份</td><td>spawn 第一毫秒同步登记进程组;新增非破坏性判活探针与收割原语(同源身份推导)</td></tr>
      <tr><td class="mono">收尾账(land operation)</td><td>新增两列:收尾总攻数 + 首攻时刻;13 次/48h 封顶升级</td></tr>
    </table>
    <p class="dim">零新告警层、零新巡逻器:监控挂在既有巡检 rider 家族,告警走既有引擎告警位点。净删除清单 8 项(旧送达路径、死代码账本、双份拷贝断言、专用退休逻辑等)随各 PR 同车删。</p>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-data" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card purple" data-sec="取舍与被否方案">
    <h2>关键取舍与被否掉的方案</h2>
    <table>
      <tr><th>决策</th><th>选了</th><th>否掉了(为什么)</th></tr>
      <tr><td>交棒送达定义</td><td>等接棒人回执(既有 turn 命令)</td><td>加新的独立看门狗盯交付——刚拆完看门狗全家,不能长回来;回执机制本来就有,只是没人用</td></tr>
      <tr><td>死棒存量</td><td>一次性收敛(boot 清扫 + 常态防再淤)</td><td>巡检渐清——数周红名单噪音教会大家忽略监控;渐清期间死棒继续批量再生孤儿闸</td></tr>
      <tr><td>「任务活着」定义</td><td>active + held 都算活</td><td>只算 active——实测真死任务多半已 held,不算它监控生而废</td></tr>
      <tr><td>founder 免 QA 通道</td><td>本期不建(P2 点名)</td><td>三起事故零次需要它;先不给绕过 QA 的口子,免 QA 语义由拒绝理由+既有打回决策面临时承担</td></tr>
      <tr><td>收尾重试预算</td><td>独立总攻数列,只在收尾失败时 +1</td><td>逢重试就加——会在走到收尾前就把预算烧光;沿用现 epoch 计数——中间小动作会无限复位它(这正是 bug)</td></tr>
      <tr><td>「她看见了」合同</td><td>监控保证「没送达/没人答必上浮」</td><td>完整阅读回执 UX——产品单范畴,本单只收敛合同边界不做产品化</td></tr>
    </table>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-tradeoffs" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card amber" data-sec="诚实边界">
    <h2>诚实边界:做什么 / 不做什么</h2>
    <h3>本设计做到</h3>
    <ul>
      <li>六个切面全部给出机制级修复(不是逐案打补丁),5 个 PR 分批、每个独立可发可回滚;P0 = 三起急性事故根因(判死+杀树 / 交棒回执 / 复活免疫+开卡断言),P1 = 慢性病(孤儿闸/死棒/出口/收尾)</li>
      <li>issue 及全部 8 条追加评论的每一条验收都有归属修复与测试(计划里有逐条映射表)</li>
      <li>Codex 设计评审 5 轮共 20 项 findings 全部折入,零拒绝;第 5 轮 APPROVED</li>
    </ul>
    <h3>本设计不做(逐项点名,零静默丢)</h3>
    <ul>
      <li><span class="badge p2">P2</span>founder 免 QA 通道;legacy 唤醒路径的静默修复;三套「终态」词表统一(立独立重构单);「她读了」回执 UX(产品单);158 根里模糊残余(fail-closed 保留 + 计数点名,按形态立后续单)</li>
      <li>Lead 收件箱唤醒降级属 FLY-1876,不在本单</li>
      <li>本页是<strong>设计</strong>交付:代码实现、真机重放验收(1894/1925/1758/1911 四形态)在后续 implement/QA 节点</li>
    </ul>
    <div class="cbox"><label>对这一节的意见(自动保存)</label><textarea data-key="sec-boundary" placeholder="写下你的意见…"></textarea></div>
  </div>

  <div class="card green" data-sec="意见汇总">
    <h2>页面意见汇总</h2>
    <p class="dim">上面每一节的意见框都会自动保存在你的浏览器里。写完后点下面按钮一键复制全部意见,贴回 Discord 即可。<strong>如果整页直接通过、没有意见,不用这个按钮</strong>——直接在 Discord 卡片上回复通过即可(复制出的汇总永远按「修改意见」处理,不当通过信号)。</p>
    <button class="btn" id="copy-all">复制全部意见</button><span id="copy-status"></span>
    <div id="summary-preview">（暂无意见）</div>
  </div>
</div>
<script nonce="__CSP_NONCE__">
(function () {
  "use strict";
  var PREFIX = "fly1940-comments:" + location.pathname + ":";
  var MARKER = "【页面意见汇总】FLY-1940";
  var CHUNK = 1800;

  function lsGet(k) { try { return localStorage.getItem(PREFIX + k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch (e) {} }

  var areas = Array.prototype.slice.call(document.querySelectorAll("textarea[data-key]"));
  areas.forEach(function (ta) {
    var key = ta.getAttribute("data-key");
    var saved = lsGet(key);
    if (saved) ta.value = saved;
    ta.addEventListener("input", function () { lsSet(key, ta.value); renderSummary(); });
  });

  function collect() {
    var parts = [];
    areas.forEach(function (ta) {
      var v = ta.value.trim();
      if (!v) return;
      var card = ta.closest("[data-sec]");
      var sec = card ? card.getAttribute("data-sec") : "未命名章节";
      parts.push("【" + sec + "】" + v);
    });
    return parts;
  }

  function buildChunks() {
    var parts = collect();
    if (!parts.length) return [];
    var chunks = [];
    var cur = MARKER;
    parts.forEach(function (p) {
      var piece = "\\n" + p;
      if ((cur + piece).length > CHUNK && cur !== MARKER) {
        chunks.push(cur);
        cur = MARKER + "(续)" + piece;
      } else {
        cur += piece;
      }
    });
    chunks.push(cur);
    return chunks;
  }

  var preview = document.getElementById("summary-preview");
  function renderSummary() {
    var chunks = buildChunks();
    preview.textContent = chunks.length ? chunks.join("\\n\\n----(分段)----\\n\\n") : "（暂无意见）";
  }
  renderSummary();

  var statusEl = document.getElementById("copy-status");
  function setStatus(msg, ok) {
    statusEl.textContent = msg;
    statusEl.style.color = ok ? "#34c759" : "#ff3b30";
  }

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  document.getElementById("copy-all").addEventListener("click", function () {
    var chunks = buildChunks();
    if (!chunks.length) { setStatus("还没有写任何意见", false); return; }
    var text = chunks.join("\\n\\n");
    var done = function (ok) {
      if (ok) {
        setStatus(chunks.length > 1 ? "已复制(" + chunks.length + " 段,请分段粘贴)" : "已复制", true);
      } else {
        setStatus("复制失败——请手动全选下方汇总内容复制", false);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
    } else {
      done(legacyCopy(text));
    }
  });
})();
</script>
</body>
</html>
`;

const out = page
	.replace("__SVG_D1__", svg("d1-root-cause"))
	.replace("__SVG_D2A__", svg("d2a"))
	.replace("__SVG_D2B__", svg("d2b"))
	.replace("__SVG_D3A__", svg("d3a"));

writeFileSync(new URL("./design.html", import.meta.url), out);
console.log("written design.html", out.length, "bytes");
