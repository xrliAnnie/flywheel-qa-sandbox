# -*- coding: utf-8 -*-
"""FLY-1851 PRD v2.0 -> 可互动终审页. 内容从文件流过,不手抄."""
import re, html, io, sys

SRC='product/doc/FLY-1851-voice-meeting-mode/prd.md'
OUT='product/doc/FLY-1851-voice-meeting-mode/final-review.html'

txt=open(SRC,encoding='utf-8').read()
lines=txt.split('\n')

# ---------- 切节 ----------
idx=[i for i,l in enumerate(lines) if l.startswith('## ')]
pre='\n'.join(lines[:idx[0]])
secs=[]
for a,b in zip(idx, idx[1:]+[len(lines)]):
    secs.append((lines[a][3:].strip(), '\n'.join(lines[a+1:b])))

# ---------- 🔴 founder 面 vs 工程面(她 2026-08-24 的常设规矩)----------
# 判据(Lead 给):这一格如果她读到会问「这什么意思」,它就不该在正文里。
# ⛔ 不是解释得更好,是拿掉 —— 撤到页底的工程附录,交 Tadashi。
ENG_KEYS = [
 '时刻口径','一次**口径统一**','一处已更正的出处错误','读本文引用的证据之前',
 'voice-bridge 那条腿','转写错语料','v3 是**音频驱动**','只读探测',
 '闭麦动作**是存在的**','闭麦:结果到齐','闭麦那一半','17. 🔴 常开流',
 '一轮问答的三个数','方法学限制','数据侧已经齐了','「打不断」的原因',
 'v3 已焊通','自查:同一个形状','P-6 结果到齐','「先应一声」与「编一个答案」',
 '音频节拍','1911 今日增量','走的不是同一条传输','载体定了','P-6c 规格',
 '原型交接吸收','P-6c 通过',
]
def is_eng(t):
    return any(k in t for k in ENG_KEYS)
her_secs=[(t,b) for t,b in secs if not is_eng(t)]
eng_secs=[(t,b) for t,b in secs if is_eng(t)]

# 正文小节里明标「工程侧 / 不问她」的子块也撤走(唯一命中:§24 的 A 栏)
def strip_eng_sub(body):
    out=[];drop=[];L=body.split('\n');i=0
    while i<len(L):
        m=re.match(r'^(#{3,4})\s+(.*)$', L[i])
        if m and re.search(r'工程侧|不问她|附录.*观察|§17 那条硬前提|那组预算数字', m.group(2)):
            lv=len(m.group(1)); drop.append(m.group(2)); j=i+1
            while j<len(L):
                m2=re.match(r'^(#{1,6})\s', L[j])
                if m2 and len(m2.group(1))<=lv: break
                j+=1
            i=j; continue
        out.append(L[i]); i+=1
    return '\n'.join(out), drop
_dropped=[]
_h=[]
for t,b in her_secs:
    nb,d=strip_eng_sub(b)
    if d: _dropped.append((t,d))
    _h.append((t,nb))
her_secs=_h

# ---------- 行内 md ----------
def inl(s):
    s=html.escape(s)
    s=re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s=re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s=re.sub(r'~~([^~]+)~~', r'<del>\1</del>', s)
    s=re.sub(r'\[\[([^\]]+)\]\]', r'\1', s)
    return s

def md(block):
    o=[]; i=0; L=block.split('\n')
    while i<len(L):
        l=L[i]
        if l.startswith('```'):
            j=i+1; buf=[]
            while j<len(L) and not L[j].startswith('```'):
                buf.append(L[j]); j+=1
            o.append('<pre>'+html.escape('\n'.join(buf))+'</pre>'); i=j+1; continue
        if l.startswith('|') and i+1<len(L) and re.match(r'^\|[\s:|-]+\|$', L[i+1].strip()):
            rows=[]; j=i
            while j<len(L) and L[j].startswith('|'):
                rows.append(L[j]); j+=1
            cells=[[c.strip() for c in r.strip().strip('|').split('|')] for r in rows]
            head=cells[0]; body=cells[2:]
            t=['<table><thead><tr>']+['<th>'+inl(c)+'</th>' for c in head]+['</tr></thead><tbody>']
            for r in body:
                t.append('<tr>'+''.join('<td>'+inl(c)+'</td>' for c in r)+'</tr>')
            t.append('</tbody></table>'); o.append(''.join(t)); i=j; continue
        m=re.match(r'^(#{3,6})\s+(.*)$', l)
        if m:
            lv=min(len(m.group(1)),6); o.append(f'<h{lv}>'+inl(m.group(2))+f'</h{lv}>'); i+=1; continue
        if l.startswith('> '):
            buf=[]
            while i<len(L) and (L[i].startswith('> ') or L[i].strip()=='>'):
                buf.append(L[i][2:] if L[i].startswith('> ') else ''); i+=1
            o.append('<blockquote>'+md('\n'.join(buf))+'</blockquote>'); continue
        if re.match(r'^[-*]\s+', l) or re.match(r'^\d+\.\s+', l):
            ol=bool(re.match(r'^\d+\.\s+', l)); buf=[]
            while i<len(L) and (re.match(r'^[-*]\s+', L[i]) or re.match(r'^\d+\.\s+', L[i]) or (L[i].startswith('  ') and L[i].strip() and buf)):
                if L[i].startswith('  ') and buf and not re.match(r'^\s*[-*\d]', L[i].strip()[:1] or 'x'):
                    buf[-1]+=' '+L[i].strip()
                else:
                    buf.append(re.sub(r'^([-*]|\d+\.)\s+','',L[i]))
                i+=1
            tag='ol' if ol else 'ul'
            o.append(f'<{tag}>'+''.join('<li>'+inl(x)+'</li>' for x in buf)+f'</{tag}>'); continue
        if l.strip()=='---':
            o.append('<hr>'); i+=1; continue
        if not l.strip():
            i+=1; continue
        buf=[l]; i+=1
        while i<len(L) and L[i].strip() and not re.match(r'^(\||```|>|#{3,6}\s|[-*]\s|\d+\.\s|---$)', L[i]):
            buf.append(L[i]); i+=1
        o.append('<p>'+inl(' '.join(buf))+'</p>')
    return ''.join(o)

# ---------- 抽 R 条款 ----------
rmap={}; rgrade={}
_L=txt.split('\n')
for i,l in enumerate(_L):
    m=re.match(r'^- \*\*R-(\d+)\b(.*)$', l)
    if not m: continue
    n=int(m.group(1))
    if n in rmap: continue
    body=re.sub(r'^\*\*\s*','',m.group(2)).strip()
    body=re.sub(r'^([⭐🔴✅]*\s*)','',body)
    # 续行:紧随其后的缩进行
    ctx=[l]; j=i+1
    while j<len(_L) and _L[j].startswith('  ') and _L[j].strip():
        ctx.append(_L[j]); j+=1
    c='\n'.join(ctx)
    if '未决' in c:                                   g='undec'
    elif re.search(r'未验|未被测|没被测|只验过一次|n=1|未测', c): g='weak'
    elif re.search(r'已验|实测|已答|通过|已关', c):      g='ok'
    else:                                             g='none'
    src = 'her' if '她' in c else 'us'
    rmap[n]=body; rgrade[n]=(src,g)
ENG_R={31,33,36}   # 事件流取值 / 音频节拍 / 回合制机制 —— 撤到工程附录
retracted={44:'「只有 notes 没有 action item 必须一路过」—— <strong>已撤销</strong>:她砍了快慢车道(§41)'}

# ---------- 组页 ----------
def box(k, label):
    return (f'<div class="cbox"><label for="t{k}">{label}</label>'
            f'<textarea id="t{k}" data-k="{k}" rows="3" placeholder="写在这里 · 自动保存"></textarea></div>')

B=io.StringIO(); w=B.write
w('<!DOCTYPE html>\n<html lang="zh">\n<head>\n<meta charset="utf-8">\n')
w('<meta name="viewport" content="width=device-width, initial-scale=1">\n')
w('<meta name="robots" content="noindex">\n<title>FLY-1851 会议模式 PRD v2.0 · 终审</title>\n')
w('''<style>
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#6e6e73;--navy:#1a365d;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--line:#e5e5ea}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,system-ui,"PingFang SC",sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:840px;margin:0 auto;padding:16px 14px 90px}
h1{font-size:22px;margin:6px 0 2px;letter-spacing:-.3px}
.sub{color:var(--dim);font-size:13px;margin-bottom:14px}
.card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:14px;margin:12px 0;border-left:4px solid var(--line)}
.card.hot{border-left-color:var(--red)} .card.ask{border-left-color:var(--amber)} .card.req{border-left-color:var(--blue)} .card.all{border-left-color:var(--dim)}
h2{font-size:17px;margin:0 0 8px;color:var(--navy)}
h3{font-size:15px;margin:14px 0 6px} h4,h5,h6{font-size:14px;margin:12px 0 5px}
p{margin:7px 0} ul,ol{margin:7px 0;padding-left:20px} li{margin:3px 0}
code{background:#f2f2f7;border-radius:4px;padding:1px 5px;font:13px 'SF Mono',ui-monospace,monospace}
pre{background:#f2f2f7;border-radius:8px;padding:10px;overflow-x:auto;font:12.5px/1.5 'SF Mono',ui-monospace,monospace;margin:8px 0}
blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--blue);background:#f7f9ff;border-radius:0 8px 8px 0}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:#fafafa;font-weight:600;white-space:nowrap}
hr{border:0;border-top:1px solid var(--line);margin:12px 0}
del{color:var(--dim)}
.rl{list-style:none;padding:0;margin:6px 0}
.rl li{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);align-items:flex-start}
.rl li:last-child{border-bottom:0}
.rn{flex:0 0 52px;font:600 13px 'SF Mono',ui-monospace,monospace;color:var(--navy)}
.rt{flex:1;font-size:14.5px}
.rl li.gone .rt{color:var(--dim)}
.gr{flex:0 0 40px;text-align:right;font-size:13px;white-space:nowrap}
.rl li.g-weak{background:#fffaf0} .rl li.g-undec{background:#fff5f5} .rl li.g-none{opacity:.86}
details{margin:8px 0;background:var(--card);border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
details>summary{cursor:pointer;padding:11px 13px;font-weight:600;font-size:15px;color:var(--navy);list-style:none;border-radius:10px}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"▸ ";color:var(--dim)}
details[open]>summary::before{content:"▾ "}
.dbody{padding:0 13px 13px}
.cbox{margin:12px 0 2px}
.cbox label{display:block;font-size:12.5px;color:var(--dim);margin-bottom:4px}
textarea{width:100%;border:1px solid var(--line);border-radius:8px;padding:9px;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#fcfcfd;resize:vertical}
textarea:focus{outline:2px solid var(--blue);outline-offset:-1px}
.bar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);border-top:1px solid var(--line);padding:9px 12px;display:flex;gap:9px;align-items:center;backdrop-filter:saturate(180%) blur(12px)}
button{font:600 15px -apple-system,system-ui,sans-serif;border:0;border-radius:9px;padding:10px 15px;background:var(--blue);color:#fff}
button.sec{background:#e9e9ee;color:var(--ink)}
#st{font-size:12.5px;color:var(--dim);flex:1}
#st.good{color:var(--green)} #st.bad{color:var(--red)}
#dump{display:none;margin:10px 0 0;min-height:150px}
.tip{font-size:12.5px;color:var(--dim);margin:4px 0 0}
</style>
</head>
<body>
<div class="wrap">
''')
w('<h1>FLY-1851 会议模式 · PRD v2.0(定稿)</h1>\n')
w('<div class="sub">终审用 · 正文只留你能判的 · 工程细节已撤到页底附录</div>\n')
w('<div class="card hot"><h2>怎么用这一页</h2>'
  '<p><strong>你要判的是「有没有什么需要 update」。</strong></p>'
  '<p><b>这一版按你今天那条规矩重出了</b>:工程细节全部从正文撤走 —— <b>怎么做的、里面怎么转的、拿什么数当合格线</b>,'
  '<b>一格都不在这上面</b>,已经整块挪到页底的工程附录,交 Tadashi。</p>'
  '<ul><li>正文三块:成色 / 等你判的 / 需求清单 —— <strong>都是你能判的</strong>。</li>'
  '<li>⚠️ <strong>不是全文了</strong>:撤掉的部分一个字没删,在最后那张<strong>工程附录</strong>里,<strong>你不用读</strong>。</li>'
  '<li>哪里想说什么就写在下面的框里 —— <strong>自动保存,刷新还在</strong>。</li>'
  '<li>写完点底部 <strong>一键汇总复制</strong>,粘回 issue thread。</li></ul>'
  '<p class="tip">⚠️ 这个页面回传不了数据 —— <strong>不复制粘回来,我收不到。</strong></p></div>\n')

# ⓪ 待你裁 —— 本轮 0 格(2026-08-24:七格她一轮全答完了)
w('<div class="card hot"><h2>⓪ 待你裁 —— 本轮 <b>0 格</b></h2>')
w('<p><b>原来那七格,你已经全答了</b>(2026-08-24)。'
  '⛔ 所以这一页<b>不再把它们列出来重问你一遍</b> —— 你说过「我记得我都已经回答过」,你是对的。</p>')
w('<p class="tip">⚠️ <b>「0 格待你裁」不等于「没有开着的格子」</b> —— 开着的还有,只是<b>不在你这儿</b>:'
  '等待音关掉之后靠什么 · 简报备好到开会之间那段 · 半小时那条证据够不够硬。<b>这三件我们自己定,不占你的时间。</b></p>')
w(box('pend','这一页有什么要改的?写在这里'))
w('</div>\n')

# ① 六条成色 / ② 待判 —— 从 pre 里取
def grab(title_kw):
    for t,b in her_secs:      # 用【已剥掉工程子块】的版本,不是原始 secs
        if title_kw in t: return t,b
    return None,None

w('<div class="card ask"><details><summary>① 成色 / 证据 —— <b>这是【状态】不是【问题】,不用你判</b></summary><div class="dbody">'
  '<p class="tip">每条结论背后的证据有多硬。<b>放在这里而不是上面,是因为它不是在等你拍板</b> —— '
  '⛔ 以前把它和「等你裁的」混在同一个清单里,所以看起来像有一堆问题在等你,那是我们排版排错了。<br>'
  '原本六条,其中<b>两条是工程的事,已撤到页底附录</b>。剩下这四条你想看就看。</p>')
t,b=grab('六条成色')
if b: w(md(b))
w(box('grade','成色这块有要改的吗?(可以不填)'))
w('</div></details></div>\n')

w('<div class="card req"><h2>③ 需求全清单(R-1 ~ R-58)</h2>'
  '<p class="tip"><b>来源</b>:👤 你定的 · 🔧 我们提的 &nbsp;|&nbsp; '
  '<b>成色</b>:✅ 已验 · ⚠️ 成色不足 · 🔄 未决 · ⛔ 已撤<br>'
  '⚠️ 两个标都<b>从 PRD 原文派生</b>,<b>不是我另外判的</b>:来源看条款那几行的字面;'
  '成色来自 <b>⓪ 那一块点名的条款</b> + 条款自带的字面。<br>'
  '🔑 <b>没有成色标 ≠ 已验</b> —— 是<b>原文没给它成色</b>。'
  '整份 PRD 的成色主要写在 <b>⓪</b> 和文首六条里,不是逐条写的。</p><ul class="rl">')
# ⓪ 那一块点名的条款 —— 显式交叉引用,不是猜
XREF={35:('undec','状态未决,见 ⓪'),2:('weak','一次通过不是通过率(n=1),见 ⓪'),
      1:('weak','依赖的场景她选择不测,见 ⓪'),55:('weak','只验过一次,见 ⓪'),
      40:('undec','能力成立,但机制二选一未定,见 ⓪')}
for _k,_v in XREF.items():
    if _k in rgrade: rgrade[_k]=(rgrade[_k][0], _v[0]); rmap[_k]=rmap[_k]
GT={'ok':('✅','已验','g-ok'),'weak':('⚠️','成色不足','g-weak'),'undec':('🔄','未决','g-undec'),'none':('','','')}
SR={'her':('👤','她定的'),'us':('🔧','我们提的')}
_c={'her':0,'us':0,'ok':0,'weak':0,'undec':0}
for n in range(1, max(rmap)+1):
    if n in ENG_R: continue
    if n in rmap:
        src,g=rgrade[n]; se,sl=SR[src]; ge,gl,cls=GT[g]
        _c[src]+=1
        if g!='none': _c[g]+=1
        w(f'<li class="{cls}"><span class="rn">R-{n}</span><span class="rt">{inl(rmap[n])}</span>'
          f'<span class="gr"><span title="{sl}">{se}</span>'
          + (f'<span class="{cls}" title="{gl}">{ge}</span>' if ge else '') + '</span></li>')
    elif n in retracted:
        w(f'<li class="gone"><span class="rn"><del>R-{n}</del></span><span class="rt">{retracted[n]}</span>'
          f'<span class="gr"><span title="已撤销">⛔</span></span></li>')
w('</ul>')
w('<p class="tip">正文 '+str(len(rmap)-len([x for x in ENG_R if x in rmap]))+' 条 · 👤 你定的 '+str(_c['her'])+' · 🔧 我们提的 '+str(_c['us'])+' · 其中 🔄 未决 '+str(_c['undec'])+' · ⚠️ 成色不足 '+str(_c['weak'])+' · ✅ 已验 '+str(_c['ok'])+' · ⛔ 已撤 1<br>'
  '🔧 另有 '+str(len([x for x in ENG_R if x in rmap]))+' 条是<b>纯工程条款</b>(取值来源 / 音频节拍 / 内部机制),已撤到工程附录 —— <b>不用你判</b>。</p>')
w(box('req','哪几条要改?'))
w('</div>\n')

w('<div class="card all"><h2>④ 正文(你能判的部分,点开展开)</h2>'
  '<p class="tip">共 '+str(len([x for x in her_secs if '六条成色' not in x[0]]))+' 节 · 默认折起 · '
  '<b>工程细节的 '+str(len(eng_secs))+' 节已撤到最后那张附录</b></p>')
for i,(t,b) in enumerate([x for x in her_secs if '六条成色' not in x[0]]):
    w(f'<details><summary>{inl(t)}</summary><div class="dbody">{md(b)}')
    w(box(f's{i}','对这一节的意见'))
    w('</div></details>\n')
w('</div>\n')

# ⑤ 工程附录 —— ⛔ 不用她读,交 Tadashi;没有意见框
w('<div class="card all"><h2>⛔ 工程附录 —— 不用你读</h2>'
  '<p class="tip">按你 2026-08-24 那条规矩,<b>怎么实现 / 什么协议 / 什么阈值 / 内部机制</b>全部从正文撤到这里,'
  '<b>交 Tadashi</b>。一个字没删,只是挪了位置。<b>这一块里没有意见框 —— 这里没有要你判的东西。</b></p>')
w('<div class="card hot" style="margin:10px 0"><h2>🔴 一处要说清楚的:「没有声音要送静音」那一格</h2>'
  '<p>你先说了「好吧,就不需要送吧」,紧接着说<b>你不懂这是干嘛、给谁送</b>。</p>'
  '<p>⛔ <b>那一句我们不作数,没有当成决定入库。</b> 你是被问了一个不该由你裁的东西 —— '
  '记成「她定了不送」是<b>伪造决定</b>。这一格整个交 Tadashi。</p></div>')
w('<details><summary>🔧 撤到附录的工程条款('+str(len([x for x in ENG_R if x in rmap]))+' 条)</summary><div class="dbody"><ul class="rl">')
for n in sorted(ENG_R):
    if n in rmap:
        w(f'<li><span class="rn">R-{n}</span><span class="rt">{inl(rmap[n])}</span><span class="gr">🔧</span></li>')
w('</ul></div></details>\n')
for i,(t,b) in enumerate(eng_secs):
    w(f'<details><summary>{inl(t)}</summary><div class="dbody">{md(b)}</div></details>\n')
if _dropped:
    for t,d in _dropped:
        w('<p class="tip">📎 「'+inl(t)+'」里明标「工程侧 / 不问她」的子块也撤走了:'+inl(' · '.join(d))+'</p>')
w('</div>\n')

w('<textarea id="dump" placeholder="复制失败时用这里"></textarea>\n')
w('</div>\n')
w('<div class="bar"><span id="st">意见自动保存</span>'
  '<button class="sec" id="clear">清空</button>'
  '<button id="copy">一键汇总复制</button></div>\n')
w('''<script nonce="__CSP_NONCE__">
(function(){
  var KEY='fly1851-final-review-v1';
  var MARK='【页面意见汇总】FLY-1851';
  var LIM=1800;
  var boxes=[].slice.call(document.querySelectorAll('textarea[data-k]'));
  var st=document.getElementById('st'), dump=document.getElementById('dump');
  function title(el){
    var d=el.closest('details'); if(d){var s=d.querySelector('summary'); if(s) return s.innerText.trim();}
    var c=el.closest('.card'); if(c){var h=c.querySelector('h2'); if(h) return h.innerText.trim();}
    return el.getAttribute('data-k');
  }
  function load(){try{var r=localStorage.getItem(KEY);if(!r)return;var d=JSON.parse(r);
    boxes.forEach(function(b){if(d[b.dataset.k])b.value=d[b.dataset.k];});}catch(e){}}
  function save(){try{var d={};boxes.forEach(function(b){if(b.value.trim())d[b.dataset.k]=b.value;});
    localStorage.setItem(KEY,JSON.stringify(d));}catch(e){}}
  function items(){var a=[];boxes.forEach(function(b){var v=b.value.trim();if(v)a.push('■ '+title(b)+'\\n'+v);});return a;}
  function chunks(){
    var a=items(); if(!a.length) return null;
    var out=[],cur=MARK;
    a.forEach(function(s){
      var add='\\n\\n'+s;
      if(cur.length+add.length>LIM && cur!==MARK){out.push(cur);cur=MARK+add;}
      else cur+=add;
    });
    out.push(cur); return out;
  }
  function flag(m,c){st.textContent=m;st.className=c||'';}
  boxes.forEach(function(b){b.addEventListener('input',save);});
  load();
  var parts=null, at=0;
  function fallback(text,why){
    dump.style.display='block'; dump.value=text;
    try{dump.focus();dump.select();}catch(e){}
    flag('❌ '+why+' —— 请手动全选上面那个框复制','bad');
  }
  document.getElementById('copy').addEventListener('click',function(){
    if(!parts||at>=parts.length){parts=chunks();at=0;}
    if(!parts){flag('还没有写任何意见','bad');return;}
    var text=parts[at];
    var many=parts.length>1;
    flag('复制中…','');
    if(!navigator.clipboard||!navigator.clipboard.writeText){
      fallback(text,'这个浏览器没有复制接口'); at++; return;
    }
    navigator.clipboard.writeText(text).then(function(){
      at++;
      if(many&&at<parts.length){flag('✅ 已复制第 '+at+'/'+parts.length+' 块 —— 粘贴后再点一次拿下一块','good');}
      else if(many){flag('✅ 全部 '+parts.length+' 块已复制完 —— 请确认都粘回去了','good');parts=null;at=0;}
      else{flag('✅ 已复制 —— 请贴回 issue thread','good');parts=null;at=0;}
    }).catch(function(){ fallback(text,'复制被拒绝'); at++; });
  });
  document.getElementById('clear').addEventListener('click',function(){
    boxes.forEach(function(b){b.value='';});
    try{localStorage.removeItem(KEY);}catch(e){}
    dump.style.display='none'; parts=null; at=0; flag('已清空','');
  });
})();
</script>
</body>
</html>
''')
open(OUT,'w',encoding='utf-8').write(B.getvalue())
print('节数',len(secs),'| R 条款',len(rmap),'| 输出字节',len(B.getvalue()))
