#!/usr/bin/env python3
"""Build founder-design.html for FLY-2911 (inline SVG diagrams, comment layer)."""
import html
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ISSUE = "FLY-2911"


def svg(name: str) -> str:
    p = HERE / f"{name}.svg"
    if not p.exists():
        return '<div class="pending">DIAGRAM PENDING LOCAL RENDER — ' + html.escape(name) + ".mmd</div>"
    return p.read_text(encoding="utf-8")


def e(s: str) -> str:
    return html.escape(s, quote=True)


import sys  # noqa: E402

sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
from sections import build  # noqa: E402

SECTIONS = build(svg)

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
  var ISSUE = 'FLY-2911';
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
<title>{e(ISSUE)} 评审作废止损</title><style>{CSS}</style></head>
<body><div class="wrap">
<h1>{e(ISSUE)} · 评审作废止损</h1>
<div class="sub">设计方案 · 2026-09-25 · 基线 main 801ac86cb · 只改 Bridge 的 Claude 评审协调器 · Codex 设计评审 4 轮通过</div>
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
