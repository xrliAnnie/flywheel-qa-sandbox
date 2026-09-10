"""Build the self-contained founder design page for FLY-2446; no external resources."""
from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parent
ISSUE = 'FLY-2446'

def diagram(stem):
    svg = ROOT / 'diagrams' / (stem + '.svg')
    if svg.exists():
        return '<div class="diagram">' + svg.read_text() + '</div>'
    source = (ROOT / 'diagrams' / (stem + '.mmd')).read_text()
    return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong><p>本机渲染失败，标准参数重试后仍失败。图的源码已保留，尚未显示成图。</p></div><details><summary>查看 Mermaid 图源码</summary><pre>' + escape(source) + '</pre></details>'

def table(headers, rows):
    return '<div class="table-wrap"><table><thead><tr>' + ''.join('<th>' + escape(h) + '</th>' for h in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + escape(cell) + '</td>' for cell in row) + '</tr>' for row in rows) + '</tbody></table></div>'

def comment(key, title):
    return '<div class="comment"><label for="note-' + escape(key, quote=True) + '">对「' + escape(title) + '」的意见</label><textarea id="note-' + escape(key, quote=True) + '" data-comment="' + escape(key, quote=True) + '" data-title="' + escape(title, quote=True) + '" placeholder="哪里不对、哪里需要改，都可以写在这里。"></textarea><small class="save-status" aria-live="polite">意见只保存在当前浏览器。</small></div>'

sections = [
('summary', '一句话：语音变成一张公用的嘴和耳朵，脑子永远是你在跟谁开会的那个 Lead',
 '<p class="lead">今天 Raya 的语音是她仓库里私有的第二个 Codex 进程，说过的话文字那边不知道。这份设计把它换成 Flywheel 拥有的一个通用语音进程：它只负责把你说的话变成文字、把 Lead 的回复念出来；你的话走和打字完全一样的路进 Lead，Lead 的回复走 Bridge 回来。</p>'
 '<p><b>这是实施前设计，代码还没写。</b>几个词先说清：<b>Lead</b> 是某个部门的负责人 AI（Tadashi、Honey Lemon、Raya 都是）；<b>mailbox</b> 是每个 Lead 落盘的持久信箱，打字消息今天就是先进这里再被投递给 Lead；<b>Bridge</b> 是团队共用的后台服务，负责保管信件、投递和授权发消息；<b>Codex realtime</b> 是 OpenAI Codex 里能直接收音频、出音频的实时会话。</p>'
 '<p>两种模式按你 09-08 07:46 定的：<b>会议模式</b>是通用能力，所有 Lead 默认都有；<b>随身（RG）模式</b>也做成通用能力，但默认关，先只给 Raya 开，以后想给谁开就在名册里加一行。</p>'),
('flow', '核心流程：你说一句话，它怎么到 Lead、又怎么回到你耳朵里',
 '<p>下图七步。要点是中间那段（③④）就是打字消息今天走的路，一个字没改；语音进程只在两头各加了一步：把转写写进 Lead 自己频道下的一条 thread（<b>thread</b> 是 Discord 里挂在某条消息下面的子对话），再把 Lead 在那条 thread 的回帖念出来。</p>'
 + diagram('d1-core-flow') +
 '<p>所以文字和语音天然互通：你在 thread 里打字，Lead 照常回，回复也会被念；别人打开 thread 就能看到整场对话的文字版。语音进程自己没有脑子：它跑的那个 Codex 实时会话被三道协议级开关锁住（不带工作区上下文、本地 Codex 的输出不自动进语音、后台线程只读且无网络），再加一份「你是某某的声音，不是脑子」的角色书。</p>'),
('journey', '一句话的完整旅程（含每一步留下的账）',
 '<p>下面是同一件事按时间顺序的展开。每一步都在某个地方记账：语音进程本机有一本流水账（journal），Bridge 有两张表，mailbox 有一行。这样进程崩了、网断了，都能知道话说到哪、有没有念出去。</p>'
 + diagram('d4-utterance-journey') +
 '<p>「nonce」是发 Discord 消息时附带的一次性编号：同一编号短时间内再发，Discord 会返回原来那条而不是再发一条，所以网络抖动不会让同一句话出现两次。「attempt token」是语音进程认领一条回帖时拿到的一次性凭证，用它回执「念完了 / 没念全」，重启后不会把已经念过的再念一遍。</p>'),
('modes', '会议模式 vs 随身模式：同一底座，只在四格不同',
 table(['', '会议模式（所有 Lead 默认开）', '随身 RG 模式（默认关，Raya 先开）'], [
   ('谁发起', 'Raya 排会到点自动起（她是唯一入口），运维也能用命令行对任一 Lead 起一场', '你对那个 Lead 说固定口令（进入语音模式）后由 Lead 发起'),
   ('念什么', 'Lead 在这场会的 thread 里的回帖', 'Lead 在 thread 和它自己频道里的所有发言，包括它主动的汇报'),
   ('「还在干活」怎么知道', '等待音 + thread 里的状态行（你可以看屏）', '只信耳朵：等待音 + 前台一个字的应答；状态行照写但不依赖'),
   ('会后留下什么', '转写证据进已有的会议记录流程（FLY-2033），零改动', '只留会话证据，不开 issue、不写纪要'),
 ]) +
 '<p>不属于模式差异、留在 Lead 自己那边的事：随身模式里「这个不用告诉我」的筛选记忆、动手前念单号人名、用嘴批 ship、会上立刻执行——这些是 Lead 的业务规则或已有的 Bridge 能力，语音进程不知道也不需要知道。</p>'),
('model', '数据与结构：哪些东西在哪、谁说了算',
 '<p>身份只有一份：团队中央名册（projects.json）。每个 Lead 那一行新增两个可选字段——两种模式的开关，和它在语音里用哪个音色（你定的：Honey Lemon 用 alloy、Tadashi 用 verse、主管用 marin）。语音房和进房的 bot 沿用现有 Huddle 那一块配置，不新建 Discord bot（Tadashi 09-08 裁定）。</p>'
 + diagram('d2-data-model') +
 '<p>「lease」是租约：语音进程认领一场会话时拿到一个带过期时间的凭证，必须定期续，续不上就自己停下；Bridge 只在过期再多等一段之后才把会话判失败并允许下一场。这样保证同一时间只有一个进程在房里说话。</p>'),
('states', '一场会话的生命周期',
 '<p>从你（或 Raya）发起到结束，会话只会沿这张图走。先在 Bridge 占好账、再去 Discord 建 thread，是为了两个人同时发起时只有一个成功、崩溃后能从账上恢复而不留孤儿 thread。</p>'
 + diagram('d3-session-states') +
 '<p>结束只有三种正常原因：你离开语音房、有人发停止命令、你口头说退出。异常（断线、租约丢失）会被明确记成「中断」，不会伪装成正常结束；会议记录流程能据此判断转写可不可信。</p>'),
('choices', '关键取舍与放弃的方案',
 table(['选择', '放弃了什么，为什么'], [
   ('独立语音进程 + 经 mailbox 互通（你 07:46 定的）', '放弃「一个脑子两个输入」：Claude Lead 根本没有实时语音能力；共享会话常开实时的成本和稳定性零数据。'),
   ('转写先发成 Discord 消息再入信箱', '放弃造假消息编号：信箱的去重、回复路由全建在 Discord 编号上，造假等于为语音另造一套机制。'),
   ('Lead 回复经 Bridge 轮询绑定频道', '放弃语音进程自己读 Discord：你明说要经 Bridge；「哪个作者算 Lead」只在 Bridge 维护一份。'),
   ('Codex 实时会话既当耳朵又当嘴', '放弃「只转写 + 另找嗓子念」：你定了载体是 Codex、耳朵嘴巴都归它；你试过系统合成音后不要。这条留作退路。'),
   ('复用现有 Huddle bot 进房', '放弃新建 bot：新建要你过验证码，多一个身份要管（Tadashi 裁定）。'),
   ('打断（你说话它停）第一版不做', '你定过「能做就做，难就算了」。实时 v2 是回合制，你插话会排队不会丢。留作后续。'),
   ('一个常驻进程按会话换身份', '放弃每个 Lead 一个语音进程：一间房同时只有一场。'),
 ])),
('boundary', '诚实边界：这份设计做什么、不做什么',
 '<ul>'
 '<li><b>还没实现。</b>本单只出设计；实现要等 ④（Raya 迁为标准 Lead）定下接口并合入。真人语音房验收在那之后。</li>'
 '<li><b>前台可能自己开口。</b>「只应一个字、不回答」是给实时模型的提示，不是硬开关；它自己说的话会在 thread 里标成 🤖 前台自言、不代表 Lead。协议级能保证的是：它没有工作区上下文、没有工具、本地 Codex 的输出不会自动进语音。</li>'
 '<li><b>不承诺速度数字。</b>回复要经过 Bridge 轮询、信箱成批投递、Lead 思考；按你的要求，靠等待音和状态行让你知道它在干活，不写任何秒数。</li>'
 '<li><b>打断第一版不做。</b>你说话时它不会停，但你的话会排队。</li>'
 '<li><b>断电只剩我们自己的转写。</b>Codex 实时会话不落持久历史。</li>'
 '<li><b>没送到会明说。</b>极端情况下（网络长时间未知）一句话可能丢，thread 里会出现「有一句可能没送到，请再说一遍」。</li>'
 '<li><b>不碰的东西：</b>打字消息的投递泵与适配器、Lead 的回复方式、Raya 仓（旧语音由 ④ 停掉）、旧的 Gemini 语音代码。</li>'
 '</ul>'),
('acceptance', '你怎么判断它真的成了',
 table(['验收', '要看到的证据'], [
   ('一个 Claude Lead 和一个 Codex Lead 各开一场会', '同一个语音程序、两条会话记录只差 Lead 名字；两份会议转写证据都能被现有会议记录流程读出内容。'),
   ('语音转写在信箱里查得到', '信箱里有来源标记为 voice 的行，编号指向 thread 里那条 🗣️ 镜像消息，状态是已被 Lead 收下。'),
   ('回复经 Bridge 念出来', 'Bridge 账本里有那条回帖、作者是该 Lead 的 bot、回执是已念；语音房录音在那个时段有声音（按波形判，不按事件日志）。'),
   ('随身模式只给 Raya', 'Raya 那行开着就能起；别的 Lead 不配就被拒绝；临时配上就能起。'),
 ]) +
 '<p>工程设计评审（Codex）四轮通过：阻塞项 8 → 4 → 2 → 0，最后一轮只剩文字同步。本页意见框里的内容是修改反馈，不是批准。</p>'),
]

css = '''
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.65 -apple-system,system-ui,"PingFang SC",sans-serif}main{max-width:960px;margin:auto;padding:32px 20px 64px}h1{font-size:36px;line-height:1.15;letter-spacing:-1px;margin:8px 0 16px}h2{font-size:24px;line-height:1.3;margin:0 0 18px}p{margin:12px 0}ul{padding-left:22px}li{margin:8px 0}.eyebrow{color:#1a365d;font-weight:650;font-size:13px;letter-spacing:.08em}.meta{color:#86868b;font-size:14px}.badge{display:inline-block;background:#f2e9fb;color:#702399;border-radius:20px;padding:4px 12px;font-size:13px}section{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid #007aff;margin:24px 0;padding:28px}section:nth-of-type(3n){border-color:#af52de}.lead{font-size:23px;line-height:1.5}.comment{border-top:1px solid #e8e8ed;margin-top:24px;padding-top:18px}.comment label{display:block;font-weight:600;font-size:14px;color:#1a365d;margin-bottom:8px}textarea{display:block;width:100%;min-height:82px;resize:vertical;border:1px solid #d2d2d7;border-radius:8px;padding:12px;background:#fbfbfd;color:#1d1d1f;font:inherit}textarea:focus{outline:2px solid #007aff;outline-offset:2px}.save-status{display:block;color:#86868b;font-size:12px;margin-top:6px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:14px}th{background:#f5f5f7;color:#1a365d}th,td{padding:13px 14px;border-bottom:1px solid #eee;vertical-align:top}th:first-child,td:first-child{width:26%;min-width:130px}.pending{padding:26px;border:1px dashed #e6b56b;border-radius:10px;background:#fff9ef;color:#67440a}.pending strong{font:600 13px/1.6 ui-monospace,monospace}details{margin:12px 0}summary{cursor:pointer;font-size:14px;color:#1a365d}pre{overflow:auto;background:#f5f5f7;padding:14px;font-size:12px}code{font:13px ui-monospace,monospace;background:#f5f5f7;padding:2px 4px}.diagram{overflow:auto}.diagram svg{width:100%;height:auto;min-width:600px;max-width:100%}button{border:0;background:#007aff;color:#fff;border-radius:22px;padding:11px 18px;font:600 14px -apple-system,system-ui,sans-serif;cursor:pointer;margin:8px 8px 8px 0}button:disabled{opacity:.45;cursor:default}.chunk{border-top:1px solid #eee;padding-top:12px;margin-top:12px}.chunk textarea{font-size:13px;min-height:150px}.hint{font-size:13px;color:#86868b}#copy-status{min-height:24px;font-size:14px;color:#1a365d}@media(max-width:600px){main{padding:22px 12px 40px}h1{font-size:30px}h2{font-size:21px}section{padding:20px 16px}.lead{font-size:20px}th,td{padding:10px}th:first-child,td:first-child{min-width:100px}.diagram svg{min-width:560px}}
'''

script = r'''
(() => {
  'use strict';
  const marker = '【页面意见汇总】FLY-2446';
  const prefix = 'flywheel-design:' + location.pathname + ':FLY-2446:';
  const notes = Array.from(document.querySelectorAll('[data-comment]'));
  const chunksNode = document.getElementById('comment-chunks');
  const copyAll = document.getElementById('copy-all');
  const status = document.getElementById('copy-status');
  let chunks = [];
  async function copyText(value) {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      status.textContent = '已复制，可以贴回对话。';
      return;
    } catch (_) {
      const field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('aria-label', '复制备用文本');
      document.body.appendChild(field);
      field.focus(); field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_) {}
      if (copied) { field.remove(); status.textContent = '已通过备用方式复制。'; }
      else { status.textContent = '浏览器未允许复制；下方备用文本已选中，请手动复制。'; }
    }
  }
  function update() {
    chunks = [];
    let current = marker;
    for (const note of notes) {
      const value = note.value.trim();
      if (!value) continue;
      const title = '【' + note.dataset.title + '】';
      const chars = Array.from(value);
      const cap = 1700 - Array.from(marker + '\n\n' + title + '\n').length;
      for (let start = 0; start < chars.length; start += cap) {
        const segment = '\n\n' + title + '\n' + chars.slice(start, start + cap).join('');
        if (Array.from(current + segment).length > 1780 && current !== marker) { chunks.push(current); current = marker; }
        current += segment;
      }
    }
    if (current !== marker) chunks.push(current);
    chunksNode.replaceChildren();
    for (let index = 0; index < chunks.length; index += 1) {
      const container = document.createElement('div'); container.className = 'chunk';
      const title = document.createElement('p'); title.textContent = '第 ' + (index + 1) + ' / ' + chunks.length + ' 段';
      const output = document.createElement('textarea'); output.readOnly = true; output.value = chunks[index]; output.setAttribute('aria-label', '意见汇总第 ' + (index + 1) + ' 段');
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '复制这一段';
      const text = chunks[index]; button.addEventListener('click', () => { void copyText(text); });
      container.append(title, output, button); chunksNode.appendChild(container);
    }
    copyAll.disabled = chunks.length === 0;
    document.getElementById('comment-count').textContent = chunks.length ? '已汇总为 ' + chunks.length + ' 段；每段都带页面意见标记。' : '还没有意见。填写任意一框后，这里会实时汇总。';
  }
  for (const note of notes) {
    const save = note.parentElement.querySelector('.save-status');
    try { note.value = localStorage.getItem(prefix + note.dataset.comment) || ''; }
    catch (_) { save.textContent = '浏览器不允许保存；仍可写意见并复制。'; }
    note.addEventListener('input', () => {
      try { localStorage.setItem(prefix + note.dataset.comment, note.value); save.textContent = '已保存在当前浏览器。'; }
      catch (_) { save.textContent = '无法自动保存，请在离开前复制。'; }
      update();
    });
  }
  copyAll.addEventListener('click', () => { void copyText(chunks.join('\n\n')); });
  update();
})();
'''

html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2446 · 通用 voice 进程</title><style>' + css + '</style></head><body><main><header><div class="eyebrow">FLY-2446 · 工程设计 · Epic FLY-2441 ⑤</div><h1>一张公用的嘴和耳朵</h1><p class="meta">2026-09-08 · plan v4 · 基于 exploration.md / research.md / plan.md</p><span class="badge">设计稿 · 尚未实现</span></header>'
for key, title, body in sections:
    html += '<section id="' + escape(key, quote=True) + '"><h2>' + escape(title) + '</h2>' + body + comment(key, title) + '</section>'
html += '<section id="feedback"><h2>把意见带回对话</h2><p class="hint">长意见会自动拆成约 1800 字以内的段落。汇总标记只表示修改反馈，不是批准。</p>' + comment('feedback', '意见汇总方式') + '<p id="comment-count" aria-live="polite"></p><button type="button" id="copy-all">复制全部意见</button><p id="copy-status" role="status"></p><div id="comment-chunks"></div></section></main><script nonce="__CSP_NONCE__">' + script + '</script></body></html>'
(ROOT / 'founder-design.html').write_text(html)
print('wrote founder-design.html: ' + str(len(html.encode())) + ' bytes')
