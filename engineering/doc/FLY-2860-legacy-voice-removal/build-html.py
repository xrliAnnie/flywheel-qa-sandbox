#!/usr/bin/env python3
"""Build founder-design.html for FLY-2860 (inline SVG diagrams, comment layer)."""
import html
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ISSUE = "FLY-2860"


def svg(name: str) -> str:
    p = HERE / f"{name}.svg"
    if not p.exists():
        return '<div class="pending">DIAGRAM PENDING LOCAL RENDER — ' + html.escape(name) + ".mmd</div>"
    return p.read_text(encoding="utf-8")


def e(s: str) -> str:
    return html.escape(s, quote=True)


SECTIONS = [
    (
        "summary",
        "一句话",
        """<p class="lead">把 7 月那三套旧语音——<code>/gemini</code>（含 <code>/gemini-advanced</code>）、<code>/eleven</code>、<code>/glaw</code>——连同托着它们的旧守护进程、测试台架、配置和部署步骤一次删干净；生产在用的语音（voice-codex，引擎 B）一行不动。</p>
<p>「守护进程」= 一直在后台跑着的程序。旧的三套命令都住在一个叫 <b>voice-bridge 守护进程</b>的程序里；这台机器上它根本没装、也起不来（所有项目都没有它需要的 <code>huddle</code> 配置），所以删它不影响任何正在用的东西。</p>
<div class="kpis">
<div class="kpi"><div class="n">62</div><div class="l">只被旧命令用的源文件<br>整文件删除</div></div>
<div class="kpi"><div class="n">18</div><div class="l">生产和旧命令共用的文件<br>保留并写明谁在用</div></div>
<div class="kpi"><div class="n">77</div><div class="l">只测旧命令的测试文件<br>随代码删除</div></div>
<div class="kpi"><div class="n">4</div><div class="l">Discord 上残留的旧斜杠命令<br>用脚本删掉</div></div>
</div>""",
    ),
    (
        "flow",
        "核心流程：删前 vs 删后",
        """<p>左边是今天：founder 在语音房里说话走的是 voice-codex；旧的 voice-bridge 守护进程挂着三套斜杠命令（「斜杠命令」= 在 Discord 输入框打 <code>/gemini</code> 这种以斜杠开头的指令）。右边是删完：只剩 voice-codex，它继续借用 voice-bridge 里「连 Discord」的那一小块代码（我们叫它「库面」= 被别的程序引用的代码，而不是自己跑起来的程序）。</p>
<div class="diagram">""" + svg("d1-flow") + """</div>""",
    ),
    (
        "model",
        "结构模型：怎么证明「只被旧命令用」",
        """<p>不是靠人眼数，而是跑一个<b>引用图脚本</b>（<code>refgraph.mjs</code>，「引用图」= 把每个文件 import 了哪些文件画成一张网）。从生产程序出发能走到的文件必须留；只有从旧命令出发才能走到的文件才删。两边都能走到的就是「共用」，保留并在 PR 里列出是谁在用。</p>
<div class="diagram">""" + svg("d2-graph") + """</div>
<table>
<tr><th>类别</th><th>例子</th><th>处理</th></tr>
<tr><td><span class="badge close">删</span> 只被旧命令到达</td><td>voice-bridge 的 assistant / eleven / huddle 目录、cli.ts、SessionSlot、VoiceRoomRuntime；gemini-agent 整包；voice-core 的 Gemini Live 与 Resident brain</td><td>整文件删</td></tr>
<tr><td><span class="badge update">剪</span> 混合文件</td><td>voice-core 的 factory / config / cli / index；voice-bridge 的 index / discordWiring / package.json；teamlead 的 ProjectConfig</td><td>保留文件，只删旧段落</td></tr>
<tr><td><span class="badge new">留</span> 共用</td><td>BotRegistry、discordWiring（voice-codex 在用）；voice-core 的 edge-tts、scrub、transcript、types</td><td>原样保留</td></tr>
</table>
<p class="dim">「混合文件」= 一个文件里既有生产在用的代码、也有旧命令的代码，只能剪段落不能整删。剪完再跑一次引用图 + 类型检查（tsc，TypeScript 编译器，能发现删漏的引用）。</p>""",
    ),
    (
        "retire",
        "Discord 残留命令怎么清",
        """<p>程序停了，已经注册到 Discord 的斜杠命令<b>不会自己消失</b>，founder 点了只会看到「应用未响应」。所以做一个可以反复跑的退役脚本：默认只看不删（dry-run，「演习模式」），加 <code>--apply</code> 才真删；只删「斜杠命令类型」且名字精确等于 <code>glaw / gemini / gemini-advanced / eleven</code> 的命令，删完再查一次必须为空。当年是哪个机器人注册的，要写进一份受版本控制的「必查目标清单」；清单里有任何一个目标没查到（没口令、被拒绝），就不算清理完成——避免「什么都没查到」被误当成「已经删干净」。机器人口令（token）只用来发请求，绝不打印、不写进回执。</p>
<div class="diagram">""" + svg("d3-retire") + """</div>""",
    ),
    (
        "tradeoffs",
        "取舍与否决的方案",
        """<div class="card green"><div class="card-title">采用：按引用图整删 + 旧守护进程一起下线</div><div class="card-reason">守护进程是三套旧命令的壳，壳里没有别的生产功能；删命令等于删壳。部署脚本里对应那一步今天在生产上本来就是空操作。</div></div>
<div class="card red"><div class="card-title">否决：只删命令，留一个空壳守护进程</div><div class="card-reason">它起不来也没人用，留着只会让每次部署继续维护一条永远空转的步骤。</div></div>
<div class="card red"><div class="card-title">否决：顺手删 Bridge 侧的 gemini-agent 专用口令和 resident 认领接口</div><div class="card-reason">那是 Bridge（中控服务）的鉴权面，约 50 处路由，风险和「删语音」不是一个量级。Lead 裁定写进 PR 后续事项，本单不动。</div></div>
<div class="card amber"><div class="card-title">取舍：历史文档不删</div><div class="card-reason">engineering/doc 等目录里约 560 个文件提到 gemini/eleven，是档案。QA 的全仓搜索用一份「允许清单」排除它们，每一类残留都写明归属。</div></div>""",
    ),
    (
        "boundary",
        "诚实的边界：做什么、不做什么",
        """<table>
<tr><th>会做</th><th>不会做</th></tr>
<tr><td>删三套旧命令、gemini-agent 包、旧守护进程和它的部署步骤（部署脚本改动先写一个会失败的测试，再改到通过）</td><td>不碰 voice-codex、voice-headphone 的任何行为</td></tr>
<tr><td>删 voice-core 里的 Gemini Live 语音与 POC 的 talk 子命令</td><td>不删 Gemini 作为「写代码的 runner」、不删 Gemini 评审 / 生图技能</td></tr>
<tr><td>删只服务旧命令的开关登记、CI 步骤、依赖、spike 实验目录</td><td>不改 Bridge 鉴权面和 resident 接口（写进后续）</td></tr>
<tr><td>提供退役脚本，由 QA 在真 Discord 上跑一次删残留命令</td><td>不在 CI 里碰真 Discord；删掉的 Discord 命令无法靠回滚代码恢复（它们今天也没人处理）</td></tr>
<tr><td>保留 <code>huddle</code> 配置键作为「旧语音冲突」标记，四处拒启守卫不变</td><td>本机 <code>.env</code> 里的 ElevenLabs 密钥不在仓库内，是否吊销由你决定</td></tr>
</table>
<p class="dim">实现前一步：先合入最新 main，重跑引用图；清单若和本文不同，以重跑结果为准，出现没点名的新共用文件就停下来问 Lead。</p>""",
    ),
    (
        "qa",
        "怎么验收",
        """<table>
<tr><th>#</th><th>判据</th><th>证据</th></tr>
<tr><td>1</td><td>全仓搜 eleven / gemini，除允许清单外为零</td><td><code>residue-check.sh</code> 退出码 0</td></tr>
<tr><td>2</td><td>Discord 上没有四个旧斜杠命令</td><td>退役脚本 apply 后再查：必查目标全部查到、命中为空</td></tr>
<tr><td>3</td><td>生产语音不回归</td><td>voice-codex 全量单测、529 语音测试、引擎 B 真开一场 ≥60 秒</td></tr>
<tr><td>4</td><td>CI 全绿、打包冒烟通过</td><td>精确头 CI 链接；在旧构建过的目录上重建打包，旧编译产物（dist，编译后的 JS）一个都不剩</td></tr>
</table>""",
    ),
]

CSS = r"""
:root{--bg:#f5f5f7;--fg:#1d1d1f;--dim:#86868b;--card:#fff;--navy:#1a365d;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,system-ui,sans-serif;line-height:1.6}
.wrap{max-width:960px;margin:0 auto;padding:28px 16px 80px}
h1{font-size:26px;margin:0 0 4px;color:var(--navy)}
.sub{color:var(--dim);font-size:14px;margin-bottom:24px}
.section{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:20px 22px;margin:18px 0;border-left:4px solid var(--blue)}
.section h2{font-size:19px;margin:0 0 10px;color:var(--navy)}
.lead{font-size:17px;font-weight:600}
code{font-family:'SF Mono',ui-monospace,monospace;font-size:13px;background:#f0f0f3;padding:1px 5px;border-radius:5px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:14px}
.kpi{background:var(--bg);border-radius:10px;padding:12px}
.kpi .n{font-size:28px;font-weight:700;color:var(--navy)}
.kpi .l{font-size:13px;color:var(--dim)}
.diagram{overflow-x:auto;background:#fff;border:1px solid #e5e5ea;border-radius:10px;padding:10px;margin:12px 0}
.diagram svg{max-width:100%;height:auto}
.pending{padding:30px;text-align:center;color:var(--amber);font-weight:700;border:2px dashed var(--amber);border-radius:10px}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:14px}
th,td{text-align:left;padding:8px;border-bottom:1px solid #ececf0;vertical-align:top}
th{color:var(--dim);font-weight:600}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:1px 7px;border-radius:6px;color:#fff}
.badge.close{background:var(--red)}.badge.update{background:var(--amber)}.badge.new{background:var(--green)}
.card{border-radius:10px;padding:12px 14px;margin:10px 0;background:var(--bg);border-left:4px solid var(--blue)}
.card.red{border-left-color:var(--red)}.card.green{border-left-color:var(--green)}.card.amber{border-left-color:var(--amber)}
.card-title{font-weight:700}.card-reason{font-size:14px;color:#3a3a3c}
.dim{color:var(--dim);font-size:13px}
.cm{margin-top:14px}
.cm label{font-size:12px;color:var(--dim);display:block;margin-bottom:4px}
.cm textarea{width:100%;min-height:60px;border:1px solid #d2d2d7;border-radius:8px;padding:8px;font:inherit;font-size:14px;resize:vertical}
.summary{border-left-color:var(--purple)}
.chunk{white-space:pre-wrap;background:var(--bg);border-radius:8px;padding:10px;font-size:13px;margin:8px 0;font-family:'SF Mono',ui-monospace,monospace}
button{background:var(--blue);color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}
#copyState{margin-left:10px;font-size:13px;color:var(--dim)}
"""

JS = r"""
(function(){
  var ISSUE = 'FLY-2860';
  var MARK = '【页面意见汇总】' + ISSUE;
  var PREFIX = 'fwcomments:' + location.pathname + ':';
  var LIMIT = 1800;
  function load(k){ try { return localStorage.getItem(PREFIX + k) || ''; } catch (err) { return ''; } }
  function save(k, v){ try { localStorage.setItem(PREFIX + k, v); } catch (err) { /* storage unavailable */ } }
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-key]'));
  function chunks(){
    var parts = [];
    areas.forEach(function(a){
      var v = a.value.trim();
      if (v) parts.push('【' + a.getAttribute('data-title') + '】\n' + v);
    });
    if (!parts.length) return [];
    var out = [];
    var cur = MARK;
    parts.forEach(function(p){
      var next = cur + '\n\n' + p;
      if (next.length > LIMIT && cur !== MARK) { out.push(cur); cur = MARK + '\n\n' + p; }
      else { cur = next; }
    });
    out.push(cur);
    return out;
  }
  var box = document.getElementById('summaryChunks');
  function render(){
    var cs = chunks();
    box.textContent = '';
    if (!cs.length) { var p = document.createElement('p'); p.className = 'dim'; p.textContent = '还没有意见。在上面任意一节下方写下即可，自动保存在本浏览器。'; box.appendChild(p); return; }
    cs.forEach(function(c, i){
      var d = document.createElement('div'); d.className = 'chunk';
      d.textContent = (cs.length > 1 ? '（第 ' + (i + 1) + '/' + cs.length + ' 段）\n' : '') + c;
      box.appendChild(d);
    });
  }
  areas.forEach(function(a){
    a.value = load(a.getAttribute('data-key'));
    a.addEventListener('input', function(){ save(a.getAttribute('data-key'), a.value); render(); });
  });
  render();
  var state = document.getElementById('copyState');
  function fallback(text){
    try {
      var t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', '');
      t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
      var ok = document.execCommand('copy'); document.body.removeChild(t);
      state.textContent = ok ? '已复制' : '复制失败，请手动选中上方文字';
    } catch (err) { state.textContent = '复制失败，请手动选中上方文字'; }
  }
  document.getElementById('copyAll').addEventListener('click', function(){
    var text = chunks().join('\n\n');
    if (!text) { state.textContent = '没有可复制的意见'; return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ state.textContent = '已复制'; }, function(){ fallback(text); });
    } else { fallback(text); }
  });
})();
"""


def main() -> None:
    body = []
    for key, title, content in SECTIONS:
        body.append(
            f'<div class="section" id="{e(key)}"><h2>{e(title)}</h2>{content}'
            f'<div class="cm"><label for="c-{e(key)}">对本节的意见（自动保存）</label>'
            f'<textarea id="c-{e(key)}" data-key="{e(key)}" data-title="{e(title)}"></textarea></div></div>'
        )
    page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(ISSUE)} 删除三套旧语音</title><style>{CSS}</style></head>
<body><div class="wrap">
<h1>{e(ISSUE)} · 删除三套旧语音命令</h1>
<div class="sub">设计方案 · 2026-09-25 · 基线 main + #1306（引擎 B）</div>
{''.join(body)}
<div class="section summary"><h2>意见汇总</h2>
<p class="dim">上面各节写的意见会自动汇总到这里；点按钮一次复制全部（超长会自动分段，每段都带开头标记）。这是修改意见，不代表通过。</p>
<div id="summaryChunks"></div>
<button id="copyAll" type="button">复制全部意见</button><span id="copyState"></span>
</div>
</div>
<script nonce="__CSP_NONCE__">{JS}</script>
</body></html>
"""
    (HERE / "founder-design.html").write_text(page, encoding="utf-8")


if __name__ == "__main__":
    main()
