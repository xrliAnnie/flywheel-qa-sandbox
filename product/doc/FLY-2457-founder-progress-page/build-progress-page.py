#!/usr/bin/env python3
"""Render the founder progress page itself, from live data.

This is the shape-defining mockup: real rows, real structure, no invented
entries. Build-time gates enforce the rules that cost us a round each when
they were left to human memory:
  · no personal names anywhere (the page must be generic across Leads)
  · no claim that the Discord jump works, since nobody has opened one
  · the lead_note sample stays labelled as a sample; nobody has written one
  · every attention row carries all four segments
Exits non-zero rather than emitting a page that breaks any of them.
"""
import json, html, sqlite3, datetime, pathlib, sys, re

S = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])
doc = json.load(open(S / "epic3.json"))["result"]["document"]
lin = {n["identifier"]: n for n in json.load(open(S / "roots3.json"))["data"]["issues"]["nodes"]}
items = {i["identifier"]: i for i in doc["items"]}
roots = {r["identifier"]: r for r in doc["header"]["roots"]["value"]}
gen = doc["generated_at"]
now = datetime.datetime.fromisoformat(gen.replace("Z", "+00:00"))
db = sqlite3.connect("file:" + str(pathlib.Path.home() / ".flywheel/teamlead.db") + "?mode=ro", uri=True)

def esc(s): return html.escape(s or "")
def ago(iso):
    mins = int((now - datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))).total_seconds() // 60)
    if mins < 60: return f"已等 {mins} 分钟"
    if mins < 1440: return f"已等 {mins//60} 小时 {mins%60} 分"
    return f"已等 {mins//1440} 天 {(mins%1440)//60} 小时"

SHORT = {"FLY-2441": "通路统一 + Raya 重建", "FLY-2355": "Codex 记忆落地",
         "FLY-2309": "自动合并怎么落地", "FLY-1143": "Release CI/CD 发布流程",
         "FLY-2369": "日常筐(bug / 小需求)"}
OPEN = ("backlog", "unstarted", "triage")

def has_thread(idf):
    return db.execute("select 1 from chat_threads where issue_id=? limit 1", (idf,)).fetchone() is not None

def machine_line(idf):
    x = items.get(idf)
    if not x: return None
    run = (x.get("run") or {}).get("value") or []
    att = (x.get("attempt") or {}).get("value") or []
    ses = ((x.get("session") or {}).get("value") or {}).get("latest") or []
    if not run: return None
    who = ses[0]["role"] if ses else "?"
    st = ses[0]["status"] if ses else ""
    return f'到「{run[0]["current_node_label"]}」· 第 {att[0]["attempt"] if att else "?"} 次 · {who} {st}'.strip()

# ---------------- 现在要你看 ----------------
KIND = {
    "waiting_founder": ("在等你按一下(门开着)", "去 thread 里回一句「同意」或「打回」", "k-gate"),
    "question_pending": ("体在问你一句话", "去 thread 里回答它的问题", "k-ask"),
    "runner_stopped": ("体自己停了", "不用你动手 —— 这条本不该占你的位置", "k-stop"),
}
RANK = {"waiting_founder": 0, "question_pending": 1, "runner_stopped": 2}
by_issue = {}
for x in items.values():
    idf = x["identifier"]
    for sig in (x.get("signals") or []):
        if sig["kind"] not in KIND: continue
        cur = by_issue.setdefault(idf, {"title": (x.get("title") or {}).get("value", ""), "sigs": {}})
        prev = cur["sigs"].get(sig["kind"])
        if prev is None or sig["since"] < prev:
            cur["sigs"][sig["kind"]] = sig["since"]
ATT = []
for idf, v in by_issue.items():
    ordered = sorted(v["sigs"].items(), key=lambda kv: RANK[kv[0]])
    top, since = ordered[0]
    kind, action, cls = KIND[top]
    extra = "".join(f'<span class="u-extra">{esc(KIND[k][0])}</span>' for k, _ in ordered[1:])
    ATT.append({"idf": idf, "title": v["title"], "kind": kind, "action": action, "cls": cls,
                "since": f'自 {since[11:16]}Z 起,{ago(since)}', "thread": has_thread(idf), "extra": extra})
ATT.sort(key=lambda a: (RANK[[k for k, v_ in KIND.items() if v_[0] == a["kind"]][0]], a["idf"]))
# 「体自己停了」不需要她动手,PRD Q1 建议移出;这一版留着但排在最后并标灰,由她定
rows = "".join(f'''<div class="u-row {a['cls']}">
<div class="u-l"><span class="u-kind {a['cls']}">{esc(a['kind'])}</span><a class="mono" href="https://linear.app/geoforge3d/issue/{esc(a['idf'])}">{esc(a['idf'])}</a>
<span class="u-t">{esc(a['title'][:44])}</span>{a['extra']}</div>
<div class="u-act">▶ {esc(a['action'])}</div>
<div class="u-r"><span class="u-since">{esc(a['since'])}</span>
<span class="jump-off" title="{'thread 已存,但跳转链接还没接通' if a['thread'] else '这张单还没有 thread'}">跳 Discord · 还没接通</span></div>
</div>''' for a in ATT) or '<div class="empty">现在没有等你的事。</div>'

# ---------------- Epic 卡 ----------------
SAMPLE_ON = "FLY-2441"
cards, shown = [], 0
for rid in sorted(roots, key=lambda r: (0 if roots[r]["state"]["type"] == "started" else 1, r)):
    kids = lin[rid]["children"]["nodes"] if rid in lin else []
    live = [k for k in kids if k["state"]["type"] == "started"]
    openk = [k for k in kids if k["state"]["type"] in OPEN]
    done = [k for k in kids if k["state"]["type"] == "completed"]
    canc = [k for k in kids if k["state"]["type"] == "canceled"]
    if not (live or openk): continue          # 全做完的拿掉
    shown += 1
    body = []
    if rid == SAMPLE_ON:
        body.append('''<div class="leadnote"><b>💬 判断</b><span class="sample-tag">示例 · 还没有人写过</span>
<div class="ln-body">这一行留给 Lead 手写一句「现在到哪了」,例如「2444 已合入,2445 等它;这块不收后面都没落点」。</div>
<div class="ln-meta">工程 Lead · 2 小时前写 ｜ 它<b>不会盖掉</b>下面机器测到的那几行</div></div>''')
    def blocks_rel(k):
        return [(r["issue"]["identifier"], r["issue"]["state"]["type"])
                for r in k["inverseRelations"]["nodes"] if r["type"] == "blocks"]
    def blockers(k):
        return [i for i, t in blocks_rel(k) if t not in ("completed", "canceled")]
    def cleared(k):
        rel = blocks_rel(k)
        return [i for i, _ in rel] if rel and not blockers(k) else []
    waiting = [k for k in openk if blockers(k)]
    freed = [k for k in openk if cleared(k)]
    idle = [k for k in openk if not blockers(k) and not cleared(k)]
    for k in live:
        idf = k["identifier"]
        body.append(f'''<div class="kid"><div class="kid-h"><span class="s s-live">在跑</span>
<a class="mono" href="https://linear.app/geoforge3d/issue/{esc(idf)}">{esc(idf)}</a><span class="kid-t">{esc(k["title"][:60])}</span></div>
<div class="kid-a">↳ {esc(machine_line(idf) or "在跑(引擎还没报节点)")} <span class="src">机器测的</span></div></div>''')
    for k in waiting:
        idf = k["identifier"]; names = " / ".join(blockers(k))
        body.append(f'''<div class="kid"><div class="kid-h"><span class="s s-wait">等 {esc(names)}</span>
<a class="mono" href="https://linear.app/geoforge3d/issue/{esc(idf)}">{esc(idf)}</a><span class="kid-t">{esc(k["title"][:60])}</span></div>
<div class="kid-a">↳ 被 {esc(names)} 挡着,没起跑 <span class="src">机器测的</span></div></div>''')
    for k in sorted(freed, key=lambda z: z["identifier"]):
        idf = k["identifier"]; names = " / ".join(cleared(k))
        body.append(f'''<div class="kid"><div class="kid-h"><span class="s s-free">依赖已解开 · 可起跑</span>
<a class="mono" href="https://linear.app/geoforge3d/issue/{esc(idf)}">{esc(idf)}</a><span class="kid-t">{esc(k["title"][:60])}</span></div>
<div class="kid-a">↳ 原本等 {esc(names)},它已经做完了 —— 现在没人挡着 <span class="src">机器测的</span></div></div>''')
    for k in sorted(idle, key=lambda z: z["identifier"]):
        idf = k["identifier"]
        body.append(f'''<div class="kid"><div class="kid-h"><span class="s s-idle">未开始</span>
<a class="mono" href="https://linear.app/geoforge3d/issue/{esc(idf)}">{esc(idf)}</a><span class="kid-t">{esc(k["title"][:60])}</span></div>
<div class="kid-a">↳ 还没起跑 <span class="src">机器测的</span></div></div>''')
    tail = [f"{len(done)} 张已完成"] if done else []
    if canc: tail.append(f"{len(canc)} 张已取消")
    tailhtml = f'<div class="kid-tail">另有 {" · ".join(tail)}(不展示)</div>' if tail else ""
    key = rid.replace("-", "").lower()
    cards.append(f'''<details class="epic"><summary>
<span class="e-st st-linear">{esc(roots[rid]["state"]["name"])}</span>
<a class="mono e-id" href="{esc(roots[rid]["url"])}">{esc(rid)}</a><span class="e-n">{esc(SHORT.get(rid, ""))}</span>
<span class="e-c">{len(live)} 在跑 · {len(waiting)} 等依赖 · {len(freed)} 可起跑 · {len(idle)} 未开始 · 共 {len(kids)}</span></summary>
<div class="e-b">{"".join(body)}{tailhtml}
<div class="comment"><label for="c-{key}">对这个 Epic 留言</label><textarea id="c-{key}" data-comment-key="{key}" placeholder="留言……"></textarea></div>
</div></details>''')

CSS = """:root{color-scheme:light;--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#86868b;--navy:#1a365d;--blue:#007aff;--green:#34c759;--amber:#ff9500;--red:#ff3b30;--purple:#af52de;--line:#e5e5ea}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,system-ui,"PingFang SC","Helvetica Neue",Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 18px 70px}
header{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:20px 22px;margin-bottom:14px;border-left:4px solid var(--navy)}
h1{margin:0 0 5px;font-size:24px;letter-spacing:-.02em;color:var(--navy)}
.sub{color:var(--dim);font-size:13px}
.sec{font-size:13px;font-weight:700;color:var(--dim);margin:24px 2px 9px}
.mono{font-family:"SF Mono",Menlo,monospace;font-size:12.5px;color:var(--navy);font-weight:600;text-decoration:none}
.mono:hover{text-decoration:underline}
.urgent{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--red);overflow:hidden}
.u-row{padding:12px 16px;border-bottom:1px solid var(--line)}
.u-row:last-child{border-bottom:none}
.u-row.k-stop{background:#fbfbfd}
.u-l{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.u-kind{font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap}
.k-gate .u-kind{background:#ffe9e7;color:#c92a20}.k-ask .u-kind{background:#fff2dd;color:#a35c00}.k-stop .u-kind{background:#eeeef0;color:#6e6e73}
.u-t{color:var(--dim);font-size:12.5px}\n.u-extra{font-size:10.5px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:1px 7px;margin-left:2px}
.u-act{font-size:14px;font-weight:600;color:var(--navy);margin:6px 0 5px}
.k-stop .u-act{font-weight:500;color:var(--dim)}
.u-r{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.u-since{font-size:12px;color:var(--dim)}
.jump-off{font-size:11.5px;padding:3px 9px;border-radius:7px;border:1px dashed #c7c7cc;color:#a1a1a6;background:#fafafa;cursor:not-allowed}
.epic{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--blue);margin-bottom:9px;overflow:hidden}
.epic summary{cursor:pointer;padding:13px 16px;display:flex;align-items:center;gap:9px;flex-wrap:wrap;list-style:none}
.epic summary::-webkit-details-marker{display:none}
.epic summary::before{content:"▸";color:var(--dim);font-size:12px}
.epic[open] summary::before{content:"▾"}
.e-st{font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;background:#e3f6e9;color:#1f7a37;white-space:nowrap}
.e-n{font-weight:600}
.e-c{margin-left:auto;font-size:12px;color:var(--dim)}
.e-b{padding:4px 16px 14px;border-top:1px solid var(--line)}
.leadnote{background:#f6f9ff;border:1px dashed #c3d7f5;border-radius:9px;padding:10px 12px;margin:10px 0;font-size:13px}
.sample-tag{font-size:10.5px;font-weight:700;background:#fff4e5;color:#8a4b00;border-radius:20px;padding:2px 8px;margin-left:6px}
.ln-body{margin-top:5px;color:#4a4a4f}.ln-meta{margin-top:6px;font-size:11px;color:var(--dim)}
.kid{padding:11px 0;border-bottom:1px solid var(--line)}
.kid:last-child{border-bottom:none}
.kid-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kid-t{font-size:12.5px}
.s{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap}
.s-live{background:#e3f6e9;color:#1f7a37}.s-idle{background:#eeeef0;color:#6e6e73}.s-wait{background:#fff2dd;color:#a35c00}.s-free{background:#eef4ff;color:#1a4fa0}
.kid-a{font-size:12.5px;color:#4a4a4f;margin-top:4px}
.src{font-size:10px;color:#a1a1a6;border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-left:4px}
.kid-tail{font-size:12px;color:var(--dim);padding-top:10px}
.empty{color:var(--dim);font-size:13px;padding:14px 16px}
.comment{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
.comment label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
.comment textarea{width:100%;min-height:56px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:13.5px/1.5 inherit;resize:vertical;background:#fafafa;color:inherit}
.comment textarea:focus{outline:2px solid #bcd7ff;background:#fff}
.foot{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--amber);padding:16px 20px;margin-top:22px;font-size:13.5px}
.foot h2{margin:0 0 8px;font-size:16px;color:var(--navy)}
.foot ul{margin:6px 0 0 20px;padding:0}.foot li{margin:5px 0}
.summary-text{white-space:pre-wrap;background:#fafafa;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:13px;min-height:40px;margin-top:8px}
button{font:14px inherit;border:1px solid var(--blue);background:var(--blue);color:#fff;border-radius:8px;padding:7px 14px;cursor:pointer;margin:8px 6px 0 0}
button.secondary{background:#fff;color:var(--blue)}
.status{font-size:13px;color:var(--dim);margin-left:6px}
@media(max-width:700px){main{padding:16px 10px 56px}.epic summary{padding:12px 13px}.e-c{margin-left:0;width:100%}}"""

JS = """(function(){
var MARK='【页面意见汇总】FLY-2457';var PREFIX='fly2457-page:'+location.pathname+':';var LIMIT=1800;
function g(k){try{return localStorage.getItem(k)}catch(e){return null}}
function s(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function d(k){try{localStorage.removeItem(k)}catch(e){}}
var areas=Array.prototype.slice.call(document.querySelectorAll('textarea[data-comment-key]'));
function label(a){var e=a.closest('details');if(!e)return a.getAttribute('data-comment-key');
var m=e.querySelector('.mono');var n=e.querySelector('.e-n');
return (m?m.textContent:'')+(n&&n.textContent?' '+n.textContent:'');}
function parts(){var p=[];areas.forEach(function(a){var v=a.value.trim();if(v)p.push('['+label(a)+'] '+v)});return p}
function chunk(p){var c=[],cur=MARK;p.forEach(function(x){var t=cur+'\\n'+x;
if(t.length>LIMIT&&cur!==MARK){c.push(cur);cur=MARK+'\\n'+x}else cur=t});c.push(cur);return c}
var host=document.getElementById('summary-chunks');
function render(){var p=parts();while(host.firstChild)host.removeChild(host.firstChild);
var cs=chunk(p);cs.forEach(function(c,i){var w=document.createElement('div');
if(cs.length>1){var l=document.createElement('div');l.className='sub';l.textContent='第 '+(i+1)+' / '+cs.length+' 段(每段都要单独复制)';w.appendChild(l)}
var pre=document.createElement('div');pre.className='summary-text';pre.textContent=p.length?c:MARK+'\\n(还没有留言)';w.appendChild(pre);
if(cs.length>1){var b=document.createElement('button');b.type='button';b.className='secondary';b.textContent='复制第 '+(i+1)+' 段';
b.addEventListener('click',function(){copy(c)});w.appendChild(b)}host.appendChild(w)})}
var st=document.getElementById('copy-status');
function setS(t){st.textContent=t;setTimeout(function(){st.textContent=''},2500)}
function fb(t){var ta=document.createElement('textarea');ta.value=t;ta.setAttribute('readonly','');
ta.style.position='fixed';ta.style.left='-9999px';document.body.appendChild(ta);ta.select();
var ok=false;try{ok=document.execCommand('copy')}catch(e){ok=false}document.body.removeChild(ta);return ok}
function copy(t){if(navigator.clipboard&&navigator.clipboard.writeText){
navigator.clipboard.writeText(t).then(function(){setS('已复制')},function(){setS(fb(t)?'已复制':'复制失败,请手动选择')})}
else setS(fb(t)?'已复制':'复制失败,请手动选择')}
areas.forEach(function(a){var v=g(PREFIX+a.getAttribute('data-comment-key'));if(v){a.value=v;var e=a.closest('details');if(e)e.open=true}
a.addEventListener('input',function(){s(PREFIX+a.getAttribute('data-comment-key'),a.value);render()})});
document.getElementById('copy-all').addEventListener('click',function(){copy(chunk(parts()).join('\\n\\n'))});
document.getElementById('clear-all').addEventListener('click',function(){
areas.forEach(function(a){a.value='';d(PREFIX+a.getAttribute('data-comment-key'))});render();setS('已清空')});
var root=document.querySelector('[data-generated-at]');var age=document.getElementById('age');
function tick(){var t=Date.parse(root.getAttribute('data-generated-at'));
if(isFinite(t)){var m=Math.max(0,Math.floor((Date.now()-t)/60000));age.textContent='你打开时它已 '+m+' 分钟旧'}}
tick();setInterval(tick,60000);render();})();"""

page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flywheel · 现在在做什么</title><style>{CSS}</style></head><body><main>
<header data-generated-at="{esc(gen)}">
<h1>Flywheel · 现在在做什么</h1>
<div class="sub">全部默认收起,点开才展开 · 数据来自 Linear 与引擎本身 · <span id="age"></span></div>
</header>

<div class="sec">⚡ 现在要你看 · {len(ATT)} 件</div>
<div class="urgent">{rows}</div>

<div class="sec">在做的 Epic · {shown} 个(全做完的不显示)</div>
{"".join(cards)}

<div class="foot">
<h2>关于这一页,你该知道的四件</h2>
<ul>
<li><b>「跳 Discord」现在是灰的,写着「还没接通」。</b> 拼这条链接要的东西都有了,但<b>还没有人真的点开验证过</b> —— 没验证过的能用,就是没能用,所以我不把它做成能点的样子。</li>
<li><b>那句「💬 判断」现在还没有人写。</b> 页面上唯一一条标着「示例」,是给你看形状的。真有人写了才会出现真句子;<b>没人写就只显示机器测到的那几行,不会假装有判断</b>。</li>
<li><b>Epic 的状态直接照抄 Linear</b>,页面不另算一份、也不另存一份。所以「哪些在做」= 你排进 In Progress 的那些。</li>
<li><b>你在这一页写的留言不会自动发给我。</b> 写完点下面「复制全部」贴回 thread —— 这一条我不会假装能自动。</li>
</ul>
<div id="summary-chunks"></div>
<button id="copy-all" type="button">复制全部留言</button><button id="clear-all" type="button" class="secondary">清空本页留言</button><span class="status" id="copy-status"></span>
</div>
</main><script nonce="__CSP_NONCE__">{JS}</script></body></html>'''

# ---- build-time gates ----
# F13 bans names in the page's OWN language. A name inside a Linear title is the
# founder's own data — scrubbing it would falsify the row — so the gate strips
# every data-derived string first and checks what the page itself says.
NAMES = ("塔大", "Tadashi", "Honey Lemon", "Annie", "Flavio")
data_strings = [(x.get("title") or {}).get("value", "") for x in items.values()]
data_strings += [k["title"] for n in lin.values() for k in n["children"]["nodes"]]
data_strings += [r["title"] for r in roots.values()]
# Linear slugifies the title into the issue URL, so a name in a title rides along
# in the href too — same data, same reasoning.
data_strings += [r.get("url", "") for r in roots.values()]
data_strings += [(x.get("url") or {}).get("value", "") for x in items.values()]
chrome = page
for s_ in sorted({esc(d) for d in data_strings if d}, key=len, reverse=True):
    chrome = chrome.replace(s_, "")
    chrome = chrome.replace(esc(s_[:60]), "")
bad = [n for n in NAMES if n in chrome]
if bad: sys.exit(f"personal name in the page's own wording (F13): {bad}")
in_data = sorted({f"{n} in {d[:52]}" for n in NAMES for d in data_strings if n in d})
if in_data:
    print("note: a name rides inside Linear's own strings, left verbatim (her data, not our wording):")
    for line in in_data: print("   ", line)
for claim in ("真能点", "已接通", "点得动"):
    if claim in page: sys.exit(f"unverified capability claimed: {claim}")
if "示例 · 还没有人写过" not in page: sys.exit("lead_note sample lost its label")
if page.count('class="u-row') != len(ATT): sys.exit("attention row count drifted")
for a in ATT:
    if not a["kind"] or not a["action"]: sys.exit(f"attention row missing a fixed segment: {a['idf']}")
if shown == 0: sys.exit("no Epic rendered — check the data fetch before publishing an empty page")
if page.count("<details") != shown: sys.exit("Epic card count drifted")
if "__CSP_NONCE__" not in page: sys.exit("nonce placeholder missing")
if re.search(r"\son[a-z]+=", page): sys.exit("inline event handler")
if re.search(r'<(script|link|img)[^>]+(src|href)="https?://', page): sys.exit("external resource")
OUT.write_text(page, encoding="utf-8")
print(f"wrote {OUT.name} ({len(page.encode())} bytes) · attention={len(ATT)} · epics={shown}")
