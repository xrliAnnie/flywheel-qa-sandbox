#!/usr/bin/env python3
"""Build the FLY-2910 founder design page: static content + inlined local SVGs + replay numbers.

All replay-derived text is passed through html.escape before interpolation.
Usage: python3 build_report.py  (run from anywhere; paths are relative to this file)
"""
import html
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
DOC = HERE.parent
OUT = DOC / "founder-design-FLY-2910.html"
REPLAY = json.loads((HERE / "replay-0925-design-freeze.json").read_text())  # v1 heuristics (rejected in R1)
STRICT = json.loads((HERE / "replay-0925-strict.json").read_text())        # v2 upper bound (generation assumed)
LOWER = json.loads((HERE / "replay-0925-strict-verified.json").read_text())  # v2 verified lower bound


def svg(name):
    p = DOC / f"{name}.svg"
    if not p.exists():
        src = html.escape((DOC / f"{name}.mmd").read_text())
        return (f'<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong>'
                f'<p>本地渲染失败，下面是 Mermaid 图源。</p><pre>{src}</pre></div>')
    s = p.read_text()
    s = re.sub(r"<\?xml[^>]*>", "", s)
    return f'<div class="diagram">{s}</div>'


e = html.escape
R = REPLAY
S = STRICT
before, full, title, v1 = (S["before_wake_batches"], S["after_wake_batches"],
                           R["title"]["wake_batches_after"], R["full"]["wake_batches_after"])
bl, fl = S["before_by_lead"], S["after_by_lead"]
assert before == R["before_wake_batches"], "v1/v2 replays must cover the same frozen window"
pct = round(100 * (before - full) / before)
LEAD = {"claude-infra-bot-lead": "claw（告警值班）", "flywheel-eng-lead": "工程 Lead"}

rows = []
for k in S["per_key"][:12]:
    wake = sum(v for kk, v in k.items() if kk.startswith("wake:"))
    sup = k.get("suppress:equivalent_delivered", 0)
    dig = k.get("digest:info", 0)
    rows.append(
        f"<tr><td>{e(LEAD.get(k['lead'], k['lead']))}</td><td><code>{e(k['title'])}</code></td>"
        f"<td>{wake + sup + dig}</td><td>{wake}</td><td>{sup}</td><td>{dig}</td></tr>")

SECTIONS = [
    ("summary", "一句话", f"""
<p class="lead">同一个 Lead 在 6 小时内又收到一条告警时，只有它和一条<b>已经确认送到</b>的告警<b>完全一样</b>（同类、同标题、同对象、同处理要求、同数量，只有时间不同），而且没变严重、仍是同一张工单，才只记账、不叫醒；其余一律照常叫醒，并在信里写明「同类 6 小时内第几次、合并了几次」。</p>
<p class="small">Lead：负责一个部门的常驻 AI 负责人（如工程 Lead、告警值班 claw）。叫醒：往 Lead 的收件箱投一封信，让它读完全部上下文处理一轮，每次都要花掉大量 token。</p>
<div class="metrics"><div><b>{before} → {full}</b><span>9-25 告警叫醒次数（截至 PT 21:00），上限估算</span></div>
<div><b>-{round(100*(before-LOWER['after_wake_batches'])/before)}% ~ -{pct}%</b><span>叫醒减少：已验证下限 ~ 上限</span></div>
<div><b>{bl.get('flywheel-eng-lead', 0)} → {fl.get('flywheel-eng-lead', 0)}</b><span>工程 Lead 本单零节省（原因见「要你知道的口径」）</span></div></div>
"""),
    ("tension", "要你知道的口径", f"""
<p>你点名的例子：9-25 工程 Lead 连续收到 <code>Cross-family review job failed</code>（跨模型评审任务失败）。回放发现这串告警<b>每一条都是不同的评审</b>，而且大多写着「请重试，门还关着」——这是 Lead 真要去做的事。</p>
<p>按 issue 的「对象不同照常叫醒」和「不能吞掉真实待办」，它们必须叫醒。所以<b>本单对工程 Lead 零节省</b>；省下来的都在 claw：同一批僵尸 session 被反复报告、同一个 cmux 监视器进程反复报警，以及 info 级的「评审通过但有建议」。</p>
<table><tr><th>算法</th><th>9-25 叫醒</th><th>说明</th></tr>
<tr><td>改前</td><td>{before}</td><td>每封告警信都叫醒</td></tr>
<tr><td>只看标题（FLY-2904 估算用的算法）</td><td>{title}</td><td>会把不同评审的失败合成一条，吞掉待办，否决</td></tr>
<tr><td>第一版：猜对象、猜处理要求</td><td>{v1}</td><td>评审发现会把不同的待办误判成同一件，例如新增一个僵尸 session、换一个评审请求。否决</td></tr>
<tr><td><b>本设计：只合并能证明完全一样、且已送达的</b></td><td><b>{full}–{LOWER['after_wake_batches']}</b></td><td>数量一变、对象一变就叫醒，比「翻倍才叫醒」更保守。下限：历史信没有「属于哪一代工单」的记录，按规则只能照常叫醒，只剩 info 进摘要；上限：假设同一件事在 6 小时内是同一张工单。上线后开始记录，实际值落在两者之间</td></tr></table>
<p class="small">FLY-2904 的 27.1 亿 token 是「只看标题」口径的上界。本设计只拿可证明安全的那部分，按 9-25 比例约为其中 43%，粗估 14 天 11–12 亿（以缓存读为主，上线后复测才算数）。口径选择已非阻塞地报给 Tadashi，按推荐推进。</p>
"""),
    ("flow", "核心流程", f"""
<p>告警本身完全不动：Discord 帖照发、工单照开、founder 看到的一样。只在 Lead 的<b>收件箱</b>（每个 Lead 唯一的信件队列）领信那一步，加一道「要不要叫醒」的判定。</p>
{svg('flow')}
<p class="small">两种「载体」（告警到达 Lead 的两条路）：Bridge 直接写的 <code>[infra_alert]</code> 信，和告警机器人发在 #flywheel-alerts 的帖子。两者最后都进同一个收件箱，所以一个卡口就能全覆盖。</p>
"""),
    ("rules", "判定规则", f"""
{svg('rules')}
<p class="small">等价指纹：由类别、原始标题和正文算出的一串校验码。正文里只把时间戳抹掉，ID、issue 号、数字、session 清单都原样保留，所以对象或数量变了，指纹就不同。清单被截断、看不全的告警无法证明一样，一律叫醒；唯一例外是僵尸积压，生产者本身就对完整清单算了签名，可以直接用。工单代次：同一个问题关单后再复发，会开出新一代工单；每封信入队时就记下它属于哪一代（用那一代首次开单的编号），代次不同也叫醒。「已经确认送到」只在投递回执之后才记下，所以一封没送到的信永远不会成为合并后续告警的依据。</p>
<p class="small">info 级例外：<code>flag_scan_handoff</code>（每周 flag 扫描就绪，等 Lead 去问你）虽然是 info，但带待办，照常叫醒。</p>
"""),
    ("model", "数据结构", f"""
{svg('model')}
<p class="small">被合并的信不会消失：它仍在收件箱里，标成 <code>audit_only</code>（只记审计、不交给模型），写明原因，并直接结算归档。<code>alert_wake_dedup_state</code> 是新加的一张小表，每个 Lead、每个等价指纹一行，记住「哪封信已经送达、6 小时窗口从什么时候开始算」；它丢了也只会多叫醒，不会少叫醒。</p>
"""),
    ("replay", "9-25 真实回放（设计阶段快照）", f"""
<p>数据来自线上收件箱（只读），PT 9-25 00:00–21:00，共 {S['letters']} 封告警信、{before} 次叫醒。实现阶段会用真正的判定代码对 9-25 整天重跑，并逐条列出每封被合并的信和它对应的已送达信，作为验收数字。</p>
<div class="scroll"><table><tr><th>收件 Lead</th><th>告警（规范化标题）</th><th>封数</th><th>叫醒</th><th>合并</th><th>进摘要</th></tr>{''.join(rows)}</table></div>
"""),
    ("tradeoffs", "取舍与否决的方案", """
<table><tr><th>方案</th><th>结论</th><th>理由</th></tr>
<tr><td>在收件箱领信时判定（本设计）</td><td>采用</td><td>一个卡口覆盖两种载体，连脚本直发的帖子也在内；告警、工单、Discord 全部不动</td></tr>
<tr><td>在告警产生处就不发</td><td>否决</td><td>要改三处以上，还会让 founder 在 Discord 看到的内容变少</td></tr>
<tr><td>只按标题合并</td><td>否决</td><td>会把「不同评审失败、各自要重试」合成一条，吞掉真实待办</td></tr>
<tr><td>猜对象和处理要求（第一版）</td><td>否决</td><td>设计评审给出了真实反例：会把新增的僵尸 session、同一任务里不同的评审请求误判成同一件</td></tr>
<tr><td>新建定时摘要服务</td><td>否决</td><td>issue 要求不新建 daemon；claw 也没有现成的定时摘要。改为「下次叫醒时信首附摘要」，全量看告警看板 <code>/duty/alert-board</code></td></tr>
<tr><td>从收件箱历史实时推算窗口</td><td>否决</td><td>每次都要重扫、重解析，而且归档时机不可控；改用一张小表，丢了也只会多叫醒</td></tr></table>
"""),
    ("boundary", "诚实边界：做什么，不做什么", """
<p><b>做：</b>两种载体的告警信按规则合并；info 进摘要；项目级开关 <code>lead_alert_wake_dedup</code>，默认开、关掉立即恢复逐条叫醒；单测覆盖 issue 列的五类情形；用 9-25 真实序列回放出改前改后对比。</p>
<p><b>不做：</b>不改任何告警的产生和发送；不放宽「对象不同就叫醒」；不补投已合并的历史信（它们可以逐条查）；不修顺带发现的收件箱优先级排序疑点，只记为发现交给 Lead。</p>
<p><b>已知限制：</b>只合并能证明完全一样的告警，所以以后新增的告警默认不会被合并；纯文字格式（plain）的告警帖认不出类别，照常叫醒（9-23 以来 0 次）；摘要最多送一次，承载它的那封信如果最终投递失败，摘要会丢，但全量仍能在看板查；回放看不到窗口内「关单后又复发」（历史工单表只留最新一代），线上判定看得到；只对新领的信判定，重投的信一律照投，所以实际节省可能略低于回放。</p>
"""),
]

CSS = """*{box-sizing:border-box}:root{--bg:#f5f5f7;--fg:#1d1d1f;--dim:#86868b;--card:#fff;--blue:#007aff;--navy:#1a365d}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:40px 16px 64px}header{padding:4px 4px 18px}
.eyebrow{color:var(--dim);font-size:13px;letter-spacing:1px;font-family:'SF Mono',monospace}
h1{font-size:clamp(26px,5vw,40px);line-height:1.2;margin:8px 0 10px;color:var(--navy)}
h2{font-size:21px;margin:0 0 14px;color:var(--navy)}
section{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid var(--blue);margin:18px 0;padding:22px 20px}
section#tension{border-left-color:#ff9500}section#boundary{border-left-color:#af52de}section#summary{border-left-color:#34c759}
.lead{font-size:18px}.small{font-size:14px;color:#515154}code{font-family:'SF Mono',monospace;font-size:13px;background:#f2f2f5;padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:14px}.metrics div{background:#f5f5f7;border-radius:10px;padding:12px}
.metrics b{display:block;font-size:28px;color:var(--blue)}.metrics span{font-size:13px;color:#515154}
table{width:100%;border-collapse:collapse;font-size:14px;margin:10px 0}th,td{text-align:left;padding:9px 7px;border-bottom:1px solid #e5e5ea;vertical-align:top}th{color:var(--dim);font-weight:600}
.scroll{overflow-x:auto}.diagram{overflow-x:auto;margin:10px 0}.diagram svg{max-width:100%;height:auto;display:block;margin:0 auto}
.pending{padding:16px;background:#fff9ed;border:1px solid #edc77c;border-radius:10px}pre{white-space:pre-wrap;font-size:12px}
.comment{margin-top:16px;padding-top:12px;border-top:1px solid #eee}label{display:block;font-size:13px;color:var(--dim);margin-bottom:6px}
textarea{width:100%;min-height:72px;resize:vertical;border:1px solid #d2d2d7;border-radius:10px;padding:10px;font:14px/1.5 -apple-system,system-ui,sans-serif;background:#fafafa;color:var(--fg)}
button{border:0;border-radius:10px;background:var(--blue);color:#fff;font-size:14px;padding:10px 16px;cursor:pointer;margin:8px 8px 0 0}
#chunks textarea{min-height:120px}#status{color:var(--dim);font-size:13px}
@media(max-width:640px){main{padding:24px 12px}section{padding:18px 14px}.metrics{grid-template-columns:1fr}td,th{padding:7px 4px;font-size:13px}}"""

JS = r"""(function(){
var prefix='fly2910-comments:'+location.pathname+':';
function get(k){try{return localStorage.getItem(prefix+k)||''}catch(e){return ''}}
function put(k,v){try{localStorage.setItem(prefix+k,v)}catch(e){}}
var boxes=Array.prototype.slice.call(document.querySelectorAll('textarea[data-key]'));
var MARK='【页面意见汇总】FLY-2910';
function chunks(){
  var parts=[];boxes.forEach(function(b){var v=b.value.trim();if(v)parts.push('【'+b.getAttribute('data-title')+'】\n'+v)});
  if(!parts.length)return [];
  var out=[],cur=MARK;
  parts.forEach(function(p){
    if(cur.length+p.length+2>1800&&cur!==MARK){out.push(cur);cur=MARK}
    if(p.length+MARK.length+2>1800){for(var i=0;i<p.length;i+=1700){var s=p.slice(i,i+1700);if(cur!==MARK){out.push(cur);cur=MARK}out.push(MARK+'\n'+s)}return}
    cur+='\n\n'+p});
  if(cur!==MARK)out.push(cur);
  return out}
function render(){
  var host=document.getElementById('chunks');while(host.firstChild)host.removeChild(host.firstChild);
  var cs=chunks();
  if(!cs.length){var p=document.createElement('p');p.className='small';p.textContent='还没有意见。在上面任一卡片下写下意见，这里会自动汇总。';host.appendChild(p);return}
  cs.forEach(function(c,i){var d=document.createElement('div');d.className='chunk';var l=document.createElement('label');l.textContent='第 '+(i+1)+' / '+cs.length+' 段';var t=document.createElement('textarea');t.readOnly=true;t.value=c;d.appendChild(l);d.appendChild(t);host.appendChild(d)})}
function fallback(text){var t=document.createElement('textarea');t.value=text;t.setAttribute('readonly','');t.style.position='fixed';t.style.top='-1000px';document.body.appendChild(t);t.select();var ok=false;try{ok=document.execCommand('copy')}catch(e){ok=false}document.body.removeChild(t);return ok}
function status(s){document.getElementById('status').textContent=s}
function copy(){
  var text=chunks().join('\n\n');if(!text){status('没有可复制的意见。');return}
  var done=function(){status('已复制全部意见。')},fail=function(){status(fallback(text)?'已复制全部意见。':'复制失败，请手动选中上面的文字复制。')};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,fail)}else{fail()}}
boxes.forEach(function(b){b.value=get(b.getAttribute('data-key'));b.addEventListener('input',function(){put(b.getAttribute('data-key'),b.value);render()})});
document.getElementById('copy-all').addEventListener('click',copy);
render()})();"""


def section(sid, title_, body):
    t = e(title_)
    return (f'<section id="{sid}"><h2>{t}</h2>{body}<div class="comment"><label for="c-{sid}">对「{t}」的意见</label>'
            f'<textarea id="c-{sid}" data-key="{sid}" data-title="{t}" placeholder="写下意见，自动保存在本机"></textarea></div></section>')


page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>告警叫醒去重设计</title><style>{CSS}</style></head><body><main>
<header><div class="eyebrow">FLY-2910 · ENGINEERING DESIGN · 2026-09-25</div><h1>告警别反复叫醒 Lead</h1>
<p class="small">同一件事 6 小时内只叫醒一次；状况变了照常叫醒；info 只进摘要。</p></header>
{''.join(section(*s) for s in SECTIONS)}
<section id="all-comments"><h2>意见汇总</h2><p class="small">上面各卡片的意见会自动汇总到这里，复制后发给 Tadashi 即可。汇总是修改意见，不代表通过。</p>
<div id="chunks"></div><button id="copy-all" type="button">复制全部意见</button><div id="status"></div></section>
</main><script nonce="__CSP_NONCE__">{JS}</script></body></html>
"""
OUT.write_text(page)
print(OUT, len(page))
