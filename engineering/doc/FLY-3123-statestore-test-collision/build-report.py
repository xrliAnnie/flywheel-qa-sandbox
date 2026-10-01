import re, pathlib
here = pathlib.Path(__file__).parent
def svg(name):
    s = (here / name).read_text()
    s = re.sub(r'<\?xml[^>]*\?>', '', s)
    return s
sections = [
("s1","一句话总结","""
<p class="lead">两个各自"测试全绿"的改动合到 main 后撞车，让一条测试在运行时找不到 <code>StateStore</code>；修法是把这条测试的一行改成文件里其他测试都在用的夹具 <code>createGreenHandoffStore</code>。这一行修复<strong>已经合过一次</strong>，之后又随它依赖的功能被整体回退，现在正随那个功能的"重新落地" PR 一起回来——所以本次设计的重点是<strong>按实际代码状态判定该做什么</strong>，而不是再写一遍代码。</p>
<div class="kv">
<div><span class="k">PR（拉取请求）</span>：把一组代码改动提交给仓库、经检查后合入主分支 main 的请求。</div>
<div><span class="k">CI（持续集成）</span>：每次提交自动跑的一整套测试；"红"就是有测试失败，会挡住合入。</div>
<div><span class="k">夹具（fixture）</span>：测试里用来准备好初始环境的小工具函数。</div>
</div>
"""),
("s2","核心流程：撞车是怎么发生的、现在到了哪一步",f"""
<p>按时间顺序看 6 个 PR 对 main 的影响。<span class="k">类型导入（type import）</span>：只把名字当"类型标签"用、编译后会被删掉的导入；用它去<em>调用</em>东西，运行时就会报"未定义"。</p>
<div class="diagram">{svg('core-flow.svg')}</div>
"""),
("s3","数据 / 结构模型：实现阶段的决策表",f"""
<p>实现阶段不再假设"代码一定还是坏的"，而是先看实际检出（checkout，即当前拿到手的那份代码）属于哪种状态。本单<strong>不再产生任何代码提交</strong>：修复已由别的 PR 承载，本单只负责核验和据实交接。</p>
<div class="diagram">{svg('structure-model.svg')}</div>
<table>
<tr><th>状态</th><th>今天的实例</th><th>动作</th></tr>
<tr><td>测试文件不存在</td><td>本 QA 沙箱</td><td>零代码提交，引用证据交接</td></tr>
<tr><td>文件在、该测试不在</td><td>生产 main <code>e2997d2e9</code></td><td>零代码提交，不单独补回测试</td></tr>
<tr><td>已是 helper 调用</td><td>#1431 <code>803ed4d13</code>、#1400 <code>ef8eb5cf7</code></td><td>no-op，单文件验证</td></tr>
<tr><td>仍是 <code>StateStore.create</code>（且导入形态吻合）</td><td>目前无</td><td>不在本单提交；把"仓库 + 精确版本 + 一行替换建议"交给那个版本所属的 issue</td></tr>
<tr><td>其他任何形态（如旧版仍是普通导入、夹具没导入、测试出现多处）</td><td>#1379 原始版本 <code>b9777db5e</code></td><td>不套用这一行，记录后交给 Lead</td></tr>
</table>
"""),
("s4","关键取舍与被否决的方案","""
<div class="card green"><div class="card-title">采纳 A：改用 createGreenHandoffStore(":memory:")</div><div class="card-reason">与同文件其余 76+ 处测试同一种写法（单一来源）；它内部就是"真实内存数据库 + 预先装好交接通过证明"，不改测试想验证的结论。一行改动，回滚也只要还原一行。</div></div>
<div class="card red"><div class="card-title">否决 B：把第 18 行改回普通导入</div><div class="card-reason">等于撤销 #1408 的刻意设计——它要求本文件所有测试都经夹具建库，保证"交接门"有通过证明；改回去会让以后的测试再次绕开夹具。</div></div>
<div class="card red"><div class="card-title">否决 C：在这条测试里临时动态导入</div><div class="card-reason">绕路、风格不一致，同样绕开交接证明。</div></div>
<div class="card amber"><div class="card-title">暂缓 D：在 CI 里加类型检查门，提前抓这类撞车</div><div class="card-reason">能防复发（编译器其实会报 TS1361，但测试运行器不做类型检查），但超出这张一行小单的范围，记为后续建议。</div></div>
<div class="card amber"><div class="card-title">不照搬过期交接须知</div><div class="card-reason">须知让实现体"去 #1425 请求同头复审再交卷"，但 #1425 已合入又被回退，已没有可复审的在飞版本；照做只会空转。</div></div>
"""),
("s5","诚实边界：做什么、不做什么","""
<ul class="bound">
<li class="yes">✔ 给出一行修法及其语义安全性论证（helper 源码已核：<code>installGreenHandoffProofs(await StateStore.create(...))</code>）。</li>
<li class="yes">✔ 给实现阶段一张按真实代码状态判定的决策表，避免伪造文件或重复提交。</li>
<li class="yes">✔ 规定测试范围：本机只跑这一个测试文件；完整 CI 只认精确头；QA 只核三件事，529 真机测试记 not_run（tests_only）。</li>
<li class="no">✘ 不在本单里修改 #1431 / #1400（它们归各自 issue 所有），也不决定谁先合。</li>
<li class="no">✘ 本单不产生代码提交、不开新 PR；也不在 QA 沙箱里伪造生产测试文件。</li>
<li class="no">✘ 不声称 #1400 能干净合入 main：GitHub 当前判定它有冲突（#1431 无冲突）。</li>
<li class="no">✘ 不加新的 CI 类型检查门（只作建议）。</li>
<li class="no">✘ 状态是 2026-10-01 的快照；#1431 可能随时合入，实现阶段须重新核实。</li>
</ul>
"""),
]
cards = []
for sid, title, body in sections:
    cards.append(f'''<section class="section" data-sec="{sid}" data-title="{title}">
<h2>{title}</h2>
{body}
<label class="cm-label" for="cm-{sid}">你的意见</label>
<textarea class="cm" id="cm-{sid}" data-sec="{sid}" placeholder="对这一节有意见就写在这里（自动保存在本浏览器）"></textarea>
</section>''')
html = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FLY-3123 测试撞车修复</title>
<style>
:root{{--bg:#f5f5f7;--fg:#1d1d1f;--dim:#86868b;--card:#fff;--navy:#1a365d}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,system-ui,sans-serif;line-height:1.6}}
.wrap{{max-width:960px;margin:0 auto;padding:24px 16px 64px}}
header h1{{font-size:26px;margin:0 0 4px;color:var(--navy)}}
header .meta{{color:var(--dim);font-size:13px}}
code,.mono{{font-family:'SF Mono',ui-monospace,monospace;font-size:.92em;background:#eef0f3;padding:1px 5px;border-radius:5px}}
.section{{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:20px;margin:18px 0;border-left:4px solid #007aff}}
.section h2{{margin:0 0 10px;font-size:19px;color:var(--navy)}}
.lead{{font-size:16px}}
.k{{font-weight:600;color:var(--navy)}}
.kv div{{font-size:14px;margin:4px 0}}
.diagram{{overflow-x:auto;background:#fff;border:1px solid #e5e5ea;border-radius:10px;padding:8px;margin:10px 0}}
.diagram svg{{max-width:100%;height:auto;display:block;margin:0 auto}}
table{{width:100%;border-collapse:collapse;font-size:14px;margin-top:10px}}
th,td{{text-align:left;padding:8px;border-bottom:1px solid #e5e5ea;vertical-align:top}}
th{{color:var(--dim);font-weight:600}}
.card{{border-radius:10px;padding:12px 14px;margin:10px 0;background:#fafafa;border-left:4px solid #86868b}}
.card.green{{border-left-color:#34c759}}.card.red{{border-left-color:#ff3b30}}.card.amber{{border-left-color:#ff9500}}
.card-title{{font-weight:600}}.card-reason{{font-size:14px;color:#3a3a3c}}
ul.bound{{list-style:none;padding:0}}ul.bound li{{margin:6px 0}}li.yes{{color:#1d6b33}}li.no{{color:#a1261d}}
.cm-label{{display:block;margin-top:14px;font-size:13px;color:var(--dim)}}
textarea.cm{{width:100%;min-height:64px;margin-top:4px;padding:8px;border:1px solid #d2d2d7;border-radius:8px;font:inherit;font-size:14px;resize:vertical}}
#summary{{border-left-color:#af52de}}
#summary-out pre{{white-space:pre-wrap;background:#f5f5f7;border-radius:8px;padding:10px;font-size:13px}}
button{{background:#007aff;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}}
#copy-status{{margin-left:10px;color:var(--dim);font-size:13px}}
</style></head><body><div class="wrap">
<header><h1>FLY-3123 · main 测试撞车的一行修复</h1>
<div class="meta">设计阶段创始人报告 · 2026-10-01 · <span class="mono">engineering/doc/FLY-3123-statestore-test-collision/</span></div></header>
{''.join(cards)}
<section class="section" id="summary"><h2>意见汇总</h2>
<p style="font-size:14px;color:#3a3a3c">自动汇总上面所有非空意见。这是修改意见，不是通过信号。</p>
<div id="summary-out"></div>
<button id="copy-all" type="button">复制全部意见</button><span id="copy-status"></span>
</section>
</div>
<script nonce="__CSP_NONCE__">
(function(){{
  var PREFIX = 'fly3123-comments:' + location.pathname + ':';
  var MARK = '【页面意见汇总】FLY-3123';
  function load(k){{ try {{ return localStorage.getItem(PREFIX + k) || ''; }} catch (e) {{ return ''; }} }}
  function save(k, v){{ try {{ localStorage.setItem(PREFIX + k, v); }} catch (e) {{}} }}
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea.cm'));
  function titleOf(ta){{ var s = ta.closest('section'); return s ? s.getAttribute('data-title') : ''; }}
  function chunks(){{
    var items = [];
    areas.forEach(function(ta){{ var v = ta.value.trim(); if (v) items.push('【' + titleOf(ta) + '】\\n' + v); }});
    if (!items.length) return [];
    var out = [], cur = MARK;
    items.forEach(function(it){{
      if (cur.length + 2 + it.length > 1800 && cur !== MARK) {{ out.push(cur); cur = MARK; }}
      cur += '\\n\\n' + it;
    }});
    out.push(cur);
    return out;
  }}
  var outEl = document.getElementById('summary-out');
  function render(){{
    while (outEl.firstChild) outEl.removeChild(outEl.firstChild);
    var cs = chunks();
    if (!cs.length) {{ var p = document.createElement('p'); p.textContent = '（暂无意见）'; p.style.color = '#86868b'; outEl.appendChild(p); return; }}
    cs.forEach(function(c){{ var pre = document.createElement('pre'); pre.textContent = c; outEl.appendChild(pre); }});
  }}
  areas.forEach(function(ta){{
    ta.value = load(ta.getAttribute('data-sec'));
    ta.addEventListener('input', function(){{ save(ta.getAttribute('data-sec'), ta.value); render(); }});
  }});
  render();
  var status = document.getElementById('copy-status');
  function fallbackCopy(text){{
    var t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', '');
    t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
    var ok = false; try {{ ok = document.execCommand('copy'); }} catch (e) {{ ok = false; }}
    document.body.removeChild(t); status.textContent = ok ? '已复制' : '复制失败，请手动选中';
  }}
  document.getElementById('copy-all').addEventListener('click', function(){{
    var text = chunks().join('\\n\\n----\\n\\n');
    if (!text) {{ status.textContent = '没有可复制的意见'; return; }}
    if (navigator.clipboard && navigator.clipboard.writeText) {{
      navigator.clipboard.writeText(text).then(function(){{ status.textContent = '已复制'; }}, function(){{ fallbackCopy(text); }});
    }} else {{ fallbackCopy(text); }}
  }});
}})();
</script>
</body></html>'''
(here / 'founder-report.html').write_text(html)
print('ok', len(html))
