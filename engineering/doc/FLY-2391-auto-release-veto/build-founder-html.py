"""Build the FLY-2391 artifact; no network or runtime dependencies."""
from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parent

def p(text, cls=""):
    return '<p'+(' class="'+escape(cls)+'"' if cls else '')+'>'+escape(text)+'</p>'

def table(headers, rows):
    return '<div class="table-wrap"><table><thead><tr>'+''.join('<th>'+escape(x)+'</th>' for x in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+escape(x)+'</td>' for x in row)+'</tr>' for row in rows)+'</tbody></table></div>'

def comment(key, title):
    return '<div class="comment"><label for="comment-'+escape(key)+'">这一节的意见 <span data-saved="'+escape(key)+'" aria-live="polite"></span></label><textarea id="comment-'+escape(key)+'" data-comment="'+escape(key)+'" data-title="'+escape(title)+'" placeholder="自动保存到本浏览器，复制发回才会送出"></textarea></div>'

def section(key, title, body):
    return '<section class="card" id="'+escape(key)+'"><h2>'+escape(title)+'</h2>'+body+comment(key,title)+'</section>'

def diagram(name):
    path=ROOT/(name+'.svg')
    if path.exists():
        return path.read_text()
    return '<div class="pending" role="note"><strong>DIAGRAM PENDING LOCAL RENDER</strong>'+p('两次本地渲染均被系统的浏览器启动权限阻止。图源已保留，以下文字说明设计含义。')+'</div><details><summary>查看 Mermaid 图源（用文字定义图形的源文件）</summary><pre>'+escape((ROOT/(name+'.mmd')).read_text())+'</pre></details>'

css='''*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:1040px;margin:auto;padding:48px 24px 80px}h1{font-size:clamp(30px,5vw,48px);line-height:1.25;letter-spacing:-1px;margin:14px 0 26px}h2{font-size:25px;line-height:1.4;margin:0 0 18px}p{margin:12px 0}.eyebrow{font-size:13px;color:#66666f;letter-spacing:1px}.card{background:#fff;border:1px solid #e3e3e8;border-radius:18px;padding:30px;margin:24px 0}.lead{font-size:23px;line-height:1.6}.small{font-size:14px;color:#64646d}.tag{font-size:13px;color:#175899;background:#edf5ff;padding:6px 13px;border-radius:20px;display:inline-block}.pending{border:1px dashed #bd8a36;background:#fff9ee;padding:18px;border-radius:10px;margin:20px 0;color:#795218}.pending strong{font-size:14px}.pending p{font-size:14px}details{margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:15px}th,td{padding:13px 10px;border-bottom:1px solid #e8e8ed;text-align:left;vertical-align:top}th{background:#fafafa;font-weight:600}td:first-child{font-weight:500}.comment{border-top:1px solid #eee;margin-top:24px;padding-top:16px}label{display:block;font-size:13px;color:#65656d;margin-bottom:7px}label span{margin-left:8px;color:#175899}textarea{width:100%;min-height:80px;padding:12px;font:inherit;font-size:15px;border:1px solid #c9c9d0;border-radius:9px;background:#fdfdff;resize:vertical}textarea:focus{outline:2px solid #0071e366;border-color:#0071e3}button{font:inherit;font-size:14px;padding:10px 16px;border:0;border-radius:8px;background:#0071e3;color:#fff;cursor:pointer;margin:10px 8px 0 0}.secondary{background:#e9f2ff;color:#075da7}.chunk{padding:16px;background:#f5f5f7;border-radius:10px;margin-top:15px}.chunk pre{font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0}#copy-status{font-size:14px;color:#62626a}svg{max-width:100%;height:auto}a{color:#0071e3}@media(max-width:600px){main{padding:24px 12px 48px}.card{padding:21px 16px;border-radius:13px}h2{font-size:22px}.lead{font-size:20px}th,td{padding:10px 6px;font-size:13px}}'''

cards=[]
cards.append(section('summary','01 / 健康时默认发布，你想拦时点一次',p('每周只为一个确定版本开一次否决窗口；你不操作且检查通过，系统到点把它发给客户。','lead')+p('beta 是先给内部使用的测试版。系统先用同一份代码准备好正式安装包，确认通知送达，再给你一上午拦截。新出的 beta 留到下个周期。')+diagram('d1-flow')+p('一句话流程：到期选定版本，预先验好正式包，发一次否决卡；你点「别发」或系统发现问题就取消，否则截止后才领取发布授权。')))
cards.append(section('states','02 / 不知道，就不自动发',table(['检查结果','系统怎么做','你需要做什么'],[
('green：客观信号新鲜且正常','才有资格进入本周期的自动发布流程','通常无需操作'),
('hold：已知有问题，或你标了坏','本周期停止自动发布并记原因','仍坚持发布时，明确手动点发'),
('unknown：缺信息、信号过期或系统故障','本周期停止；修复后也不重开这一轮窗口','等下周期，或在技术安全门仍通过时手动点发')])+p('短暂故障也要当时留下记录，不能被下一次“恢复正常”冲掉。日常日报只展示健康，不每天向你提发布问题。')))
cards.append(section('model','03 / 你看到的包，就是最后发出去的包',p('hash 是文件内容的指纹，改一个字节就会变化。正式包在窗口前已上传到不能覆盖的位置，并从下载路径重新读一遍验证指纹。窗口后不重新构建。')+diagram('d2-model')+table(['保留什么','为什么'],[
('本周周期、时区、截止时间','改配置或重启不能多开一轮窗口'),
('内部版、正式版、源码指纹、两份包的指纹','知道你允许的是哪个最终安装包'),
('实际消息、送达时间、谁点了哪个按钮','发送尝试不能被当成通知送达'),
('授权、执行尝试、客户清单结果','丢响应时核对原尝试，不盲目再发'),
('Bridge、Linear、GitHub 同一事件编号','Bridge 是协调任务的服务；三处记录能相互核对')])) )
cards.append(section('veto','04 / 一次「别发」，收到明确回执',p('只认你的真实账号在本周期卡片上的动作。系统先把否决落到耐久账本，再回复「已拦下，本周期不自动发布」。别人代点、聊天里引用一句话、机器给出意见，都不会代替你。')+p('通知必须到你有权限打开的位置，并能读回同一张卡片；这证明送达，不代表你已经阅读。通知不确定、送晚到不足一上午、按钮失效或消息被删，本周期都停止。')+p('如果后来改变主意，可以准备一张绑定同一份安装包的新手动发布卡，再由你明确点发。它不会重新开启第二轮“沉默就发”。')))
cards.append(section('cutoff','05 / 截止前的否决，与已经提交的处置',p('授权领取是系统最后一次检查后，耐久记录“这次可以开始提交”的时点；它一定在否决窗口截止之后。客户清单实际切换成功，才叫发布。')+table(['当时状态','系统的真实答复'],[
('窗口内已受理「别发」','已拦下；没有发布授权'),
('截止已到但尚未领取授权','仍保守接受否决'),
('授权已领取、远端正在提交','提交中；先核对结果，不能谎称已拦下'),
('网络断了、结果不知道','核对同一次提交；不能凭超时再发一次'),
('已经发出，后来发现问题','走撤版止血；它会阻止后续客户继续升坏版')])+p('提交许可最多允许在 30 秒内发起请求，但已发出的请求可能更晚返回。这不是“30 秒后一定没发布”的保证。窗口里的否决和发布后的撤版分别记账。','small')))
cards.append(section('tradeoffs','06 / 选择与舍弃',table(['选择','得到什么 / 付出什么'],[
('采用：独立发布账本＋最后一刻领取授权','减少每天要你点头的次数；需要耐久回执和明确恢复步骤'),
('保留：现成的构建、文件验证、原子发布清单','沿用已确定的安装包合同；自动与手动都不能跳过安全检查'),
('舍弃：计时器一到直接跑发布脚本','无法可靠证明通知送达、否决生效和版本没有被换'),
('舍弃：借用代码合并的批准记录','代码合入主分支和给客户发版本各有自己的授权'),
('舍弃：恢复正常就重开窗口','一周只开一次；不会反复催你')])) )
cards.append(section('rollout','07 / 默认关，最后一步才灰度',p('灰度是先在有限范围启用、观察真实结果。开关默认关闭；设计通过、代码合入都不会自动把它打开。')+table(['顺序','要拿到的证据'],[
('先把基础链路走通','同一发布端的上传、回读、下载、原子清单切换'),
('健康信号对上真实版本','实际运行代码、内部包、健康检查对象一致'),
('客户能更新，也能止血','真实安装、升级、回滚；坏版能撤回或暂停更新'),
('只观察，再真手动发布','先只记录会怎么判；再把新授权链完整手动跑通'),
('你授权，最后开启','你确认时间与证据后，才开首个有限周期')])+p('后续验收必须包括：一次按钮真的拦下并留账；另一周期健康且无动作才自动发；信号缺失或故障时自动发布次数为零。')))
cards.append(section('timing','08 / 三个时间决定，仍待你拍板',p('Lead 已确认目前没有已批准的时刻。下面只是建议，尚未写成生产值；少任何必要配置，系统都不会自动启用。')+table(['待决定','建议值（未批准）'],[
('发布日','周二'),('早报出候选','08:00 PT'),('下午否决截止','15:00 PT')])+p('PT 指美国太平洋当地时间；配置将用 America/Los_Angeles 自动处理夏令时。实际送达后必须还留有完整否决时长；迟送不挤掉你的考虑时间。')))
cards.append(section('boundary','09 / 当前交付到哪里',p('正式设计评审已通过，没有阻塞项。11 项非阻塞建议已随设计交给组长，尚未修复；涉及失败重试、手动重发、周期和时间边界、凭据保护及测试接线。完整记录保留在工程交接中。')+p('本页交付工程设计和可执行的实施计划，包括 20 条状态转移、并发失败测试、迁移回退、独立记账和最后灰度的证据要求。')+p('尚未实现自动发布、启用生产开关或验证真实客户机。已有代码和模拟测试不能代替上线证明；后续由实现与独立 QA 完成。QA 是另一个角色按验收条件检查实际行为。')+p('两张图保留 Mermaid 源码；本机渲染被系统权限阻止，当前不能宣称浏览器视觉验收通过。页面留言与复制会做隔离逻辑测试，发布后还会检查真实托管页。','small')))
cards.append(section('feedback','10 / 意见汇总',p('留言只保存在这个浏览器，按下复制后发回，组长才会收到。长意见自动拆段，每段都有同一标题。这里的反馈标记表示修改意见，不是批准。')))
cards[-1]=cards[-1].replace('</section>','<button type="button" id="copy-all">复制全部意见</button><span id="copy-status" role="status"></span><div id="comment-chunks"></div></section>')
html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLY-2391 · 默认发布，你保留否决权</title><style>'+css+'</style></head><body><main><div class="eyebrow">FLY-2391 · ENGINEERING DESIGN · 2026-09-14</div><h1>默认发布，<br>你保留否决权。</h1><span class="tag">设计评审通过 · 开关默认关闭</span>'+''.join(cards)+'<script nonce="__CSP_NONCE__">'+(ROOT/'comment-controller.js').read_text()+'</script></main></body></html>'
(ROOT/'founder-design.html').write_text(html)
print('Built founder-design.html:',len(html.encode()),'bytes')
