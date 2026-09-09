"""Build the self-contained design review page; no external resources."""
from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parent

def diagram(stem):
    svg = ROOT / 'diagrams' / (stem + '.svg')
    if svg.exists():
        return '<div class="diagram">' + svg.read_text() + '</div>'
    source = (ROOT / 'diagrams' / (stem + '.mmd')).read_text()
    return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong><p>本机渲染器启动被系统拒绝，标准参数重试后仍失败。图的源码已保留，尚未显示成图。</p></div><details><summary>查看 Mermaid 图源码</summary><pre>' + escape(source) + '</pre></details>'

def table(headers, rows):
    return '<div class="table-wrap"><table><thead><tr>' + ''.join('<th>' + escape(h) + '</th>' for h in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + escape(cell) + '</td>' for cell in row) + '</tr>' for row in rows) + '</tbody></table></div>'

def comment(key, title):
    return '<div class="comment"><label for="note-' + escape(key, quote=True) + '">对「' + escape(title) + '」的意见</label><textarea id="note-' + escape(key, quote=True) + '" data-comment="' + escape(key, quote=True) + '" data-title="' + escape(title, quote=True) + '" placeholder="哪里不对、哪里需要改，都可以写在这里。"></textarea><small class="save-status" aria-live="polite">意见只保存在当前浏览器。</small></div>'

sections = [
('summary', '一句话：换成共同通路，保住 Raya 的工作', '<p class="lead">Flywheel 负责收信、唤起模型和发回回复；Raya 保留身份、统管判断、summary、日报与会议业务。</p><p><b>这是实施前设计，尚未迁移或上线。</b> 标准 Lead 是登记在团队中央名册、使用团队共同运行程序的负责人。CoS 指跨项目统管业务。</p>'),
('flow', '你发一句话，它怎样到达 Raya', '<p>mailbox 是落盘的持久信箱，已入库的信件不会因进程重启消失。Bridge 负责保管、投递和出站授权。收信器运行在标准 Lead 进程内；停机时新信先留在 Discord，重启后靠保存的收件位置补齐。Codex 适配器把已收好的信交给现有模型会话。</p>' + diagram('d1-core') + '<p>Raya 与 Mufasa 共用信箱结构、投递泵、适配器和出站规则。现有系统按项目保存数据库：Raya 与 Mufasa 的数据库文件不同；本次不做全局合库。</p>'),
('model', '哪些资料只保留一份', '<p>中央名册是身份唯一来源；Raya 的名字可以展示为 Raya，内部稳定编号始终为 <code>raya/raya</code>。部署回执记录实际运行版本，SHA 是能够精确指向某次代码提交的编号。</p>' + diagram('d2-model') + table(['资料','唯一位置与含义'],[
('身份与联系信息','中央名册。旧 14 人资料通过中央受锁更新命令逐字段迁入；写入冲突就停止，不再各自维护。'),
('Raya 的人格与业务','Raya 仓；身份提示只保留一份，会议、追问和日报保存自己的业务状态。'),
('未读 summaries','原 Raya 仓的未合并 PR；PR 是可审阅的一组文件变更，原编号与内容保留。'),
('已阅与长期记忆','Raya 读懂后合并纯 summary PR，并在独立 memory 仓保存来源。'),
('收信与模型会话','由 Flywheel 保存；旧 thread 编号不会冒充新会话。'),
('实际上线版本','独立班车写部署回执，同时绑定 Flywheel 与 Raya 两个版本。')
])),
('inventory', '删什么，留什么', '<p>逐文件清单覆盖当前 <b>274 个已跟踪文件</b>，另列文字、日报和统管判断三个未合入分支。旧审计文档仍保留，因此全仓搜索历史词语可能有结果；活动程序、依赖和发布物必须没有旧驱动。</p>' + table(['删除的自建部分','保留或提取的业务'],[
('Discord 收信、私发回复','通过标准信箱收信，通过 Bridge 发回复与业务通知。'),
('brain daemon、自建服务安装器','Raya 身份与业务；标准可见 Lead 由 Flywheel 管理。'),
('app-server、thread 与轮次驱动','现有 Codex 会话；不保留第二个私有脑。'),
('14 人 profile 与 voice-leads 名单','中央名册中的名字、别名、记忆路径、工作目录与权限边界。'),
('2379 旧壳上的文字通路','追问的请求编号、答复归属、超时和恢复逻辑。'),
('Raya 内独立语音运行栈','会议与业务状态保留；共享语音能力由⑤接回。')
]) + '<p>daemon 是后台常驻程序；app-server 和 thread 是旧模型驱动与会话管理接口。本次把这些交给 Flywheel，Raya 仓不再自己启动它们。</p>'),
('business', '保住收件、追问与会议', '<p><b>最低连续性证据：</b>迁移前的未读 PR 没丢，迁移窗口的新 summary 仍能收进来，迁移后至少一个真实吸收轮次到达 Raya，并在频道给出对账报告。</p><p>现有通用 Runner 问答不能直接给 Lead 用。Lead 已决定另开后续单补团队共用的问答接口。④保留追问和会议状态机，明确标记传输不可用；不伪造已投递回执。待追问的 summary 保持未读，并在本轮报告说明原因。</p><p>后续启用会议投递时，须有两种回执：频道里看见通知的消息编号，以及目标 Lead 信箱里真正收下邀请的投递编号。两者必须分开，不能用一条 Discord 消息冒充两种证明。</p><p>日报与统管判断在当前基线仍是未合入分支，⑥提取其业务时不能合回旧模型驱动。音频接入由⑤负责；未就绪时明确告知不可用，不假报会议语音已经启动。</p>'),
('migration', '迁移顺序与失败时的处理', diagram('d3-migration') + '<ol><li>准备并验证公共平台、独立工作区、业务包和身份。</li><li>保存业务状态、未读 PR、未决请求与最后确认的收信位置。</li><li>在获批切换窗口确认旧脑与旧语音都停止，先把确认过的收件位置写入新通路并读回核对；缺失、损坏或旧消息处理结果不明时停止切换。</li><li>验证收发身份、告警落点和服务名无冲突，再启动唯一标准 Raya。</li><li>用一条停机期间的已知消息证明历史确实补齐，再证明新文字和 summary 跑通，由独立班车写回执。</li></ol><p>失败时保留新到信件与业务记录。已有合格标准版本就回到该版本；首次迁移还没有这样的版本时，保持明确的待修复状态。重新启用旧脑需要单独授权，不自动绕回旧架构。</p>'),
('choices', '关键取舍与放弃的方案', table(['选择','理由 / 代价'],[
('使用现有 Lead 通路','单一收信与会话所有者；本单补通用主动发信；Lead 问答接口另开后续单。'),
('保留外部业务工作区','现有通用 Codex 不允许直接在 Flywheel 的状态目录内工作；部署须验证内容与版本一致。'),
('删除旧 voice 驱动','符合只保留人格与 CoS 的目标；完整音频恢复须等⑤共享能力。'),
('不继续给旧脑加转发','会继续拥有两套状态、名册、恢复和运行方式。'),
('不整目录抹掉业务','会议状态、追问回执和记忆都要提取并验证。'),
('不以合并代替上线','只有班车、活进程与真实消息证据共同证明部署完成。')
])),
('acceptance', '你如何判断它真的迁好了', table(['验收','要看到的证据'],[
('文字同路','同一条输入的信箱、模型轮次、出站去重记录和实际 Discord 回复。'),
('停机期间不丢信','启动前收件位置已写入并读回；一条停机窗口内的已知消息真正入库并获得回复，只验新消息不算。'),
('身份与告警','Bridge 与 Lead 使用登记的同一 bot；告警确实到达公共配置选中的频道。'),
('summary 没断','切换前后 PR 清单与真实吸收轮次；对账、记忆来源和可见报告。'),
('旧壳退役','全部活动源、测试入口、依赖和安装产物的删除清单与负向检查。'),
('业务存续','追问/会议状态机与编号保留；外部通道不可用时明确显示，不产生旧通路副作用。'),
('实际上线','新部署回执里两个版本、当前唯一进程、可见窗口、人格内容和消息证据相互一致。')
]) + '<p><b>本页还没有这些迁移验收结果。</b> 当前已完成代码与文件审计，工程设计已通过第三轮评审；本机图形渲染受限。①已合入，③在本次审计时 PR #1126 仍未合入。</p>'),
('boundary', '授权与诚实边界', '<p>设计节点只提交设计，不实现、不合并、不部署、不重启服务。Lead 已明确按发布、报告、无需等待反馈的节点合同推进；后到 founder 意见由当前工作节点增量修改。页面意见标记不替代工程评审。合入后也只有独立班车负责上线。</p><p>每个意见框会自动保存，刷新后可继续写。页面不上传意见；底部复制的标记只表示修改意见，绝不表示批准。跨设备不会自动同步这些草稿。</p>')
]

css = '''
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.65 -apple-system,system-ui,"PingFang SC",sans-serif}main{max-width:960px;margin:auto;padding:32px 20px 64px}h1{font-size:36px;line-height:1.15;letter-spacing:-1px;margin:8px 0 16px}h2{font-size:24px;line-height:1.3;margin:0 0 18px}p{margin:12px 0}.eyebrow{color:#1a365d;font-weight:650;font-size:13px;letter-spacing:.08em}.meta{color:#86868b;font-size:14px}.badge{display:inline-block;background:#f2e9fb;color:#702399;border-radius:20px;padding:4px 12px;font-size:13px}section{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);border-left:4px solid #007aff;margin:24px 0;padding:28px}section:nth-of-type(3n){border-color:#af52de}.lead{font-size:23px;line-height:1.5}.comment{border-top:1px solid #e8e8ed;margin-top:24px;padding-top:18px}.comment label{display:block;font-weight:600;font-size:14px;color:#1a365d;margin-bottom:8px}textarea{display:block;width:100%;min-height:82px;resize:vertical;border:1px solid #d2d2d7;border-radius:8px;padding:12px;background:#fbfbfd;color:#1d1d1f;font:inherit}textarea:focus{outline:2px solid #007aff;outline-offset:2px}.save-status{display:block;color:#86868b;font-size:12px;margin-top:6px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:14px}th{background:#f5f5f7;color:#1a365d}th,td{padding:13px 14px;border-bottom:1px solid #eee;vertical-align:top}th:first-child,td:first-child{width:30%;min-width:150px}.pending{padding:26px;border:1px dashed #e6b56b;border-radius:10px;background:#fff9ef;color:#67440a}.pending strong{font:600 13px/1.6 ui-monospace,monospace}details{margin:12px 0}summary{cursor:pointer;font-size:14px;color:#1a365d}pre{overflow:auto;background:#f5f5f7;padding:14px;font-size:12px}code{font:13px ui-monospace,monospace;background:#f5f5f7;padding:2px 4px}.diagram{overflow:auto}.diagram svg{width:100%;height:auto;min-width:650px}button{border:0;background:#007aff;color:#fff;border-radius:22px;padding:11px 18px;font:600 14px -apple-system,system-ui,sans-serif;cursor:pointer;margin:8px 8px 8px 0}button:disabled{opacity:.45;cursor:default}.chunk{border-top:1px solid #eee;padding-top:12px;margin-top:12px}.chunk textarea{font-size:13px;min-height:150px}.hint{font-size:13px;color:#86868b}#copy-status{min-height:24px;font-size:14px;color:#1a365d}@media(max-width:600px){main{padding:22px 12px 40px}h1{font-size:30px}h2{font-size:21px}section{padding:20px 16px}.lead{font-size:20px}th,td{padding:10px}th:first-child,td:first-child{min-width:112px}.diagram svg{min-width:560px}}
'''

script = r'''
(() => {
  'use strict';
  const marker = '【页面意见汇总】FLY-2445';
  const prefix = 'flywheel-design:' + location.pathname + ':FLY-2445:';
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
# JS is static source. Convert intentional JS newline literals once, never splice data.
script = script.replace('\\\\n', '\\n')

html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2445 · Raya 迁为标准 Lead</title><style>' + css + '</style></head><body><main><header><div class="eyebrow">FLY-2445 · 工程设计</div><h1>Raya，接入共同通路</h1><p class="meta">2026-09-08 · v3 · 基于 research.md 与 plan.md</p><span class="badge">工程设计已通过 · 尚未迁移</span></header>'
for key, title, body in sections:
    html += '<section id="' + escape(key, quote=True) + '"><h2>' + escape(title) + '</h2>' + body + comment(key, title) + '</section>'
html += '<section id="feedback"><h2>把意见带回对话</h2><p class="hint">长意见会自动拆成约 1800 字以内的段落。汇总标记只表示修改反馈，不是批准。</p>' + comment('feedback', '意见汇总方式') + '<p id="comment-count" aria-live="polite"></p><button type="button" id="copy-all">复制全部意见</button><p id="copy-status" role="status"></p><div id="comment-chunks"></div></section></main><script nonce="__CSP_NONCE__">' + script + '</script></body></html>'
(ROOT / 'founder-design.html').write_text(html)
print('wrote founder-design.html: ' + str(len(html.encode())) + ' bytes')
