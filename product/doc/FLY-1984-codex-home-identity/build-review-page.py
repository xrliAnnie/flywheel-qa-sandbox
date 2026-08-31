# -*- coding: utf-8 -*-
import io, re, html, json, sys

src = io.open("epic-prd.md", encoding="utf-8").read().split("\n")

# ---- 切节:按 markdown 自己的标题结构,不重排 ----
# 节的边界【按标题文字定位】,不写死行号 —— 删掉一节会让所有行号错位。
# 每一项:(卡片 id, 卡片标题, 这一节从哪一行标题开始, 一句话摘要)
ANCHORS = [
    ("intro", "这份 PRD 是干嘛的", "> 这份 PRD 只说要什么形状、为什么、做到什么样算做到了。",
     "先说清楚这份东西的边界:只说要什么、为什么、怎么算做到,不替 Tadashi 拆单。"),
    ("s1", "问题", "## 问题",
     "两句话:Lead 学的东西只在一块盘上,丢了就没了;runner 学的东西连盘都没有,干完就归零。"),
    ("s2", "现状 · Lead 这边", "## 现状",
     "12 个 Lead 各有一个文件夹,今天共 1054 个文件;仓是有的,但这些记忆一条都没提交进去。"),
    ("s3", "现状 · runner 这边", "### runner 这边",
     "runner 起来时根本没有记忆;它的身份挂在一次性编号上,任务结束就没了。"),
    ("s4", "要什么 · A. Lead 的记忆存进私有仓", "### A. Lead 的记忆存到一个私有的 GitHub 仓",
     "一个仓、一 Lead 一文件夹、所有 Lead 可读只写自己那格、上仓前先跑真扫描、而且要能自动定期进去。"),
    ("s5", "要什么 · B. runner 也要有记忆", "### B. runner 也要有记忆",
     "记忆跟着角色和项目走(不跟一次性编号)、短目录自动送到眼前正文按需读、写入时机倾向一个 issue 一次。"),
    ("s6", "卡在哪", "## 卡在哪",
     "runner 启动参数里没有一项是挂记忆目录的,这个能力现在不存在。它不做,B 底下都用不上。"),
    ("s8", "做到什么样算做到了 · A", "## 做到什么样算做到了",
     "9 条可以验的:换台机器拉得下来、权限对、扫描做过、今天写的明天在远端看得到、判断看远端不看日志。"),
    ("s9", "做到什么样算做到了 · B", "### B",
     "4 条可以验的:起来能读到属于自己角色和项目的、第二次读得到第一次写的、换 issue 换目录还是同一份、目录清掉不丢。"),
    ("s10", "还没定的 / 还没查的", "## 还没定的 / 还没查的",
     "三条老实摆着:别的角色该不该读到、那份目录长了会被悄悄截掉(现在没解法)、Codex 那边没查过。"),
    ("s11", "附:她在页面上逐格的裁定", "## 附:她在页面上逐格的裁定",
     "把她在上一页逐格勾的结果原样列出来,方便对照。"),
]

def anchor_line(needle, after):
    """返回该标题所在行号(0-based)。必须唯一,否则直接失败,不猜。"""
    hits = [i for i, l in enumerate(src) if i >= after and l.strip() == needle.strip()]
    assert hits, "找不到锚点: %r" % needle
    return hits[0]

SECTIONS, cur = [], 0
for idx, (sid, title, anchor, summary) in enumerate(ANCHORS):
    a = anchor_line(anchor, cur)
    cur = a + 1
    SECTIONS.append([sid, title, a, None, summary])
for i in range(len(SECTIONS)):
    SECTIONS[i][3] = SECTIONS[i+1][2] if i + 1 < len(SECTIONS) else len(src)

def esc(t): return html.escape(t, quote=False)

def inline(t):
    t = esc(t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    return t

def md2html(lines):
    out, i, n = [], 0, len(lines)
    while i < n:
        before = i
        ln = lines[i]
        if not ln.strip() or set(ln.strip()) <= set("-"):
            i += 1; continue
        # 表格
        if ln.lstrip().startswith("|"):
            rows = []
            while i < n and lines[i].lstrip().startswith("|"):
                rows.append(lines[i].strip()); i += 1
            cells = [[c.strip() for c in r.strip("|").split("|")] for r in rows]
            cells = [c for c in cells if not all(set(x) <= set("-: ") for x in c)]
            out.append("<table>")
            for k, row in enumerate(cells):
                tag = "th" if k == 0 else "td"
                out.append("<tr>" + "".join("<%s>%s</%s>" % (tag, inline(c), tag) for c in row) + "</tr>")
            out.append("</table>")
            continue
        # 引用(她的原话)
        if ln.lstrip().startswith(">"):
            q = []
            while i < n and lines[i].lstrip().startswith(">"):
                q.append(re.sub(r"^\s*>\s?", "", lines[i])); i += 1
            out.append('<blockquote>' + "<br>".join(inline(x) for x in q) + "</blockquote>")
            continue
        # 列表
        if ln.lstrip().startswith("- "):
            items = []
            while i < n and (lines[i].lstrip().startswith("- ") or (lines[i].startswith("  ") and lines[i].strip())):
                if lines[i].lstrip().startswith("- "):
                    items.append([lines[i].lstrip()[2:]])
                else:
                    items[-1].append(lines[i].strip())
                i += 1
            out.append("<ul>")
            for it in items:
                body, sub = [], []
                for part in it:
                    (sub if part.startswith(">") else body).append(part)
                h = "".join(body)
                li = "<li>" + inline(h)
                if sub:
                    li += '<blockquote>' + "<br>".join(inline(re.sub(r"^\s*>\s?", "", x)) for x in sub) + "</blockquote>"
                out.append(li + "</li>")
            out.append("</ul>")
            continue
        # 段落
        para = []
        while i < n and lines[i].strip() and not lines[i].lstrip()[0] in "|->" and not lines[i].lstrip().startswith("- "):
            para.append(lines[i].strip()); i += 1
        if para:
            out.append("<p>" + inline("".join(para)) + "</p>")
        # 没有任何分支消费掉这一行 ⇒ 立刻炸,不要静静地转圈
        assert i > before, "解析器卡在第 %d 行,没人消费它: %r" % (before, lines[before])
    return "\n".join(out)

cards, audit = [], {}
for sid, title, a, b, summary in SECTIONS:
    raw = src[a:b]
    body = [l for l in raw if not l.startswith("#")]
    # 只把【明确标注为某人原话】的引用块提到卡片外面,并标明是谁说的。
    # 不这样做的话,Honey Lemon 那句会被摆在「你的原话」下面 —— 她会读成自己说过的。
    quotes = []
    j = 0
    while j < len(body):
        if body[j].lstrip().startswith(">"):
            prev = ""
            k = j - 1
            while k >= 0 and not body[k].strip():
                k -= 1
            if k >= 0:
                prev = body[k]
            q = []
            while j < len(body) and body[j].lstrip().startswith(">"):
                q.append(re.sub(r"^\s*>\s?", "", body[j])); j += 1
            # 有些引用块自己内部就带「她的原话:」(开场那一段就是),
            # 这种要把【那一行】原样提出来 —— Lead 点名它必须单独成块。
            inner = [x for x in q if x.strip().startswith("她的原话")]
            if inner:
                for x in inner:
                    quotes.append({"who": "原文开场里引的你这句", "text": x})
                continue
            if "原话" not in prev and "说过的话" not in prev:
                continue
            who = "Honey Lemon 说的" if "Honey Lemon" in prev else "你说的"
            quotes.append({"who": who, "text": "".join(q)})
        else:
            j += 1
    audit[sid] = "".join(x.strip() for x in body)
    cards.append((sid, title, summary, quotes, md2html(body)))

io.open("/tmp/cards.json", "w", encoding="utf-8").write(json.dumps(
    [{"id": c[0], "title": c[1], "summary": c[2], "quotes": c[3], "html": c[4]} for c in cards],
    ensure_ascii=False))
io.open("/tmp/audit.json", "w", encoding="utf-8").write(json.dumps(audit, ensure_ascii=False))
io.open("/tmp/ranges.json", "w", encoding="utf-8").write(json.dumps(
    [[x[0], x[2], x[3]] for x in SECTIONS], ensure_ascii=False))
print("切出 %d 节" % len(cards))
for c in cards:
    print("  %-6s %-28s 原话 %d 处  %d 字" % (c[0], c[1], len(c[3]), len(c[4])))
# -*- coding: utf-8 -*-
import io, json
cards = json.load(io.open("/tmp/cards.json", encoding="utf-8"))

CSS = """:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#86868b;--line:#e5e5ea;
--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Helvetica Neue",sans-serif;
line-height:1.55;font-size:15.5px;-webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;padding:30px 18px 120px}
h1{font-size:25px;line-height:1.3;margin:0 0 6px;letter-spacing:-.4px}
.sub{color:var(--dim);font-size:13.5px;margin:0 0 20px;line-height:1.65}
.card{background:var(--card);border-radius:12px;padding:17px 19px;margin:0 0 13px;
box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--line)}
.card .n{font-size:11.5px;letter-spacing:.6px;color:var(--dim);font-weight:700;margin:0 0 3px}
.card h2{font-size:17.5px;margin:0 0 9px;letter-spacing:-.2px;line-height:1.35}
.sum{font-size:15px;line-height:1.65;margin:0 0 10px}
p{margin:0 0 8px}
code{font-family:"SF Mono",ui-monospace,monospace;font-size:12.5px;background:#f0f0f4;
padding:1px 5px;border-radius:4px}
blockquote{margin:8px 0;padding:10px 13px;border-left:3px solid #cfe0f5;background:#f6faff;
border-radius:0 8px 8px 0;font-size:14.5px;line-height:1.7}
.who{font-size:12.5px;color:var(--dim);font-weight:700;margin:9px 0 0}
.qhead{font-size:11.5px;font-weight:800;letter-spacing:.5px;color:#0a53c4;margin:12px 0 2px}
ul{margin:6px 0 8px;padding-left:20px}li{margin:0 0 6px;line-height:1.65}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13.5px}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:#fafafc;font-weight:700}
details{margin:10px 0 4px;border:1px solid var(--line);border-radius:9px;background:#fbfbfd}
details>summary{cursor:pointer;padding:9px 13px;font-size:13.5px;font-weight:700;color:#0a53c4;
list-style:none;user-select:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"展开原文  ▸  ";font-weight:700}
details[open]>summary::before{content:"收起原文  ▾  "}
details>summary span{color:var(--dim);font-weight:400}
.inner{padding:2px 15px 13px;border-top:1px solid var(--line);font-size:14px}
.picks{display:flex;flex-wrap:wrap;gap:7px;margin:11px 0 8px}
.picks label{display:inline-flex;align-items:center;gap:5px;font-size:14px;font-weight:700;
border:1.5px solid var(--line);border-radius:8px;padding:6px 14px;cursor:pointer;background:#fff}
.picks input{margin:0;accent-color:var(--blue)}
textarea.note{width:100%;min-height:44px;border:1px solid var(--line);border-radius:8px;
padding:8px 10px;font:inherit;font-size:13.5px;resize:vertical;background:#fff;color:var(--ink)}
textarea.note::placeholder{color:#b0b0b5}
.bar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.94);
backdrop-filter:saturate(180%) blur(12px);border-top:1px solid var(--line);
padding:11px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:9}
button{font:inherit;font-size:14px;font-weight:700;border-radius:9px;padding:9px 16px;
border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer}
button.p{background:var(--blue);border-color:var(--blue);color:#fff}
button:active{opacity:.75}
.status{font-size:13px;color:var(--dim)}
.status.ok{color:#1a7f37;font-weight:700}.status.err{color:var(--red);font-weight:700}
#dump{display:none;width:100%;min-height:150px;margin:10px 0 0;border:1px solid var(--line);
border-radius:8px;padding:10px;font:inherit;font-size:13px}
@media(max-width:600px){.wrap{padding:22px 13px 140px}h1{font-size:22px}}"""

JS = r"""(function(){
"use strict";
var MARK = "【页面意见汇总】FLY-1984";
var LIMIT = 1800;
var KEY = "fly1984-prd-review-v2";
var notes = Array.prototype.slice.call(document.querySelectorAll("textarea[data-s]"));
var radios = Array.prototype.slice.call(document.querySelectorAll(".picks input[type=radio]"));
var groups = [];
radios.forEach(function(r){ if(groups.indexOf(r.name) < 0) groups.push(r.name); });
var st = document.getElementById("st");
var dump = document.getElementById("dump");
function titleOf(name){
  var el = document.querySelector("input[name='" + name + "']");
  var card = el ? el.closest(".card") : null;
  var h = card ? card.querySelector("h2") : null;
  return h ? h.textContent.replace(/\s+/g," ").trim() : name;
}
function pickOf(name){
  var c = document.querySelector("input[name='" + name + "']:checked");
  return c ? c.value : "";
}
function noteOf(name){
  var el = document.querySelector("input[name='" + name + "']");
  var card = el ? el.closest(".card") : null;
  var ta = card ? card.querySelector("textarea[data-s]") : null;
  return ta && ta.value.trim() ? ta.value.trim() : "";
}
function load(){
  var raw = null;
  try { raw = window.localStorage.getItem(KEY); } catch(e){ raw = null; }
  if(!raw) return;
  var data = null;
  try { data = JSON.parse(raw); } catch(e){ return; }
  if(!data || typeof data !== "object") return;
  notes.forEach(function(b){
    var v = data["n:" + b.getAttribute("data-s")];
    if(typeof v === "string") b.value = v;
  });
  groups.forEach(function(g){
    var v = data["p:" + g];
    if(typeof v !== "string" || !v) return;
    var el = document.querySelector("input[name='" + g + "'][value='" + v + "']");
    if(el) el.checked = true;
  });
}
function save(){
  var data = {};
  notes.forEach(function(b){ if(b.value.trim()) data["n:" + b.getAttribute("data-s")] = b.value; });
  groups.forEach(function(g){ var v = pickOf(g); if(v) data["p:" + g] = v; });
  try { window.localStorage.setItem(KEY, JSON.stringify(data)); } catch(e){}
}
function parts(){
  var out = [];
  groups.forEach(function(g){
    var p = pickOf(g), note = noteOf(g);
    if(!p && !note) return;
    var body = "【" + titleOf(g) + "】\n" + (p ? ("→ " + p) : "→ (没勾)");
    if(note) body += "\n" + note;
    out.push(body);
  });
  return out;
}
function chunks(){
  var ps = parts(), out = [], cur = "";
  ps.forEach(function(p){
    var cand = cur ? (cur + "\n\n" + p) : p;
    if(cur && (MARK.length + 1 + cand.length) > LIMIT){ out.push(cur); cur = p; }
    else { cur = cand; }
  });
  if(cur) out.push(cur);
  if(!out.length) return [];
  return out.map(function(body, i){
    var head = MARK;
    if(out.length > 1) head = MARK + "  (" + (i+1) + "/" + out.length + ")";
    return head + "\n" + body;
  });
}
function refresh(){
  var n = 0;
  groups.forEach(function(g){ if(pickOf(g)) n++; });
  var w = notes.filter(function(b){ return b.value.trim().length > 0; }).length;
  st.className = "status";
  st.textContent = (!n && !w) ? ("还没勾（共 " + groups.length + " 节）")
    : ("已勾 " + n + "/" + groups.length + " 节" + (w ? ("・写了 " + w + " 段") : ""));
}
function showManual(text, msg){
  dump.style.display = "block"; dump.value = text; dump.focus(); dump.select();
  st.className = "status err"; st.textContent = msg;
}
document.getElementById("copy").addEventListener("click", function(){
  var cs = chunks();
  if(!cs.length){
    st.className = "status err";
    st.textContent = "还没勾也没写，没东西可复制";
    return;
  }
  var joined = cs.join("\n\n");
  var okMsg = cs.length > 1
    ? ("复制好了 —— 太长了，分成 " + cs.length + " 段，每段开头都有标记，一段一段贴")
    : "复制好了，去贴回 issue";
  var manualMsg = "自动复制没成功 —— 下面框里是全文，已经选中了，自己按一下拷贝";
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(joined).then(function(){
      dump.style.display = "none";
      st.className = "status ok"; st.textContent = okMsg;
    }).catch(function(){ showManual(joined, manualMsg); });
  } else { showManual(joined, manualMsg); }
});
document.getElementById("clear").addEventListener("click", function(){
  notes.forEach(function(b){ b.value = ""; });
  radios.forEach(function(r){ r.checked = false; });
  try { window.localStorage.removeItem(KEY); } catch(e){}
  dump.style.display = "none"; refresh();
});
notes.forEach(function(b){ b.addEventListener("input", function(){ save(); refresh(); }); });
radios.forEach(function(r){ r.addEventListener("change", function(){ save(); refresh(); }); });
load(); refresh();
})();"""

body = []
body.append('<h1>FLY-1984 的 PRD,请你逐节过一遍</h1>')
body.append('<p class="sub">2026-08-28 · 这是 A 线(Lead 的记忆)和 B 线(runner 的记忆)合成的<b>一个 Epic 的 PRD</b>。<br>'
            '每一节先给你一句话摘要,想看原文点「展开原文」。<b>每节勾一个「对 / 不对 / 存疑」,不同意就写在下面。</b><br>'
            '<b>你勾完我改,改完就交给 Tadashi,他自己拆单。</b><br>'
            '勾完点最底下「一键汇总复制」,再贴回 issue —— 我才收得到,这页的字只存在你自己的浏览器里。</p>')

for i, c in enumerate(cards):
    body.append('<div class="card">')
    body.append('<p class="n">%d / %d</p>' % (i+1, len(cards)))
    body.append('<h2>%s</h2>' % c["title"])
    body.append('<p class="sum">%s</p>' % c["summary"])
    if c["quotes"]:
        body.append('<p class="qhead">这一节里的原话(一个字没改)</p>')
        for q in c["quotes"]:
            body.append('<p class="who">%s:</p><blockquote>%s</blockquote>' % (q["who"], q["text"]))
    body.append('<div class="picks">')
    for v in ("对", "不对", "存疑"):
        body.append('<label><input type="radio" name="%s" value="%s"> %s</label>' % (c["id"], v, v))
    body.append('</div>')
    body.append('<textarea data-s="%s" class="note" placeholder="不同意 / 要改的地方,写这里…"></textarea>' % c["title"])
    body.append('<details><summary><span>(这一节在 PRD 里的原文)</span></summary><div class="inner">%s</div></details>' % c["html"])
    body.append('</div>')

page = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>FLY-1984 PRD 逐节审阅</title>
<style>
%s
</style>
</head>
<body>
<div class="wrap">
%s
</div>
<div class="bar">
<button class="p" id="copy">一键汇总复制</button>
<button id="clear">清空</button>
<span class="status" id="st">还没勾</span>
<textarea id="dump" readonly></textarea>
</div>
<script nonce="__CSP_NONCE__">
%s
</script>
</body>
</html>
""" % (CSS, "\n".join(body), JS)
io.open("prd-review.html", "w", encoding="utf-8").write(page)
print("生成 prd-review.html:%d 字节" % len(page))
