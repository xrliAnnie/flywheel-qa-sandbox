#!/usr/bin/env python3
"""Build the FLY-2405 founder design page from static copy + locally rendered Mermaid SVGs.

Render diagrams first:  mmdc -i diagrams/dN-*.mmd -o diagrams/dN-*.svg -w 1000 -b white --svgId FLY-2405-dN
"""
import html
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
DIAG = HERE / "diagrams"


def _round(match: "re.Match[str]") -> str:
    value = round(float(match.group(0)), 1)
    return f"{value:.0f}" if value == int(value) else f"{value:.1f}"


def svg(name: str) -> str:
    raw = (DIAG / name).read_text(encoding="utf-8")
    raw = re.sub(r"<\?xml[^>]*\?>", "", raw)
    # Mermaid 11 draws state nodes as long sketch paths; 1-decimal coordinates are
    # visually lossless here and keep the page under the 512 KB publish cap.
    raw = re.sub(
        r'(<path[^>]* d=")([^"]*)(")',
        lambda m: m.group(1) + re.sub(r"-?\d+\.\d+", _round, m.group(2)) + m.group(3),
        raw,
    )
    return f'<div class="diagram">{raw}</div>'


def esc(text: str) -> str:
    return html.escape(text, quote=True)


SECTIONS = [
    (
        "summary",
        "一句话",
        "blue",
        f"""<p class="lead">给 Bridge 加一个<b>「代客起房 / 拆房」窗口</b>:
在沙箱里的 runner 只要打一条命令提交请求,真正的起房、拆房由沙箱外的 Bridge 去做——
Codex 体和 Claude 体从此走同一条路,Lead 不用再手工代劳。</p>
<p class="gloss"><b>名词小抄</b>(第一次出现的术语):
<b>runner</b> = 替我们干活的 AI 工人(Codex 或 Claude);
<b>沙箱</b> = macOS 给 Codex runner 套的「玻璃罩」,罩里能读写自己的工作目录、能上网,但不能启动系统级后台服务、看不见罩外的进程;
<b>Bridge</b> = Flywheel 的总调度后台程序,本身在罩外运行;
<b>529 测试房</b> = 一套和生产隔离的「迷你 Flywheel」(自己的 Bridge + 测试 Lead + 测试频道),专门给 QA 做真实验证;
<b>房位(slot)</b> = 机器上预先分好的 6 个测试房编号,同一时间一个房位只能住一间房。</p>""",
    ),
    (
        "why",
        "为什么要做",
        "red",
        """<ul>
<li>今天 Codex runner 在罩里跑起房脚本,卡在 <code>launchctl bootstrap</code>(macOS 启动后台服务的命令)这一步,报 <code>Bootstrap failed: 5</code>——罩子不允许它启动系统级后台服务。</li>
<li>罩里看不见罩外进程,所以就算起来了也拆不干净。</li>
<li>结果:今天 FLY-2914 的 Codex QA 体只能靠 Lead 在罩外代起代拆才测完。founder 在 A/B/C 三个方案里选了 <b>A = Bridge 提供起房服务</b>。</li>
<li>顺带有两个已知「拆房坑」今天在 slot 1、slot 4 各撞了一次,本单一起修。</li>
</ul>""",
    ),
    (
        "flow",
        "核心流程:之前 vs 之后",
        "green",
        svg("d1-before-after.svg")
        + """<p>标着「今天」的那块:Codex runner 自己起房必然失败,只能找 Lead。
标着「本设计」的那块:runner 只提交一个<b>结构化请求</b>(只能填预先规定好的几个选项,不能塞任意命令),
Bridge 检查通过后在罩外执行,拆房前先把房里的数据库和日志存一份证据快照。</p>""",
    ),
    (
        "sequence",
        "一次完整的起房 → 验证 → 拆房",
        "blue",
        svg("d2-sequence.svg")
        + """<p class="gloss"><b>head / commit</b> = 某一版代码的唯一指纹(40 位编号);
<b>受信包装器</b> = 一段来自已合入主干的小脚本,负责在罩外按固定步骤执行,不接受请求里的任意命令;
<b>认领口令</b> = Bridge 在房位锁里放的一次性暗号,起房/拆房脚本都要对上暗号才动手,防止拆错别人的房;拆房脚本自己<b>不</b>放房位,等 Bridge 在罩外确认零残留后才凭口令放——中途出错随时可以重拆;
<b>负载 144</b> = 机器 18 个核 × 每核 8 的忙碌度上限,超过就先排队,和现有派工限流用同一个旋钮。</p>""",
    ),
    (
        "states",
        "房间的一生(状态机)",
        "purple",
        svg("d3-states.svg")
        + """<p><b>状态机</b> = 把一间房可能处在的每种状态和允许的转换画清楚。
关键规则:<b>只要真的动过房位,失败也不自动释放</b>——保留现场给人查,只能通过「拆房」离开;
还没动过房位就失败(比如构建失败)的,自动释放,不留垃圾。</p>""",
    ),
    (
        "data",
        "数据 / 结构模型",
        "amber",
        svg("d4-data.svg")
        + """<p>在 Bridge 现有的状态库里新增 4 张表:<b>房间</b>、<b>房位预留</b>(房位号唯一,天然防止两间房抢同一个位)、
<b>操作</b>(每次部署或拆房一条,带「防重复提交」编号,网络重试不会起两间房)、
<b>审计</b>(只能追加、不能改删,放行和拒绝都记)。</p>""",
    ),
    (
        "guards",
        "护栏:谁能做什么",
        "red",
        """<table>
<tr><th>动作</th><th>runner</th><th>Lead</th></tr>
<tr><td>起房</td><td>只有 QA / 实现节点、且自己还在工作中;每个 runner 同时最多 1 间</td><td>可以</td></tr>
<tr><td>拆房</td><td>只能拆自己起的;原主人已结束时,同一张单的后继者可接手</td><td>任何房都能代拆</td></tr>
<tr><td>拆别人的房</td><td>拒绝 + 审计</td><td>—</td></tr>
<tr><td>请求里出现生产服务名(<code>com.flywheel.*</code> 且不是测试房)</td><td colspan="2">拒绝 + 审计</td></tr>
<tr><td>请求里出现没见过的字段</td><td colspan="2">拒绝 + 审计</td></tr>
</table>
<p>另外:代码必须先推到 GitHub 才能起房(保证跑的是可追溯的版本);
房起来后 Bridge 亲自核对「房里跑的版本 == 请求的版本」,对不上就判失败。</p>""",
    ),
    (
        "tradeoffs",
        "关键取舍与被否方案",
        "amber",
        """<ul>
<li><b>否:让 Codex 用「不套罩子」模式跑起房。</b> 等于给 runner 开一个通用越狱口;而且 FLY-2168 已禁止 danger-full-access。</li>
<li><b>否:直接在 runner 自己的工作目录起房。</b> runner 可能边测边改、里面可能有旧的构建产物;改为每间房单独检出一份「这个版本的干净代码」,先 install + build。代价:每次起房多几分钟构建时间。</li>
<li><b>否:多间房共享同一份源码目录省构建时间。</b> 评审发现两个 Bridge(比如测试房里的测试房)会互相删对方的源码;为正确性放弃复用。</li>
<li><b>否:把 codex:rescue(找 Codex 要第二意见)和嵌套 Codex 诊断也塞进本服务。</b> 它们本质是「在罩外跑任意 Codex 会话」,会把一个动作固定的窗口变成万能后门。去向:第二意见改走 Bridge 已有的正式评审门;需要嵌套 Codex 的诊断先交 Claude 体。</li>
<li><b>取:拆房前自动存证据快照。</b> 以前拆房会把房里的数据库和日志一起删掉;现在先用 SQLite 安全导出(<code>VACUUM INTO</code>,不会漏掉还没落盘的写入),导不出来就不拆。</li>
</ul>""",
    ),
    (
        "pits",
        "顺手修的两个拆房坑",
        "green",
        """<ol>
<li><b>「死掉的 Codex 通信口」让拆房被拒。</b> 新版 Codex 的通信口是一个「快捷方式」(软链接),进程死后快捷方式还在;旧的安全检查见到快捷方式就一律拒拆。改为:快捷方式指向的东西不存在 = 已死,清掉继续;指向 Codex 固定目录的活口 = 正常处理;指向别处 = 仍然拒绝。</li>
<li><b>「陈旧的启动标记」让拆房误判。</b> 起房时会先放一个「我要启动了」的标记,即使后来根本没启动成功,拆房也会当它在跑、然后因为关不掉而失败。改为:标记只代表「尝试过」,是否真在跑以真实进程为准;但仍保留「有没有漏网进程」的普查。</li>
</ol>""",
    ),
    (
        "alertduty",
        "范围追加:带告警值守的房",
        "amber",
        """<p><b>告警值守</b> = 专门一个 Lead(生产里是 Claw)负责接住系统告警、跟进处理;<b>B 类工单帖</b> = 告警发到告警频道的帖子,值守 Lead 读到后建单处理。今天测试房里这条链路完全跑不起来,原因有四:</p>
<ol>
<li>值守 Lead 的名字在 6 处代码里写死成生产的 Claw,测试房的 Lead 名字不同,告警找不到主人;</li>
<li>值守接口需要的口令房里从不配置;</li>
<li>发帖的「dispatcher 机器人」身份在测试房里被刻意清掉,硬塞进去 Bridge 还会拒绝启动;</li>
<li>测试 Lead 的频道订阅里没有告警频道。</li>
</ol>
<p><b>方案:</b>起房时可选打开「告警值守」:每间房随机生成一次性口令;值守 Lead 名字改成从一个统一入口读取,<b>只有在测试房里</b>才允许改成测试 Lead,生产里无论环境怎么配都还是 Claw;发帖只用<b>登记在册的测试机器人</b>(名字必须是测试机器人格式,还要向 Discord 核对真实身份,且不能和房里任何 Lead 是同一个机器人),绝不把生产机器人口令放进房;测试 Lead 自动订阅告警频道。前提:Discord 里要先给测试机器人开告警频道权限(这是运维动作,没开会明确报错,不会假装成功)。</p>""",
    ),
    (
        "boundary",
        "诚实边界:做什么 / 不做什么",
        "purple",
        """<p><b>评审:</b>本设计经 Codex(manifest 指定的 gpt-6-astra、最高强度)3 轮评审通过:第 1 轮 6 个阻断、第 2 轮 4 个、第 3 轮 0 个;另有 2 条实现期建议已单独记录。</p>
<p><b>做:</b>runner 一条命令起房/拆房;房位归属与口令防误拆;版本核对;负载排队;证据快照;审计;两个拆房坑;QA 规则改成「要房就调服务」。</p>
<p><b>不做 / 做不到:</b></p>
<ul>
<li>这不是防「恶意 runner」的安全墙:所有 runner 和 Bridge 是同一个系统用户,Claude runner 本来就不在罩里。它防的是「好意但会犯错」的 runner(拆错房、高负载时硬起、带错版本)。信任边界和今天 Lead 手工代起完全一样,没有放宽。</li>
<li>房里需要重启后台服务的演练(比如 restart drill)仍然做不了,留后续。</li>
<li>没人拆的「孤儿房」不会自动回收,只会在列表里标出来,由同单后继或 Lead 处理。</li>
<li>本单自己的验收需要先由 Claude QA 体或 Lead 起一间「外层房」来跑被测版本——因为被测服务合并前还不在生产里;之后的日常使用就全程零手工了。</li>
</ul>""",
    ),
    (
        "acceptance",
        "怎么证明做成了",
        "blue",
        """<ol>
<li>在一间测试房里派一个<b>真的、在罩子里的 Codex runner</b>:用一条命令起一间内层房 → 在里面做一次真验证(版本核对 + 一次带鉴权的接口往返)→ 一条命令拆房 → Bridge 在罩外检查零残留、证据快照齐全。Claude runner 再走一遍。</li>
<li>越权演示:拆别人的房、请求里带生产服务名、带未知字段 → 都被拒,审计里有记录。</li>
<li>拆房坑回归:跑过真 Codex 的房一次拆干净;人为放一个陈旧标记也能拆干净。</li>
<li>合并上线后,第一次真实 Codex QA 用它起房、验证、拆房,Lead 零手工。</li>
</ol>""",
    ),
]

COLORS = {
    "red": "#ff3b30",
    "amber": "#ff9500",
    "blue": "#007aff",
    "green": "#34c759",
    "purple": "#af52de",
}


def card(key: str, title: str, color: str, body: str) -> str:
    return f"""<section class="card {color}" data-section="{esc(key)}" data-title="{esc(title)}">
  <h2><span style="color:{COLORS[color]}">●</span> {esc(title)}</h2>
  <div class="body">{body}</div>
  <label class="cmt-label" for="c-{esc(key)}">我的意见(自动保存在本机浏览器)</label>
  <textarea class="cmt" id="c-{esc(key)}" data-key="{esc(key)}" rows="3" placeholder="写下对这一节的意见…"></textarea>
</section>"""


CSS = """
*{box-sizing:border-box}
body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,system-ui,sans-serif;line-height:1.6}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
header h1{font-size:26px;margin:0 0 4px;color:#1a365d}
header .meta{color:#86868b;font-size:14px}
header .meta code,.issue{font-family:'SF Mono',monospace}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:18px 20px;margin:18px 0;border-left:4px solid #86868b}
.card.red{border-left-color:#ff3b30}.card.amber{border-left-color:#ff9500}.card.blue{border-left-color:#007aff}
.card.green{border-left-color:#34c759}.card.purple{border-left-color:#af52de}
.card h2{font-size:19px;margin:0 0 10px;color:#1a365d}
.lead{font-size:17px}
.gloss{background:#f5f5f7;border-radius:8px;padding:10px 12px;font-size:14px;color:#3a3a3c}
code{font-family:'SF Mono',monospace;font-size:13px;background:#f0f0f3;padding:1px 5px;border-radius:4px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border-bottom:1px solid #e5e5ea;padding:8px;text-align:left;vertical-align:top}
th{color:#1a365d}
.diagram{overflow-x:auto;margin:10px 0;border:1px solid #e5e5ea;border-radius:10px;background:#fff;padding:8px}
.diagram svg{max-width:100%;height:auto}
.cmt-label{display:block;margin-top:14px;font-size:13px;color:#86868b}
.cmt{width:100%;margin-top:4px;border:1px solid #d2d2d7;border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;resize:vertical;background:#fbfbfd}
.cmt:focus{outline:none;border-color:#007aff;background:#fff}
#summary-card pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f7;border-radius:8px;padding:10px;font-family:'SF Mono',monospace;font-size:13px;min-height:40px}
.btn{background:#007aff;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;margin:6px 8px 6px 0}
.btn.secondary{background:#e5e5ea;color:#1d1d1f}
#copy-status{font-size:13px;color:#86868b}
.chunk{margin-top:12px}
.chunk-head{font-size:13px;color:#86868b}
@media (max-width:600px){.card{padding:14px}header h1{font-size:21px}}
"""

JS = r"""
(function(){
  var MARKER = '【页面意见汇总】FLY-2405';
  var LIMIT = 1800;
  var PREFIX = 'fly2405-comments:' + location.pathname + ':';
  function load(k){ try { return localStorage.getItem(PREFIX + k) || ''; } catch (e) { return ''; } }
  function save(k, v){ try { localStorage.setItem(PREFIX + k, v); } catch (e) {} }
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea.cmt'));
  function collect(){
    var items = [];
    areas.forEach(function(a){
      var v = a.value.trim();
      if (!v) return;
      var sec = a.closest('section');
      items.push('【' + (sec ? sec.getAttribute('data-title') : a.getAttribute('data-key')) + '】\n' + v);
    });
    return items;
  }
  function chunks(items){
    var out = []; var cur = MARKER;
    items.forEach(function(it){
      var add = '\n\n' + it;
      if (cur.length + add.length > LIMIT && cur !== MARKER) { out.push(cur); cur = MARKER; }
      cur += add;
    });
    if (items.length) out.push(cur);
    return out;
  }
  var box = document.getElementById('summary-chunks');
  var empty = document.getElementById('summary-empty');
  var status = document.getElementById('copy-status');
  function copyText(text){
    function fallback(){
      var t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(t);
      status.textContent = ok ? '已复制' : '复制失败,请手动选择文本复制';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ status.textContent = '已复制'; }, fallback);
    } else { fallback(); }
  }
  function render(){
    var parts = chunks(collect());
    while (box.firstChild) box.removeChild(box.firstChild);
    empty.style.display = parts.length ? 'none' : 'block';
    parts.forEach(function(p, i){
      var wrap = document.createElement('div'); wrap.className = 'chunk';
      var head = document.createElement('div'); head.className = 'chunk-head';
      head.textContent = '第 ' + (i + 1) + ' / ' + parts.length + ' 段(' + p.length + ' 字)';
      var pre = document.createElement('pre'); pre.textContent = p;
      var btn = document.createElement('button'); btn.className = 'btn secondary'; btn.type = 'button';
      btn.textContent = '复制这一段';
      btn.addEventListener('click', function(){ copyText(p); });
      wrap.appendChild(head); wrap.appendChild(pre); wrap.appendChild(btn);
      box.appendChild(wrap);
    });
  }
  areas.forEach(function(a){
    a.value = load(a.getAttribute('data-key'));
    a.addEventListener('input', function(){ save(a.getAttribute('data-key'), a.value); render(); });
  });
  document.getElementById('copy-all').addEventListener('click', function(){
    var parts = chunks(collect());
    if (!parts.length) { status.textContent = '还没有任何意见'; return; }
    copyText(parts.join('\n\n'));
  });
  render();
})();
"""


def main() -> None:
    cards = "\n".join(card(*s) for s in SECTIONS)
    page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-2405 起房服务设计</title>
<style>{CSS}</style>
</head>
<body>
<main>
<header>
  <h1>起房服务:让 runner 自己起 / 拆测试房</h1>
  <div class="meta"><span class="issue">FLY-2405</span> · 设计阶段 · 2026-09-26 · 方案 A(founder 已选)</div>
</header>
{cards}
<section class="card blue" id="summary-card">
  <h2><span style="color:#007aff">●</span> 意见汇总</h2>
  <p>上面每节写的意见会自动汇总到这里(以 <code>{esc('【页面意见汇总】FLY-2405')}</code> 开头;超过约 1800 字自动分段,每段都带这个标记)。这是修改意见,不代表通过。</p>
  <button class="btn" id="copy-all" type="button">复制全部意见</button> <span id="copy-status"></span>
  <p id="summary-empty" style="color:#86868b">还没有任何意见。</p>
  <div id="summary-chunks"></div>
</section>
</main>
<script nonce="__CSP_NONCE__">{JS}</script>
</body>
</html>
"""
    (HERE / "founder-design.html").write_text(page, encoding="utf-8")
    print("wrote", HERE / "founder-design.html", len(page))


if __name__ == "__main__":
    main()
