#!/usr/bin/env python3
"""FLY-1867 founder HTML 组装器 — 内联本地预渲染 SVG,零外部依赖。"""
import re
import pathlib

HERE = pathlib.Path(__file__).parent

HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>FLY-1867 · playwright-mcp Chrome 泄漏 — 设计评审</title>
<style>
  :root{
    --bg:#f5f5f7; --card:#fff; --ink:#1d1d1f; --dim:#86868b;
    --red:#ff3b30; --amber:#ff9500; --blue:#007aff; --green:#34c759; --purple:#af52de; --navy:#1a365d;
    --line:#e8e8ed;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--bg); color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,system-ui,"Helvetica Neue",Arial,sans-serif;
    line-height:1.55; font-size:15px; -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:960px; margin:0 auto; padding:26px 20px 40px}
  header{margin:4px 0 20px}
  .eyebrow{
    font-family:"SF Mono",ui-monospace,Menlo,monospace; font-size:12px; letter-spacing:.06em;
    color:var(--dim); text-transform:uppercase; margin-bottom:8px;
  }
  h1{font-size:28px; line-height:1.22; margin:0 0 11px; letter-spacing:-.02em}
  .lede{font-size:16.5px; color:#3a3a3c; margin:0; max-width:74ch}
  .card{
    background:var(--card); border-radius:12px; padding:17px 22px; margin:0 0 14px;
    box-shadow:0 1px 3px rgba(0,0,0,.06); border-left:4px solid var(--blue);
  }
  .card.amber{border-left-color:var(--amber)}
  .card.green{border-left-color:var(--green)}
  .card.gray{border-left-color:var(--dim)}
  .card.summary{border-left-color:var(--purple)}
  h2{font-size:18.5px; margin:0 0 11px; letter-spacing:-.01em}
  h3{font-size:15px; margin:15px 0 5px; color:var(--navy)}
  p{margin:0 0 9px; max-width:78ch}
  em{color:#3a3a3c}
  .term{
    font-family:"SF Mono",ui-monospace,Menlo,monospace; font-size:.92em;
    background:#f0f0f2; padding:1px 5px; border-radius:4px;
  }
  .note{
    background:#f8f8fa; border-left:3px solid var(--dim); border-radius:0 6px 6px 0;
    padding:9px 13px; margin:11px 0 3px; font-size:14px; color:#3a3a3c;
  }
  .note.red-note{background:#fff5f4; border-left-color:var(--red)}
  .two{display:grid; grid-template-columns:1fr 1fr; gap:11px; margin:11px 0}
  @media (max-width:620px){ .two{grid-template-columns:1fr} }
  .mini{background:#f8f8fa; border-radius:8px; padding:11px 14px; border-left:3px solid var(--dim)}
  .mini.red{border-left-color:var(--red); background:#fff5f4}
  .mini-h{font-weight:600; margin-bottom:5px; font-size:14px}
  .mini p{margin:0; font-size:14px; color:#3a3a3c}
  .figure{
    margin:12px 0 4px; padding:11px; background:#fbfbfd; border:1px solid var(--line);
    border-radius:10px; overflow-x:auto;
  }
  .figure svg{display:block; margin:0 auto; max-width:100%; height:auto}
  .flow{display:grid;gap:8px;margin:3px auto;max-width:760px}
  .flow-node{padding:10px 13px;border-radius:9px;text-align:center;border:2px solid var(--blue);background:#f2f8ff;font-size:14px}
  .flow-node.start{border-color:var(--amber);background:#fff7eb;font-weight:600}
  .flow-node.off{border-color:var(--green);background:#f2fbf4;font-weight:600}
  .flow-split{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .flow-arrow{text-align:center;color:var(--dim);line-height:1;font-size:18px}
  @media (max-width:620px){.flow-split{grid-template-columns:1fr}}
  table{border-collapse:collapse; width:100%; margin:10px 0; font-size:14px; display:block; overflow-x:auto}
  th,td{border-bottom:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top}
  th{color:var(--dim); font-weight:600; font-size:12.5px; letter-spacing:.03em; text-transform:uppercase; white-space:nowrap}
  td.ok{color:#1d7a3e} td.bad{color:#c1281f} td.warn{color:#9a5a00}
  table.data td:nth-child(2){font-family:"SF Mono",ui-monospace,Menlo,monospace; white-space:nowrap}
  .legs{display:grid; gap:11px; margin:12px 0 4px}
  .leg{border-radius:9px; padding:12px 15px; border-left:4px solid var(--dim); background:#f8f8fa}
  .leg.p1{border-left-color:var(--green); background:#f2fbf4}
  .leg.p2{border-left-color:var(--blue); background:#f2f8ff}
  .leg.p3{border-left-color:var(--purple); background:#faf5ff}
  .leg-h{font-weight:600; margin-bottom:7px; font-size:15px}
  .leg p{margin:0 0 6px; font-size:14px}
  .leg-note{color:#3a3a3c; font-size:13.5px !important}
  .tag{
    font-size:11px; font-weight:600; background:var(--green); color:#fff;
    padding:2px 7px; border-radius:20px; margin-left:6px; letter-spacing:.02em;
  }
  ul.honest{margin:8px 0 4px; padding-left:20px}
  ul.honest li{margin-bottom:7px; max-width:78ch}
  .cmt{margin-top:12px; padding-top:10px; border-top:1px dashed var(--line)}
  .cmt label{display:block; font-size:12px; color:var(--dim); margin-bottom:5px; letter-spacing:.02em}
  textarea{
    width:100%; font:inherit; font-size:14px; padding:9px 11px; border:1px solid #d8d8dd;
    border-radius:7px; resize:vertical; background:#fdfdfe; color:var(--ink);
  }
  textarea:focus{outline:2px solid var(--blue); outline-offset:-1px; border-color:transparent}
  .summary{background:#fdfaff}
  .small{font-size:13px; color:var(--dim)}
  .sum-item{background:#fff; border-radius:7px; padding:9px 12px; margin-bottom:8px; border-left:3px solid var(--purple)}
  .sum-sec{font-size:11.5px; color:var(--purple); font-weight:600; margin-bottom:4px; letter-spacing:.03em}
  .sum-item div:last-child{white-space:pre-wrap; font-size:14px}
  .empty-hint{color:var(--dim); font-size:14px; margin:4px 0}
  .copy-row{margin-top:13px; display:flex; align-items:center; gap:11px; flex-wrap:wrap}
  button{
    font:inherit; font-size:14px; font-weight:500; background:var(--blue); color:#fff; border:0;
    padding:8px 17px; border-radius:8px; cursor:pointer;
  }
  button:hover{background:#0066d6}
  #copy-status{font-size:13.5px; color:var(--dim)}
  footer{text-align:center; color:var(--dim); font-size:12.5px; margin-top:16px}
</style>
</head>
<body>
"""

SCRIPT = """
<script nonce="__CSP_NONCE__">
(function () {
  var PREFIX = 'fly1867:' + location.pathname + ':';
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-key]'));

  function lsGet(k) { try { return localStorage.getItem(PREFIX + k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch (e) {} }

  function secTitle(ta) {
    var card = ta.closest('.card');
    var h = card ? card.querySelector('h2') : null;
    return h ? h.textContent : '未命名板块';
  }

  function renderSummary() {
    var list = document.getElementById('summary-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    var any = false;
    areas.forEach(function (ta) {
      var v = ta.value.trim();
      if (!v) return;
      any = true;
      var item = document.createElement('div');
      item.className = 'sum-item';
      var sec = document.createElement('div');
      sec.className = 'sum-sec';
      sec.textContent = secTitle(ta);
      var body = document.createElement('div');
      body.textContent = v;
      item.appendChild(sec);
      item.appendChild(body);
      list.appendChild(item);
    });
    if (!any) {
      var hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.textContent = '上面任何板块写了评论,都会自动汇总到这里。';
      list.appendChild(hint);
    }
  }

  areas.forEach(function (ta) {
    ta.value = lsGet(ta.getAttribute('data-key'));
    ta.addEventListener('input', function () {
      lsSet(ta.getAttribute('data-key'), ta.value);
      renderSummary();
    });
  });
  renderSummary();

  function buildCopyText() {
    var parts = [];
    areas.forEach(function (ta) {
      var v = ta.value.trim();
      if (v) parts.push('【' + secTitle(ta) + '】\\n' + v);
    });
    return parts.join('\\n\\n');
  }

  function legacyCopy(text, status) {
    var ok = false;
    try {
      var tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.setAttribute('readonly', '');
      tmp.style.position = 'fixed';
      tmp.style.left = '-9999px';
      document.body.appendChild(tmp);
      tmp.select();
      ok = document.execCommand('copy');
      document.body.removeChild(tmp);
    } catch (e) { ok = false; }
    status.textContent = ok ? '✅ 已复制' : '❌ 复制失败,请手动全选上方文字';
    status.style.color = ok ? '#34c759' : '#ff3b30';
  }

  document.getElementById('copy-all').addEventListener('click', function () {
    var status = document.getElementById('copy-status');
    var text = buildCopyText();
    if (!text) { status.textContent = '还没有评论'; status.style.color = '#86868b'; return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        status.textContent = '✅ 已复制';
        status.style.color = '#34c759';
      }, function () { legacyCopy(text, status); });
    } else {
      legacyCopy(text, status);
    }
  });
})();
</script>
</body>
</html>
"""


def inline_svg(name: str) -> str:
    s = (HERE / f"{name}.svg").read_text()
    s = re.sub(r"^<\?xml[^>]*\?>\s*", "", s)
    s = re.sub(r"<!DOCTYPE[^>]*>\s*", "", s)
    return s.replace("<svg ", '<svg style="max-width:100%;height:auto;" ', 1)


def main() -> None:
    body = (HERE / "founder-design.body.html").read_text()
    for token, name in (
        ("__SVG_D1__", "d1-leak"),
        ("__SVG_D2__", "d2-gap"),
        ("__SVG_D3__", "d3-fix"),
    ):
        svg = inline_svg(name)
        if token in body:
            body = body.replace(token, svg)

    out = HEAD + body + SCRIPT
    if "__SVG_D" in out:
        raise SystemExit("unreplaced SVG token remains")
    if "__CSP_NONCE__" not in out:
        raise SystemExit("CSP nonce placeholder missing")
    if "Content-Security-Policy" in out:
        raise SystemExit("must not ship our own CSP meta")
    if re.search(r"\son(click|input|load|change)\s*=", out):
        raise SystemExit("inline event handler found — CSP would block it")

    dest = HERE / "founder-design.html"
    dest.write_text(out)
    print(f"wrote {dest} ({len(out)} bytes)")


if __name__ == "__main__":
    main()
