from pathlib import Path
from html import escape
import ast
ROOT = Path(__file__).resolve().parent
# The existing report supplies only the inline comment-layer source. No execution/import.
upstream = ROOT.parent / 'FLY-2446-generic-voice-process/build-report.py'
module = ast.parse(upstream.read_text())
script = next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'script' for t in n.targets)).replace('FLY-2446','FLY-2701')
def para(s): return '<p>'+escape(s)+'</p>'
def table(headers, rows):
    return '<div class="scroll"><table><thead><tr>'+''.join('<th>'+escape(v)+'</th>' for v in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+escape(v)+'</td>' for v in row)+'</tr>' for row in rows)+'</tbody></table></div>'
def diagram(name):
    p=ROOT/(name+'.svg')
    if p.exists(): return '<div class="diagram">'+p.read_text()+'</div>'
    return '<div class="pending"><strong>DIAGRAM PENDING LOCAL RENDER</strong>'+para('本机图形渲染被系统权限拒绝，按标准参数重试仍失败。保留了 Mermaid 图源码。Mermaid 是用文字描述流程并生成图的工具。')+'</div><details><summary>查看图源码</summary><pre>'+escape((ROOT/(name+'.mmd')).read_text())+'</pre></details>'
def comment(key,title):
    return '<div class="comment"><label for="note-'+escape(key,quote=True)+'">对「'+escape(title)+'」的意见</label><textarea id="note-'+escape(key,quote=True)+'" data-comment="'+escape(key,quote=True)+'" data-title="'+escape(title,quote=True)+'" placeholder="这里可以写你的修改意见"></textarea><small class="save-status">意见只保存在当前浏览器。</small></div>'
sections=[
('summary','用的时候启动，结束后退出',para('语音平时不运行；开启耳机模式就启动，预约会议提前两分钟准备，结束后空闲两分钟退出。')+para('这是实施前设计。设计获批不代表已部署、已测快，或 founder 已亲测。')),
('flow','一场通话怎么开始和结束',para('Bridge 是团队共用后台，保管预约和未完成的启动请求；launchd 是 macOS 自带的进程管理器，负责真正启动语音。后台已经在运行，不另养一个语音唤醒进程。')+diagram('flow')),
('timing','等多久：先把真实耗时量清楚',table(['项目','证据或设计目标'],[
('旧样本全程','52.046 秒：发起到可通话。只有一次样本。'),
('旧样本等待被发现','5.196 秒；来自 Lead 提供的创建时间与原始启动事件。'),
('旧样本准备过程','46.850 秒；现有日志不能拆出进房、模型启动和语音连接各花多久。'),
('新耳机模式','每次实测全程不超过 52.046 秒 + 同次实测进程冷启动；至少测 3 次。'),
('会议','缺省提前 120 秒；到开会时间应已进房且模型准备好。'),
('结束','完成收尾后连续空闲 120 秒，再在最多 5 秒内退出。')])+para('实施先补分段计时，再让进房和模型并行准备。不能为省时间删掉身份校验，也不能把“进了房”当成“已经能说能听”。约 10 秒冷启动仅有开机旁证，不填进验收结果。')),
('model','保存什么，怎样避免旧预约误启动',para('每个预约有固定编号；每次改期都有递增版本。只认最新版本，取消或改期必须先结束旧通话。启动回执只说明系统接到了请求；真正领取会话和准备完成各有独立凭据。')+diagram('model')+table(['记录','用途'],[
('预约编号、版本、开会时间','后台重启后仍知道何时准备，旧回复不能覆盖新版。'),
('通话编号与占用许可','一次只允许一场占用房间，过期的进程不能继续发声。'),
('启动尝试与故障记录','启动失败不丢；同一次故障复用原有告警通道。')])) ,
('privacy','提前到房，不提前听你说话',para('进房和模型都准备好后，预约仍等到开会时间才开放声音。提前阶段不转录、不转发、不缓存房间音频。本人提前来又离开，也不能沿用旧的“在场”记录。')+para('到点后本人还没来，最多等两分钟；无人到场正常结束。房间已被另一场通话占用时不抢占，赶不上时间会明确报迟到。')),
('race','刚要退出时来了新请求',para('后台先把请求写入持久记录，再叫系统启动。若这次启动恰好碰上正在退出的旧进程，请求仍未被领取；后台继续每三秒补查，旧进程退出后再启动。')+para('检查一次“没有任务”不能证明安全；验收要故意把新请求插在最后空读与退出之间，证明它最终被领取。进程启动了却没领取，或进了房却没准备好，都要告警。')),
('choices','关键取舍',table(['采用','代价或放弃的方案'],[
('彻底按需，空闲不留进程','放弃常驻轮询；后台不可用时不能新启动，恢复后补查持久待办。'),
('进房与模型并行','任一路失败都要取消并清理另一路，不能留下半开的房间或模型进程。'),
('会议提前两分钟','提前短时占用资源；具体余量由冷启动实测复核。'),
('班车最多推迟十分钟','到期仍通话就更新，并报可能的通话中断；紧急授权重启不等。'),
('保留原有安全截止','异常断线可能中断，不假称能自动接回，不无限延长发声权限。')])) ,
('boundary','这次交付到哪里',para('本单提供共用后台的预约接口和直接操作命令。提交一次预约后，不需要调用方守到开会时间。耳机模式也改为按需启动。')+para('旧 Raya 业务外壳已经停用，本单不恢复它。自然语言排会怎样接上预约接口，由业务包并仓后的后继单完成；这里不把那条体验说成已经打通。')+para('实现前先合入 FLY-2693 健康告警、FLY-2655 语音解密；部署脚本还须对齐 FLY-2669 和 FLY-2657。设计阶段没有改代码、启生产会话或重启服务。')),
('acceptance','怎样才算真的能用',table(['验收','必须留下的证据'],[
('真机正常休眠','系统显示已注册但未运行，连续巡检和空闲部署都不唤醒。'),
('至少三次耳机冷启动','逐次分段耗时、开始前无进程、进房与真实双向语音。'),
('一次预约会议','通过真实命令提交，到点前准备好；提前不收音，到点能通话。'),
('退出竞态与失败告警','临界新请求不漏；启动失败与进房失败有真实告警送达凭据。'),
('founder亲测一场','最后仍须本人实际使用；此前只标工程验证，不算完整产品验收。')]))
]
css='''*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:17px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1080px;margin:auto;padding:40px 22px 80px}.eyebrow{font-size:13px;letter-spacing:.12em;color:#666}h1{font-size:clamp(32px,5vw,52px);line-height:1.2;margin:12px 0 24px}h2{font-size:26px;line-height:1.4;margin:0 0 18px}section{background:white;border:1px solid #e5e5e7;border-radius:22px;padding:30px;margin:24px 0;box-shadow:0 6px 25px #00000004}p{margin:14px 0}table{width:100%;border-collapse:collapse;text-align:left}th,td{border-bottom:1px solid #e8e8ed;padding:14px;vertical-align:top}th{color:#6e6e73;font-size:14px}td:first-child{min-width:150px;font-weight:600}.scroll{overflow-x:auto}.comment{border-top:1px solid #e8e8ed;margin-top:26px;padding-top:18px}label{display:block;font-size:14px;color:#515154;margin-bottom:8px}textarea{width:100%;min-height:86px;border:1px solid #d2d2d7;border-radius:10px;padding:12px;font:inherit;resize:vertical;background:#fbfbfd}textarea:focus{outline:3px solid #0071e333}small{display:block;color:#777;font-size:12px}button{border:0;border-radius:10px;background:#0071e3;color:white;font:inherit;padding:10px 18px;cursor:pointer}button:disabled{opacity:.4}.pending{border:1px solid #e6ca8c;background:#fffaf0;border-radius:14px;padding:22px}.pending strong{font-size:15px;color:#795817}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}summary{cursor:pointer;color:#0071e3}.diagram svg{width:100%;height:auto}.chunk{margin-top:18px}.chunk textarea{min-height:160px}@media(max-width:600px){main{padding:20px 12px 50px}section{padding:22px 18px}h2{font-size:23px}th,td{padding:10px}}'''
html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2701 · 语音按需启动</title><style>'+css+'</style></head><body><main>'
for i,(key,title,body) in enumerate(sections):
    html+='<section id="'+key+'">'
    if i==0: html+='<div class="eyebrow">FLY-2701 · 2026-09-17 · 实施前设计</div><h1>'+escape(title)+'</h1>'
    else: html+='<h2>'+escape(title)+'</h2>'
    html+=body+comment(key,title)+'</section>'
html+='<section id="feedback"><h2>把意见带回对话</h2>'+para('下方实时汇总所有意见。超过约 1800 字自动分段，每段保留页面标记；标记表示修改反馈，不表示批准。')+comment('feedback','意见汇总方式')+'<p id="comment-count" aria-live="polite"></p><button type="button" id="copy-all">复制全部意见</button><p id="copy-status" role="status"></p><div id="comment-chunks"></div></section></main><script nonce="__CSP_NONCE__">'+script+'</script></body></html>'
(ROOT/'founder-design.html').write_text(html)
print('Created founder-design.html',len(html.encode()),'bytes')
