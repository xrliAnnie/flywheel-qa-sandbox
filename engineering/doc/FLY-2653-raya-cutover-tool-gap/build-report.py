#!/usr/bin/env python3
"""Build founder-design.html for FLY-2653 from inline sections + locally rendered SVGs."""
import html
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
ISSUE = "FLY-2653"


def svg(name: str) -> str:
    text = (HERE / "diagrams" / name).read_text(encoding="utf-8")
    text = re.sub(r"<\?xml[^>]*\?>", "", text)
    # Round long path coordinates: keeps the page well under the publish cap.
    return re.sub(r"(\d+\.\d{2})\d+", r"\1", text)


def e(text: str) -> str:
    return html.escape(text, quote=True)


CSS = """
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.65 -apple-system,system-ui,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:32px 16px 80px}
h1{font-size:28px;margin:0 0 6px;color:#1a365d}
.sub{color:#86868b;font-size:14px;margin-bottom:24px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:22px 24px;margin:0 0 18px;border-left:4px solid #007aff}
.card.red{border-left-color:#ff3b30}.card.amber{border-left-color:#ff9500}.card.green{border-left-color:#34c759}
.card.purple{border-left-color:#af52de}.card.gray{border-left-color:#86868b}
.card h2{font-size:19px;margin:0 0 12px;color:#1a365d}
.lead{font-size:18px;font-weight:600}
.term{background:#f0f4fa;border-radius:6px;padding:1px 6px;font-family:'SF Mono',monospace;font-size:13.5px}
.explain{color:#515154}
table{border-collapse:collapse;width:100%;font-size:14.5px;margin:8px 0}
th,td{border-bottom:1px solid #e5e5ea;padding:8px 8px;text-align:left;vertical-align:top}
th{color:#86868b;font-weight:600;font-size:13px}
.badge{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;color:#fff}
.b-ok{background:#34c759}.b-bad{background:#ff3b30}.b-warn{background:#ff9500}.b-info{background:#007aff}
.diagram{overflow-x:auto;margin:10px 0;padding:8px;background:#fff;border:1px solid #e5e5ea;border-radius:10px}
.diagram svg{max-width:100%;height:auto;display:block;margin:0 auto}
.comment{margin-top:14px;border-top:1px dashed #d2d2d7;padding-top:10px}
.comment label{display:block;font-size:13px;color:#86868b;margin-bottom:4px}
textarea{width:100%;min-height:64px;border:1px solid #d2d2d7;border-radius:8px;padding:8px;font:14px/1.5 -apple-system,system-ui,sans-serif;resize:vertical}
button{background:#1a365d;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;margin:6px 6px 0 0}
pre.out{white-space:pre-wrap;background:#f5f5f7;border-radius:8px;padding:10px;font:13px/1.5 'SF Mono',monospace;margin:8px 0}
.hint{color:#86868b;font-size:13px}
@media(max-width:600px){.card{padding:16px}h1{font-size:23px}}
"""

SECTIONS = []


def section(sid: str, color: str, title: str, body: str) -> None:
    SECTIONS.append((sid, color, title, body))


section("s1", "green", "1. 一句话总结", f"""
<p class="lead">这张单要的两处代码修复，今天上午已经由 FLY-2657 做完并上线了；Raya 割接到今天中午还卡着，是因为还差三件<strong>运维动作</strong>，其中一件（persona 占位过期）是这次审计新发现的。前两件 Lead 今天下午已经做完并核对通过。</p>
<p class="lead">14:04 你要求 Raya 换代尽快推进之后，设计做了一次修订：原先的「本单零代码」结论作废，改为<strong>三处很小的代码改动</strong>，让授权过的版本不会因为主线多合一个提交就作废，并让成功的紧急部署也能顺带推进 Raya。</p>
<p class="explain"><span class="term">割接</span>：把 Raya 从旧的运行方式（旧壳）切换到 Flywheel 标准 Lead 的运行方式，切的过程分 P2 到 P7 几步，每一步都记在一本「迁移账本」里。<br>
<span class="term">旧壳</span>：Raya 以前的两个后台程序 brain 和 voice，割接完成后它们应当永久停掉。<br>
<span class="term">班车</span>：Flywheel 每天 00:00 和 12:00 自动跑一次的更新程序，Raya 割接的每一步只有它能推进。</p>
<p>本单交付：核对清单、给 Lead 的操作手册（runbook）、验收标准、三处最小代码改动的设计（第 5 节），以及两条留待以后的改进建议。所有安全闸仍是「不确定就拒绝」（<span class="term">fail-closed</span>：检查结果拿不准时一律当作不通过，而不是放行）。</p>
""")

section("s2", "blue", "2. 核心流程：班车要过的三道闸", f"""
<p class="explain">班车在真正停掉旧壳之前，会先做一轮「预检」（<span class="term">prestop</span>：停旧壳之前的全部可逆检查，任何一项不过就原地退出、什么都不改）。预检里有三道闸和这次的卡死有关：</p>
<div class="diagram">{svg("d1-flow.svg")}</div>
<table>
<tr><th>闸</th><th>它在查什么</th><th>现状</th></tr>
<tr><td>闸 1 旧壳</td><td>账本里记的旧壳进程和机器上的实际情况对不对得上</td><td><span class="badge b-ok">已修</span> FLY-2657：进程确实没了就当它自己退场，补记时间并发一条提醒</td></tr>
<tr><td>闸 2 目标版本</td><td>旧规则：Raya 代码主线的最新版本必须<strong>正好等于</strong>你授权的那个版本。<br>新规则：你授权的版本只要还在主线的历史里（是主线的<span class="term">祖先</span>：主线是从它一路往后长出来的）就放行</td><td><span class="badge b-warn">本单改</span> 中午那趟班车时账本还是旧授权，Lead 已用你 9 月 16 日的新授权行重建账本。但 Raya 仓每 6 小时就可能自动合进一个 summary 提交，一合旧规则就又失败、又得找你要新授权行。改完后：实际构建和上线的仍然<strong>只是你授权的那一版</strong>，后合进来的提交不会搭车；只有主线历史被改写到不再包含授权版本时才拒绝</td></tr>
<tr><td>闸 3 persona</td><td>标准 Lead 工作区里那份 Raya 人设文件（<span class="term">persona</span>：告诉 Raya「你是谁、怎么做事」的说明书），必须和目标版本里的那份一字不差</td><td><span class="badge b-ok">新发现 · 下午已处理</span> 工作区里原来还是 9 月 9 日的旧版，人设此后改过 4 次，所以不过。Lead 已换成目标版本那份，旧版留了备份可撤回</td></tr>
</table>
<p class="explain">三道闸任何一道不过，日志里都只有同一句 <span class="term">prestop-validation-failed</span>，所以巡逻只看见了闸 1，闸 2、闸 3 一直是隐形的。</p>
""")

section("s3", "purple", "3. 谁来推进、要多久", f"""
<div class="diagram">{svg("d2-who.svg")}</div>
<table>
<tr><th>问题</th><th>答案</th></tr>
<tr><td>Lead 重建账本之后，谁接着跑？</td><td>00:00 / 12:00 的定时班车；本单改完后，<strong>一次成功的紧急部署</strong>也会在 Flywheel 自己部署完之后顺带跑同一个 Raya 段。紧急部署失败、紧急票无效、或者任何一步拿不准时，Raya 段仍然完全不碰。注意：带着这项改动上线的那一轮更新程序，内存里还是旧逻辑，要到<strong>它之后的下一次</strong>运行才生效。手动提前唤起班车仍被部署护栏禁止。</td></tr>
<tr><td>你最早什么时候能用上新 Raya（文字模式不再每轮强制发言，#154）？</td><td>更新程序首次带着新逻辑走到 P5 的时候。账本此刻（16:11 PT 只读读数）仍在 P2。具体哪一趟取决于本单 PR 何时合入并部署，设计节点不承诺时间。</td></tr>
<tr><td>正式的「v2 部署回执」什么时候出？</td><td>再下一趟班车。中间需要 Lead 做一次人工取证，并等过一个 6 小时的 summary 轮。FLY-2619 / FLY-2631 的收尾按这个节拍。</td></tr>
<tr><td>你需要配合什么？</td><td>班车前后约 20 分钟别在 #raya 频道说话（预检要求频道安静 15 分钟）；本单改动上线之前，Raya 仓主线每多合一个提交，授权就会对不上；上线之后这条限制消失。</td></tr>
<tr><td>割接完成以后的日常更新呢？</td><td>日常更新（<span class="term">standard-update</span>：割接完成后，每趟班车把 Raya 更新到主线最新版的例行动作）直接以刚取回的主线最新版为目标，账本里的「目标版本」不再充当闸门，而是改成如实记下这次实际部署的版本。只允许向前快进，不允许回退或分叉。你的授权行只管一次性换代，日常更新不需要、也不新增任何授权机制。</td></tr>
</table>
""")

section("s4", "gray", "4. 数据结构：账本里记了什么", f"""
<div class="diagram">{svg("d3-data.svg")}</div>
<p class="explain"><span class="term">cursor</span>：标准 Lead 记录「每个频道读到哪条消息了」的进度文件。以前的工具要求割接时这个文件还不存在；现在标准 Lead 已经在线并一直在写它，所以 FLY-2657 让工具在确认 Lead 健康的前提下直接沿用它，并在账本里标成 <span class="term">preexisting</span>（意思是「割接前就已经存在」）。<br>
<span class="term">授权行</span>：你在 Discord 里发的那一行固定格式文字。工具会自己去 Discord 取回这条消息，核对发信人是你、内容逐字一致，再自己算指纹存进账本——Lead 不需要、也不能手填。</p>
""")

section("s5", "amber", "5. 关键取舍与放弃的方案", """
<table>
<tr><th>方案</th><th>结论</th><th>理由</th></tr>
<tr><td>A 零代码，只交付核对 + 操作手册 + 验收</td><td><span class="badge b-bad">已作废</span></td><td>最初按你 9 月 16 日「不开新活」采用；你 9 月 18 日 14:04 要求尽快推进后由 Lead 指令取代</td></tr>
<tr><td>A′ 三处最小改动：① 一次性换代只要求授权版本是主线祖先；② 日常更新以主线最新版为目标并如实回写；③ 成功的紧急部署顺带跑 Raya 段</td><td><span class="badge b-ok">采用</span></td><td>只动两个脚本文件；三处都先写会失败的测试再改实现；每条原有的拒绝路径都保留并有测试钉住。经 Codex 设计评审，高优先级意见全部收口</td></tr>
<tr><td>F 一次性换代时干脆自动追到主线最新版</td><td><span class="badge b-bad">不做</span></td><td>那等于让你没看过的提交搭着你的授权上线。是否取消一次性授权这回事，另由 FLY-2747 处理</td></tr>
<tr><td>B 顺手把「预检失败时说清是哪一道闸」做进本单</td><td><span class="badge b-warn">推迟</span></td><td>很值得做（闸 3 就是因为它藏了三天），但它不是割接能否完成的必要条件，而且会碰到割接关键路径，应当单独过一轮设计评审。Lead 已记账，割接跑完再定</td></tr>
<tr><td>C 让工具自动替 Lead 更新 persona</td><td><span class="badge b-bad">不做</span></td><td>换人设属于授权范围内的人工动作，工具只该检查、不该代办</td></tr>
<tr><td>D 手动提前唤起班车，不等 00:00</td><td><span class="badge b-bad">不做</span></td><td>部署护栏明确禁止；绕过护栏需要你亲口授权，不在本单范围</td></tr>
<tr><td>E 直接关单不出文档</td><td><span class="badge b-bad">不做</span></td><td>会丢掉闸 2、闸 3 的事实；下次换目标版本会原样再踩</td></tr>
</table>
""")

section("s6", "red", "6. 诚实边界：这份设计做什么、不做什么", """
<table>
<tr><th>做</th><th>不做</th></tr>
<tr><td>逐条证明本单两处期望在主线代码和生产环境里都已存在</td><td>不保证割接在哪一趟一定成功</td></tr>
<tr><td>给 Lead 一份逐字可执行、每条前置都附当前读数的操作手册</td><td>设计节点没有对生产做任何写操作：没重建账本、没换 persona、没碰班车、没读密钥的值、没读你的 Discord 消息正文</td></tr>
<tr><td>指出新发现的第三道闸和「目标版本易碎」这两个风险</td><td>不放宽任何一道安全闸；目标版本漂了只能重新授权，没有也不该有绕过办法</td></tr>
<tr><td>写明验收标准和失败时的回退点（停旧壳之后只能向前，不能再重建账本）</td><td>不改授权行格式；不放宽旧壳、persona、频道安静、账本校验、只许快进这几道闸；不合并、不部署、不发紧急重启、不手动唤起更新程序</td></tr>
<tr><td>三处改动各有「先失败后通过」的测试，外加六条「紧急轮出问题时 Raya 零调用」的断言</td><td>不把「测试通过」说成「生产已割接」：账本现在仍在 P2，生产验收由 Lead 在割接后读回</td></tr>
</table>
<p class="explain">一个原先未核实的假设——你那条授权消息的正文里<strong>逐字</strong>包含固定格式的授权行——已经由 Lead 下午重建账本成功间接证实（工具核不过就不会写账本）。仍然不受我们控制的有两件事：本单改动上线之前 Raya 仓主线不能再前进；更新程序跑 Raya 段那一刻 #raya 频道要安静 15 分钟。</p>
""")

BODY = []
for sid, color, title, body in SECTIONS:
    BODY.append(
        f'<section class="card {color}" data-section="{e(sid)}" data-title="{e(title)}">'
        f"<h2>{e(title)}</h2>{body}"
        f'<div class="comment"><label for="c-{e(sid)}">对这一节的意见（自动保存在本机浏览器）</label>'
        f'<textarea id="c-{e(sid)}" data-comment="{e(sid)}" placeholder="写下你的意见…"></textarea></div>'
        "</section>"
    )

SUMMARY = """
<section class="card green" id="summary-card">
<h2>页面意见汇总</h2>
<p class="hint">这里实时汇总上面每一节里写下的意见。它只是修改意见，不代表通过。</p>
<div id="summary-empty" class="hint">上面任何板块写了意见，这里就会出现汇总。</div>
<div id="summary-chunks"></div>
<button type="button" id="copy-all">复制全部意见</button>
<span id="copy-status" class="hint"></span>
</section>
"""

SCRIPT = r"""
(function () {
  var MARKER = '【页面意见汇总】FLY-2653';
  var PREFIX = 'fly2653-comment:' + location.pathname + ':';
  var LIMIT = 1800;
  function load(key) { try { return window.localStorage.getItem(PREFIX + key) || ''; } catch (err) { return ''; } }
  function save(key, value) { try { window.localStorage.setItem(PREFIX + key, value); } catch (err) { /* storage unavailable */ } }
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-comment]'));
  function entries() {
    var list = [];
    areas.forEach(function (area) {
      var text = area.value.trim();
      if (!text) return;
      var card = area.closest('section');
      list.push('■ ' + (card ? card.getAttribute('data-title') : area.getAttribute('data-comment')) + '\n' + text);
    });
    return list;
  }
  function pieces(list) {
    var out = [];
    list.forEach(function (item) {
      while (item.length > LIMIT) { out.push(item.slice(0, LIMIT)); item = item.slice(LIMIT); }
      out.push(item);
    });
    return out;
  }
  function buildChunks() {
    var list = pieces(entries());
    if (!list.length) return [];
    var bodies = [], current = '';
    list.forEach(function (item) {
      var next = current ? current + '\n\n' + item : item;
      if (current && next.length > LIMIT) { bodies.push(current); current = item; } else { current = next; }
    });
    if (current) bodies.push(current);
    return bodies.map(function (body, index) {
      var head = bodies.length > 1 ? MARKER + ' (' + (index + 1) + '/' + bodies.length + ')' : MARKER;
      return head + '\n' + body;
    });
  }
  function fallbackCopy(text) {
    var helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(helper);
    return ok;
  }
  function copyText(text, status) {
    function done(ok) { status.textContent = ok ? '已复制' : '复制失败，请手动选中复制'; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else {
      done(fallbackCopy(text));
    }
  }
  var holder = document.getElementById('summary-chunks');
  var empty = document.getElementById('summary-empty');
  var status = document.getElementById('copy-status');
  function render() {
    var chunks = buildChunks();
    while (holder.firstChild) holder.removeChild(holder.firstChild);
    empty.style.display = chunks.length ? 'none' : 'block';
    chunks.forEach(function (chunk, index) {
      var pre = document.createElement('pre');
      pre.className = 'out';
      pre.textContent = chunk;
      holder.appendChild(pre);
      if (chunks.length > 1) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = '复制第 ' + (index + 1) + ' 段';
        button.addEventListener('click', function () { copyText(chunk, status); });
        holder.appendChild(button);
      }
    });
  }
  areas.forEach(function (area) {
    area.value = load(area.getAttribute('data-comment'));
    area.addEventListener('input', function () { save(area.getAttribute('data-comment'), area.value); render(); });
  });
  document.getElementById('copy-all').addEventListener('click', function () {
    var chunks = buildChunks();
    if (!chunks.length) { status.textContent = '还没有意见可复制'; return; }
    copyText(chunks.join('\n\n'), status);
  });
  render();
})();
"""

PAGE = (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1">'
    f"<title>{ISSUE} Raya 割接恢复设计</title><style>{CSS}</style></head><body><div class=\"wrap\">"
    f"<h1>{ISSUE} · Raya 割接为什么还卡着，以及怎么走完</h1>"
    '<div class="sub">工程设计说明（给 founder）· 2026-09-18 · 设计已修订：三处最小代码改动（取代原「零代码」结论）</div>'
    + "".join(BODY)
    + SUMMARY
    + f'</div><script nonce="__CSP_NONCE__">{SCRIPT}</script></body></html>'
)

(HERE / "founder-design.html").write_text(PAGE, encoding="utf-8")
print(len(PAGE.encode("utf-8")))
