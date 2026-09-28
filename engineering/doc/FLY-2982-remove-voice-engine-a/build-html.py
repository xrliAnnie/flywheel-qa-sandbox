#!/usr/bin/env python3
"""Build the FLY-2982 founder design page: inline local mmdc SVGs, one nonced script, no external fetches."""
import html
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "fly2982-remove-voice-engine-a-design.html"


def svg(n: int) -> str:
    path = HERE / f"d{n}.svg"
    if not path.exists():
        return ('<div class="pending">DIAGRAM PENDING LOCAL RENDER — Mermaid 源文件 '
                f'd{n}.mmd 保留在同目录</div>')
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"<\?xml[^>]*>", "", text)
    # shrink long float coordinates (stateDiagram bloat) without changing the picture
    text = re.sub(r'="[^"]*"', lambda m: re.sub(r"(\d+\.\d{2})\d+", r"\1", m.group(0)), text)
    # stateDiagram edge/node ids are not scoped by --svgId; scope every id per diagram
    ids = sorted(set(re.findall(r'\sid="([^"]+)"', text)), key=len, reverse=True)
    for ident in ids:
        if ident.startswith(f"FLY-2982-d{n}"):
            continue
        scoped = f"d{n}-{ident}"
        text = text.replace(f'id="{ident}"', f'id="{scoped}"')
        text = text.replace(f"#{ident})", f"#{scoped})").replace(f'#{ident}"', f'#{scoped}"')
    return text


def esc(s: str) -> str:
    return html.escape(s, quote=True)


SECTIONS = []


def card(key: str, title: str, color: str, body: str) -> None:
    SECTIONS.append(
        f'<div class="card {color}" data-section="{esc(title)}">'
        f"<h2>{esc(title)}</h2>{body}"
        f'<div class="comment-box"><label for="c-{key}">对这一节的评论(自动保存在本机浏览器)</label>'
        f'<textarea id="c-{key}" data-key="{key}" placeholder="写下你的意见…"></textarea></div></div>'
    )


card("summary", "一句话结论", "green", """
<p class="lead-line"><b>把旧语音引擎 A(用 OpenAI 按量付费 API key 的那一套)从仓库里整个删掉;语音守护进程从此只有引擎 B(WebRTC + ChatGPT 订阅)一条路,不留开关、不留回退。</b></p>
<ul>
<li><b>引擎</b>:语音守护进程里负责「听你说话、生成回答声音」的那一层。今天有 A、B 两个,靠一个环境变量挑。</li>
<li><b>环境变量 / 开关</b>:启动程序时读的一行配置。生产上从来没写这一行,所以<b>今天生产默认跑的其实是 A</b>。</li>
<li>合入并部署后,下一次开语音就只会是 B。你已接受:从现在到 FLY-2886(语音大脑)上线之间,生产没有可用语音。</li>
</ul>
<div class="kpis">
<div class="kpi"><div class="v">42 → 0</div><div class="k">含 A 标识的文件(除墓碑/负向测试逐行白名单)</div></div>
<div class="kpi"><div class="v">0</div><div class="k">保留的引擎开关</div></div>
<div class="kpi"><div class="v">0</div><div class="k">需要的 OpenAI API key</div></div>
<div class="kpi"><div class="v">2 轮</div><div class="k">Codex 设计评审(R2 通过)</div></div>
</div>
""")

card("flow", "核心流程:删之前 vs 删之后", "blue", f"""
<div class="diagram">{svg(1)}</div>
<ul>
<li><b>wrapper</b>(启动壳):launchd 拉起语音守护进程前先跑的脚本,负责检查凭据和二进制。删后它不再看引擎开关,<b>无条件</b>清掉进程环境里的 API key,再检查订阅凭据与钉死的 Codex 0.156.1。</li>
<li>生产 <code>.env</code> 里就算还留着旧的 <code>OPENAI_API_KEY</code> 或旧开关值,也只会被忽略,照样跑 B。</li>
</ul>
""")

card("steps", "怎么删:6 个提交,消费者先、提供者后", "purple", f"""
<div class="diagram">{svg(2)}</div>
<ul>
<li><b>消费者先放松</b>:守护进程(消费者)今天强制要求 Bridge 在「会话投影」里带旧声线字段;先让它不再要求,Bridge(生产者)再停发,中间任何一个提交都能独立构建、测试。<b>会话投影</b> = Bridge 开会时交给语音守护进程的一份「这场会是谁、用什么声线、进哪个房」的说明。</li>
<li><b>旗标登记</b>(仓库里记录「代码读了哪些环境变量」的表)要和最后一个读它的脚本同一个提交删掉,否则中间提交的漂移测试会红 —— 这是 Codex 第 1 轮抓到的。</li>
<li><b>残留检查</b>:一个脚本按固定关键字全仓搜索(历史文档除外),只放行三类具体行:墓碑、剥离旧配置键的代码、证明「旧值无效」的负向测试;其余任何命中都失败。</li>
</ul>
""")

card("data", "数据与结构:声线字段怎么迁移", "amber", f"""
<div class="diagram">{svg(3)}</div>
<ul>
<li><b>不改线上配置</b>:你机器上 17 个 Lead 的 <code>projects.json</code> 里都还有旧键 <code>realtimeVoice</code>;Bridge 加载时直接剥掉它,不报错、不刷日志;配置脚本下次写入时顺手删。</li>
<li><b>声线</b>:只剩 <code>liveVoice</code>。8 个没设的 Lead 用缺省 cove —— 这是 FLY-2885 已定的 B 缺省。</li>
<li><b>没有数据迁移</b>:语音会话表里没有「引擎」这一列;历史会话照旧保存。</li>
</ul>
""")

card("tradeoffs", "关键取舍与否掉的方案", "red", """
<div class="scroll"><table class="tbl">
<tr><th>问题</th><th>选择</th><th>否掉的方案</th></tr>
<tr><td>引擎开关</td><td>整个删掉,旧值一律无效</td><td>只接受 B 的单档开关(没意义,还会把一行陈旧配置变成事故);缺省改成 B(留了回退口子)</td></tr>
<tr><td>旧声线键</td><td>加载时静默剥离</td><td>加载时拒绝 —— 部署那一刻 17 个 Lead 全部加载失败,Bridge 起不来</td></tr>
<tr><td>和 FLY-2886 的冲突</td><td>只碰躲不开的文件、最小改动,本单先合,PR 附合并指南</td><td>等 2886 先合(违背「写好马上合」);顺手重构共用文件(冲突最大)</td></tr>
<tr><td>只剩 A 在用的放音链、话语投递</td><td><b>明示例外</b>:本 PR 后生产没有调用方,但它们缠在 2886 正在返工的 4 个文件里,等 2886 合入后再删(Lead 裁定)</td><td>本单一起删 —— 要重写 2886 的文件,合得最慢</td></tr>
<tr><td>共用类型 <code>RealtimeAudioOwner</code></td><td>留在 <code>realtime.ts</code>,文件只剩这个类型</td><td>挪到新文件 —— 要改 4 个 2886 文件的 import</td></tr>
</table></div>
""")

card("inflight", "挂在 A 上的单(只列给 Lead,本单不改任何 Linear 单)", "navy", """
<div class="scroll"><table class="tbl">
<tr><th>单</th><th>现状</th><th>建议</th></tr>
<tr><td class="n">FLY-2863 · #1314</td><td>进行中,分支用了旧声线字段、旧前台和 OpenAI 朗读端点</td><td>关 PR,基于 B 重开(FLY-2888 已写「挪 2796/2863 可用」)</td></tr>
<tr><td class="n">FLY-1451</td><td>语音 Epic,9-25 已写「A 整条线不做」</td><td>更新 Epic 文字</td></tr>
<tr><td class="n">FLY-2021</td><td>「v3 WebRTC 握手被拒」</td><td>已被 FLY-2885 解决,可关</td></tr>
<tr><td class="n">FLY-1172 / FLY-963</td><td>Gemini 时代的观测/转写单</td><td>Gemini 已在 FLY-2860 退役,可关</td></tr>
</table></div>
<p class="sub">怎么处理由 Lead 和你定;本单只在 PR 里列出。</p>
""")

card("boundary", "诚实边界:做什么、不做什么", "amber", """
<h3>做</h3>
<ul>
<li>删掉 A 的全部入口与调用:引擎本体、连接层、引擎开关、API key 要求、旧声线字段、只属于 A 的结束原因、A 专用测试与脚本、A 的早期原型。</li>
<li>用残留检查脚本证明「搜不到」,并证明生产目录里编译出来的旧文件也会被清掉(编译器不会自己删)。</li>
</ul>
<h3>不做</h3>
<ul>
<li>不改你机器上的任何线上配置、不重启服务、不做语音真房测试(A 删了没东西可测;B 的真房归 FLY-2886)。</li>
<li>不删两处明示例外(旧放音链、旧话语投递):本 PR 后生产不再调用它们,2886 合入后由 Lead 另开单删除。</li>
<li>不动与引擎无关的旧入口守卫(huddle 拒绝、CoS voiceIntent、voice master 禁令)。</li>
<li><b>从合入到 FLY-2886 上线,生产没有可用语音</b>(你已接受)。回滚 = 撤销这个 PR,A 原样回来。</li>
</ul>
""")


HEAD = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>删除语音引擎 A</title>
<style>
:root{--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--dim:#86868b;--line:#e5e5ea;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de;--navy:#1a365d;--greenbg:#eefaf1;--redbg:#fff1f0}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,system-ui,"PingFang SC","Hiragino Sans GB",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;line-height:1.3;margin:0 0 6px;color:var(--navy)}h2{font-size:19px;margin:0 0 8px;color:var(--navy)}h3{font-size:15px;margin:14px 0 6px}
.sub{color:var(--dim);font-size:13px}
.card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px;margin:16px 0;border-left:4px solid var(--line)}
.card.red{border-left-color:var(--red)}.card.amber{border-left-color:var(--amber)}.card.blue{border-left-color:var(--blue)}.card.green{border-left-color:var(--green)}.card.purple{border-left-color:var(--purple)}.card.navy{border-left-color:var(--navy)}
ul{padding-left:20px;margin:6px 0}li{margin:3px 0}
.lead-line{font-size:16px}
.kpis{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}.kpi{flex:1 1 150px;background:#fafafc;border-radius:10px;padding:10px 12px}
.kpi .v{font-size:22px;font-weight:700;color:var(--navy)}.kpi .k{font-size:12px;color:var(--dim)}
.badge{display:inline-block;font-size:12px;line-height:1;padding:4px 8px;border-radius:10px;font-weight:600;white-space:nowrap}.ok{background:var(--greenbg);color:#1e7d32}.no{background:var(--redbg);color:#c4271d}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;border-collapse:collapse;font-size:14px}.tbl th,.tbl td{text-align:left;vertical-align:top;padding:7px 6px;border-top:1px solid var(--line)}
.tbl th{font-size:12px;color:var(--dim);font-weight:600;border-top:none;white-space:nowrap}.tbl td.n{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:13px;white-space:nowrap}
.diagram{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0;overflow-x:auto}.diagram svg{display:block;margin:0 auto;max-width:100%;height:auto}
.pending{padding:24px;text-align:center;border:2px dashed var(--amber);border-radius:10px;color:#a35a00;font-weight:600}
.comment-box{margin-top:16px;padding-top:12px;border-top:1px dashed var(--line)}.comment-box label{font-size:13px;color:var(--dim);display:block;margin-bottom:6px}
.comment-box textarea{width:100%;min-height:60px;border:1px solid #d2d2d7;border-radius:8px;padding:10px;font-family:inherit;font-size:14px;resize:vertical;background:#fbfbfd;color:var(--text)}
.chunk{margin:10px 0;padding:10px;border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;font-size:13px;background:#fbfbfd}
.chunk-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:12px;color:var(--dim)}
.btn{background:var(--navy);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}.btn.small{padding:4px 10px;font-size:12px}
#copy-status{margin-left:10px;font-size:13px;color:var(--dim)}.empty-note{color:var(--dim)}
</style></head><body><div class="wrap">
<h1>语音 · 删除旧引擎 A,引擎 B 成为唯一引擎</h1>
<div class="sub">FLY-2982 · 设计 · 2026-09-27 · Codex 设计评审 2 轮通过 · Lead 已裁定保留范围</div>
"""

SUMMARY = """
<div class="card navy" id="summary-card"><h2>💬 你的评论汇总</h2>
<p class="sub">上面每一节的评论会实时汇总到这里(存在本机浏览器)。复制出来的文字以「【页面意见汇总】FLY-2982」开头;太长会自动分段,每段都带这个开头。这是修改意见,不代表通过。</p>
<div id="summary-list"></div>
<button class="btn" id="copy-all" type="button">复制全部评论</button><span id="copy-status"></span>
</div>
"""

SCRIPT = r"""
<script nonce="__CSP_NONCE__">
(function () {
  'use strict';
  var MARK = '【页面意见汇总】FLY-2982';
  var LIMIT = 1800;
  var PREFIX = 'fly2982:' + location.pathname + ':comment:';
  function lsGet(k) { try { return localStorage.getItem(PREFIX + k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch (e) {} }
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-key]'));
  function titleOf(a) { var c = a.closest('.card'); return (c && c.getAttribute('data-section')) || '未命名'; }
  function entries() {
    var out = [];
    areas.forEach(function (a) { var v = a.value.trim(); if (v) out.push('【' + titleOf(a) + '】' + v); });
    return out;
  }
  function chunks() {
    var list = entries(); if (!list.length) return [];
    var parts = [], cur = '';
    list.forEach(function (e) {
      while (e.length > LIMIT) { if (cur) { parts.push(cur); cur = ''; } parts.push(e.slice(0, LIMIT)); e = e.slice(LIMIT); }
      if (cur && (cur.length + e.length + 2) > LIMIT) { parts.push(cur); cur = ''; }
      cur = cur ? cur + '\n\n' + e : e;
    });
    if (cur) parts.push(cur);
    var n = parts.length;
    return parts.map(function (p, i) { return MARK + (n > 1 ? ' (' + (i + 1) + '/' + n + ')' : '') + '\n' + p; });
  }
  function fallbackCopy(t) {
    var ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta); return ok;
  }
  function setStatus(m) { var el = document.getElementById('copy-status'); el.textContent = m; setTimeout(function () { el.textContent = ''; }, 3000); }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { setStatus('✅ 已复制'); },
        function () { setStatus(fallbackCopy(t) ? '✅ 已复制' : '❌ 复制失败'); });
    } else { setStatus(fallbackCopy(t) ? '✅ 已复制' : '❌ 复制失败'); }
  }
  function render() {
    var list = document.getElementById('summary-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    var cs = chunks();
    if (!cs.length) { var p = document.createElement('p'); p.className = 'empty-note'; p.textContent = '还没有评论。'; list.appendChild(p); return; }
    cs.forEach(function (c, i) {
      var box = document.createElement('div'); box.className = 'chunk';
      var head = document.createElement('div'); head.className = 'chunk-head';
      var lab = document.createElement('span'); lab.textContent = '第 ' + (i + 1) + ' 段 / 共 ' + cs.length + ' 段';
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn small'; btn.textContent = '复制这一段';
      btn.addEventListener('click', function () { copyText(c); });
      head.appendChild(lab); head.appendChild(btn);
      var body = document.createElement('div'); body.textContent = c;
      box.appendChild(head); box.appendChild(body); list.appendChild(box);
    });
  }
  areas.forEach(function (a) {
    a.value = lsGet(a.getAttribute('data-key'));
    a.addEventListener('input', function () { lsSet(a.getAttribute('data-key'), a.value); render(); });
  });
  render();
  document.getElementById('copy-all').addEventListener('click', function () {
    var cs = chunks(); if (!cs.length) { setStatus('没有可复制的评论'); return; }
    copyText(cs.join('\n\n'));
  });
})();
</script>
"""

page = HEAD + "".join(SECTIONS) + SUMMARY + "</div>" + SCRIPT + "</body></html>\n"
OUT.write_text(page, encoding="utf-8")
print(OUT, len(page.encode("utf-8")))
