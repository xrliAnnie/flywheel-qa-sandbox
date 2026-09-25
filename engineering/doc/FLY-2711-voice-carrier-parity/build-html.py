#!/usr/bin/env python3
"""Build the FLY-2711 founder design HTML from inline sections + locally rendered SVGs."""
import html
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent


def svg(name):
    p = HERE / name
    if not p.exists():
        return '<div class="pending">DIAGRAM PENDING LOCAL RENDER（源文件：%s）</div>' % html.escape(name.replace('.svg', '.mmd'))
    text = p.read_text(encoding='utf-8')
    text = re.sub(r'<\?xml[^>]*\?>', '', text)
    return '<div class="diagram">' + text + '</div>'


def esc(s):
    return html.escape(s, quote=True)


SECTIONS = [
    ('s1', '一句话', 'blue', """
<p class="lead">除了 Raya，别的 Lead 都进不了语音房。原因有两个：一个已经修好了；另一个的修复代码两周前就写好了，却一直没合进去，而且有三个毛病。本单把这三个毛病修好，在测试房里用真机验证，然后交给 Lead 走正常上线。</p>
<ul>
<li><b>Codex 载体的测试房</b>（原 FLY-2712，<code>/tmp</code> 和 <code>/private/tmp</code> 是同一个目录的两种写法，被当成了两个目录）：9 月 22 日 FLY-2655 已经修好，之后 Codex 测试房已经能进房。本单不写新代码，只把它列进回归检查。</li>
<li><b>Claude 载体</b>（Claude 载体 = 跑在 Claude Code 上的 Lead，生产里占绝大多数）：语音开门前要问 Lead 一句「你会不会把自己发的话当成 founder 的话？」。Codex Lead 会回答，Claude Lead 不会回答，所以门一直关着（503）。能回答这句话的代码在插件仓库的 PR #28 里，没人合。</li>
</ul>"""),
    ('s2', '核心流程：语音开门前怎么核实', 'green', """
<p>「探针」= Bridge 在开会话前，给 Lead 的插件发一个带一次性随机数和签名的小问题；插件必须用<b>真正处理消息的那个函数</b>现场回答，再签名送回。这样读到的是「此刻真的在跑的保护」，不是「源码里写了保护」。</p>
%s
<p class="note">主仓这一侧（Bridge 发问、验签）早就写好，本单不改它；缺的是插件那一侧的回答者。</p>""" % svg('d1-flow.svg')),
    ('s3', '最危险的毛病：网络闪断时会丢 founder 的消息', 'red', """
<p>PR #28 原样合进去，<b>所有 Claude Lead</b> 在每次网络闪断恢复时，都会把断线期间 founder 发来的消息悄悄扔掉——比「语音起不来」严重得多。</p>
<p>原因：Discord 恢复连接时，会先把错过的消息补发过来，最后才说「恢复完毕」。PR #28 在「恢复完毕」之前一直处于关门状态，于是补发的消息全被挡掉。我们在它钉住的 discord.js 14.25.1 源码里确认了这个顺序。</p>
%s
<p>修法：学 Codex 那边的做法。<b>收消息</b>只看「这条是不是我自己发的」——机器人身份第一次登录后就固定下来，断线也不会忘；<b>回答语音探针</b>才额外要求「此刻连着」。断线时语音门暂时关，但文字消息照收。</p>""" % svg('d2-resume.svg')),
    ('s4', '结构：改哪里、谁负责什么', 'purple', """
%s
<table>
<tr><th>毛病</th><th>后果</th><th>修法</th></tr>
<tr><td>① 断线期间丢消息</td><td>所有 Claude Lead 丢 founder 消息</td><td>收消息看固定身份；只有探针看连接状态；先写会失败的测试再修</td></tr>
<tr><td>② 残留的 socket 文件</td><td>插件异常退出后，这个 Lead 的语音永远 503，要人手删文件</td><td>用操作系统的「内核文件锁」（进程一死系统自动释放的锁）决定唯一主人；拿到锁的才清理残留、建新 socket；本机已实测 Bun 支持</td></tr>
<tr><td>③ 版本号没改</td><td>合了也装不上（更新器只认新版本号）</td><td>0.0.7 → 0.0.8</td></tr>
</table>
<p class="note">「socket」= 同一台机器上两个程序之间的私有对话口，这里是一个只有本机本用户能读写的文件。「黄金向量」= 两个仓库里都写死同一组输入和同一个签名结果，谁改了格式谁的测试就红。</p>""" % svg('d3-model.svg')),
    ('s5', '取舍与被否决的方案', 'amber', """
<ul>
<li><b>否决：给 Claude Lead 开一个「替代验证」旋钮</b>（比如看插件版本号就放行）。这只能证明「装了」，不能证明「在跑」；而且一个能把门打开的开关就是一个隐患。FLY-2598 的合同也明确禁止。</li>
<li><b>否决：原样合 PR #28</b>。会让所有 Claude Lead 丢消息（见上）。</li>
<li><b>否决：只靠「连一下试试，连不上就当是残留」来清理 socket</b>。Codex 第一轮评审指出两个进程同时清理时仍可能删掉对方刚建好的；改成内核锁后才彻底没有这个窗口。</li>
<li><b>保留</b>：线协议（问题和回答的格式）一个字节都不改；主仓生产代码零改动，所以生产 Codex（Raya）的行为不可能被影响。</li>
</ul>
<p>设计评审：Codex 3 轮（第 1 轮 4 个 HIGH 全部吸收 → 第 2 轮通过 → 第 3 轮确认），Lead 预先加了三条硬要求（不丢消息 / 残留自动回收 / 版本号），全部写进了验收。</p>"""),
    ('s6', '怎么验：测试房真机 + 上线', 'blue', """
<ol>
<li>在一个 Claude 载体测试房里，用隔离的配置装上还没合入的新插件（生产插件目录一个字节都不动，前后拍快照比对）。</li>
<li>开语音：不再 503，机器人进房，状态到 <code>live</code>。<b>需要你进一次测试语音房</b>——没有真人在房，语音进程会按「没人来」结束。</li>
<li>闪断演练：把插件暂停到 Discord 判它掉线，这时请你发一条带暗号的消息，再恢复；日志必须显示这条消息是在「恢复中」被补发进来的，并且 Lead 恰好收到一次。</li>
<li>残留演练：强杀插件，让 socket 文件残留，Lead 自动重生后必须自己清掉残留、重新能回答探针。</li>
<li>通过后由 Lead 合入插件 PR。<b>合入即上线</b>：插件仓库的 main 就是生产指针，下一次服务重启或任意 Claude Lead 自然重生都会更新到 0.0.8。</li>
</ol>"""),
    ('s7', '边界：做什么、不做什么', 'gray', """
<ul>
<li><b>做</b>：Claude Lead 能通过语音开门检查；网络闪断不丢消息；残留文件自动回收。</li>
<li><b>不做</b>：不改语音本身的听说质量、不改 Codex / Raya、不改会话流程、不新增任何开关；runner 不重启任何生产 Lead，不自己上线。</li>
<li><b>上线后的变化需要你知道</b>：生产里 14 个 Claude Lead 已经配了会议模式语音，插件上线后它们会第一次真的能开会议语音。</li>
<li><b>仍存在的旧限制</b>：如果 Discord 选择「重新登录」而不是「恢复连接」，断线期间的消息本来就不会补发——这是一直以来的行为，本单不改变也不恶化。</li>
<li>生产 Claude Lead 这次只做「只读开门检查」验证（不真的开会话）；真实会议语音的第一场由你决定何时开。</li>
</ul>"""),
]

CSS = """
:root{--bg:#f5f5f7;--fg:#1d1d1f;--dim:#86868b;--card:#fff;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de;--gray:#86868b;--navy:#1a365d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,system-ui,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:26px;margin:0 0 4px;color:var(--navy)}
.meta{color:var(--dim);font-size:13px;margin-bottom:22px}
.meta code,code{font-family:'SF Mono',monospace;font-size:13px;background:#f0f0f3;padding:1px 5px;border-radius:5px}
.card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:18px 20px;margin:0 0 18px;border-left:4px solid var(--blue)}
.card.red{border-left-color:var(--red)}.card.amber{border-left-color:var(--amber)}.card.green{border-left-color:var(--green)}.card.purple{border-left-color:var(--purple)}.card.gray{border-left-color:var(--gray)}.card.blue{border-left-color:var(--blue)}
.card h2{font-size:18px;margin:0 0 10px;color:var(--navy)}
.lead{font-size:16px}
.note{color:var(--dim);font-size:13px}
.diagram{overflow-x:auto;margin:10px 0;text-align:center}
.diagram svg{max-width:100%;height:auto}
.pending{padding:30px;border:2px dashed var(--amber);border-radius:10px;text-align:center;color:var(--amber);font-weight:600}
table{border-collapse:collapse;width:100%;font-size:14px;margin:10px 0}
th,td{border-bottom:1px solid #e5e5ea;padding:8px 6px;text-align:left;vertical-align:top}
th{color:var(--dim);font-weight:600}
textarea{width:100%;min-height:64px;margin-top:12px;border:1px solid #d2d2d7;border-radius:8px;padding:8px 10px;font:14px/1.5 -apple-system,system-ui,sans-serif;resize:vertical;background:#fafafa}
.clabel{font-size:12px;color:var(--dim);margin-top:10px}
button{background:var(--blue);color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;margin:6px 6px 0 0}
pre.sum{white-space:pre-wrap;background:#fafafa;border:1px solid #e5e5ea;border-radius:8px;padding:10px;font-size:13px;min-height:40px}
.status{font-size:12px;color:var(--green);margin-left:6px}
"""

SCRIPT = r"""
(function () {
  var MARK = '【页面意见汇总】FLY-2711';
  var LIMIT = 1800;
  var prefix = 'fly2711-comments:' + location.pathname + ':';
  function load(k) { try { return localStorage.getItem(prefix + k) || ''; } catch (e) { return ''; } }
  function save(k, v) { try { localStorage.setItem(prefix + k, v); } catch (e) { /* storage unavailable */ } }
  var boxes = Array.prototype.slice.call(document.querySelectorAll('textarea[data-section]'));
  function chunks() {
    var parts = [];
    boxes.forEach(function (b) {
      var v = b.value.trim();
      if (v) parts.push('【' + b.getAttribute('data-title') + '】\n' + v);
    });
    if (!parts.length) return [];
    var out = [], cur = MARK;
    parts.forEach(function (p) {
      if (cur.length + 2 + p.length > LIMIT && cur !== MARK) { out.push(cur); cur = MARK; }
      cur += '\n\n' + p;
    });
    out.push(cur);
    return out;
  }
  var holder = document.getElementById('sum-holder');
  function render() {
    while (holder.firstChild) holder.removeChild(holder.firstChild);
    var cs = chunks();
    if (!cs.length) {
      var empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = '还没有意见。';
      holder.appendChild(empty);
      return;
    }
    cs.forEach(function (c, i) {
      var pre = document.createElement('pre');
      pre.className = 'sum';
      pre.textContent = c;
      holder.appendChild(pre);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = cs.length > 1 ? ('复制第 ' + (i + 1) + ' 段') : '复制这段';
      btn.addEventListener('click', function () { copy(c, btn); });
      holder.appendChild(btn);
    });
  }
  function fallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function done(btn, ok) {
    var s = document.getElementById('copy-status');
    s.textContent = ok ? '已复制' : '复制失败，请手动选中文字';
  }
  function copy(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(btn, true); }, function () { done(btn, fallback(text)); });
    } else {
      done(btn, fallback(text));
    }
  }
  boxes.forEach(function (b) {
    b.value = load(b.getAttribute('data-section'));
    b.addEventListener('input', function () { save(b.getAttribute('data-section'), b.value); render(); });
  });
  document.getElementById('copy-all').addEventListener('click', function () {
    var cs = chunks();
    copy(cs.length ? cs.join('\n\n') : MARK + '\n\n（无意见）', this);
  });
  render();
})();
"""


def main():
    cards = []
    for sid, title, color, body in SECTIONS:
        cards.append(
            '<section class="card %s"><h2>%s</h2>%s'
            '<div class="clabel">对本节的意见（自动保存在本机浏览器）</div>'
            '<textarea data-section="%s" data-title="%s" placeholder="写下对「%s」的意见…"></textarea></section>'
            % (color, esc(title), body, esc(sid), esc(title), esc(title))
        )
    page = (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>FLY-2711 语音载体对齐</title><style>' + CSS + '</style></head><body><div class="wrap">'
        '<h1>FLY-2711 让 Claude Lead 也能进语音房</h1>'
        '<div class="meta">设计定稿 · 2026-09-24 · plan v2.1（Codex 3 轮通过）· 分支 <code>flywheel-FLY-2711</code> · 合并了原 FLY-2712</div>'
        + ''.join(cards)
        + '<section class="card green"><h2>意见汇总</h2>'
        '<p class="note">上面每节写的意见会自动汇总到这里。复制后发给 Lead 即可；这只是修改意见，不代表通过。</p>'
        '<div id="sum-holder"></div>'
        '<button type="button" id="copy-all">复制全部意见</button><span class="status" id="copy-status"></span>'
        '</section></div>'
        '<script nonce="__CSP_NONCE__">' + SCRIPT + '</script></body></html>'
    )
    (HERE / 'founder-design.html').write_text(page, encoding='utf-8')
    print('wrote', HERE / 'founder-design.html', len(page.encode('utf-8')), 'bytes')


if __name__ == '__main__':
    main()
