"""Build the FLY-2563 design report; no product or publish effects.
Comment controller and Apple-light style adapted from FLY-2399.
"""
from html import escape
from pathlib import Path
ROOT=Path(__file__).resolve().parent
def p(text):
    return '<p>'+escape(text)+'</p>'
def table(head, rows):
    return '<table><thead><tr>'+''.join('<th>'+escape(x)+'</th>' for x in head)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+escape(x)+'</td>' for x in row)+'</tr>' for row in rows)+'</tbody></table>'
def diagram(name):
    path=ROOT/(name+'.svg')
    if path.exists():
        return '<div class="diagram">'+path.read_text()+'</div>'
    return '<div class="pending" role="note"><strong>DIAGRAM PENDING LOCAL RENDER</strong>'+p('本地画图所需浏览器被系统权限阻止；标准参数重试仍失败。Mermaid 是图的文字源格式；源码已随设计保存，下方文字说明完整流程。')+'</div>'
def comment(key,title):
    return '<div class="comment"><label for="comment-'+escape(key)+'">这一节的意见<span data-saved="'+escape(key)+'" aria-live="polite"></span></label><textarea id="comment-'+escape(key)+'" data-comment="'+escape(key)+'" data-title="'+escape(title)+'" placeholder="自动保存到当前浏览器；复制给组长才会送出"></textarea></div>'
SCRIPT='\n(() => {\n  \'use strict\';\n  const marker = \'【页面意见汇总】FLY-2563\';\n  const prefix = \'flywheel:design-comments:\' + location.pathname + \':\';\n  const inputs = Array.from(document.querySelectorAll(\'textarea[data-comment]\'));\n  const chunksBox = document.getElementById(\'comment-chunks\');\n  const status = document.getElementById(\'copy-status\');\n  let chunks = [];\n  function splitText(text) {\n    const chars = Array.from(text);\n    const room = 1800 - Array.from(marker).length - 1;\n    if (!chars.length) return [marker + \'\\n（暂无意见）\'];\n    const result = [];\n    let part = \'\';\n    for (const char of chars) {\n      if (part.length + char.length > room) {\n        result.push(marker + \'\\n\' + part);\n        part = \'\';\n      }\n      part += char;\n    }\n    if (part) result.push(marker + \'\\n\' + part);\n    return result;\n  }\n  function fallbackCopy(text) {\n    const helper = document.createElement(\'textarea\');\n    helper.value = text;\n    helper.setAttribute(\'aria-label\', \'复制意见\');\n    helper.style.position = \'fixed\';\n    helper.style.left = \'-10000px\';\n    document.body.appendChild(helper);\n    helper.select();\n    let ok = false;\n    try { ok = document.execCommand(\'copy\'); } catch (_) { ok = false; }\n    helper.remove();\n    return ok;\n  }\n  async function copyText(text) {\n    let ok = false;\n    if (navigator.clipboard && typeof navigator.clipboard.writeText === \'function\') {\n      try { await navigator.clipboard.writeText(text); ok = true; }\n      catch (_) { ok = fallbackCopy(text); }\n    } else { ok = fallbackCopy(text); }\n    status.textContent = ok ? \'已复制\' : \'复制失败，请选中下方文字手动复制\';\n  }\n  function updateSummary() {\n    const entries = inputs.filter(input => input.value.trim()).map(input =>\n      input.dataset.title + \'\\n\' + input.value.trim());\n    chunks = splitText(entries.join(\'\\n\\n\'));\n    chunksBox.replaceChildren();\n    chunks.forEach((chunk, index) => {\n      const block = document.createElement(\'div\');\n      block.className = \'chunk\';\n      const text = document.createElement(\'pre\');\n      text.textContent = chunk;\n      const button = document.createElement(\'button\');\n      button.type = \'button\';\n      button.className = \'secondary\';\n      button.textContent = \'复制第 \' + (index + 1) + \' 段\';\n      button.addEventListener(\'click\', () => copyText(chunk));\n      block.appendChild(text);\n      block.appendChild(button);\n      chunksBox.appendChild(block);\n    });\n  }\n  inputs.forEach(input => {\n    const saved = document.querySelector(\'[data-saved="\' + input.dataset.comment + \'"]\');\n    try { input.value = localStorage.getItem(prefix + input.dataset.comment) || \'\'; }\n    catch (_) { if (saved) saved.textContent = \'无法读取本机保存\'; }\n    input.addEventListener(\'input\', () => {\n      try {\n        localStorage.setItem(prefix + input.dataset.comment, input.value);\n        if (saved) saved.textContent = \'已保存\';\n      } catch (_) { if (saved) saved.textContent = \'未保存；仍可复制\'; }\n      updateSummary();\n    });\n  });\n  document.getElementById(\'copy-all\').addEventListener(\'click\', () => copyText(chunks.join(\'\\n\\n\')));\n  updateSummary();\n})();\n'
CSS='\n:root{color-scheme:light;--ink:#1d1d1f;--muted:#6e6e73;--blue:#007aff}\n*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;line-height:1.75}\nmain{max-width:960px;margin:auto;padding:40px 22px 80px}header{padding:10px 6px 30px}h1{font-size:clamp(28px,5vw,42px);line-height:1.25;letter-spacing:-.04em;margin:8px 0 12px}h2{font-size:21px;letter-spacing:-.015em;margin:0 0 20px}.eyebrow{font-size:12px;letter-spacing:.15em;color:var(--blue);font-weight:650}.muted,.small{color:var(--muted);font-size:13px}.card{background:#fff;border:1px solid #e8e8ed;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:28px;margin-bottom:20px}.hero{font-size:24px;line-height:1.65;margin-top:0}p{margin:12px 0}.tag{display:inline-block;padding:5px 10px;background:#edf5ff;color:#145b9b;border-radius:6px;font-size:12px;margin:8px 8px 0 0}.diagram{overflow-x:auto}.diagram svg{display:block;max-width:100%;height:auto;margin:8px auto 24px}.pending{padding:20px;border:1px dashed #c58c33;border-radius:8px;background:#fffaf0;color:#725320;font-size:14px;margin:12px 0 22px}.pending strong{font-size:12px;letter-spacing:.06em}.pending p{margin:6px 0}dl{margin:18px 0}dt{font-weight:650;color:#15599c;margin-top:18px}dd{margin:5px 0 0}.sample{background:#f5f5f7;padding:18px;border-radius:8px}code{font:13px "SFMono-Regular",Consolas,monospace;background:#f5f5f7;padding:3px 6px;border-radius:4px}li{margin:7px 0}.comment{border-top:1px solid #ececf0;margin-top:24px;padding-top:18px}label{display:block;font-size:13px;color:var(--muted);margin-bottom:8px}label span{margin-left:12px;color:#237343}textarea{width:100%;min-height:76px;resize:vertical;border:1px solid #d2d2d7;border-radius:8px;padding:12px;font:inherit;font-size:14px;background:#fcfcfd}textarea:focus{outline:2px solid #7ab7ff;outline-offset:2px}button{background:var(--blue);color:#fff;border:0;border-radius:7px;padding:10px 16px;font:inherit;font-size:14px;cursor:pointer;margin:14px 12px 0 0}.secondary{background:#eaf3ff;color:#15599c}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 system-ui,sans-serif;background:#f5f5f7;padding:16px;border-radius:8px}.chunk{margin-top:18px}#copy-status{font-size:13px;color:var(--muted)}a{color:#0067d6;text-decoration:none}@media(max-width:600px){main{padding:22px 12px 50px}.card{padding:22px 18px;border-radius:12px}.hero{font-size:21px}h2{font-size:18px}}\n\ntable{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;padding:12px 8px;border-bottom:1px solid #eee}th{color:#6e6e73}pre{white-space:pre-wrap;overflow-wrap:anywhere}\n'
SECTIONS = [
 ('flow','01 / 让查账每次只做一小步',
  p('把每三秒重翻旧账改成按保存的位置处理一小页新证据，并在等网络前关闭数据库连接，让 Bridge 持续接待请求。')+diagram('d1-flow')+
  p('Bridge 是舰队处理请求的入口。事件循环是它接待请求的主线程；同步查账没结束，其他请求就只能排队。新的流程每次最多处理一小页，保存结果和进度，再把主线程让出来。')+
  p('网络发送另外排队，每次一轮并有超时；发送暂时失败，下一页本地查账仍能继续。关闭模式后停止观察与发送，重开时接着已保存的进度做。')),
 ('cause','02 / 两个问题，都需要修',
  table(['问题','这次查到的证据','计划修法'],[
   ('查账占住主线程','事故备份已加索引，旧取消查询仍约 350ms；它先扫描 536 张卡，再查历史事件。','先限定新事件候选页，再核对原始身份；不再每三秒翻历史。'),
   ('连接持续增长','代码中确认了两处数据库打开后未关闭，其中一处会按项目重复执行。','操作完成就关闭；异常和网络挂起也检验关闭情况。'),
   ('旧归档扫描风险','现有时间预算只能在语句之间检查，不能打断一条慢查询。','先取有限候选，再检查是否能归档，保存已检查位置。')])+
  p('索引是数据库的检索目录，能减少查找范围；仅补索引仍未达到这次要求的 50ms。fd 是进程持有文件和网络连接的系统名额；要修掉未关闭的连接，也要读出系统真正允许使用的上限。')+
  p('本次评审纠正了一点：启动配置中的 256，不能直接当成 Bridge 实际上限。事故是否真的耗尽了名额还需要现场证据；健康页会同时核对程序限制和系统内核限制，使用两者中更小的有效值。')),
 ('model','03 / 记住读到哪，不改谁有权决定',
  diagram('d2-model')+
  table(['记录','保存什么','为什么需要'],[
   ('原始事件','原决定、原运行、原卡片和原时间。','继续按原始证据核对，不用后来那张卡替换。'),
   ('处理进度（水位）','每类事件已经检查到哪里。水位就是下次接着读的位置。','重启可以接着做，不从头翻账。'),
   ('确切待办','还剩哪件事件、哪张卡没处理完，以及原因。','晚到、未来时间和一件事件对应多张卡时，不漏记。'),
   ('已有观察结果','原事件与原卡片的唯一组合、归因和观察时间。','重复执行不会增记一次决定。')])+
  p('事务是数据库的一次整体提交：结果和处理进度要么一起保存，要么一起回退。即使中途重启，也不会出现“进度已经越过，结果却没有记下”的半成品。')+
  p('让卡片进入终态的那件事件仍处理一次；处理过的证据不反复扫描。没有对应工作流的普通取消事件，检查后直接继续，不留无限重试或告警。旧 holder 表继续保留，它保存的是审批卡的稳定身份，回放与复盘仍可读取。')),
 ('tradeoffs','04 / 选择与舍弃',
  table(['选择','收益','代价与边界'],[
   ('有界候选页 + 持久化进度','处理量随新事件前进；异常可接续。','要处理跨页、时间乱序和重放；这些都列入回归。'),
   ('及时关闭连接 + 核对有效上限','减少泄漏，并在真正接近上限时告警。','启动配置的提限只是尽力步骤；实际有效上限仍须取证，不能靠配置值宣布通过。'),
   ('只加索引 / 只提高上限：不采用','改动较少。','前者仍超出响应目标；后者不能阻止连接继续增长。'),
   ('把数据库整体迁到其他线程：暂不采用','隔离同步工作更彻底。','会改动大量事务和授权读取边界，超出这次修复。')])+
  p('本次不删除旧卡，不增加 holder 冷归档策略，不改 swap 噪声阈值。swap 是系统把内存内容写到磁盘的行为；它的阈值校准已明确暂缓。')),
 ('qa','05 / 怎样证明问题修好了',
  table(['检查','通过线','证据来源'],[
   ('取消观察','一次 < 50ms，且有实际待处理事件。','170 万条事件、500 张卡夹具与指定事故备份的隔离副本。'),
   ('每轮查账','本地一轮 < 100ms，无新事件时不再扫描旧卡。','真实计时、候选数量与持久化水位。'),
   ('连续响应','p99 指 99% 的请求快于该时长。启动后 15 分钟，p99 < 300ms，事件循环延迟 < 100ms。','同一进程的完整时间序列。'),
   ('连接名额','有效上限至少 8192；超过它的 80% 发日志和统一告警。','真实 Bridge 进程与内核的限制、取两者较小值、实际用量与样本时间。'),
   ('长期连接','持续 2 小时不单调增长，两次可比采样差不超过 6。','按真实数字 fd 统计数据库连接；稳态不超过项目数 × 6。'),
   ('归档','一次 < 200ms；连续 20 次确实推进；重启保留位置。','大数据副本和保留活动引用的回归测试。')])+
  p('健康页只读取后台已采样的数字，不能为了显示健康而再次阻塞请求。采样失败或过期会明确显示未知；不能把未知显示成零。')),
 ('boundary','06 / 当前交付到哪一步',
  p('本页说明的是技术设计。已完成源码审计和事故备份的只读旧查询测量；代码修复、迁移安装、持续运行验证与生产部署属于后续阶段。')+
  p('不会因为本页或机器意见而获得合并权限；审批模式和 founder 的决定权保持原合同。合并与部署分开，只有独立更新服务在授权窗口部署。')+
  p('本地 Mermaid 图两次渲染均遇到浏览器权限拒绝，当前保留明确待渲染标记与源码。页面结构和评论逻辑的检查不等于浏览器视觉验收。')),
]
cards=[]
for key,title,body in SECTIONS:
    cards.append('<section class="card" id="'+escape(key)+'"><h2>'+escape(title)+'</h2>'+body+comment(key,title)+'</section>')
cards.append('<section class="card" id="feedback"><h2>07 / 意见汇总</h2>'+p('每节留言实时汇总；长意见可分段复制。这里保存的是修改意见，不是通过信号。留言只存当前浏览器，不跨设备同步，也不会自动发送。')+comment('feedback','07 / 总体意见')+'<button type="button" id="copy-all">复制全部意见</button><span id="copy-status" role="status"></span><div id="comment-chunks"></div></section>')
html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2563 · 让 Bridge 持续接待请求</title><style>'+CSS+'</style></head><body><main><header><div class="eyebrow">FLY-2563 · 设计说明 · 2026-09-14 PT</div><h1>查账做小步，连接及时关。</h1><p class="muted">慢查询与连接寿命 · 保留原决定证据 · 每节都能留言</p></header>'+''.join(cards)+'<script nonce="__CSP_NONCE__">'+SCRIPT+'</script></main></body></html>'
(ROOT/'founder-design.html').write_text(html)
print('Built founder-design.html:',len(html.encode()),'bytes')
