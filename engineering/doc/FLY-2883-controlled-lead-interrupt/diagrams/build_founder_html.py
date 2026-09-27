import html, pathlib
D = pathlib.Path(__file__).resolve().parent.parent
svg = lambda n: (D/"diagrams"/f"{n}.svg").read_text()
E = html.escape
sections = []
def sec(sid, title, body, color="navy"):
    sections.append((sid, title, body, color))

sec("s1", "一句话", f"""
<p class="big">你说「打断他」时,Raya 走一个<b>受控接口</b>:先记一笔审计(记不进就什么都不发),把问题放进那位 Lead 的信箱并标「加急」,再按他是哪种 Lead 把这件事<b>插进他正在做的这一轮</b>——不让他停下手上的活;他回的话按这次打断的编号存好,Raya 按编号取回念给你。</p>
<p class="dim">「受控接口」= 只有 Bridge 认可的调用方能用、每一步都留记录的正规入口,而不是直接往他的终端里敲字。「Bridge」= 我们自己的后台中枢,所有 Lead 和机器人之间的消息都经过它。</p>
""")

sec("s2", "核心流程", f"""
<p>从你说「打断他」到你听到回复,一共这几步。菱形是判断点。</p>
<div class="diagram">{svg('d1-flow')}</div>
<ul>
<li><b>Codex Lead</b>(用 OpenAI Codex 跑的 Lead):用 Codex 自带的 <code>steer</code> 功能把信插进当前这一轮。<span class="dim">steer = 「在它正在进行的这一轮里追加一句话」,不会取消它手上的活。</span></li>
<li><b>Claude Lead</b>(用 Claude Code 跑的 Lead):它的信箱只在空闲时才会被读到,所以只能往它终端里打一句<b>固定的提示</b>:「有加急信件,请先运行 flywheel-comm lead-interrupt pending 看信并回复,然后继续手上的活」。<b>问题正文永远不进终端</b>,它自己去信箱取。</li>
<li>只有在「确定它在忙、没卡在确认对话框、输入框是空的」时才打这句提示;判不准就不打字,改走普通信箱——宁可晚一点,也不往你可能正在打字的地方乱敲。</li>
<li>「它在不在忙」不另做一套判断,直接用另一张并行单(FLY-2882,Lead 忙闲接口)已经在 14 个正式 Lead 上实测过的判断方法,两边永远一致。</li>
</ul>
""", "blue")

sec("s3", "数据怎么存", f"""
<p>一次打断 = 一行记录 + 一串审计 + 一封加急信。</p>
<div class="diagram">{svg('d2-data')}</div>
<p class="dim">「审计」= 只能追加、不能修改或删除的流水账:谁发起、引用你哪句话(消息号)、打断谁、问题的指纹(一串由正文算出的校验码,能证明内容没被改过,但看不出原文)、什么时候。正文本身只存在记录和那封信里。</p>
<h3>一次打断会经过的状态</h3>
<div class="diagram small">{svg('d3-state')}</div>
""", "purple")

sec("s4", "关键取舍与放弃的做法", """
<table class="tbl">
<tr><th>做法</th><th>结论</th><th>为什么</th></tr>
<tr><td>直接往 Lead 终端敲原话</td><td class="no">放弃</td><td>你已否决:没审计;Lead 会以为是你本人在终端说话(绕过权限核对);回复不一定回到 Raya。</td></tr>
<tr><td>只把信放进信箱</td><td class="no">放弃</td><td>Claude Lead 忙的时候读不到信箱,要等这一轮做完才看到,就不是「打断」了。</td></tr>
<tr><td>Bridge 直接连到 Codex 去 steer</td><td class="no">放弃</td><td>只有 Codex Lead 旁边那个配套进程知道它此刻在跑哪一轮;从外面插会和它抢,容易插错轮。</td></tr>
<tr><td>另建一套「谁能调用」的注册表</td><td class="no">放弃</td><td>现在只有语音 Raya 一个调用方,直接复用它已有的会话凭证(租约)就够;以后要加调用方,必须改代码并过评审。</td></tr>
<tr><td>Claude 侧打完提示后又把正文写进它的信箱</td><td class="no">放弃</td><td>它回完后,信箱里那份会在它空闲时再冒出来,可能让它把同一件事做两遍。所以打完提示就把信先扣住,它回了就直接销掉。</td></tr>
<tr><td><b>审计 → 加急信 → 按载体插一句 → 按编号回信</b></td><td class="ok">采用</td><td>每一步都有记录;正文只走信箱;两种 Lead 各用最稳的插入方式;回复能对上是哪一次打断。</td></tr>
</table>
""", "amber")

sec("s5", "诚实边界:做什么、不做什么", """
<div class="grid2">
<div><h3 class="ok">这一单做</h3><ul>
<li>Bridge 里的受控打断接口、审计、加急信。</li>
<li>Codex / Claude 两种 Lead 各自的插入方式。</li>
<li>Lead 看信、回信的命令;按编号取回复。</li>
<li>在隔离的 529 测试房里,两种 Lead 各打断一次验证。</li>
</ul></div>
<div><h3 class="no">这一单不做</h3><ul>
<li><b>不做「让他立刻停下」</b>(按 Esc / 取消当前这一轮)——你没要求。</li>
<li>不改「Lead 不许往 Runner 终端乱打字」那条规则,也不给 Runner 开这个口子。</li>
<li>Raya 那边的对话(1 分钟没回先看他忙什么、问你等还是打断、把回复念出来)是后续集成单;这一单只把接口做好。</li>
<li>不在正式环境的 Lead 身上做真实打断测试。</li>
</ul></div>
</div>
<h3>已知的不完美</h3>
<ul>
<li>Claude Lead「在不在忙」只能看终端画面判断(用 FLY-2882 的方法);判不准时会退回普通信箱,可能要等他这一轮做完才看到。</li>
<li><b>先后顺序:</b>这一单要等 FLY-2882(Lead 忙闲接口)合进去之后再动手写代码,因为要直接用它的判断。</li>
<li>极少数崩溃时刻,Codex Lead 可能收到同一封信两次;回信接口只认第一条回复,不会乱。</li>
<li>「引用你哪句话」的校验目前按现在的语音引擎做;新语音引擎合进来后由集成单调整。</li>
</ul>
""", "green")

css = """
:root{--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--dim:#86868b;--line:#e5e5ea;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de;--navy:#1a365d}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,system-ui,"PingFang SC","Hiragino Sans GB",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;line-height:1.3;margin:0 0 6px;color:var(--navy)}
h2{font-size:19px;margin:0 0 8px;color:var(--navy)}h3{font-size:15px;margin:14px 0 6px}
.sub,.dim{color:var(--dim);font-size:13px}.big{font-size:16.5px}
.card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px;margin:16px 0;border-left:4px solid var(--navy)}
.card.blue{border-left-color:var(--blue)}.card.purple{border-left-color:var(--purple)}.card.amber{border-left-color:var(--amber)}.card.green{border-left-color:var(--green)}.card.red{border-left-color:var(--red)}
.diagram{background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px;margin:10px 0;overflow-x:auto;-webkit-overflow-scrolling:touch}
.diagram svg{display:block;margin:0 auto;max-width:100%;height:auto}
.diagram.small svg{max-width:420px}
code{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:12.5px;background:#f0f0f2;padding:1px 4px;border-radius:4px}
.tbl{width:100%;border-collapse:collapse;font-size:14px}.tbl th,.tbl td{text-align:left;vertical-align:top;padding:8px 6px;border-top:1px solid var(--line)}.tbl th{font-size:12px;color:var(--dim);border-top:none}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:640px){.grid2{grid-template-columns:1fr}.tbl{font-size:13px}}
.ok{color:#1e7d32;font-weight:600}.no{color:#c4271d;font-weight:600}.tbl td.ok,.tbl td.no{white-space:nowrap}
ul{padding-left:20px;margin:6px 0}li{margin:4px 0}
.cmt{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
.cmt label{font-size:12.5px;color:var(--dim);display:block;margin-bottom:4px}
.cmt textarea{width:100%;min-height:64px;border:1px solid var(--line);border-radius:8px;padding:8px;font:14px/1.5 inherit;resize:vertical}
.saved{font-size:12px;color:var(--green);min-height:16px}
#summary pre{white-space:pre-wrap;word-break:break-word;background:#f7f7f9;border-radius:8px;padding:10px;font-size:13px;margin:8px 0}
button{background:var(--navy);color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;margin:4px 6px 4px 0}
.status{font-size:12.5px;color:var(--dim)}
"""
parts = []
for sid, title, body, color in sections:
    parts.append(f'''<div class="card {color}" data-section="{E(sid)}" data-title="{E(title)}">
<h2>{E(title)}</h2>
{body}
<div class="cmt"><label for="c-{sid}">💬 对「{E(title)}」的意见(自动保存在你这台设备的浏览器里)</label>
<textarea id="c-{sid}" data-key="{E(sid)}" placeholder="有想改的地方写在这里"></textarea><div class="saved" id="saved-{sid}"></div></div>
</div>''')

script = r"""
(function(){
  var PREFIX = 'fly2883-comments:' + location.pathname + ':';
  var MARK = '【页面意见汇总】FLY-2883';
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-key]'));
  function load(k){ try { return localStorage.getItem(PREFIX + k) || ''; } catch(e){ return ''; } }
  function save(k,v){ try { localStorage.setItem(PREFIX + k, v); return true; } catch(e){ return false; } }
  function titleOf(el){ var c = el.closest('[data-title]'); return c ? c.getAttribute('data-title') : ''; }
  function chunks(){
    var items = [];
    areas.forEach(function(a){ var v = a.value.trim(); if (v) items.push('【' + titleOf(a) + '】\n' + v); });
    if (!items.length) return [];
    var out = [], cur = MARK;
    var LIMIT = 1800, room = LIMIT - MARK.length - 2, pieces = [];
    items.forEach(function(it){ while (it.length > room){ pieces.push(it.slice(0, room)); it = it.slice(room); } pieces.push(it); });
    pieces.forEach(function(it){
      var next = cur + '\n\n' + it;
      if (next.length > LIMIT && cur !== MARK) { out.push(cur); cur = MARK + '\n\n' + it; }
      else { cur = next; }
    });
    out.push(cur);
    return out;
  }
  var box = document.getElementById('summary-body');
  var status = document.getElementById('copy-status');
  function render(){
    while (box.firstChild) box.removeChild(box.firstChild);
    var cs = chunks();
    if (!cs.length){ var p = document.createElement('p'); p.className='status'; p.textContent='还没有意见。在上面任意一段下面写,这里会自动汇总。'; box.appendChild(p); return; }
    cs.forEach(function(text, i){
      if (cs.length > 1){ var h = document.createElement('div'); h.className='status'; h.textContent='第 ' + (i+1) + ' / ' + cs.length + ' 段'; box.appendChild(h); }
      var pre = document.createElement('pre'); pre.textContent = text; box.appendChild(pre);
      var b = document.createElement('button'); b.type='button'; b.textContent = cs.length > 1 ? '复制第 ' + (i+1) + ' 段' : '复制这段'; 
      b.addEventListener('click', function(){ copy(text); }); box.appendChild(b);
    });
  }
  function fallbackCopy(text){
    var t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly',''); t.style.position='fixed'; t.style.opacity='0';
    document.body.appendChild(t); t.select(); var ok = false;
    try { ok = document.execCommand('copy'); } catch(e){ ok = false; }
    document.body.removeChild(t);
    status.textContent = ok ? '已复制' : '复制失败,请手动选中上面的文字复制';
  }
  function copy(text){
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ status.textContent='已复制'; }, function(){ fallbackCopy(text); });
    } else { fallbackCopy(text); }
  }
  areas.forEach(function(a){
    a.value = load(a.getAttribute('data-key'));
    a.addEventListener('input', function(){
      var ok = save(a.getAttribute('data-key'), a.value);
      var s = document.getElementById('saved-' + a.getAttribute('data-key'));
      if (s) s.textContent = ok ? '已自动保存' : '本机浏览器不允许保存,关页面前请先复制';
      render();
    });
  });
  document.getElementById('copy-all').addEventListener('click', function(){ var cs = chunks(); if (cs.length) copy(cs.join('\n\n')); else status.textContent='还没有意见'; });
  render();
})();
"""
page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>受控打断 Lead</title><style>{css}</style></head>
<body><div class="wrap">
<h1>受控打断 Lead:设计</h1>
<div class="sub">FLY-2883 · 2026-09-25 · 设计节点产出 · 出处:FLY-2881 第三版 S4 第 21–24 步 + 琥珀卡「打断别的 Lead」</div>
{''.join(parts)}
<div class="card" id="summary"><h2>意见汇总</h2>
<p class="dim">上面每段的意见会自动汇总到这里,复制后贴回 thread 即可。这是修改意见,不是通过信号。</p>
<div id="summary-body"></div>
<button type="button" id="copy-all">复制全部意见</button> <span class="status" id="copy-status"></span>
</div>
</div>
<script nonce="__CSP_NONCE__">{script}</script>
</body></html>
"""
(D/"founder-design.html").write_text(page)
print(len(page))
