from pathlib import Path
from html import escape
import argparse

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--approved', action='store_true')
args = parser.parse_args()
e = escape

def para(text, lead=False):
    return '<p' + (' class="lead"' if lead else '') + '>' + e(text) + '</p>'

def table(rows):
    return '<div class="table-wrap"><table><thead><tr><th>对象</th><th>安排与完成证据</th></tr></thead><tbody>' + ''.join('<tr><th scope="row">'+e(a)+'</th><td>'+e(b)+'</td></tr>' for a,b in rows) + '</tbody></table></div>'

def comment(key, title):
    return '<div class="comment"><label for="note-'+e(key)+'">对「'+e(title)+'」的意见</label><textarea id="note-'+e(key)+'" data-comment="'+e(key)+'" data-title="'+e(title)+'" placeholder="写下疑问、不同意见或需要改的地方。"></textarea><small class="save-status" aria-live="polite">只保存在当前浏览器。</small></div>'

def section(key, title, content):
    return '<section id="'+e(key)+'"><h2>'+e(title)+'</h2>'+content+comment(key,title)+'</section>'

def diagram(name):
    svg=root/(name+'.svg')
    if svg.exists():
        return '<div class="diagram">'+svg.read_text()+'</div>'
    return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong>'+para('本次执行环境的图形渲染被权限拒绝，标准参数重试后仍失败。下方保留 Mermaid 图源码；尚未完成图形展示。')+'</div><details><summary>查看图的原始定义</summary><pre>'+e((root/(name+'.mmd')).read_text())+'</pre></details>'

sections=[]
sections.append(section('outcome','Raya 的工作，接回同一个 Lead',para('在标准 Raya 对话里理解各项目、主动追问、收 summaries、写日报和安排会议；业务规则与记录都留在 Raya 仓。',True)+para('标准 Lead 是团队统一登记、收发消息和运行的负责人。summary 是各 Lead 写下的项目事实与判断。此次交付是实施前设计；尚未证明这些业务已在生产可用。')))
sections.append(section('flow','一次理解，怎样变成可见的行动',diagram('flow')+para('你与 Raya 说话、其他 Lead 的回复、定时收件都会进入现有对话通路。Raya 的业务命令准备材料和记录结果，真正的收发、合并检查与语音由团队已有工具完成。')+para('实施会补齐主动发信后接收回复的通路，让 Raya 能直接找对应 Lead 问清楚，不必等你在场。没问清楚就保留未知，不为了清空收件箱而合并。')))
sections.append(section('read','什么才算「已阅」',table([('未读 summary','Lead 把事实与判断写进 Raya 仓的 PR；PR 是可以审阅并合并的一组文件变更。未合并就保持未读。'),('理解后的合并','Raya 先说明她理解了什么，再核对同一版本并合并。只有实际合并才算已阅，格式齐全不能替代理解。'),('需要追问','同一份 summary 的问题聚合后，在 Leads 圆桌找对应负责人。对方回复有出处，旧回复不能结清新问题。'),('每轮对账','列出阅读、吸收和追问结果，也保留未交、未送达或未知。空轮给收件事实，不编造观点。')])) )
sections.append(section('judgment','从对话形成目标，也敢指出分歧',para('Raya 会从普通对话里提炼目标，保留你交代执行的事和阶段性记忆。你的明确承诺与 Raya 的推断分别标注，不要求你填表。')+para('她读各仓的真实进展，指出「实际在推的」与「你说要紧的」哪里对不上。观察必须具体到你能当场否掉；你纠正后，下一轮能使用新理解。')+para('Raya 可以采取方向级协调动作。若动作与你表达过的重点不同，她要把动作和理由一起亮出来。这是披露，不是逐项请示；工程合入和部署仍走团队现行权限通路。')))
sections.append(section('report','每晚一份，可以接着讨论的日报',para('默认按你的时区在晚上 20:00 到期。日期、时刻和运行期调整沿共同唤醒能力处理；忙碌或停机会如实显示延迟。',True)+table([('保留原来的产品形态','日报是 Raya 仓里的 reports/YYYY-MM-DD.md；在 #raya 发标题、正文分片、仓链接和讨论邀请。'),('内容可核','列出当天各项目事实与 Raya 的判断，附来源 summary；还未吸收的材料清楚标出。'),('意见进入下轮','实施会补齐聊天引用传递：你回复任意一片，Raya 按被回复消息的编号找到对应日报，下一轮能引用你的意见。'),('重启后续做','日期、正文摘要和每片消息回执都保存。已经确认发出的片段不再发；结果不明时先对账。'),('真正验收','连续两个当地自然日各有一份日报，并有一次真实回复被下一轮引用。缩短时钟的测试不能替代这两天。')])) )
sections.append(section('model','资料只保留一份，结果有出处',diagram('model')+table([('中央名册','项目与 Lead 的固定编号是身份来源；显示名变了也不会问错人。读不到资料时标未知。'),('业务记忆','原目标、问题、会议和 长期记忆历史继续保留。不会用新框架覆盖旧记录。'),('执行回执','回执是工具记录的实际结果：发信、合并、语音状态分别核对。消息送达不代表事情已完成。')])) )
sections.append(section('meeting','会议接入团队共用语音',para('会议继续用原来的唯一编号、日历和业务记录。Raya 从标准对话安排会议，再交给⑤的通用语音能力。')+para('「请求已接受」只代表进入启动过程。只有实际会话进入运行状态，才说已经开会；结束与转写也要有真实记录。')+para('Flywheel 已合入的通用语音是基线；Raya 侧尚未合入的接线不算已批准或已上线。实现必须完成这段连接并通过真实对话与转写验收。')))
sections.append(section('choices','保留什么，拒绝什么',table([('保留','④已提取的业务模块、2380日报形态、2381的目标与读取能力、summary原合同和已有业务编号。'),('拒绝旧壳','不合回私有模型进程、Discord取信器、单独名册或旧的独立后台计时器。'),('拒绝只改提示','补齐业务入口、结构化回执和恢复流程；占位「不可用」不能作⑥完成。'),('平台的改动','通用目录查询、发信结果、主动圆桌收发接线、聊天回复引用和每日唤醒；Raya 的判断与业务状态仍在 Raya 仓。'),('边界','不做全项目排序表、细排每项任务、独立跨项目依赖引擎或语音控制电脑。')])) )
sections.append(section('proof','何时才能说真正可用',para('本设计要经过工程评审，再由后续实现、QA 和部署各自完成交付。QA 指独立验证实际行为。',True)+para('最终需要：标准 Raya 正在运行；summary 真收件与已阅；主动追问得到真实回复；目标和偏离能被纠正；连续两日报及反馈；会议真实运行与转写。')+para('合入不等于上线。还要由原有自动更新流程部署，并核对 Raya 与 Flywheel 两仓版本、当前 Lead 身份，以及同一次运行的文字、summary 和告警证据。此次设计没有执行这些生产动作。')))
summary = '<p>汇总会随输入更新。复制后发回当前讨论即可；这些意见不是通过或发布授权。</p><div id="comment-chunks"></div><button id="copy-all" type="button">复制全部意见</button><p id="copy-status" aria-live="polite"></p>'
sections.append(section('comments','意见汇总与整体意见',summary))

css='''*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:40px 22px 72px}header{padding:8px 4px 12px}h1{font-size:42px;line-height:1.15;letter-spacing:-1px;margin:10px 0 18px}h2{font-size:25px;line-height:1.35;margin:0 0 18px}p{margin:12px 0}.eyebrow{color:#426080;font-size:13px;letter-spacing:.12em;font-weight:650}.meta{color:#6e6e73;font-size:14px}.badge{display:inline-block;background:#eaf2ff;color:#255c9d;border-radius:20px;padding:5px 12px;font-size:13px}.lead{font-size:23px;line-height:1.55}section{background:#fff;border:1px solid #e7e7ed;border-radius:16px;padding:30px;margin:22px 0;box-shadow:0 2px 6px rgba(0,0,0,.025)}.comment{border-top:1px solid #ececf0;padding-top:18px;margin-top:25px}.comment label{display:block;font-size:14px;font-weight:600;margin-bottom:8px;color:#3d526b}textarea{width:100%;display:block;resize:vertical;min-height:86px;background:#fbfbfd;border:1px solid #d2d2d7;border-radius:9px;padding:12px;font:inherit;color:inherit}textarea:focus{outline:2px solid #007aff;outline-offset:2px}.save-status{display:block;color:#6e6e73;font-size:12px;margin-top:7px}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:15px;text-align:left}th,td{padding:14px 12px;border-bottom:1px solid #ebebef;vertical-align:top}thead th{background:#f5f5f7;color:#3d526b}tbody th{width:23%;min-width:125px;font-weight:600}.pending{border:1px dashed #d8b489;background:#fffaf3;border-radius:10px;padding:22px;color:#785324}.pending strong{font:600 13px/1.6 ui-monospace,monospace}.pending p{font-size:15px}.diagram{overflow:auto}.diagram svg{width:100%;height:auto}details{margin:14px 0}summary{cursor:pointer;color:#426080;font-size:14px}pre{white-space:pre;overflow:auto;padding:16px;border-radius:8px;background:#f5f5f7;font-size:12px;line-height:1.6}button{background:#007aff;color:#fff;border:0;border-radius:22px;padding:11px 18px;font:600 14px/1.4 system-ui;cursor:pointer;margin:12px 8px 8px 0}button:disabled{opacity:.45;cursor:default}.chunk{border-top:1px solid #ececf0;padding-top:15px;margin-top:15px}.chunk textarea{min-height:150px;font-size:14px}.chunk label{display:block;color:#426080;margin-bottom:8px;font-size:14px}#copy-status{min-height:24px;color:#426080;font-size:14px}a{color:#0067c5}footer{font-size:13px;color:#6e6e73;padding:12px 4px}@media(max-width:600px){main{padding:22px 12px 40px}h1{font-size:32px}h2{font-size:22px}section{padding:22px 17px}.lead{font-size:20px}th,td{padding:12px 9px}tbody th{min-width:100px}table{font-size:14px}}'''
script=r'''(() => {
  'use strict';
  const marker = '【页面意见汇总】FLY-2447';
  const prefix = 'flywheel-comments:' + location.pathname + ':FLY-2447:';
  const notes = Array.from(document.querySelectorAll('[data-comment]'));
  const chunksRoot = document.getElementById('comment-chunks');
  const copyAll = document.getElementById('copy-all');
  const status = document.getElementById('copy-status');
  let chunks = [];
  function splitComments(items) {
    const limit = 1780;
    const result = [];
    let current = marker;
    for (const item of items) {
      let remaining = Array.from('[' + item.title + ']\n' + item.text);
      while (remaining.length) {
        const room = limit - current.length - 2;
        if (room <= 0) { result.push(current); current = marker; continue; }
        let count = 0, used = 0;
        while (count < remaining.length && used + remaining[count].length <= room) { used += remaining[count].length; count++; }
        if (count === 0) { result.push(current); current = marker; continue; }
        const part = remaining.splice(0, count).join('');
        current += '\n\n' + part;
        if (remaining.length) { result.push(current); current = marker; }
      }
    }
    if (current !== marker) result.push(current);
    return result;
  }
  async function copyText(text) {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const helper = document.createElement('textarea');
      helper.value = text; helper.setAttribute('aria-label', '复制意见临时内容');
      helper.style.position = 'fixed'; helper.style.left = '-9999px';
      document.body.appendChild(helper); helper.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } finally { helper.remove(); }
      if (!copied) throw new Error('copy failed');
    }
  }
  async function copyAndReport(text) {
    try { await copyText(text); status.textContent = '已复制。请粘贴回当前讨论。'; }
    catch (_) { status.textContent = '自动复制失败，请在汇总框中选择文字后手动复制。'; }
  }
  function refresh() {
    const items = notes.filter(n => n.value.trim()).map(n => ({title:n.dataset.title,text:n.value.trim()}));
    chunks = splitComments(items);
    chunksRoot.replaceChildren();
    copyAll.disabled = chunks.length === 0;
    if (!chunks.length) {
      const empty = document.createElement('p'); empty.textContent = '还没有意见。填写任意一节，下方就会自动汇总。'; chunksRoot.appendChild(empty);
    }
    chunks.forEach((text, index) => {
      const box = document.createElement('div'); box.className = 'chunk';
      const label = document.createElement('label'); label.htmlFor = 'chunk-' + index;
      label.textContent = '可单独复制 · 第 ' + (index + 1) + ' / ' + chunks.length + ' 段';
      const field = document.createElement('textarea'); field.id = 'chunk-' + index; field.readOnly = true; field.value = text;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '复制这一段';
      button.addEventListener('click', () => copyAndReport(text));
      box.append(label, field, button); chunksRoot.appendChild(box);
    });
  }
  notes.forEach(note => {
    const feedback = note.parentElement.querySelector('.save-status');
    try { note.value = localStorage.getItem(prefix + note.dataset.comment) || ''; }
    catch (_) { feedback.textContent = '浏览器存储不可用；本次仍可填写和复制，请离开前保存。'; }
    note.addEventListener('input', () => {
      try { localStorage.setItem(prefix + note.dataset.comment, note.value); feedback.textContent = '已自动保存到当前浏览器。'; }
      catch (_) { feedback.textContent = '未能保存；请离开前复制意见。'; }
      status.textContent = ''; refresh();
    });
  });
  copyAll.addEventListener('click', () => copyAndReport(chunks.join('\n\n')));
  refresh();
})();'''
state='工程设计已通过 · 尚未实施' if args.approved else '工程设计评审中 · 尚未实施'
html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2447 · Raya 统管业务</title><style>'+css+'</style></head><body><main><header><div class="eyebrow">FLY-2447 · ⑥ 工程设计</div><h1>让 Raya 的统管工作<br>在共同地基上跑通</h1><p class="meta">2026-09-14 · 基于 FLY-1846 产品需求文档、④团队统一负责人机制与⑤共用语音</p><span class="badge">'+e(state)+'</span></header>'+''.join(sections)+'<footer><a href="https://linear.app/geoforge3d/issue/FLY-2447">查看 FLY-2447</a> · 每节意见仅保存在当前浏览器；不自动发送。两张图均已在本机生成后嵌入页面，不依赖外部网站。</footer></main><script nonce="__CSP_NONCE__">'+script+'</script></body></html>'
(root/'founder-design.html').write_text(html)
print('founder-design.html',len(html.encode()),'bytes;',len(sections),'sections; rendered SVGs',sum((root/(n+'.svg')).exists() for n in ['flow','model']))
